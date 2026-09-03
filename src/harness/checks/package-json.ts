// Package JSON Publish Invariants — guard against silent field removal at edit
// time, before a broken tarball can get published.
//
// Runs at PreToolUse ("pre_block") against a `package.json` being written.
// Compares the pre-edit JSON on disk against the proposed post-edit JSON.
// If any publish-critical field present pre-edit is missing post-edit, the
// check emits one finding per field and the write is blocked.
//
// Also runs `publint` (dynamically imported, optional dep) against the
// proposed post-edit content so subtler publish regressions (malformed
// exports, missing targets) get caught the same way.
//
// Does NOT fire on:
//   - Packages with `"private": true` — those never ship.
//   - First-time file creation — there's no "before" to diff.
//   - `package.json` files that are not at a tree root (no sibling
//     node_modules / package-lock.json / pnpm-lock.yaml / yarn.lock).
//     These are almost always fixtures or test data.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { InlineMatch } from "./shared.js";

/** Fields whose removal would meaningfully break a published package. */
const TOP_LEVEL_FIELDS = [
	"name",
	"version",
	"license",
	"repository",
	"homepage",
	"bugs",
	"keywords",
	"author",
	"engines",
	"main",
	"types",
	"exports",
	"bin",
	"files",
	"publishConfig",
	"sideEffects",
	"type",
] as const;

/** Scripts whose removal would also break publishing. */
const SCRIPT_FIELDS = ["prepublishOnly"] as const;

/** Lockfile / node_modules markers that identify a real publish target. */
const TREE_ROOT_MARKERS = [
	"node_modules",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const;

/** Named constants referenced in conditionals so cold readers see intent
 *  instead of magic strings. */
const PACKAGE_JSON_BASENAME = "package.json";
const PUBLINT_ERROR_SEVERITY = "error";
const FUNCTION_TYPEOF = "function";

/**
 * Return parsed JSON only when the parse succeeds and the result is a plain
 * object. Matches the `safeReadPackageJson` pattern from
 * `src/lib/hook-detection.ts` — null means "skip, we can't reason about
 * this file".
 */
function safeParse(raw: string): JsonObject | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed instanceof Object && !Array.isArray(parsed)) {
		return parsed as JsonObject;
	}
	return null;
}

function safeReadJson(path: string): JsonObject | null {
	if (!existsSync(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	return safeParse(raw);
}

/** True iff the directory containing `filePath` has a sibling lockfile / node_modules. */
function isTreeRoot(filePath: string): boolean {
	const dir = dirname(filePath);
	for (const marker of TREE_ROOT_MARKERS) {
		if (existsSync(join(dir, marker))) return true;
	}
	return false;
}

/**
 * A field is "present" if it exists on the object and its value is not one of:
 * null / undefined / "" / []. For nested objects and non-empty strings it's
 * considered present regardless of internal shape.
 */
function isPresent(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (value === "") return false;
	if (Array.isArray(value) && value.length === 0) return false;
	return true;
}

/** Extract scripts.<key> or return undefined. */
function getScript(pkg: JsonObject, key: string): unknown {
	const scripts = pkg.scripts;
	if (!(scripts instanceof Object) || Array.isArray(scripts)) return undefined;
	return (scripts as JsonObject)[key];
}

interface PublintMessage {
	code: string;
	type: string;
	args?: unknown[];
}
type PublintFn = (opts: { pkgDir: string }) => Promise<{ messages: PublintMessage[] }>;

/**
 * Dynamically invoke `publint`, returning its error-severity messages.
 * Returns null if publint isn't installed or the call fails — this is a
 * best-effort supplementary check, not a hard dependency.
 */
async function runPublint(
	pkgDir: string,
): Promise<Array<{ code: string; message: string }> | null> {
	try {
		// Dynamic import — no hard dep on publint at compile time.
		// Using a variable specifier so tsc doesn't try to resolve the bare
		// `"publint"` module path when the package isn't installed.
		const specifier = "publint";
		const mod: unknown = await import(specifier);
		if (!(mod instanceof Object)) return null;
		const candidate = (mod as { publint?: unknown }).publint;
		if (typeof candidate !== FUNCTION_TYPEOF) return null;
		const publint = candidate as PublintFn;
		const { messages } = await publint({ pkgDir });
		const errors = messages.filter((m) => m.type === PUBLINT_ERROR_SEVERITY);
		return errors.map((m) => ({
			code: m.code,
			message: `publint [${m.code}] ${JSON.stringify(m.args ?? [])}`,
		}));
	} catch {
		return null;
	}
}

/**
 * Public API — consumed by the check registry via
 * `check-registry/entries-errors.ts`. Matches the
 * `(content, filePath) => InlineMatch[]` signature of every other
 * agent-safety check so it plugs into `buildAgentSafetyChecks` without
 * special-casing.
 *
 * `content` is the proposed POST-edit package.json. The PRE-edit content is
 * read from disk via `filePath` — that still holds the old content at
 * PreToolUse time.
 */
export function checkPackageJsonPublishInvariants(
	content: string,
	filePath: string,
): InlineMatch[] {
	// Only fire on exactly `package.json`. Not `package.json.bak`, not
	// `package.json5`, not deeply nested fixtures unless the tree-root check
	// below also passes.
	if (basename(filePath) !== PACKAGE_JSON_BASENAME) return [];
	// Skip `node_modules/.../package.json` — those are third-party, never our
	// publish target.
	if (filePath.includes("/node_modules/") || filePath.includes("\\node_modules\\")) return [];

	// Tree-root gate: only enforce on real publish targets.
	if (!isTreeRoot(filePath)) return [];

	// Parse post-edit content. If it's malformed, emit a single parse error
	// finding — don't try to enumerate 17 missing fields on top of that.
	const post = safeParse(content);
	if (!post) {
		return [
			{
				line: 1,
				text: "[package_json_publish_invariants] Post-edit package.json is not valid JSON. Fix syntax before removing fields.",
			},
		];
	}

	// Read pre-edit content. If the file didn't exist pre-edit (new file), or
	// we can't parse the pre-edit JSON, there's nothing to diff against.
	const pre = safeReadJson(filePath);
	if (!pre) return [];

	// Skip private packages entirely — they never ship, so losing publish
	// metadata is harmless.
	if (pre.private === true) return [];

	const findings: InlineMatch[] = [];
	const postLines = content.split("\n");

	for (const field of TOP_LEVEL_FIELDS) {
		if (!isPresent(pre[field])) continue; // wasn't present pre-edit, nothing to lose
		if (isPresent(post[field])) continue; // still present post-edit, fine
		findings.push({
			line: findLineOfField(postLines, field) || 1,
			text: `[package_json_publish_invariants] Pre-edit package.json had \`${field}\` but it was removed by this edit. Restore the field or publish will ship a broken tarball.`,
		});
	}

	for (const scriptKey of SCRIPT_FIELDS) {
		const preScript = getScript(pre, scriptKey);
		const postScript = getScript(post, scriptKey);
		if (!isPresent(preScript)) continue;
		if (isPresent(postScript)) continue;
		findings.push({
			line: findLineOfField(postLines, scriptKey) || 1,
			text: `[package_json_publish_invariants] Pre-edit package.json had \`scripts.${scriptKey}\` but it was removed by this edit. Restore the script or pre-publish safety gates will no longer run.`,
		});
	}

	return findings;
}

/**
 * Best-effort line lookup for a top-level field. Used only for display
 * positioning — if the field isn't in the post-edit text (because it was
 * removed), we return 0 and the caller falls back to line 1.
 */
function findLineOfField(lines: string[], field: string): number {
	const needle = `"${field}"`;
	for (let i = 0; i < lines.length; i++) {
		if (nonNull(lines[i]).includes(needle)) return i + 1;
	}
	return 0;
}

/**
 * Public API — async companion that runs the sync check and additionally
 * invokes `publint` on the post-edit content. Re-exported through
 * `generic-checks.ts` so external consumers (tests, the verify pipeline's
 * async path, future post-hook tooling) can opt into the supplementary
 * publish-lint without adding `publint` as a hard dependency.
 *
 * Returns the base findings plus one finding per publint error. If publint
 * isn't installed, returns the base findings only.
 */
export async function checkPackageJsonPublishInvariantsWithPublint(
	content: string,
	filePath: string,
): Promise<InlineMatch[]> {
	const base = checkPackageJsonPublishInvariants(content, filePath);

	// Skip publint if we already have a parse error — publint would reproduce
	// the same complaint.
	if (base.length === 1 && nonNull(base[0]).text.includes("not valid JSON")) return base;

	// Skip publint on private packages. Mirror the sync check's short-circuit.
	const pre = safeReadJson(filePath);
	if (pre?.private === true) return base;
	const post = safeParse(content);
	if (post?.private === true) return base;

	const pkgDir = dirname(filePath);
	const publintErrors = await runPublint(pkgDir);
	if (!publintErrors || publintErrors.length === 0) return base;

	const publintFindings: InlineMatch[] = publintErrors.map((e) => ({
		line: 1,
		text: `[package_json_publish_invariants] ${e.message}`,
	}));
	return [...base, ...publintFindings];
}

// ============================================================================
// scripts ↔ files-exist
// ============================================================================
// Catches the universal CI failure shape: `package.json` declares a script
// like `"test:custom": "node ./scripts/foo.mjs"` but `./scripts/foo.mjs`
// doesn't exist on disk. Manifests in monorepos drift from the file tree
// during refactors / renames / branch merges; the missing-file error only
// surfaces in CI when the script actually runs.
//
// Conservative regex set — only matches patterns where a concrete file path
// is unambiguous: a known runtime / compiler followed by a path with a known
// code/config extension. We deliberately do NOT try to parse arbitrary shell;
// that path leads to false positives that desensitize the user to real ones.

/** Runtimes / compilers whose first file-shaped argument is the script path. */
const RUNTIME_FILE_REF = /\b(?:node|tsx|bun|deno|ts-node|esno)\s+(?:["']?)([./][\w./-]*\.(?:[mc]?[jt]sx?|json))(?:["']?)/g;

/** `tsc -p <path>` and `tsc --project <path>`. */
const TSC_PROJECT_REF = /\btsc\s+(?:-p|--project)\s+(?:["']?)([\w./-]+\.json)(?:["']?)/g;

/** `--config <path>` / `-c <path>` for vitest, jest, eslint, biome, etc. */
const CONFIG_FLAG_REF = /(?:^|\s)(?:--config|-c)\s+(?:["']?)([\w./-]+\.(?:json|jsonc|js|ts|mjs|cjs))(?:["']?)/g;

const SCRIPT_FILE_REF_PATTERNS = [RUNTIME_FILE_REF, TSC_PROJECT_REF, CONFIG_FLAG_REF];

function extractScriptFileRefs(scriptValue: string): string[] {
	const refs = new Set<string>();
	for (const pattern of SCRIPT_FILE_REF_PATTERNS) {
		// Reset lastIndex — these are module-scope `g` regexes, shared across calls.
		pattern.lastIndex = 0;
		for (const match of scriptValue.matchAll(pattern)) {
			if (match[1]) refs.add(match[1]);
		}
	}
	return [...refs];
}

/**
 * Detect `package.json#scripts` values that reference files which don't exist
 * on disk. Runs on PostToolUse against the post-edit content. Conservative:
 * only flags paths matched by a runtime+path or tsc/--config pattern. Skips
 * `node_modules/**`. Returns one finding per missing file.
 */
/**
 * Missing-file findings for one script's file refs — the per-script body
 * extracted from {@link checkPackageJsonScriptPaths}'s outer loop so that
 * loop restarts at cognitive depth 0.
 */
function collectMissingScriptRefFindings(
	scriptName: string,
	scriptVal: string,
	dir: string,
	lines: string[],
	seen: Set<string>,
): InlineMatch[] {
	const findings: InlineMatch[] = [];
	for (const ref of extractScriptFileRefs(scriptVal)) {
		const refPath = isAbsolute(ref) ? ref : resolve(dir, ref);
		if (existsSync(refPath)) continue;
		// One finding per (script, ref) pair — same script invoking the same
		// missing file twice is one bug, not two.
		const key = `${scriptName}::${ref}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const lineIdx = lines.findIndex((l) => l.includes(`"${scriptName}"`));
		findings.push({
			line: lineIdx >= 0 ? lineIdx + 1 : 1,
			text: `[package_json_script_paths] scripts.${scriptName} references "${ref}" but that file does not exist on disk. Either create the file or fix the path before \`npm run ${scriptName}\` is invoked.`,
		});
	}
	return findings;
}

export function checkPackageJsonScriptPaths(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (basename(filePath) !== PACKAGE_JSON_BASENAME) return [];
	if (filePath.includes("/node_modules/") || filePath.includes("\\node_modules\\")) return [];

	const pkg = safeParse(content);
	if (!pkg) return [];

	const scripts = pkg.scripts;
	if (!(scripts instanceof Object) || Array.isArray(scripts)) return [];

	const dir = dirname(filePath);
	const findings: InlineMatch[] = [];
	const lines = content.split("\n");
	const seen = new Set<string>();

	for (const [scriptName, scriptVal] of Object.entries(scripts as JsonObject)) {
		if (typeof scriptVal !== "string") continue;
		findings.push(...collectMissingScriptRefFindings(scriptName, scriptVal, dir, lines, seen));
	}
	return findings;
}
