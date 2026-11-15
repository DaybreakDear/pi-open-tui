import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExpandHint } from "./theme.ts";

/** The expand affordance every hinted row ends with. */
export const HINT_KEY = "ctrl+o";
export const HINT_TAIL = "to expand";
/** The plain form; `"plain"` paints exactly this, as v0.4.6 did. */
export const HINT_TEXT = `(${HINT_KEY} ${HINT_TAIL})`;

/**
 * The keycap alone, one brightness step above `dim` and underlined. `theme.style` is used instead of
 * `theme.underline` because text attributes must survive a process whose chalk colour level is off.
 */
function keycap(theme: Theme): string {
	return theme.style(HINT_KEY, { fg: "muted", underline: true });
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
 * only, so both modes occupy the same width and no caller's budget changes.
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
