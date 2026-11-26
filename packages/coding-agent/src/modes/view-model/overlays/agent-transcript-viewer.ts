import type * as fs from "node:fs";
import type { SessionHeader } from "../../../session/session-entries";
import type { TranscriptEntryLike } from "../../../session/transcript/transcript-entry";

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry = TranscriptEntryLike | SessionHeader | { type: "model_change"; model: string };

/** Local filesystem and session parsing capabilities supplied by the host. */
export interface AgentTranscriptSource {
	/**
	 * Sync primitives drive the first paint and the incremental tail. When the
	 * host also supplies `promises.readFile` (e.g. passes `node:fs` itself), full
	 * reloads after rotation/rewrite read the file off the UI thread.
	 */
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync"> & {
		promises?: Pick<typeof fs.promises, "readFile">;
	};
	parseEntries(text: string): AgentTranscriptEntry[];
}
