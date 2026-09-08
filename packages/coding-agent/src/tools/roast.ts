import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getRoastDbPath, VERSION } from "@oh-my-pi/pi-utils";
import roastPrompt from "../prompts/tools/roast.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";

export const ROAST_DEVICE_NAME = "roast";
export const roastDeviceUsage = roastPrompt;

/** Local-only feedback; deliberately independent of auto-QA consent and upload queues. */
export async function dispatchRoastDevice(
	session: ToolSession,
	text: string,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const report = text.trim();
	if (!report) throw new ToolError("Empty roast. Write a non-empty plain-text complaint to xd://roast.");
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
	return {
		result: { content: [{ type: "text", text: "Roast saved locally. Nothing uploaded." }] },
		xdev: { tool: ROAST_DEVICE_NAME, mode: "execute", tier: "write", args: { report } },
	};
}
