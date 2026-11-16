import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import { installCopyButtons } from "../extensions/open-tui/copy-buttons.ts";
import {
	installMarkdownSkin,
	markSkinScope,
	resetMarkdownSkinSession,
} from "../extensions/open-tui/markdown-skin.ts";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { DEFAULT_COST } from "../extensions/open-tui/currency.ts";
import { formatTurnTelemetry, type TurnTelemetry } from "../extensions/open-tui/telemetry.ts";
import { createPainter, type ThemeConfig } from "../extensions/open-tui/theme.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
	style: (text: string) => `<styled>${text}</styled>`,
} as unknown as Theme;

/** Tag-free painter: `visibleWidth` then measures terminal columns instead of the mock's markers. */
const plainTheme = {
	fg: (_color: string, text: string) => text,
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
	return { preset: "pi", slots: {}, dividers: "line", gutter: false, banding: false, userBar: true, ...overrides };
}

let current: ThemeConfig = config();
/** The turn summary `agent_settled` would leave for the next divider: numbers only, never colour. */
let pending: string | undefined;
/** The theme the skin reads at render time; a "theme switch" is just a new value here. */
let activeTheme: Theme = theme;

const TURN: TurnTelemetry = {
	tps: 42.5,
	ttftMs: 1_200,
	totalMs: 29_700,
	inputTokens: 567,
	outputTokens: 1_200,
	cacheReadTokens: 0,
	stallMs: 0,
	stallCount: 0,
	rateUsdPerMTokens: null,
	generationMs: 28_000,
	totalTokens: 1_767,
	costUsd: 0.01,
	measurementMs: 28_000,
};
/** Short label: duration and tokens only, so the rule has room at 60 columns. */
const TURN_CONFIG = { ...DEFAULT_CONFIG.telemetry, tps: false, ttft: false, stalls: false, cost: false };

/** What the marker carries: the numbers, serialised — the label is formatted at render time. */
const payloadOf = (telemetry: TurnTelemetry): string => JSON.stringify(telemetry);

const labelFor = (themeUsed: Theme = theme): string =>
	formatTurnTelemetry(TURN, themeUsed, TURN_CONFIG, "unicode", DEFAULT_COST, createPainter(themeUsed, current));

const startSkin = () => {
	resetMarkdownSkinSession();
	pending = undefined;
	activeTheme = theme;
	return installMarkdownSkin({
		theme: () => activeTheme,
		config: () => current,
		consumeTurnSummary: () => {
			const next = pending;
			pending = undefined;
			return next;
		},
		telemetrySettings: () => ({ config: TURN_CONFIG, iconMode: "unicode", cost: DEFAULT_COST }),
	});
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

test("a repeated prompt shows the current numbers instead of the cached ones", () => {
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("first", context()), "first");
		pending = "first label";
		assert.ok(markSkinScope("second", context()).includes("first label"));
		// The same prompt again, now with a fresh summary: the cache hit must be overwritten, because
		// the numbers on screen have to describe the turn that just finished.
		pending = "second label";
		const repeat = markSkinScope("second", context());
		assert.ok(repeat.includes("second label"), repeat);
		assert.ok(!repeat.includes("first label"), repeat);
	} finally {
		cleanup?.();
	}
});

test("a label cache hit still consumes the summary instead of dropping it", () => {
	const cleanup = startSkin();
	try {
		markSkinScope("first", context());
		pending = "label one";
		markSkinScope("second", context());
		pending = "label two";
		assert.ok(markSkinScope("second", context()).includes("label two"));
		// Never leave a pending summary behind: the next unrelated message must stay bare.
		assert.equal(pending, undefined);
		assert.equal(markSkinScope("third", context()), "---\n\nthird");
	} finally {
		cleanup?.();
	}
});

test("a repeated first prompt is a normal message: divider plus its own metrics", () => {
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("hello", context()), "hello");
		// Re-rendering the exemption with no summary at all keeps it divider-free (resize).
		assert.equal(markSkinScope("hello", context()), "hello");
		// A new prompt with the same text is a message like any other: it gets the divider and the
		// summary, instead of silently swallowing both.
		pending = "turn label";
		const repeat = markSkinScope("hello", context());
		assert.ok(repeat.includes("turn label"), repeat);
		assert.ok(repeat.endsWith("---\n\nhello"), repeat);
		assert.equal(pending, undefined);
		assert.equal(markSkinScope("unrelated", context()), "---\n\nunrelated");
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

/** The rail reads the `userBar` slot; with `preset: "pi"` it falls back to the `accent` token. */
const RAIL = "<accent>▌</accent> ";

const userMessage = (text = "hello\n\n```js\nx()\n```") => new UserMessageComponent(text);

test("the user rail prefixes every rendered row and never reaches the copy payload", () => {
	initTheme();
	current = config({ userBar: true });
	const cleanup = startSkin();
	try {
		const component = userMessage();
		const lines = component.render(40);
		assert.ok(lines.length >= 2);
		// Every row, including the OSC 133 zone-marker rows: the rail sits outside them.
		for (const line of lines) assert.ok(line.startsWith(RAIL), line);
		// The copy payload is the untouched source markdown, so `[Copy]` sends the message, not the rail.
		const text = (component as unknown as { text: string }).text;
		assert.equal(text, "hello\n\n```js\nx()\n```");
		assert.ok(!text.includes("▌"));
	} finally {
		cleanup?.();
		current = config();
	}
});

test("userBar: false keeps the v0.4.6 bubble byte for byte", () => {
	initTheme();
	const baseline = userMessage().render(40);
	current = config({ userBar: false });
	const cleanup = startSkin();
	try {
		assert.deepEqual(userMessage().render(40), baseline);
		assert.ok(new UserMessageComponent("hello").render(40).every((line) => !line.includes("▌")));
	} finally {
		cleanup?.();
		current = config();
	}
});

test("the rail comes out of the width budget instead of widening the row", () => {
	initTheme();
	current = config({ userBar: true });
	const cleanup = installMarkdownSkin({ theme: () => plainTheme, config: () => current });
	try {
		// Pi pads the bubble to the width it is handed: a padded row still lands exactly on the budget
		// (38 rendered columns plus the two rail columns) instead of overflowing by two.
		for (const line of userMessage().render(40)) assert.equal(visibleWidth(line), 40);
		// Narrow terminals still fit, down to where the rail itself is dropped for lack of columns.
		for (const width of [21, 12, 5]) {
			for (const line of userMessage().render(width)) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
			}
		}
		// Below five columns Pi's own rows overflow the budget, so the rail is dropped instead of adding
		// two more columns to them: the plain render is kept byte for byte.
		current = config({ userBar: false });
		for (const width of [4, 3, 2]) {
			const plain = userMessage().render(width);
			assert.ok(plain.every((line) => !line.includes("▌")));
			current = config({ userBar: true });
			assert.deepEqual(userMessage().render(width), plain);
			current = config({ userBar: false });
		}
	} finally {
		cleanup?.();
		current = config();
	}
});

test("a marker never hands its label to another Markdown instance", () => {
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("first", context()), "first");
		pending = payloadOf(TURN);
		const source = markSkinScope("second", context());
		const marker = /^<!--pi-turn:[\s\S]*?-->/.exec(source)?.[0] ?? "";
		assert.ok(marker.startsWith("<!--pi-turn:"), source);
		const owner = markdownInstance();
		const stranger = markdownInstance();
		// The owner never renders the rule, so its label must not be left waiting in a module slot:
		// an unrelated Markdown on its own `---` has to stay plain.
		assert.deepEqual(owner.renderToken?.({ type: "html", raw: marker } as Token, 60), []);
		assert.deepEqual(rule(stranger, 20), ["<dim>────────────────────</dim>"]);
		// The owner still gets its own numbers when its own rule follows.
		assert.ok(rule(owner, 60)[0]?.includes(labelFor(theme)));
	} finally {
		cleanup?.();
	}
});

test("with dividers off a marker that looks like ours is left to Pi", () => {
	const cleanup = startSkin();
	try {
		current = config({ dividers: "none" });
		const instance = markdownInstance();
		const raw = `<!--pi-turn:${payloadOf(TURN)}-->`;
		// Off-path byte identity: with dividers off we do not own the channel, so Pi renders the html.
		assert.deepEqual(instance.renderToken?.({ type: "html", raw } as Token, 60), [raw]);
		// ... and swallowing it must not leave a label behind for the next rule either.
		current = config({ dividers: "line" });
		assert.deepEqual(rule(instance, 20), ["<dim>────────────────────</dim>"]);
	} finally {
		cleanup?.();
		current = config();
	}
});

test("a marker payload with an embedded newline still renders one padded row", () => {
	const cleanup = startSkin();
	try {
		const instance = markdownInstance();
		// The marker is unvalidated text: a newline in it would break the rule into two unpadded rows.
		const payload = payloadOf(TURN).replace("{", "{\r\n");
		instance.renderToken?.({ type: "html", raw: `<!--pi-turn:${payload}-->` } as Token, 60);
		const rows = rule(instance, 60);
		assert.equal(rows.length, 1);
		assert.ok(!rows[0]?.includes("\n"), rows[0]);
		assert.ok(rows[0]?.includes(labelFor(theme)), rows[0]);
	} finally {
		cleanup?.();
	}
});

test("the label cache is bounded so replayed history cannot grow it without end", () => {
	const cleanup = startSkin();
	try {
		markSkinScope("first", context());
		// More distinct messages than the 256-entry cap: each carries a full payload.
		for (let index = 0; index < 600; index++) {
			pending = payloadOf(TURN);
			markSkinScope(`message ${index}`, context());
		}
		// The oldest label aged out, so that message renders bare instead of showing a stale one.
		assert.equal(markSkinScope("message 0", context()), "---\n\nmessage 0");
		// The newest one is still cached: a repaint keeps its own numbers.
		assert.ok(markSkinScope("message 599", context()).startsWith("<!--pi-turn:"));
	} finally {
		cleanup?.();
	}
});

test("a user message with its own --- shows the label twice (known limitation)", () => {
	initTheme();
	const cleanup = startSkin();
	try {
		assert.equal(markSkinScope("first", context()), "first");
		pending = payloadOf(TURN);
		const source = markSkinScope("before\n\n---\n\nafter", context());
		// Pi's block cache is keyed on `token.raw`, so the `---` we prepend and the user's own `---`
		// share one decorated block and both rows get the label. Not fixable from a transformer.
		const rows = new Markdown(source, 0, 0, markdownTheme).render(120);
		assert.equal(rows.filter((line) => line.includes(labelFor(theme))).length, 2);
	} finally {
		cleanup?.();
	}
});
