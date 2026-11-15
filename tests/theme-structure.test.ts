import assert from "node:assert/strict";
import test from "node:test";
import { keyHint, keyText, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { resolveGlyphs } from "../extensions/open-tui/icons.ts";
import { createCompactRenderers } from "../extensions/open-tui/tool-view.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";
import type { ThemeConfig } from "../extensions/open-tui/theme.ts";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

/** Markers instead of ANSI so the assertions read as structure, not escape codes. */
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bg: (color: string, text: string) => `{${color}}${text}{/${color}}`,
	bold: (text: string) => text,
	style: (text: string) => `<styled>${text}</styled>`,
} as unknown as Theme;
const glyphs = () => resolveGlyphs("unicode");

const text = (value: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: value }], details });

function context(overrides: Partial<RenderContext> = {}): RenderContext {
	const keybindingHints = { keyText, keyHint };
	return {
		...keybindingHints,
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
	};
}

const NEUTRAL: ThemeConfig = { preset: "pi", slots: {}, dividers: "none", gutter: false, banding: false };

/** One collapsed `tool_search` row: the summary line plus one body line of loaded tool names. */
function searchRows(cfg?: () => ThemeConfig): string[] {
	const compact = createCompactRenderers("tool_search", undefined, glyphs, undefined, false, undefined, undefined, cfg);
	const result = text("", { loaded: ["browser_snapshot", "browser_click"] });
	return compact.renderResult!(result, { expanded: false, isPartial: false }, theme, context({ args: { query: "browser" } }))
		.render(120);
}

test("without a theme config there is no gutter bar and no banding", () => {
	const rows = searchRows();
	assert.equal(rows.length, 2);
	assert.doesNotMatch(rows.join("\n"), /│/);
	assert.doesNotMatch(rows.join("\n"), /toolSuccessBg/);
});

test("dividers none, gutter false, and banding false reproduce the plain rows byte for byte", () => {
	// The design gate: `preset: "pi"` with the structural options off is v0.4.6 output.
	assert.deepEqual(searchRows(() => NEUTRAL), searchRows());
});

test("gutter prefixes body rows with the slot-coloured bar in the indent column", () => {
	const plain = searchRows(() => NEUTRAL);
	const rows = searchRows(() => ({ ...NEUTRAL, gutter: true }));
	assert.equal(rows.length, plain.length);
	// The summary keeps Pi's result corner; only the body line takes the bar.
	assert.equal(stripAnsi(rows[0]!), stripAnsi(plain[0]!));
	const bare = (row: string) => stripAnsi(row).replace(new RegExp("<[^<>]*>", "g"), "");
	const plainBody = bare(plain[1]!);
	assert.equal(plainBody[3], " ", "the plain body line is indented under the corner");
	assert.equal(bare(rows[1]!), `${plainBody.slice(0, 3)}│${plainBody.slice(4)}`);
	// Both prefixes are the same visible width, so no column is lost.
	assert.equal(visibleWidth(bare(rows[1]!)), visibleWidth(plainBody));
});

test("banding paints odd rows with the result background", () => {
	const rows = searchRows(() => ({ ...NEUTRAL, banding: true }));
	assert.doesNotMatch(rows[0]!, /toolSuccessBg/);
	assert.equal(rows[1]!.startsWith("{toolSuccessBg}"), true);
	assert.equal(rows[1]!.endsWith("{/toolSuccessBg}"), true);
});

test("nested codemode rows band alternately and their body line takes the bar", () => {
	const compact = createCompactRenderers("codemode", undefined, glyphs, undefined, false, undefined, undefined,
		() => ({ ...NEUTRAL, gutter: true, banding: true }));
	const calls = [
		{ name: "read", args: '{"path":"a.ts"}', status: "ok" },
		{ name: "grep", args: '{"pattern":"x"}', status: "ok" },
	];
	const result = text("console output", { calls, consoleOutput: "console output" });
	const rows = compact.renderResult!(result, { expanded: false, isPartial: false }, theme, context()).render(120);
	assert.equal(rows.length, 4);
	assert.doesNotMatch(rows[0]!, /toolSuccessBg/);
	assert.equal(rows[1]!.startsWith("{toolSuccessBg}"), true, "the second nested call is banded");
	assert.equal(rows[3]!.startsWith("{toolSuccessBg}"), true, "the body line is banded");
	assert.match(rows[3]!, /│/);
});

test("the shipped defaults turn the gutter on and banding off", () => {
	// DEFAULT_CONFIG.theme is the approved look: dividers "line", gutter true, banding false.
	assert.equal(DEFAULT_CONFIG.theme.dividers, "line");
	assert.equal(DEFAULT_CONFIG.theme.gutter, true);
	assert.equal(DEFAULT_CONFIG.theme.banding, false);
	const rows = searchRows(() => DEFAULT_CONFIG.theme);
	assert.match(rows[1]!, /│/);
	assert.doesNotMatch(rows.join("\n"), /toolSuccessBg/);
});
