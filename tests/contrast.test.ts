import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_SLOTS } from "../extensions/open-tui/theme.ts";

// The turn divider paints inside the user bubble and the tool gutter paints inside the tool
// row, so each slot has to stay legible against the background it actually sits on. These are
// the theme files' own backgrounds (`themes/<preset>.json`), after `vars` dereferencing:
//   divider → colors.userMessageBg (catppuccin's "$card" resolves to #313244)
//   gutter  → colors.toolPendingBg
// Refresh them together with themes/*.json; they are the surface the ratios are measured on.
const PRESET_BACKGROUNDS: Record<keyof typeof PRESET_SLOTS, { userBubble: string; tool: string }> = {
	"tokyo-night": { userBubble: "#24283b", tool: "#1f2335" },
	"catppuccin-mocha": { userBubble: "#313244", tool: "#28283c" },
	"gruvbox-dark": { userBubble: "#3c3836", tool: "#32302f" },
	"rose-pine-moon": { userBubble: "#2a273f", tool: "#2a273f" },
};

// WCAG 2.x non-text contrast: structural rules are decorative chrome, so 3:1 is the floor
// before a divider fades into the bubble it is drawn on.
const MIN_CONTRAST = 3.0;

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	assert.ok(match, `expected a #rrggbb colour, got ${hex}`);
	return {
		r: Number.parseInt(match[1]!, 16),
		g: Number.parseInt(match[2]!, 16),
		b: Number.parseInt(match[3]!, 16),
	};
}

/** WCAG relative luminance: sRGB channels linearised, then weighted 0.2126 / 0.7152 / 0.0722. */
function relativeLuminance(hex: string): number {
	const { r, g, b } = parseHex(hex);
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, always ≥ 1: the lighter luminance over the darker one, plus 0.05 each. */
function contrastRatio(a: string, b: string): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

test("the contrast helpers reproduce the WCAG reference values", () => {
	assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00");
	assert.equal(contrastRatio("#ffffff", "#000000").toFixed(2), "21.00");
	// #767676 on white is the canonical "just passes 4.5:1" grey in WCAG examples.
	assert.equal(contrastRatio("#767676", "#ffffff").toFixed(2), "4.54");
});

test("every preset's divider is legible inside the user bubble", () => {
	for (const preset of Object.keys(PRESET_SLOTS) as (keyof typeof PRESET_SLOTS)[]) {
		const divider = PRESET_SLOTS[preset].divider;
		assert.ok(divider, `${preset} has no divider colour`);
		const background = PRESET_BACKGROUNDS[preset].userBubble;
		const ratio = contrastRatio(divider, background);
		assert.ok(
			ratio >= MIN_CONTRAST,
			`${preset}: divider ${divider} on user bubble ${background} is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`,
		);
	}
});

test("every preset's gutter is legible inside the tool row", () => {
	for (const preset of Object.keys(PRESET_SLOTS) as (keyof typeof PRESET_SLOTS)[]) {
		const gutter = PRESET_SLOTS[preset].gutter;
		assert.ok(gutter, `${preset} has no gutter colour`);
		const background = PRESET_BACKGROUNDS[preset].tool;
		const ratio = contrastRatio(gutter, background);
		assert.ok(
			ratio >= MIN_CONTRAST,
			`${preset}: gutter ${gutter} on tool row ${background} is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`,
		);
	}
});
