import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import openTui from "../extensions/open-tui/index.ts";
import {
	PRESET_SLOTS,
	SLOT_TOKEN,
	createPainter,
	createSkinProvider,
	resolveSlotColor,
	type SlotName,
	type ThemeConfig,
} from "../extensions/open-tui/theme.ts";
import { createCompactRenderers } from "../extensions/open-tui/tool-view.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

const piThemeConfig: ThemeConfig = { preset: "pi", slots: {}, dividers: "line", gutter: true, banding: false, userBar: false };

interface Recorded {
	color: string;
	text: string;
}

interface RecordedStyle {
	text: string;
	options: unknown;
}

/** A theme stub that records the two call shapes the painter may use. */
function recordingTheme() {
	const fgCalls: Recorded[] = [];
	const styleCalls: RecordedStyle[] = [];
	const theme = {
		fg(color: string, text: string) {
			fgCalls.push({ color, text });
			return `<fg:${color}>${text}`;
		},
		style(text: string, options: unknown) {
			styleCalls.push({ text, options });
			return `<style>${text}`;
		},
		bold(text: string) {
			return `<bold>${text}`;
		},
	} as unknown as Theme;
	return { theme, fgCalls, styleCalls };
}

test("slots beat the preset", () => {
	const cfg: ThemeConfig = { preset: "tokyo-night", slots: { thinking: "#ff0000" }, dividers: "line", gutter: true, banding: false, userBar: false };
	assert.equal(resolveSlotColor(cfg, "thinking"), "#ff0000");
	assert.equal(resolveSlotColor(cfg, "toolCall"), "#bb9af7", "the preset's own palette colour");
});

test("preset 'pi' yields no override, so every slot falls through to its Pi token", () => {
	const cfg: ThemeConfig = { ...piThemeConfig, slots: {} };
	for (const slot of Object.keys(SLOT_TOKEN) as SlotName[]) {
		assert.equal(resolveSlotColor(cfg, slot), undefined, `${slot} must not be overridden by the pi preset`);
	}
});

test("SLOT_TOKEN pins the v0.4.6 token for every slot", () => {
	assert.deepEqual(SLOT_TOKEN, {
		thinking: "thinkingText",
		toolCall: "toolTitle",
		toolTitle: "toolTitle",
		toolOutput: "toolOutput",
		command: "toolTitle",
		divider: "dim",
		gutter: "dim",
		userBar: "accent",
		cost: "warning",
		stats: "accent",
		success: "success",
		error: "error",
		warning: "warning",
	});
});

test("tokyo-night keeps the plan's slot values", () => {
	assert.deepEqual(PRESET_SLOTS["tokyo-night"], {
		thinking: "#7aa2f7",
		toolCall: "#bb9af7",
		toolTitle: "#7dcfff",
		toolOutput: "#a9b1d6",
		command: "#e0af68",
		divider: "#3b4261",
		gutter: "#414868",
		userBar: "#7aa2f7",
		cost: "#e0af68",
	});
});

test("every preset derives its slots from that theme's palette", () => {
	for (const preset of ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "rose-pine-moon"] as const) {
		for (const [slot, value] of Object.entries(PRESET_SLOTS[preset])) {
			assert.match(value, /^#[0-9a-f]{6}$/, `${preset}.${slot} must be a hex color`);
		}
	}
});

test("paint calls theme.fg with the Pi token when nothing overrides a slot", () => {
	const { theme, fgCalls, styleCalls } = recordingTheme();
	const painter = createPainter(theme, piThemeConfig);
	assert.equal(painter.paint("toolOutput", "line"), "<fg:toolOutput>line");
	assert.deepEqual(fgCalls, [{ color: "toolOutput", text: "line" }]);
	assert.deepEqual(styleCalls, []);
});

test("paint calls theme.fg when the slot value names a token", () => {
	const { theme, fgCalls, styleCalls } = recordingTheme();
	const painter = createPainter(theme, { ...piThemeConfig, slots: { cost: "error" } });
	assert.equal(painter.paint("cost", "$0.01"), "<fg:error>$0.01");
	assert.deepEqual(fgCalls, [{ color: "error", text: "$0.01" }]);
	assert.deepEqual(styleCalls, []);
});

test("paint calls theme.style with a parsed color for hex values", () => {
	const { theme, fgCalls, styleCalls } = recordingTheme();
	const painter = createPainter(theme, { ...piThemeConfig, slots: { thinking: "#ff0000" } });
	assert.equal(painter.paint("thinking", "…"), "<style>…");
	assert.deepEqual(fgCalls, []);
	assert.deepEqual(styleCalls, [{ text: "…", options: { fg: { kind: "rgb", r: 255, g: 0, b: 0 } } }]);
});

test("an invalid color literal falls back to the Pi token", () => {
	const { theme, fgCalls } = recordingTheme();
	const painter = createPainter(theme, { ...piThemeConfig, slots: { thinking: "#not-a-color" } });
	assert.equal(painter.paint("thinking", "x"), "<fg:thinkingText>x");
	assert.deepEqual(fgCalls, [{ color: "thinkingText", text: "x" }]);
});

test("a call-site fallback token only applies when no slot value resolves", () => {
	const { theme, fgCalls } = recordingTheme();
	const piPainter = createPainter(theme, piThemeConfig);
	assert.equal(piPainter.paint("toolCall", "●", "success"), "<fg:success>●");
	assert.deepEqual(fgCalls, [{ color: "success", text: "●" }]);
});

test("tool rows pick the slot by state, so a preset cannot swallow the status colour", () => {
	const tokyoNight: ThemeConfig = { preset: "tokyo-night", slots: {}, dividers: "line", gutter: true, banding: false, userBar: false };
	const skin = createSkinProvider(() => tokyoNight, () => 0);
	const row = createCompactRenderers("read", undefined, () => resolveGlyphs("ascii"), undefined, false, undefined, skin);
	const { theme, fgCalls, styleCalls } = recordingTheme();
	// Regression: the status token used to be passed as the fallback, so the preset's toolCall colour
	// (#bb9af7) won and a failed tool rendered purple instead of red.
	const failed = row.renderCall!({ path: "/repo/src/a.ts" }, theme, callContext({ isError: true })).render(120);
	assert.match(failed[0]!, /<fg:error>/, "a failed call paints with Pi's error token");
	assert.deepEqual(styleCalls, [], "no preset colour may replace the status colour");
	assert.equal(fgCalls.filter((call) => call.color === "error").length, 2, "the icon and the title both take error");

	fgCalls.length = 0;
	styleCalls.length = 0;
	const done = row.renderCall!({ path: "/repo/src/a.ts" }, theme, callContext()).render(120);
	assert.match(done[0]!, /<fg:success>/, "a finished call paints with Pi's success token");
	assert.ok(styleCalls.length > 0, "the rest of the row keeps the preset's colours");
});

test("an unknown slot value falls back instead of throwing when the theme has no colour table", () => {
	const fgCalls: string[] = [];
	const tokens = new Set(["thinkingText", "toolTitle", "dim", "accent", "success", "error", "warning", "toolOutput"]);
	// Shaped like Pi's own theme: an unknown name throws, and it used to throw inside render().
	const theme = {
		fg(color: string, text: string) {
			if (!tokens.has(color)) throw new Error(`Unknown theme color: ${color}`);
			fgCalls.push(color);
			return `<fg:${color}>${text}`;
		},
	} as unknown as Theme;
	// No `colors` table: the name cannot be checked up front, so the paint call has to be the gate.
	const painter = createPainter(theme, { ...piThemeConfig, slots: { thinking: "chartreuse" } });
	assert.equal(painter.paint("thinking", "…"), "<fg:thinkingText>…");
	assert.deepEqual(fgCalls, ["thinkingText"]);
});

test("raw returns the same function paint would apply", () => {
	const { theme, fgCalls } = recordingTheme();
	const painter = createPainter(theme, piThemeConfig);
	const paintDivider = painter.raw("divider");
	assert.equal(paintDivider("|"), "<fg:dim>|");
	assert.deepEqual(fgCalls, [{ color: "dim", text: "|" }]);
});

type RenderCallContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

function callContext(overrides: Partial<RenderCallContext> = {}): RenderCallContext {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...overrides,
	} as unknown as RenderCallContext;
}

test("the skin epoch busts the tool view's rendered-row cache", () => {
	let epoch = 0;
	let cfg: ThemeConfig = { preset: "pi", slots: {}, dividers: "line", gutter: true, banding: false, userBar: false };
	const skin = createSkinProvider(() => cfg, () => epoch);
	const { theme, fgCalls } = recordingTheme();
	const row = createCompactRenderers("read", undefined, () => resolveGlyphs("unicode"), undefined, false, undefined, skin);
	const context = {
		args: {},
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
	} as unknown as RenderCallContext;
	// One row component held across the switch, the way Pi keeps a rendered row alive.
	const component = row.renderCall!({ path: "a.ts" }, theme, context);
	const piRows = component.render(80);
	assert.match(piRows[0]!, /<fg:success>/, "the pi preset paints with the Pi token");
	const callsAfterFirst = fgCalls.length;
	assert.deepEqual(component.render(80), piRows, "an unchanged skin reuses the cached rows");
	assert.equal(fgCalls.length, callsAfterFirst, "the cached render paints nothing again");
	cfg = { preset: "tokyo-night", slots: {}, dividers: "line", gutter: true, banding: false, userBar: false };
	epoch += 1;
	const themed = component.render(80);
	assert.notDeepEqual(themed, piRows, "the epoch bump rebuilds the row instead of reusing it");
	assert.ok(fgCalls.length > callsAfterFirst, "the rebuild paints again");
	assert.match(themed[0]!, /<style>/, "the rebuilt row uses the new preset's literal colours");
	const callsAfterThemed = fgCalls.length;
	assert.deepEqual(component.render(80), themed, "the rebuilt row is cached under the new epoch");
	assert.equal(fgCalls.length, callsAfterThemed, "the new epoch's cache holds too");
});

type RendererFactory = Parameters<ExtensionAPI["registerToolRenderer"]>[0];

test("the extension wires the configured theme into its painter and keeps the epoch for other changes", (t) => {
	const agentDir = temporaryDirectory(t, "open-tui-skin-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// The factory default preset is tokyo-night, which is what the painter has to read from the file.
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
		...DEFAULT_CONFIG,
		toolView: { mode: "compact", extensionTools: false, exclude: [] },
	}));

	let rendererFactory: RendererFactory | undefined;
	let shortcut: ((ctx: ExtensionContext) => void) | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		events: createEventBus(),
		registerCommand() {},
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
			if (key === "ctrl+shift+m") shortcut = options.handler;
		},
		registerToolRenderer: (factory: RendererFactory) => {
			rendererFactory = factory;
		},
		registerMarkdownTransformer() {},
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui: {
			setFooter() {},
			setHeader() {},
			getEditorComponent: () => undefined,
			setEditorComponent() {},
			notify() {},
			custom: () => undefined,
		},
	} as unknown as ExtensionContext;
	openTui(pi);
	handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.ok(rendererFactory, "the extension must register its compact renderers");
	assert.ok(shortcut, "ctrl+shift+m must be registered");

	// A builtin tool without a native renderer of its own still gets the compact row.
	const compact = rendererFactory("read", () => ({} as unknown as ToolRenderers));
	assert.ok(compact);
	const { theme, styleCalls } = recordingTheme();
	const component = compact.renderCall!({ path: "a.ts" }, theme, callContext());
	const rows = component.render(80);
	// A preset literal proves the file's theme reached the painter: PI_THEME_CONFIG would paint tokens.
	assert.match(rows[0]!, /<style>/, "the row uses the configured preset");
	const painted = styleCalls.length;
	assert.ok(painted > 0);
	assert.deepEqual(component.render(80), rows, "an unchanged skin reuses the cached row");
	assert.equal(styleCalls.length, painted);

	// A cost change is not a theme change: the epoch must stay put and the row must stay cached.
	shortcut!(ctx);
	assert.deepEqual(component.render(80), rows, "the skin epoch survives a non-theme change");
	assert.equal(styleCalls.length, painted, "a non-theme change must not repaint the row");
});
