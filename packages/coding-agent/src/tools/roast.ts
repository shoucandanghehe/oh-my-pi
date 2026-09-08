import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { getRoastDbPath, VERSION } from "@oh-my-pi/pi-utils";
import roastPrompt from "../prompts/tools/roast.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

export const ROAST_COMMAND_NAME = "roast";

const roastSchema = type({
	report: type("string").describe("What got in the way and its practical impact."),
	"+": "reject",
});

/** Local-only feedback; deliberately independent of Auto-QA consent and upload queues. */
export function createRoastTool(session: ToolSession): AgentTool<typeof roastSchema> {
	return {
		name: ROAST_COMMAND_NAME,
		label: "Roast",
		description: roastPrompt,
		parameters: roastSchema,
		strict: true,
		intent: "omit",
		approval: "write",
		async execute(_toolCallId, params) {
			const report = params.report.trim();
			if (!report) throw new ToolError("Provide a non-empty roast.");
			const dbPath = getRoastDbPath();
			await fs.mkdir(path.dirname(dbPath), { recursive: true });
			const db = new Database(dbPath, { create: true });
			try {
				db.run("PRAGMA busy_timeout = 5000");
				db.exec(`CREATE TABLE IF NOT EXISTS roasts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					created_at TEXT NOT NULL,
					session_id TEXT,
					cwd TEXT NOT NULL,
					model TEXT,
					version TEXT NOT NULL,
					report TEXT NOT NULL
				)`);
				db.prepare(
					"INSERT INTO roasts (created_at, session_id, cwd, model, version, report) VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					new Date().toISOString(),
					session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? null,
					session.cwd,
					session.getActiveModelString?.() ?? null,
					VERSION,
					report,
				);
			} finally {
				db.close();
			}
			return { content: [{ type: "text", text: "Roast saved locally. Nothing uploaded." }] };
		},
	};
}
