import type { PaneRestorableMessage } from "@oh-my-pi/pi-tui/chat/session-controls";
import type { AgentViewSession } from "../../session/agent-session-handle";
import { materializeImageChipLinks } from "./ui-helpers";

/** Apply the receiving session's interactive input hooks without parsing commands. */
export async function preparePaneInput(
	session: AgentViewSession,
	input: PaneRestorableMessage,
): Promise<PaneRestorableMessage | undefined> {
	let { text, images, imageLinks } = input;
	const result = await session.emitInteractiveInput(text, images);
	if (result?.handled) return undefined;
	if (result?.text !== undefined) text = result.text.trim();
	if (result?.images !== undefined) {
		images = result.images;
		imageLinks = await materializeImageChipLinks(images, session.sessionManager);
	}
	if (!text && !images?.length) return undefined;
	return { text, images, imageLinks };
}
