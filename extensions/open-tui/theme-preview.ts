import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { OpenTuiConfig, SettingsLanguage } from "./config.ts";
import { createPainter, THEME_PRESETS, type SlotName, type ThemePreset } from "./theme.ts";

/** Preset names are proper nouns: they read the same in both settings languages. */
export const PRESET_LABELS: Record<ThemePreset, string> = {
	pi: "Pi",
	"tokyo-night": "Tokyo Night",
	"catppuccin-mocha": "Catppuccin Mocha",
	"gruvbox-dark": "Gruvbox Dark",
	"rose-pine-moon": "Rosé Pine Moon",
};

/**
 * The slots the swatch strip shows, in the order the eye meets them in a transcript: thinking, the
 * tool card, the user rail, the turn rule. The divider is last so it sits next to its own sample.
 */
const SWATCH_SLOTS: readonly SlotName[] = ["thinking", "toolCall", "toolOutput", "command", "divider"];

const SWATCH_BLOCK = "██";

const COPY = {
	en: {
		title: "Theme preview",
		hint: "←/→: preview · Enter: apply · Esc: back",
		body: "The quick brown fox jumps over the lazy dog.",
	},
	zh: {
		title: "主题预览",
		hint: "←/→：预览 · Enter：应用 · Esc：返回",
		body: "铜锣烧与羊羹，恰好的甜。",
	},
} as const satisfies Record<SettingsLanguage, unknown>;

/**
 * What the terminal should show *now*. It swaps the preset and drops the per-slot overrides, because
 * `resolveSlotColor` lets an override beat the preset: leaving them in place would preview the user's
 * patches instead of the preset they are choosing. Nothing is written and nothing is applied.
 */
export function previewConfig(config: OpenTuiConfig, preset: ThemePreset): OpenTuiConfig {
	return { ...config, theme: { ...config.theme, preset, slots: {} } };
}

/**
 * What Enter persists: the snapshot taken when the page opened, with only the preset replaced. Every
 * later-added switch (dividers, gutter, banding, userBar, timestamps) and the user's own slot
 * overrides therefore survive, and `pi` really is the full restore it claims to be.
 */
export function appliedConfig(config: OpenTuiConfig, preset: ThemePreset): OpenTuiConfig {
	return { ...config, theme: { ...config.theme, preset } };
}

/**
 * Everything the page does to the outside world. It holds no writer of its own: the settings page
 * persists through its normal `theme.*` path and the extension repaints through `repaint()`. That is
 * also why the page never touches `ctx.ui.setTheme` — that stops the theme watcher for the session.
 */
export interface ThemePreviewHooks {
	/** Show `config` immediately; must not write the file. */
	preview: (config: OpenTuiConfig) => void;
	/** Persist `config` and keep it. */
	apply: (config: OpenTuiConfig) => void;
	/** Put the capture-time configuration back on screen. */
	revert: (config: OpenTuiConfig) => void;
	/** The page is done; the host should leave the sub-page. */
	close: () => void;
}

/**
 * A carousel over the five open-tui presets. Pure enough to render without a TUI: it needs a theme
 * for painting and the configuration it was opened with, nothing else.
 */
export class ThemePreviewPage implements Component {
	private index: number;
	private readonly opened: OpenTuiConfig;
	private readonly theme: Theme;
	private readonly hooks: ThemePreviewHooks;
	private caches: string[] | undefined;
	private cachedWidth: number | undefined;
	/** A preview reached the screen: only then is there something to put back. */
	private previewed = false;
	/** Apply or revert already ran; every later key or dispose is a no-op. */
	private settled = false;

	constructor(theme: Theme, config: OpenTuiConfig, hooks: ThemePreviewHooks) {
		this.theme = theme;
		this.opened = structuredClone(config);
		this.hooks = hooks;
		this.index = Math.max(0, THEME_PRESETS.indexOf(config.theme.preset));
	}

	get selectedPreset(): ThemePreset {
		return THEME_PRESETS[this.index]!;
	}

	render(width: number): string[] {
		if (this.caches && this.cachedWidth === width) return this.caches;
		const copy = COPY[this.opened.settingsLanguage];
		const lines = [
			truncateToWidth(`  ${this.theme.bold(this.theme.fg("accent", copy.title))}`, width, ""),
			truncateToWidth(`  ${this.theme.fg("dim", copy.hint)}`, width, ""),
		];
		THEME_PRESETS.forEach((preset, index) => {
			lines.push(...this.presetLines(preset, index === this.index, width));
		});
		this.caches = lines;
		this.cachedWidth = width;
		return lines;
	}

	handleInput(data: string): void {
		// A settled page is inert: the overlay can still deliver a key while it tears down.
		if (this.settled) return;
		if (matchesKey(data, Key.left)) {
			this.step(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.step(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.settle("apply");
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) this.settle("revert");
	}

	invalidate(): void {
		this.caches = undefined;
		this.cachedWidth = undefined;
	}

	/**
	 * Reverts unless the page already settled. `session_shutdown` calls this while the overlay is
	 * being torn down, and the host may dispose again afterwards, so it must be idempotent.
	 */
	dispose(): void {
		this.settle("revert");
	}

	private step(delta: number): void {
		this.index = (this.index + delta + THEME_PRESETS.length) % THEME_PRESETS.length;
		this.previewed = true;
		this.invalidate();
		this.hooks.preview(previewConfig(this.opened, this.selectedPreset));
	}

	private settle(kind: "apply" | "revert"): void {
		if (this.settled) return;
		this.settled = true;
		if (kind === "apply") {
			this.hooks.apply(appliedConfig(this.opened, this.selectedPreset));
		} else if (this.previewed) {
			// Nothing was previewed, so there is nothing on screen to restore; repainting the whole
			// transcript to recover colours that already match would be pure cost.
			this.hooks.revert(this.opened);
		}
		this.hooks.close();
	}

	private presetLines(preset: ThemePreset, selected: boolean, width: number): string[] {
		// Painted with the preset's own colours (overrides cleared), so the swatch shows what picking
		// this preset would actually put on screen. `pi` carries no slot colours at all — it resolves to
		// Pi's own tokens — so its swatch is deliberately uncoloured rather than faked.
		const painter = createPainter(this.theme, previewConfig(this.opened, preset).theme);
		const strip = SWATCH_SLOTS.map((slot) => `${painter.paint(slot, SWATCH_BLOCK)} `).join("").trimEnd();
		const marker = selected ? "  → " : "    ";
		const copy = COPY[this.opened.settingsLanguage];
		// The divider sample is a colour probe, not a style preview: it is always the same glyph so the
		// five rows can be compared, and `theme.dividers` keeps its own row on the Appearance page.
		const divider = "─".repeat(Math.max(0, Math.min(width - 4, 32)));
		return [
			truncateToWidth(`${marker}${strip}  ${PRESET_LABELS[preset]}`, width, ""),
			truncateToWidth(`    ${painter.paint("toolOutput", copy.body)}`, width, ""),
			truncateToWidth(`    ${painter.paint("divider", divider)}`, width, ""),
		];
	}
}
