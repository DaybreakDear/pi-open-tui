import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { parseColor, type Color } from "@earendil-works/pi-tui";

/** `pi` follows the active Pi theme exactly, so the open-tui layer paints no colours of its own. */
export type ThemePreset = "pi" | "tokyo-night" | "catppuccin-mocha" | "gruvbox-dark" | "rose-pine-moon";

export type SlotName =
	| "thinking"
	| "toolCall"
	| "toolTitle"
	| "toolOutput"
	| "command"
	| "divider"
	| "gutter"
	| "userBar"
	| "cost"
	| "stats"
	| "success"
	| "error"
	| "warning";

/** A Pi theme token name, or a colour literal such as `#7aa2f7` or `oklch(62% 0.1 200)`. */
export type SlotValue = string;

export type DividerStyle = "none" | "line" | "dashed";

export interface ThemeConfig {
	preset: ThemePreset;
	/** Per-slot overrides; they beat the preset and the Pi token. */
	slots: Partial<Record<SlotName, SlotValue>>;
	dividers: DividerStyle;
	gutter: boolean;
	banding: boolean;
}

export const SLOT_NAMES: readonly SlotName[] = [
	"thinking",
	"toolCall",
	"toolTitle",
	"toolOutput",
	"command",
	"divider",
	"gutter",
	"userBar",
	"cost",
	"stats",
	"success",
	"error",
	"warning",
];

export const THEME_PRESETS: readonly ThemePreset[] = ["pi", "tokyo-night", "catppuccin-mocha", "gruvbox-dark", "rose-pine-moon"];

export const DIVIDER_STYLES: readonly DividerStyle[] = ["none", "line", "dashed"];

/**
 * The Pi token each slot fell back to before the slot layer existed (v0.4.6). `preset: "pi"` with no
 * overrides must therefore render exactly the old colours.
 */
export const SLOT_TOKEN: Record<SlotName, ThemeColor> = {
	thinking: "thinkingText",
	toolCall: "toolTitle",
	toolTitle: "toolTitle",
	toolOutput: "toolOutput",
	command: "toolTitle",
	divider: "dim",
	gutter: "dim",
	userBar: "accent",
	cost: "warning",
	stats: "accent",
	success: "success",
	error: "error",
	warning: "warning",
};

/**
 * Preset colours come from the palette in `themes/<preset>.json`. toolTitle, toolOutput, command,
 * cost and divider mirror the tokens those themes already set; toolCall, gutter and userBar sit
 * next to them in the same palette.
 */
export const PRESET_SLOTS: Record<Exclude<ThemePreset, "pi">, Partial<Record<SlotName, SlotValue>>> = {
	"tokyo-night": {
		thinking: "#7aa2f7",
		toolCall: "#bb9af7",
		toolTitle: "#7dcfff",
		toolOutput: "#a9b1d6",
		command: "#e0af68",
		divider: "#3b4261",
		gutter: "#414868",
		userBar: "#7aa2f7",
		cost: "#e0af68",
	},
	"catppuccin-mocha": {
		thinking: "#89b4fa",
		toolCall: "#cba6f7",
		toolTitle: "#89dceb",
		toolOutput: "#bac2de",
		command: "#f9e2af",
		divider: "#45475a",
		gutter: "#313244",
		userBar: "#89b4fa",
		cost: "#f9e2af",
	},
	"gruvbox-dark": {
		thinking: "#83a598",
		toolCall: "#d3869b",
		toolTitle: "#8ec07c",
		toolOutput: "#d5c4a1",
		command: "#fabd2f",
		divider: "#504945",
		gutter: "#3c3836",
		userBar: "#83a598",
		cost: "#fabd2f",
	},
	"rose-pine-moon": {
		thinking: "#c4a7e7",
		toolCall: "#ea9a97",
		toolTitle: "#9ccfd8",
		toolOutput: "#908caa",
		command: "#f6c177",
		divider: "#56526e",
		gutter: "#393552",
		userBar: "#c4a7e7",
		cost: "#f6c177",
	},
};

/** Used when no theme block is configured: identical to `preset: "pi"`. */
export const PI_THEME_CONFIG: ThemeConfig = { preset: "pi", slots: {}, dividers: "line", gutter: true, banding: false };

/** Slot overrides win over the preset; `pi` contributes no preset colours. */
export function resolveSlotColor(cfg: ThemeConfig, slot: SlotName): SlotValue | undefined {
	const override = cfg.slots[slot];
	if (override !== undefined) return override;
	return cfg.preset === "pi" ? undefined : PRESET_SLOTS[cfg.preset][slot];
}

const COLOR_LITERAL = /^(?:#|oklch\(|oklab\()/i;

/** Parse a configured colour literal; an unreadable value is ignored so painting never throws. */
function parseColorLiteral(value: SlotValue): Color | undefined {
	if (!COLOR_LITERAL.test(value)) return undefined;
	try {
		return parseColor(value);
	} catch {
		return undefined;
	}
}

type ColorFn = (text: string) => string;

/**
 * A token name paints through `theme.fg`; anything else is a colour literal painted through
 * `theme.style`. Names the theme does not know are ignored rather than thrown on.
 */
function colorFn(theme: Theme, value: SlotValue | undefined, token: ThemeColor): ColorFn {
	if (value !== undefined) {
		if (COLOR_LITERAL.test(value)) {
			const color = parseColorLiteral(value);
			if (color) {
				const literal = color;
				return typeof theme.style === "function"
					? (text) => theme.style(text, { fg: literal })
					: (text) => theme.fg(token, text);
			}
		} else {
			const known = (theme as { colors?: Record<string, unknown> }).colors;
			if (known === undefined || Object.hasOwn(known, value)) {
				return (text) => theme.fg(value as ThemeColor, text);
			}
		}
	}
	return (text) => theme.fg(token, text);
}

export interface Painter {
	/** Paint `text` with the slot's colour, or with `fallback`/the Pi token when the slot resolves none. */
	paint(slot: SlotName, text: string, fallback?: ThemeColor): string;
	/** The same painting as a reusable function (drop caps, separators). */
	raw(slot: SlotName, fallback?: ThemeColor): ColorFn;
}

/**
 * `fallback` exists for call sites whose colour is computed today (a tool-call icon that follows the
 * call status): no slot value means the dynamic token survives untouched.
 */
export function createPainter(theme: Theme, cfg: ThemeConfig = PI_THEME_CONFIG): Painter {
	const functions = new Map<string, ColorFn>();
	const raw = (slot: SlotName, fallback?: ThemeColor): ColorFn => {
		const token = fallback ?? SLOT_TOKEN[slot];
		const key = `${slot}\u0000${token}`;
		const cached = functions.get(key);
		if (cached) return cached;
		const fn = colorFn(theme, resolveSlotColor(cfg, slot), token);
		functions.set(key, fn);
		return fn;
	};
	return {
		paint: (slot, text, fallback) => raw(slot, fallback)(text),
		raw,
	};
}

/**
 * `epoch` changes whenever the configuration changes. Renderers that cache painted rows key on it,
 * so a theme switch repaints instead of reusing rows drawn in the previous colours.
 */
export interface Skin {
	painter: Painter;
	epoch: number;
}

export type SkinProvider = (theme: Theme) => Skin;

/** Rebuilds the painter for a new theme or a new configuration; otherwise the cached one is reused. */
export function createSkinProvider(getConfig: () => ThemeConfig, getEpoch: () => number): SkinProvider {
	let cached: { theme: Theme; epoch: number; skin: Skin } | undefined;
	return (theme) => {
		const epoch = getEpoch();
		if (!cached || cached.theme !== theme || cached.epoch !== epoch) {
			cached = { theme, epoch, skin: { painter: createPainter(theme, getConfig()), epoch } };
		}
		return cached.skin;
	};
}
