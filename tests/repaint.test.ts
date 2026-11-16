import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/open-tui/config.ts";
import openTui from "../extensions/open-tui/index.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

interface RepaintCounts {
	/** `tui.invalidate()`: the only call that drops Pi's theme-independent render caches. */
	invalidate: number;
	/** `tui.requestRender(true)`: the forced full redraw that follows an invalidation. */
	forced: number;
}

interface RepaintHarness {
	counts: RepaintCounts;
	/** Switches to the Appearance tab, selects the row matching `label`, then toggles it. */
	selectAndToggle: (label: RegExp) => void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function selectedLine(component: SettingsComponent, width = 100): string {
	return component.render(width).find((line) => line.includes("→ ")) ?? "";
}

/**
 * Boots the real extension against a recording TUI, then opens the settings overlay so a
 * keypress travels the production path: settings row → onConfigChanged → persistConfig.
 */
function repaintHarness(t: TestContext, options: { mountEditor?: boolean } = {}): RepaintHarness {
	const agentDir = temporaryDirectory(t, "open-tui-repaint-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const counts: RepaintCounts = { invalidate: 0, forced: 0 };
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 100, rows: 30, write() {} },
		children: [],
		getShowHardwareCursor: () => false,
		setShowHardwareCursor() {},
		invalidate() {
			counts.invalidate += 1;
		},
		requestRender(force?: boolean) {
			if (force) counts.forced += 1;
		},
	} as unknown as TUI;

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let settings: SettingsComponent | undefined;
	let editorFactory: unknown;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		events: createEventBus(),
		registerCommand(name: string, registered: { handler?: typeof command }) {
			if (name === "open-tui") command = registered.handler;
		},
		registerShortcut() {},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		isIdle: () => true,
		ui: {
			theme,
			setFooter() {},
			setHeader() {},
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory?: unknown) {
				editorFactory = factory;
				// Pi mounts the editor by invoking the factory; skipping that keeps `getTui()` undefined.
				if (options.mountEditor !== false && typeof factory === "function") {
					factory(tui, theme, { matches: () => false } as unknown as KeybindingsManager);
				}
			},
			notify() {},
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => SettingsComponent,
			) => {
				settings = factory(tui, theme, {} as KeybindingsManager, () => {});
			},
		},
	} as unknown as ExtensionContext;

	openTui(pi);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	void command?.("", ctx);
	assert.ok(settings, "the settings overlay must be built");

	return {
		counts,
		selectAndToggle(label: RegExp) {
			const mounted = settings!;
			// Appearance is the second tab; its rows are reachable only from there.
			mounted.handleInput("\x1b[C");
			for (let i = 0; i < 24 && !label.test(selectedLine(mounted)); i++) mounted.handleInput("\x1b[B");
			assert.match(selectedLine(mounted), label, `Appearance must offer a ${label} row`);
			// Navigation keeps the row list cached but renders nothing new: reset before the toggle.
			counts.invalidate = 0;
			counts.forced = 0;
			mounted.handleInput(" ");
		},
	};
}

// T1.1 A theme-block change must repaint what is already drawn.
test("a preset change invalidates and forces one render", (t) => {
	const host = repaintHarness(t);
	host.selectAndToggle(/Theme preset/);
	// The change must really have landed, otherwise the assertions below are vacuous.
	assert.equal(loadConfig().theme.preset !== DEFAULT_CONFIG.theme.preset, true);
	assert.equal(host.counts.invalidate, 1);
	assert.equal(host.counts.forced, 1);
});

// T1.2 Fields outside the theme block cannot change a painted byte.
test("an icon-mode or currency change does not repaint", (t) => {
	for (const label of [/Icon mode/, /Currency\b(?! switching)/]) {
		const host = repaintHarness(t);
		host.selectAndToggle(label);
		assert.equal(host.counts.invalidate, 0, `${label} must not invalidate the screen`);
		assert.equal(host.counts.forced, 0, `${label} must not force a render`);
	}
});

// T1.3 Every visual field lives under `theme`; each one must repaint.
test("each theme visual field invalidates and forces one render", (t) => {
	for (const label of [/Dividers/, /Tool gutter/, /Row banding/, /User message rail/]) {
		const host = repaintHarness(t);
		host.selectAndToggle(label);
		assert.equal(host.counts.invalidate, 1, `${label} must invalidate the screen once`);
		assert.equal(host.counts.forced, 1, `${label} must force one render`);
	}
});

// T1.4 Before (or without) a mounted editor there is no TUI to repaint.
test("a theme change without a mounted TUI is inert", (t) => {
	const host = repaintHarness(t, { mountEditor: false });
	assert.doesNotThrow(() => host.selectAndToggle(/Theme preset/));
	assert.equal(loadConfig().theme.preset !== DEFAULT_CONFIG.theme.preset, true);
	assert.equal(host.counts.invalidate, 0);
	assert.equal(host.counts.forced, 0);
});
