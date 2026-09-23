import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

describe("BTW investigation capabilities", () => {
	for (const transport of ["direct", "device"] as const) {
		it(`allows investigation but rejects mutations through ${transport} calls`, async () => {
			const directory = TempDir.createSync("btw-readonly-");
			const file = path.resolve(directory.path(), "fixture.ts");
			const original = "const needle42 = 42;\n";
			await Bun.write(file, original);
			const auth = createInMemoryAuthStorage();
			const registry = new ModelRegistry(auth);
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected test model");
			const settings = Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" });
			const tools = new Map<string, Tool>();
			const xdev: XdevState = {
				tools,
				mountedNames: new Set(),
				builtInNames: new Set(),
				isActive: name => tools.has(name),
			};
			const toolSession: ToolSession = {
				cwd: path.resolve(directory.path()),
				settings,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				xdev,
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
			for (const tool of [ast, lsp, github, write, mutation, web]) tools.set(tool.name, tool);
			if (transport === "device")
				for (const tool of [ast, lsp, github, mutation, web]) xdev.mountedNames.add(tool.name);
			const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
				type: "toolCall",
				id,
				name: transport === "device" ? "write" : name,
				arguments: transport === "device" ? { path: `xd://${name}`, content: JSON.stringify(args) } : args,
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
				{ type: "toolCall", id: "resolve", name: "write", arguments: { path: "xd://resolve", content: "apply" } },
			];
			if (transport === "device") {
				calls.push({
					type: "toolCall",
					id: "malformed-device",
					name: "write",
					arguments: { path: "xd://lsp", content: "[]" },
				});
				calls.push(call("nested-write", "write", { path: file, content: "not authorized" }));
			}
			let requests = 0;
			let results: ToolResultMessage[] = [];
			const sideStreamFn: StreamFn = (_model, context) => {
				const stream = new AssistantMessageEventStream();
				const first = requests++ === 0;
				queueMicrotask(() => {
					const message = createAssistantMessage("Investigation complete");
					if (first) {
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
						tools: transport === "direct" ? [...tools.values()] : [write],
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: registry,
				sideStreamFn,
				toolRegistry: tools,
				builtInToolNames: new Set(tools.keys()),
				xdev,
			});
			try {
				const conversation = session.createEphemeralConversation("Investigate", undefined, undefined, {
					readOnlyTools: true,
				});
				await conversation.initializeExtensionRuntime();
				await conversation.prompt("Inspect the fixture without changing it");
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
				await session.dispose();
				auth.close();
				directory.removeSync();
			}
		});
	}
});
