/** Commands a transcript's own host supports. Missing commands have no controls. */
export interface TranscriptActions {
	copy?: (text: string) => void | Promise<void>;
	retry?: () => void | Promise<void>;
	switchModel?: () => void | Promise<void>;
	rewind?: () => void | Promise<void>;
}

let actions: TranscriptActions | undefined;

/** Configure the interactive Main host. Detached transcripts provide their own actions. */
export function setTranscriptActions(next: TranscriptActions | undefined): void {
	actions = next;
}

export function getTranscriptActions(): TranscriptActions | undefined {
	return actions;
}
