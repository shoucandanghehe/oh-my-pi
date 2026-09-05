import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function createRunningViewer(ui: TUI = new TUI(new ProcessTerminal()), statusContent?: string): AgentTranscriptViewer {
	const registry = new AgentRegistry();
	registry.register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: "Main",
		status: "running",
		session: statusContent ? ({} as never) : null,
	});
	const viewer = new AgentTranscriptViewer({
		agentId: "Worker",
		registry,
		ui,
		cwd: process.cwd(),
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+a"],
		createStatusLine: () => ({
			getTopBorder: () => ({
				content: statusContent ?? " STATUS ",
				width: Bun.stringWidth(Bun.stripANSI(statusContent ?? " STATUS ")),
				revision: 0,
			}),
			dispose: () => {},
		}),
		requestRender: () => {},
		onClose: () => {},
		onHubToggle: () => {},
	});
	viewer.setViewportHeight(8);
	return viewer;
}

describe("AgentTranscriptViewer", () => {
	it("keeps an advisor on the unified shell with a read-only composer", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Reviewer",
			displayName: "Reviewer",
			kind: "advisor",
			parentId: "Main",
			status: "idle",
			session: {} as never,
		});
		const peerStatusLine = {
			getTopBorder: vi.fn(() => ({ content: " MAIN STATUS ", width: 13, revision: 0 })),
			dispose: vi.fn(),
		};
		const viewer = new AgentTranscriptViewer({
			agentId: "Reviewer",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => peerStatusLine,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		viewer.focused = true;
		try {
			const header = Bun.stripANSI(viewer.renderWorkspaceHeader(40, true));
			expect(header).toContain("Reviewer");
			expect(header).toContain("idle");
			expect(header).toContain("Esc");
			expect(header).not.toContain("Enter send");
			expect(viewer.renderWorkspaceHeader(40, true)).toContain(theme.fg("accent", theme.bold("Reviewer")));
			expect(Bun.stripANSI(viewer.renderWorkspaceHeader(40, false))).toStartWith("○ Reviewer");

			const before = viewer.render(40);
			expect(before).toHaveLength(8);
			const transcript = Bun.stripANSI(before.join("\n"));
			expect(transcript).toContain("MAIN STATUS");
			expect(transcript).not.toContain("advisor");
			expect(transcript).not.toContain("read-only");
			expect(peerStatusLine.getTopBorder).toHaveBeenCalled();
			viewer.handleInput("x");
			expect(viewer.render(40)).toEqual(before);
		} finally {
			viewer.dispose();
		}
		expect(peerStatusLine.dispose).toHaveBeenCalledTimes(1);
	});

	it("shows a status-line error without blocking the transcript, then recovers in place", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		const disposeStatusLine = vi.fn();
		const createStatusLine = vi.fn(() => ({
			getTopBorder: () => ({ content: " LIVE STATUS ", width: 13, revision: 0 }),
			dispose: disposeStatusLine,
		}));
		const viewer = new AgentTranscriptViewer({
			agentId: "Parked",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: process.cwd(),
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine,
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		try {
			const unavailable = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(unavailable).toContain("Status unavailable (parked)");
			expect(unavailable).not.toContain("LIVE STATUS");
			expect(createStatusLine).not.toHaveBeenCalled();

			const session = {} as never;
			expect(registry.attachSession("Parked", session)).toBe(true);
			expect(Bun.stripANSI(viewer.render(60).join("\n"))).toContain("LIVE STATUS");
			expect(createStatusLine).toHaveBeenCalledWith(session);
		} finally {
			viewer.dispose();
		}
		expect(disposeStatusLine).toHaveBeenCalledTimes(1);
	});

	it("plays the completed-agent petrification before closing", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		const close = vi.fn();
		try {
			const normal = viewer.render(40);
			const normalHeader = viewer.renderWorkspaceHeader(40, false);
			viewer.startAutoClose(close);
			vi.advanceTimersByTime(64);
			const petrifyingHeader = viewer.renderWorkspaceHeader(40, false);
			expect(petrifyingHeader).not.toBe(normalHeader);
			viewer.cancelAutoClose();
			expect(viewer.render(40)).toEqual(normal);
			expect(viewer.renderWorkspaceHeader(40, false)).toBe(normalHeader);

			viewer.startAutoClose(close);
			vi.advanceTimersByTime(2_999);
			expect(close).not.toHaveBeenCalled();
			vi.advanceTimersByTime(16);
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			viewer.dispose();
			vi.useRealTimers();
		}
	});

	it("petrifies diagonally from the top-left without moving glyphs", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		try {
			const normal = viewer.render(40);
			viewer.startAutoClose(() => {});
			vi.advanceTimersByTime(1_200);
			const petrifying = viewer.render(40);

			expect(petrifying[0]).not.toBe(normal[0]);
			expect(Bun.stripANSI(petrifying[0] ?? "").trimEnd()).toBe(Bun.stripANSI(normal[0] ?? "").trimEnd());
			expect(petrifying.at(-1)).toBe(normal.at(-1));
			const graySteps = new Set((petrifying[0] ?? "").match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []);
			expect(graySteps.size).toBeGreaterThanOrEqual(4);
		} finally {
			viewer.dispose();
			vi.useRealTimers();
		}
	});

	it("preserves styled backgrounds while petrifying foreground glyphs", () => {
		vi.useFakeTimers();
		const background = theme.bg("statusLineBg", " STONE STATUS ");
		const viewer = createRunningViewer(new TUI(new ProcessTerminal()), background);
		try {
			const normal = viewer.render(40);
			const normalStatus = normal.find(line => Bun.stripANSI(line).includes("STONE STATUS"));
			expect(normalStatus).toContain(theme.getBgAnsi("statusLineBg"));

			viewer.startAutoClose(() => {});
			vi.advanceTimersByTime(2_600);
			const petrifiedStatus = viewer.render(40).find(line => Bun.stripANSI(line).includes("STONE STATUS"));

			expect(Bun.stripANSI(petrifiedStatus ?? "")).toBe(Bun.stripANSI(normalStatus ?? ""));
			expect(petrifiedStatus).toContain(theme.getBgAnsi("statusLineBg"));
		} finally {
			viewer.dispose();
			vi.useRealTimers();
		}
	});

	it("restores the pane and permanently abandons auto-close after interaction", () => {
		vi.useFakeTimers();
		const viewer = createRunningViewer();
		const close = vi.fn();
		try {
			const normal = viewer.render(40);
			viewer.startAutoClose(close);
			vi.advanceTimersByTime(2_999);
			viewer.handleInput("\x1b[5~");
			expect(viewer.render(40)).toEqual(normal);

			viewer.startAutoClose(close);
			vi.advanceTimersByTime(3_100);
			expect(close).not.toHaveBeenCalled();
		} finally {
			viewer.dispose();
			vi.useRealTimers();
		}
	});

	it("repaints the dissolve at display-frame cadence", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const viewer = createRunningViewer(ui);
		try {
			viewer.startAutoClose(() => {});
			requestComponentRender.mockClear();

			vi.advanceTimersByTime(1_000);
			const viewerPaints = requestComponentRender.mock.calls.filter(([component]) => component === viewer);
			expect(viewerPaints.length).toBeGreaterThanOrEqual(60);
		} finally {
			viewer.dispose();
			vi.useRealTimers();
		}
	});

	it("loads a local transcript asynchronously before publishing incremental rows", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-load-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const entries: unknown[] = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
			{ type: "custom", id: "padding", timestamp, data: "x".repeat(2 * 1024 * 1024) },
			...Array.from({ length: 300 }, (_value, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp,
				message: { role: "user", content: `row-${index}`, timestamp: index },
			})),
		];
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		// oxlint-disable-next-line prefer-const -- requestRender may run during construction before assignment
		let viewer: AgentTranscriptViewer | undefined;
		const loaded = Promise.withResolvers<void>();
		viewer = new AgentTranscriptViewer({
			agentId: "Worker",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => ({
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: () => {},
			}),
			requestRender: () => {
				if (viewer && Bun.stripANSI(viewer.render(60).join("\n")).includes("row-299")) loaded.resolve();
			},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(12);
		try {
			const immediate = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(immediate).toContain("Loading transcript");
			expect(immediate).not.toContain("row-299");

			await loaded.promise;
			expect(Bun.stripANSI(viewer.render(60).join("\n"))).toContain("row-299");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("opens a persisted activity entry inside the virtualized transcript", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-deep-link-"));
		const file = path.join(dir, "Worker.jsonl");
		const timestamp = "2026-08-23T00:00:00.000Z";
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "worker", timestamp, cwd: dir },
			...Array.from({ length: 30 }, (_value, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp,
				message: { role: "user", content: `activity-row-${index}`, timestamp: index },
			})),
		];
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile: file,
		});
		const viewer = new AgentTranscriptViewer({
			agentId: "Worker",
			initialEntryId: "m20",
			registry,
			ui: new TUI(new ProcessTerminal()),
			cwd: dir,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+a"],
			createStatusLine: () => ({
				getTopBorder: () => ({ content: " STATUS ", width: 8, revision: 0 }),
				dispose: () => {},
			}),
			requestRender: () => {},
			onClose: () => {},
			onHubToggle: () => {},
		});
		viewer.setViewportHeight(8);
		try {
			const rendered = Bun.stripANSI(viewer.render(60).join("\n"));
			expect(rendered).toContain("activity-row-20");
			expect(rendered).not.toContain("activity-row-0");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
