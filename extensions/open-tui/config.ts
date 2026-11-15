import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CostConfig } from "./currency.ts";
import { clampUsdToCny, DEFAULT_COST } from "./currency.ts";
import type { IconMode } from "./icons.ts";
import { DIVIDER_STYLES, EXPAND_HINTS, SLOT_NAMES, THEME_PRESETS, type ExpandHint, type SlotName, type SlotValue, type ThemeConfig } from "./theme.ts";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";
export type ThinkingPeekLines = 0 | 1 | 2;
export type ToolViewMode = "native" | "compact";

export type { IconMode } from "./icons.ts";

export interface FooterSegments {
	cwd: boolean;
	hostname: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
	context: boolean;
	/** Context progress bar and its icon; off keeps the percentage and token usage. */
	contextBar: boolean;
	/** billion-context compression blocks (read-only sidecar). */
	contextBlocks: boolean;
	tokens: boolean;
	cost: boolean;
	liveTps: boolean;
	extensionSegments: boolean;
	extensionStatuses: boolean;
	capitalizeProviderName: boolean;
	nerdIconSpacing: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface ThinkingPeekConfig {
	lines: ThinkingPeekLines;
	/** Append `12.3s · 1.2k tok` to the thinking header; false restores the v0.4.6 label. */
	showCounts: boolean;
}

export interface ContextBlocksConfig {
	/** Read the billion-context sidecar and show it in the footer and the overlay. */
	enabled: boolean;
	/** Footer segment on/off; the overlay stays reachable from its shortcut either way. */
	footerSegment: boolean;
	/** `fs.watchFile` poll interval in milliseconds. */
	pollMs: number;
}

export interface ToolViewConfig {
	mode: ToolViewMode;
	/** In compact mode, also collapse tools that are not Pi's own built-ins. */
	extensionTools: boolean;
	/** Tool names that always keep their native rendering. */
	exclude: string[];
}

export interface OpenTuiConfig {
	enabled: boolean;
	/** Override Pi's header with the open-tui header. When false, the header slot is left to Pi or another extension. */
	header: boolean;
	inlineFooter: boolean;
	/** Clickable `Copy` labels on code blocks, user messages, and nonempty editor drafts (fullscreen mode only). */
	copyButtons: boolean;
	settingsLanguage: SettingsLanguage;
	cursorStyle: CursorStyle;
	icons: {
		mode: IconMode;
	};
	footerSegments: FooterSegments;
	telemetry: TelemetryConfig;
	thinkingPeek: ThinkingPeekConfig;
	toolView: ToolViewConfig;
	/** Currency and the manual USD→CNY rate used by the footer and telemetry. */
	cost: CostConfig;
	/** open-tui's own colours (slots) and the structural options built on them. */
	theme: ThemeConfig;
	/** billion-context sidecar (read-only) blocks: footer segment and overlay. */
	contextBlocks: ContextBlocksConfig;
}

/** The shipped expand-hint mode; `"plain"` keeps the v0.4.6 rendering. */
const DEFAULT_EXPAND_HINT: ExpandHint = "plain";

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	header: true,
	inlineFooter: false,
	copyButtons: true,
	settingsLanguage: "en",
	cursorStyle: "block",
	icons: {
		mode: "auto",
	},
	footerSegments: {
		cwd: true,
		hostname: false,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,
		runtime: true,
		context: true,
		contextBar: true,
		contextBlocks: true,
		tokens: true,
		cost: true,
		liveTps: true,
		extensionSegments: true,
		extensionStatuses: true,
		capitalizeProviderName: true,
		nerdIconSpacing: false,
	},
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
	thinkingPeek: {
		lines: 1,
		showCounts: true,
	},
	toolView: {
		mode: "native",
		extensionTools: false,
		exclude: [],
	},
	contextBlocks: {
		enabled: true,
		footerSegment: true,
		pollMs: 1500,
	},
	cost: DEFAULT_COST,
	theme: {
		preset: "tokyo-night",
		slots: {},
		dividers: "line",
		gutter: true,
		banding: false,
		userBar: true,
		expandHint: DEFAULT_EXPAND_HINT,
	},
};

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function normalizeThinkingPeekLines(value: unknown): ThinkingPeekLines {
	return value === 0 || value === 1 || value === 2 ? value : DEFAULT_CONFIG.thinkingPeek.lines;
}

function normalizeToolView(value: unknown): ToolViewConfig {
	const source = typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Partial<Record<keyof ToolViewConfig, unknown>>)
		: {};
	return {
		mode: source.mode === "compact" ? "compact" : DEFAULT_CONFIG.toolView.mode,
		extensionTools: source.extensionTools === true,
		exclude: Array.isArray(source.exclude) ? source.exclude.filter((name): name is string => typeof name === "string") : [],
	};
}

const ICON_MODES: IconMode[] = ["auto", "nerd", "unicode", "ascii"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unknown keys survive so a newer config keeps its settings, while an invalid preset falls back to
 * the shipped default and every other field falls back individually.
 */
function normalizeTheme(value: unknown): ThemeConfig {
	const source = isRecord(value) ? value : {};
	const preset = THEME_PRESETS.includes(source.preset as ThemeConfig["preset"])
		? (source.preset as ThemeConfig["preset"])
		: DEFAULT_CONFIG.theme.preset;
	const dividers = DIVIDER_STYLES.includes(source.dividers as ThemeConfig["dividers"])
		? (source.dividers as ThemeConfig["dividers"])
		: DEFAULT_CONFIG.theme.dividers;
	const expandHint = EXPAND_HINTS.includes(source.expandHint as ExpandHint)
		? (source.expandHint as ExpandHint)
		: DEFAULT_EXPAND_HINT;
	const slots: Partial<Record<SlotName, SlotValue>> = {};
	if (isRecord(source.slots)) {
		for (const slot of SLOT_NAMES) {
			const slotValue = source.slots[slot];
			if (typeof slotValue === "string" && slotValue.trim().length > 0) slots[slot] = slotValue.trim();
		}
	}
	return {
		...source,
		preset,
		dividers,
		slots,
		gutter: typeof source.gutter === "boolean" ? source.gutter : DEFAULT_CONFIG.theme.gutter,
		banding: typeof source.banding === "boolean" ? source.banding : DEFAULT_CONFIG.theme.banding,
		userBar: typeof source.userBar === "boolean" ? source.userBar : DEFAULT_CONFIG.theme.userBar,
		expandHint,
	};
}

/** Invalid currency, rate, or switch flag fall back field by field; unknown sibling keys survive. */
function normalizeCost(value: unknown): CostConfig {
	const source = isRecord(value) ? value : {};
	const currency = source.currency === "usd" || source.currency === "cny"
		? source.currency
		: DEFAULT_COST.currency;
	const usdToCny = clampUsdToCny(source.usdToCny);
	const switchable = typeof source.switchable === "boolean" ? source.switchable : DEFAULT_COST.switchable;
	return { ...source, currency, usdToCny, switchable };
}

const MIN_CONTEXT_BLOCKS_POLL_MS = 250;
const MAX_CONTEXT_BLOCKS_POLL_MS = 60_000;

/** Invalid flags and poll intervals fall back field by field; unknown sibling keys survive. */
function normalizeContextBlocks(value: unknown): ContextBlocksConfig {
	const source = isRecord(value) ? value : {};
	const pollMs = typeof source.pollMs === "number" && Number.isFinite(source.pollMs)
		? Math.min(MAX_CONTEXT_BLOCKS_POLL_MS, Math.max(MIN_CONTEXT_BLOCKS_POLL_MS, Math.round(source.pollMs)))
		: DEFAULT_CONFIG.contextBlocks.pollMs;
	return {
		...source,
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.contextBlocks.enabled,
		footerSegment: typeof source.footerSegment === "boolean" ? source.footerSegment : DEFAULT_CONFIG.contextBlocks.footerSegment,
		pollMs,
	};
}

// Non-boolean flags (e.g. "false" strings) fall back to defaults instead of reading as truthy.
function normalizeFlags<T extends object>(value: unknown, defaults: T): T {
	const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	const result: Record<string, unknown> = { ...source };
	for (const [key, fallback] of Object.entries(defaults)) {
		if (typeof result[key] !== "boolean") result[key] = fallback;
	}
	return result as T;
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)
			&& typeof overVal === "object" && overVal !== null && !Array.isArray(overVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}

	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const config = deepMerge(DEFAULT_CONFIG, parsed);
		if (typeof config.enabled !== "boolean") {
			config.enabled = DEFAULT_CONFIG.enabled;
		}
		if (typeof config.header !== "boolean") {
			config.header = DEFAULT_CONFIG.header;
		}
		if (typeof config.inlineFooter !== "boolean") {
			config.inlineFooter = DEFAULT_CONFIG.inlineFooter;
		}
		if (typeof config.copyButtons !== "boolean") {
			config.copyButtons = DEFAULT_CONFIG.copyButtons;
		}
		config.footerSegments = normalizeFlags(config.footerSegments, DEFAULT_CONFIG.footerSegments);
		config.telemetry = normalizeFlags(config.telemetry, DEFAULT_CONFIG.telemetry);
		if (typeof config.icons !== "object" || config.icons === null || !ICON_MODES.includes(config.icons.mode)) {
			config.icons = structuredClone(DEFAULT_CONFIG.icons);
		}
		if (config.settingsLanguage !== "en" && config.settingsLanguage !== "zh") {
			config.settingsLanguage = DEFAULT_CONFIG.settingsLanguage;
		}
		if (config.cursorStyle !== "block" && config.cursorStyle !== "bar" && config.cursorStyle !== "underline") {
			config.cursorStyle = DEFAULT_CONFIG.cursorStyle;
		}
		if (typeof config.thinkingPeek !== "object" || config.thinkingPeek === null || Array.isArray(config.thinkingPeek)) {
			config.thinkingPeek = structuredClone(DEFAULT_CONFIG.thinkingPeek);
		} else {
			config.thinkingPeek.lines = normalizeThinkingPeekLines(config.thinkingPeek.lines);
			if (typeof config.thinkingPeek.showCounts !== "boolean") {
				config.thinkingPeek.showCounts = DEFAULT_CONFIG.thinkingPeek.showCounts;
			}
		}
		config.toolView = normalizeToolView(config.toolView);
		config.cost = normalizeCost(config.cost);
		config.theme = normalizeTheme(config.theme);
		config.contextBlocks = normalizeContextBlocks(config.contextBlocks);
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): boolean {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}
