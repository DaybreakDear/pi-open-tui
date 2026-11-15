import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";
import { fmtTokens, formatDuration, sanitizeStatus } from "./utils.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 2;
/**
 * Thought columns the header must leave before the counts keep their space: below this the
 * header degrades instead of silently erasing the thinking text the peek exists to show.
 */
const MIN_THOUGHT_COLS = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
}

/** Elapsed time and token count for the thinking header. */
export interface PeekCounts {
	elapsedMs: number;
	tokens: number;
	showCounts: boolean;
}

export interface PeekMessageParts {
	thinking: string;
	text: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const normalizePeekLineCount = (lineCount: number): number => Math.max(1, Math.min(MAX_PEEK_LINES, Math.floor(lineCount)));

/** One decimal below a minute so a thinking block visibly progresses; `1m 5s` after that. */
function formatPeekElapsed(elapsedMs: number): string {
	const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** The degraded narrow header keeps whole seconds only, e.g. `12s`. */
function formatCompactElapsed(elapsedMs: number): string {
	const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
	return `${Math.floor(ms / 1000)}s`;
}

/** `12.3s · 1.2k tok`, or "" when counts are off (the v0.4.6 label). */
function formatPeekCounts(counts: PeekCounts | undefined): string {
	if (!counts?.showCounts) return "";
	const tokens = Number.isFinite(counts.tokens) ? Math.max(0, Math.round(counts.tokens)) : 0;
	return `${formatPeekElapsed(counts.elapsedMs)} · ${fmtTokens(tokens)} tok`;
}

/**
 * Pure phase machine for one assistant-message update.
 *
 * Thinking text is cumulative: once the answer starts, later updates still
 * carry the full thinking block alongside new text. To keep the spinner honest:
 * - idle + thinking        -> thinking (spinner starts)
 * - idle + thinking + text -> done    (already answered, never spin)
 * - thinking + text        -> done    (answer started: stop spinner)
 * - done + thinking        -> done    (never restart the spinner)
 * - any + text only        -> idle stays idle (plain answer, nothing to peek)
 */
export function reducePeek(prev: PeekState, parts: PeekMessageParts): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, MAX_PEEK_LINES) : prev.tail;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	return { phase, tail };
}

/** Fresh peek state (no task running yet). */
export function createPeekState(): PeekState {
	return { phase: "idle", tail: "" };
}

/**
 * Collect the running thinking text and answer text from an assistant
 * message's content parts. Thinking arrives token-by-token, so re-calling
 * this on every `message_update` yields the cumulative text.
 */
export function collectPeekParts(content: unknown): PeekMessageParts {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as { type?: unknown; thinking?: unknown; text?: unknown };
		if (part.type === "thinking") {
			thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? "";
		} else if (part.type === "text") {
			text += stringValue(part.text) ?? "";
		}
	}
	return { thinking, text };
}

/**
 * Extract the last non-empty logical lines of the thinking text, whitespace-
 * normalized. NOT width-bounded: clipping to the terminal happens at render
 * time in buildPeekLabel/clipTail, so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const lines: string[] = [];
	let end = fullThinking.length;
	while (end > 0 && lines.length < count) {
		const start = fullThinking.lastIndexOf("\n", end - 1) + 1;
		const line = fullThinking.slice(start, end).replace(/\s+/g, " ").trim();
		if (line) lines.push(line);
		end = start - 1;
	}
	return lines.reverse().join("\n");
}

/**
 * Clip a tail string to `budget` visible columns, keeping the END (it is a
 * tail view) and prefixing "…" when clipped. Walk backwards over complete
 * graphemes so measurement is limited to the visible suffix.
 */
export function clipTail(text: string, budget: number): string {
	if (!text || budget <= 0) return "";
	const limit = budget - 1; // reserve one column for the ellipsis
	let w = 0;
	let end = text.length;
	let clippedStart = end;
	const segments = graphemeSegmenter.segment(text);
	while (end > 0) {
		const part = segments.containing(end - 1)!;
		w += visibleWidth(part.segment);
		if (w > budget) return "…" + text.slice(clippedStart);
		end = part.index;
		if (w <= limit) clippedStart = end;
	}
	return text;
}

/**
 * Build the label Pi renders in its hidden-thinking block. `width` is a
 * conservative budget that keeps each native Text row within the terminal.
 * In two-line mode, an overflowing latest logical line uses both rows for
 * its continuation instead of retaining the previous logical line.
 */
export function buildPeekLabel(
	state: PeekState,
	frame: number,
	glyphs: IconGlyphs,
	width: number,
	lineCount = 1,
	counts?: PeekCounts,
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = `${glyphs.thinking} think`;
	const count = normalizePeekLineCount(lineCount);
	const fit = (line: string): string => truncateToWidth(line, w, "…");
	switch (state.phase) {
		case "thinking": {
			const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
			// Thinking text is model output (untrusted): strip terminal control
			// sequences before placing it in Pi's native label.
			const stats = formatPeekCounts(counts);
			let marker = `${prefix} ${spin}`;
			let statsSuffix = stats ? ` ${stats}` : "";
			// Two-stage degradation with the spinner last: the token segment goes first, then the
			// `think` literal, so a narrow terminal never drops the only moving glyph before the text.
			if (stats) {
				const thoughtCols = state.tail ? MIN_THOUGHT_COLS : 0;
				const fitsHeader = (candidate: string, suffix: string): boolean =>
					visibleWidth(`${candidate} `) + visibleWidth(suffix) + thoughtCols <= w;
				if (!fitsHeader(marker, statsSuffix)) {
					statsSuffix = ` ${formatPeekElapsed(counts?.elapsedMs ?? 0)}`;
					if (!fitsHeader(marker, statsSuffix)) {
						marker = `${glyphs.thinking} ${spin}`;
						statsSuffix = ` ${formatCompactElapsed(counts?.elapsedMs ?? 0)}`;
					}
				}
			}
			const markerWidth = visibleWidth(`${marker} `);
			const suffixWidth = visibleWidth(statsSuffix);
			// The marker row shares its columns with the counts; continuation rows carry no suffix.
			const contentWidth = Math.max(1, w - markerWidth - suffixWidth);
			const thoughtWidth = Math.max(1, w - markerWidth);
			const thoughtIndent = " ".repeat(markerWidth);
			const safeLines = state.tail
				.split("\n")
				.map((tail) => sanitizeStatus(tail))
				.filter(Boolean)
				.slice(-count);
			const latest = safeLines.at(-1) ?? "";
			const lineWithMarker = (tail: string): string => fit(tail ? `${marker} ${tail}${statsSuffix}` : `${marker}${statsSuffix}`);
			if (count >= 2) {
				const window = clipTail(latest, contentWidth * count);
				const latestWrapped = wrapTextWithAnsi(window, Math.max(1, contentWidth));
				if (latestWrapped.length > 1) {
					// Word wrapping may add short rows; always retain the newest content.
					// The counts stay on the marker row: repeating them doubled the numbers.
					const first = latestWrapped.at(-2) ?? "";
					const second = latestWrapped.at(-1) ?? "";
					return `${lineWithMarker(first)}\n${fit(`${thoughtIndent}${second}`)}`;
				}
			}
			const firstTail = clipTail(count >= 2 ? safeLines[0] ?? "" : latest, contentWidth);
			if (count < 2 || safeLines.length < 2) return lineWithMarker(firstTail);
			// Align the latest line with the first line's thinking text, not with the status
			// marker; the continuation row has the counts' columns to itself.
			const secondTail = clipTail(latest, thoughtWidth);
			return `${lineWithMarker(firstTail)}\n${fit(`${thoughtIndent}${secondTail}`)}`;
		}
		case "done":
			return fit(`${prefix} ${glyphs.done}`);
		default:
			return fit(`${prefix} ·`);
	}
}
