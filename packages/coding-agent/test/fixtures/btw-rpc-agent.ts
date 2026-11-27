import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { createAssistantMessage } from "../helpers/agent-session-setup";

// Real session, RPC dispatch and local read tool. Only the provider is scripted.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
const read = new ReadTool({
	cwd,
	settings,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
});
const mainStream = createMockModel({
	handler: context => ({
		content: ["Main answer."],
		// The delay only bounds a leaked process.
		delayMs: JSON.stringify(context.messages.at(-1)).includes("slow main") ? 600_000 : 0,
	}),
}).stream;
let releaseAbortedStream: (() => void) | undefined;
const sideStream: StreamFn = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	const question = JSON.stringify(context.messages.findLast(message => message.role === "user"));
	// This transport never even supplies its stream until the follow-up runs.
	if (question.includes("hold setup") && context.messages.at(-1)?.role === "toolResult") {
		const opened = Promise.withResolvers<AssistantMessageEventStream>();
		releaseAbortedStream = () => opened.resolve(stream);
		session.emitNotice("info", "Waiting to open the next provider stream", "fixture-stream-setup");
		return opened.promise;
	}
	const prior = context.messages.filter(message => message.role !== "developer").slice(0, -1);
	const reply = (text: string) => ({
		...createAssistantMessage(text),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	let partial = "";
	const delta = (text: string) => {
		partial += text;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply(partial) });
	};
	queueMicrotask(() => {
		// An interrupted investigation's provider only finishes once another turn actually dispatches.
		if (question.includes("recall interrupted fixture")) {
			releaseAbortedStream?.();
			releaseAbortedStream = undefined;
		}
		if (question.includes("fail")) {
			stream.push({
				type: "error",
				reason: "error",
				error: { ...reply(""), stopReason: "error", errorMessage: "provider exploded" },
			});
			return;
		}
		stream.push({ type: "start", partial: { ...reply(""), content: [] } });
		if (question.includes("investigate fixture") && context.messages.at(-1)?.role !== "toolResult") {
			stream.push({
				type: "done",
				reason: "toolUse",
				message: {
					...reply(""),
					responseId: "fixture-read-call",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "btw-read", name: "read", arguments: { path: "btw-fact.txt" } }],
				},
			});
			return;
		}
		if (question.includes("slow")) {
			const finish = () => {
				delta("late");
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...reply("Thinking"), stopReason: "aborted", errorMessage: "Provider aborted" },
				});
			};
			const abort = () => {
				fs.writeFileSync(path.join(cwd, "btw-aborted"), "");
				if (question.includes("investigate fixture")) releaseAbortedStream = finish;
				else finish();
			};
			if (options?.signal?.aborted) abort();
			else {
				options?.signal?.addEventListener("abort", abort, { once: true });
				delta("Thinking");
			}
			return;
		}
		const nativeRead =
			context.messages.some(message => message.role === "assistant" && message.responseId === "fixture-read-call") &&
			context.messages.some(
				message =>
					message.role === "toolResult" &&
					message.toolCallId === "btw-read" &&
					message.content.some(block => block.type === "text" && block.text.includes("cerulean walrus")),
			);
		const transcript = JSON.stringify(context.messages);
		let text = `Answer with ${prior.length} context messages.`;
		if (question.includes("investigate fixture"))
			text = nativeRead ? "Found the cerulean walrus." : "No tool result.";
		else if (question.includes("recall interrupted fixture")) {
			const partial = context.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "text" && block.text === "Thinking"),
			);
			text = `Native read: ${nativeRead}; partial answer: ${partial}.`;
		} else if (question.includes("recall frozen fixture"))
			text = `${model.id}: ${transcript.includes("before side question")}/${transcript.includes("after side question")}/${nativeRead}`;
		delta(text.slice(0, 7));
		delta(text.slice(7));
		stream.push({ type: "done", reason: "stop", message: { ...reply(text), responseId: "fixture-response" } });
	});
	return stream;
};
const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing bundled test model");
const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["RPC fixture"], tools: [read] }, streamFn: mainStream }),
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings,
	modelRegistry,
	sideStreamFn: sideStream,
	toolRegistry: new Map([[read.name, read as AgentTool]]),
	builtInToolNames: new Set([read.name]),
});
await runRpcMode(session);
