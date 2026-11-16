import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { fmtTokens, formatDuration } from "./utils.ts";

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
	/** Live counters while the block streams, frozen ones once it settled; undefined when none ran. */
	stats: () => ThinkingStatsSnapshot | undefined;
	/** `thinkingPeek.showCounts`: off renders the thinking block exactly as Pi does. */
	showCounts: () => boolean;
	/** Theme helper for the appended line; resolved per render so a theme switch repaints. */
	dim: (text: string) => string;
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
 * Pi flips its `isStreaming` accessor exactly once at `message_end` and reuses the same Markdown
 * component (`setText` clears its render cache), so the settled render happens once and re-renders
 * afterwards repeat it. The function stays pure in (markdown, stats, streaming) — same inputs, same
 * bytes — which is what keeps a re-render from stacking a second line.
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
		return appendThinkingStats(markdown, context.isStreaming, source.stats(), source.showCounts(), source.dim);
	};
}
