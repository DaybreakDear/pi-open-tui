import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG, loadConfig, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import { DEFAULT_COST } from "../extensions/open-tui/currency.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

function configWith(t: TestContext, raw: unknown): OpenTuiConfig {
	const agentDir = temporaryDirectory(t, "open-tui-config-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify(raw), "utf8");
	return loadConfig();
}

test("defaults the cost block when the config has none", (t) => {
	const config = configWith(t, { enabled: true });
	assert.deepEqual(config.cost, DEFAULT_COST);
	assert.deepEqual(DEFAULT_CONFIG.cost, DEFAULT_COST);
});

test("keeps a valid cost block", (t) => {
	const config = configWith(t, { cost: { currency: "cny", usdToCny: 7.4, switchable: false } });
	assert.deepEqual(config.cost, { currency: "cny", usdToCny: 7.4, switchable: false });
});

test("falls back per field on invalid cost values", (t) => {
	const config = configWith(t, { cost: { currency: "eur", usdToCny: 0, switchable: "yes" } });
	assert.equal(config.cost.currency, "usd");
	assert.equal(config.cost.usdToCny, DEFAULT_COST.usdToCny);
	assert.equal(config.cost.switchable, DEFAULT_COST.switchable);

	// A string is not a boolean, whatever it spells.
	const stringFalse = configWith(t, { cost: { switchable: "false" } });
	assert.equal(stringFalse.cost.switchable, true, "a \"false\" string must not flip the flag off");

	// Cost flags default to true, so only a flag that defaults to false can prove the fallback runs
	// instead of a truthiness read: "yes" must not become true here.
	assert.equal(DEFAULT_CONFIG.inlineFooter, false, "this gate only holds while the default is false");
	const truthyString = configWith(t, { inlineFooter: "yes" });
	assert.equal(truthyString.inlineFooter, false, "a truthy string falls back to the default");

	const negative = configWith(t, { cost: { currency: "cny", usdToCny: -2 } });
	assert.equal(negative.cost.currency, "cny");
	assert.equal(negative.cost.usdToCny, DEFAULT_COST.usdToCny);

	const nonNumeric = configWith(t, { cost: { usdToCny: "7.5" } });
	assert.equal(nonNumeric.cost.usdToCny, DEFAULT_COST.usdToCny);

	const broken = configWith(t, { cost: "cny" });
	assert.deepEqual(broken.cost, DEFAULT_COST);

	const infinite = configWith(t, { cost: { usdToCny: 1e999 } });
	assert.equal(infinite.cost.usdToCny, DEFAULT_COST.usdToCny);

	// Finite but absurd rates would render as ¥6.3e+297, so the window is bounded.
	const absurd = configWith(t, { cost: { usdToCny: 1e300 } });
	assert.equal(absurd.cost.usdToCny, DEFAULT_COST.usdToCny);
	const belowWindow = configWith(t, { cost: { usdToCny: 0.009 } });
	assert.equal(belowWindow.cost.usdToCny, DEFAULT_COST.usdToCny);
	const aboveWindow = configWith(t, { cost: { usdToCny: 1000.5 } });
	assert.equal(aboveWindow.cost.usdToCny, DEFAULT_COST.usdToCny);
	const lowerBound = configWith(t, { cost: { usdToCny: 0.01 } });
	assert.equal(lowerBound.cost.usdToCny, 0.01);
	const upperBound = configWith(t, { cost: { usdToCny: 1000 } });
	assert.equal(upperBound.cost.usdToCny, 1000);
});

test("old configs without any new block still load", (t) => {
	const agentDir = temporaryDirectory(t, "open-tui-config-legacy-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ enabled: true, footerSegments: { cwd: false } }), "utf8");
	const config = loadConfig();
	assert.equal(config.enabled, true);
	assert.equal(config.footerSegments.cwd, false);
	assert.deepEqual(config.cost, DEFAULT_COST);
});

test("a broken config file falls back to the defaults", (t) => {
	const agentDir = temporaryDirectory(t, "open-tui-config-broken-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(agentDir, "open-tui.json"));
	const messages: string[] = [];
	const config = loadConfig((message) => messages.push(message));
	assert.deepEqual(config.cost, DEFAULT_COST);
	rmSync(join(agentDir, "open-tui.json"), { recursive: true, force: true });
	assert.ok(messages.length > 0);
});

const DEFAULT_THEME = {
	preset: "tokyo-night" as const,
	slots: {},
	dividers: "line" as const,
	gutter: true,
	banding: false,
	userBar: true,
	expandHint: "plain" as const,
	timestamps: "all" as const,
};

test("defaults the theme block when the config has none", (t) => {
	const config = configWith(t, { enabled: true });
	assert.deepEqual(config.theme, DEFAULT_THEME);
	assert.deepEqual(DEFAULT_CONFIG.theme, DEFAULT_THEME);
});

test("keeps a valid theme block", (t) => {
	const config = configWith(t, {
		theme: { preset: "gruvbox-dark", slots: { thinking: "#83a598", cost: "warning" }, dividers: "dashed", gutter: false, banding: true },
	});
	assert.deepEqual(config.theme, {
		preset: "gruvbox-dark",
		slots: { thinking: "#83a598", cost: "warning" },
		dividers: "dashed",
		gutter: false,
		banding: true,
		userBar: true,
		expandHint: "plain",
		timestamps: "all",
	});
});

test("falls back on a non-boolean userBar and thinking peek counts", (t) => {
	const config = configWith(t, { theme: { userBar: "yes" }, thinkingPeek: { lines: 2, showCounts: "no" } });
	assert.equal(config.theme.userBar, DEFAULT_THEME.userBar);
	assert.equal(config.thinkingPeek.showCounts, true);
	assert.equal(config.thinkingPeek.lines, 2, "a bad showCounts must not reset the line count");
});

test("falls back per field on invalid theme values", (t) => {
	const config = configWith(t, { theme: { preset: "solarized", dividers: "wavy", gutter: "yes", banding: 1, expandHint: "sparkle", bubble: "wide", timestamps: "none" } });
	assert.equal(config.theme.preset, "tokyo-night");
	assert.equal(config.theme.dividers, "line");
	assert.equal(config.theme.gutter, DEFAULT_THEME.gutter);
	assert.equal(config.theme.banding, DEFAULT_THEME.banding);
	assert.equal(config.theme.expandHint, DEFAULT_THEME.expandHint);
	assert.ok(!Object.hasOwn(config.theme, "bubble"), "obsolete bubble setting is dropped on load");
	assert.equal(config.theme.timestamps, DEFAULT_THEME.timestamps);

	const nullPreset = configWith(t, { theme: { preset: null, slots: null } });
	assert.equal(nullPreset.theme.preset, "tokyo-night");
	assert.deepEqual(nullPreset.theme.slots, {});

	const broken = configWith(t, { theme: "tokyo-night" });
	assert.deepEqual(broken.theme, DEFAULT_THEME);
});

test("keeps slot overrides, drops unknown slots and non-string values", (t) => {
	const config = configWith(t, {
		theme: { slots: { thinking: "#ff0000", cost: 7, nope: "#00ff00", divider: "" } },
	});
	assert.deepEqual(config.theme.slots, { thinking: "#ff0000" });
});

test("an unknown key inside the theme block survives", (t) => {
	const config = configWith(t, { theme: { preset: "pi", density: "compact" } });
	assert.equal((config.theme as unknown as Record<string, unknown>).density, "compact");
	assert.equal(config.theme.preset, "pi");
});

test("an unknown key inside the cost block survives", (t) => {
	// The settings dialog writes the loaded object back, so a dropped sibling key is deleted on save.
	const config = configWith(t, { cost: { currency: "cny", usdToCny: 7.4, switchable: false, rounding: "ceil" } });
	assert.equal((config.cost as unknown as Record<string, unknown>).rounding, "ceil");
	assert.equal(config.cost.currency, "cny");
	assert.equal(config.cost.usdToCny, 7.4);
	assert.equal(config.cost.switchable, false);
});

test("defaults the context blocks block and clamps the poll interval", (t) => {
	assert.deepEqual(DEFAULT_CONFIG.contextBlocks, { enabled: true, footerSegment: true, pollMs: 1500 });
	assert.equal(DEFAULT_CONFIG.footerSegments.contextBlocks, true);

	const defaults = configWith(t, {});
	assert.deepEqual(defaults.contextBlocks, DEFAULT_CONFIG.contextBlocks);

	const kept = configWith(t, { contextBlocks: { enabled: false, footerSegment: false, pollMs: 500 } });
	assert.deepEqual(kept.contextBlocks, { enabled: false, footerSegment: false, pollMs: 500 });

	// A poll interval that would hammer the disk, or one that is not a number, falls back to the default.
	const clamped = configWith(t, { contextBlocks: { pollMs: 5, enabled: "yes" } });
	assert.equal(clamped.contextBlocks.pollMs, 250);
	assert.equal(clamped.contextBlocks.enabled, true);
	assert.equal(clamped.contextBlocks.footerSegment, true);
});
