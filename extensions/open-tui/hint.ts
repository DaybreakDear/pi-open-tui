import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExpandHint } from "./theme.ts";

/** The expand affordance every hinted row ends with. */
export const HINT_KEY = "ctrl+o";
export const HINT_TAIL = "to expand";
/** The plain form; `"plain"` paints exactly this, as v0.4.6 did. */
export const HINT_TEXT = `(${HINT_KEY} ${HINT_TAIL})`;

/** SGR 4 opens the underline and SGR 24 closes it around the keycap's painted span. */
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

/**
 * The keycap alone: one brightness step above `dim`, underlined, but only while the theme paints. `theme.fg`
 * is the signal — it hands back escapes in a process that renders colour and its argument unchanged in one
 * that does not — and the underline is emitted here rather than through `theme.style`/`theme.underline`,
 * whose chalk path can drop text attributes.
 */
function keycap(theme: Theme): string {
	const label = theme.fg("muted", HINT_KEY);
	return label === HINT_KEY ? label : `${UNDERLINE_ON}${label}${UNDERLINE_OFF}`;
}

/**
 * `head` followed by the `ctrl+o` affordance, painted through `paint` — the span the row already uses
 * for that line.
 *
 * `"plain"` paints `head` and the hint as one span, byte for byte what v0.4.6 emitted. `"key"` keeps
 * the row's span on `head`, then paints the parentheses and tail `dim` and only the keycap with the
 * emphasis, so the hint is easier to find without becoming louder.
 *
 * `maxWidth` truncates by visible columns. `"plain"` truncates the text before painting, exactly as
 * v0.4.6 did; `"key"` truncates the painted line so the underline survives. Underline adds SGR bytes
 * only, so both modes occupy the same width and no caller's budget changes. Without colour (a theme that
 * paints nothing) the keycap span collapses, so `"key"` emits the `"plain"` bytes.
 */
export function formatExpandHint(
	theme: Theme,
	mode: ExpandHint | undefined,
	head: string,
	paint: (text: string) => string,
	maxWidth?: number,
): string {
	if (mode !== "key") {
		const text = `${head} ${HINT_TEXT}`;
		return paint(maxWidth === undefined ? text : truncateToWidth(text, maxWidth, "…"));
	}
	const line = paint(head) + theme.fg("dim", " (") + keycap(theme) + theme.fg("dim", ` ${HINT_TAIL})`);
	return maxWidth === undefined ? line : truncateToWidth(line, maxWidth, "…");
}
