/**
 * Types for scripts/patch-cost-display.mjs. The tool ships as plain `.mjs` because it runs under
 * `node` against a third-party install, outside this package's build; `npm run typecheck` still
 * covers the test file that imports it, so the exported surface is declared here by hand.
 */

export type CostConfigShape = { currency: string; usdToCny: number };

export interface CostSite {
	/** 1-based line of the match inside the file it was found in. */
	line: number;
	/** The matched source text, e.g. `$${u.cost.toFixed(4)}`. */
	text: string;
	/** The member path inside the template literal, e.g. `u.cost`. */
	expression: string;
}

export interface PatchResult {
	code: string;
	changed: boolean;
	reason: string;
}

export const PATCH_MARKER: string;
export const COST_DEFAULTS: CostConfigShape;
export const MIN_RATE: number;
export const MAX_RATE: number;
export const SITE_SOURCE: string;
export const PURE_FORMATTER_SRC: string;
export const CONFIG_READER_SRC: string;
export const PACKAGE_NAMES: string[];

export function sitePattern(): RegExp;
export function findRemainingSites(source: string): CostSite[];
export function patchSource(source: string): PatchResult;
export function main(argv: string[]): number;
