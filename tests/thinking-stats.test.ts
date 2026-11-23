import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import {
	appendThinkingStats,
	createThinkingStatsLedger,
	createThinkingStatsTransformer,
	thinkingRunsOf,
	thinkingStatsLine,
	type ThinkingStatsSnapshot,
} from "../extensions/open-tui/thinking-stats.ts";
import {
	installMarkdownSkin,
	markSkinScope,
	resetMarkdownSkinSession,
	userDividerRowCount,
} from "../extensions/open-tui/markdown-skin.ts";
import type { ThemeConfig } from "../extensions/open-tui/theme.ts";
import { createPainter } from "../extensions/open-tui/theme.ts";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { DEFAULT_COST } from "../extensions/open-tui/currency.ts";
import { formatTurnTelemetry, type TurnTelemetry } from "../extensions/open-tui/telemetry.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
	style: (text: string) => `<styled>${text}</styled>`,
} as unknown as Theme;

/** Tag-free dim: assertions then compare the plain text of the stats line. */
const dim = (text: string): string => text;

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

const thinkingContext = (isStreaming: boolean): MarkdownTransformContext => ({
	messageType: "assistant-thinking",
	isStreaming,
	availableWidth: 80,
});

const stats: ThinkingStatsSnapshot = { elapsedMs: 12_345, tokens: 1_234 };

const BODY = "pondering the shape of the parser";

/** One ledger entry keyed by the block's own text: the identity the transformer looks up. */
function transform(
	options: { stats?: ThinkingStatsSnapshot; showCounts?: boolean; markdown?: string; streaming?: boolean } = {},
): string {
	const markdown = options.markdown ?? BODY;
	const ledger = createThinkingStatsLedger();
	if (options.stats) ledger.record(markdown, options.stats);
	const transformer = createThinkingStatsTransformer({
		lookup: ledger.lookup,
		showCounts: () => options.showCounts ?? true,
		dim,
	});
	return transformer(markdown, thinkingContext(options.streaming ?? false));
}

test("a streaming thinking render carries no counters (the block is still being written)", () => {
	assert.equal(transform({ stats, streaming: true }), "pondering the shape of the parser");
	// Same bytes as the unsettled input, so streaming output stays exactly Pi's own text.
	assert.equal(transform({ stats, streaming: true, markdown: "a\n\nb" }), "a\n\nb");
});

test("a settled thinking render carries exactly one stats line", () => {
	const rendered = transform({ stats });
	assert.equal(rendered, "pondering the shape of the parser\n\n· 12.3s · 1.2k tok");
	// Exactly one line: a second append would be a re-render bug, not a feature.
	assert.equal(rendered.split("\n\n")[1], "· 12.3s · 1.2k tok");
	assert.equal(rendered.match(/tok/g)?.length, 1);
});

test("re-rendering a settled block reproduces the same bytes instead of stacking a line", () => {
	assert.equal(transform({ stats }), transform({ stats }));
	// Pi re-runs the transformer on the raw `this.text` every time, so the settled bytes never come
	// back as an input; the `endsWith` guard only covers a caller that feeds them back by hand.
	const settled = transform({ stats });
	assert.equal(appendThinkingStats(settled, false, stats, true, dim), settled);
});

test("two distinct thinking blocks keep their own numbers across a repaint", () => {
	const ledger = createThinkingStatsLedger();
	ledger.record("first run", { elapsedMs: 1_000, tokens: 100 });
	ledger.record("second run", { elapsedMs: 12_345, tokens: 4_500 });
	const transformer = createThinkingStatsTransformer({ lookup: ledger.lookup, showCounts: () => true, dim });
	const first = transformer("first run", thinkingContext(false));
	const second = transformer("second run", thinkingContext(false));
	assert.equal(first, "first run\n\n· 1.0s · 100 tok");
	assert.equal(second, "second run\n\n· 12.3s · 4.5k tok");
	// A repaint (resize, theme switch, `invalidate()`) re-runs both transforms: neither block may
	// pick up the other's counters, which a single global slot did.
	assert.equal(transformer("first run", thinkingContext(false)), first);
	assert.equal(transformer("second run", thinkingContext(false)), second);
});

test("a stats lookup miss appends nothing instead of painting another turn's numbers", () => {
	const ledger = createThinkingStatsLedger();
	ledger.record("known run", { elapsedMs: 12_345, tokens: 4_500 });
	const transformer = createThinkingStatsTransformer({ lookup: ledger.lookup, showCounts: () => true, dim });
	assert.equal(transformer("unknown run", thinkingContext(false)), "unknown run");
	// The known block is unaffected by the miss.
	assert.equal(transformer("known run", thinkingContext(false)), "known run\n\n· 12.3s · 4.5k tok");
});

test("the ledger is bounded: the oldest block is forgotten first", () => {
	const ledger = createThinkingStatsLedger(2);
	ledger.record("oldest", { elapsedMs: 1, tokens: 1 });
	ledger.record("middle", { elapsedMs: 2, tokens: 2 });
	ledger.record("newest", { elapsedMs: 3, tokens: 3 });
	assert.equal(ledger.size(), 2);
	assert.equal(ledger.lookup("oldest"), undefined);
	assert.deepEqual(ledger.lookup("middle"), { elapsedMs: 2, tokens: 2 });
	assert.deepEqual(ledger.lookup("newest"), { elapsedMs: 3, tokens: 3 });
	ledger.clear();
	assert.equal(ledger.size(), 0);
});

test("a message's thinking runs are keyed exactly as Pi joins them into one Markdown slot", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "  first line\n" },
			{ type: "thinking", thinking: "second line" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "   " },
			{ type: "thinking", thinking: "third run" },
		],
	};
	// `assistant-message.js` trims each part, drops the empty ones, joins a consecutive run with
	// "\n\n", and hands that exact string to the transformer — so it is the block's identity.
	assert.deepEqual(thinkingRunsOf(message), ["first line\n\nsecond line", "third run"]);
	assert.deepEqual(thinkingRunsOf({ role: "assistant", content: [{ type: "text", text: "no thinking" }] }), []);
	assert.deepEqual(thinkingRunsOf({ role: "assistant" }), []);
	assert.deepEqual(thinkingRunsOf(undefined), []);
	assert.deepEqual(thinkingRunsOf({ role: "assistant", content: [null, { type: "thinking", thinking: 7 }] }), []);
});

test("the dim helper receives the whole line", () => {
	const calls: string[] = [];
	const rendered = appendThinkingStats("body", false, stats, true, (text) => {
		calls.push(text);
		return `<dim>${text}</dim>`;
	});
	assert.equal(rendered, "body\n\n<dim>· 12.3s · 1.2k tok</dim>");
	assert.deepEqual(calls, ["· 12.3s · 1.2k tok"]);
	assert.equal(thinkingStatsLine(stats, dim), "· 12.3s · 1.2k tok");
});

test("showCounts: false leaves the thinking markdown byte-identical", () => {
	assert.equal(transform({ stats, showCounts: false }), "pondering the shape of the parser");
	assert.equal(appendThinkingStats("body", false, stats, false, dim), "body");
});

test("no thinking stats (a task without thinking) appends nothing", () => {
	assert.equal(transform({}), "pondering the shape of the parser");
});

test("only the visible thinking face is claimed: a hidden run renders Pi's Text label, never this face", () => {
	// Pi renders hidden thinking as `new Text(hiddenThinkingLabel)` and only the visible branch gets
	// the `assistant-thinking` transform, so this module must stay off every other face instead of
	// inventing a second rendering path. The hidden label keeps flowing through
	// `editor.setLatestHiddenThinkingLabel`; `tests/telemetry.test.ts` ("keeps a bounded peek scoped
	// to the current assistant") asserts that probe end to end.
	for (const messageType of ["user", "assistant"] as const) {
		const transformer = createThinkingStatsTransformer({ lookup: () => stats, showCounts: () => true, dim });
		assert.equal(transformer("answer", { ...thinkingContext(false), messageType }), "answer");
	}
});

test("the stats line follows the peek scale: whole seconds past a minute", () => {
	assert.equal(thinkingStatsLine({ elapsedMs: 65_000, tokens: 1234 }, dim), "· 1m 5s · 1.2k tok");
	assert.equal(thinkingStatsLine({ elapsedMs: 12_345, tokens: 999 }, dim), "· 12.3s · 999 tok");
});

// ---------------------------------------------------------------------------
// V0.6-5b: turn telemetry on the divider
// ---------------------------------------------------------------------------

const markdownProto = Markdown.prototype as unknown as {
	theme: MarkdownTheme;
	renderToken?: (token: Token, width: number, nextType?: string) => string[];
};

const markdownInstance = (): typeof markdownProto => {
	const instance = Object.create(Markdown.prototype) as typeof markdownProto;
	instance.theme = markdownTheme;
	return instance;
};

const rule = (instance: typeof markdownProto, width: number, nextType?: string): string[] =>
	instance.renderToken?.({ type: "hr", raw: "---" } as Token, width, nextType) ?? [];

let current: ThemeConfig = config();
/**
 * The turn summary `agent_settled` leaves for the next divider: the plain numbers, no colour. The
 * label itself is formatted per render, so a theme switch repaints it.
 */
let pending: string | undefined;
/** The theme the skin reads at render time; a theme switch is just a new value here. */
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
/**
 * Duration only: the mock theme's tags count as visible width, so the label stays short enough
 * to be asserted whole instead of clipped.
 */
const TURN_CONFIG = { ...DEFAULT_CONFIG.telemetry, tps: false, ttft: false, tokens: false, stalls: false, cost: false };

let settings = { config: TURN_CONFIG, iconMode: "unicode" as const, cost: DEFAULT_COST };

/** What the marker carries: the numbers, serialised. */
const payloadOf = (telemetry: TurnTelemetry): string => JSON.stringify(telemetry);

const labelFor = (themeUsed: Theme = theme, cfg = TURN_CONFIG): string =>
	formatTurnTelemetry(TURN, themeUsed, cfg, "unicode", DEFAULT_COST, createPainter(themeUsed, current));

const startSkin = () => {
	resetMarkdownSkinSession();
	pending = undefined;
	activeTheme = theme;
	settings = { config: TURN_CONFIG, iconMode: "unicode", cost: DEFAULT_COST };
	return installMarkdownSkin({
		theme: () => activeTheme,
		config: () => current,
		consumeTurnSummary: () => {
			const next = pending;
			pending = undefined;
			return next;
		},
		telemetrySettings: () => settings,
	});
};

const userContext: MarkdownTransformContext = { messageType: "user", isStreaming: false, availableWidth: 80 };

/** Rendering the marker token yields no rows; it only hands its label to the rule that follows. */
const divide = (instance: typeof markdownProto, source: string, width: number): string[] => {
	const marker = /^<!--pi-turn:([\s\S]*?)-->/.exec(source);
	const rows: string[] = [];
	if (marker) assert.deepEqual(instance.renderToken?.({ type: "html", raw: marker[0] } as Token, width), []);
	rows.push(...rule(instance, width));
	return rows;
};

test("T5b.1 the next user divider carries the settled turn metrics", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(120);
		pending = payloadOf(TURN);
		const second = new UserMessageComponent("second");
		const [row] = second.render(120);
		assert.ok(row?.includes(labelFor(theme)), row);
		assert.ok(row?.includes("29.7s"), row);
		assert.equal(userDividerRowCount(second), 1);
		assert.equal(markSkinScope("second", userContext), "second");
	} finally {
		cleanup?.();
	}
});

test("T5b.2 the summary is consumed once: the following message keeps a bare divider", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(120);
		pending = payloadOf(TURN);
		assert.ok(new UserMessageComponent("second").render(120)[0]?.includes("29.7s"));
		assert.equal(pending, undefined);
		assert.ok(!new UserMessageComponent("third").render(120)[0]?.includes("29.7s"));
	} finally {
		cleanup?.();
	}
});

test("T5b.3 with no prior telemetry the divider is just the rule", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(40);
		const second = new UserMessageComponent("second");
		assert.equal(stripTerminalSequences(second.render(40)[0] ?? ""), `<dim>${"━".repeat(40)}</dim>`);
	} finally {
		cleanup?.();
	}
});

test("T5b.4 telemetry off leaves the divider bare (the notify guard is upstream)", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(80);
		// The upstream notify guard left no summary; the boundary cannot fabricate numbers.
		assert.ok(!new UserMessageComponent("second").render(80)[0]?.includes("tps"));
	} finally {
		cleanup?.();
	}
});

test("T5b.5 replaying history without a settle injects no stale numbers", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		// Replaying history without agent_settled keeps the later boundaries bare.
		assert.equal(userDividerRowCount(new UserMessageComponent("old one")), 0);
		new UserMessageComponent("old one").render(80);
		for (const text of ["old two", "old three"]) {
			const message = new UserMessageComponent(text);
			assert.ok(!message.render(80)[0]?.includes("29.7s"));
		}
	} finally {
		cleanup?.();
	}
});

test("a decorated divider survives a re-render at another width", () => {
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(120);
		pending = payloadOf(TURN);
		const second = new UserMessageComponent("second");
		assert.ok(second.render(120)[0]?.includes(labelFor(theme)));
		assert.ok(second.render(160)[0]?.includes(labelFor(theme)));
	} finally {
		cleanup?.();
	}
});

test("a theme switch repaints the label instead of keeping the settle-time colours", () => {
	const warm = {
		fg: (color: string, text: string) => `<warm:${color}>${text}</warm:${color}>`,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
		style: (text: string) => `<styled>${text}</styled>`,
	} as unknown as Theme;
	const cleanup = startSkin();
	try {
		initTheme();
		new UserMessageComponent("first").render(160);
		pending = payloadOf(TURN);
		const second = new UserMessageComponent("second");
		const [cool] = second.render(160);
		activeTheme = warm;
		const [repainted] = second.render(160);
		assert.ok(cool?.includes(labelFor(theme)), cool);
		assert.ok(repainted?.includes(labelFor(warm)), repainted);
		assert.notEqual(cool, repainted);
	} finally {
		cleanup?.();
	}
});

test("a marker payload that does not parse is treated as absent", () => {
	const cleanup = startSkin();
	try {
		const instance = markdownInstance();
		instance.renderToken?.({ type: "html", raw: "<!--pi-turn:{not json-->" } as Token, 60);
		assert.deepEqual(rule(instance, 40), [`<dim>${"━".repeat(40)}</dim>`]);
	} finally {
		cleanup?.();
	}
});

test("a label wider than the rule is clipped, and a rule too narrow drops it", () => {
	const cleanup = startSkin();
	try {
		// The full palette of numbers: long enough that a 20-column rule cannot hold it.
		settings = { config: DEFAULT_CONFIG.telemetry, iconMode: "unicode", cost: DEFAULT_COST };
		initTheme();
		new UserMessageComponent("first").render(120);
		pending = payloadOf(TURN);
		const second = new UserMessageComponent("second");
		const label = labelFor(theme, DEFAULT_CONFIG.telemetry);
		const [narrow] = second.render(20);
		assert.ok(narrow !== undefined);
		assert.ok(!narrow.includes(label), narrow);
		const [tiny] = second.render(6);
		assert.equal(stripTerminalSequences(tiny ?? ""), "<dim>━━━━━━</dim>");
	} finally {
		cleanup?.();
	}
});
