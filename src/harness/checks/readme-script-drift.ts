// readme-script-drift — markdown docs referencing npm scripts that don't
// exist in package.json.
//
// Bug class: docs say `npm run foo` but the script was renamed / removed —
// `package_json_script_paths` validates the scripts→files direction; nothing
// validated the reverse docs→scripts direction. A stale command in a README
// is the first thing a cold agent (or human) runs and the first thing that
// fails.
//
// VERIFY-ONLY shape (like `gitignored_written_config`): the detector is 3-arg —
// it needs a `getScripts` resolver backed by package.json lookup, which the
// registry's uniform `(content, filePath) => InlineMatch[]` PostToolUse
// contract can't supply. Production wiring injects
// `resolveNearestPackageScripts` (exported below); tests inject a mock.
//
// FP posture (the lower-FP option, deliberately): a code fence that clones or
// `cd`s into another directory is describing ANOTHER repo's setup, so every
// npm reference inside that fence is skipped. Prose references and ordinary
// fences are checked against the NEAREST package.json walking up from the
// markdown file (monorepo docs resolve to their own package). Unresolvable /
// malformed package.json fails open to no findings.
//
// Check id: readme_script_drift
// Advisory only — deterministic extraction, but nearest-manifest resolution
// is a heuristic in monorepos.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InlineMatch } from "./shared.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

/** Markdown extensions this check scans. */
const MARKDOWN_EXT_RE = /\.(?:md|markdown)$/i;

/** npm builtins runnable via `npm run` without a scripts entry. */
const NPM_RUN_BUILTINS = new Set(["env"]);

/**
 * `npm run <script>` / `npm run-script <script>` — the script token must not
 * start with `-` (flags like `--help` / `--if-present` are not script names).
 */
const NPM_RUN_RE = /\bnpm\s+run(?:-script)?\s+([A-Za-z0-9_:.][A-Za-z0-9_:.-]*)/g;

/** `npm test` — sugar for the "test" script. */
const NPM_TEST_RE = /\bnpm\s+test\b/g;

/** Fence delimiters (``` or ~~~, optionally indented); captures the info word. */
const FENCE_DELIM_RE = /^\s*(?:```|~~~)\s*([A-Za-z0-9+-]*)/;

/**
 * Fence info strings marking DATA, not commands — an `npm run …` inside a
 * json/yaml fence is a quoted config/message string (dogfood-observed FP
 * class: rule suggestions embedded in JSON snippets), not a command the
 * reader is told to run.
 */
const DATA_FENCE_LANGS = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "html", "diff", "csv"]);

/** Lines that mark a fence as foreign-repo setup: `git clone …` or `cd <dir>`. */
const FOREIGN_SETUP_LINE_RE = /(?:\bgit\s+clone\b|^\s*(?:\$\s*)?cd\s+\S)/;

// ─── Fence tracking ──────────────────────────────────────────────────────────

interface FenceMap {
	/** Per-line fence id, or null when the line is outside any fence. */
	fenceIdByLine: (number | null)[];
	/**
	 * Fence ids to skip: foreign-repo setup (`git clone` / `cd` line inside)
	 * or a data-language info string (json/yaml/… — quoted strings, not commands).
	 */
	foreignFences: Set<number>;
}

/**
 * One pass over the lines: assign each line the id of its enclosing code
 * fence (delimiter lines included), and record which fences must be skipped
 * (data-language fences, foreign-repo setup fences).
 */
function mapFences(lines: string[]): FenceMap {
	const fenceIdByLine: (number | null)[] = [];
	const foreignFences = new Set<number>();
	let currentFence: number | null = null;
	let nextFenceId = 0;

	for (const line of lines) {
		const delim = FENCE_DELIM_RE.exec(line);
		if (delim !== null) {
			if (currentFence === null) {
				currentFence = nextFenceId++;
				fenceIdByLine.push(currentFence);
				const lang = (delim[1] ?? "").toLowerCase();
				if (DATA_FENCE_LANGS.has(lang)) foreignFences.add(currentFence);
			} else {
				fenceIdByLine.push(currentFence); // closing delimiter belongs to the fence
				currentFence = null;
			}
			continue;
		}
		fenceIdByLine.push(currentFence);
		if (currentFence !== null && FOREIGN_SETUP_LINE_RE.test(line)) {
			foreignFences.add(currentFence);
		}
	}
	return { fenceIdByLine, foreignFences };
}

// ─── Per-line reference extraction ───────────────────────────────────────────

/** Extract the npm-script names referenced on one line (deduped). */
function scriptRefsOnLine(line: string): Set<string> {
	const refs = new Set<string>();
	NPM_RUN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = NPM_RUN_RE.exec(line)) !== null) {
		const name = m[1];
		if (name !== undefined && !NPM_RUN_BUILTINS.has(name)) refs.add(name);
	}
	NPM_TEST_RE.lastIndex = 0;
	if (NPM_TEST_RE.test(line)) refs.add("test");
	return refs;
}

/**
 * Push findings for one markdown line's npm-script references into `matches`
 * (mutated in place), skipping refs already satisfied by `scripts`. Stops
 * early once `matches` reaches {@link MAX_MATCHES_PER_FILE}.
 */
function collectLineDrift(
	line: string,
	lineNumber: number,
	scripts: ReadonlySet<string>,
	matches: InlineMatch[],
): void {
	for (const script of scriptRefsOnLine(line)) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		if (scripts.has(script)) continue;
		const command = script === "test" && !line.includes("npm run") ? "npm test" : `npm run ${script}`;
		matches.push({
			line: lineNumber,
			text: `readme_script_drift: "${command}" references script "${script}" missing from package.json scripts — ${line.trim().slice(0, REPORT_LINE_TRUNC)}`,
		});
	}
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect `npm run <script>` / `npm test` references in a markdown file whose
 * script is absent from the resolved package.json `scripts`.
 *
 * Check id: `readme_script_drift`
 *
 * `getScripts` is INJECTED — in production it is
 * {@link resolveNearestPackageScripts}, in unit tests a mock. A null result
 * (no resolvable / parseable package.json) fails open to no findings.
 */
export function detectReadmeScriptDrift(
	content: string,
	filePath: string,
	getScripts: (markdownPath: string) => ReadonlySet<string> | null,
): InlineMatch[] {
	if (!MARKDOWN_EXT_RE.test(filePath)) return [];

	const scripts = getScripts(filePath);
	if (scripts === null) return []; // no manifest context → fail open

	const lines = content.split("\n");
	const { fenceIdByLine, foreignFences } = mapFences(lines);
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const fenceId = fenceIdByLine[i] ?? null;
		if (fenceId !== null && foreignFences.has(fenceId)) continue; // data fence / other repo's setup

		const line = lines[i] ?? "";
		collectLineDrift(line, i + 1, scripts, matches);
	}
	return matches;
}

// ─── Production resolver ─────────────────────────────────────────────────────

/**
 * Read the `scripts` keys of one package.json. Returns null when the manifest
 * is unreadable, malformed, or carries no `scripts` object (fail-open).
 */
function readManifestScriptNames(manifestPath: string): ReadonlySet<string> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const scripts =
			typeof parsed === "object" && parsed !== null
				? (parsed as { scripts?: unknown }).scripts
				: undefined;
		if (typeof scripts !== "object" || scripts === null) return null;
		return new Set(Object.keys(scripts));
	} catch {
		return null; // malformed manifest → fail open
	}
}

/**
 * Resolve the `scripts` keys of the NEAREST package.json walking up from the
 * markdown file's directory, stopping at `stopDir` (the repo root / verify
 * cwd — never walk above it). Returns null when no package.json is found
 * within bounds or the nearest one is unreadable / malformed (fail-open).
 */
export function resolveNearestPackageScripts(
	markdownPath: string,
	stopDir: string,
): ReadonlySet<string> | null {
	const stop = resolve(stopDir);
	let dir = resolve(dirname(markdownPath));

	// Walk up until (and including) stopDir; bail if we start outside it.
	if (dir !== stop && !dir.startsWith(stop + "/")) return null;

	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) return readManifestScriptNames(manifest);
		if (dir === stop) return null;
		const parent = dirname(dir);
		if (parent === dir) return null; // filesystem root safety stop
		dir = parent;
	}
}
