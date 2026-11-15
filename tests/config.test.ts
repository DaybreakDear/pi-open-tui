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
	assert.equal(config.cost.switchable, true);

	const negative = configWith(t, { cost: { currency: "cny", usdToCny: -2 } });
	assert.equal(negative.cost.currency, "cny");
	assert.equal(negative.cost.usdToCny, DEFAULT_COST.usdToCny);

	const nonNumeric = configWith(t, { cost: { usdToCny: "7.5" } });
	assert.equal(nonNumeric.cost.usdToCny, DEFAULT_COST.usdToCny);

	const broken = configWith(t, { cost: "cny" });
	assert.deepEqual(broken.cost, DEFAULT_COST);

	const infinite = configWith(t, { cost: { usdToCny: 1e999 } });
	assert.equal(infinite.cost.usdToCny, DEFAULT_COST.usdToCny);
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
