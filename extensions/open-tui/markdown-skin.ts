import { UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
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
/** `▌` plus its column gap: the rail is prepended outside the width Pi budgeted for the text. */
const USER_BAR_GLYPH = "▌";
const USER_BAR_COLUMNS = 2;

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
}

let source: MarkdownSkinSource | undefined;
/**
 * The first user message of a session stays unruled; keyed by source text because the transform gets no
 * message identity. A repeated identical prompt reuses the exemption — the price of stable re-renders.
 */
let firstUserText: string | undefined;

/** Called on `session_start`: the divider belongs between messages, not above the first one. */
export function resetMarkdownSkinSession(): void {
	firstUserText = undefined;
}

/**
 * `user` face transformer: Pi runs it before its native block cache, and the divider only prepends
 * source markdown — `UserMessageComponent.text` keeps the original text, so copying is unaffected.
 */
export function markSkinScope(markdown: string, context: MarkdownTransformContext): string {
	if (!source || context.messageType !== "user" || source.config().dividers === "none") return markdown;
	if (firstUserText === undefined) {
		firstUserText = markdown;
		return markdown;
	}
	if (markdown === firstUserText) return markdown;
	return `${DIVIDER_TEXT}\n\n${markdown}`;
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
		if (!current || token.type !== "hr" || style === "none") {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		const painter = createPainter(current.theme(), current.config());
		const glyph = style === "dashed" ? DASHED_GLYPH : LINE_GLYPH;
		const rows = [painter.paint("divider", glyph.repeat(Math.min(width, HR_MAX_WIDTH)))];
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
	};
}
