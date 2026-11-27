import type * as fs from "node:fs";
import type { SessionHeader } from "../../../session/session-entries";
import type { VisitEntriesFromFileStreamOptions } from "../../../session/session-loader";
import type { TranscriptEntryLike } from "../../../session/transcript/transcript-entry";

/** Parsed message and model metadata relevant to a transcript viewer. */
export type AgentTranscriptEntry = TranscriptEntryLike | SessionHeader | { type: "model_change"; model: string };

/** Local filesystem and session parsing capabilities supplied by the host. */
export interface AgentTranscriptSource {
	fs: Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "readFileSync" | "statSync">;
	parseEntries(text: string): AgentTranscriptEntry[];
	visitEntries(
		filePath: string,
		visit: (entry: AgentTranscriptEntry) => void,
		options: VisitEntriesFromFileStreamOptions,
	): Promise<unknown>;
}
