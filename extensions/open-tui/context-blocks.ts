import { readFileSync, statSync, unwatchFile, watchFile, type Stats } from "node:fs";

/**
 * Read-only view on the billion-context sidecar that sits next to the session
 * file (`<sessionFile>.acp.json`).
 *
 * The block shape is mirrored locally on purpose: open-tui must not depend on
 * `billion-context-pi`, and this module never writes the sidecar.
 */
export const CONTEXT_BLOCKS_SCHEMA_VERSION = 1;
export const CONTEXT_BLOCKS_SUFFIX = ".acp.json";
const DEFAULT_POLL_MS = 1500;

/** The subset of a billion-context block that the footer and the overlay use. */
export interface BcpBlockLike {
	blockId: string;
	tier: 1 | 2 | 3;
	topic: string;
	summary: string;
	compressedTokens: number;
	survivedCount: number;
	active: boolean;
	generation: number;
}

export interface ContextBlocksSnapshot {
	producer: string;
	blocks: readonly BcpBlockLike[];
	/** Σ blocks[].compressedTokens */
	compressedTokens: number;
	blockCount: number;
	tiers: Record<1 | 2 | 3, number>;
}

// A future producer may bump the schema; degrade silently, warn once per process.
let schemaWarningEmitted = false;

// The sidecar can grow to hundreds of KiB: cache by (path, mtimeMs) so a footer
// repaint never re-parses it.
let cachedPath: string | undefined;
let cachedMtimeMs: number | undefined;
let cachedSnapshot: ContextBlocksSnapshot | undefined;

export function contextBlocksPath(sessionFile: string | undefined): string | undefined {
	return sessionFile ? `${sessionFile}${CONTEXT_BLOCKS_SUFFIX}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toTier(value: unknown): 1 | 2 | 3 {
	return value === 2 || value === 3 ? value : 1;
}

function toBlock(value: unknown): BcpBlockLike | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.blockId === "string" && value.blockId.length > 0
		? value.blockId
		: undefined;
	if (!id) return undefined;
	return {
		blockId: id,
		tier: toTier(value.tier),
		topic: typeof value.topic === "string" ? value.topic : "",
		summary: typeof value.summary === "string" ? value.summary : "",
		compressedTokens: Math.max(0, toNumber(value.compressedTokens, 0)),
		survivedCount: Math.max(0, toNumber(value.survivedCount, 0)),
		active: value.active === true,
		generation: toNumber(value.generation, 0),
	};
}

/** The host's notify channel: `process.emitWarning` writes to stderr, which a
 * full-screen TUI repaint throws away. */
export type ContextBlocksWarn = (message: string) => void;

function toSnapshot(value: unknown, warn?: ContextBlocksWarn): ContextBlocksSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== CONTEXT_BLOCKS_SCHEMA_VERSION) {
		// Warn once per process, and only when someone is listening.
		if (!schemaWarningEmitted && warn) {
			schemaWarningEmitted = true;
			warn(
				`open-tui: ignoring context blocks sidecar with schemaVersion ${String(value.schemaVersion)} `
				+ `(expected ${CONTEXT_BLOCKS_SCHEMA_VERSION})`,
			);
		}
		return undefined;
	}
	const blocks = (Array.isArray(value.blocks) ? value.blocks : [])
		.map(toBlock)
		.filter((block): block is BcpBlockLike => block !== undefined);
	const tiers: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
	let compressedTokens = 0;
	for (const block of blocks) {
		tiers[block.tier] += 1;
		compressedTokens += block.compressedTokens;
	}
	return {
		producer: typeof value.producer === "string" && value.producer.length > 0 ? value.producer : "unknown",
		blocks,
		compressedTokens,
		blockCount: blocks.length,
		tiers,
	};
}

function cacheSnapshot(path: string, mtimeMs: number, snapshot: ContextBlocksSnapshot | undefined): void {
	cachedPath = path;
	cachedMtimeMs = mtimeMs;
	cachedSnapshot = snapshot;
}

/** `undefined` means "no sidecar for this session" — never an error. */
export function readContextBlocks(
	sessionFile: string | undefined,
	warn?: ContextBlocksWarn,
): ContextBlocksSnapshot | undefined {
	const path = contextBlocksPath(sessionFile);
	if (!path) {
		cacheSnapshot("", Number.NaN, undefined);
		return undefined;
	}
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		// No sidecar (or an unreadable one): drop the cache so a later write is re-read.
		cacheSnapshot("", Number.NaN, undefined);
		return undefined;
	}
	if (path === cachedPath && mtimeMs === cachedMtimeMs) return cachedSnapshot;
	const previous = path === cachedPath ? cachedSnapshot : undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A half-written or corrupt sidecar must not blank the footer: keep the
		// last good snapshot for this path until a valid file lands.
		cacheSnapshot(path, mtimeMs, previous);
		return previous;
	}
	const snapshot = toSnapshot(parsed, warn);
	cacheSnapshot(path, mtimeMs, snapshot);
	return snapshot;
}

/**
 * Poll the sidecar and hand every change to `onChange`. Returns the teardown
 * that calls `fs.unwatchFile`; callers must invoke it on shutdown so no watcher
 * outlives its session.
 */
/** `fs.watchFile` would otherwise poll at NaN or Infinity and never fire. */
function pollInterval(pollMs: number): number {
	return Number.isFinite(pollMs) && pollMs >= 1 ? Math.floor(pollMs) : DEFAULT_POLL_MS;
}

/**
 * Poll the sidecar and hand every change to `onChange`. Returns the teardown
 * that calls `fs.unwatchFile`; callers must invoke it on shutdown so no watcher
 * outlives its session.
 */
export function watchContextBlocks(
	getSessionFile: () => string | undefined,
	onChange: (snapshot?: ContextBlocksSnapshot) => void,
	pollMs = DEFAULT_POLL_MS,
	warn?: ContextBlocksWarn,
): () => void {
	let stopped = false;
	const path = contextBlocksPath(getSessionFile());
	const listener = (current: Stats, previous: Stats): void => {
		if (stopped || current.mtimeMs === previous.mtimeMs) return;
		onChange(readContextBlocks(getSessionFile(), warn));
	};
	if (path) watchFile(path, { interval: pollInterval(pollMs) }, listener);
	onChange(readContextBlocks(getSessionFile(), warn));
	return () => {
		if (stopped) return;
		stopped = true;
		if (path) unwatchFile(path, listener);
		cacheSnapshot("", Number.NaN, undefined);
	};
}
