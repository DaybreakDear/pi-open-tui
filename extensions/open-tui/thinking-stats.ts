import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { fmtTokens, formatDuration, lruGet, lruSet } from "./utils.ts";

/** Elapsed time and output tokens of one thinking block. */
export interface ThinkingStatsSnapshot {
	elapsedMs: number;
	tokens: number;
}

/**
 * Pi renders the visible thinking block through a Markdown transformer and hides it behind a plain
 * label when `hideThinkingBlock` is on; the transformer only runs in the visible case, so this module
 * owns exactly one path and the label probe in `editor.ts` keeps the other.
 */
export interface ThinkingStatsSource {
	/**
	 * Counters for one thinking block, looked up by the block's own text: undefined when unknown.
	 * A miss appends nothing — showing another turn's numbers is worse than showing none.
	 */
	lookup: (markdown: string) => ThinkingStatsSnapshot | undefined;
	/** `thinkingPeek.showCounts`: off renders the thinking block exactly as Pi does. */
	showCounts: () => boolean;
	/** Theme helper for the appended line; resolved per render so a theme switch repaints. */
	dim: (text: string) => string;
}

/** How many blocks keep their counters: a long session must not grow this map forever. */
export const THINKING_STATS_CAPACITY = 256;

/**
 * Counters keyed by the thinking text itself, which is the block's identity: the transformer receives
 * that exact string, so a re-render (resize, theme switch, `invalidate()`) still finds its own numbers
 * instead of whatever the current turn happens to be doing.
 */
export interface ThinkingStatsLedger {
	record: (text: string, stats: ThinkingStatsSnapshot) => void;
	lookup: (text: string) => ThinkingStatsSnapshot | undefined;
	clear: () => void;
	size: () => number;
}

export function createThinkingStatsLedger(capacity = THINKING_STATS_CAPACITY): ThinkingStatsLedger {
	const entries = new Map<string, ThinkingStatsSnapshot>();
	return {
		record: (text, stats) => {
			lruSet(entries, text, { elapsedMs: stats.elapsedMs, tokens: stats.tokens }, capacity);
		},
		lookup: (text) => lruGet(entries, text),
		clear: () => entries.clear(),
		size: () => entries.size,
	};
}

/**
 * The thinking runs of one assistant message, each joined exactly as `assistant-message.js` joins
 * them into a single Markdown slot: consecutive `thinking` parts, trimmed, empty ones dropped, joined
 * with `\n\n`. The strings must be byte-equal to the transformer's input or the ledger never hits.
 */
export function thinkingRunsOf(message: unknown): string[] {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const runs: string[] = [];
	let run: string[] = [];
	const close = (): void => {
		if (run.length > 0) runs.push(run.join("\n\n"));
		run = [];
	};
	for (const part of content) {
		const thinking = (part as { type?: unknown; thinking?: unknown } | null | undefined)?.type === "thinking"
			? (part as { thinking?: unknown }).thinking
			: undefined;
		if (typeof thinking !== "string") {
			// Any non-thinking part ends the run; Pi only ever joins adjacent thinking parts.
			close();
			continue;
		}
		const trimmed = thinking.trim();
		if (trimmed) run.push(trimmed);
	}
	close();
	return runs;
}

/** One decimal below a minute, `1m 5s` after that: the same scale the peek header uses. */
function formatStatsElapsed(elapsedMs: number): string {
	const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** `· 12.3s · 1.2k tok`, dimmed through the theme helper rather than a raw escape sequence. */
export function thinkingStatsLine(stats: ThinkingStatsSnapshot, dim: (text: string) => string): string {
	const tokens = Number.isFinite(stats.tokens) ? Math.max(0, Math.round(stats.tokens)) : 0;
	return dim(`· ${formatStatsElapsed(stats.elapsedMs)} · ${fmtTokens(tokens)} tok`);
}

/**
 * Appends the settled stats line under a thinking block.
 *
 * Streaming renders return the input untouched: the numbers only appear once the block stops writing.
 * Idempotence across re-renders comes from Pi, not from here: `Markdown.render` always re-runs the
 * transform on the raw `this.text` and caches rendered blocks by `token.raw`, so a re-render repeats
 * the appended line instead of stacking a second one. The `endsWith` guard below therefore cannot fire
 * through Pi; it stays as defence in depth for a caller that feeds settled text back in.
 */
export function appendThinkingStats(
	markdown: string,
	streaming: boolean,
	stats: ThinkingStatsSnapshot | undefined,
	showCounts: boolean,
	dim: (text: string) => string,
): string {
	if (streaming || !showCounts || !stats) return markdown;
	const line = thinkingStatsLine(stats, dim);
	if (markdown.endsWith(line)) return markdown;
	return `${markdown}\n\n${line}`;
}

/** `assistant-thinking` transformer: the only face it touches, because Pi hides thinking elsewhere. */
export function createThinkingStatsTransformer(source: ThinkingStatsSource): MarkdownTransformer {
	return (markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		return appendThinkingStats(markdown, context.isStreaming, source.lookup(markdown), source.showCounts(), source.dim);
	};
}
