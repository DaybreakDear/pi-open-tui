import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { installMarkdownSkin, resetMarkdownSkinSession } from "../extensions/open-tui/markdown-skin.ts";
import { DEFAULT_CONFIG } from "../extensions/open-tui/config.ts";
import { DEFAULT_COST } from "../extensions/open-tui/currency.ts";
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

function user(iso?: string): UserMessageComponent {
	return new UserMessageComponent("hi there", markdownTheme, 1, [], "message-2", iso);
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

test("T7.7 assistant stamps use Pi's native blank row, never a frame", () => {
	current = config();
	const cleanup = install();
	try {
		const expected = formatTimestamp(MS);
		assert.ok(expected !== undefined);
		const rows = assistant(MS).render(40);
		assert.ok(stripTerminalSequences(rows[0]!).startsWith(expected), rows[0]);
		assert.ok(!rows.some((row) => stripTerminalSequences(row).includes("╭")));
		for (const row of rows) assert.equal(visibleWidth(row), 40);
	} finally { cleanup?.(); }
});

test("timestamps skip the standalone divider and stamp the user message's native blank row", () => {
	initTheme();
	resetMarkdownSkinSession();
	current = config();
	const skin = installMarkdownSkin({ theme: () => theme, config: () => current,
		telemetrySettings: () => ({ config: DEFAULT_CONFIG.telemetry, iconMode: "unicode", cost: DEFAULT_COST }) });
	const stamps = install();
	try {
		user(ISO).render(40);
		const rows = user(ISO).render(40);
		const expected = formatTimestamp(MS);
		assert.ok(rows[0]?.includes("━━━") && !rows[0]?.includes(expected!));
		assert.ok(stripTerminalSequences(rows[1]!).includes(expected!));
	} finally { stamps?.(); skin?.(); }
});

// ---------------------------------------------------------------------------
// V0.6-10: stamps carry a date, with the granularity picked by distance from today.
//
// Every fixture below is built with `new Date(year, month, day, hour, minute)`, i.e. a *local* civil
// time, and the reference instant is passed to `formatTimestamp` explicitly. Nothing parses a UTC
// string and nothing reads the wall clock, so these cases classify identically under any `TZ`.
// ---------------------------------------------------------------------------

/** The pinned "now": 2026-11-15 14:32 local. Only its calendar day matters to the classifier. */
const NOW = new Date(2026, 10, 15, 14, 32);
const NOW_MS = NOW.getTime();

/** `NOW`'s local calendar day shifted by `dayOffset`, at `hour:minute`; the constructor normalises. */
function localMillis(dayOffset: number, hour = 14, minute = 32, year = NOW.getFullYear(), month = NOW.getMonth()): number {
	return new Date(year, month, NOW.getDate() + dayOffset, hour, minute).getTime();
}

/** The same local instant as the ISO string Pi's restore path carries. */
function localIso(dayOffset: number, hour = 14, minute = 32, year = NOW.getFullYear(), month = NOW.getMonth()): string {
	return new Date(localMillis(dayOffset, hour, minute, year, month)).toISOString();
}

test("T10.1 today prints the clock alone", () => {
	assert.equal(formatTimestamp(localMillis(0), NOW_MS), "14:32");
});

test("T10.2 yesterday is named, not timed", () => {
	assert.equal(formatTimestamp(localMillis(-1), NOW_MS), "昨天 14:32");
});

test("T10.3 the same year carries month and day, unpadded months and days, padded clock", () => {
	// March 5 is two months back; `3月5日` has no zero padding, `09:05` keeps it.
	assert.equal(formatTimestamp(new Date(NOW.getFullYear(), 2, 5, 9, 5).getTime(), NOW_MS), "3月5日 09:05");
});

test("T10.4 an earlier year carries the year", () => {
	assert.equal(formatTimestamp(localMillis(0, 14, 32, NOW.getFullYear() - 1), NOW_MS), "2025年11月15日 14:32");
});

test("T10.5 23:59 and the next 00:01 are one calendar day apart, not two minutes", () => {
	// Two minutes of elapsed time across midnight: a millisecond comparison would call this today.
	const now = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 1).getTime();
	const lateNight = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 23, 59).getTime();
	assert.equal(formatTimestamp(lateNight, now), "昨天 23:59");
	assert.equal(formatTimestamp(now, now), "00:01");
});

test("T10.6 the year boundary follows the calendar day, not the year", () => {
	const now = new Date(2026, 0, 1, 0, 1).getTime();
	const newYearsEve = new Date(2025, 11, 31, 23, 59).getTime();
	assert.equal(formatTimestamp(newYearsEve, now), "昨天 23:59");
	// Two days later the same instant is last year's, so it needs the full date.
	assert.equal(formatTimestamp(newYearsEve, new Date(2026, 0, 2, 12, 0).getTime()), "2025年12月31日 23:59");
});

test("T10.7 a future timestamp reads as today and never as a future date", () => {
	assert.equal(formatTimestamp(localMillis(1), NOW_MS), "14:32");
	assert.equal(formatTimestamp(localMillis(0, 14, 32, NOW.getFullYear() + 1), NOW_MS), "14:32");
});

test("T10.8 chinese renders like all and does include user messages", () => {
	initTheme();
	const stamp = localIso(0, 14, 32, NOW.getFullYear() - 1);
	const render = (timestamps: ThemeConfig["timestamps"]) => {
		current = config({ timestamps });
		const cleanup = install();
		try {
			return { user: user(stamp).render(40), assistant: assistant(undefined, stamp).render(40) };
		} finally {
			cleanup?.();
		}
	};
	const all = render("all");
	const chinese = render("chinese");
	assert.deepEqual(chinese, all, "all and chinese share one formatter today");
	const off = render("off");
	assert.notDeepEqual(chinese.user, off.user, "chinese must stamp the user row");

	const expected = formatTimestamp(Date.parse(stamp), Date.now());
	assert.ok(expected !== undefined);
	assert.ok(stripTerminalSequences(chinese.user[0]!).endsWith(expected), JSON.stringify(chinese.user[0]));
	assert.ok(stripTerminalSequences(chinese.assistant[0]!).startsWith(expected), JSON.stringify(chinese.assistant[0]));
});

test("T10.9 off leaves the message rows byte for byte identical", () => {
	initTheme();
	const stamp = localIso(-1);
	const assistantBaseline = assistant(undefined, stamp).render(40);
	const userBaseline = user(stamp).render(40);
	current = config({ timestamps: "off" });
	const cleanup = install();
	try {
		assert.deepEqual(assistant(undefined, stamp).render(40), assistantBaseline);
		assert.deepEqual(user(stamp).render(40), userBaseline);
	} finally {
		cleanup?.();
	}
});

test("T10.10 assistant mode leaves user messages alone", () => {
	initTheme();
	const stamp = localIso(-1);
	const baseline = user(stamp).render(40);
	current = config({ timestamps: "assistant" });
	const cleanup = install();
	try {
		assert.deepEqual(user(stamp).render(40), baseline);
		const expected = formatTimestamp(Date.parse(stamp), Date.now());
		assert.ok(expected !== undefined);
		const rows = assistant(undefined, stamp).render(40);
		assert.ok(stripTerminalSequences(rows[0]!).startsWith(expected), JSON.stringify(rows[0]));
	} finally {
		cleanup?.();
	}
});

test("T10.11 the grown stamp still fits 24 and 25 columns without overflow", () => {
	initTheme();
	// A cross-year stamp is the longest form: `2025年11月15日 14:32` is 20 columns.
	const stamp = localIso(0, 14, 32, NOW.getFullYear() - 1);
	const label = formatTimestamp(Date.parse(stamp), Date.now());
	assert.ok(label !== undefined);
	assert.equal(visibleWidth(label), 20, "fixture label width changed");

	for (const width of [TIMESTAMP_MIN_WIDTH, TIMESTAMP_MIN_WIDTH + 1]) {
		current = config();
		const cleanup = install();
		try {
			const assistantRows = assistant(undefined, stamp).render(width);
			const userRows = user(stamp).render(width);
			for (const row of [...assistantRows, ...userRows]) {
				assert.ok(visibleWidth(row) <= width, `row overflows ${width} columns: ${JSON.stringify(row)}`);
			}
			assert.ok(stripTerminalSequences(assistantRows[0]!).includes(label));
			assert.ok(stripTerminalSequences(userRows[0]!).includes(label));
		} finally { cleanup?.(); }
	}
});
