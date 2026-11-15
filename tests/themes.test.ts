import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Theme presets live in themes/*.json and are validated against the schema that
// ships with Pi itself (an optional peer dependency of this package). The
// schema is read from node_modules instead of being copied, so a schema change
// in a supported Pi release is caught here instead of silently drifting.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_PACKAGE = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const SCHEMA_PATH = join(PI_PACKAGE, "schemas", "theme.schema.json");
const DARK_THEME_PATH = join(PI_PACKAGE, "dist", "modes", "interactive", "theme", "dark.json");
const THEMES_DIR = join(ROOT, "themes");

const NAMES = ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "rose-pine-moon"] as const;
const BASE_TOKEN_COUNT = 56;

type JsonSchema = Record<string, unknown>;
type ThemeColors = Record<string, string | number>;
interface ThemeFile {
	name: string;
	appearance?: "dark" | "light";
	vars?: ThemeColors;
	colors: ThemeColors;
	export?: ThemeColors;
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as JsonSchema;
const dark = JSON.parse(readFileSync(DARK_THEME_PATH, "utf8")) as ThemeFile;
const BASE_TOKENS = Object.keys(dark.colors);

function readTheme(name: string): ThemeFile {
	return JSON.parse(readFileSync(join(THEMES_DIR, `${name}.json`), "utf8")) as ThemeFile;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validation (draft 2020-12 subset used by theme.schema.json)
//
// Only the keywords the theme schema actually uses are implemented: $ref into
// $defs, anyOf, type, const, pattern, minimum/maximum, properties, required,
// patternProperties and additionalProperties. That is enough to validate a
// theme without pulling a validator dependency into the package.
// ---------------------------------------------------------------------------

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
	assert.ok(ref.startsWith("#/"), `unsupported $ref: ${ref}`);
	let node: unknown = root;
	for (const segment of ref.slice(2).split("/")) {
		node = (node as JsonSchema)[segment];
		assert.ok(node, `unresolvable $ref: ${ref}`);
	}
	return node as JsonSchema;
}

function validate(node: JsonSchema, value: unknown, path: string, root: JsonSchema): string[] {
	if (node.$ref) {
		return validate(resolveRef(root, node.$ref as string), value, path, root);
	}
	if (Array.isArray(node.anyOf)) {
		const failures = (node.anyOf as JsonSchema[]).map((sub) => validate(sub, value, path, root));
		if (failures.some((errors) => errors.length === 0)) {
			return [];
		}
		const detail = failures.map((errors) => errors[0] ?? "no reason").join("; ");
		return [`${path}: ${JSON.stringify(value)} matches none of the allowed forms (${detail})`];
	}

	const errors: string[] = [];
	const type = node.type;

	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return [`${path}: expected object, got ${JSON.stringify(value)}`];
		}
		const record = value as Record<string, unknown>;
		for (const key of (node.required as string[] | undefined) ?? []) {
			if (!(key in record)) {
				errors.push(`${path}: missing required property "${key}"`);
			}
		}
		const properties = (node.properties as Record<string, JsonSchema> | undefined) ?? {};
		for (const [key, sub] of Object.entries(properties)) {
			if (key in record) {
				errors.push(...validate(sub, record[key], `${path}.${key}`, root));
			}
		}
		const patternProperties = (node.patternProperties as Record<string, JsonSchema> | undefined) ?? {};
		for (const [key, entry] of Object.entries(record)) {
			let known = key in properties;
			for (const [pattern, sub] of Object.entries(patternProperties)) {
				if (new RegExp(pattern).test(key)) {
					known = true;
					errors.push(...validate(sub, entry, `${path}.${key}`, root));
				}
			}
			if (!known && node.additionalProperties === false) {
				errors.push(`${path}: unexpected property "${key}"`);
			}
		}
		return errors;
	}

	if (type === "string") {
		if (typeof value !== "string") {
			return [`${path}: expected string, got ${JSON.stringify(value)}`];
		}
		if (typeof node.const === "string" && value !== node.const) {
			errors.push(`${path}: expected "${node.const}", got "${value}"`);
		}
		if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
			errors.push(`${path}: "${value}" does not match pattern ${node.pattern}`);
		}
		return errors;
	}

	if (type === "integer") {
		if (!Number.isInteger(value)) {
			return [`${path}: expected integer, got ${JSON.stringify(value)}`];
		}
		const numeric = value as number;
		if (typeof node.minimum === "number" && numeric < node.minimum) {
			errors.push(`${path}: ${numeric} is below minimum ${node.minimum}`);
		}
		if (typeof node.maximum === "number" && numeric > node.maximum) {
			errors.push(`${path}: ${numeric} is above maximum ${node.maximum}`);
		}
		return errors;
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Colour resolution and WCAG contrast
//
// Variables are resolved to their concrete value before measuring. Only hex
// values are measured: oklch()/okhsl() conversion is not implemented here, so
// the gate below requires the critical pairs to resolve to hex and reports any
// pair it could not measure instead of silently passing it. The shipped presets
// use hex in `vars`, so every critical pair is measured.
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FUNCTIONAL_PATTERN = /^(oklch|okhsl|rgb|hsl|color)\(/i;

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function parseHex(value: string): Rgb | null {
	const match = HEX_PATTERN.exec(value.trim());
	if (!match) {
		return null;
	}
	const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
	return {
		r: Number.parseInt(digits.slice(0, 2), 16),
		g: Number.parseInt(digits.slice(2, 4), 16),
		b: Number.parseInt(digits.slice(4, 6), 16),
	};
}

/** Follows variable references (with or without a leading `$`) to a concrete value. */
function resolveColor(theme: ThemeFile, key: string): string | number {
	let current: string | number | undefined = theme.colors[key] ?? theme.export?.[key];
	for (let hops = 0; current !== undefined; hops += 1) {
		if (hops > 16) {
			assert.fail(`variable chain for "${key}" does not terminate`);
		}
		if (typeof current !== "string") {
			return current;
		}
		const reference: string = current.startsWith("$") ? current.slice(1) : current;
		const isConcrete =
			reference === "" ||
			HEX_PATTERN.test(reference) ||
			FUNCTIONAL_PATTERN.test(reference) ||
			/^\d+$/.test(reference);
		if (isConcrete) {
			return reference;
		}
		const next: string | number | undefined = theme.vars?.[reference];
		if (next === undefined) {
			assert.fail(`"${key}" references unknown variable "${reference}"`);
		}
		current = next;
	}
	assert.fail(`"${key}" is not defined by the theme`);
}

function channelToLinear(channel: number): number {
	const scaled = channel / 255;
	return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance for an sRGB colour. */
function relativeLuminance({ r, g, b }: Rgb): number {
	return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG 2.x contrast ratio, always >= 1. */
function contrastRatio(a: Rgb, b: Rgb): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Critical pairs: secondary text against the page background, muted text inside
 * user message cards, and tool output on the success tint. `export.pageBg` is
 * the theme's declared background (Pi themes have no `background` token).
 */
const CRITICAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["text", "pageBg"],
	["muted", "pageBg"],
	["dim", "pageBg"],
	["text", "userMessageBg"],
	["muted", "userMessageBg"],
	["toolOutput", "toolSuccessBg"],
];
const MIN_CONTRAST = 3;

// ---------------------------------------------------------------------------

test("theme schema and built-in skeleton keep the shape these presets target", () => {
	assert.deepEqual(schema.required, ["name", "colors"]);
	assert.equal(BASE_TOKENS.length, BASE_TOKEN_COUNT);
});

test("each theme validates against the Pi theme schema", () => {
	for (const name of NAMES) {
		const theme = readTheme(name);
		assert.deepEqual(validate(schema, theme, name, schema), [], `${name} does not satisfy theme.schema.json`);
	}
});

test("each theme declares its own name and a dark appearance", () => {
	for (const name of NAMES) {
		const theme = readTheme(name);
		assert.equal(theme.name, name);
		assert.equal(theme.appearance, "dark");
	}
});

test(`each theme defines all ${BASE_TOKEN_COUNT} base tokens`, () => {
	for (const name of NAMES) {
		const theme = readTheme(name);
		const missing = BASE_TOKENS.filter((token) => !(token in theme.colors));
		const extra = Object.keys(theme.colors).filter((token) => !BASE_TOKENS.includes(token));
		assert.deepEqual(missing, [], `${name} is missing tokens`);
		assert.deepEqual(extra, [], `${name} has tokens the built-in dark theme does not define`);
	}
});

test("every theme colour resolves to a concrete value", () => {
	for (const name of NAMES) {
		const theme = readTheme(name);
		const unresolved: string[] = [];
		for (const scope of [theme.colors, theme.export ?? {}]) {
			for (const [key, value] of Object.entries(scope)) {
				if (typeof value !== "string") {
					continue;
				}
				const reference = value.startsWith("$") ? value.slice(1) : value;
				const isConcrete =
					reference === "" ||
					HEX_PATTERN.test(reference) ||
					FUNCTIONAL_PATTERN.test(reference) ||
					/^\d+$/.test(reference);
				if (!isConcrete && theme.vars?.[reference] === undefined) {
					unresolved.push(`${key} -> ${value}`);
				}
			}
		}
		assert.deepEqual(unresolved, [], `${name} has unresolvable colour references`);
		// Every colour must also survive full resolution, catching var -> var cycles.
		for (const key of [...Object.keys(theme.colors), ...Object.keys(theme.export ?? {})]) {
			resolveColor(theme, key);
		}
	}
});

test(`critical pairs meet the ${MIN_CONTRAST}:1 contrast gate`, () => {
	for (const name of NAMES) {
		const theme = readTheme(name);
		const unmeasured: string[] = [];
		for (const [foregroundKey, backgroundKey] of CRITICAL_PAIRS) {
			const foreground = resolveColor(theme, foregroundKey);
			const background = resolveColor(theme, backgroundKey);
			const foregroundRgb = typeof foreground === "string" ? parseHex(foreground) : null;
			const backgroundRgb = typeof background === "string" ? parseHex(background) : null;
			if (!foregroundRgb || !backgroundRgb) {
				unmeasured.push(`${foregroundKey}=${String(foreground)} on ${backgroundKey}=${String(background)}`);
				continue;
			}
			const ratio = contrastRatio(foregroundRgb, backgroundRgb);
			assert.ok(
				ratio >= MIN_CONTRAST,
				`${name}: ${foregroundKey} on ${backgroundKey} is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`,
			);
		}
		assert.deepEqual(
			unmeasured,
			[],
			`${name}: contrast gate only measures hex colours (oklch/okhsl parsing is deliberately not implemented), so these pairs must be hex`,
		);
	}
});
