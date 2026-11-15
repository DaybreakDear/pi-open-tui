import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/open-tui/config.ts";
import { HINT_KEY, HINT_TAIL, HINT_TEXT, formatExpandHint } from "../extensions/open-tui/hint.ts";
import type { ExpandHint } from "../extensions/open-tui/theme.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

// A hinted row's head, and the exact span v0.4.6 painted around `head + hint`: one `dim` run.
const HEAD = "├  … 5 earlier calls";
const paintDim = (text: string) => piTheme.fg("dim", text);

test("plain mode reproduces the v0.4.6 single dim span", () => {
	initTheme("dark");
	const v046 = piTheme.fg("dim", `${HEAD} ${HINT_TEXT}`);
	assert.equal(HINT_TEXT, "(ctrl+o to expand)");
	assert.equal(formatExpandHint(piTheme, "plain", HEAD, paintDim), v046);
	assert.equal(formatExpandHint(piTheme, undefined, HEAD, paintDim), v046, "an absent key behaves like plain");
	assert.equal(formatExpandHint(piTheme, "sparkle" as ExpandHint, HEAD, paintDim), v046, "an unvalidated mode behaves like plain");
});

test("key mode underlines only the keycap and keeps the body dim", () => {
	initTheme("dark");
	const keycap = piTheme.style(HINT_KEY, { fg: "muted", underline: true });
	assert.match(keycap, /\x1b\[4m/, "the keycap span is underlined");
	const out = formatExpandHint(piTheme, "key", HEAD, paintDim);
	assert.ok(out.includes(keycap), "the keycap carries the emphasis");
	assert.doesNotMatch(out.replace(keycap, ""), /\x1b\[4m/, "nothing else is underlined");
	assert.equal(stripAnsi(out), `${HEAD} ${HINT_TEXT}`, "the text itself is untouched");
	assert.ok(out.startsWith(piTheme.fg("dim", HEAD)), "the head keeps the row's span");
	assert.ok(out.endsWith(piTheme.fg("dim", ` ${HINT_TAIL})`)), "the tail stays dim");
});

test("emphasis never changes the visible width, truncated or not", () => {
	initTheme("dark");
	const plain = formatExpandHint(piTheme, "plain", HEAD, paintDim);
	const key = formatExpandHint(piTheme, "key", HEAD, paintDim);
	assert.equal(visibleWidth(key), visibleWidth(`${HEAD} ${HINT_TEXT}`));
	assert.equal(visibleWidth(key), visibleWidth(plain));
	for (const width of [1, 5, 12, 20, 60]) {
		const truncatedPlain = formatExpandHint(piTheme, "plain", HEAD, paintDim, width);
		const truncatedKey = formatExpandHint(piTheme, "key", HEAD, paintDim, width);
		assert.ok(visibleWidth(truncatedPlain) <= width, `plain ${width}`);
		assert.ok(visibleWidth(truncatedKey) <= width, `key ${width}`);
		assert.equal(visibleWidth(truncatedKey), visibleWidth(truncatedPlain), `width ${width} is unchanged`);
	}
});

test("config keeps a valid expandHint and falls back to plain", (t) => {
	const agentDir = temporaryDirectory(t, "open-tui-hint-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configWith = (raw: unknown) => {
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify(raw), "utf8");
		return loadConfig();
	};
	assert.equal(DEFAULT_CONFIG.theme.expandHint, "plain", "the shipped default is the v0.4.6 rendering");
	assert.equal(configWith({ theme: { expandHint: "key" } }).theme.expandHint, "key");
	assert.equal(configWith({ theme: { expandHint: "sparkle" } }).theme.expandHint, "plain");
	assert.equal(configWith({ theme: { expandHint: 7 } }).theme.expandHint, "plain");
	assert.equal(configWith({ theme: {} }).theme.expandHint, "plain");
});
