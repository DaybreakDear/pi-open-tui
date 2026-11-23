import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import { installCopyButtons } from "../extensions/open-tui/copy-buttons.ts";
import { installMarkdownSkin, markSkinScope, resetMarkdownSkinSession, userDividerRowCount } from "../extensions/open-tui/markdown-skin.ts";
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
const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const markdownTheme: MarkdownTheme = {
	heading: (text) => text, link: (text) => text, linkUrl: (text) => text,
	code: (text) => text, codeBlock: (text) => text, codeBlockBorder: (text) => text,
	quote: (text) => text, quoteBorder: (text) => text, hr: (text) => `<pi-hr>${text}</pi-hr>`,
	listBullet: (text) => text, bold: (text) => text, italic: (text) => text,
	strikethrough: (text) => text, underline: (text) => text,
};
const telemetry: TurnTelemetry = {
	tps: 42.5, ttftMs: 1_200, totalMs: 29_700, inputTokens: 567, outputTokens: 1_200,
	cacheReadTokens: 0, stallMs: 0, stallCount: 0, rateUsdPerMTokens: null,
	generationMs: 28_000, totalTokens: 1_767, costUsd: 0.01, measurementMs: 28_000,
};
const telemetryConfig = { ...DEFAULT_CONFIG.telemetry, tps: false, ttft: false, tokens: false, stalls: false, cost: false };
function config(overrides: Partial<ThemeConfig> = {}): ThemeConfig {
	return { preset: "pi", slots: {}, dividers: "line", gutter: false, banding: false, userBar: true, ...overrides };
}
let current = config();
let activeTheme: Theme = theme;
let pending: string | undefined;
const user = (text: string) => new UserMessageComponent(text);
const label = (selected: Theme = activeTheme) => formatTurnTelemetry(telemetry, selected, telemetryConfig,
	"unicode", DEFAULT_COST, createPainter(selected, current));
const startSkin = () => {
	resetMarkdownSkinSession();
	pending = undefined;
	activeTheme = theme;
	return installMarkdownSkin({ theme: () => activeTheme, config: () => current,
		consumeTurnSummary: () => { const value = pending; pending = undefined; return value; },
		telemetrySettings: () => ({ config: telemetryConfig, iconMode: "unicode", cost: DEFAULT_COST }),
	});
};

interface MarkdownInternals {
	theme: MarkdownTheme;
	renderToken?: (token: Token, width: number, nextTokenType?: string) => string[];
}
const markdownProto = Markdown.prototype as unknown as MarkdownInternals;
function markdownInstance(): MarkdownInternals {
	const instance = Object.create(Markdown.prototype) as MarkdownInternals;
	instance.theme = markdownTheme;
	return instance;
}
const rule = (instance: MarkdownInternals, width: number, next?: string) =>
	instance.renderToken?.({ type: "hr", raw: "---" } as Token, width, next) ?? [];

test("a prototype without renderToken is safely left unpatched", () => {
	const original = markdownProto.renderToken;
	markdownProto.renderToken = undefined;
	try {
		assert.equal(installMarkdownSkin({ theme: () => theme, config: () => current,
			telemetrySettings: () => ({ config: telemetryConfig, iconMode: "unicode", cost: DEFAULT_COST }) }), undefined);
	} finally { markdownProto.renderToken = original; }
});

test("skin installs once and cleans up without clobbering copy buttons", () => {
	const original = markdownProto.renderToken;
	const cleanup = startSkin();
	assert.ok(cleanup);
	assert.notEqual(markdownProto.renderToken, original);
	assert.equal(startSkin(), undefined);
	const copy = installCopyButtons({ getTui: () => undefined, getTheme: () => theme, isEnabled: () => true });
	copy.cleanup();
	cleanup?.();
	cleanup?.();
	assert.equal(markdownProto.renderToken, original);
});

test("message boundaries sit outside markdown, the rail, the background and the copy payload", () => {
	initTheme();
	current = config();
	const cleanup = startSkin();
	try {
		const first = user("first");
		assert.equal(userDividerRowCount(first), 0);
		first.render(120);
		assert.equal(userDividerRowCount(first), 0);
		pending = JSON.stringify(telemetry);
		const second = user("before\n\n---\n\nafter");
		const rows = second.render(120);
		assert.ok(rows[0]?.includes(label()), rows[0]);
		assert.ok(!rows[0]?.includes("▌") && !rows[0]?.includes("<bg:userMessageBg>"), rows[0]);
		assert.ok(!rows[0]?.includes("\x1b]133;A\x07"), "divider is outside the terminal copy zone");
		assert.ok(rows[1]?.includes("\x1b]133;A\x07"), "message remains inside the terminal copy zone");
		assert.equal(rows.filter((row) => row.includes(label())).length, 1);
		assert.equal(userDividerRowCount(second), 1);
		const layout = (second as unknown as { mouseLayout?: { children: { height: number }[] } }).mouseLayout;
		assert.equal(layout?.children.reduce((sum, child) => sum + child.height, 0), rows.length);
		assert.equal((second as unknown as { text: string }).text, "before\n\n---\n\nafter");
		assert.equal(markSkinScope("---\n\nbody", { messageType: "user", isStreaming: false, availableWidth: 120 }), "---\n\nbody");
	} finally { cleanup?.(); current = config(); }
});

test("the final answer has its own divider after thinking, outside Markdown and mouse hit regions", () => {
	initTheme();
	current = config();
	const cleanup = startSkin();
	try {
		const answer = new AssistantMessageComponent({ role: "assistant", content: [
			{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "final answer" },
		], stopReason: "stop", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		const rows = answer.render(80);
		const thinking = rows.findIndex((row) => row.includes("reasoning"));
		const boundary = rows.findIndex((row) => row.includes("━"));
		const final = rows.findIndex((row) => row.includes("final answer"));
		assert.ok(thinking >= 0 && thinking < boundary && boundary < final, rows.join("\n"));
		assert.equal(rows.filter((row) => row.includes("━")).length, 1);
		assert.deepEqual(answer.render(80), rows);
		const internal = answer as unknown as { contentContainer: { mouseLayout?: { children: { height: number }[] } } };
		assert.equal(internal.contentContainer.mouseLayout?.children.reduce((sum, child) => sum + child.height, 0), rows.length);
		current = config({ dividers: "none" });
		assert.ok(!answer.render(80).some((row) => row.includes("━")));
	} finally { cleanup?.(); current = config(); }
});

test("interleaved thinking and text place the divider before the final answer", () => {
	initTheme();
	current = config();
	const cleanup = startSkin();
	try {
		const answer = new AssistantMessageComponent({ role: "assistant", content: [
			{ type: "text", text: "draft before reasoning" },
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "final answer" },
		], stopReason: "stop", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		const rows = answer.render(80);
		const draft = rows.findIndex((row) => row.includes("draft before reasoning"));
		const thinking = rows.findIndex((row) => row.includes("reasoning") && !row.includes("draft before reasoning"));
		const boundary = rows.findIndex((row) => row.includes("━"));
		const final = rows.findIndex((row) => row.includes("final answer"));
		assert.ok(draft < thinking && thinking < boundary && boundary < final, rows.join("\n"));
	} finally { cleanup?.(); current = config(); }
});

test("tool-use and streaming messages do not show the final-answer divider", () => {
	initTheme();
	current = config();
	const cleanup = startSkin();
	try {
		const toolUse = new AssistantMessageComponent({ role: "assistant", content: [
			{ type: "text", text: "running" }, { type: "toolCall", id: "call1", name: "bash", arguments: {} },
		], stopReason: "toolUse", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		assert.ok(!toolUse.render(80).some((row) => row.includes("━")));
		const streaming = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "partial" }],
			stopReason: "pending", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		assert.ok(!streaming.render(80).some((row) => row.includes("━")));
	} finally { cleanup?.(); current = config(); }
});

test("cleanup and reinstall do not revive stale divider children", () => {
	initTheme();
	current = config();
	const firstInstall = startSkin();
	user("first").render(80);
	const message = user("second");
	assert.equal(message.render(80).filter((row) => row.includes("━")).length, 1);
	const assistant = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "answer" }],
		stopReason: "stop", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
	assert.equal(assistant.render(80).filter((row) => row.includes("━")).length, 1);
	firstInstall?.();
	const nextInstall = startSkin();
	try {
		user("new first").render(80);
		assert.equal(message.render(80).filter((row) => row.includes("━")).length, 1);
		assert.equal(assistant.render(80).filter((row) => row.includes("━")).length, 1);
	} finally { nextInstall?.(); }
});

test("same prompt text has separate per-instance metrics, and re-renders retain the correct label", () => {
	initTheme();
	const cleanup = startSkin();
	try {
		user("hello").render(120);
		pending = JSON.stringify(telemetry);
		const second = user("hello");
		assert.ok(second.render(120)[0]?.includes(label()));
		const changed = { ...telemetry, totalMs: 12_300 };
		pending = JSON.stringify(changed);
		const third = user("hello");
		assert.ok(third.render(120)[0]?.includes("12.3s"));
		assert.ok(second.render(100)[0]?.includes("29.7s"));
		assert.equal(pending, undefined);
		assert.ok(!user("other").render(100)[0]?.includes("12.3s"));
	} finally { cleanup?.(); }
});

test("a session reset exempts its new first user and discards old labels", () => {
	initTheme();
	const cleanup = startSkin();
	try {
		user("first").render(80);
		pending = JSON.stringify(telemetry);
		user("second").render(80);
		resetMarkdownSkinSession();
		const next = user("new session");
		next.render(80);
		assert.equal(userDividerRowCount(next), 0);
		assert.equal(pending, undefined);
		assert.equal(userDividerRowCount(user("next")), 0);
	} finally { cleanup?.(); }
});

test("divider choices control the boundary, not authored Markdown", () => {
	initTheme();
	const cleanup = startSkin();
	try {
		user("first").render(80);
		current = config({ dividers: "dashed" });
		assert.ok(user("second").render(80)[0]?.includes("╍╍╍"));
		current = config({ dividers: "none" });
		const bare = user("third");
		bare.render(80);
		assert.equal(userDividerRowCount(bare), 0);
		assert.deepEqual(rule(markdownInstance(), 4), ["<pi-hr>────</pi-hr>"]);
		current = config({ dividers: "line" });
		assert.deepEqual(rule(markdownInstance(), 4), ["<dim>━━━━</dim>"]);
		assert.deepEqual(rule(markdownInstance(), 3, "paragraph"), ["<dim>━━━</dim>", ""]);
	} finally { cleanup?.(); current = config(); }
});

test("solid and dashed dividers use heavy glyphs across the current message width", () => {
	initTheme();
	current = config();
	const cleanup = startSkin();
	try {
		user("first").render(120);
		const second = user("second");
		const answer = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "answer" }],
			stopReason: "stop", timestamp: Date.now() } as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		for (const width of [6, 120, 173, 37]) {
			assert.equal(second.render(width)[0], `<dim>${"━".repeat(width)}</dim>`);
			assert.ok(answer.render(width).includes(`<dim>${"━".repeat(width)}</dim>`));
			assert.deepEqual(rule(markdownInstance(), width), [`<dim>${"━".repeat(width)}</dim>`]);
		}
		current = config({ dividers: "dashed" });
		assert.equal(second.render(131)[0], `<dim>${"╍".repeat(131)}</dim>`);
		assert.ok(answer.render(131).includes(`<dim>${"╍".repeat(131)}</dim>`));
		assert.deepEqual(rule(markdownInstance(), 131), [`<dim>${"╍".repeat(131)}</dim>`]);
	} finally { cleanup?.(); current = config(); }
});

test("a labelled divider fills the available width after resizing", () => {
	initTheme();
	current = config();
	const cleanup = installMarkdownSkin({ theme: () => plainTheme, config: () => current,
		consumeTurnSummary: () => { const value = pending; pending = undefined; return value; },
		telemetrySettings: () => ({ config: telemetryConfig, iconMode: "unicode", cost: DEFAULT_COST }),
	});
	try {
		user("first").render(80);
		pending = JSON.stringify(telemetry);
		const second = user("second");
		for (const width of [80, 173, 35]) {
			const row = second.render(width)[0] ?? "";
			assert.equal(visibleWidth(row), width, `labelled divider at ${width} columns`);
			assert.ok(row.includes("━"), row);
		}
	} finally { cleanup?.(); pending = undefined; current = config(); }
});

test("a theme switch repaints a labelled boundary at the next render", () => {
	initTheme();
	const cleanup = startSkin();
	try {
		user("first").render(120);
		pending = JSON.stringify(telemetry);
		const second = user("second");
		assert.ok(second.render(120)[0]?.includes(label()));
		activeTheme = { ...theme, fg: (color: string, text: string) => `<warm:${color}>${text}</warm:${color}>` } as Theme;
		assert.ok(second.render(120)[0]?.includes(label()));
	} finally { cleanup?.(); }
});

test("narrow terminals and the rail do not widen the message beyond the budget", () => {
	initTheme();
	current = config({ dividers: "none" });
	const cleanup = installMarkdownSkin({ theme: () => plainTheme, config: () => current,
		telemetrySettings: () => ({ config: telemetryConfig, iconMode: "unicode", cost: DEFAULT_COST }) });
	try {
		for (const width of [40, 21, 12, 5]) {
			const component = user("hello");
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
			assert.equal((component as unknown as { text: string }).text, "hello");
		}
		for (const width of [4, 3, 2]) {
			current = config({ userBar: false, dividers: "none" });
			const baseline = user("tiny").render(width);
			current = config({ dividers: "none" });
			assert.deepEqual(user("tiny").render(width), baseline);
		}
	} finally { cleanup?.(); current = config(); }
});
