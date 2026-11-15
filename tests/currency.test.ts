import assert from "node:assert/strict";
import test from "node:test";
import {
	convertUsd,
	currencySymbol,
	DEFAULT_COST,
	formatCost,
	formatRate,
	type CostConfig,
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

test("convertUsd is identity for usd and guarded for bad rates", () => {
	assert.equal(convertUsd(1, usd), 1);
	assert.equal(convertUsd(1, { ...cny, usdToCny: Number.NaN }), 1);
	assert.equal(convertUsd(1, { ...cny, usdToCny: -2 }), 1);
	assert.equal(convertUsd(1, { ...cny, usdToCny: 0 }), 1);
	assert.equal(convertUsd(1, { ...cny, usdToCny: Number.POSITIVE_INFINITY }), 1);
	assert.equal(convertUsd(2, cny), 14.3);
});

test("non-finite amounts never render NaN", () => {
	assert.equal(formatCost(Number.NaN, usd), "$0.000");
	assert.equal(formatCost(Number.POSITIVE_INFINITY, usd), "$0.000");
	assert.equal(formatRate(Number.NaN, usd), null);
});
