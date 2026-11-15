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

const SYMBOLS: Record<CurrencyCode, string> = { usd: "$", cny: "¥" };

export function currencySymbol(code: CurrencyCode): string {
	return SYMBOLS[code] ?? SYMBOLS.usd;
}

/**
 * Convert a USD amount into the configured currency. Invalid or non-positive
 * rates fall back to 1 so a typo in `open-tui.json` never inflates the footer.
 */
export function convertUsd(usd: number, cfg: CostConfig): number {
	const amount = Number.isFinite(usd) ? usd : 0;
	if (cfg.currency !== "cny") return amount;
	const rate = cfg.usdToCny;
	if (!Number.isFinite(rate) || rate <= 0) return amount;
	return amount * rate;
}

/** Absolute amounts below 0.1 keep three decimals so small costs stay readable. */
function formatAmount(value: number, cfg: CostConfig): string {
	const converted = convertUsd(value, cfg);
	const digits = Math.abs(converted) < 0.1 ? 3 : 2;
	return `${currencySymbol(cfg.currency)}${converted.toFixed(digits)}`;
}

export function formatCost(usd: number, cfg: CostConfig): string {
	return formatAmount(usd, cfg);
}

export function formatRate(usdPerMTokens: number | null, cfg: CostConfig): string | null {
	if (usdPerMTokens === null || !Number.isFinite(usdPerMTokens)) return null;
	return `${formatAmount(usdPerMTokens, cfg)}/M`;
}
