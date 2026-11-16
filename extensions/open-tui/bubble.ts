import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createPainter, type Painter, type ThemeConfig } from "./theme.ts";

/**
 * Independent from the other prototype patches: the bubble guards on its own key, is installed after
 * `installMarkdownSkin` / `installCopyButtons`, and its cleanup therefore runs first.
 */
const PATCH_KEY = Symbol.for("pi-open-tui.assistant-bubble");

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const SIDE = "│";
const RULE = "─";

/**
 * Measured, not hardcoded: `─` (U+2500) and `│` (U+2502) are East Asian Ambiguous, so a terminal
 * configured for wide-ambiguous columns draws them two columns wide and a hardcoded 2 overflows.
 */
const RULE_COLUMNS = visibleWidth(RULE);
const SIDE_COLUMNS = visibleWidth(SIDE);

/** `│` plus its gap column on each side; the frame costs these out of the width budget. */
export const BUBBLE_LEFT_RESERVE = SIDE_COLUMNS + 1;
export const BUBBLE_RIGHT_RESERVE = SIDE_COLUMNS + 1;
/** Below this the frame would leave no room for the message. */
export const BUBBLE_MIN_WIDTH = 20;

type Paint = (text: string) => string;

/** Every emitted line has exactly `width` columns: the rule repeat absorbs the remainder as spaces. */
function cornerRow(width: number, left: string, right: string, paint: Paint, segment = ""): string {
	const inner = width - visibleWidth(left) - visibleWidth(right);
	const free = inner - visibleWidth(segment);
	const cells = Math.max(0, Math.floor(free / RULE_COLUMNS));
	const gap = Math.max(0, free - cells * RULE_COLUMNS);
	return `${paint(left)}${paint(RULE.repeat(cells))}${" ".repeat(gap)}${segment === "" ? "" : paint(segment)}${paint(right)}`;
}

function contentRow(row: string, inner: number, side: string): string {
	const pad = Math.max(0, inner - visibleWidth(row));
	return `${side} ${row}${" ".repeat(pad)} ${side}`;
}

function frame(rows: string[], width: number, painter: Painter): string[] {
	const inner = width - BUBBLE_LEFT_RESERVE - BUBBLE_RIGHT_RESERVE;
	const paint: Paint = (text) => painter.paint("divider", text);
	const side = paint(SIDE);
	const framed = [cornerRow(width, TOP_LEFT, TOP_RIGHT, paint)];
	for (const row of rows) framed.push(contentRow(row, inner, side));
	framed.push(cornerRow(width, BOTTOM_LEFT, BOTTOM_RIGHT, paint));
	return framed;
}

/**
 * Rewrites the frame's top row with `label` right-aligned; `undefined` when `row` is not a bubble top
 * row or the label does not fit, so the caller can fall back instead of splitting the frame.
 */
export function stampBubbleTopRow(row: string, label: string, painter: Painter): string | undefined {
	const width = visibleWidth(row);
	const bare = stripTerminalSequences(row);
	if (!bare.startsWith(TOP_LEFT) || !bare.endsWith(TOP_RIGHT)) return undefined;
	const segment = ` ${label} `;
	if (visibleWidth(segment) > width - visibleWidth(TOP_LEFT) - visibleWidth(TOP_RIGHT)) return undefined;
	return cornerRow(width, TOP_LEFT, TOP_RIGHT, (text) => painter.paint("divider", text), segment);
}

/** Only `render` is wrapped; the message text and `outputPad` stay untouched. */
interface AssistantInternals {
	render(width: number): string[];
}

export interface BubbleSource {
	theme: () => Theme;
	config: () => ThemeConfig;
}

let source: BubbleSource | undefined;

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
/** Pi's `isImageLine` is not exported from the package root; mirror its two protocol prefixes. */
function isImageRow(row: string): boolean {
	return row.includes(KITTY_PREFIX) || row.includes(ITERM2_PREFIX);
}

/**
 * Wraps `AssistantMessageComponent.prototype.render` so the reply is drawn inside a rounded frame that
 * spends the width budget instead of adding columns. Returns `undefined` when the prototype lacks the
 * member (silent degradation) or is already patched.
 */
export function installBubble(next: BubbleSource): (() => void) | undefined {
	const assistantProto = AssistantMessageComponent.prototype as unknown as AssistantInternals & Record<symbol, unknown>;
	if (typeof assistantProto.render !== "function" || assistantProto[PATCH_KEY]) return undefined;

	const originalRender = assistantProto.render;
	source = next;

	const patched = function (this: AssistantInternals, width: number): string[] {
		const current = source;
		// All-or-nothing: a half-drawn frame would leave rows wider or narrower than the budget.
		if (current === undefined || current.config().bubble === "off" || width < BUBBLE_MIN_WIDTH) {
			return originalRender.call(this, width);
		}
		const inner = width - BUBBLE_LEFT_RESERVE - BUBBLE_RIGHT_RESERVE;
		if (inner < 1) return originalRender.call(this, width);
		// The inner component is rendered at the width the frame actually leaves for it, so
		// `copy-buttons` (which sees the same inner rows) keeps its coordinate math correct.
		const rows = originalRender.call(this, inner);
		// An inline image owns its own columns, and Pi's own renderer keeps a minimum width for
		// fences: either one would break the frame, so the frame is dropped rather than clipping.
		if (rows.length === 0 || rows.some((row) => isImageRow(row) || visibleWidth(row) > inner)) {
			return originalRender.call(this, width);
		}
		return frame(rows, width, createPainter(current.theme(), current.config()));
	};

	assistantProto.render = patched;
	assistantProto[PATCH_KEY] = true;

	return () => {
		// Another extension may have wrapped ours; leave its wrapper in place then.
		if (assistantProto.render === patched) assistantProto.render = originalRender;
		delete assistantProto[PATCH_KEY];
		source = undefined;
	};
}
