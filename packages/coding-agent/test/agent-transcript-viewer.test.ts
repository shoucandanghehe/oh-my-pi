import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

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
			getTopBorder: vi.fn(() => ({ content: " MAIN STATUS ", width: 13 })),
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
			getTopBorder: () => ({ content: " LIVE STATUS ", width: 13 }),
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
});
