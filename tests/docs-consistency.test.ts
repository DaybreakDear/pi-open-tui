import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import {
	DIVIDER_STYLES,
	EXPAND_HINTS,
	SLOT_NAMES,
	THEME_PRESETS,
} from "../extensions/open-tui/theme.ts";

// The 0.5.0 review found the configuration reference listing a slot that does
// not exist (`thinkingBorder`) while omitting six real ones, and a README that
// said "eight slots" for thirteen. An unknown slot name is dropped silently by
// `normalizeTheme`, so a wrong table is not cosmetic: it is a config that does
// nothing. These tests fail when the docs and the code drift apart.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function read(file: string): string {
	return readFileSync(join(ROOT, file), "utf8");
}

/** Every backticked first cell of a markdown table row, e.g. "| `thinking` | … |". */
function tableFirstCells(markdown: string): string[] {
	const cells: string[] = [];
	for (const line of markdown.split("\n")) {
		const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
		if (match?.[1] !== undefined) cells.push(match[1]);
	}
	return cells;
}

const READMES = ["README.md", "README.zh-CN.md"];

for (const file of READMES) {
	test(`${file} documents every slot and no invented one`, () => {
		const cells = tableFirstCells(read(file));
		for (const slot of SLOT_NAMES) {
			assert.ok(
				cells.includes(slot),
				`${file} has no table row for the slot "${slot}" (SLOT_NAMES in extensions/open-tui/theme.ts)`,
			);
		}
		assert.ok(
			!read(file).includes("thinkingBorder"),
			`${file} mentions "thinkingBorder", which is not in SLOT_NAMES`,
		);
	});

	test(`${file} documents every preset, divider style, and expand-hint mode`, () => {
		const text = read(file);
		for (const value of [...THEME_PRESETS, ...DIVIDER_STYLES, ...EXPAND_HINTS]) {
			assert.ok(text.includes(value), `${file} never mentions "${value}"`);
		}
	});
}

test("no document mentions a slot that does not exist", () => {
	// The configuration reference was the file that carried the invented name.
	for (const file of [...READMES, "docs/configuration.md", "CHANGELOG.md"]) {
		assert.ok(
			!read(file).includes("thinkingBorder"),
			`${file} mentions "thinkingBorder", which is not in SLOT_NAMES and is dropped silently`,
		);
	}
});

test("the README does not claim an outdated slot count", () => {
	const english = read("README.md");
	assert.ok(
		english.includes("thirteen slots"),
		"README.md must state the real slot count; SLOT_NAMES now has " + String(SLOT_NAMES.length),
	);
	assert.match(
		read("README.zh-CN.md"),
		/十三个槽位/,
		"README.zh-CN.md must state the real slot count",
	);
});

test("the configuration reference documents thinkingPeek.showCounts", () => {
	const doc = read("docs/configuration.md");
	assert.ok(
		doc.includes("thinkingPeek.showCounts"),
		"docs/configuration.md documents thinkingPeek.lines but not showCounts",
	);
});

test("the configuration reference documents every theme option", () => {
	const doc = read("docs/configuration.md");
	for (const key of Object.keys(DEFAULT_CONFIG.theme)) {
		if (key === "slots") continue; // covered by the README slot table
		assert.ok(doc.includes(`theme.${key}`), `docs/configuration.md has no row for theme.${key}`);
	}
	for (const key of Object.keys(DEFAULT_CONFIG.contextBlocks)) {
		assert.ok(doc.includes(`contextBlocks.${key}`), `docs/configuration.md has no row for contextBlocks.${key}`);
	}
});

test("the changelog does not promise a markdown skin", () => {
	// markdown-skin.ts only special-cases the `hr` token; headings, fences, and
	// emphasis are delegated untouched. Claiming otherwise was a review finding.
	const changelog = read("CHANGELOG.md");
	const added = changelog.slice(changelog.indexOf("## [0.5.0]"), changelog.indexOf("## [0.4.6]"));
	assert.ok(
		!/markdown skin/i.test(added),
		"the 0.5.0 section advertises a markdown skin that recolours headings and fences; markdown-skin.ts only handles `hr`",
	);
});
