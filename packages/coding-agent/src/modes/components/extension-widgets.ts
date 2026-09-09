import { Container, Text, type TUI } from "@oh-my-pi/pi-tui";
import type {
	ExtensionUiComponent,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions/types";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";

const MAX_WIDGET_LINES = 10;

/** Owns mounted widget instances; session runners retain only their declarations. */
export class ExtensionWidgets {
	readonly above = new Container();
	readonly below = new Container();
	readonly #widgets = new Map<string, { component: ExtensionUiComponent; container: Container }>();

	constructor(private readonly ui: TUI) {}

	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const previous = this.#widgets.get(key);
		if (previous) {
			previous.container.removeChild(previous.component);
			this.#widgets.delete(key);
			previous.component.dispose?.();
		}
		if (content === undefined) return;
		let component: ExtensionUiComponent;
		if (Array.isArray(content)) {
			const lines = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) lines.addChild(new Text(replaceTabs(line), 1, 0));
			if (content.length > MAX_WIDGET_LINES)
				lines.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			component = lines;
		} else {
			component = content(this.ui, theme);
		}
		const container = options?.placement === "belowEditor" ? this.below : this.above;
		this.#widgets.set(key, { component, container });
		container.addChild(component);
	}

	clear(): void {
		const widgets = [...this.#widgets.values()];
		this.#widgets.clear();
		this.above.clear();
		this.below.clear();
		for (const { component } of widgets) component.dispose?.();
	}
}
