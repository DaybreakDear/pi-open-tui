import assert from "node:assert/strict";
import fs, { readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { readContextBlocks } from "../extensions/open-tui/context-blocks.ts";
import { ContextBlocksOverlay } from "../extensions/open-tui/context-blocks-overlay.ts";
import openTui from "../extensions/open-tui/index.ts";
import { stripAnsi } from "../extensions/open-tui/utils.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const SIDECAR = {
	schemaVersion: 1,
	producer: "billion-context-pi",
	blocks: [
		{
			blockId: "b1",
			tier: 1,
			topic: "Compress the transcript",
			summary: "The transcript was folded into a summary of the earlier turns.",
			compressedTokens: 2500,
			survivedCount: 3,
			active: false,
			generation: 1,
		},
		{
			blockId: "b2",
			tier: 2,
			topic: "Distill the summaries",
			summary: "Two tier-one summaries were merged into one.",
			compressedTokens: 900,
			survivedCount: 2,
			active: false,
			generation: 1,
		},
	],
};

function fakeTui(columns = 80, rows = 24): TUI & { renders: number } {
	const tui = {
		renders: 0,
		terminal: { columns, rows },
		requestRender: () => {
			tui.renders += 1;
		},
	};
	return tui as unknown as TUI & { renders: number };
}

function writeSidecar(sessionFile: string, value: unknown = SIDECAR): string {
	const path = `${sessionFile}.acp.json`;
	writeFileSync(path, JSON.stringify(value), "utf8");
	return path;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, message);
		await delay(10);
	}
}

function renderText(lines: readonly string[]): string {
	return lines.map(stripAnsi).join("\n");
}

/** A fake extension host: no real terminal, no real session, but the real handlers. */
function runtimeHost(t: TestContext, sessionFile: string | undefined, raw: Partial<typeof DEFAULT_CONFIG> = {}) {
	const agentDir = temporaryDirectory(t, "pi-open-tui-context-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// A session can learn its file late (in-memory startup), so the host can change it.
	let currentSessionFile = sessionFile;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), ...raw }));

	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const shortcuts = new Map<string, { description?: string; handler: (ctx: ExtensionContext) => void }>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const dispatched: string[] = [];
	const notifications: string[] = [];
	let footerFactory: ((tui: TUI, theme: Theme, footerData: unknown) => unknown) | undefined;
	let customOptions: { overlay?: boolean } | undefined;
	let customFactory: ((tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: unknown) => void) => unknown) | undefined;
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: createEventBus(),
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			commands.set(name, options);
		},
		registerShortcut: (key: string, options: { description?: string; handler: (ctx: ExtensionContext) => void }) => {
			shortcuts.set(key, options);
		},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		// Any of these would mean the overlay reached into Pi instead of reading a file.
		sendMessage: (message: unknown) => dispatched.push(JSON.stringify(message)),
		sendUserMessage: (message: unknown) => dispatched.push(JSON.stringify(message)),
		runCommand: (name: string) => dispatched.push(name),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		// The footer also paints the context bar; a zero window keeps it out of the way.
		getContextUsage: () => undefined,
		model: undefined,
		sessionManager: {
			getSessionFile: () => currentSessionFile,
			getLeafId: () => "leaf-1",
			getEntries: () => [],
			getCwd: () => process.cwd(),
			getSessionName: () => "test session",
		},
		ui: {
			setFooter: (factory: NonNullable<typeof footerFactory>) => {
				footerFactory = factory;
			},
			setHeader() {},
			getEditorComponent: () => undefined,
			setEditorComponent() {},
			notify: (message: string) => notifications.push(message),
			custom: (factory: NonNullable<typeof customFactory>, options: { overlay?: boolean }) => {
				customFactory = factory;
				customOptions = options;
				return Promise.resolve(undefined);
			},
			requestRender() {},
		},
	} as unknown as ExtensionContext;
	openTui(pi);
	const host = {
		pi,
		ctx,
		commands,
		shortcuts,
		dispatched,
		notifications,
		customOptions: () => customOptions,
		customFactory: () => customFactory,
		footerFactory: () => footerFactory,
		setSessionFile: (next: string | undefined) => {
			currentSessionFile = next;
		},
		/** Fire a Pi event through the handlers the extension registered. */
		emit: async (event: string, payload: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "startup" }, ctx);
			}
		},
		shutdown: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown", reason: "quit" }, ctx);
			}
		},
	};
	// Every host owns a StatWatcher; leaving one behind would hang the test process.
	t.after(async () => {
		await host.shutdown();
	});
	return host;
}

const originalWatchFile = fs.watchFile;
const originalUnwatchFile = fs.unwatchFile;

/** Record the real `fs.watchFile` / `fs.unwatchFile` calls the watcher makes. */
function spyFileWatchers(t: TestContext): string[] {
	const calls: string[] = [];
	fs.watchFile = ((path: fs.PathLike, ...rest: unknown[]) => {
		calls.push(`watch ${String(path)}`);
		return (originalWatchFile as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof fs.watchFile;
	fs.unwatchFile = ((path: fs.PathLike, ...rest: unknown[]) => {
		calls.push(`unwatch ${String(path)}`);
		return (originalUnwatchFile as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof fs.unwatchFile;
	syncBuiltinESMExports();
	t.after(() => {
		fs.watchFile = originalWatchFile;
		fs.unwatchFile = originalUnwatchFile;
		syncBuiltinESMExports();
	});
	return calls;
}

function statWatchers(): number {
	return process.getActiveResourcesInfo().filter((name) => name === "StatWatcher").length;
}

function renderFooter(
	factory: (tui: TUI, theme: Theme, footerData: unknown) => unknown,
	tui: TUI,
	width = 120,
): string {
	const component = factory(tui, theme, {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => [],
	}) as { render: (width: number) => string[]; dispose?: () => void };
	try {
		return renderText(component.render(width));
	} finally {
		component.dispose?.();
	}
}

test("the blocks overlay renders the sidecar blocks", (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const tui = fakeTui();
	const overlay = new ContextBlocksOverlay(tui, theme, () => readContextBlocks(sessionFile), () => {});
	const text = renderText(overlay.render(80));
	assert.match(text, /Context Compression/);
	assert.match(text, /2 blocks · 3\.4k compressed · t1×1 t2×1 t3×0/);
	assert.match(text, /b1/);
	assert.match(text, /Compress the transcript/);
	// The summaries stay folded until the operator asks for them.
	assert.doesNotMatch(text, /folded into a summary/);
});

test("the blocks overlay expands a summary on enter and collapses it again", (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const overlay = new ContextBlocksOverlay(fakeTui(), theme, () => readContextBlocks(sessionFile), () => {});
	overlay.render(80);
	overlay.handleInput("\r");
	assert.match(renderText(overlay.render(80)), /folded into a summary/);
	overlay.handleInput("\r");
	assert.doesNotMatch(renderText(overlay.render(80)), /folded into a summary/);
});

test("the blocks overlay only ever reads the sidecar", (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	const path = writeSidecar(sessionFile);
	const before = readFileSync(path, "utf8");
	const mtimeBefore = statSync(path).mtimeMs;
	let closed = false;
	const overlay = new ContextBlocksOverlay(fakeTui(), theme, () => readContextBlocks(sessionFile), () => {
		closed = true;
	});
	overlay.render(80);
	for (const key of ["\x1b[B", "\r", "r", "j", "k"]) overlay.handleInput(key);
	overlay.render(80);
	overlay.handleInput("\x1b");
	assert.equal(closed, true);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.equal(statSync(path).mtimeMs, mtimeBefore);
});

test("ctrl+shift+c and open-tui:context open the read-only overlay", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const host = runtimeHost(t, sessionFile);
	await host.start();

	const shortcut = host.shortcuts.get("ctrl+shift+c");
	assert.ok(shortcut, "ctrl+shift+c must be registered");
	assert.equal(shortcut.description, "Context compression blocks");
	shortcut.handler(host.ctx);
	const options = host.customOptions();
	assert.equal(options?.overlay, true);
	const factory = host.customFactory();
	assert.ok(factory, "the shortcut must open an overlay");
	const component = factory(fakeTui(), theme, {} as KeybindingsManager, () => {}) as { render: (width: number) => string[] };
	assert.match(renderText(component.render(80)), /Context Compression/);

	const command = host.commands.get("open-tui:context");
	assert.ok(command, "open-tui:context must be registered");
	assert.equal(command.description, "Show billion-context compression blocks (read-only)");
	await command.handler("", host.ctx);

	// Read-only means read-only: no Pi command or message was dispatched.
	assert.deepEqual(host.dispatched, []);
	assert.deepEqual(host.notifications, []);
});

test("the footer shows the blocks segment only while the sidecar exists", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	const host = runtimeHost(t, sessionFile, {
		icons: { ...DEFAULT_CONFIG.icons, mode: "ascii" },
		contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, pollMs: 250 },
	});
	await host.start();
	const factory = host.footerFactory();
	assert.ok(factory, "the footer must be installed");
	const tui = fakeTui(120, 40);

	// No sidecar → no segment and no stray divider.
	const without = renderFooter(factory, tui);
	assert.doesNotMatch(without, /# 2 · 3\.4k/);

	writeSidecar(sessionFile);
	// The SidecarWatcher polls at 250 ms: poll the render instead of racing a fixed sleep.
	await waitFor(() => /# 2 · 3.4k/.test(renderFooter(factory, tui)), "the watch must deliver the new sidecar");
	const withBlocks = renderFooter(factory, tui);
	assert.match(withBlocks, /# 2 · 3\.4k/);

	await host.shutdown();
});

test("session shutdown unwatches the sidecar", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const calls = spyFileWatchers(t);
	const sidecar = `${sessionFile}.acp.json`;
	const baseline = statWatchers();
	const host = runtimeHost(t, sessionFile, { contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, pollMs: 250 } });
	await host.start();
	assert.ok(calls.includes(`watch ${sidecar}`), "installing the UI must watch the sidecar once");
	assert.equal(statWatchers(), baseline + 1, "exactly one StatWatcher may be live");
	await host.shutdown();
	assert.ok(calls.includes(`unwatch ${sidecar}`), "session_shutdown must fs.unwatchFile the sidecar");
	assert.equal(statWatchers(), baseline, "no StatWatcher may outlive its session");
});

test("the blocks overlay keeps each divider on one row and inside the terminal", (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const dump = (lines: readonly string[]): string => lines.map(stripAnsi).join("\n");
	for (const width of [20, 40, 80, 120]) {
		for (const rows of [12, 24, 40]) {
			const overlay = new ContextBlocksOverlay(fakeTui(width, rows), theme, () => readContextBlocks(sessionFile), () => {});
			const lines = overlay.render(width);
			// A divider that overflows the child width wraps, leaving a stray "──" row.
			const dashes = lines
				.map((line) => stripAnsi(line).trim())
				.filter((line) => line.length > 0 && /^─+$/.test(line))
				.map((line) => line.length);
			assert.deepEqual(dashes, [width - 4, width - 4], `width ${width}: each divider must be one row of ${width - 4}\n${dump(lines)}`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: a line exceeds the terminal\n${dump(lines)}`);
			assert.ok(lines.length <= rows, `width ${width} × ${rows}: ${lines.length} rows overflow the terminal\n${dump(lines)}`);
		}
	}
	// The empty state is chrome-only and must fit the shortest terminal too.
	const empty = new ContextBlocksOverlay(fakeTui(80, 12), theme, () => undefined, () => {});
	assert.ok(empty.render(80).length <= 12, dump(empty.render(80)));
});

test("a click on a block row selects that block", (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	const names = ["ONE", "TWO", "THREE"];
	writeSidecar(sessionFile, {
		schemaVersion: 1,
		producer: "billion-context-pi",
		blocks: names.map((name, index) => ({
			blockId: `b${index + 1}`,
			tier: 1,
			topic: `topic ${index + 1}`,
			summary: `summary-marker-${name}`,
			compressedTokens: 100 * (index + 1),
			survivedCount: index,
			active: false,
			generation: 1,
		})),
	});
	const press = (y: number): TuiMouseEvent => ({
		type: "press", button: "left", x: 3, y, screenX: 3, screenY: y, width: 80, height: 24,
		shift: false, alt: false, ctrl: false,
	});

	for (const [index, name] of names.entries()) {
		const overlay = new ContextBlocksOverlay(fakeTui(), theme, () => readContextBlocks(sessionFile), () => {});
		const lines = overlay.render(80).map(stripAnsi);
		// A click selects; enter then expands whatever is selected, which makes the
		// selection observable without changing the click semantics.
		const row = lines.findIndex((line) => line.includes(`▸ b${index + 1}`));
		assert.ok(row > 0, `b${index + 1} must have a header row\n${lines.join("\n")}`);
		assert.equal(overlay.handleMouse(press(row))?.handled, true, `clicking b${index + 1}'s header must be handled`);
		overlay.handleInput("\r");
		const text = renderText(overlay.render(80));
		assert.match(text, new RegExp(`summary-marker-${name}`), `clicking b${index + 1} must select b${index + 1}\n${text}`);
		for (const other of names.filter((candidate) => candidate !== name)) {
			assert.doesNotMatch(text, new RegExp(`summary-marker-${other}`), `clicking b${index + 1} selected b${other} instead\n${text}`);
		}
	}

	// Chrome rows (top padding, title, header, dividers, hint, bottom padding) select nothing.
	const chrome = new ContextBlocksOverlay(fakeTui(), theme, () => readContextBlocks(sessionFile), () => {});
	const lines = chrome.render(80).map(stripAnsi);
	for (const y of [0, 1, 2, 3, lines.length - 2, lines.length - 1]) {
		assert.equal(chrome.handleMouse(press(y)), undefined, `chrome row ${y} must not select a block\n${lines.join("\n")}`);
	}
});

test("a settled turn re-arms the watch a session could not start", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	// In-memory startup: `startContextBlocksWatch` bails and nothing else arms the watch.
	const host = runtimeHost(t, undefined, { contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, pollMs: 60_000 } });
	await host.start();
	const factory = host.footerFactory();
	assert.ok(factory, "the footer must be installed");
	const tui = fakeTui(120, 40);
	assert.doesNotMatch(renderFooter(factory, tui), /# 2 · 3\.4k/);

	// The session gains a file mid-run; the sidecar is already there.
	host.setSessionFile(sessionFile);
	writeSidecar(sessionFile);
	await host.emit("agent_settled", { type: "agent_settled" });
	assert.match(renderFooter(factory, tui), /# 2 · 3\.4k/);
});

test("a settled turn and a compaction re-read the sidecar before the poll", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	// A minute-long poll: only an active re-read can refresh the segment in time.
	const host = runtimeHost(t, sessionFile, { contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, pollMs: 60_000 } });
	await host.start();
	const factory = host.footerFactory();
	assert.ok(factory, "the footer must be installed");
	const tui = fakeTui(120, 40);
	assert.doesNotMatch(renderFooter(factory, tui), /# 2 · 3\.4k/);

	writeSidecar(sessionFile);
	await host.emit("agent_settled", { type: "agent_settled" });
	assert.match(renderFooter(factory, tui), /# 2 · 3\.4k/, "agent_settled must read the new sidecar");

	// A compaction folds the blocks; the next event must show the new count.
	await new Promise((resolve) => setTimeout(resolve, 10));
	writeSidecar(sessionFile, { ...SIDECAR, blocks: SIDECAR.blocks.slice(0, 1) });
	await host.emit("session_compact", { type: "session_compact" });
	const compacted = renderFooter(factory, tui);
	assert.match(compacted, /# 1 · 2\.5k/, `session_compact must read the new sidecar\n${compacted}`);
	assert.doesNotMatch(compacted, /# 2 · 3\.4k/);
});

test("contextBlocks.enabled: false closes the overlay as well as the segment", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const host = runtimeHost(t, sessionFile, { contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, enabled: false } });
	await host.start();
	const shortcut = host.shortcuts.get("ctrl+shift+c");
	assert.ok(shortcut, "ctrl+shift+c must stay registered");
	shortcut.handler(host.ctx);
	assert.equal(host.customFactory(), undefined, "the shortcut must not open the overlay when disabled");
	const command = host.commands.get("open-tui:context");
	assert.ok(command, "open-tui:context must stay registered");
	await command.handler("", host.ctx);
	assert.equal(host.customFactory(), undefined, "the command must not open the overlay when disabled");
	assert.deepEqual(host.dispatched, []);
});

test("footerSegment: false hides the segment but keeps the overlay reachable", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile);
	const host = runtimeHost(t, sessionFile, { contextBlocks: { ...DEFAULT_CONFIG.contextBlocks, footerSegment: false } });
	await host.start();
	const factory = host.footerFactory();
	assert.ok(factory, "the footer must be installed");
	assert.doesNotMatch(renderFooter(factory, fakeTui(120, 40)), /# 2 · 3\.4k/);
	const shortcut = host.shortcuts.get("ctrl+shift+c");
	assert.ok(shortcut, "ctrl+shift+c must stay registered");
	shortcut.handler(host.ctx);
	assert.ok(host.customFactory(), "the overlay stays reachable when only the segment is off");
});

test("a schema mismatch is reported through the notify channel", async (t) => {
	const dir = temporaryDirectory(t, "pi-open-tui-blocks-");
	const sessionFile = join(dir, "session.jsonl");
	writeSidecar(sessionFile, { ...SIDECAR, schemaVersion: 2 });
	const host = runtimeHost(t, sessionFile);
	await host.start();
	const factory = host.footerFactory();
	assert.ok(factory, "the footer must be installed");
	// stderr would be wiped by the next repaint, so the warning rides the notify channel.
	assert.equal(host.notifications.length, 1, `expected one notify, got ${JSON.stringify(host.notifications)}`);
	assert.match(host.notifications[0]!, /schemaVersion 2/);
	assert.doesNotMatch(renderFooter(factory, fakeTui(120, 40)), /# 2 · 3\.4k/, "a mismatched sidecar must not paint a segment");
});

test("the ctrl+shift+c chord matches the bytes Pi sends", () => {
	// Pi encodes ctrl+shift+c as CSI 99;6u. If Pi ever changes how it spells the
	// chord, this fails here instead of the shortcut silently going dark.
	assert.equal(matchesKey("\x1b[99;6u", "ctrl+shift+c"), true);
	assert.equal(matchesKey("\x1b[99;5u", "ctrl+shift+c"), false, "ctrl+c must not open the overlay");
});
