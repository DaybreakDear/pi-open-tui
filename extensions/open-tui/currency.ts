export type CurrencyCode = "usd" | "cny";

export interface CostConfig {
	currency: CurrencyCode;
	/** Manual fixed rate: 1 USD = `usdToCny` CNY. Only used when `currency` is "cny". */
	usdToCny: number;
	/** When true, `ctrl+shift+m` may flip the currency and persist the result. */
	switchable: boolean;
}

export const DEFAULT_COST: CostConfig = {
	currency: "usd",
	usdToCny: 7.15,
	switchable: true,
};

/**
 * Supported manual-rate window. A finite product is not enough: `toFixed` switches to exponential
 * form at 1e21, so `usdToCny: 1e300` used to render as `¥6.3e+297`.
 */
export const MIN_USD_TO_CNY = 0.01;
export const MAX_USD_TO_CNY = 1000;

/**
 * Invalid or out-of-window rates are typos, not data: fall back to the shipped default so a broken
 * `open-tui.json` never inflates or deflates the footer.
 */
export function clampUsdToCny(rate: unknown): number {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return DEFAULT_COST.usdToCny;
	if (rate < MIN_USD_TO_CNY || rate > MAX_USD_TO_CNY) return DEFAULT_COST.usdToCny;
	return rate;
}

/**
 * Fixed rate ladder for the settings row: the settings list only offers items, not inputs. Hand-edited
 * rates snap to the next rung up, so the ladder lives next to the rate validation.
 */
export const RATE_STEPS = [6.8, 7.0, 7.15, 7.3, 7.5] as const;

const SYMBOLS: Record<CurrencyCode, string> = { usd: "$", cny: "¥" };

export function currencySymbol(code: CurrencyCode): string {
	// The config is hand-editable, so an unknown code falls back to the dollar sign.
	return SYMBOLS[code] ?? SYMBOLS.usd;
}

/**
 * Convert a USD amount into the configured currency. An out-of-window rate falls back to the shipped
 * default through `clampUsdToCny`, the same fallback the settings ladder uses.
 */
export function convertUsd(usd: number, cfg: CostConfig): number {
	const amount = Number.isFinite(usd) ? usd : 0;
	if (cfg.currency !== "cny") return amount;
	return amount * clampUsdToCny(cfg.usdToCny);
}

/** Absolute amounts below 0.1 keep three decimals so small costs stay readable. */
function formatAmount(value: number, cfg: CostConfig): string {
	// Negative provider figures are reachable; rendering them puts the symbol before the minus sign.
	const converted = Math.max(0, convertUsd(value, cfg));
	const digits = converted < 0.1 ? 3 : 2;
	return `${currencySymbol(cfg.currency)}${converted.toFixed(digits)}`;
}

export function formatCost(usd: number, cfg: CostConfig): string {
	return formatAmount(usd, cfg);
}

export function formatRate(usdPerMTokens: number | null, cfg: CostConfig): string | null {
	if (usdPerMTokens === null || !Number.isFinite(usdPerMTokens)) return null;
	return `${formatAmount(usdPerMTokens, cfg)}/M`;
}
