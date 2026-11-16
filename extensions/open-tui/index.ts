import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installCopyButtons, markCopyScope } from "./copy-buttons.ts";
import { installBubble } from "./bubble.ts";
import { installTimestamps } from "./timestamps.ts";
import { installMarkdownSkin, markSkinScope, resetMarkdownSkinSession } from "./markdown-skin.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { readContextBlocks, watchContextBlocks, type ContextBlocksSnapshot } from "./context-blocks.ts";
import { ContextBlocksOverlay } from "./context-blocks-overlay.ts";
import { createSkinProvider, type SkinProvider } from "./theme.ts";
import { createFooterSegments } from "./footer-segments.ts";
import { installHeader } from "./header.ts";
import { emptyGitStatus } from "./git.ts";
import { GitStatusRefresher } from "./git-refresh.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand, settingsCopy } from "./settings-command.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import {
	createThinkingStatsLedger,
	createThinkingStatsTransformer,
	thinkingRunsOf,
	type ThinkingStatsSnapshot,
} from "./thinking-stats.ts";
import { registerToolView } from "./tool-view.ts";
import {
	createInitialState,
	getModelMeta,
	getUsageTotals,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";
import { resolveGlyphs } from "./icons.ts";
import {
	buildPeekLabel,
	collectPeekParts,
	createPeekState,
	reducePeek,
	type PeekState,
} from "./peek.ts";

type PendingUiChange = "install" | "uninstall";

export function getPendingUiChange(enabled: boolean, active: boolean): PendingUiChange | undefined {
	if (enabled === active) return undefined;
	return enabled ? "install" : "uninstall";
}

function isTuiContext(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

/** Compares the whole theme subtree: every field under it reaches the painter. */
function themeBlockChanged(previous: OpenTuiConfig["theme"], next: OpenTuiConfig["theme"]): boolean {
	return JSON.stringify(previous) !== JSON.stringify(next);
}

/**
 * Turn metrics for the *next* user divider, written by `agent_settled` and consumed once by the skin.
 * Module level so the consumer handed to `installMarkdownSkin` stays a plain closure and the value
 * survives a settings-driven reinstall; both session boundaries clear it.
 */
let pendingTurnSummary: string | undefined;

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	// Bumped on every config write: painters and the tool view's row cache key on it.
	let skinEpoch = 0;
	const skin: SkinProvider = createSkinProvider(() => config.theme, () => skinEpoch);
	let configLoaded = false;
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	// The sidecar watcher lives only while the UI is installed; every teardown path unwatches it.
	let stopContextBlocks: (() => void) | undefined;
	let contextBlocks: ContextBlocksSnapshot | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;
	let copyButtons: ReturnType<typeof installCopyButtons> | undefined;
	let cleanupMarkdownSkin: (() => void) | undefined;
	let cleanupBubble: (() => void) | undefined;
	let cleanupTimestamps: (() => void) | undefined;
	let pendingUiChange: PendingUiChange | undefined;
	const footerSegments = createFooterSegments(pi.events, () => requestFooterRender?.());
	const gitRefresher = new GitStatusRefresher((git) => {
		if (!sessionLifecycle.isCurrent() || !active || !config.enabled) return;
		state.git = git;
		requestFooterRender?.();
	});

	// thinking-peek state (rendered by Pi inside its hidden-thinking block)
	const peek: PeekState = createPeekState();
	let peekFrame = 0;
	let peekSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let peekTaskEpoch = 0; // bumped at every agent task boundary
	let peekLabelActive = false;
	// Set on the first thinking update of a task: the header's elapsed time starts there.
	let thinkingStartedAt: number | undefined;
	// Session-wide output total when this task started: the header shows the message, not the session.
	let thinkingTokensBase: number | undefined;
	// Frozen when the task settles: the peek's live clock is cleared shortly after, but a re-render of
	// the settled thinking block must still find its counters. Keyed by the block's own text, because a
	// single slot painted every historical block with the current turn's numbers.
	const thinkingStats = createThinkingStatsLedger();
	// The run the last `message_end` recorded, so `agent_settled` can freeze exactly that one.
	let lastThinkingRun: string | undefined;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	/** Clock and token delta for the running thinking block; read here, never inside the transformer. */
	const liveThinkingStats = (): ThinkingStatsSnapshot | undefined => {
		if (thinkingStartedAt === undefined || !lastCtx) return undefined;
		return {
			elapsedMs: Date.now() - thinkingStartedAt,
			tokens: getUsageTotals(lastCtx).output - (thinkingTokensBase ?? 0),
		};
	};

	/**
	 * Files this message's thinking blocks under their own text. Called at `message_end`, where the
	 * counters are final and the block is about to be re-rendered with `isStreaming === false`.
	 */
	const recordThinkingStats = (message: unknown, stats: ThinkingStatsSnapshot | undefined): boolean => {
		if (!stats) return false;
		const runs = thinkingRunsOf(message);
		if (runs.length === 0) return false;
		for (const run of runs) thinkingStats.record(run, stats);
		lastThinkingRun = runs[runs.length - 1];
		return true;
	};

	/** Pi decides whether this label is visible; our toggle only controls updates. */
	const isPeekEnabled = () => sessionLifecycle.isCurrent() && config.enabled && config.thinkingPeek.lines > 0 && active;

	const setPeekLabel = (ctx?: ExtensionContext): void => {
		if (!isPeekEnabled() || peek.phase === "idle") return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		if (!editor) throw new Error("Open TUI editor is not installed");
		const snapshot = { ...peek };
		const frame = peekFrame;
		const glyphs = resolveGlyphs(config.icons.mode);
		const lines = config.thinkingPeek.lines;
		const tokensBase = thinkingTokensBase ?? 0;
		// Both numbers are read per render: Pi re-invokes this on every frame, and a snapshot taken
		// here would freeze the clock and the token segment for the rest of the task.
		editor.setLatestHiddenThinkingLabel((width) => {
			const counts = thinkingStartedAt === undefined
				? undefined
				: {
					elapsedMs: Date.now() - thinkingStartedAt,
					tokens: getUsageTotals(target).output - tokensBase,
					showCounts: config.thinkingPeek.showCounts,
				};
			return buildPeekLabel(snapshot, frame, glyphs, width, lines, counts);
		});
		peekLabelActive = true;
	};

	const clearPeekLabel = (ctx?: ExtensionContext): void => {
		if (!peekLabelActive) return;
		const target = ctx ?? lastCtx;
		if (!target || !isTuiContext(target)) return;
		// The global reset is safe here: every completed message returns to Pi's native label.
		target.ui.setHiddenThinkingLabel();
		peekLabelActive = false;
	};

	/** Reset peek state to idle and cancel any scheduled cleanup. */
	const resetPeek = () => {
		peek.phase = "idle";
		peek.tail = "";
		thinkingStartedAt = undefined;
		thinkingTokensBase = undefined;
		editor?.resetHiddenThinkingLabelTarget();
		if (peekSettleTimer) {
			clearTimeout(peekSettleTimer);
			peekSettleTimer = undefined;
		}
	};
	const currentSessionFile = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager.getSessionFile();
		} catch {
			// In-memory sessions can throw here: no sidecar means no segment.
			return undefined;
		}
	};

	const stopContextBlocksWatch = (): void => {
		stopContextBlocks?.();
		stopContextBlocks = undefined;
		contextBlocks = undefined;
	};

	const startContextBlocksWatch = (ctx: ExtensionContext): void => {
		stopContextBlocksWatch();
		if (!config.contextBlocks.enabled || !isTuiContext(ctx)) return;
		const sessionFile = () => currentSessionFile(ctx);
		if (!sessionFile()) return;
		stopContextBlocks = watchContextBlocks(
			sessionFile,
			(snapshot) => {
				contextBlocks = snapshot;
				requestFooterRender?.();
			},
			config.contextBlocks.pollMs,
			(message) => ctx.ui.notify(message, "warning"),
		);
	};

	/**
	 * Design §3.4 wants an active read after a settled turn or a compaction: the
	 * watch alone lags up to `pollMs`, and it may never have been armed (the session
	 * file is not known at install time, so `startContextBlocksWatch` bails).
	 */
	const refreshContextBlocks = (ctx: ExtensionContext): void => {
		if (!config.contextBlocks.enabled || !isTuiContext(ctx)) return;
		// Nothing armed means the watcher bailed earlier: re-arm now that the file is known.
		if (!stopContextBlocks) startContextBlocksWatch(ctx);
		contextBlocks = readContextBlocks(currentSessionFile(ctx), (message) => ctx.ui.notify(message, "warning"));
		requestFooterRender?.();
	};

	/** Read-only overlay: it reads the sidecar and never writes it or dispatches commands. */
	const openContextBlocksOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!isTuiContext(ctx)) return;
		// `contextBlocks.enabled` covers the footer and this overlay.
		// `footerSegment: false` only hides the segment; the overlay stays reachable.
		if (!config.contextBlocks.enabled) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const overlay = new ContextBlocksOverlay(
				tui,
				theme,
				() => readContextBlocks(currentSessionFile(ctx), (message) => ctx.ui.notify(message, "warning")),
				() => done(undefined),
			);
			return {
				capturesViewportInput: true,
				render: (width: number) => overlay.render(width),
				invalidate: () => overlay.invalidate(),
				handleInput: (data: string) => {
					overlay.handleInput(data);
					tui.requestRender();
				},
				handleMouse: (event: TuiMouseEvent) => {
					const result = overlay.handleMouse(event);
					if (result?.handled && result.render !== false) tui.requestRender();
					return result;
				},
			};
		}, { overlay: true });
	};
	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			// Leave the header slot alone when disabled so another extension's header survives.
			if (config.header) cleanupHeader = installHeader(pi, ctx);
			const footer = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel, config.footerSegments.capitalizeProviderName),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
						if (!fn) footerSegments.deactivate();
						else if (active && sessionLifecycle.isCurrent()) footerSegments.activate();
					},
					scheduleGitRefresh: () => {
						scheduleGitRefresh(ctx, true);
					},
					getLiveTps: () => turnTelemetry.getLiveTps(),
					getExtensionSegments: footerSegments.getSegments,
					getContextBlocks: () => (config.contextBlocks.enabled && config.contextBlocks.footerSegment
						? contextBlocks
						: undefined),
					getSkin: skin,
					canEmbedInEditor: () => editor?.isFramed() ?? false,
				},
			);
			cleanupFooter = footer.cleanup;
			editor = installEditor(
				pi,
				ctx,
				config.cursorStyle,
				{
					enabled: () => config.inlineFooter,
					render: footer.renderInline,
				},
				() => copyButtons?.editor,
			);
			cleanupMarkdownSkin = installMarkdownSkin({
				theme: () => ctx.ui.theme,
				config: () => config.theme,
				consumeTurnSummary: () => {
					const next = pendingTurnSummary;
					pendingTurnSummary = undefined;
					return next;
				},
			});
			copyButtons = installCopyButtons({
				getTui: editor.getTui,
				getTheme: () => ctx.ui.theme,
				isEnabled: () => config.copyButtons,
			});
			// Installed after the skin and the copy buttons so the frame wraps their output, and
			// after the bubble so a stamp can ride the frame's own top border.
			cleanupBubble = installBubble({ theme: () => ctx.ui.theme, config: () => config.theme });
			cleanupTimestamps = installTimestamps({ theme: () => ctx.ui.theme, config: () => config.theme });
			active = true;
			if (requestFooterRender) footerSegments.activate();
			startContextBlocksWatch(ctx);
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		stopContextBlocksWatch();
		gitRefresher.reset();
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			// Reverse of the install order: timestamps, bubble, copy buttons, markdown skin.
			cleanupTimestamps?.();
			cleanupBubble?.();
			copyButtons?.cleanup();
			cleanupMarkdownSkin?.();
			cleanupTimestamps = undefined;
			cleanupBubble = undefined;
			cleanupMarkdownSkin = undefined;
			editor?.cleanup();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			copyButtons = undefined;
			editor = undefined;
			requestFooterRender = undefined;
			resetPeek();
			clearPeekLabel(ctx);
			active = false;
		}
	};

	const scheduleGitRefresh = (ctx: ExtensionContext, immediate = false) => {
		if (!sessionLifecycle.isCurrent() || !isTuiContext(ctx) || !active || !config.enabled) return;
		const segs = config.footerSegments;
		// gitCommit only appends a tag to the gitBranch segment, so it never needs git on its own.
		if (!segs.gitBranch && !segs.gitStatus) {
			gitRefresher.reset();
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		gitRefresher.request(ctx.cwd, {
			readCommit: segs.gitBranch,
			readTag: segs.gitBranch && segs.gitCommit,
			readCounts: segs.gitStatus,
		}, immediate);
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			scheduleGitRefresh(ctx, true);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		resetMarkdownSkinSession();
		pendingTurnSummary = undefined;
		thinkingStats.clear();
		lastThinkingRun = undefined;
		gitRefresher.reset();
		lastCtx = ctx;
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));
		configLoaded = true;
		clearPeekLabel(ctx);

		applyUi(ctx);

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		// Always unwatch, even when the UI was never installed for this session.
		stopContextBlocksWatch();
		gitRefresher.reset();
		stopWorkingTimer();
		footerSegments.deactivate();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, _ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		// agent_start also covers custom-message and continuation-triggered tasks
		// that do not emit a user message_start event.
		peekTaskEpoch++;
		// The ledger is deliberately kept: a re-render of a previous block needs its own numbers.
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		gitRefresher.flush();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || ctx.isIdle()) return;
		const role = event.message?.role;
		if (role === "user") {
			// Restore Pi's native label until real thinking arrives. The task epoch is
			// advanced by agent_start so custom/no-user tasks are covered too.
			resetPeek();
			clearPeekLabel(ctx);
		} else if (role === "assistant") {
			resetPeek();
			clearPeekLabel(ctx);
		}
	});

	pi.on("message_update", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent() || ctx.isIdle()) return;
		if (!isPeekEnabled()) return;
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		if (peek.phase === "done") return;
		const parts = collectPeekParts(message.content);
		const next = reducePeek(peek, parts);
		if (next.phase === "thinking" && thinkingStartedAt === undefined) {
			thinkingStartedAt = Date.now();
			thinkingTokensBase = getUsageTotals(ctx).output;
		}
		const changed = next.phase !== peek.phase || next.tail !== peek.tail;
		peek.phase = next.phase;
		peek.tail = next.tail;
		if (!changed) return;
		if (peek.phase === "thinking") {
			peekFrame++;
			setPeekLabel(ctx);
		} else if (peek.phase === "done") {
			setPeekLabel(ctx);
		}
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(
				telemetry,
				ctx.ui.theme,
				config.telemetry,
				config.icons.mode,
				config.cost,
				skin(ctx.ui.theme).painter,
			);
			if (message) {
				ctx.ui.notify(message, "info");
				// The notify is transient; the divider keeps the same line in the transcript.
				pendingTurnSummary = message;
			}
		}
		// Freeze the counters before the settle timer clears the live clock below, and file them under
		// the block that was actually being written: the ledger, not a single slot.
		const frozen = liveThinkingStats();
		if (frozen && lastThinkingRun !== undefined) thinkingStats.record(lastThinkingRun, frozen);
		// Only clear the peek label when this task is still the current one.
		const settleEpoch = peekTaskEpoch;
		if (peekSettleTimer) clearTimeout(peekSettleTimer);
		peekSettleTimer = setTimeout(() => {
			peekSettleTimer = undefined;
			if (!sessionLifecycle.isCurrent() || peekTaskEpoch !== settleEpoch) return;
			resetPeek();
			clearPeekLabel(ctx);
		}, 300);
		refreshContextBlocks(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		if (event.message?.role === "assistant") {
			// File the counters under the block's own text and repaint once so the settled numbers show
			// immediately, whether or not Pi re-renders the block before this handler runs.
			if (recordThinkingStats(event.message, liveThinkingStats())) repaint();
			if (peek.phase === "thinking") {
				// Sub-message finished (answer text or a tool call): freeze the peek line.
				peek.phase = "done";
				setPeekLabel(ctx);
			}
		}
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		scheduleGitRefresh(ctx);
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
		// A compaction moves tokens between blocks: read it now, not on the next poll.
		refreshContextBlocks(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerToolView(
		pi,
		() => {
			// Resumed sessions rebuild their rows before session_start fires, so read the file once here.
			if (!configLoaded) {
				config = loadConfig();
				configLoaded = true;
			}
			return config.enabled ? config.toolView : { ...config.toolView, mode: "native" };
		},
		() => resolveGlyphs(config.icons.mode),
		skin,
		() => config.theme,
	);

	pi.registerMarkdownTransformer(markSkinScope);
	pi.registerMarkdownTransformer(markCopyScope);
	// The visible thinking block is Pi's Markdown, so its counters are appended there; the hidden label
	// keeps going through `editor.setLatestHiddenThinkingLabel`. Exactly one of the two is live at a time.
	pi.registerMarkdownTransformer(createThinkingStatsTransformer({
		lookup: thinkingStats.lookup,
		showCounts: () => config.thinkingPeek.showCounts,
		dim: (text) => (lastCtx && isTuiContext(lastCtx) ? lastCtx.ui.theme.fg("dim", text) : text),
	}));

	// `requestRender` alone redraws the same bytes: Pi caches rendered lines per (text, width),
	// so a colour change needs `invalidate` first. No editor means no mounted TUI to repaint.
	const repaint = (): void => {
		const tui = editor?.getTui();
		if (!tui) return;
		tui.invalidate();
		tui.requestRender(true);
	};

	// Save first so the in-memory config and the session agree only after the write.
	const persistConfig = (nextConfig: OpenTuiConfig): void => {
		if (!saveConfig(nextConfig)) {
			lastCtx?.ui.notify(nextConfig.settingsLanguage === "zh"
				? "open-tui 设置本次生效，但未保存到磁盘。请检查配置目录权限和可用空间。"
				: "open-tui settings apply for this session but could not be saved. Check configuration directory permissions and free space.", "warning");
		}
		// Every visual field (preset, slots, dividers, gutter, banding, userBar) lives under `theme`,
		// so compare the whole block: identity would miss a caller that reuses the old object.
		if (themeBlockChanged(config.theme, nextConfig.theme)) {
			skinEpoch += 1;
			repaint();
		}
		config = nextConfig;
	};

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const cursorStyleChanged = config.cursorStyle !== newConfig.cursorStyle;
			const headerChanged = config.header !== newConfig.header;
			const copyButtonsChanged = config.copyButtons !== newConfig.copyButtons;
			const thinkingPeekLinesChanged = config.thinkingPeek.lines !== newConfig.thinkingPeek.lines;
			persistConfig(newConfig);
			if (newConfig.thinkingPeek.lines === 0 || !newConfig.enabled) {
				resetPeek();
				clearPeekLabel(lastCtx);
			} else if (thinkingPeekLinesChanged && peekLabelActive) {
				setPeekLabel(lastCtx);
			}
			if (cursorStyleChanged && active && editor) {
				editor.setCursorStyle(newConfig.cursorStyle);
			}
			if (headerChanged && active && lastCtx) {
				cleanupHeader?.();
				cleanupHeader = newConfig.header ? installHeader(pi, lastCtx) : undefined;
			}
			if (copyButtonsChanged) copyButtons?.refresh();
			if (lastCtx) {
				pendingUiChange = getPendingUiChange(newConfig.enabled, active);
			}
			const gitNeeded = newConfig.footerSegments.gitBranch || newConfig.footerSegments.gitStatus;
			gitRefresher.reset();
			if (lastCtx && newConfig.enabled && gitNeeded) {
				scheduleGitRefresh(lastCtx, true);
			} else {
				state.git = emptyGitStatus();
			}
			requestFooterRender?.();
		},
		onOverlayClosed: () => {
			if (!lastCtx || pendingUiChange === undefined) return;
			const change = pendingUiChange;
			pendingUiChange = undefined;
			if (!config.enabled || change === "uninstall") {
				uninstallUi(lastCtx);
			} else {
				applyUi(lastCtx);
				scheduleGitRefresh(lastCtx, true);
			}
		},
	});

	pi.registerCommand("open-tui:context", {
		description: "Show billion-context compression blocks (read-only)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await openContextBlocksOverlay(ctx);
		},
	});

	// Registered on the extension lifecycle, not per session, so it stays live across sessions.
	pi.registerShortcut("ctrl+shift+c", {
		description: "Context compression blocks",
		handler: (ctx: ExtensionContext) => {
			void openContextBlocksOverlay(ctx);
		},
	});
	pi.registerShortcut("ctrl+shift+m", {
		description: "Toggle currency (USD/CNY)",
		handler: (ctx: ExtensionContext) => {
			const copy = settingsCopy(config.settingsLanguage);
			if (!config.cost.switchable) {
				ctx.ui.notify(copy.notices.currencyLocked, "info");
				return;
			}
			const currency = config.cost.currency === "usd" ? "cny" : "usd";
			persistConfig({ ...config, cost: { ...config.cost, currency } });
			requestFooterRender?.();
			// Locked or not, the shortcut must always leave a visible trace: both cost segments may be off.
			ctx.ui.notify(copy.notices.currencySwitched(copy.values.currencies[currency]), "info");
		},
	});
}
