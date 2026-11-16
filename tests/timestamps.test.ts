import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { installBubble } from "../extensions/open-tui/bubble.ts";
import { formatTimestamp, installTimestamps, TIMESTAMP_MIN_WIDTH } from "../extensions/open-tui/timestamps.ts";
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
	return {
		preset: "pi",
		slots: {},
		dividers: "line",
		gutter: false,
		banding: false,
		userBar: true,
		bubble: "off",
		timestamps: "all",
		...overrides,
	};
}

/** A fixed instant; `formatTimestamp` is the oracle for the expected local `HH:MM`. */
const ISO = "2024-11-15T05:03:00.000Z";
const MS = Date.parse(ISO);
/** A second, deliberately different instant: only one of them may reach the row. */
const OTHER_MS = Date.parse("2024-01-02T09:41:00.000Z");

let current: ThemeConfig = config();

const install = () => installTimestamps({ theme: () => theme, config: () => current });

type AssistantInput = ConstructorParameters<typeof AssistantMessageComponent>[0];

function assistantMessage(timestamp?: number): AssistantInput {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello world" }],
		stopReason: "stop",
		...(timestamp === undefined ? {} : { timestamp }),
	} as unknown as AssistantInput;
}

function assistant(timestamp?: number, iso?: string): AssistantMessageComponent {
	return new AssistantMessageComponent(assistantMessage(timestamp), true, markdownTheme, "Thinking...", 1, [], "message-1", iso);
}

function user(): UserMessageComponent {
	return new UserMessageComponent("hi there", markdownTheme, 1, [], "message-2");
}

test("T7.1 an ISO timestamp from the restore path wins over the live one", () => {
	const expected = formatTimestamp(ISO);
	assert.ok(expected !== undefined);
	assert.notEqual(expected, formatTimestamp(OTHER_MS));
	current = config();
	const cleanup = install();
	try {
		const rows = assistant(OTHER_MS, ISO).render(40);
		assert.ok(stripTerminalSequences(rows[0]!).startsWith(expected), JSON.stringify(rows[0]));
	} finally {
		cleanup?.();
	}
});

test("T7.2 a live message timestamp is formatted as local time", () => {
	const expected = formatTimestamp(MS);
	assert.ok(expected !== undefined);
	current = config();
	const cleanup = install();
	try {
		const rows = assistant(MS).render(40);
		const bare = stripTerminalSequences(rows[0]!);
		assert.ok(bare.startsWith(expected), `${JSON.stringify(bare)} should start with ${expected}`);
		assert.equal(visibleWidth(rows[0]!), 40);
	} finally {
		cleanup?.();
	}
});

test("T7.3 no timestamp at all: one first-render snapshot, stable across renders", () => {
	current = config();
	const cleanup = install();
	try {
		const component = assistant();
		const first = component.render(40);
		const second = component.render(40);
		assert.deepEqual(second, first);
		const bare = stripTerminalSequences(first[0]!);
		assert.match(bare, /^\d{2}:\d{2}/, `no snapshot stamp in ${JSON.stringify(bare)}`);
		assert.equal(visibleWidth(first[0]!), 40);
	} finally {
		cleanup?.();
	}
});

test("T7.4 timestamps off stays byte for byte identical to the unpatched render", () => {
	const baseline = assistant(MS).render(40);
	current = config({ timestamps: "off" });
	const cleanup = install();
	try {
		assert.deepEqual(assistant(MS).render(40), baseline);
	} finally {
		cleanup?.();
	}
});

test("T7.5 a width below the threshold writes nothing", () => {
	const width = TIMESTAMP_MIN_WIDTH - 1;
	const baseline = assistant(MS).render(width);
	current = config();
	const cleanup = install();
	try {
		assert.deepEqual(assistant(MS).render(width), baseline);
	} finally {
		cleanup?.();
	}
});

test("T7.6 a user message is stamped on the reserved top blank row only", () => {
	initTheme();
	const baseline = user().render(40);
	const expected = formatTimestamp(MS);
	assert.ok(expected !== undefined);
	current = config();
	const cleanup = install();
	try {
		const stamped = new UserMessageComponent("hi there", markdownTheme, 1, [], "message-3", ISO).render(40);
		assert.equal(stamped.length, baseline.length, "the stamp must not add a row");
		assert.deepEqual(stamped.slice(1), baseline.slice(1), "only the top blank row may change");
		assert.ok(stripTerminalSequences(stamped[0]!).trimEnd().endsWith(expected), JSON.stringify(stamped[0]));
		assert.equal(visibleWidth(stamped[0]!), 40);
	} finally {
		cleanup?.();
	}
});

test("T7.7 inside the bubble the stamp rides the top border row", () => {
	const bubble = installBubble({ theme: () => theme, config: () => current });
	current = config({ bubble: "rounded" });
	const cleanup = install();
	try {
		const expected = formatTimestamp(MS);
		assert.ok(expected !== undefined);
		const rows = assistant(MS).render(40);
		const bare = stripTerminalSequences(rows[0]!);
		assert.equal(bare, `╭${"─".repeat(31)} ${expected} ╮`);
		for (const row of rows) assert.equal(visibleWidth(row), 40);
	} finally {
		cleanup?.();
		bubble?.();
	}
});
