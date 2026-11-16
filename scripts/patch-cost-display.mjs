/**
 * Rewrite the hardcoded `$` in the subagent/delegate cost readouts of pi-subagents and
 * billion-context-pi so they follow open-tui's `cost.currency`.
 *
 * Both packages format those strings themselves — pi-subagents in `bundle/*.js`, billion-context-pi
 * in `dist/index.js` — with a literal `$${…toFixed(4)}` and no config read or formatter hook. The
 * only way to make them follow `cost.currency` is to rewrite the nine call sites in the files Pi
 * actually loads, and the rewrite has to be textual because the chunk filenames change between
 * releases. The injected code must not import from `extensions/open-tui`: the patched packages load
 * in processes where our extension is not guaranteed to be present.
 *
 * `PURE_FORMATTER_SRC` and `CONFIG_READER_SRC` are the literal text written into the bundles and
 * are also compiled here and in the tests, so what is tested is what ships.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Marks a file we already prepended to. */
export const PATCH_MARKER = "/* pi-open-tui:cost-patch v1 */";

/** Mirrors DEFAULT_COST in extensions/open-tui/currency.ts; the tests assert they stay equal. */
export const COST_DEFAULTS = { currency: "usd", usdToCny: 7.15 };
/** Mirrors MIN_USD_TO_CNY / MAX_USD_TO_CNY: out-of-window rates fall back to the default above. */
export const MIN_RATE = 0.01;
export const MAX_RATE = 1000;

/**
 * The single expression all nine sites share: `$${expr.toFixed(4)}` inside a template literal.
 * `expr` is restricted to a plain member path so the pattern cannot swallow unrelated arithmetic.
 */
export const SITE_SOURCE = String.raw`\$\$\{([A-Za-z0-9_.\[\]]+)\.toFixed\(4\)\}`;

/** A fresh pattern per call: a shared `g` regex would carry `lastIndex` between files. */
export function sitePattern() {
	return new RegExp(SITE_SOURCE, "g");
}

/**
 * `(cfg, usd) => string`, dependency-free on purpose. Only the symbol and the conversion change:
 * the four decimals stay, because these readouts are sub-cent amounts and open-tui's own
 * `formatCost` (two decimals, three below 0.1) would print `$0.000` here.
 */
export const PURE_FORMATTER_SRC = `(cfg, usd) => {
	// Only "cny" converts; any other value (a hand-edited config, a missing key) keeps the dollar
	// sign, mirroring currencySymbol() in extensions/open-tui/currency.ts.
	const cny = Boolean(cfg) && cfg.currency === "cny";
	// A non-finite provider figure would print "NaN"; the footer renders it as zero for the same reason.
	const amount = Number.isFinite(usd) ? usd : 0;
	if (!cny) return "$" + amount.toFixed(4);
	// An out-of-window or non-numeric rate is a typo, so it falls back to the shipped default instead
	// of printing an inflated or exponential amount.
	const rate = Number.isFinite(cfg.usdToCny) && cfg.usdToCny >= ${MIN_RATE} && cfg.usdToCny <= ${MAX_RATE} ? cfg.usdToCny : ${COST_DEFAULTS.usdToCny};
	return "¥" + (amount * rate).toFixed(4);
}`;

/**
 * Evaluates to `() => { currency, usdToCny }`. Wrapped in an IIFE so the bundle gets one binding
 * and no globals; the dependencies are passed in because the injected text cannot `import`
 * anything beyond the three namespace imports in the prefix.
 */
export const CONFIG_READER_SRC = `((fs, os, path, defaults) => {
	let cachedStamp = null;
	let cachedValue = null;
	// The patched packages load in a host process whose cwd we do not control, so the path is
	// resolved on every read and an explicit override always wins.
	const configPath = () => {
		if (process.env.PI_OPEN_TUI_CONFIG) return process.env.PI_OPEN_TUI_CONFIG;
		// USERPROFILE first for Windows, HOME for POSIX, os.homedir() as the last resort.
		const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
		return path.join(home, ".pi", "agent", "open-tui.json");
	};
	// A broken config must never break a third-party package's rendering, so every filesystem and
	// JSON step swallows its error and falls through to the shipped defaults.
	const read = () => {
		const file = configPath();
		let stamp = "";
		try {
			const stat = fs.statSync(file);
			// Size joins the mtime because some filesystems stamp whole seconds only, and a settings
			// toggle rewrites the same-length file within one second.
			stamp = String(stat.mtimeMs) + ":" + String(stat.size);
		} catch {
			stamp = "";
		}
		if (cachedStamp !== null && stamp === cachedStamp) return cachedValue;
		let parsed = null;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			parsed = null;
		}
		const cost = parsed && typeof parsed === "object" ? parsed.cost : null;
		const value = cost && typeof cost === "object"
			? { currency: cost.currency, usdToCny: cost.usdToCny }
			: { currency: defaults.currency, usdToCny: defaults.usdToCny };
		cachedStamp = stamp;
		cachedValue = value;
		return value;
	};
	return read;
})(__potFs, __potOs, __potPath, __POT_COST_DEFAULTS)`;

/** Packages whose loaded bundles hardcode the dollar sign. */
export const PACKAGE_NAMES = ["pi-subagents", "billion-context-pi"];

const BACKUP_SUFFIX = ".pi-open-tui.bak";

/**
 * Every site in `source`, with the line it sits on. Surviving sites after a write are the failure
 * mode this tool exists to prevent, so the detection is a first-class export.
 */
export function findRemainingSites(source) {
	const sites = [];
	for (const match of source.matchAll(sitePattern())) {
		const index = match.index ?? 0;
		sites.push({
			line: source.slice(0, index).split("\n").length,
			text: match[0],
			expression: match[1],
		});
	}
	return sites;
}

function rewriteSites(source) {
	// The replacement is assembled by concatenation: `$` and `{` are literal here, and a replacement
	// function's return value gets no `$&`-style processing.
	return source.replace(sitePattern(), (_whole, expression) => "${__potCostFormat(" + expression + ")}");
}

function buildPrefix(newline) {
	return [
		PATCH_MARKER,
		// Namespace imports keep the prefix legal above the file's own import declarations: import
		// declarations are hoisted, so position does not matter.
		'import * as __potFs from "node:fs";',
		'import * as __potOs from "node:os";',
		'import * as __potPath from "node:path";',
		`const __POT_COST_DEFAULTS = ${JSON.stringify(COST_DEFAULTS)};`,
		`const __potCostFormatPure = ${PURE_FORMATTER_SRC};`,
		`const __potReadCostConfig = ${CONFIG_READER_SRC};`,
		// The rewritten call sites pass the amount only, so the config read happens here; the reader
		// memoises it on the file's mtime, which keeps this cheap enough for a per-row readout.
		"const __potCostFormat = (usd) => __potCostFormatPure(__potReadCostConfig(), usd);",
		"",
	].join(newline);
}

function injectPrefix(source, newline) {
	const prefix = buildPrefix(newline);
	// A shebang must stay the first line, and a byte-order mark must stay the first byte.
	const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = bom === "" ? source : source.slice(1);
	if (body.startsWith("#!")) {
		const end = body.indexOf("\n");
		if (end !== -1) return bom + body.slice(0, end + 1) + prefix + body.slice(end + 1);
	}
	return bom + prefix + body;
}

/**
 * `{ code, changed, reason }`. Idempotent: a file that still carries the marker gets its remaining
 * sites rewritten but never a second prefix.
 */
export function patchSource(source) {
	const sites = findRemainingSites(source);
	const marked = source.includes(PATCH_MARKER);
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	if (sites.length === 0) {
		return {
			code: source,
			changed: false,
			reason: marked ? "already patched (marker present, no raw site)" : "no $${…toFixed(4)} site",
		};
	}
	if (marked) {
		return {
			code: rewriteSites(source),
			changed: true,
			reason: `re-patched ${sites.length} site(s) in an already marked file`,
		};
	}
	return {
		code: injectPrefix(rewriteSites(source), newline),
		changed: true,
		reason: `patched ${sites.length} site(s)`,
	};
}

/**
 * Compile the injected strings exactly as written. A syntax error in them would otherwise surface
 * as a broken third-party package at the user's session start, so it fails the tool instead.
 */
function loadInjection() {
	const format = new Function(`return ${PURE_FORMATTER_SRC};`)();
	const read = new Function(
		"__potFs",
		"__potOs",
		"__potPath",
		"__POT_COST_DEFAULTS",
		`return ${CONFIG_READER_SRC};`,
	)(fs, os, path, COST_DEFAULTS);
	return { format, read };
}

function homeDir() {
	return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** `--root`, then the env override, then the two install locations Pi uses on this machine. */
function resolveRoots(explicitRoot) {
	if (explicitRoot) return [path.resolve(explicitRoot)];
	const fromEnv = process.env.PI_OPEN_TUI_PATCH_ROOT;
	if (fromEnv) return [path.resolve(fromEnv)];
	return [path.join(homeDir(), ".pi", "agent", "npm", "node_modules"), "D:/env/npm-global/node_modules"];
}

function findPackageDir(roots, name) {
	for (const root of roots) {
		const dir = path.join(root, name);
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	return null;
}

/**
 * The directory the package actually loads, derived from `package.json` rather than a hardcoded
 * chunk name: pi-subagents exports `./bundle/index.js`, billion-context-pi exports `./dist/index.js`.
 * `src/` is never touched — it is not what Pi runs.
 */
function resolveEntry(packageDir) {
	let manifest = {};
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	} catch {
		manifest = {};
	}
	const exported = manifest.exports;
	const root = exported && typeof exported === "object" ? exported["."] ?? exported : exported;
	const entry =
		typeof root === "string"
			? root
			: root && typeof root === "object"
				? root.import ?? root.default ?? root.require
				: null;
	const relative = typeof entry === "string" ? entry : typeof manifest.main === "string" ? manifest.main : "index.js";
	return {
		dir: path.join(packageDir, path.dirname(relative)),
		label: path.dirname(relative) || ".",
		version: typeof manifest.version === "string" ? manifest.version : "unknown",
	};
}

function collectJsFiles(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			collectJsFiles(full, out);
			continue;
		}
		// Only loaded ESM bundles: `.map` and `.d.ts` are not code Pi evaluates.
		if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

function parseArgs(argv) {
	const options = { mode: "apply", root: null, help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--check" || arg === "--revert" || arg === "--dry-run") {
			const mode = arg.slice(2);
			if (options.mode !== "apply" && options.mode !== mode) {
				throw new Error(`${arg} cannot be combined with another mode flag`);
			}
			options.mode = mode;
		} else if (arg === "--root") {
			const value = argv[index + 1];
			if (!value) throw new Error("--root needs a directory");
			options.root = value;
			index++;
		} else if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

const USAGE = `Usage: node scripts/patch-cost-display.mjs [--check|--revert|--dry-run] [--root <dir>]

Make the pi-subagents and billion-context-pi cost readouts follow cost.currency.

  (no flag)   apply the patch, writing <file>${BACKUP_SUFFIX} once per file
  --check     report only; exit 1 when a loaded bundle still hardcodes \`\$\`
  --dry-run   report what would change, write nothing
  --revert    restore every <file>${BACKUP_SUFFIX} and delete it
  --root      patch the packages found under <dir> instead of the default install location

Environment: PI_OPEN_TUI_PATCH_ROOT (root override), PI_OPEN_TUI_CONFIG (config path for the readout).`;

function relPath(from, file) {
	return path.relative(from, file).split(path.sep).join("/");
}

function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(`patch-cost: ${error instanceof Error ? error.message : String(error)}`);
		console.error(USAGE);
		return 2;
	}
	if (options.help) {
		console.log(USAGE);
		return 0;
	}

	const roots = resolveRoots(options.root);
	console.log(`pi-open-tui cost patch — ${PATCH_MARKER}`);
	const rootReport = roots.map((root) => `${root} (${fs.existsSync(root) ? "exists" : "missing"})`);
	console.log(`roots: ${rootReport.join("; ")}`);

	if (options.mode === "revert") return revert(roots);

	const { format, read } = loadInjection();
	const config = read();
	console.log(`config: ${String(config.currency)} @ ${String(config.usdToCny)}  (1.3660 USD → ${format(config, 1.366)})\n`);

	const write = options.mode === "apply";
	let failed = false;
	let plannedFiles = 0;
	let plannedSites = 0;
	let writtenFiles = 0;

	for (const name of PACKAGE_NAMES) {
		const packageDir = findPackageDir(roots, name);
		if (packageDir === null) {
			// Not installed is normal: report and move on rather than failing a partially set-up machine.
			console.log(`○ ${name}: not installed under any root`);
			continue;
		}
		const entry = resolveEntry(packageDir);
		const targetFiles = collectJsFiles(entry.dir);
		console.log(`● ${name} ${entry.version} — ${path.join(packageDir, entry.label)} (${targetFiles.length} .js file(s))`);

		let siteFiles = 0;
		let packageSites = 0;
		let alreadyPatched = 0;
		for (const file of targetFiles) {
			const source = fs.readFileSync(file, "utf8");
			const sites = findRemainingSites(source);
			if (source.includes(PATCH_MARKER)) alreadyPatched++;
			if (sites.length === 0) continue;
			siteFiles++;
			packageSites += sites.length;
			plannedFiles++;
			plannedSites += sites.length;
			const label = relPath(packageDir, file);
			for (const site of sites) {
				console.log(`    ${label}:${site.line}  \`${site.text}\` → \`\${__potCostFormat(${site.expression})}\``);
			}
			if (!write) continue;
			// The backup is written once, before the first patch: a second run must not overwrite the
			// original with a patched copy.
			const backup = file + BACKUP_SUFFIX;
			if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
			const result = patchSource(source);
			fs.writeFileSync(file, result.code, "utf8");
			writtenFiles++;
			console.log(`    → ${label}: ${result.reason}, backup ${path.basename(backup)}`);
		}

		console.log(`    ${packageSites} site(s) in ${siteFiles} file(s), ${alreadyPatched} already patched`);

		if (!write) {
			// Nothing was written, so remaining sites are the current state: --check treats them as the
			// failure, --dry-run only reports them.
			if (packageSites > 0 && options.mode === "check") failed = true;
			continue;
		}

		// A silent no-op is the bug this check exists to catch: an upstream reformat would leave the
		// readout in dollars and nobody would notice until a CNY user compared the two panels.
		const remaining = [];
		for (const file of targetFiles) {
			for (const site of findRemainingSites(fs.readFileSync(file, "utf8"))) {
				remaining.push(`${relPath(packageDir, file)}:${site.line}  ${site.text}`);
			}
		}
		if (remaining.length > 0) {
			failed = true;
			console.error(`✖ ${name}: ${remaining.length} hardcoded cost site(s) survived the patch:`);
			for (const line of remaining) console.error(`    ${line}`);
			console.error("  The expression shape changed upstream. Update SITE_SOURCE in scripts/patch-cost-display.mjs.");
		}
		if (siteFiles === 0 && alreadyPatched === 0) {
			// Not a failure: upstream may have fixed the hardcoding. It is still worth saying out loud.
			console.log(`    ! no hardcoded cost site found — verify the readout by hand after an upgrade`);
		}
	}

	if (options.mode === "dry-run") {
		console.log(`\n[dry-run] ${plannedFiles} file(s) / ${plannedSites} site(s) would be patched; nothing was written`);
	} else {
		console.log(`\npatched ${writtenFiles} file(s) / ${plannedSites} site(s)`);
	}
	if (options.mode === "check") {
		// Exit 1 so CI and the user can tell "already patched" from "needs re-running".
		console.log(failed ? "\n✖ unpatched hardcoded cost sites remain — run: npm run patch:cost" : "\n✔ every hardcoded cost site is patched");
	}
	return failed ? 1 : 0;
}

function revert(roots) {
	let failed = false;
	let restored = 0;
	for (const name of PACKAGE_NAMES) {
		const packageDir = findPackageDir(roots, name);
		if (packageDir === null) {
			console.log(`○ ${name}: not installed under any root`);
			continue;
		}
		const entry = resolveEntry(packageDir);
		console.log(`● ${name} — ${path.join(packageDir, entry.label)}`);
		for (const file of collectJsFiles(entry.dir)) {
			const backup = file + BACKUP_SUFFIX;
			const label = relPath(packageDir, file);
			if (fs.existsSync(backup)) {
				// Buffer to Buffer: the restore has to be byte-for-byte, not a re-encoding.
				fs.writeFileSync(file, fs.readFileSync(backup));
				fs.unlinkSync(backup);
				restored++;
				console.log(`    ← ${label}: restored, backup removed`);
				continue;
			}
			if (fs.readFileSync(file, "utf8").includes(PATCH_MARKER)) {
				// Patched with no backup cannot be undone; say so instead of leaving a half state.
				console.error(`    ✖ ${label}: patched but ${path.basename(backup)} is missing`);
				failed = true;
			}
		}
	}
	console.log(`\nrestored ${restored} file(s)`);
	return failed ? 1 : 0;
}

// Only run when invoked directly: the tests import the helpers above.
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}

export { main };
