import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BcpBlockLike, ContextBlocksSnapshot } from "./context-blocks.ts";
import { fmtTokens } from "./utils.ts";

const TITLE = "Context Compression";
const EMPTY = "No compression blocks yet.";
const HINT = "ctrl+d expand · enter expand · r reload · esc close";
/** Rows the chrome (title, header, dividers, hint, box padding) takes from the terminal. */
const CHROME_ROWS = 7;
const INDENT = "      ";

export function formatBlocksHeader(snapshot: ContextBlocksSnapshot): string {
	const tiers = [1, 2, 3].map((tier) => `t${tier}×${snapshot.tiers[tier as 1 | 2 | 3]}`).join(" ");
	const noun = snapshot.blockCount === 1 ? "block" : "blocks";
	return `${snapshot.blockCount} ${noun} · ${fmtTokens(snapshot.compressedTokens)} compressed · ${tiers}`;
}

/**
 * The summary is all we know about what survived, so the ratio is compressed
 * tokens over the summary's rough token count. Empty summaries have no ratio.
 */
function summaryRatio(block: BcpBlockLike): string {
	if (block.summary.length === 0) return "—";
	const survivedTokens = Math.max(1, Math.round(block.summary.length / 4));
	return `${(block.compressedTokens / survivedTokens).toFixed(1)}x`;
}

export interface ContextBlocksOverlayHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
	handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

/**
 * Read-only viewer for billion-context compression blocks: it reads the sidecar
 * (via the injected `reload`) and never writes it or dispatches any Pi command.
 */
export class ContextBlocksOverlay implements ContextBlocksOverlayHandle {
	private selected = 0;
	private scroll = 0;
	private readonly expanded = new Set<string>();
	private readonly container: Box;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly reload: () => ContextBlocksSnapshot | undefined;
	private readonly onClose: () => void;
	private snapshot: ContextBlocksSnapshot | undefined;
	private layoutWidth: number | undefined;
	private layoutRows: number | undefined;
	private cachedLines: string[] | undefined;
	/** Rendered row offset → block index, for click selection. */
	private readonly rowBlocks: number[] = [];

	constructor(
		tui: TUI,
		theme: Theme,
		reload: () => ContextBlocksSnapshot | undefined,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.reload = reload;
		this.onClose = onClose;
		this.snapshot = reload();
		this.container = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		this.rebuild();
	}

	private blocks(): readonly BcpBlockLike[] {
		return this.snapshot?.blocks ?? [];
	}

	private blockLines(block: BcpBlockLike, index: number, width: number): string[] {
		const selected = index === this.selected;
		const marker = selected ? this.theme.fg("accent", "▸") : this.theme.fg("dim", "▸");
		const topic = block.topic.length > 0 ? block.topic : "(untitled)";
		const head = `${marker} ${this.theme.fg("dim", block.blockId)}  ${this.theme.fg("dim", `t${block.tier}`)}  ${topic}`;
		const detail = `${INDENT}${this.theme.fg("dim", `${fmtTokens(block.compressedTokens)} tok · ${summaryRatio(block)} · survived ${block.survivedCount}`)}`;
		const lines = [truncateToWidth(head, width, "…"), truncateToWidth(detail, width, "…")];
		if (!this.expanded.has(block.blockId)) return lines;
		const body = block.summary.length > 0 ? block.summary : "(no summary)";
		for (const line of wrapTextWithAnsi(body, Math.max(10, width - INDENT.length))) {
			lines.push(truncateToWidth(`${INDENT}${this.theme.fg("dim", line)}`, width, "…"));
		}
		return lines;
	}

	private rebuild(width = this.layoutWidth ?? Math.min(90, this.tui.terminal.columns)): void {
		this.layoutWidth = width;
		this.layoutRows = this.tui.terminal.rows;
		this.container.clear();
		this.rowBlocks.length = 0;
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", TITLE)), 1, 0));

		const blocks = this.blocks();
		const innerWidth = Math.max(20, width - 2);
		if (!this.snapshot || blocks.length === 0) {
			this.container.addChild(new Text(this.theme.fg("dim", EMPTY), 1, 0));
			this.container.addChild(new Text(this.theme.fg("dim", "esc close"), 1, 0));
			this.cachedLines = undefined;
			return;
		}

		this.selected = Math.min(Math.max(0, this.selected), blocks.length - 1);
		this.container.addChild(new Text(this.theme.fg("dim", formatBlocksHeader(this.snapshot)), 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", "─".repeat(innerWidth)), 1, 0));

		const budget = Math.max(4, (this.layoutRows ?? 24) - CHROME_ROWS);
		const groups = blocks.map((block, index) => this.blockLines(block, index, innerWidth));
		// Keep the selected block inside the window, dropping whole blocks from the top.
		let start = Math.min(Math.max(0, this.scroll), this.selected);
		const groupHeight = (from: number, to: number): number => {
			let total = 0;
			for (let index = from; index <= to; index++) total += groups[index]!.length;
			return total;
		};
		while (start < this.selected && groupHeight(start, this.selected) > budget) start += 1;
		this.scroll = start;

		// A block taller than the viewport is clipped rather than pushed off-screen.
		let used = 0;
		for (let index = start; index < groups.length && used < budget; index++) {
			for (const line of groups[index]!) {
				if (used >= budget) break;
				this.container.addChild(new Text(line, 1, 0));
				this.rowBlocks.push(index);
				used += 1;
			}
		}

		this.container.addChild(new Text(this.theme.fg("dim", "─".repeat(innerWidth)), 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", HINT), 1, 0));
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (width !== this.layoutWidth || this.tui.terminal.rows !== this.layoutRows) {
			this.rebuild(width);
		}
		if (this.cachedLines) return this.cachedLines;
		this.cachedLines = this.container.render(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.container.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "r")) {
			this.snapshot = this.reload();
			this.scroll = 0;
			this.rebuild();
			this.invalidate();
			return;
		}
		const blocks = this.blocks();
		if (blocks.length === 0) return;
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.rebuild();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.selected = Math.min(blocks.length - 1, this.selected + 1);
			this.rebuild();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.enter)) {
			const block = blocks[this.selected];
			if (!block) return;
			if (this.expanded.has(block.blockId)) this.expanded.delete(block.blockId);
			else this.expanded.add(block.blockId);
			this.rebuild();
			this.invalidate();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press") return undefined;
		// The Box pads one row on top and one column on the left.
		const block = this.rowBlocks[event.y - 1];
		if (block === undefined) return undefined;
		this.selected = block;
		this.rebuild();
		this.invalidate();
		return { handled: true, focus: true, render: true };
	}
}
