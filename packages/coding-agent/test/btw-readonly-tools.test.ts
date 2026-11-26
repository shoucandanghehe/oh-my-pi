import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BTW_SUMMARY_MESSAGE_TYPE, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

describe("BTW investigation capabilities", () => {
	for (const presentation of ["direct", "mounted"] as const) {
		it(`allows investigation but rejects mutations with a ${presentation} Main tool roster`, async () => {
			const directory = TempDir.createSync("@btw-readonly-");
			const file = path.resolve(directory.path(), "fixture.ts");
			const original = "const needle42 = 42;\n";
			await Bun.write(file, original);
			const auth = createInMemoryAuthStorage();
			const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
			auth.keys.setRuntime("anthropic", "test-key");
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected test model");
			const settings = Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" });
			const tools = new Map<string, Tool>();
			const toolCommands: ToolCommandState = {
				tools,
				mountedNames: new Set(),
				builtInNames: new Set(),
				isActive: name => tools.has(name) && !toolCommands.mountedNames.has(name),
			};
			const toolSession: ToolSession = {
				cwd: path.resolve(directory.path()),
				settings,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
			};
			const ast = new AstGrepTool(toolSession);
			const lsp = new LspTool(toolSession);
			const github = new GithubTool(toolSession);
			const write = new WriteTool(toolSession);
			const lspCalls: string[] = [];
			vi.spyOn(lsp, "execute").mockImplementation(async (_id, args) => {
				lspCalls.push(args.action);
				if (args.action !== "hover") await Bun.write(file, "unexpected LSP mutation");
				return {
					content: [{ type: "text", text: `Hover: ${await Bun.file(file).text()}` }],
					details: { action: args.action, success: true },
				};
			});
			const githubCalls: string[] = [];
			vi.spyOn(github, "execute").mockImplementation(async (_id, args) => {
				githubCalls.push(args.op);
				if (args.op !== "file_read") await Bun.write(file, "unexpected GitHub mutation");
				return {
					content: [{ type: "text", text: `Repository file: ${await Bun.file(file).text()}` }],
					details: {},
				};
			});
			let unsafeCalls = 0;
			const mutation: AgentTool = {
				name: "retain",
				label: "Retain",
				description: "Persist memory",
				approval: "read",
				parameters: type({}),
				execute: async () => {
					unsafeCalls++;
					await Bun.write(file, "unexpected memory mutation");
					return { content: [{ type: "text", text: "mutated" }] };
				},
			};
			const web: AgentTool = {
				name: "web_search",
				label: "Search",
				description: "Search web",
				approval: "read",
				parameters: type({ query: "string" }),
				execute: async () => ({
					content: [{ type: "text", text: "Search result: https://example.com/investigation" }],
				}),
			};
			const bash: AgentTool = {
				name: "bash",
				label: "Shell",
				description: "Run a command",
				approval: "exec",
				parameters: type({ command: "string" }),
				execute: async () => {
					unsafeCalls++;
					return { content: [{ type: "text", text: "unexpected shell execution" }] };
				},
			};
			for (const tool of [ast, lsp, github, write, mutation, web, bash]) {
				tools.set(tool.name, tool);
				toolCommands.builtInNames.add(tool.name);
			}
			if (presentation === "mounted")
				for (const tool of [ast, lsp, github, mutation]) toolCommands.mountedNames.add(tool.name);
			const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
				type: "toolCall",
				id,
				name,
				arguments: args,
			});
			const calls: ToolCall[] = [
				call("structural-search", "ast_grep", { pat: "const $NAME = 42", path: file }),
				call("web-search", "web_search", { query: "investigation" }),
				call("hover", "lsp", { action: "hover", file, line: 1, symbol: "needle42" }),
				call("rename", "lsp", { action: "rename", file, line: 1, symbol: "needle42", new_name: "changed" }),
				call("repo-read", "github", { op: "file_read", path: "fixture.ts" }),
				call("repo-write", "github", { op: "pr_create", title: "not authorized" }),
				call("memory-write", "retain", {}),
				{ type: "toolCall", id: "file-write", name: "write", arguments: { path: file, content: "not authorized" } },
				call("shell", "bash", { command: "lsp --help" }),
				call("resolve", "resolve", { reason: "apply" }),
			];
			let requests = 0;
			let results: ToolResultMessage[] = [];
			let declaredTools: Context["tools"];
			const sideStreamFn: StreamFn = (_model, context) => {
				const stream = new AssistantMessageEventStream();
				const first = requests++ === 0;
				queueMicrotask(() => {
					const message = createAssistantMessage("Investigation complete");
					if (first) {
						declaredTools = context.tools;
						message.content = calls;
						message.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message });
					} else {
						results = context.messages.filter(message => message.role === "toolResult");
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			};
			const session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: [],
						messages: [],
						tools: [...tools.values()].filter(tool => toolCommands.isActive(tool.name)),
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: registry,
				sideStreamFn,
				toolRegistry: tools,
				builtInToolNames: new Set(tools.keys()),
				toolCommands: presentation === "mounted" ? toolCommands : undefined,
			});
			const conversation = session.createEphemeralConversation("Investigate");
			try {
				await conversation.initializeExtensionRuntime();
				await conversation.prompt("Inspect the fixture without changing it");
				const mainTools = (await session.agent.buildSideRequestContext([])).tools ?? [];
				// Preserve Main's declaration prefix; append tools mounted only as commands in Main.
				expect(declaredTools?.slice(0, mainTools.length)).toEqual(mainTools);
				expect(
					declaredTools
						?.slice(mainTools.length)
						.map(tool => tool.name)
						.sort(),
				).toEqual(presentation === "mounted" ? ["ast_grep", "github", "lsp"] : []);
				const structural = results.find(result => result.toolCallId === "structural-search");
				expect(structural?.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "text", text: expect.stringContaining("needle42") }),
					]),
				);
				expect(
					results
						.filter(result => !result.isError)
						.map(result => result.toolCallId)
						.sort(),
				).toEqual(["hover", "repo-read", "structural-search", "web-search"]);
				expect(
					results
						.filter(result => result.isError)
						.map(result => result.toolCallId)
						.sort(),
				).toEqual(
					calls
						.filter(call => !["structural-search", "web-search", "hover", "repo-read"].includes(call.id))
						.map(call => call.id)
						.sort(),
				);
				expect(lspCalls).toEqual(["hover"]);
				expect(githubCalls).toEqual(["file_read"]);
				expect(unsafeCalls).toBe(0);
				expect(await Bun.file(file).text()).toBe(original);
				expect(session.messages).toEqual([]);
			} finally {
				await conversation.session?.dispose();
				await session.dispose();
				auth.close();
				directory.removeSync();
			}
		});
	}

	it("only delivers the exact approved summary into Main, even in yolo mode", async () => {
		using temp = TempDir.createSync("@btw-summary-");
		const auth = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const main = new AgentSession({
			agent: new Agent({
				initialState: { model },
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Summary received") }),
					);
					return stream;
				},
			}),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
			modelRegistry,
		});
		const requests: string[] = [];
		const conversation = main.createEphemeralConversation("Side topic", undefined, model, {
			approveSummary: async summary => {
				requests.push(summary);
				return summary === "Reviewed facts";
			},
			sendToMainSession: summary => main.publishBtwSummary({ threadKey: "topic", threadTitle: "Facts", summary }),
		});
		try {
			await conversation.initializeExtensionRuntime();
			const send = conversation.getTool("send_to_main_session");
			if (!send) throw new Error("Expected BTW summary tool");
			await expect(send.execute("denied", { summary: "Do not send" })).rejects.toThrow("did not approve");
			expect(main.messages).toEqual([]);
			await send.execute("approved", { summary: "Reviewed facts" });
			await main.waitForIdle();
			expect(requests).toEqual(["Do not send", "Reviewed facts"]);
			expect(main.messages.filter(message => message.role === "custom")).toEqual([
				expect.objectContaining({
					role: "custom",
					customType: BTW_SUMMARY_MESSAGE_TYPE,
					details: { summaries: [{ threadKey: "topic", threadTitle: "Facts", summary: "Reviewed facts" }] },
				}),
			]);
		} finally {
			await conversation.session?.dispose();
			await main.dispose();
			auth.close();
		}
	});
});
