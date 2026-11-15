import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	PRESET_SLOTS,
	SLOT_TOKEN,
	createPainter,
	resolveSlotColor,
	type SlotName,
	type ThemeConfig,
} from "../extensions/open-tui/theme.ts";

const piThemeConfig: ThemeConfig = { preset: "pi", slots: {}, dividers: "line", gutter: true, banding: false };

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
	} as unknown as Theme;
	return { theme, fgCalls, styleCalls };
}

test("slots beat the preset", () => {
	const cfg: ThemeConfig = { preset: "tokyo-night", slots: { thinking: "#ff0000" }, dividers: "line", gutter: true, banding: false };
	assert.equal(resolveSlotColor(cfg, "thinking"), "#ff0000");
	assert.equal(resolveSlotColor(cfg, "toolCall"), PRESET_SLOTS["tokyo-night"].toolCall);
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
	const presetPainter = createPainter(theme, { ...piThemeConfig, preset: "tokyo-night" });
	assert.equal(presetPainter.paint("toolCall", "●", "success"), "<style>●");
	assert.deepEqual(fgCalls, [{ color: "success", text: "●" }]);
});

test("raw returns the same function paint would apply", () => {
	const { theme, fgCalls } = recordingTheme();
	const painter = createPainter(theme, piThemeConfig);
	const paintDivider = painter.raw("divider");
	assert.equal(paintDivider("|"), "<fg:dim>|");
	assert.deepEqual(fgCalls, [{ color: "dim", text: "|" }]);
});
