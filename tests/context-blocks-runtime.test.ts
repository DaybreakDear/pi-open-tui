import assert from "node:assert/strict";
import fs, { readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
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

function renderText(lines: readonly string[]): string {
	return lines.map(stripAnsi).join("\n");
}

/** A fake extension host: no real terminal, no real session, but the real handlers. */
function runtimeHost(t: TestContext, sessionFile: string | undefined, raw: Partial<typeof DEFAULT_CONFIG> = {}) {
	const agentDir = temporaryDirectory(t, "pi-open-tui-context-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
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
			getSessionFile: () => sessionFile,
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
	await new Promise((resolve) => setTimeout(resolve, 600));
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
