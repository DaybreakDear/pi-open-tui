import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
	BUBBLE_LEFT_RESERVE,
	BUBBLE_MIN_WIDTH,
	BUBBLE_RIGHT_RESERVE,
	installBubble,
} from "../extensions/open-tui/bubble.ts";
import type { ThemeConfig } from "../extensions/open-tui/theme.ts";

/** Tag-free painter: `visibleWidth` then measures terminal columns, not mock markers. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string) => text,
} as unknown as Theme;

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

function config(overrides: Partial<ThemeConfig> = {}): ThemeConfig {
	return { preset: "pi", slots: {}, dividers: "line", gutter: false, banding: false, userBar: true, ...overrides };
}

let current: ThemeConfig = config({ bubble: "rounded" });

const install = () => installBubble({ theme: () => theme, config: () => current });

type AssistantInput = ConstructorParameters<typeof AssistantMessageComponent>[0];

function message(text = "Hello world\n\nSecond paragraph"): AssistantInput {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	} as unknown as AssistantInput;
}

function assistant(text?: string): AssistantMessageComponent {
	return new AssistantMessageComponent(message(text), true, markdownTheme, "Thinking...", 1, [], "message-1");
}

/** Pi renders through `Container.render`, so a bare container is a faithful stand-in for T6.2/T6.4. */
function fakeComponent(rows: string[], seen?: number[]): AssistantMessageComponent {
	const container = new Container();
	container.addChild({
		render: (width: number) => {
			seen?.push(width);
			return rows;
		},
	} as never);
	return container as unknown as AssistantMessageComponent;
}

test("T6.1 the frame consumes the width budget instead of overflowing", () => {
	current = config({ bubble: "rounded" });
	const cleanup = install();
	try {
		const rows = assistant().render(40);
		assert.equal(rows[0], `╭${"─".repeat(38)}╮`);
		assert.equal(rows.at(-1), `╰${"─".repeat(38)}╯`);
		for (const row of rows.slice(1, -1)) {
			const bare = stripTerminalSequences(row);
			assert.ok(bare.startsWith("│ ") && bare.endsWith(" │"), `side borders missing: ${JSON.stringify(bare)}`);
		}
		for (const row of rows) {
			assert.equal(visibleWidth(row), 40, `row broke the width budget: ${JSON.stringify(row)}`);
		}
	} finally {
		cleanup?.();
	}
});

test("T6.2 the inner component is rendered at width minus the measured borders", () => {
	assert.deepEqual([BUBBLE_LEFT_RESERVE, BUBBLE_RIGHT_RESERVE], [2, 2]);
	current = config({ bubble: "rounded" });
	const seen: number[] = [];
	const inner = fakeComponent(["inner"], seen);
	const cleanup = install();
	try {
		const rows = AssistantMessageComponent.prototype.render.call(inner, 40);
		assert.deepEqual(seen, [40 - BUBBLE_LEFT_RESERVE - BUBBLE_RIGHT_RESERVE]);
		// Pi's container prefixes OSC 133 markers, so compare the visible row.
		assert.equal(stripTerminalSequences(rows[1]!), `│ ${"inner".padEnd(36)} │`);
		for (const row of rows) assert.equal(visibleWidth(row), 40);
	} finally {
		cleanup?.();
	}
});

test("T6.3 a width below the threshold falls back byte for byte", () => {
	const width = BUBBLE_MIN_WIDTH - 1;
	const baseline = assistant().render(width);
	current = config({ bubble: "rounded" });
	const cleanup = install();
	try {
		assert.deepEqual(assistant().render(width), baseline);
	} finally {
		cleanup?.();
	}
});

test("T6.4 a row that carries an inline image falls back byte for byte", () => {
	const imageRows = ["\x1b_Ga=T;AAAA\x1b\\"];
	const baseline = AssistantMessageComponent.prototype.render.call(fakeComponent(imageRows), 40);
	current = config({ bubble: "rounded" });
	const cleanup = install();
	try {
		assert.deepEqual(AssistantMessageComponent.prototype.render.call(fakeComponent(imageRows), 40), baseline);
	} finally {
		cleanup?.();
	}
});

test("T6.5 the same width and text render identical bytes twice", () => {
	current = config({ bubble: "rounded" });
	const cleanup = install();
	try {
		const component = assistant();
		assert.deepEqual(component.render(40), component.render(40));
	} finally {
		cleanup?.();
	}
});

test("T6.6 bubble off stays byte for byte identical to the unpatched render", () => {
	const baseline = assistant().render(40);
	current = config({ bubble: "off" });
	const cleanup = install();
	try {
		assert.deepEqual(assistant().render(40), baseline);
	} finally {
		cleanup?.();
	}
});

test("T6.7 cleanup restores the prototype render", () => {
	const original = AssistantMessageComponent.prototype.render;
	current = config({ bubble: "rounded" });
	const cleanup = install();
	assert.notEqual(AssistantMessageComponent.prototype.render, original);
	cleanup?.();
	assert.equal(AssistantMessageComponent.prototype.render, original);
});
