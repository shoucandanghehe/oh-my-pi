import type { ExtensionWidgetContent, WidgetPlacement } from "./types";

export interface ExtensionWidget {
	readonly key: string;
	readonly placement: WidgetPlacement;
	readonly content: Exclude<ExtensionWidgetContent, undefined>;
}

export interface ExtensionPresentation {
	readonly widgets: readonly ExtensionWidget[];
	readonly statuses: ReadonlyMap<string, string>;
}

export const EMPTY_EXTENSION_PRESENTATION: ExtensionPresentation = { widgets: [], statuses: new Map() };

/** The presentation owned by one session, without its interactive UI context. */
export interface ExtensionPresentationSource {
	/** Stable until that session publishes a change. */
	getPresentation(): ExtensionPresentation;
	/** Follow future changes; read the current snapshot before subscribing. */
	subscribePresentation(listener: () => void): () => void;
}
