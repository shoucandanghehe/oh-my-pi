/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { TranscriptPresenter } from "../src/extensibility/extensions/render-types";
import { agentTranscriptSource } from "../src/modes/agent-hub-runtime";
import type { AgentSessionEvent, AgentSessionEventListener } from "../src/session/agent-session-events";
import type {
	AgentViewSession,
	ToolExecutionUpdateEvent,
	ToolStreamUpdateEvent,
} from "../src/session/agent-session-handle";
import { captureStreamedToolArgs, restoreStreamedToolArgs } from "../src/thread/session-mirror";
import { AgentWorkspaceTranscript } from "../src/ui/overlays/panels/agent-transcript-viewer";
import { AgentTranscriptViewerModel } from "../src/ui/overlays/panels/agent-transcript-viewer-model";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { mountLayer } from "./helpers/layer-terminal";

function sideSession(label: string) {
	const present: TranscriptPresenter = block => {
		if (block.type !== "toolCall" || !isRecord(block.args)) return undefined;
		const output = block.result?.content[0];
		const value = isRecord(output) ? output.text : block.args.query;
		return { compact: { label: `${label} ${value} ${block.isPartial ? "partial" : "final"}` } };
	};
	const listeners = new Set<AgentSessionEventListener>();
	const saved: AgentMessage[] = [];
	const state = { streamMessage: null as AgentMessage | null, pendingToolCalls: new Set<string>() };
	const active: ToolExecutionUpdateEvent[] = [];
	const previews: ToolStreamUpdateEvent[] = [];
	const pending: ToolResultMessage[] = [];
	const session = {
		agent: { state, getPendingToolResults: () => pending },
		get messages() {
			return saved;
		},
		get isStreaming() {
			return state.streamMessage !== null || state.pendingToolCalls.size > 0;
		},
		sessionManager: { getLeafId: () => String(saved.length), getCwd: () => process.cwd() },
		settings: Settings.isolated({ "display.smoothStreaming": false }),
		extensionRunner: {
			getMessageRenderer: (customType: string) =>
				customType === "side-note" ? () => `${label} custom note` : undefined,
			getTranscriptPresenters: () => [present],
			getAssistantTextRenderers: () => [],
			getAssistantThinkingRenderers: () => [],
		},
		getToolByName: () => undefined,
		activeToolExecutionUpdates: () => active,
		activeToolStreamUpdates: () => previews,
		buildTranscriptSessionContext: () => ({ messages: [...saved] }),
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		session: session as unknown as AgentViewSession,
		state,
		saved,
		active,
		previews,
		pending,
		emit: (event: AgentSessionEvent) => listeners.forEach(listener => listener(event)),
	};
}

it("restores the latest edit preview on side-pane attach and routes live previews to the same card", () => {
	const side = sideSession("side");
	side.session.extensionRunner!.getTranscriptPresenters = () => [];
	const edit: ToolCall = {
		type: "toolCall",
		id: "edit",
		name: "edit",
		arguments: { path: "mod.ts", old_string: "old", new_string: "new" },
	};
	const reply = createAssistantMessage("Editing");
	side.saved.push(
		{ ...reply, content: [...reply.content, edit], stopReason: "toolUse" },
		{
			role: "toolResult",
			toolCallId: edit.id,
			toolName: edit.name,
			timestamp: 3,
			isError: false,
			content: [{ type: "text", text: "Edit succeeded without diff details" }],
		},
	);
	const preview = (marker: string): ToolStreamUpdateEvent => ({
		type: "tool_stream_update",
		toolCallId: edit.id,
		toolName: edit.name,
		update: {
			streaming: true,
			files: [{ path: "mod.ts", diff: `@@ -1 +1 @@\n-old\n+${marker}`, firstChangedLine: 1 }],
		},
	});
	side.previews.push(preview("ATTACH-PREVIEW"));
	const model = new AgentTranscriptViewerModel({
		agentId: "worker",
		transcript: agentTranscriptSource,
		registry: { get: () => ({ kind: "sub", status: "running" }) },
		liveSession: () => side.session,
		terminalRows: () => 42,
		expandKeys: ["ctrl+o"],
		hubKeys: [],
		onClose: () => {},
		onHubClose: () => {},
	});
	const surface = mountLayer(
		() => (
			<col>
				<AgentWorkspaceTranscript model={model} />
			</col>
		),
		{ columns: 100, rows: 42 },
	);
	try {
		const card = model.tools.get(edit.id);
		expect(card?.status()).toBe("done");
		expect(surface.text()).toContain("ATTACH-PREVIEW");
		side.previews.length = 0;
		side.emit(preview("LIVE-PREVIEW"));
		expect(surface.text()).toContain("LIVE-PREVIEW");
		expect(surface.text()).not.toContain("ATTACH-PREVIEW");
		expect(model.tools.get(edit.id)).toBe(card);
	} finally {
		surface.dispose();
		model.dispose();
	}
});

it("keeps one live subagent tool card through persistence and binds presenters to the displayed session", async () => {
	const first = sideSession("First pane");
	const second = sideSession("Second pane");
	let current = first.session;
	const model = new AgentTranscriptViewerModel({
		agentId: "worker",
		transcript: agentTranscriptSource,
		registry: { get: () => ({ kind: "sub", status: "running" }) },
		liveSession: () => current,
		terminalRows: () => 40,
		expandKeys: ["ctrl+o"],
		hubKeys: [],
		onClose: () => {},
		onHubClose: () => {},
		pollMs: 3_600_000,
	});
	const surface = mountLayer(
		() => (
			<col>
				<AgentWorkspaceTranscript model={model} />
			</col>
		),
		{ columns: 100, rows: 40 },
	);
	try {
		const part: ToolCall = { type: "toolCall", id: "one", name: "lookup", arguments: {} };
		const reply = { ...createAssistantMessage("Before tool"), timestamp: 41, stopReason: "toolUse" as const };
		const preview = { ...reply, content: [...reply.content, part] };
		setStreamingPartialJson(part, '{"query":"streamed path');
		first.state.streamMessage = preview;
		model.poll();
		const card = model.tools.get("one");
		expect(card?.args).toMatchObject({ query: "streamed path" });
		expect(surface.text()).toContain("First pane streamed path partial");
		expect(card?.state().argsComplete).toBe(false);

		const final = {
			...preview,
			content: [
				...reply.content,
				{ ...part, arguments: { query: "final args" } },
				{ type: "text" as const, text: "After tool" },
			],
		};
		// The agent has already cleared streamMessage; its journal can still be behind message_end.
		first.state.streamMessage = null;
		first.emit({ type: "message_end", message: final });
		await Promise.resolve();
		expect(model.tools.get("one")).toBe(card);
		expect(surface.text()).toContain("First pane final args partial");
		expect(card?.state().argsComplete).toBe(true);

		first.saved.push(final);
		first.state.pendingToolCalls.add("one");
		first.emit({
			type: "tool_execution_start",
			toolCallId: "one",
			toolName: "lookup",
			args: { query: "validated args" },
		});
		first.active.push({
			type: "tool_execution_update",
			toolCallId: "one",
			toolName: "lookup",
			args: {},
			partialResult: { content: [{ type: "text", text: "working result" }], details: {} },
		});
		model.poll();
		expect(model.tools.get("one")).toBe(card);
		expect(card?.args).toEqual({ query: "validated args" });
		const lines = surface.text();
		expect(lines.match(/First pane working result partial/g)).toHaveLength(1);
		expect(lines.indexOf("Before tool")).toBeLessThan(lines.indexOf("First pane working result partial"));
		expect(lines.indexOf("First pane working result partial")).toBeLessThan(lines.indexOf("After tool"));

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "one",
			toolName: "lookup",
			timestamp: 42,
			isError: false,
			content: [{ type: "text", text: "saved result" }],
			details: {},
		};
		first.saved.push(result, {
			role: "custom",
			customType: "side-note",
			content: "raw note",
			display: true,
			timestamp: 43,
		});
		first.state.pendingToolCalls.clear();
		// A stale mirrored preview must not draw a second assistant or overwrite a final result.
		first.state.streamMessage = preview;
		model.poll();
		const done = surface.text();
		expect(done.match(/First pane saved result final/g)).toHaveLength(1);
		expect(done.match(/Before tool/g)).toHaveLength(1);
		expect(done).toContain("First pane custom note");
		expect(done).not.toContain("working result");

		second.saved.push(final, result, {
			role: "custom",
			customType: "side-note",
			content: "raw note",
			display: true,
			timestamp: 43,
		});
		current = second.session;
		model.poll();
		first.emit({ type: "message_end", message: final });
		await Promise.resolve();
		expect(surface.text()).toContain("Second pane saved result final");
		expect(surface.text()).toContain("Second pane custom note");
		expect(surface.text()).not.toContain("First pane");
	} finally {
		surface.dispose();
		model.dispose();
	}
});

it("carries provider argument prefixes separately across the worker clone boundary", () => {
	const first: ToolCall = { type: "toolCall", id: "shared", name: "lookup", arguments: {} };
	const second: ToolCall = { type: "toolCall", id: "other", name: "lookup", arguments: { key: "done" } };
	const message = {
		...createAssistantMessage("worker"),
		content: [{ type: "text" as const, text: "worker" }, first, second],
	};
	setStreamingPartialJson(first, '{"key":"not done');
	const cloned = structuredClone(message);
	const [, clonedFirst, clonedSecond] = cloned.content;
	if (clonedFirst?.type !== "toolCall" || clonedSecond?.type !== "toolCall") throw new Error("Expected cloned tools");
	expect(getStreamingPartialJson(clonedFirst)).toBeUndefined();
	restoreStreamedToolArgs(cloned, structuredClone(captureStreamedToolArgs(message)));
	expect(getStreamingPartialJson(clonedFirst)).toBe('{"key":"not done');
	expect(getStreamingPartialJson(clonedSecond)).toBeUndefined();
	expect(JSON.stringify(cloned)).not.toContain("not done");
});
