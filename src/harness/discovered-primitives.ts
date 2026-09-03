// ============================================================
// Interlinked Harness — Defensive-primitive coverage detector
// ============================================================
// Adaptation of the curl `curlx_str_number` lesson from the Mythos
// security analysis blog: once a project has adopted a defensive
// wrapper around an unsafe builtin (e.g. `safeParseInt` wrapping
// `parseInt`), every bare call to the underlying builtin is a
// missed opportunity to use the wrapper. The harness DISCOVERS the
// project's chosen primitives by scanning the codebase, caches the
// finding, and then ratchets violations like
// `non_null_assertion_ratchet`: any post-edit increase in bare
// builtin calls is flagged. Decreases pass silently.
//
// Per feedback_harness_deterministic_only: discovery is regex+
// heuristic over file contents — no LLM, no runtime behavior. The
// ratchet semantics make it tolerant of regex undercount: a stable
// miscount doesn't fire as long as the count doesn't INCREASE.

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { nonNull } from "../lib/non-null.js";

import {
	cachePath,
	filterDisabled,
	listSourceFiles,
	loadCache,
	saveCache,
} from "./discovered-primitives-fs.js";

// Re-export the filesystem-I/O leaf helpers so the module's public
// surface (and existing import paths) is unchanged after extraction.
export { cachePath, listSourceFiles, loadCache, saveCache };

/** A defensive primitive the harness has detected in the project. */
export interface DiscoveredPrimitive {
	/** Wrapper function name (e.g. "safeParseInt"). */
	wrapperName: string;
	/** Unsafe builtin the wrapper supersedes (e.g. "parseInt"). */
	unsafeBuiltin: string;
	/** Number of call-sites for the wrapper repo-wide. */
	callSiteCount: number;
	/** Relative path to the file declaring the wrapper. */
	declarationFile: string;
	/** Unix-ms when this primitive was last discovered. */
	discoveredAt: number;
}

/** Cache file shape — written to `.interlinked/discovered-primitives.json`. */
export interface DiscoveryCache {
	/** Schema version. Bump when the shape changes. */
	version: 1;
	/** Unix-ms when discovery last ran. */
	discoveredAt: number;
	/** Active primitives. */
	primitives: DiscoveredPrimitive[];
	/** Per-wrapper opt-out list — user can disable a discovered
	 *  primitive's enforcement without re-running discovery. */
	disabled: string[];
}

/** Threshold below which a wrapper isn't considered a "primitive."
 *  Tuned to be high enough that one-off helpers don't count, low
 *  enough that genuine project conventions land. */
export const PRIMITIVE_CALL_SITE_THRESHOLD = 10;

/** Cache TTL — re-discover at most once per day per session.
 *  Public API: exposed for callers that want a non-default TTL
 *  (e.g. CI-driven runs that want fresh discovery every push). */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

interface UnsafeBuiltin {
	/** The canonical name we display. */
	name: string;
	/** Regex matching a bare call to this builtin. */
	callRegex: RegExp;
	/** Hint words that suggest a wrapper around this builtin. */
	wrapperHints: string[];
}

/** Unsafe builtins we recognize and can discover wrappers for. Each
 *  pattern uses non-`.|\w` lookbehind so we don't double-count method
 *  accesses (`foo.parseInt(` is not a global `parseInt` call). */
const UNSAFE_BUILTINS: UnsafeBuiltin[] = [
	{
		name: "parseInt",
		callRegex: /(?<![.\w$])parseInt\s*\(/g,
		wrapperHints: ["parse", "to", "int", "number", "safe"],
	},
	{
		name: "parseFloat",
		callRegex: /(?<![.\w$])parseFloat\s*\(/g,
		wrapperHints: ["parse", "to", "float", "number", "safe"],
	},
	{
		name: "Number",
		callRegex: /(?<![.\w$])Number\s*\(/g,
		wrapperHints: ["to", "number", "safe", "parse"],
	},
	{
		name: "JSON.parse",
		callRegex: /\bJSON\s*\.\s*parse\s*\(/g,
		wrapperHints: ["parse", "decode", "load", "safe", "from"],
	},
	{
		name: "eval",
		callRegex: /(?<![.\w$])eval\s*\(/g,
		wrapperHints: ["eval", "exec", "run", "safe"],
	},
	{
		name: "child_process.exec",
		callRegex: /\b(?:child_process\s*\.\s*)?exec(?:Sync)?\s*\(/g,
		wrapperHints: ["exec", "run", "shell", "spawn", "safe"],
	},
	{
		name: "fetch",
		callRegex: /(?<![.\w$])fetch\s*\(/g,
		wrapperHints: ["fetch", "request", "http", "api", "safe", "client"],
	},
	{
		name: "setTimeout-string",
		// setTimeout/setInterval with a string arg → silent eval. Match
		// a quote opening immediately after the paren.
		callRegex: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
		wrapperHints: ["timeout", "schedule", "delay"],
	},
];

/** Find candidate wrapper-function declarations in `content` that
 *  call the given unsafe builtin in their body. Returns the wrapper
 *  names.
 *
 *  Heuristic match: function/const declarations whose body contains
 *  the builtin call AND whose name contains any of the builtin's
 *  hint words (case-insensitive). Hints filter out unrelated
 *  functions that incidentally call the builtin. */
export function findWrappersInContent(
	content: string,
	builtin: UnsafeBuiltin,
): string[] {
	const names: string[] = [];
	// Strip block comments so commented-out examples don't count.
	const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "");

	builtin.callRegex.lastIndex = 0;
	if (!builtin.callRegex.test(stripped)) return names;

	const fnDeclRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*[<(]/g;
	const arrowDeclRe =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]+>\s*)?\(/g;

	const candidates: { name: string; declIdx: number }[] = [];
	for (const re of [fnDeclRe, arrowDeclRe]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(stripped);
		while (m !== null) {
			candidates.push({ name: nonNull(m[1]), declIdx: m.index });
			m = re.exec(stripped);
		}
	}

	for (const c of candidates) {
		const lname = c.name.toLowerCase();
		const hasHint = builtin.wrapperHints.some((h) => lname.includes(h));
		if (!hasHint) continue;
		// Window of ~4000 chars after the declaration — bounded cost.
		const window = stripped.slice(c.declIdx, c.declIdx + 4000);
		builtin.callRegex.lastIndex = 0;
		if (builtin.callRegex.test(window) && !names.includes(c.name)) {
			names.push(c.name);
		}
	}
	return names;
}

/** Count bare calls to the unsafe builtin in `content`, excluding
 *  calls that appear inside any of the named wrapper functions
 *  themselves (so the wrapper's own implementation doesn't count
 *  against it). Comments and string literals are scrubbed. */
export function countBareBuiltinCalls(
	content: string,
	builtin: UnsafeBuiltin,
	wrapperNames: string[],
): number {
	// Strip block and line comments.
	let stripped = content
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
	// Best-effort string-literal scrub: replace contents of strings so
	// embedded `parseInt(` inside a string doesn't count.
	stripped = stripped
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");

	// Excise each wrapper's body so internal builtin calls are skipped.
	for (const name of wrapperNames) {
		stripped = eraseWrapperBodies(stripped, name);
	}

	builtin.callRegex.lastIndex = 0;
	let count = 0;
	while (builtin.callRegex.exec(stripped) !== null) count++;
	return count;
}

/** Replace every occurrence of `name`'s function/arrow body in
 *  `stripped` with spaces (so indices don't shift), for each
 *  declaration of `name` found. Used to excise a wrapper's own
 *  implementation before counting bare builtin calls. */
function eraseWrapperBodies(stripped: string, name: string): string {
	const declRe = new RegExp(
		`(?:function\\s+${escapeRegex(name)}\\s*[<(]|\\b(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*(?:async\\s*)?(?:<[^>]+>\\s*)?\\()`,
		"g",
	);
	let m: RegExpExecArray | null = declRe.exec(stripped);
	while (m !== null) {
		const start = m.index;
		const bodyOpen = stripped.indexOf("{", start);
		if (bodyOpen === -1) {
			m = declRe.exec(stripped);
			continue;
		}
		const bodyEnd = findMatchingBraceEnd(stripped, bodyOpen);
		// Replace body with spaces so indices don't shift.
		stripped =
			stripped.slice(0, bodyOpen) +
			" ".repeat(bodyEnd - bodyOpen) +
			stripped.slice(bodyEnd);
		declRe.lastIndex = bodyEnd;
		m = declRe.exec(stripped);
	}
	return stripped;
}

/** Given the index of an opening `{`, return the index just past
 *  its matching closing `}` (brace-depth scan). */
function findMatchingBraceEnd(stripped: string, bodyOpen: number): number {
	let depth = 1;
	let i = bodyOpen + 1;
	while (i < stripped.length && depth > 0) {
		const ch = stripped[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	return i;
}

/** Run a full discovery pass over the repo. Returns the list of
 *  detected primitives (those meeting the call-site threshold). */
type WrapperStats = { callSites: number; declarationFiles: Set<string> };
type PerBuiltin = Map<string, Map<string, WrapperStats>>;

/** Pass 1: read all source files, find wrapper declarations per
 *  unsafe builtin. Returns the per-builtin bucket map plus a content
 *  cache used in pass 2 to avoid re-reading files. */
function findWrappers(files: string[]): { perBuiltin: PerBuiltin; contents: Map<string, string> } {
	const perBuiltin: PerBuiltin = new Map();
	const contents = new Map<string, string>();
	for (const file of files) {
		const content = tryReadFile(file);
		if (content === null) continue;
		contents.set(file, content);
		registerWrappersFromFile(content, file, perBuiltin);
	}
	return { perBuiltin, contents };
}

function tryReadFile(file: string): string | null {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function registerWrappersFromFile(
	content: string,
	file: string,
	perBuiltin: PerBuiltin,
): void {
	for (const builtin of UNSAFE_BUILTINS) {
		const wrappers = findWrappersInContent(content, builtin);
		if (wrappers.length === 0) continue;
		const bucket = getOrCreate(perBuiltin, builtin.name, () => new Map());
		for (const w of wrappers) {
			const stats = getOrCreate(bucket, w, () => ({
				callSites: 0,
				declarationFiles: new Set<string>(),
			}));
			stats.declarationFiles.add(file);
		}
	}
}

function getOrCreate<K, V>(m: Map<K, V>, k: K, make: () => V): V {
	const existing = m.get(k);
	if (existing !== undefined) return existing;
	const fresh = make();
	m.set(k, fresh);
	return fresh;
}

/** Pass 2: count repo-wide call-sites for each wrapper, excluding
 *  the declaration sites themselves. Mutates `perBuiltin` in place. */
function countCallSites(perBuiltin: PerBuiltin, contents: Map<string, string>): void {
	for (const [, bucket] of perBuiltin) {
		for (const [wrapperName, stats] of bucket) {
			stats.callSites = countWrapperCallSitesAcrossFiles(wrapperName, contents);
		}
	}
}

function countWrapperCallSitesAcrossFiles(
	wrapperName: string,
	contents: Map<string, string>,
): number {
	const escaped = escapeRegex(wrapperName);
	const callRe = new RegExp(`(?<![.\\w$])${escaped}\\s*\\(`, "g");
	const declRe = new RegExp(`\\bfunction\\s+${escaped}\\s*[<(]`, "g");
	let total = 0;
	for (const [, content] of contents) {
		total += countRegexHits(content, callRe) - countRegexHits(content, declRe);
	}
	return total;
}

function countRegexHits(content: string, re: RegExp): number {
	re.lastIndex = 0;
	let n = 0;
	while (re.exec(content) !== null) n++;
	return n;
}

/** Pass 3: pick the winning wrapper per builtin (highest call-site
 *  count, threshold-gated) and produce the final primitive list. */
function pickWinners(
	perBuiltin: PerBuiltin,
	repoRoot: string,
	now: number,
): DiscoveredPrimitive[] {
	const out: DiscoveredPrimitive[] = [];
	for (const [builtinName, bucket] of perBuiltin) {
		const winner = pickWinnerFromBucket(bucket);
		if (!winner) continue;
		const declFile = [...winner.stats.declarationFiles][0] || "";
		out.push({
			wrapperName: winner.name,
			unsafeBuiltin: builtinName,
			callSiteCount: winner.stats.callSites,
			declarationFile: declFile ? relative(repoRoot, declFile) : "",
			discoveredAt: now,
		});
	}
	return out;
}

function pickWinnerFromBucket(
	bucket: Map<string, WrapperStats>,
): { name: string; stats: WrapperStats } | null {
	let best: { name: string; stats: WrapperStats } | null = null;
	for (const [name, stats] of bucket) {
		if (stats.callSites < PRIMITIVE_CALL_SITE_THRESHOLD) continue;
		if (!best || stats.callSites > best.stats.callSites) best = { name, stats };
	}
	return best;
}

export function discoverPrimitives(
	repoRoot: string,
	now: number = Date.now(),
): DiscoveredPrimitive[] {
	const files = listSourceFiles(repoRoot);
	if (files.length === 0) return [];
	const { perBuiltin, contents } = findWrappers(files);
	countCallSites(perBuiltin, contents);
	return pickWinners(perBuiltin, repoRoot, now);
}

/** Refresh discovery if the cache is missing or stale. Returns the
 *  active primitives — discovered MINUS the user's disabled list. */
export function refreshIfStale(
	repoRoot: string,
	now: number = Date.now(),
	ttlMs: number = DISCOVERY_TTL_MS,
): DiscoveredPrimitive[] {
	const cache = loadCache(repoRoot);
	if (cache && now - cache.discoveredAt < ttlMs) {
		return filterDisabled(cache);
	}
	const prims = discoverPrimitives(repoRoot);
	const disabled = cache?.disabled || [];
	saveCache(repoRoot, {
		version: 1,
		discoveredAt: now,
		primitives: prims,
		disabled,
	});
	const dset = new Set(disabled);
	return prims.filter((p) => !dset.has(p.wrapperName));
}

/** Count bare unsafe-builtin calls in a file's content, partitioned
 *  by primitive. The returned map keys are wrapper names; values are
 *  the number of bare calls to that wrapper's underlying unsafe
 *  builtin in this file. */
export function countViolations(
	content: string,
	primitives: DiscoveredPrimitive[],
): Map<string, number> {
	const out = new Map<string, number>();
	for (const prim of primitives) {
		const builtin = UNSAFE_BUILTINS.find((b) => b.name === prim.unsafeBuiltin);
		if (!builtin) continue;
		const count = countBareBuiltinCalls(content, builtin, [prim.wrapperName]);
		out.set(prim.wrapperName, count);
	}
	return out;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Public access to the canonical UNSAFE_BUILTINS list (for tests
 *  and downstream callers that enumerate). */
export function getUnsafeBuiltins(): readonly UnsafeBuiltin[] {
	return UNSAFE_BUILTINS;
}

/** High-level helper for the harness PostToolUse path: refresh
 *  primitives if the cache is stale and return per-primitive
 *  violation counts for the given file content. Returns undefined
 *  when no primitives have been discovered (project hasn't adopted
 *  a wrapper yet) or when discovery fails — the ratchet check
 *  fails open in those cases so we don't block on flaky discovery.
 *  This is the only entry point server.ts uses; the lower-level
 *  pieces are exported for tests and external tooling. */
export function capturePrimitiveViolations(
	repoRoot: string,
	content: string,
): Record<string, number> | undefined {
	try {
		const prims = refreshIfStale(repoRoot);
		if (prims.length === 0) return undefined;
		const violations = countViolations(content, prims);
		if (violations.size === 0) return undefined;
		const out: Record<string, number> = {};
		for (const [k, v] of violations) out[k] = v;
		return out;
	} catch {
		return undefined;
	}
}
