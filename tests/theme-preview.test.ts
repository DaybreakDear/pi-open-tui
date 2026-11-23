import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, saveConfig, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import openTui from "../extensions/open-tui/index.ts";
import { registerSettingsCommand } from "../extensions/open-tui/settings-command.ts";
import { PRESET_LABELS, ThemePreviewPage, appliedConfig, previewConfig } from "../extensions/open-tui/theme-preview.ts";
import { PRESET_SLOTS, THEME_PRESETS, type ThemeConfig } from "../extensions/open-tui/theme.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

interface Paint {
	text: string;
	fg: unknown;
}

/**
 * Records what `createPainter` paints with. Colour literals go through `theme.style`, so the fg
 * argument is the parsed `{ kind: "rgb", r, g, b }` colour the swatch is drawn with.
 */
const painted: Paint[] = [];

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string, style: { fg?: unknown }) => {
		painted.push({ text, fg: style.fg });
		return text;
	},
} as Theme;

function resetPainted(): void {
	painted.length = 0;
}

interface PreviewCalls {
	preview: OpenTuiConfig[];
	apply: OpenTuiConfig[];
	revert: OpenTuiConfig[];
	close: number;
}

interface PreviewFixture {
	page: ThemePreviewPage;
	calls: PreviewCalls;
	/** The configuration the page was opened with: what Esc must put back. */
	opened: OpenTuiConfig;
	render: (width?: number) => string[];
	press: (key: string) => void;
}

/** A page on its own: no TUI, no overlay, only the hooks the settings page would wire up. */
function previewFixture(t: TestContext, themeOverrides: Partial<ThemeConfig> = {}): PreviewFixture {
	const agentDir = temporaryDirectory(t, "open-tui-preview-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const opened = structuredClone(DEFAULT_CONFIG);
	opened.theme = { ...opened.theme, preset: "tokyo-night", dividers: "dashed", ...themeOverrides };
	saveConfig(opened);

	const calls: PreviewCalls = { preview: [], apply: [], revert: [], close: 0 };
	resetPainted();
	const page = new ThemePreviewPage(theme, opened, {
		preview: (next) => calls.preview.push(next),
		// The real apply persists through the settings page's writer, so the fixture writes too.
		apply: (next) => {
			calls.apply.push(next);
			saveConfig(next);
		},
		revert: (next) => calls.revert.push(next),
		close: () => {
			calls.close += 1;
		},
	});
	return {
		page,
		calls,
		opened,
		render: (width = 80) => page.render(width),
		press: (key) => page.handleInput(key),
	};
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

// T8.1
test("the preview page lists the five open-tui presets and marks the current one", (t) => {
	const { render } = previewFixture(t);
	const lines = render();

	for (const preset of THEME_PRESETS) {
		assert.ok(lines.some((line) => line.includes(PRESET_LABELS[preset])), `${preset} row missing`);
	}
	const markers = lines.filter((line) => /^ {2}→/.test(line));
	assert.equal(markers.length, 1, "exactly one row carries the selection marker");
	// The fixture opens on tokyo-night, so that is the row the marker must sit on.
	assert.match(markers[0]!, new RegExp(PRESET_LABELS["tokyo-night"]));
});

// T8.2
test("left and right preview without writing the configuration", (t) => {
	const { press, calls, render } = previewFixture(t);
	const before = readFileSync(getConfigPath(), "utf8");

	press(RIGHT);
	press(RIGHT);
	press(LEFT);

	assert.equal(calls.preview.length, 3);
	// tokyo-night → catppuccin-mocha → gruvbox-dark → catppuccin-mocha
	assert.deepEqual(calls.preview.map((config) => config.theme.preset), [
		"catppuccin-mocha",
		"gruvbox-dark",
		"catppuccin-mocha",
	]);
	assert.equal(calls.apply.length, 0, "previewing is not applying");
	assert.equal(calls.revert.length, 0, "previewing is not reverting");
	assert.equal(readFileSync(getConfigPath(), "utf8"), before, "the on-disk configuration must not move");
	assert.match(render().find((line) => /^ {2}→/.test(line))!, new RegExp(PRESET_LABELS["catppuccin-mocha"]));
});

// T8.3
test("Enter applies and persists the previewed preset", (t) => {
	const { press, calls } = previewFixture(t);

	press(RIGHT);
	press("\r");

	assert.equal(calls.apply.length, 1);
	const applied = calls.apply[0]!;
	assert.equal(applied.theme.preset, "catppuccin-mocha");
	assert.equal(loadConfig().theme.preset, "catppuccin-mocha", "Enter must reach the disk");
	// Every other switch survives the apply: `pi` is a full restore, not a reset to defaults.
	assert.equal(applied.theme.dividers, "dashed");
	assert.equal(applied.theme.timestamps, DEFAULT_CONFIG.theme.timestamps);
	assert.equal(calls.close, 1, "applying leaves the page");
});

// T8.4
test("Esc reverts to exactly the configuration captured on entry", (t) => {
	const { press, calls, opened } = previewFixture(t);
	const captured = structuredClone(opened);

	press(RIGHT);
	press(RIGHT);
	press(LEFT);
	press("\x1b");

	assert.equal(calls.revert.length, 1);
	assert.equal(calls.apply.length, 0, "Esc must not persist");
	assert.deepEqual(calls.revert[0], captured, "the revert payload is the entry snapshot");
	assert.deepEqual(calls.revert[0]!.theme, {
		preset: "tokyo-night",
		slots: {},
		dividers: "dashed",
		gutter: captured.theme.gutter,
		banding: captured.theme.banding,
		userBar: captured.theme.userBar,
		timestamps: captured.theme.timestamps,
		expandHint: captured.theme.expandHint,
	});
	assert.deepEqual(loadConfig().theme, captured.theme, "the file still holds the entry state");
});

// T8.5
test("every preset row is a real swatch plus a body sample and a divider sample", (t) => {
	const { render } = previewFixture(t);
	const lines = render();

	// Each row paints its colour strip through `createPainter`, i.e. with the colours the preset
	// itself resolves — not with the user's per-slot overrides.
	for (const preset of ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "rose-pine-moon"] as const) {
		const divider = parseColor(PRESET_SLOTS[preset].divider!);
		assert.ok(
			painted.some((paint) => paint.text.includes("█") && sameColor(paint.fg, divider)),
			`${preset} must paint a solid block in its own divider colour`,
		);
		assert.ok(
			painted.some((paint) => /^─+$/.test(paint.text) && sameColor(paint.fg, divider)),
			`${preset} must show a divider sample in its own divider colour`,
		);
	}
	const toolOutput = parseColor(PRESET_SLOTS["tokyo-night"].toolOutput!);
	assert.ok(
		painted.some((paint) => paint.text.length > 4 && sameColor(paint.fg, toolOutput)),
		"a body sample must be painted with the preset's body colour",
	);
	assert.equal(lines.filter((line) => line.includes("█")).length, THEME_PRESETS.length, "one swatch row per preset");
});

function sameColor(actual: unknown, expected: unknown): boolean {
	try {
		assert.deepEqual(actual, expected);
		return true;
	} catch {
		return false;
	}
}

// T8.6
test("reverting twice, and reverting after the page settled, are no-ops", (t) => {
	const { page, press, calls } = previewFixture(t);

	press(RIGHT);
	assert.doesNotThrow(() => page.dispose());
	assert.doesNotThrow(() => page.dispose());
	assert.equal(calls.revert.length, 1, "dispose reverts at most once");

	// A key after dispose (the overlay may still deliver one) must not throw or revert again.
	assert.doesNotThrow(() => press("\x1b"));
	assert.doesNotThrow(() => press(RIGHT));
	assert.equal(calls.revert.length, 1);
	assert.equal(calls.preview.length, 1, "a settled page stops previewing");

	const applied = previewFixture(t);
	applied.press(RIGHT);
	applied.press("\r");
	assert.doesNotThrow(() => applied.page.dispose());
	assert.equal(applied.calls.revert.length, 0, "an applied page has nothing left to put back");
});

/**
 * Boots the real extension so a keypress travels the production path: settings row → sub-page →
 * in-memory config → `repaint()`. Nothing here may reach `ctx.ui.setTheme`.
 */
function overlayHarness(
	t: TestContext,
	initialTheme: Partial<ThemeConfig> = {},
): {
	open: () => SettingsComponent;
	/** What was on disk before the overlay opened: the page must capture exactly this. */
	opened: OpenTuiConfig;
	counts: { invalidate: number; forced: number; setTheme: number };
	fire: (event: string) => void;
} {
	const agentDir = temporaryDirectory(t, "open-tui-preview-overlay-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;

	// The extension reads the file once, at `session_start`, so the state under test has to be on
	// disk before the handlers are wired; writing it afterwards would only touch a dead snapshot.
	const opened = structuredClone(DEFAULT_CONFIG);
	opened.theme = { ...opened.theme, ...initialTheme };
	assert.equal(saveConfig(opened), true);

	const counts = { invalidate: 0, forced: 0, setTheme: 0 };
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
			// Any preview that went through `setTheme` would stop the theme watcher and kill live
			// reloading for the rest of the session, so the harness counts the calls instead.
			setTheme() {
				counts.setTheme += 1;
			},
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory?: unknown) {
				editorFactory = factory;
				if (typeof factory === "function") {
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

	return {
		opened,
		open() {
			void command?.("", ctx);
			assert.ok(settings, "the settings overlay must be built");
			return settings;
		},
		counts,
		fire(event) {
			void handlers.get(event)?.({ type: event }, ctx);
		},
	};
}

/**
 * The overlay as `registerSettingsCommand` builds it on `DEFAULT_CONFIG` at 80×24 — the shape the
 * f23a62a baseline was captured in. `DEFAULT_CONFIG` is what `loadConfig()` returns without a file.
 */
function settingsOnlyHarness(): SettingsComponent {
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	const pi = {
		registerCommand(_name: string, registered: { handler?: typeof handler }) {
			handler = registered.handler;
		},
	} as unknown as ExtensionAPI;
	registerSettingsCommand(pi, {
		getConfig: () => structuredClone(DEFAULT_CONFIG),
		onConfigChanged: () => {},
		onOverlayClosed: () => {},
	});
	const terminal = { columns: 80, rows: 24 };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory: (t: TUI, th: Theme, kb: KeybindingsManager, done: (value: void) => void) => Component) => {
				component = factory(tui, theme, {} as KeybindingsManager, () => {}) as SettingsComponent;
				return new Promise<void>(() => {});
			},
		},
	} as unknown as ExtensionContext;
	void handler?.("", ctx);
	assert.ok(component, "the harness must build the overlay");
	return component;
}

/**
 * The off-path guarantee: opening the preview must be the only thing that can change what the
 * settings overlay looks like. These tabs cannot know the feature exists.
 */
test("the settings overlay is byte-identical to f23a62a on every tab the preview does not touch", () => {
	const baseline = JSON.parse(
		readFileSync(new URL("./fixtures/settings-render-f23a62a.json", import.meta.url), "utf8"),
	) as Record<"features" | "icons" | "segments" | "telemetry", string[]>;
	const settings = settingsOnlyHarness();

	assert.deepEqual(settings.render(80), baseline.features);

	settings.handleInput("\t");
	const appearance = settings.render(80);
	const entry = appearance.findIndex((line) => line.includes("Preview themes"));
	assert.ok(entry > 0, "Appearance must carry the preview entry row");
	assert.deepEqual(
		[...appearance.slice(0, entry), ...appearance.slice(entry + 1)],
		baseline.icons,
		"Appearance may differ by the preview entry only",
	);

	settings.handleInput("\t");
	assert.deepEqual(settings.render(80), baseline.segments);
	settings.handleInput("\t");
	assert.deepEqual(settings.render(80), baseline.telemetry);
});

/** Walks the Appearance page down to the preview entry row and opens the sub-page. */
function openPreviewPage(html: SettingsComponent): void {
	html.handleInput("\t");
	for (let i = 0; i < 24 && !/Preview themes/.test(selectedLine(html)); i++) html.handleInput("\x1b[B");
	assert.match(selectedLine(html), /Preview themes/, "Appearance must offer the preview entry");
	html.handleInput("\r");
	assert.match(html.render(100).join("\n"), /Theme preview/, "Enter on the entry row must open the sub-page");
}

function selectedLine(component: SettingsComponent, width = 100): string {
	return component.render(width).find((line) => line.includes("→ ")) ?? "";
}

// T8.7
test("previewing and closing leaves the on-disk configuration byte-identical", (t) => {
	const host = overlayHarness(t, { preset: "gruvbox-dark" });
	const before = readFileSync(getConfigPath(), "utf8");

	const settings = host.open();
	openPreviewPage(settings);

	host.counts.invalidate = 0;
	host.counts.forced = 0;
	settings.handleInput(RIGHT);
	assert.equal(host.counts.invalidate, 1, "a preview repaints through invalidate()");
	assert.equal(host.counts.forced, 1);
	settings.handleInput(RIGHT);
	assert.equal(host.counts.invalidate, 2, "every step repaints: the transcript shows the new colours");
	assert.equal(host.counts.forced, 2);
	assert.equal(host.counts.setTheme, 0, "previewing must never call ctx.ui.setTheme");
	assert.equal(readFileSync(getConfigPath(), "utf8"), before, "previewing writes nothing");

	settings.handleInput("\x1b");
	assert.equal(readFileSync(getConfigPath(), "utf8"), before, "reverting writes nothing either");
	// Back on the Appearance page, with the entry snapshot still on disk.
	assert.match(settings.render(100).join("\n"), /Theme preset/);
	assert.deepEqual(loadConfig().theme, host.opened.theme);
});

test("a preview that is still open at session_shutdown reverts once and never throws", (t) => {
	const host = overlayHarness(t, { preset: "tokyo-night" });
	const before = readFileSync(getConfigPath(), "utf8");

	const settings = host.open();
	openPreviewPage(settings);
	settings.handleInput(RIGHT);

	// Shutdown tears the overlay down behind the page's back; the page must still put the theme back.
	assert.doesNotThrow(() => host.fire("session_shutdown"));
	assert.doesNotThrow(() => settings.handleInput("\x1b"));
	assert.doesNotThrow(() => settings.handleInput("\x1b"));
	assert.equal(readFileSync(getConfigPath(), "utf8"), before, "a revert never rewrites the file");
	assert.deepEqual(loadConfig().theme, host.opened.theme);
});

test("applying from the preview page persists and keeps the other visual switches", (t) => {
	const host = overlayHarness(t, { preset: "tokyo-night", dividers: "dashed", userBar: false });

	const settings = host.open();
	openPreviewPage(settings);
	settings.handleInput(RIGHT);
	settings.handleInput("\r");

	const saved = loadConfig().theme;
	assert.equal(saved.preset, "catppuccin-mocha");
	assert.equal(saved.dividers, "dashed");
	assert.equal(saved.userBar, false);
	assert.equal(saved.timestamps, host.opened.theme.timestamps);
	// Applying returns to the settings list rather than closing the overlay.
	assert.match(settings.render(100).join("\n"), /Theme preset/);
});

// The helpers are part of the page's contract, so pin them directly.
test("previewConfig shows the preset while appliedConfig keeps the snapshot", () => {
	const base = structuredClone(DEFAULT_CONFIG);
	base.theme = { ...base.theme, preset: "tokyo-night", slots: { toolTitle: "#ff0000" } };

	const preview = previewConfig(base, "gruvbox-dark");
	assert.equal(preview.theme.preset, "gruvbox-dark");
	assert.deepEqual(preview.theme.slots, {}, "a preview must drop the user's overrides, not hide the preset behind them");
	assert.equal(preview.theme.dividers, base.theme.dividers);

	const applied = appliedConfig(base, "pi");
	assert.equal(applied.theme.preset, "pi");
	assert.deepEqual(applied.theme.slots, base.theme.slots, "the user's own overrides come back with pi");
	assert.equal(applied.theme.timestamps, base.theme.timestamps);
});
