import { AssistantMessageComponent, UserMessageComponent, type MarkdownTransformContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type MarkdownTheme, type Token } from "@earendil-works/pi-tui";
import type { IconMode, TelemetryConfig } from "./config.ts";
import type { CostConfig } from "./currency.ts";
import { formatTurnTelemetry, parseTurnTelemetry, type TurnTelemetry } from "./telemetry.ts";
import { createPainter, type Painter, type ThemeConfig } from "./theme.ts";

const PATCH_KEY = Symbol.for("pi-open-tui.markdown-skin");
const LINE_GLYPH = "━";
const DASHED_GLYPH = "╍";
const TURN_BRACKET_COLUMNS = 4;
const TURN_MIN_RULE = 2;
const USER_BAR_GLYPH = "▌";
const USER_BAR_COLUMNS = visibleWidth(`${USER_BAR_GLYPH} `);

interface MarkdownInternals {
	theme: MarkdownTheme;
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
}

interface UserMessageInternals {
	render(width: number): string[];
	children: unknown[];
}

interface AssistantMessageInternals {
	render(width: number): string[];
	contentContainer: { children: unknown[] };
	markdownSlots: { kind: string; markdown: unknown }[];
	lastMessage?: { stopReason?: string };
	hasToolCalls: boolean;
	isStreaming: boolean;
}

export interface MarkdownSkinSource {
	theme: () => Theme;
	config: () => ThemeConfig;
	/** The metrics left by agent_settled for the next user message. */
	consumeTurnSummary?: () => string | undefined;
	telemetrySettings: () => TurnTelemetrySettings;
}

export interface TurnTelemetrySettings {
	config: TelemetryConfig;
	iconMode: IconMode;
	cost: CostConfig;
}

let source: MarkdownSkinSource | undefined;
let firstUser: object | undefined;
let boundaries = new WeakMap<object, { telemetry?: TurnTelemetry }>();
let dividerRows = new WeakMap<object, number>();

/** Session boundaries reset the first-user exemption and all per-message render state. */
export function resetMarkdownSkinSession(): void {
	firstUser = undefined;
	boundaries = new WeakMap();
	dividerRows = new WeakMap();
}

/** A boundary is a component row, never part of the source Markdown or its copy payload. */
export function markSkinScope(markdown: string, _context: MarkdownTransformContext): string {
	return markdown;
}

/** Used by the timestamp wrapper, which is installed outside the user-message skin. */
export function userDividerRowCount(component: object): number {
	return dividerRows.get(component) ?? 0;
}

function decorateRule(paint: (text: string) => string, glyph: string, total: number, label: string): string {
	const room = total - TURN_BRACKET_COLUMNS - TURN_MIN_RULE;
	if (room < 1) return paint(glyph.repeat(total));
	const clipped = visibleWidth(label) > room ? truncateToWidth(label, room, "…") : label;
	const inner = visibleWidth(clipped) + TURN_BRACKET_COLUMNS;
	const left = Math.floor((total - inner) / 2);
	return `${paint(`${glyph.repeat(left)}┫ `)}${clipped}${paint(` ┣${glyph.repeat(total - inner - left)}`)}`;
}

function formatLabel(telemetry: TurnTelemetry, current: MarkdownSkinSource, painter: Painter): string {
	const settings = current.telemetrySettings();
	return formatTurnTelemetry(telemetry, current.theme(), settings.config, settings.iconMode, settings.cost, painter);
}

/** Keep normal author-written Markdown HRs styled; do not treat them as conversation boundaries. */
export function installMarkdownSkin(next: MarkdownSkinSource): (() => void) | undefined {
	const markdownProto = Markdown.prototype as unknown as MarkdownInternals & Record<symbol, unknown>;
	if (typeof markdownProto.renderToken !== "function" || markdownProto[PATCH_KEY]) return undefined;

	const originalRenderToken = markdownProto.renderToken;
	let installed = true;
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
		const rows = [painter.paint("divider", glyph.repeat(Math.max(0, width)))];
		if (nextTokenType && nextTokenType !== "space") rows.push("");
		return rows;
	};
	markdownProto.renderToken = patched;
	markdownProto[PATCH_KEY] = true;

	const assistantProto = AssistantMessageComponent.prototype as unknown as AssistantMessageInternals;
	const originalAssistantRender = assistantProto.render;
	const assistantRules = new WeakMap<object, { render(width: number): string[]; invalidate(): void }>();
	let patchedAssistantRender: ((this: AssistantMessageInternals, width: number) => string[]) | undefined;
	if (typeof originalAssistantRender === "function") {
		patchedAssistantRender = function (this: AssistantMessageInternals, width: number): string[] {
			const current = source;
			let divider = assistantRules.get(this);
			if (divider !== undefined) {
				const oldIndex = this.contentContainer.children.indexOf(divider);
				if (oldIndex >= 0) this.contentContainer.children.splice(oldIndex, 1);
			}
			const style = current?.config().dividers ?? "none";
			// Only a completed text answer gets a rule; tool calls and partial streams do not.
			const final = !this.isStreaming && !this.hasToolCalls
				&& (this.lastMessage?.stopReason === "stop" || this.lastMessage?.stopReason === "length");
			let lastThinking = -1;
			for (let index = 0; index < this.markdownSlots.length; index++) {
				if (this.markdownSlots[index]?.kind === "thinking") lastThinking = index;
			}
			const textSlot = this.markdownSlots.slice(lastThinking + 1).find((slot) => slot.kind === "text");
			const textIndex = textSlot === undefined ? -1 : this.contentContainer.children.indexOf(textSlot.markdown);
			if (current && final && style !== "none" && width > 0 && textIndex >= 0) {
				if (divider === undefined) {
					divider = {
						invalidate() {},
						render(ruleWidth: number): string[] {
							const skin = source;
							if (!installed || !skin || ruleWidth < 1 || skin.config().dividers === "none") return [];
							const glyph = skin.config().dividers === "dashed" ? DASHED_GLYPH : LINE_GLYPH;
							return [createPainter(skin.theme(), skin.config()).paint("divider", glyph.repeat(ruleWidth))];
						},
					};
					assistantRules.set(this, divider);
				}
				// Place the rule *after* thinking and before answer text. As a real child it participates
				// in Pi's mouse layout; a prefixed render row would shift copy and thinking hit regions.
				this.contentContainer.children.splice(textIndex, 0, divider);
			}
			return originalAssistantRender.call(this, width);
		};
		assistantProto.render = patchedAssistantRender;
	}

	const userProto = UserMessageComponent.prototype as unknown as UserMessageInternals;
	const originalUserRender = userProto.render;
	const userRules = new WeakMap<object, { render(width: number): string[]; invalidate(): void }>();
	const userWidths = new WeakMap<object, number>();
	let patchedUserRender: ((this: UserMessageInternals, width: number) => string[]) | undefined;
	if (typeof originalUserRender === "function") {
		patchedUserRender = function (this: UserMessageInternals, width: number): string[] {
			const current = source;
			if (!current) return originalUserRender.call(this, width);
			if (firstUser === undefined) firstUser = this;
			let boundary = boundaries.get(this);
			if (boundary === undefined) {
				const summary = current.consumeTurnSummary?.();
				boundary = { telemetry: summary === undefined ? undefined : parseTurnTelemetry(summary) };
				boundaries.set(this, boundary);
			}
			const thisOwner = this;
			userWidths.set(this, width);
			let divider = userRules.get(this);
			if (divider !== undefined) {
				const oldIndex = this.children.indexOf(divider);
				if (oldIndex >= 0) this.children.splice(oldIndex, 1);
			}
			const style = current.config().dividers;
			const hasDivider = this !== firstUser && style !== "none" && width > 0;
			dividerRows.set(this, hasDivider ? 1 : 0);
			if (hasDivider) {
				if (divider === undefined) {
					divider = {
						invalidate() {},
						render(ruleWidth: number): string[] {
							const skin = source;
							if (!installed || !skin || ruleWidth < 1) return [];
							const glyph = skin.config().dividers === "dashed" ? DASHED_GLYPH : LINE_GLYPH;
							const painter = createPainter(skin.theme(), skin.config());
							const total = userWidths.get(thisOwner) ?? ruleWidth;
							const state = boundaries.get(thisOwner);
							const label = state?.telemetry === undefined ? undefined : formatLabel(state.telemetry, skin, painter);
							return [label === undefined ? painter.paint("divider", glyph.repeat(total))
								: decorateRule((text) => painter.paint("divider", text), glyph, total, label)];
						},
					};
					userRules.set(this, divider);
				}
				this.children.unshift(divider);
			}
			const budget = width - USER_BAR_COLUMNS;
			const railEnabled = current.config().userBar && budget > 0;
			let rows = originalUserRender.call(this, railEnabled ? budget : width);
			// Pi can overflow at very narrow widths (e.g. fenced blocks). Do not compound it.
			if (railEnabled && rows.slice(hasDivider ? 1 : 0).some((line) => visibleWidth(line) > budget)) {
				rows = originalUserRender.call(this, width);
			} else if (railEnabled) {
				const rail = `${createPainter(current.theme(), current.config()).paint("userBar", USER_BAR_GLYPH)} `;
				rows = rows.map((line, index) => index === 0 && hasDivider ? line : `${rail}${line}`);
			}
			// Pi places its copy zone on row 0. Keep that zone on the original message,
			// not on the extra divider child, so shell-integrated copy excludes the rule.
			const zoneStart = "\x1b]133;A\x07";
			if (hasDivider && rows.length > 1 && rows[0]?.startsWith(zoneStart)) {
				rows[0] = rows[0].slice(zoneStart.length);
				rows[1] = zoneStart + rows[1];
			}
			return rows;
		};
		userProto.render = patchedUserRender;
	}

	return () => {
		installed = false;
		if (markdownProto.renderToken === patched) markdownProto.renderToken = originalRenderToken;
		if (patchedUserRender !== undefined && userProto.render === patchedUserRender) userProto.render = originalUserRender;
		if (patchedAssistantRender !== undefined && assistantProto.render === patchedAssistantRender) assistantProto.render = originalAssistantRender;
		delete markdownProto[PATCH_KEY];
		source = undefined;
		resetMarkdownSkinSession();
	};
}
