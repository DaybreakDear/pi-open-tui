import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type OpenTuiConfig } from "../extensions/open-tui/config.ts";
import { installEditor } from "../extensions/open-tui/editor.ts";
import openTui, { getPendingUiChange } from "../extensions/open-tui/index.ts";
import { registerSettingsCommand } from "../extensions/open-tui/settings-command.ts";
import { preserveEnvironment, temporaryDirectory } from "./fixtures/test-helpers.ts";

interface SettingsComponent extends Component {
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

async function openSettings(
	initialConfig = structuredClone(DEFAULT_CONFIG),
	onChange?: (config: OpenTuiConfig) => void,
): Promise<{
	component: SettingsComponent;
	terminal: { columns: number; rows: number };
	getConfig: () => OpenTuiConfig;
	isClosed: () => boolean;
	isOverlayClosed: () => boolean;
	waitForClose: () => Promise<void>;
	press: (key: string, count?: number) => void;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;
	let overlayClosed = false;

	const pi = {
		registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
			onChange?.(nextConfig);
		},
		onOverlayClosed: () => {
			overlayClosed = true;
		},
	});

	const terminal = { columns: 80, rows: 24 };
	const tui = { terminal, requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => new Promise<void>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, (_value: void) => {
					closed = true;
					resolve();
				}) as SettingsComponent;
			}),
		},
	} as unknown as ExtensionContext;

	assert.ok(commandHandler);
	const closePromise = Promise.resolve(commandHandler("", ctx));
	assert.ok(component);
	const mounted = component;

	return {
		component,
		terminal,
		getConfig: () => config,
		isClosed: () => closed,
		isOverlayClosed: () => overlayClosed,
		waitForClose: () => closePromise,
		press(key, count = 1) {
			for (let i = 0; i < count; i++) mounted.handleInput(key);
		},
	};
}

function selectedLine(component: SettingsComponent, width = 80): string {
	return component.render(width).find((line) => line.includes("→ ")) ?? "";
}

// Configuration persistence.
test("reports whether configuration was saved", (t) => {
	const agentDir = temporaryDirectory(t, "open-tui-save-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const config = structuredClone(DEFAULT_CONFIG);
	config.header = false;
	assert.equal(saveConfig(config), true);
	assert.equal(loadConfig().header, false);
	const configPath = join(agentDir, "open-tui.json");
	rmSync(configPath);
	mkdirSync(configPath);
	assert.equal(saveConfig(config), false);
});

// Navigation and live settings changes.
test("closes cleanly after enabling or disabling the UI", async () => {
	for (const enabled of [true, false]) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.enabled = enabled;
		const settings = await openSettings(config);

		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().enabled, !enabled);
		assert.equal(settings.isClosed(), false);
		assert.equal(settings.isOverlayClosed(), false);

		settings.component.handleInput("q");
		assert.equal(settings.isClosed(), true);
		assert.equal(settings.isOverlayClosed(), false);
		await settings.waitForClose();
		assert.equal(settings.isOverlayClosed(), true);
	}
});

test("leaves fullscreen wheel speed to Pi settings", async () => {
	const settings = await openSettings();
	assert.doesNotMatch(settings.component.render(80).join("\n"), /wheel speed/i);
	assert.equal("fullscreen" in settings.getConfig(), false);
});

test("previews cursor styles from the Appearance tab", async () => {
	const writes: string[] = [];
	let editorInstalls = 0;
	let editorFactory: unknown;
	let hardwareCursor = false;
	const editorTui = {
		terminal: { columns: 80, rows: 24, write: (data: string) => writes.push(data) },
		requestRender() {},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor: (enabled: boolean) => {
			hardwareCursor = enabled;
		},
	} as unknown as TUI;
	const editor = installEditor({} as ExtensionAPI, {
		ui: {
			getEditorComponent: () => editorFactory,
			setEditorComponent: (factory: unknown) => {
				editorFactory = factory;
				editorInstalls++;
				if (typeof factory === "function") {
					factory(editorTui, {
						borderColor: (text: string) => text,
						selectList: {},
					}, { matches: () => false });
				}
			},
		},
	} as unknown as ExtensionContext);
	const settings = await openSettings(undefined, (config) => editor.setCursorStyle(config.cursorStyle));

	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");

	assert.equal(settings.getConfig().cursorStyle, "bar");
	assert.equal(settings.isClosed(), false);
	assert.equal(editorInstalls, 1);
	assert.equal(hardwareCursor, true);
	assert.ok(writes.includes("\x1b[6 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "underline");
	assert.ok(writes.includes("\x1b[4 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "block");
	assert.equal(hardwareCursor, false);
	assert.ok(writes.includes("\x1b[0 q"));
	assert.equal(editorInstalls, 1);
	assert.match(selectedLine(settings.component), /Cursor style/);
	assert.match(settings.component.render(80).join("\n"), /\[Appearance\].*Icon mode.*Cursor style/s);

	settings.component.handleInput("q");
	await settings.waitForClose();
	assert.equal(settings.isOverlayClosed(), true);
	editor.cleanup();
});

test("reconciles enabled changes with the installed UI", () => {
	assert.equal(getPendingUiChange(true, false), "install");
	assert.equal(getPendingUiChange(false, true), "uninstall");
	assert.equal(getPendingUiChange(true, true), undefined);
	assert.equal(getPendingUiChange(false, false), undefined);
});

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git branch/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.gitBranch, false);
	assert.match(selectedLine(settings.component), /Git branch/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Git branch/);
});

test("toggles live TPS from the Footer tab", async () => {
	const settings = await openSettings();

	settings.press("\t", 2);
	settings.press("\x1b[B", 9);
	assert.match(selectedLine(settings.component), /Live TPS/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.liveTps, false);
	assert.equal(settings.getConfig().telemetry.tps, true);
});

test("configures telemetry from its own tab", async () => {
	const settings = await openSettings();

	settings.press("\t", 3);
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.enabled, false);
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.tps, false);
});

test("supports localized settings and keyboard shortcuts", async () => {
	const settings = await openSettings();
	assert.match(settings.component.render(80).join("\n"), /Open TUI Settings.*General.*Language/s);

	settings.press("\x1b[B", 2);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().settingsLanguage, "zh");
	assert.match(settings.component.render(80).join("\n"), /Open TUI 设置.*常规.*语言.*简体中文/s);
	assert.match(selectedLine(settings.component), /语言/);

	const reopened = await openSettings(structuredClone(settings.getConfig()));
	assert.match(reopened.component.render(80).join("\n"), /Open TUI 设置.*简体中文/s);

	reopened.press("\x1b[B", 2);
	reopened.component.handleInput("\x1b[C");
	assert.match(reopened.component.render(80).join("\n"), /\[外观\].*图标模式.*光标样式/s);
	reopened.component.handleInput("\x1b[D");
	assert.match(selectedLine(reopened.component), /语言/);
	reopened.component.handleInput("q");
	assert.equal(reopened.isClosed(), true);
});

test("configures inline footer from General settings", async () => {
	const settings = await openSettings();
	// Headers are skipped: Enabled → Header → Language → Thinking peek → Copy buttons → Tool view → Footer in editor border.
	settings.press("\x1b[B", 6);
	assert.match(selectedLine(settings.component), /Footer in editor border/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().inlineFooter, true);
});

test("toggles copy buttons from General settings", async () => {
	const settings = await openSettings();
	assert.equal(settings.getConfig().copyButtons, true);
	// Enabled → Header → Language → Thinking peek → Copy buttons
	settings.press("\x1b[B", 4);
	assert.match(selectedLine(settings.component), /Copy buttons/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().copyButtons, false);
});

test("toggling tool view settings keeps the other tool view options", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.toolView.exclude = ["subagent_wait"];
	const settings = await openSettings(config);
	// Enabled → Header → Language → Thinking peek → Copy buttons → Tool view
	for (let i = 0; i < 5; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Tool view/);
	settings.component.handleInput(" ");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Compact extension tools/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().toolView.extensionTools, true);
	assert.deepEqual(settings.getConfig().toolView, { mode: "compact", extensionTools: true, exclude: ["subagent_wait"] });
});

test("toggles the header without resetting a disabled slot and warns when persistence fails", async (t) => {
	const agentDir = temporaryDirectory(t, "pi-open-tui-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ ...DEFAULT_CONFIG, header: false }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let settings: SettingsComponent | undefined;
	const headers: unknown[] = [];
	let editorFactory: unknown;
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		events: createEventBus(),
		registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
		registerShortcut() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		// Git/runtime probes spawn in cwd; keeping them out of agentDir lets Windows delete it.
		cwd: process.cwd(),
		ui: {
			setFooter() {},
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory: unknown) { editorFactory = factory; },
			setHeader: (factory: unknown) => headers.push(factory),
			notify: (message: string, level: string) => notifications.push({ message, level }),
			custom: (factory: (tui: TUI, theme: Theme) => SettingsComponent) =>
				void (settings = factory({ terminal: { columns: 80, rows: 24 }, requestRender() {} } as TUI, theme)),
		},
	} as unknown as ExtensionContext;
	openTui(pi);
	await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.deepEqual(headers, [], "a disabled header must not reset another extension's header");
	void command?.("", ctx);
	assert.ok(settings);
	settings.handleInput("\x1b[B");
	assert.match(selectedLine(settings), /Override header/);
	settings.handleInput(" ");
	assert.equal(notifications.length, 0);
	rmSync(join(agentDir, "open-tui.json"));
	mkdirSync(join(agentDir, "open-tui.json"));
	settings.handleInput(" ");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "warning");
	assert.match(notifications[0]?.message ?? "", /apply for this session but could not be saved/);
	assert.equal(typeof headers[0], "function");
	assert.deepEqual(headers.slice(1), [undefined], "disabling restores Pi's built-in header once");
});

test("configures the hostname footer segment", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Hostname/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.hostname, true);
	assert.match(selectedLine(settings.component), /Hostname/);
});

test("configures the extension status line with Space", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 12; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Extension status line/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.extensionStatuses, false);
	assert.match(selectedLine(settings.component), /Extension status line/);
});

// Width, height, and localization.
test("keeps localized settings and values within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	const settings = await openSettings(config);

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		}
		const output = lines.join("\n");
		assert.match(output, /开启/);
		settings.press("\x1b[B", 2);
		assert.match(selectedLine(settings.component, width), /简体中文/);
		settings.press("\x1b[A", 2);
	}
});

test("keeps every Footer selection visible in short terminals", async () => {
	for (const language of ["en", "zh"] as const) {
		for (const width of [24, 36, 48, 80]) {
			const config = structuredClone(DEFAULT_CONFIG);
			config.settingsLanguage = language;
			const settings = await openSettings(config);
			settings.terminal.columns = width;
			settings.terminal.rows = 12;
			settings.press("\t", 2);
			for (let i = 0; i < 16; i++) {
				const lines = settings.component.render(width);
				assert.ok(lines.length <= 12, `${language} ${width}x12: ${lines.length} rows`);
				assert.ok(lines.slice(0, 12).some((line) => line.includes("→ ")));
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
				settings.component.handleInput("\x1b[B");
			}
		}
	}
});

test("relayouts on height and width changes without losing the selection", async () => {
	const settings = await openSettings();
	settings.press("\t", 2);
	settings.press("\x1b[B", 14);
	assert.match(selectedLine(settings.component), /Capitalize provider name/);

	for (const [width, rows] of [[80, 12], [80, 24], [48, 12], [24, 12], [36, 12], [80, 24]] as const) {
		settings.terminal.columns = width;
		settings.terminal.rows = rows;
		const lines = settings.component.render(width);
		assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length} rows`);
		assert.match(lines.join("\n"), /→ .*On/);
	}
	assert.match(selectedLine(settings.component), /Capitalize provider name/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.capitalizeProviderName, false);
});

test("preserves long Footer labels' current values at narrow widths", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const settings = await openSettings(config);
		settings.press("\t", 2);
		settings.press("\x1b[B", 12);
		for (const id of ["extensionStatuses", "extensionSegments", "capitalizeProviderName", "nerdIconSpacing"] as const) {
			for (const toggle of [false, true]) {
				if (toggle) settings.component.handleInput(" ");
				const enabled = settings.getConfig().footerSegments[id];
				const value = language === "en" ? (enabled ? "On" : "Off") : (enabled ? "开启" : "关闭");
				for (const width of [24, 36, 48, 60]) {
					const line = selectedLine(settings.component, width);
					assert.ok(line.trimEnd().endsWith(`: ${value}`), line);
					assert.ok(visibleWidth(line) <= width);
				}
			}
			settings.component.handleInput("\x1b[B");
		}
	}
});

test("normalizes invalid settings values", (t) => {
	const agentDir = temporaryDirectory(t, "pi-open-tui-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
		settingsLanguage: "de",
		cursorStyle: "invalid",
		header: "no",
		inlineFooter: "yes",
		copyButtons: "no",
		thinkingPeek: { lines: 9 },
		toolView: { mode: "hidden", extensionTools: "yes", exclude: ["keep", 1, null] },
		fullscreen: { wheelScrollLines: 10 },
	}), "utf8");
	const loaded = loadConfig();
	assert.equal(loaded.settingsLanguage, "en");
	assert.equal(loaded.cursorStyle, "block");
	assert.equal(loaded.header, true);
	assert.equal(loaded.inlineFooter, false);
	assert.equal(loaded.copyButtons, true);
	assert.equal(loaded.thinkingPeek.lines, 1);
	assert.deepEqual(loaded.toolView, { mode: "native", extensionTools: false, exclude: ["keep"] });
	assert.equal("fullscreen" in loaded, true);
});

test("cycles the thinking peek line count from General settings", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	const settings = await openSettings(config);
	// Enabled → Header → Language → Thinking peek
	settings.press("\x1b[B", 3);
	assert.match(selectedLine(settings.component), /Thinking peek/);
	assert.match(selectedLine(settings.component), /1 line/);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 2);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 0);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 1);
	settings.component.handleInput("q");
});

// Currency settings and the ctrl+shift+m shortcut.
test("cycles the display currency from the Appearance tab", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\t");
	// Appearance → Icon mode → Cursor style → Currency
	settings.press("\x1b[B", 2);
	assert.match(selectedLine(settings.component), /Currency/);
	assert.match(selectedLine(settings.component), /USD \$/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cost.currency, "cny");
	assert.match(selectedLine(settings.component), /CNY ¥/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cost.currency, "usd");
	assert.match(selectedLine(settings.component), /USD \$/);

	settings.component.handleInput("q");
	await settings.waitForClose();
});

test("steps the manual USD to CNY rate through a fixed ladder", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.cost = { ...config.cost, currency: "cny" };
	const settings = await openSettings(config);
	settings.component.handleInput("\t");
	settings.press("\x1b[B", 3);
	assert.match(selectedLine(settings.component), /USD→CNY rate/);
	assert.match(selectedLine(settings.component), /7\.15/);

	const rates: number[] = [];
	for (let index = 0; index < 5; index++) {
		settings.component.handleInput("\r");
		rates.push(settings.getConfig().cost.usdToCny);
	}
	assert.deepEqual(rates, [7.3, 7.5, 6.8, 7.0, 7.15]);
	assert.equal(settings.getConfig().cost.currency, "cny", "changing the rate must not change the currency");

	settings.component.handleInput("q");
	await settings.waitForClose();
});

test("a hand-edited rate steps up to the next ladder rung", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	// 7.4 is not on the ladder; a strict float lookup used to fall through to 6.8.
	config.cost = { ...config.cost, usdToCny: 7.4 };
	const settings = await openSettings(config);
	settings.component.handleInput("\t");
	settings.press("\x1b[B", 3);
	assert.match(selectedLine(settings.component), /7\.4/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cost.usdToCny, 7.5);

	// Above the top rung the ladder wraps around.
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cost.usdToCny, 6.8);

	settings.component.handleInput("q");
	await settings.waitForClose();
});

function shortcutHost(t: TestContext, raw: Partial<OpenTuiConfig>) {
	const agentDir = temporaryDirectory(t, "pi-open-tui-shortcut-");
	preserveEnvironment(t, ["PI_CODING_AGENT_DIR"]);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ ...DEFAULT_CONFIG, ...raw }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let shortcut: { description?: string; handler: (ctx: ExtensionContext) => void } | undefined;
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		events: createEventBus(),
		registerCommand() {},
		registerShortcut: (key: string, options: { description?: string; handler: (ctx: ExtensionContext) => void }) => {
			if (key === "ctrl+shift+m") shortcut = options;
		},
		registerToolRenderer() {},
		registerMarkdownTransformer() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		ui: {
			setFooter() {},
			setHeader() {},
			getEditorComponent: () => undefined,
			setEditorComponent() {},
			notify: (message: string, level: string) => notifications.push({ message, level }),
			custom: () => undefined,
		},
	} as unknown as ExtensionContext;
	openTui(pi);
	handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return { shortcut: () => shortcut, notifications, ctx };
}

test("ctrl+shift+m toggles the currency and persists it", (t) => {
	const host = shortcutHost(t, {});
	const shortcut = host.shortcut();
	assert.ok(shortcut, "ctrl+shift+m must be registered");
	assert.equal(shortcut.description, "Toggle currency (USD/CNY)");

	shortcut.handler(host.ctx);
	assert.equal(loadConfig().cost.currency, "cny");
	shortcut.handler(host.ctx);
	assert.equal(loadConfig().cost.currency, "usd");
	assert.equal(host.notifications.length, 0);
});

test("ctrl+shift+m is inert when switching is disabled", (t) => {
	const host = shortcutHost(t, { cost: { currency: "usd", usdToCny: 7.15, switchable: false } });
	const shortcut = host.shortcut();
	assert.ok(shortcut);

	shortcut.handler(host.ctx);
	assert.equal(loadConfig().cost.currency, "usd");
	assert.equal(host.notifications.length, 1);
	assert.equal(host.notifications[0]?.level, "info");
	assert.match(host.notifications[0]?.message ?? "", /disabled/i);
});
