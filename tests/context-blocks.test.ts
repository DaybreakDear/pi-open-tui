import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	contextBlocksPath,
	readContextBlocks,
	watchContextBlocks,
	type ContextBlocksSnapshot,
} from "../extensions/open-tui/context-blocks.ts";
import { temporaryDirectory } from "./fixtures/test-helpers.ts";

const BLOCKS = [
	{ blockId: "b1", tier: 1, topic: "repo recon", summary: "s1", compressedTokens: 51_400, survivedCount: 6, active: false, generation: 1 },
	{ blockId: "b2", tier: 1, topic: "theme work", summary: "s2", compressedTokens: 8_200, survivedCount: 2, active: true, generation: 2 },
	{ blockId: "b3", tier: 3, topic: "old tier", summary: "s3", compressedTokens: 1_000, survivedCount: 0, active: false, generation: 1 },
];

function sidecar(schemaVersion: number, blocks: unknown[] = BLOCKS): unknown {
	return { schemaVersion, producer: "billion-context-pi", blocks };
}

/** Writes `<sessionFile>.acp.json` and returns the session file path. */
function sessionWithSidecar(t: TestContext, payload: unknown): { dir: string; sessionFile: string } {
	const dir = temporaryDirectory(t, "open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", "utf8");
	writeFileSync(contextBlocksPath(sessionFile)!, JSON.stringify(payload), "utf8");
	return { dir, sessionFile };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, message);
		await delay(10);
	}
}

test("parses blocks and sums compressed tokens", (t) => {
	const { sessionFile } = sessionWithSidecar(t, sidecar(1));
	const snapshot = readContextBlocks(sessionFile);

	assert.ok(snapshot, "a schemaVersion 1 sidecar must parse");
	assert.equal(snapshot.producer, "billion-context-pi");
	assert.equal(snapshot.blockCount, 3);
	assert.equal(snapshot.blocks.length, 3);
	assert.equal(snapshot.compressedTokens, 51_400 + 8_200 + 1_000);
	assert.deepEqual(snapshot.tiers, { 1: 2, 2: 0, 3: 1 });
	assert.equal(snapshot.blocks[1]!.topic, "theme work");
});

test("schemaVersion mismatch yields undefined", (t) => {
	const warnings: string[] = [];
	const emitWarning = process.emitWarning;
	process.emitWarning = ((warning: string | Error) => {
		warnings.push(String(warning));
	}) as typeof process.emitWarning;
	try {
		const { sessionFile } = sessionWithSidecar(t, sidecar(2));
		// Two reads: the warning is per process, not per read.
		assert.equal(readContextBlocks(sessionFile), undefined);
		assert.equal(readContextBlocks(sessionFile), undefined);
	} finally {
		process.emitWarning = emitWarning;
	}
	assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
	assert.match(warnings[0]!, /schemaVersion/i);
});

test("malformed json keeps previous snapshot", async (t) => {
	const { sessionFile } = sessionWithSidecar(t, sidecar(1));
	const updates: (ContextBlocksSnapshot | undefined)[] = [];
	const stop = watchContextBlocks(() => sessionFile, (snapshot) => updates.push(snapshot), 25);
	t.after(stop);

	await waitFor(() => updates.length >= 1, "watch callback must deliver the initial read");
	const first = updates.at(-1);
	assert.ok(first, "initial read must be a snapshot");
	const before = updates.length;

	// A half-written or corrupt sidecar must not blank the footer: the watch
	// callback keeps handing back the last good snapshot.
	const path = contextBlocksPath(sessionFile)!;
	writeFileSync(path, "{ this is not json", "utf8");
	const bumped = new Date(Date.now() + 60_000);
	utimesSync(path, bumped, bumped);

	await waitFor(() => updates.length > before, "watch callback must fire after the corrupt rewrite");
	assert.equal(updates.at(-1), first, "the last good snapshot must survive a parse failure");
	assert.equal(updates.at(-1)!.blockCount, 3);
});

test("mtime cache avoids re-parse", (t) => {
	const { sessionFile } = sessionWithSidecar(t, sidecar(1));
	const first = readContextBlocks(sessionFile);
	const second = readContextBlocks(sessionFile);
	assert.ok(first);
	assert.equal(second, first, "an unchanged mtime must return the cached snapshot");
});

test("missing session file is not an error", (t) => {
	assert.equal(readContextBlocks(undefined), undefined);

	const dir = temporaryDirectory(t, "open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "{}\n", "utf8");
	assert.equal(readContextBlocks(sessionFile), undefined, "no sidecar next to the session file");
});

test("stop() tears the watcher down", async (t) => {
	const { sessionFile } = sessionWithSidecar(t, sidecar(1));
	const updates: (ContextBlocksSnapshot | undefined)[] = [];
	const stop = watchContextBlocks(() => sessionFile, (snapshot) => updates.push(snapshot), 25);
	await waitFor(() => updates.length >= 1, "initial read");
	stop();
	const settled = updates.length;

	const path = contextBlocksPath(sessionFile)!;
	writeFileSync(path, JSON.stringify(sidecar(1, BLOCKS.slice(0, 1))), "utf8");
	const bumped = new Date(Date.now() + 60_000);
	utimesSync(path, bumped, bumped);
	await delay(150);
	assert.equal(updates.length, settled, "a stopped watcher must not deliver updates");
});
