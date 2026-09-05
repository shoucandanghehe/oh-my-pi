import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { type Component, Container, isFocusable, type OverlayOptions, setKeybindings } from "@oh-my-pi/pi-tui";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { KeybindingsManager } from "../../../src/config/keybindings";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../../src/extensibility/extensions";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { HookEditorComponent } from "../../../src/modes/components/hook-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function guestOptionLabels(request: CollabUiRequestDraft): string[] {
	if (request.kind !== "select") throw new Error(`Expected select request, got ${request.kind}`);
	return request.options.map(option => (typeof option === "string" ? option : option.label));
}

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	let focused: Component | null = editor;
	editor.focused = true;
	const getFocused = () => focused;
	const setFocus = vi.fn((component: Component | null) => {
		if (focused && isFocusable(focused)) focused.focused = false;
		focused = component;
		if (focused && isFocusable(focused)) focused.focused = true;
	});
	const addAutocompleteProvider = vi.fn();
	const fakeHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
	};
	const showOverlay = vi.fn(() => fakeHandle);
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			getFocused,
			setFocus,
			showOverlay,
			terminal: { rows: 40, columns: 120 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		getFocused,
		setFocus,
		showOverlay,
		fakeHandle,
		ctx,
		controller,
		inputController: (readText: () => Promise<string>) =>
			new InputController(ctx, { readImage: async () => null, readText }),
		handleInput(data: string): void {
			if (!focused?.handleInput) throw new Error("Expected a focused input component");
			focused.handleInput(data);
		},
		getPrompt(): HookEditorComponent {
			if (!(focused instanceof HookEditorComponent)) throw new Error("Expected the custom answer editor");
			return focused;
		},
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController Ask dialog input", () => {
	const questions: ExtensionAskDialogQuestion[] = [
		{ id: "answer", question: "Choose an answer?", options: [{ label: "Default" }] },
	];

	it("waits for clipboard text before advancing the custom answer exactly once", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog([
			{ id: "first", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
			{ id: "second", question: "Next answer?", options: [{ label: "Beta" }, { label: "Gamma" }] },
		]);
		harness.handleInput(" ");
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();

		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\r");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);

		clipboard.resolve("clipboard answer");
		expect(await paste).toBe(true);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [
				{ id: "first", selectedOptions: ["Alpha"], customInput: "clipboard answer" },
				{ id: "second", selectedOptions: ["Gamma"], customInput: undefined },
			],
		});
		expect(harness.editor.getText()).toBe("");
		expect(harness.getFocused()).toBe(harness.editor);
	});

	it("does not expose the Ask dialog before a custom answer is applied", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showAskDialog([
			{ id: "answer", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
		]);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("custom answer");

		harness.handleInput("\r");

		expect(harness.getFocused()).toBeInstanceOf(HookEditorComponent);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "custom answer" }],
		});
	});

	it("discards a cancelled prompt's late paste after a new custom editor opens", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const cancelledPrompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\x1b");
		await Promise.resolve();
		await Promise.resolve();

		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		expect(replacement).not.toBe(cancelledPrompt);
		harness.handleInput("replacement answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "replacement answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("discards an aborted Ask's late paste without touching the next Ask or hidden draft", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const abort = new AbortController();
		const pending = harness.controller.showAskDialog(questions, { signal: abort.signal });
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		abort.abort();
		expect(await pending).toBeUndefined();
		expect(harness.getFocused()).toBe(harness.editor);

		const next = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		harness.handleInput("next answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await next).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "next answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("keeps a failed clipboard read editable and discards its queued empty submit", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		await Promise.resolve();
		clipboard.reject(new Error("Clipboard unavailable"));

		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("typed after failure");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "typed after failure" }],
		});
		expect(harness.editor.getText()).toBe("");
	});
});

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("exposes the draft editor cursor while it proxies input, and drops it once cleared (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// The ask dialog holds TUI focus, but rendering it must mirror focus onto
		// the draft editor so its insertion cursor is visible.
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(true);

		// Once the draft clears, the ask controls take over and the editor cursor
		// must not linger.
		harness.editor.setText("");
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(false);
	});

	it("lets the clear action empty the draft and lift the ask guard (#6738)", () => {
		const harness = makeHarness();
		// Route Ctrl+C to the guard: keep app.clear on Ctrl+C but move the ask
		// cancel key off it, so Ctrl+C reaches draft editing instead of cancelling.
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		harness.editor.setActionKeys("app.clear", ["ctrl+c"]);
		let cleared = 0;
		// Mirror interactive wiring: app.clear (Ctrl+C) clears the draft.
		harness.editor.onClear = () => {
			cleared++;
			harness.editor.setText("");
		};
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+C is reserved by the base editor and never clears; the guard must
		// dispatch the configured clear action so the "finish or clear" hint works.
		ask?.handleInput?.("\x03");
		expect(cleared).toBe(1);
		expect(harness.editor.getText()).toBe("");

		// With the draft gone the guard releases: the next key reaches the ask
		// controls and submits the highlighted option.
		ask?.handleInput?.("\n");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("remounts the draft editor when the ask surface is restored after a nested prompt (#6738)", async () => {
		const harness = makeHarness();
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		// Draft submitted: the guard lifts and ask controls take input; open the
		// note prompt, which swaps the container to the nested editor.
		harness.editor.setText("");
		ask?.handleInput?.("n");
		const promptEditor = harness.editorContainer.children[0];
		expect(promptEditor).not.toBe(ask);

		// A failed async submission restores the draft while the nested prompt is
		// open, re-blocking the guard.
		harness.editor.setText("half typed prompt");

		// Cancelling the nested prompt settles its awaited state before restoring
		// the ask surface and remounting the guarded draft editor.
		promptEditor?.handleInput?.("\x1b");
		await Promise.resolve();
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		ask?.handleInput?.("!");
		expect(harness.editor.getText()).toBe("half typed prompt!");
	});

	it("keeps localAskDialog on the host while preserving long-preview paging and submit", async () => {
		const harness = makeHarness();
		const requestGuestUi = vi.fn();
		harness.ctx.collabHost = { requestGuestUi } as never;
		const ui = await harness.init();
		if (!ui.localAskDialog) throw new Error("localAskDialog was not registered");
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
		try {
			const preview = `\`\`\`\n${Array.from({ length: 80 }, (_, index) => `PREVIEW-${index}`).join("\n")}\n\`\`\``;
			const pending = ui.localAskDialog([
				{
					id: "approval",
					question: "Approve this exact message?",
					options: [{ label: "Approve", preview }],
				},
			]);
			const ask = harness.editorContainer.children[0];
			expect(ask).toBeInstanceOf(AskDialogComponent);
			expect(ask?.render?.(80).join("\n")).toContain("PREVIEW-0");

			for (let page = 0; page < 10; page++) ask?.handleInput?.("\x1b[6~");
			expect(ask?.render?.(80).join("\n")).toContain("PREVIEW-79");
			for (let page = 0; page < 10; page++) ask?.handleInput?.("\x1b[5~");
			expect(ask?.render?.(80).join("\n")).toContain("PREVIEW-0");
			ask?.handleInput?.("\n");

			expect(await pending).toEqual({
				kind: "submit",
				results: [
					{
						id: "approval",
						question: "Approve this exact message?",
						options: ["Approve"],
						multi: false,
						selectedOptions: ["Approve"],
						customInput: undefined,
						note: undefined,
						timedOut: undefined,
					},
				],
			});
			expect(requestGuestUi).not.toHaveBeenCalled();
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("cancels localAskDialog locally without requesting a guest answer", async () => {
		const harness = makeHarness();
		const requestGuestUi = vi.fn();
		harness.ctx.collabHost = { requestGuestUi } as never;
		const ui = await harness.init();
		if (!ui.localAskDialog) throw new Error("localAskDialog was not registered");

		const pending = ui.localAskDialog([
			{
				id: "approval",
				question: "Approve?",
				options: [{ label: "Approve" }, { label: "Reject" }],
			},
		]);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		ask?.handleInput?.("\x1b");

		expect(await pending).toBeUndefined();
		expect(requestGuestUi).not.toHaveBeenCalled();
	});

	it("offers collaboration guests custom input by default", async () => {
		const harness = makeHarness();
		const requestGuestUi = vi.fn((request: CollabUiRequestDraft) => {
			if (request.kind === "select") {
				expect(guestOptionLabels(request)).toContain("Other (type your own)");
				return Promise.resolve({ kind: "answered" as const, value: "Other (type your own)" });
			}
			expect(request.kind).toBe("editor");
			return Promise.resolve({ kind: "answered" as const, value: "guest custom answer" });
		});
		harness.ctx.collabHost = { requestGuestUi } as never;
		const ui = await harness.init();

		const result = await ui.askDialog?.([
			{
				id: "choice",
				question: "Choose?",
				options: [{ label: "Option A" }],
			},
		]);

		expect(requestGuestUi).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			kind: "submit",
			results: [
				expect.objectContaining({
					id: "choice",
					selectedOptions: [],
					customInput: "guest custom answer",
				}),
			],
		});
	});

	it("advertises and honors disabled custom input for collaboration guest questions", async () => {
		const harness = makeHarness();
		let requestIndex = 0;
		const requestGuestUi = vi.fn((request: CollabUiRequestDraft) => {
			expect(request.kind).toBe("select");
			const labels = guestOptionLabels(request);
			switch (requestIndex++) {
				case 0:
					expect(labels).toEqual(["Option A", "Option B", "Chat about this"]);
					return Promise.resolve({ kind: "answered" as const, value: "Option B" });
				case 1:
					expect(labels).toEqual(["Option A", "Option B", "Next →", "Chat about this"]);
					return Promise.resolve({ kind: "answered" as const, value: "Next →" });
				case 2:
					expect(labels).toEqual(["Option C", "Chat about this"]);
					return Promise.resolve({ kind: "answered" as const, value: "Option C" });
				default:
					throw new Error(`Unexpected guest request ${requestIndex}`);
			}
		});
		harness.ctx.collabHost = { requestGuestUi } as never;
		const ui = await harness.init();
		expect(ui.askDialogCapabilities).toEqual({ allowCustomInput: true });

		const result = await ui.askDialog?.([
			{
				id: "multi",
				question: "Choose many?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
				allowCustomInput: false,
			},
			{
				id: "single",
				question: "Choose one?",
				options: [{ label: "Option C" }],
				allowCustomInput: false,
			},
		]);

		expect(requestGuestUi).toHaveBeenCalledTimes(3);
		expect(result).toEqual({
			kind: "submit",
			results: [
				expect.objectContaining({ id: "multi", selectedOptions: ["Option B"], customInput: undefined }),
				expect.objectContaining({ id: "single", selectedOptions: ["Option C"], customInput: undefined }),
			],
		});
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

describe("ExtensionUiController custom overlay", () => {
	// showHookCustom mounts the overlay in the `.then` of a Promise.try chain;
	// draining the microtask queue a few times settles it without real timers.
	const flushMicrotasks = async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	};

	it("forwards overlayOptions to showOverlay and invokes onHandle", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const onHandle = vi.fn();
		const overlayOptions: OverlayOptions = {
			anchor: "bottom-center",
			width: "85%",
			maxHeight: "55%",
			margin: { bottom: 1, left: 2, right: 2 },
		};

		ui.custom<void>(() => new Container(), { overlay: true, overlayOptions, onHandle });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
		expect(onHandle).toHaveBeenCalledTimes(1);
		expect(onHandle).toHaveBeenCalledWith(harness.fakeHandle);
	});

	it("resolves overlayOptions factories before showing the overlay", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const overlayOptions: OverlayOptions = { anchor: "top-right", width: 40 };
		const resolveOverlayOptions = vi.fn(() => overlayOptions);

		ui.custom<void>(() => new Container(), {
			overlay: true,
			overlayOptions: resolveOverlayOptions,
		});

		await flushMicrotasks();
		expect(resolveOverlayOptions).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
	});

	it("falls back to the full-cover defaults when overlayOptions is absent", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.custom<void>(() => new Container(), { overlay: true });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
	});

	it("rejects and restores the editor when a custom factory fails", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const failure = new Error("custom factory failed");

		await expect(ui.custom(() => Promise.reject(failure))).rejects.toBe(failure);

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.setFocus).toHaveBeenLastCalledWith(harness.editor);
	});

	it("aborts a pending custom factory and disposes its late component", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.editor.setText("draft before factory");
		const controller = new AbortController();
		const factory = Promise.withResolvers<Container>();
		const component = new Container() as Container & { dispose: Mock<() => void> };
		component.dispose = vi.fn();

		const pending = ui.custom(() => factory.promise, { signal: controller.signal });
		harness.editor.setText("draft typed while factory is pending");
		controller.abort();

		await expect(pending).rejects.toBe(controller.signal.reason);
		factory.resolve(component);
		await flushMicrotasks();

		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("draft typed while factory is pending");
	});
});
