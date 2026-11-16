import {
	AssistantMessageComponent,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stampBubbleTopRow } from "./bubble.ts";
import { createPainter, type ThemeConfig } from "./theme.ts";

/** Installed after the bubble so it can write into the frame's top border row. */
const ASSISTANT_PATCH_KEY = Symbol.for("pi-open-tui.assistant-timestamps");
const USER_PATCH_KEY = Symbol.for("pi-open-tui.user-timestamps");

/** Below this an `HH:MM` stamp would eat the row it decorates. */
export const TIMESTAMP_MIN_WIDTH = 24;

/**
 * Pi's messages carry the time in three shapes, all normalised to a local `HH:MM`:
 * `(this as any).timestamp` is an ISO string on the session-restore path, `lastMessage.timestamp` is
 * epoch milliseconds on the live path, and a component with neither gets one snapshot (see below).
 */
export function formatTimestamp(value: unknown): string | undefined {
	const millis = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : undefined;
	if (millis === undefined || !Number.isFinite(millis)) return undefined;
	const date = new Date(millis);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * A second render of the same component must print the same stamp, so the clock is read once here
 * instead of on every render. `WeakMap` keeps the module from retaining finished components.
 */
const snapshots = new WeakMap<object, string>();

function labelFor(component: object, kind: "assistant" | "user"): string | undefined {
	const restored = formatTimestamp((component as { timestamp?: unknown }).timestamp);
	if (restored !== undefined) return restored;
	if (kind === "assistant") {
		const live = formatTimestamp((component as { lastMessage?: { timestamp?: unknown } }).lastMessage?.timestamp);
		if (live !== undefined) return live;
	}
	const snapshot = snapshots.get(component);
	if (snapshot !== undefined) return snapshot;
	const now = formatTimestamp(Date.now());
	if (now !== undefined) snapshots.set(component, now);
	return now;
}

/**
 * `null` when `line` does not end in enough blank columns to hold `label`, so a stamp can never cover
 * text. Truncating keeps every escape sequence the row opened and closes it again.
 */
function writeRight(line: string, label: string, width: number): string | undefined {
	const labelWidth = visibleWidth(label);
	if (labelWidth === 0 || labelWidth >= width) return undefined;
	const bare = stripTerminalSequences(line);
	if (bare.length < labelWidth || bare.slice(-labelWidth).trim() !== "") return undefined;
	return truncateToWidth(line, width - labelWidth, "", true) + label;
}

/** `null` unless the row is visually blank, which is what Pi's `Markdown` reserves above a message. */
function writePrefix(line: string, label: string, width: number): string | undefined {
	const labelWidth = visibleWidth(label);
	const used = visibleWidth(line);
	if (labelWidth === 0 || used + labelWidth > width) return undefined;
	if (stripTerminalSequences(line).trim() !== "") return undefined;
	return line + label + " ".repeat(width - used - labelWidth);
}

interface MessageInternals {
	render(width: number): string[];
}

export interface TimestampSource {
	theme: () => Theme;
	config: () => ThemeConfig;
}

let source: TimestampSource | undefined;

/**
 * Wraps the two message components' `render` so each message can carry a `HH:MM` stamp without
 * adding a row. Returns `undefined` when either prototype lacks `render` or is already patched.
 */
export function installTimestamps(next: TimestampSource): (() => void) | undefined {
	const assistantProto = AssistantMessageComponent.prototype as unknown as MessageInternals & Record<symbol, unknown>;
	const userProto = UserMessageComponent.prototype as unknown as MessageInternals & Record<symbol, unknown>;
	if (typeof assistantProto.render !== "function" || typeof userProto.render !== "function") return undefined;
	if (assistantProto[ASSISTANT_PATCH_KEY] || userProto[USER_PATCH_KEY]) return undefined;

	const originalAssistant = assistantProto.render;
	const originalUser = userProto.render;
	source = next;

	const patchedAssistant = function (this: MessageInternals, width: number): string[] {
		const current = source;
		const mode = current?.config().timestamps ?? "all";
		if (current === undefined || mode === "off" || width < TIMESTAMP_MIN_WIDTH) {
			return originalAssistant.call(this, width);
		}
		const label = labelFor(this, "assistant");
		const rows = originalAssistant.call(this, width);
		if (label === undefined || rows.length === 0) return rows;
		const painter = createPainter(current.theme(), current.config());
		// With the bubble installed the frame owns row 0, so the stamp rides its top border.
		const framed = stampBubbleTopRow(rows[0] ?? "", label, painter);
		if (framed !== undefined) {
			rows[0] = framed;
			return rows;
		}
		const prefixed = writePrefix(rows[0] ?? "", painter.paint("divider", label), width);
		if (prefixed !== undefined) rows[0] = prefixed;
		return rows;
	};

	const patchedUser = function (this: MessageInternals, width: number): string[] {
		const current = source;
		const mode = current?.config().timestamps ?? "all";
		// `assistant` mode leaves user messages untouched; the row-0 stamp is the only place a user
		// message has, and it must never reach the `[Copy]` row below it.
		if (current === undefined || mode === "off" || mode === "assistant" || width < TIMESTAMP_MIN_WIDTH) {
			return originalUser.call(this, width);
		}
		const label = labelFor(this, "user");
		const rows = originalUser.call(this, width);
		if (label === undefined || rows.length === 0) return rows;
		const written = writeRight(rows[0] ?? "", createPainter(current.theme(), current.config()).paint("divider", label), width);
		if (written !== undefined) rows[0] = written;
		return rows;
	};

	assistantProto.render = patchedAssistant;
	userProto.render = patchedUser;
	assistantProto[ASSISTANT_PATCH_KEY] = true;
	userProto[USER_PATCH_KEY] = true;

	return () => {
		// Another extension may have wrapped ours; leave its wrapper in place then.
		if (assistantProto.render === patchedAssistant) assistantProto.render = originalAssistant;
		if (userProto.render === patchedUser) userProto.render = originalUser;
		delete assistantProto[ASSISTANT_PATCH_KEY];
		delete userProto[USER_PATCH_KEY];
		source = undefined;
	};
}
