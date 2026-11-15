import assert from "node:assert/strict";
import test from "node:test";
import type { MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import { installCopyButtons } from "../extensions/open-tui/copy-buttons.ts";
import {
	installMarkdownSkin,
	markSkinScope,
	resetMarkdownSkinSession,
} from "../extensions/open-tui/markdown-skin.ts";
import type { ThemeConfig } from "../extensions/open-tui/theme.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
	style: (text: string) => `<styled>${text}</styled>`,
} as unknown as Theme;

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => `<pi-hr>${text}</pi-hr>`,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

function config(overrides: Partial<ThemeConfig> = {}): ThemeConfig {
	return { preset: "pi", slots: {}, dividers: "line", gutter: false, banding: false, ...overrides };
}

let current: ThemeConfig = config();

const startSkin = () => {
	resetMarkdownSkinSession();
	return installMarkdownSkin({ theme: () => theme, config: () => current });
};

const context = (messageType: MarkdownTransformContext["messageType"] = "user"): MarkdownTransformContext => ({
	messageType,
	isStreaming: false,
	availableWidth: 80,
});

/** Pi keeps these private in its typings; the skin patches them through this same escape hatch. */
interface MarkdownInternals {
	theme: MarkdownTheme;
	renderToken?: (token: Token, width: number, nextTokenType?: string) => string[];
}

const markdownProto = Markdown.prototype as unknown as MarkdownInternals & Record<string, unknown>;

/** A bare Markdown instance: the patch only touches `renderToken`, which reads `this.theme`. */
function markdownInstance(): MarkdownInternals {
	const instance = Object.create(Markdown.prototype) as MarkdownInternals;
	instance.theme = markdownTheme;
	return instance;
}

const rule = (instance: MarkdownInternals, width: number, nextType?: string): string[] =>
	instance.renderToken?.({ type: "hr", raw: "---" } as Token, width, nextType) ?? [];

test("a prototype without renderToken yields undefined instead of throwing", () => {
	const original = markdownProto.renderToken;
	// The capability probe must survive a Pi release that renames the hook.
	markdownProto.renderToken = undefined;
	try {
		assert.equal(installMarkdownSkin({ theme: () => theme, config: () => config() }), undefined);
	} finally {
		markdownProto.renderToken = original;
	}
});

test("install is idempotent and cleanup restores the original prototype method", () => {
	const original = markdownProto.renderToken;
	const cleanup = startSkin();
	assert.ok(cleanup, "the skin installs on a capable prototype");
	assert.notEqual(markdownProto.renderToken, original);
	// A second install on an already patched prototype is a no-op rather than a nested wrapper.
	assert.equal(installMarkdownSkin({ theme: () => theme, config: () => config() }), undefined);
	cleanup();
	assert.equal(markdownProto.renderToken, original);
	// Cleaning up twice must not throw or clobber another extension's wrapper.
	cleanup();
	assert.equal(markdownProto.renderToken, original);
});

test("skin installs before copy-buttons and the reverse cleanup restores both", () => {
	const originalToken = markdownProto.renderToken;
	const originalRender = Markdown.prototype.render;
	const cleanupSkin = startSkin();
	assert.ok(cleanupSkin);
	const copyButtons = installCopyButtons({ getTui: () => undefined, getTheme: () => theme, isEnabled: () => true });
	assert.notEqual(markdownProto.renderToken, originalToken);
	const withBoth = markdownProto.renderToken;
	// Reverse of the install order: copy-buttons restores the skin's wrapper...
	copyButtons.cleanup();
	assert.notEqual(markdownProto.renderToken, originalToken);
	// ...then the skin restores the true original.
	cleanupSkin?.();
	assert.equal(markdownProto.renderToken, originalToken);
	assert.equal(Markdown.prototype.render, originalRender);
	assert.notEqual(originalToken, withBoth);
});

test("the first user message gets no divider and every later one does", () => {
	current = config({ dividers: "line" });
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("first", context()), "first");
		// Re-rendering the first message (resize, theme switch) must stay divider-free.
		assert.equal(markSkinScope("first", context()), "first");
		assert.equal(markSkinScope("second", context()), "---\n\nsecond");
		// Assistant faces are never touched.
		assert.equal(markSkinScope("answer", context("assistant")), "answer");
		assert.equal(markSkinScope("thinking", context("assistant-thinking")), "thinking");
		resetMarkdownSkinSession();
		assert.equal(markSkinScope("after reset", context()), "after reset");
	} finally {
		cleanup?.();
	}
});

test("dividers: none leaves the user face byte-identical", () => {
	current = config({ dividers: "none" });
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("first", context()), "first");
		assert.equal(markSkinScope("second", context()), "second");
	} finally {
		cleanup?.();
	}
});

test("dashed dividers render the slot-coloured dashed rule", () => {
	const cleanup = startSkin();
	try {
		const instance = markdownInstance();
		current = config({ dividers: "dashed" });
		assert.deepEqual(rule(instance, 6), ["<dim>╌╌╌╌╌╌</dim>"]);
		current = config({ dividers: "line" });
		assert.deepEqual(rule(instance, 4), ["<dim>────</dim>"]);
		current = config({ dividers: "none" });
		assert.deepEqual(rule(instance, 4), ["<pi-hr>────</pi-hr>"]);
		// Pi's own spacing rule after a rule is preserved.
		current = config({ dividers: "dashed" });
		assert.deepEqual(rule(instance, 3, "paragraph"), ["<dim>╌╌╌</dim>", ""]);
		// A configured palette colour replaces the fallback token.
		current = config({ dividers: "dashed", slots: { divider: "#3b4261" } });
		assert.deepEqual(rule(instance, 2), ["<styled>╌╌</styled>"]);
	} finally {
		cleanup?.();
		current = config();
	}
});

test("the rule is capped at 80 columns like Pi's own hr", () => {
	const cleanup = startSkin();
	try {
		current = config({ dividers: "dashed" });
		const [row] = rule(markdownInstance(), 200);
		assert.equal(row, `<dim>${"╌".repeat(80)}</dim>`);
	} finally {
		cleanup?.();
		current = config();
	}
});
