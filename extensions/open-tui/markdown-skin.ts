import type { MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
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

/** Pi's private `Markdown` fields; checked at runtime because they can change between releases. */
interface MarkdownInternals {
	theme: MarkdownTheme;
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
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

	return () => {
		// Another extension may have wrapped ours; leave its wrapper in place then.
		if (markdownProto.renderToken === patched) markdownProto.renderToken = originalRenderToken;
		delete markdownProto[PATCH_KEY];
		source = undefined;
		firstUserText = undefined;
	};
}
