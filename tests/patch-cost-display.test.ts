import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_COST, MAX_USD_TO_CNY, MIN_USD_TO_CNY } from "../extensions/open-tui/currency.ts";
import {
	CONFIG_READER_SRC,
	COST_DEFAULTS,
	findRemainingSites,
	MAX_RATE,
	MIN_RATE,
	PATCH_MARKER,
	PURE_FORMATTER_SRC,
	patchSource,
	sitePattern,
} from "../scripts/patch-cost-display.mjs";

// The cost readouts printed by pi-subagents and billion-context-pi hardcode `$` in nine places and
// expose no formatter hook, so open-tui's `cost.currency` never reaches them. scripts/patch-cost-display.mjs
// rewrites those nine sites in place. These tests pin the rewrite and the injected code, because a
// silent no-op here is a wrong-currency readout nobody notices.

/**
 * The exact source text of the nine hardcoded sites, copied verbatim from
 * pi-subagents/bundle/chunk-*.js and billion-context-pi/dist/index.js.
 */
const REAL_SITES = [
	// pi-subagents/bundle/chunk-4MVDMA5C.js:7152
	"  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);",
	// pi-subagents/bundle/chunk-FLNDHNPE.js:4395
	'  return `${label}: \\u2191${formatTokens(usage.input)} \\u2193${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;',
	// pi-subagents/bundle/chunk-5EMPFFO4.js:815
	"  if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);",
	// billion-context-pi/dist/index.js:19393
	'    const costStr = usage.cost.total > 0 ? ` ($${usage.cost.total.toFixed(4)})` : "";',
	// billion-context-pi/dist/index.js:20432
	'      const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";',
	// billion-context-pi/dist/index.js:21111
	'      const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";',
	// billion-context-pi/dist/index.js:21126
	"        lines.push(`cost=$${c.total.toFixed(4)}`);",
	// billion-context-pi/dist/index.js:21297
	'    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";',
	// billion-context-pi/dist/index.js:22687
	'    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";',
];

/** Marker occurrences, counted literally: PATCH_MARKER carries regex metacharacters. */
function markerCount(source: string): number {
	return source.split(PATCH_MARKER).length - 1;
}

function siteFixture(): string {
	return ["// fixture", ...REAL_SITES, ""].join("\n");
}

/** Compile the injected formatter exactly as shipped: same text, same behaviour. */
function compileFormatter(): (cfg: unknown, usd: number) => string {
	return new Function(`return ${PURE_FORMATTER_SRC};`)() as (cfg: unknown, usd: number) => string;
}

const DEFAULT_RATE = COST_DEFAULTS.usdToCny;
const usd = { currency: "usd", usdToCny: DEFAULT_RATE };
const cny = { currency: "cny", usdToCny: DEFAULT_RATE };

test("the patch covers the nine real hardcoded sites", () => {
	const fixture = siteFixture();
	assert.equal(findRemainingSites(fixture).length, 9, "the fixture must contain nine sites");

	const { code, changed, reason } = patchSource(fixture);
	assert.equal(changed, true, reason);
	assert.equal(findRemainingSites(code).length, 0, "no `$${…toFixed(4)}` site may survive the rewrite");
	assert.ok(code.includes("__potCostFormat(u.cost)"), "the `u.cost` site was not rewritten");
	assert.ok(code.includes("__potCostFormat(usage.cost)"), "the `usage.cost` site was not rewritten");
	assert.ok(code.includes("__potCostFormat(totalCost.costUsd)"), "the `totalCost.costUsd` site was not rewritten");
	assert.ok(code.includes("__potCostFormat(usage.cost.total)"), "the `usage.cost.total` site was not rewritten");
	assert.ok(code.includes("__potCostFormat(cost)"), "the bare `cost` site was not rewritten");
	assert.ok(code.includes("__potCostFormat(c.total)"), "the `c.total` site was not rewritten");
	assert.equal(markerCount(code), 1, "the marker must be prepended once");
});

test("the regex matches each site and nothing else", () => {
	assert.equal(sitePattern().global, true, "the pattern must rewrite every site in a file, not the first");
	// Already-patched output must not match, or a second run would nest `__potCostFormat(__potCostFormat(…))`.
	assert.equal(findRemainingSites("parts.push(`${__potCostFormat(u.cost)}`);").length, 0);
	// A different precision belongs to another code path and is left alone.
	assert.equal(findRemainingSites("parts.push(`$${u.cost.toFixed(2)}`);").length, 0);
});

test("the pure formatter keeps USD verbatim and converts CNY at four decimals", () => {
	const format = compileFormatter();
	// Precision is the whole point: these readouts are sub-cent, and open-tui's own formatCost
	// (2 decimals, 3 below 0.1) would print `$0.000` instead.
	assert.equal(format(usd, 1.366), "$1.3660");
	assert.equal(format(cny, 1.366), "¥9.7669");
	assert.equal(format(usd, 0.0004), "$0.0004");
	assert.equal(format(cny, 0.0004), "¥0.0029");
	assert.equal(format(cny, 0), "¥0.0000");
});

test("the pure formatter never prints NaN, and bad input falls back", () => {
	const format = compileFormatter();
	assert.equal(format(usd, Number.NaN), "$0.0000");
	assert.equal(format(usd, Number.POSITIVE_INFINITY), "$0.0000");
	assert.equal(format(cny, Number.NaN), "¥0.0000");
	// Out-of-window and non-numeric rates are typos: fall back to the shipped default, as the footer does.
	for (const rate of [1e300, -5, "7", Number.NaN, null, undefined, 0]) {
		assert.equal(format({ currency: "cny", usdToCny: rate }, 1.366), "¥9.7669", `rate ${String(rate)}`);
	}
	// The config is hand-editable, so an unknown code falls back to the dollar sign.
	assert.equal(format({ currency: "eur", usdToCny: 7.15 }, 1.366), "$1.3660");
	assert.equal(format({}, 1.366), "$1.3660");
});

test("the injected defaults match currency.ts", () => {
	// The injected strings are self-contained by design (no import of extensions/open-tui), so the
	// borrowed constants have to be checked against their source of truth.
	assert.equal(DEFAULT_RATE, DEFAULT_COST.usdToCny);
	assert.equal(MIN_RATE, MIN_USD_TO_CNY);
	assert.equal(MAX_RATE, MAX_USD_TO_CNY);
	assert.equal(COST_DEFAULTS.usdToCny, DEFAULT_COST.usdToCny);
	assert.equal(COST_DEFAULTS.currency, DEFAULT_COST.currency);
});

test("patching is idempotent", () => {
	const once = patchSource(siteFixture());
	const twice = patchSource(once.code);
	assert.equal(twice.changed, false, "a second run must not touch an already patched file");
	assert.equal(twice.code, once.code);
	assert.equal(markerCount(twice.code), 1, "the marker must stay single");
});

test("a source without sites reports that instead of a rewrite", () => {
	const { code, changed, reason } = patchSource("export const x = 1;\n");
	assert.equal(changed, false);
	assert.equal(code, "export const x = 1;\n");
	assert.match(reason, /no .*toFixed\(4\)/i);
});

test("unmet targets are detectable by file and line", () => {
	const leftovers = findRemainingSites(siteFixture());
	assert.equal(leftovers.length, 9);
	assert.deepEqual(leftovers[1], {
		line: 3,
		text: "$${usage.cost.toFixed(4)}",
		expression: "usage.cost",
	});
	// Surviving sites are what makes the tool exit non-zero after a write.
	assert.equal(findRemainingSites(patchSource(siteFixture()).code).length, 0);
});

test("the injected prefix runs as written, reading the real config file", () => {
	// A self-contained fixture instead of the nine-site one: the real sites are duplicated `const
	// costStr` declarations in different function scopes, which cannot be evaluated in one body.
	// Wrapping them in functions keeps them unevaluated until the test calls them.
	const source = [
		"function renderCostLine(u, parts) {",
		"  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);",
		"}",
		"function renderTotal(totalCost, parts) {",
		"  if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);",
		"}",
		"",
	].join("\n");
	const patched = patchSource(source).code;
	// The prefix is prepended above the file's own imports, so strip the import lines to evaluate the
	// remaining body in this scope with the same `__potFs/__potOs/__potPath` bindings.
	const body = patched
		.split("\n")
		.filter((line) => !line.startsWith("import * as __pot"))
		.join("\n");
	const evaluate = new Function(
		"__potFs",
		"__potOs",
		"__potPath",
		`${body}\nreturn { format: __potCostFormat, renderCostLine };`,
	) as (...args: unknown[]) => {
		format: (usdAmount: number) => string;
		renderCostLine: (usage: { cost: number }, parts: string[]) => void;
	};

	const directory = mkdtempSync(join(os.tmpdir(), "pi-open-tui-patch-"));
	const configPath = join(directory, "open-tui.json");
	const previous = process.env.PI_OPEN_TUI_CONFIG;
	try {
		process.env.PI_OPEN_TUI_CONFIG = configPath;
		const { format, renderCostLine } = evaluate(fs, os, nodePath);

		// A missing config must not throw and must render dollars.
		assert.equal(format(0.0004), "$0.0004");

		writeFileSync(configPath, JSON.stringify({ cost: { currency: "cny", usdToCny: 7.15 } }), "utf8");
		assert.equal(format(1.366), "¥9.7669");
		assert.equal(format(0.0004), "¥0.0029");

		// The rewritten call site, not just the helper: this is the string pi-subagents would print.
		const parts: string[] = [];
		renderCostLine({ cost: 1.366 }, parts);
		assert.deepEqual(parts, ["¥9.7669"]);

		// An unparsable config is treated as defaults rather than breaking the host package's render.
		writeFileSync(configPath, "{ not json", "utf8");
		assert.equal(format(0.0004), "$0.0004");

		// `usdToCny` outside the window falls back to the default rate.
		writeFileSync(configPath, JSON.stringify({ cost: { currency: "cny", usdToCny: 1e300 } }), "utf8");
		assert.equal(format(1.366), "¥9.7669");
	} finally {
		if (previous === undefined) delete process.env.PI_OPEN_TUI_CONFIG;
		else process.env.PI_OPEN_TUI_CONFIG = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the reader memoises but notices a rewritten config", () => {
	const directory = mkdtempSync(join(os.tmpdir(), "pi-open-tui-patch-memo-"));
	const configPath = join(directory, "open-tui.json");
	const previous = process.env.PI_OPEN_TUI_CONFIG;
	try {
		process.env.PI_OPEN_TUI_CONFIG = configPath;
		writeFileSync(configPath, JSON.stringify({ cost: { currency: "usd" } }), "utf8");
		const read = new Function(
			"__potFs",
			"__potOs",
			"__potPath",
			"__POT_COST_DEFAULTS",
			`return ${CONFIG_READER_SRC};`,
		)(fs, os, nodePath, COST_DEFAULTS) as () => { currency?: string; usdToCny?: number };
		assert.equal(read().currency, "usd");
		writeFileSync(configPath, JSON.stringify({ cost: { currency: "cny", usdToCny: 7.3 } }), "utf8");
		assert.equal(read().currency, "cny");
		assert.equal(read().usdToCny, 7.3);
	} finally {
		if (previous === undefined) delete process.env.PI_OPEN_TUI_CONFIG;
		else process.env.PI_OPEN_TUI_CONFIG = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
