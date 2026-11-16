import { UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import { createPainter, type ThemeConfig } from "./theme.ts";

/**
 * Independent from `pi-open-tui.copy-buttons`: two patches guard on their own key, so the install
 * order (`markdown-skin` first, `copy-buttons` second) is what makes the reverse cleanup restore the
 * original methods. See `installCopyButtons`.
 */
const PATCH_KEY = Symbol.for("pi-open-tui.markdown-skin");

/** Pi caps horizontal rules at 80 columns (`Markdown.renderToken`, `case "hr"`); mirror it. */
const HR_MAX_WIDTH = 80;
const LINE_GLYPH = "─";
const DASHED_GLYPH = "╌";
const DIVIDER_TEXT = "---";
/**
 * Turn metrics ride to the rule inside an HTML comment: the source markdown is what Pi caches, so a
 * re-render (resize, theme switch) reproduces the decorated divider instead of losing the numbers.
 * The rule patch swallows the token, so nothing of it reaches the screen.
 */
const TURN_MARKER_OPEN = "<!--pi-turn:";
const TURN_MARKER_CLOSE = "-->";
/** Bracket columns around the label: `┤ ` and ` ├`. */
const TURN_BRACKET_COLUMNS = 4;
/** Rule columns kept on each side before the label is clipped instead of dropped. */
const TURN_MIN_RULE = 2;
/** `▌` plus its column gap: the rail is prepended outside the width Pi budgeted for the text. */
const USER_BAR_GLYPH = "▌";
/**
 * Measured, not hardcoded: `U+258C` is East Asian Ambiguous, so a terminal configured for
 * ambiguous-wide columns draws the rail two columns wide and the hardcoded 2 overflowed by one.
 */
const USER_BAR_COLUMNS = visibleWidth(`${USER_BAR_GLYPH} `);

/** Pi's private `Markdown` fields; checked at runtime because they can change between releases. */
interface MarkdownInternals {
	theme: MarkdownTheme;
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
}

/** Only `render` is wrapped; `text`, the copy payload, is deliberately left alone. */
interface UserMessageInternals {
	render(width: number): string[];
}

/**
 * The skin reads its inputs lazily: a theme switch or a `/open-tui` settings write must change the
 * next render without reinstalling the prototype patch (reinstalling would break the fixed order).
 */
export interface MarkdownSkinSource {
	theme: () => Theme;
	config: () => ThemeConfig;
	/** Reads and clears the turn metrics `agent_settled` left for the next user divider. */
	consumeTurnSummary?: () => string | undefined;
}

let source: MarkdownSkinSource | undefined;
/**
 * The first user message of a session stays unruled; keyed by source text because the transform gets no
 * message identity. A later message with the same text is a message like any other — see `markSkinScope`.
 */
let firstUserText: string | undefined;
/**
 * Label each user message already consumed, keyed by source text for the same reason `firstUserText` is:
 * the transform gets no message identity. Without it a re-render would lose metrics the pending summary
 * can only hand out once. A repeated identical prompt reuses the earlier label — the price of stability.
 */
const dividerLabels = new Map<string, string>();
/** The label a marker token just handed to the rule that follows it in the same render pass. */
let renderedDividerLabel: string | undefined;

/** Called on `session_start`: the divider belongs between messages, not above the first one. */
export function resetMarkdownSkinSession(): void {
	firstUserText = undefined;
	dividerLabels.clear();
	renderedDividerLabel = undefined;
}

/**
 * `user` face transformer: Pi runs it before its native block cache, and the divider only prepends
 * source markdown — `UserMessageComponent.text` keeps the original text, so copying is unaffected.
 */
export function markSkinScope(markdown: string, context: MarkdownTransformContext): string {
	if (!source || context.messageType !== "user" || source.config().dividers === "none") return markdown;
	// Consume up front: a summary that finds no divider here must never stay pending for an unrelated
	// later message.
	const consumed = source.consumeTurnSummary?.();
	const first = firstUserText === undefined;
	if (first) firstUserText = markdown;
	// The ruling exception is one message wide. Re-rendering the first message (resize, theme switch)
	// passes the same text with no summary, which is the only signal a stateless transform has; a new
	// prompt that repeats the first text carries its own summary and is ruled like any other message.
	if (markdown === firstUserText && consumed === undefined) return markdown;
	return dividerSource(markdown, consumed);
}

/**
 * `───┤ 12.3s · 4.5k tok ├──`: the rule keeps the `divider` slot colour, the label keeps its own metrics
 * styling. A label with no room left is clipped; a rule too narrow for brackets degrades to the bare rule.
 */
function decorateRule(paint: (text: string) => string, glyph: string, total: number, label: string): string {
	const room = total - TURN_BRACKET_COLUMNS - TURN_MIN_RULE;
	if (room < 1) return paint(glyph.repeat(total));
	const clipped = visibleWidth(label) > room ? truncateToWidth(label, room, "…") : label;
	const inner = visibleWidth(clipped) + TURN_BRACKET_COLUMNS;
	const left = Math.floor((total - inner) / 2);
	return `${paint(`${glyph.repeat(left)}┤ `)}${clipped}${paint(` ├${glyph.repeat(total - inner - left)}`)}`;
}

/** Prepends the divider, carrying this message's turn metrics when it has any. */
function dividerSource(markdown: string, consumed: string | undefined): string {
	// A cache hit is still overwritten by the current summary: the numbers on screen must describe the
	// turn that just finished, and the summary must never be left unconsumed.
	const label = consumed ?? dividerLabels.get(markdown);
	if (label === undefined) return `${DIVIDER_TEXT}\n\n${markdown}`;
	dividerLabels.set(markdown, label);
	return `${TURN_MARKER_OPEN}${label}${TURN_MARKER_CLOSE}\n\n${DIVIDER_TEXT}\n\n${markdown}`;
}

/**
 * Wraps `Markdown.prototype.renderToken` so a horizontal rule is drawn from the `divider` slot.
 * Returns `undefined` when the prototype lacks the hook (silent degradation) or is already patched.
 */
export function installMarkdownSkin(next: MarkdownSkinSource): (() => void) | undefined {
	const markdownProto = Markdown.prototype as unknown as MarkdownInternals & Record<symbol, unknown>;
	if (typeof markdownProto.renderToken !== "function" || markdownProto[PATCH_KEY]) return undefined;

	const originalRenderToken = markdownProto.renderToken;
	source = next;

	const patched = function (this: MarkdownInternals, token: Token, width: number, nextTokenType?: string,
		styleContext?: unknown): string[] {
		const current = source;
		const style = current?.config().dividers ?? "none";
		// The marker is ours: swallow it and hand its label to the rule rendered right after it.
		if (token.type === "html" && typeof token.raw === "string"
			&& token.raw.startsWith(TURN_MARKER_OPEN) && token.raw.endsWith(TURN_MARKER_CLOSE)) {
			renderedDividerLabel = token.raw.slice(TURN_MARKER_OPEN.length, -TURN_MARKER_CLOSE.length);
			return [];
		}
		if (!current || token.type !== "hr" || style === "none") {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		const painter = createPainter(current.theme(), current.config());
		const glyph = style === "dashed" ? DASHED_GLYPH : LINE_GLYPH;
		const paint = (text: string): string => painter.paint("divider", text);
		const label = renderedDividerLabel;
		renderedDividerLabel = undefined;
		const rule = label === undefined
			? paint(glyph.repeat(Math.min(width, HR_MAX_WIDTH)))
			: decorateRule(paint, glyph, Math.min(width, HR_MAX_WIDTH), label);
		const rows = [rule];
		// Same spacing rule as Pi's own horizontal rule.
		if (nextTokenType && nextTokenType !== "space") rows.push("");
		return rows;
	};

	markdownProto.renderToken = patched;
	markdownProto[PATCH_KEY] = true;

	// The rail is prepended to the rendered rows, so `UserMessageComponent.text` (the copy payload)
	// keeps the original markdown and the bubble `[Copy]` button copies the message, not the glyph.
	const userProto = UserMessageComponent.prototype as unknown as UserMessageInternals;
	const originalUserRender = userProto.render;
	let patchedUserRender: ((this: UserMessageInternals, width: number) => string[]) | undefined;
	if (typeof originalUserRender === "function") {
		patchedUserRender = function (this: UserMessageInternals, width: number): string[] {
			const current = source;
			// Pi pads its bubble to the width it is handed, so the two rail columns come out of the
			// budget instead of widening the row past the terminal.
			const budget = width - USER_BAR_COLUMNS;
			if (!current || !current.config().userBar || budget < 1) return originalUserRender.call(this, width);
			const rows = originalUserRender.call(this, budget);
			// Very narrow terminals make Pi's own renderer overflow its budget (fences keep a minimum
			// width); the rail is dropped rather than adding two more columns to an already broken row.
			if (rows.some((line) => visibleWidth(line) > budget)) return originalUserRender.call(this, width);
			const painter = createPainter(current.theme(), current.config());
			const rail = `${painter.paint("userBar", USER_BAR_GLYPH)} `;
			return rows.map((line) => `${rail}${line}`);
		};
		userProto.render = patchedUserRender;
	}

	return () => {
		// Another extension may have wrapped ours; leave its wrapper in place then.
		if (markdownProto.renderToken === patched) markdownProto.renderToken = originalRenderToken;
		if (patchedUserRender !== undefined && userProto.render === patchedUserRender) userProto.render = originalUserRender;
		delete markdownProto[PATCH_KEY];
		source = undefined;
		firstUserText = undefined;
		dividerLabels.clear();
		renderedDividerLabel = undefined;
	};
}
