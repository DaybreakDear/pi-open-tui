import assert from "node:assert/strict";
import test from "node:test";
import { resolveGlyphs, type IconGlyphs } from "../extensions/open-tui/icons.ts";

const MODES = ["nerd", "unicode", "ascii"] as const;

test("glyph sets never provide the currency symbol", () => {
	for (const mode of MODES) {
		const glyphs = resolveGlyphs(mode);
		// Currency symbols and their precision belong to currency.ts; a glyph
		// set that also emitted "$" duplicated the symbol in the footer.
		assert.equal("cost" in glyphs, false, `${mode} must not expose a cost glyph`);
	}
});

test("glyph sets still cover the semantic slots the footer and telemetry render", () => {
	const required: (keyof IconGlyphs)[] = [
		"cwd", "host", "session", "git", "working", "done", "context", "model",
		"thinking", "input", "output", "cacheHit", "speed", "latency", "stall",
		"extensions", "toolCall", "toolResult", "blocks",
	];
	for (const mode of MODES) {
		const glyphs = resolveGlyphs(mode);
		for (const key of required) {
			assert.equal(typeof glyphs[key], "string", `${mode}.${key} must stay defined`);
		}
	}
});

test("blocks glyph is pinned per icon set", () => {
	assert.equal(resolveGlyphs("nerd").blocks, "\uF0C5");
	assert.equal(resolveGlyphs("unicode").blocks, "\u29C9");
	assert.equal(resolveGlyphs("ascii").blocks, "#");
});
