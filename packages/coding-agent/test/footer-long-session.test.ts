import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	await Settings.init({ inMemory: true, overrides: { "git.enabled": false } });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("FooterComponent long-session rendering", () => {
	it("reads indexed assistant usage without scanning session entries", () => {
		const getAssistantUsageStatistics = vi.fn(() => ({
			input: 1_000,
			output: 500,
			cacheRead: 250,
			cacheWrite: 125,
			totalTokens: 1_875,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 2,
			cost: 1.5,
		}));
		const session = {
			state: { model: null },
			getContextUsage: () => undefined,
			sessionManager: {
				getAssistantUsageStatistics,
				getEntries: () => {
					throw new Error("footer must not scan the session journal");
				},
			},
		} as unknown as AgentSession;

		const lines = new FooterComponent(session).render(120);

		expect(getAssistantUsageStatistics).toHaveBeenCalledTimes(1);
		expect(Bun.stripANSI(lines.join("\n"))).toContain("↑1K ↓500");
	});
});
