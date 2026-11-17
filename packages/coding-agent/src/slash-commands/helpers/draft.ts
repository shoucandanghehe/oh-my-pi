import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../types";

/** Clear only text still owned by this submission, never a newer detached draft. */
export function clearSubmittedText(runtime: TuiSlashCommandRuntime): void {
	if (!runtime.draftDetached) runtime.ctx.editor.setText("");
}

/** A text-only command gives a draft with images back instead of running without them; returns whether it refused. */
export function refuseImages(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): boolean {
	const images = runtime.input?.images;
	if (!images?.length) return false;
	runtime.ctx.editor.restoreDetachedDraft(command.text, images, runtime.input?.imageLinks);
	runtime.ctx.showWarning(`/${command.name} takes text only; remove the images to run it`);
	return true;
}

/**
 * Run a command that takes its whole draft, images included. An unsent draft gets
 * its attachments back, and with `restoreText` its text too; a `run` that throws on
 * a detached draft is left to the caller, which already took the draft out.
 */
export async function runWithDetachedDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
	options?: { restoreText?: boolean },
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		const hasAttachments = (runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0;
		if (submitted || !(hasAttachments || options?.restoreText)) return;
		if (runtime.draftDetached || options?.restoreText) {
			// Newer typing may already sit in the editor: merge the submission
			// back beside it so each draft's image markers keep their images.
			editor.restoreDetachedDraft(command.text, runtime.input?.images, runtime.input?.imageLinks);
			return;
		}
		editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
		editor.pendingImageLinks = [
			...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
			...editor.pendingImageLinks,
		];
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
	} catch (error) {
		if (runtime.draftDetached) {
			// The caller already took this draft out of the editor before
			// dispatch (Ctrl+Enter's `handleFollowUp`, or `onSubmit` for these
			// commands); it owns restoring the submission and reporting the
			// error so a submission that failed after newer text was typed
			// merges with it once, instead of being silently dropped here.
			throw error;
		}
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
