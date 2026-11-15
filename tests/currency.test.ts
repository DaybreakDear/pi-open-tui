import assert from "node:assert/strict";
import test from "node:test";
import {
	convertUsd,
	currencySymbol,
	DEFAULT_COST,
	formatCost,
	formatRate,
	type CostConfig,
	type CurrencyCode,
} from "../extensions/open-tui/currency.ts";

const usd: CostConfig = DEFAULT_COST;
const cny: CostConfig = { ...DEFAULT_COST, currency: "cny" };

test("usd renders a single $ and no duplicated glyph", () => {
	assert.equal(formatCost(0.0063, usd), "$0.006");
	// Regression: footer used to render `${glyphs.cost} $0.006` => "$ $0.006".
	assert.equal(formatCost(0.0063, usd).match(/\$/g)?.length, 1);
});

test("cny converts with the configured rate", () => {
	assert.equal(formatCost(0.0063, cny), "¥0.045");
	assert.equal(currencySymbol("usd"), "$");
	assert.equal(currencySymbol("cny"), "¥");
	// The config file is hand-editable, so an unknown code must not render the literal "undefined".
	assert.equal(currencySymbol("eur" as CurrencyCode), "$");
});

test("precision switches at 0.1 on the converted value", () => {
	assert.equal(formatCost(0.0999, usd), "$0.100");
	assert.equal(formatCost(0.1, usd), "$0.10");
	assert.equal(formatCost(1.234, usd), "$1.23");
	assert.equal(formatCost(0, usd), "$0.000");
	// 0.01 USD = 0.072 CNY stays below the threshold after conversion.
	assert.equal(formatCost(0.01, cny), "¥0.072");
	// 0.014 USD = 0.100 CNY crosses it, so the precision drops to two digits.
	assert.equal(formatCost(0.014, cny), "¥0.10");
});

test("rate formatting", () => {
	assert.equal(formatRate(0.15, usd), "$0.15/M");
	assert.equal(formatRate(0.15, cny), "¥1.07/M");
	assert.equal(formatRate(null, usd), null);
	assert.equal(formatRate(null, cny), null);
});

test("convertUsd is identity for usd and takes the default rate for bad ones", () => {
	assert.equal(convertUsd(1, usd), 1);
	// One fallback for the whole module: a typo must not silently convert at a 1:1 rate.
	assert.equal(convertUsd(1, { ...cny, usdToCny: Number.NaN }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(1, { ...cny, usdToCny: -2 }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 0 }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(1, { ...cny, usdToCny: Number.POSITIVE_INFINITY }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(2, cny), 14.3);
});

test("non-finite amounts never render NaN", () => {
	assert.equal(formatCost(Number.NaN, usd), "$0.000");
	assert.equal(formatCost(Number.POSITIVE_INFINITY, usd), "$0.000");
	assert.equal(formatRate(Number.NaN, usd), null);
});

test("negative amounts clamp to zero instead of rendering the symbol before the minus", () => {
	// Provider figures are only guarded by Number.isFinite upstream, so negatives are reachable.
	for (const value of [-1, -0.5, -1e-9]) {
		assert.equal(formatCost(value, usd), "$0.000", `formatCost(${value})`);
		assert.equal(formatRate(value, cny), "\u00a50.000/M", `formatRate(${value})`);
	}
});

test("rates outside the supported window are treated as typos", () => {
	// 1e300 stays finite, but toFixed switches to exponential form at 1e21.
	const absurd = formatCost(0.00028, { ...cny, usdToCny: 1e300 });
	assert.equal(absurd, "\u00a50.002", "the shipped default rate, not a 1:1 conversion");
	assert.equal(absurd.includes("e+"), false);

	// Both boundaries are inclusive; a rate beyond either one snaps to the shipped default.
	assert.equal(convertUsd(1, { ...cny, usdToCny: 0.01 }), 0.01);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 1000 }), 1000);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 0.009 }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 1000.5 }), DEFAULT_COST.usdToCny);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 1e300 }), DEFAULT_COST.usdToCny);
});
