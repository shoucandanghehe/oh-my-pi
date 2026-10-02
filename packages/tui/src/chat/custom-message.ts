import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { FramedMessageComponent } from "../chrome/message-frame";
import { Container } from "../tui";
import { plainLine } from "../native/spans";
import { replaceTabs } from "../render/render-utils";
import type { MessageRenderer } from "./extension-types";
import { theme } from "../theme";
import {
	type BtwSummaryMessageDetails,
	type CustomMessage,
	BTW_SUMMARY_MESSAGE_TYPE,
	LIVE_DELEGATION_MESSAGE_TYPE,
} from "./messages";

function isBtwSummaryDetails(details: unknown): details is BtwSummaryMessageDetails {
	return (
		isRecord(details) &&
		Array.isArray(details.summaries) &&
		details.summaries.every(
			entry =>
				isRecord(entry) &&
				typeof entry.threadKey === "string" &&
				typeof entry.threadTitle === "string" &&
				typeof entry.summary === "string",
		)
	);
}

/** Use persisted source facts for display; content remains the model-facing protocol. */
function btwSummaryRenderer(customRenderer?: MessageRenderer): MessageRenderer {
	return (message, options, uiTheme) => {
		if (customRenderer) {
			try {
				const component = customRenderer(message, options, uiTheme);
				if (component) return component;
			} catch (error) {
				logger.warn("Custom message renderer failed", { customType: message.customType, error });
			}
		}
		if (!isBtwSummaryDetails(message.details)) return undefined;
		const sources = new Container();
		for (const entry of message.details.summaries) {
			sources.addChild(
				new FramedMessageComponent({
					message: { customType: `BTW · ${plainLine(entry.threadTitle)}`, content: replaceTabs(entry.summary) },
					role: "omp.custom.btw-summary",
					borderColor: "borderAccent",
				}),
			);
		}
		return sources;
	};
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomMessage<unknown>> {
	constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer) {
		const isLiveDelegation = message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		const isHook = String(message.role) === "hookMessage";
		super({
			message,
			role: isHook ? "omp.hook" : isLiveDelegation ? "omp.custom.delegation" : "omp.custom",
			// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here:
			// tag hooks with the hook glyph, other injected messages with a neutral package.
			icon: () => (isHook ? theme.icon.extensionHook : theme.icon.package),
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
			customRenderer:
				message.customType === BTW_SUMMARY_MESSAGE_TYPE ? btwSummaryRenderer(customRenderer) : customRenderer,
		});
	}
}
