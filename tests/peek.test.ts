import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildPeekLabel,
	clipTail,
	collectPeekParts,
	createPeekState,
	peekTail,
	reducePeek,
} from "../extensions/open-tui/peek.ts";
import type { IconGlyphs } from "../extensions/open-tui/icons.ts";
import { sanitizeStatus } from "../extensions/open-tui/utils.ts";

const glyphs = { thinking: "~", done: "+" } as IconGlyphs;

// Content collection.
test("collectPeekParts joins thinking and answer text, ignoring other parts", () => {
	const parts = collectPeekParts([
		{ type: "thinking", thinking: "alpha" },
		{ type: "text", text: "answer" },
		{ type: "toolCall", id: "x", name: "read", arguments: {} },
		{ type: "thinking", thinking: " beta" },
	]);
	assert.deepEqual(parts, { thinking: "alpha beta", text: "answer" });
});

test("collectPeekParts tolerates non-array content", () => {
	assert.deepEqual(collectPeekParts(undefined), { thinking: "", text: "" });
	assert.deepEqual(collectPeekParts("nope"), { thinking: "", text: "" });
});

test("collectPeekParts ignores non-string fields without coercing or throwing", () => {
	assert.deepEqual(
		collectPeekParts([
			{ type: "thinking", thinking: Symbol("invalid"), text: "fallback" },
			{ type: "thinking", thinking: { invalid: true }, text: " next" },
			{ type: "text", text: { invalid: true } },
			{ type: "text", text: Symbol("invalid") },
		]),
		{ thinking: "fallback next", text: "" },
	);
});

// Logical tails and display-width clipping.
for (const [name, source, count, expected] of [
	["last logical line", "first line\nsecond line here", 1, "second line here"],
	["last two nonempty lines", "first\nsecond\n\nthird", 2, "second\nthird"],
	["collapsed whitespace", "  padded   text  \n", 1, "padded text"],
	["blank input", "   ", 1, ""],
	["empty input", "", 1, ""],
] as const) {
	test(`peekTail: ${name}`, () => assert.equal(peekTail(source, count), expected));
}

test("peekTail keeps the full tail; width bounding is clipTail's job", () => {
	assert.equal(peekTail("x".repeat(500)).length, 500);
});

test("clipTail keeps the end of long text within budget", () => {
	const tail = clipTail("x".repeat(500), 10);
	assert.equal(tail, "…" + "x".repeat(9));
});

test("clipTail truncates wide CJK text by visible width, not code points", () => {
	const tail = clipTail("思".repeat(100), 10);
	// budget 10 → 1 col for "…" + 4 wide chars (8 cols) = 9 visible columns
	assert.equal(tail, "…" + "思".repeat(4));
	assert.ok(visibleWidth(tail) <= 10);
});

for (const [name, source, budget, expected] of [
	["fitting Latin text", "short", 10, "short"],
	["fitting CJK text", "思思", 4, "思思"],
	["zero-width prefix with Latin", "\u200babc", 3, "\u200babc"],
	["zero-width prefix with CJK", "\u200b思", 2, "\u200b思"],
	["zero budget", "abc", 0, ""],
	["negative budget", "abc", -5, ""],
	["empty input", "", 5, ""],
	["ellipsis-only budget", "abcdef", 1, "…"],
] as const) {
	test(`clipTail: ${name}`, () => assert.equal(clipTail(source, budget), expected));
}

test("clipTail preserves complete graphemes at the tail boundary", () => {
	for (const grapheme of ["😀", "👩‍💻", "e\u0301"]) {
		const tail = clipTail(grapheme.repeat(50), 5);
		assert.equal(tail, "…" + grapheme.repeat(Math.floor(4 / visibleWidth(grapheme))));
		assert.ok(visibleWidth(tail) <= 5);
	}
});

// Labels and streaming state transitions.
test("buildPeekLabel renders each phase", () => {
	const state = createPeekState();
	assert.equal(buildPeekLabel(state, 0, glyphs, 80), "~ think ·");

	state.phase = "thinking";
	state.tail = "deriving";
	assert.equal(buildPeekLabel(state, 1, glyphs, 80), "~ think ⠙ deriving");

	state.phase = "done";
	assert.equal(buildPeekLabel(state, 2, glyphs, 80), "~ think +");
});

test("buildPeekLabel aligns the latest thought with the previous thought", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nlatest thought" },
		0,
		glyphs,
		80,
		2,
	);
	const [previous, latest] = label.split("\n");
	assert.ok(previous !== undefined && latest !== undefined);
	assert.equal(previous.indexOf("previous thought"), latest.indexOf("latest thought"));
});

test("buildPeekLabel wraps an overflowing latest thought instead of keeping the previous one", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nabcdefghijklmnopqrstuvwxyz" },
		0,
		glyphs,
		30,
		2,
	);
	const [first, second] = label.split("\n");
	assert.ok(first !== undefined && second !== undefined);
	assert.ok(!label.includes("previous thought"));
	assert.match(first, /~ think ⠋ abcdefghijklmnopqrst/);
	assert.match(second, /uvwxyz$/);
	assert.equal(first.indexOf("abcdefghijklmnopqrst"), second.indexOf("uvwxyz"));
});

test("buildPeekLabel follows new deltas after a long thought fills both rows", () => {
	for (const thought of ["word ".repeat(200), "思考".repeat(500), "x".repeat(1000)]) {
		const before = buildPeekLabel({ phase: "thinking", tail: thought }, 0, glyphs, 30, 2);
		for (const delta of ["NEW", "NEW_DELTA"]) {
			const after = buildPeekLabel({ phase: "thinking", tail: thought + delta }, 0, glyphs, 30, 2);
			assert.notEqual(after, before);
			assert.ok(after.endsWith(delta), "the latest delta must be visible with a fixed spinner frame");
			const rows = after.split("\n");
			assert.equal(rows.length, 2);
			assert.ok(rows.every((row) => visibleWidth(row) <= 30));
		}
	}
});

test("buildPeekLabel never exceeds the label width, even on narrow terminals", () => {
	const state = { phase: "thinking" as const, tail: "思".repeat(200) };
	for (const width of [80, 40, 8, 200]) {
		assert.ok(visibleWidth(buildPeekLabel(state, 0, glyphs, width)) <= width);
	}
	for (const line of buildPeekLabel({ phase: "thinking", tail: "前一行\n最新一行" }, 0, glyphs, 40, 2).split("\n")) {
		assert.ok(visibleWidth(line) <= 40);
	}
});

test("buildPeekLabel fills wide terminals instead of a fixed cap", () => {
	const state = { phase: "thinking" as const, tail: "x".repeat(500) };
	const line = buildPeekLabel(state, 0, glyphs, 200);
	assert.ok(visibleWidth(line) > 92, "wide terminals must see more than the old 92-col cap");
});

test("reducePeek: spinner starts on thinking, stops when answer text arrives", () => {
	const idle = createPeekState();
	const t = reducePeek(idle, { thinking: "reasoning", text: "" });
	assert.equal(t.phase, "thinking");
	assert.equal(t.tail, "reasoning");

	const done = reducePeek(t, { thinking: "reasoning more", text: "answer" });
	assert.equal(done.phase, "done");

	// Cumulative thinking keeps arriving after the answer starts: stay done.
	const after = reducePeek(done, { thinking: "reasoning more", text: "answer more" });
	assert.equal(after.phase, "done");
	assert.equal(after.tail, "reasoning more");
});

test("reducePeek keeps two thinking lines for the double-line label", () => {
	const next = reducePeek(createPeekState(), { thinking: "previous\nlatest", text: "" });
	assert.equal(next.phase, "thinking");
	assert.equal(next.tail, "previous\nlatest");
});

test("reducePeek: a mixed thinking+text first update never spins", () => {
	const next = reducePeek(createPeekState(), { thinking: "short", text: "hi" });
	assert.equal(next.phase, "done");
});

test("reducePeek: text-only updates stay idle", () => {
	const next = reducePeek(createPeekState(), { thinking: "", text: "plain answer" });
	assert.equal(next.phase, "idle");
});

test("buildPeekLabel neutralizes terminal control sequences in thinking text", () => {
	const dirty = "\x1b]0;pwned\x07\x1b[31mred\x1b[0m\x1b[2J\x1b[?25l tail";
	const line = buildPeekLabel({ phase: "thinking", tail: dirty }, 0, glyphs, 80);
	assert.equal(line, "~ think ⠋ red tail");
	assert.ok(!line.includes("\x1b[31m"), "injected SGR must be removed");
	assert.ok(!line.includes("\x1b]"), "injected OSC must be removed");
	assert.ok(!line.includes("\x1b"), "no raw control sequences may remain");
});

test("sanitizeStatus preserves text around unsupported CSI sequences", () => {
	assert.equal(sanitizeStatus("\x1b[?25lvisible\x1b[31m text"), "visible text");
});

// Elapsed time and token counts in the thinking header.
const counts = { elapsedMs: 12_300, tokens: 1_240, showCounts: true };

test("buildPeekLabel appends elapsed time and token counts to the thinking header", () => {
	assert.equal(
		buildPeekLabel({ phase: "thinking", tail: "x" }, 0, glyphs, 80, 1, counts),
		"~ think ⠋ x 12.3s · 1.2k tok",
	);
});

test("buildPeekLabel keeps the v0.4.6 label when counts are off", () => {
	assert.equal(
		buildPeekLabel({ phase: "thinking", tail: "x" }, 0, glyphs, 80, 1, { ...counts, showCounts: false }),
		"~ think ⠋ x",
	);
});

test("buildPeekLabel degrades to the elapsed-only header on narrow terminals", () => {
	const label = buildPeekLabel({ phase: "thinking", tail: "x" }, 0, glyphs, 20, 1, counts);
	assert.equal(label, "~ 12s");
	assert.ok(!label.includes("tok"));
});

test("buildPeekLabel keeps the spinner and the counts while clipping the thought", () => {
	const label = buildPeekLabel({ phase: "thinking", tail: "x".repeat(400) }, 0, glyphs, 60, 1, counts);
	assert.ok(label.startsWith("~ think ⠋ "), label);
	assert.ok(label.endsWith("12.3s · 1.2k tok"), label);
	assert.ok(visibleWidth(label) <= 60, `${visibleWidth(label)} > 60`);
});

test("buildPeekLabel keeps count labels within the width budget at every width", () => {
	const state = { phase: "thinking" as const, tail: "思".repeat(200) };
	for (const width of [120, 80, 60, 40, 30, 26, 22, 20, 12, 8]) {
		for (const row of buildPeekLabel(state, 0, glyphs, width, 1, counts).split("\n")) {
			assert.ok(visibleWidth(row) <= width, `${width}: ${visibleWidth(row)} > ${width}: ${row}`);
		}
	}
});

test("buildPeekLabel keeps counts on the second row of the two-line header", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nlatest thought" },
		0,
		glyphs,
		80,
		2,
		counts,
	);
	const rows = label.split("\n");
	assert.equal(rows.length, 2);
	assert.ok(rows[0]?.includes("previous thought"), label);
	assert.ok(rows[1]?.endsWith("12.3s · 1.2k tok"), label);
	assert.ok(rows.every((row) => visibleWidth(row) <= 80));
});

test("buildPeekLabel formats long durations and small token counts", () => {
	const label = buildPeekLabel({ phase: "thinking", tail: "x" }, 0, glyphs, 80, 1, {
		elapsedMs: 65_000,
		tokens: 900,
		showCounts: true,
	});
	assert.equal(label, "~ think ⠋ x 1m 5s · 900 tok");
});

test("buildPeekLabel ignores counts outside the thinking phase", () => {
	assert.equal(buildPeekLabel({ phase: "done", tail: "" }, 2, glyphs, 80, 1, counts), "~ think +");
	assert.equal(buildPeekLabel(createPeekState(), 0, glyphs, 80, 1, counts), "~ think ·");
});
