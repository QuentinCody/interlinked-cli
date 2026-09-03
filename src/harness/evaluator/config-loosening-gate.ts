// Config-loosening gate (Batch 6).
//
// PreToolUse ask-mode hook: when an edit to tsconfig.json / biome.json /
// package.json / .eslintrc.* would weaken a strictness or quality flag
// relative to its HEAD-committed version, surface a finding so the user
// can confirm. These config tightenings rarely come back once relaxed,
// and asymmetric review value justifies the friction.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

export interface ConfigLooseningFinding {
	rule: string;
	before: unknown;
	after: unknown;
	file: string;
	message: string;
}

const CONFIG_BASENAME_RE =
	/(?:^|\/)(tsconfig(?:\.[^/]+)?\.json|biome\.json|biome\.jsonc|\.eslintrc(?:\.(?:json|js|cjs|mjs))?|package\.json)$/;

function isConfigFile(filePath: string): boolean {
	return CONFIG_BASENAME_RE.test(filePath.replace(/\\/g, "/"));
}

export function safeJsonParse(text: string): unknown {
	if (!text) return null;
	try {
		// Tolerate JSONC (// comments and trailing commas) in tsconfig / biome.
		const cleaned = text
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/,(\s*[}\]])/g, "$1");
		return JSON.parse(cleaned);
	} catch {
		return null;
	}
}

function get(obj: unknown, ...path: string[]): unknown {
	let node: unknown = obj;
	for (const segment of path) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as JsonObject)[segment];
	}
	return node;
}

// ==========================================================================
// Per-file detectors
// ==========================================================================

// Subset of strictness flags that `strict: true` implies as true. Other
// flags in TSCONFIG_STRICTNESS_FLAGS (noFallthroughCasesInSwitch,
// noImplicitReturns, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
// are NOT implied by `strict` per the TypeScript docs and must be set
// explicitly — they're handled by the literal-true → literal-false branch.
const STRICT_IMPLIES = new Set([
	"noImplicitAny",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"noImplicitThis",
	"alwaysStrict",
	"useUnknownInCatchVariables",
]);

const TSCONFIG_STRICTNESS_FLAGS = [
	"strict",
	"noImplicitAny",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"noImplicitThis",
	"alwaysStrict",
	"useUnknownInCatchVariables",
	"noFallthroughCasesInSwitch",
	"noImplicitReturns",
	"noUncheckedIndexedAccess",
	"exactOptionalPropertyTypes",
	"noImplicitOverride",
	"noUnusedLocals",
	"noUnusedParameters",
] as const;

/** Flags whose STRICT value is `false` (TypeScript's default is the loose
 *  setting). `allowUnreachableCode: false` turns statements after an
 *  unconditional return/throw into compile errors; absent or `true` merely
 *  warns or ignores them. Tracked separately because the polarity is
 *  inverted relative to TSCONFIG_STRICTNESS_FLAGS. */
const INVERTED_STRICTNESS_FLAGS = ["allowUnreachableCode"] as const;

/**
 * Resolve the effective value of a strictness flag, accounting for both
 * (a) the `strict: true` umbrella that implies subordinate flags as true,
 * and (b) TypeScript's documented defaults for absent flags (every
 * strictness flag defaults to `false` when not explicitly set, except
 * subordinate flags under `strict: true`).
 *
 * Returns `false` for an absent flag in the non-implied case so that
 * removing an explicit `true` is detected as `true → false` rather than
 * `true → undefined` (which silently slipped through previously).
 */
function effectiveStrictnessValue(co: unknown, flag: string): boolean {
	const explicit = get(co, flag);
	if (explicit === true) return true;
	if (explicit === false) return false;
	// `strict` itself defaults to false when absent.
	if (flag === "strict") return false;
	// Subordinate flags inherit `strict: true` when not explicitly set.
	if (STRICT_IMPLIES.has(flag) && get(co, "strict") === true) return true;
	// All other flags default to false per the TypeScript docs.
	return false;
}

/** Inverted-polarity flags: strict only when explicitly `false`; absent or
 *  `true` is the loose default, so `false → absent` is a loosening. */
function detectInvertedFlagLoosening(
	filePath: string,
	beforeCo: unknown,
	afterCo: unknown,
): ConfigLooseningFinding[] {
	const findings: ConfigLooseningFinding[] = [];
	for (const flag of INVERTED_STRICTNESS_FLAGS) {
		const b = get(beforeCo, flag) === false;
		const a = get(afterCo, flag) === false;
		if (b && !a) {
			findings.push({
				rule: flag,
				before: false,
				after: get(afterCo, flag),
				file: filePath,
				message: `tsconfig flag \`${flag}\` was \`false\` (strict) and is now absent or \`true\`. Unreachable statements stop being compile errors, so dead code after return/throw can accumulate unseen.`,
			});
		}
	}
	return findings;
}

function detectTsconfigLoosening(
	filePath: string,
	before: unknown,
	after: unknown,
): ConfigLooseningFinding[] {
	const beforeCo = get(before, "compilerOptions");
	const afterCo = get(after, "compilerOptions");
	const findings: ConfigLooseningFinding[] = detectInvertedFlagLoosening(filePath, beforeCo, afterCo);
	for (const flag of TSCONFIG_STRICTNESS_FLAGS) {
		const b = effectiveStrictnessValue(beforeCo, flag);
		const a = effectiveStrictnessValue(afterCo, flag);
		if (b === true && a === false) {
			findings.push({
				rule: flag,
				before: b,
				after: a,
				file: filePath,
				message: `tsconfig flag \`${flag}\` effectively flipped from true → false (either explicit override or removal of the strict umbrella that previously implied it). This permits a class of bugs the type system was previously catching.`,
			});
		}
	}
	return findings;
}

interface PackageJson {
	engines?: { node?: string };
	scripts?: Record<string, string>;
}

function parseSemverFloor(spec: string | undefined): number {
	if (!spec) return 0;
	const m = /(\d+)/.exec(spec);
	return m ? Number(m[1]) : 0;
}

const REQUIRED_SCRIPT_KEYS = ["test", "typecheck", "lint", "build"] as const;

/** Parsed JSON is `unknown`; a package.json is any non-array object (every
 *  field the detector reads is optional). A predicate, not an assertion, so
 *  both tsgo and typescript-eslint agree the narrowing is real. */
function isPackageJsonShape(v: unknown): v is PackageJson {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function detectPackageJsonLoosening(
	filePath: string,
	before: PackageJson | null,
	after: PackageJson | null,
): ConfigLooseningFinding[] {
	const findings: ConfigLooseningFinding[] = [];
	if (before === null || after === null) return findings;

	const beforeNode = parseSemverFloor(before.engines?.node);
	const afterNode = parseSemverFloor(after.engines?.node);
	if (beforeNode > 0 && afterNode === 0) {
		// engines.node removed entirely — no declared floor at all. The
		// most extreme loosening: any Node version (or none) now appears
		// supported per the manifest.
		findings.push({
			rule: "engines.node",
			before: before.engines?.node,
			after: undefined,
			file: filePath,
			message: `engines.node removed (was ${before.engines?.node}). The package no longer declares a Node version floor; consumers on older Node may install successfully and crash at runtime. Restore the floor or document why no minimum is appropriate.`,
		});
	} else if (beforeNode > 0 && afterNode > 0 && afterNode < beforeNode) {
		findings.push({
			rule: "engines.node",
			before: before.engines?.node,
			after: after.engines?.node,
			file: filePath,
			message: `engines.node lowered from ${before.engines?.node} → ${after.engines?.node}. Older Node releases lack APIs the codebase may rely on; if the lower floor is intentional, document why and verify nothing in the project requires the higher version.`,
		});
	}

	for (const key of REQUIRED_SCRIPT_KEYS) {
		const had = before.scripts?.[key];
		const has = after.scripts?.[key];
		if (had && !has) {
			findings.push({
				rule: `scripts.${key}`,
				before: had,
				after: undefined,
				file: filePath,
				message: `\`scripts.${key}\` was removed from package.json. Without it, CI / contributors lose a standard entry point. Restore it (even if just a thin wrapper) or rewire CI to whatever replaced it.`,
			});
		}
	}

	return findings;
}

// ==========================================================================
// Public API
// ==========================================================================

/** Public API — pure-function detector exposed for tests + the gate. */
export function detectConfigLoosening(
	filePath: string,
	beforeText: string,
	afterText: string,
): ConfigLooseningFinding[] {
	if (!isConfigFile(filePath)) return [];
	if (!beforeText) return []; // new file — no loosening to detect
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (!after) return []; // can't parse the proposed file — let tsc/biome catch it.

	const norm = filePath.replace(/\\/g, "/");
	if (/(?:^|\/)tsconfig.*\.json$/.test(norm)) {
		return detectTsconfigLoosening(filePath, before, after);
	}
	if (/(?:^|\/)package\.json$/.test(norm)) {
		return detectPackageJsonLoosening(
			filePath,
			isPackageJsonShape(before) ? before : null,
			isPackageJsonShape(after) ? after : null,
		);
	}
	// biome.json / .eslintrc.* — coverage TBD: schema-aware diff would catch
	// rule severity drops. Returning [] for now; promote to a real detector
	// in a follow-up. Returning empty here is fail-open, not silent — the
	// edit proceeds normally and biome/eslint will still apply at PostToolUse.
	return [];
}

// ==========================================================================
// Event-level entry point — called from evaluator/pre-tool.ts
// ==========================================================================

/**
 * Read the HEAD version of a file. Resolves the file's path relative to
 * the repo root before invoking `git show HEAD:<rel>` so monorepo configs
 * (e.g. `packages/api/tsconfig.json`) compare against their own HEAD
 * baseline, not the repo-root file with the same basename.
 */
export function readHeadVersion(file: string): string {
	const fileDir = dirname(file);
	try {
		const top = spawnSync("git", ["-C", fileDir, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			timeout: 1500,
		});
		if (top.status !== 0 || !top.stdout) return "";
		const repoRoot = top.stdout.trim();
		const absFile = isAbsolute(file) ? file : resolve(file);
		const rel = relative(repoRoot, absFile).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..")) return "";
		const r = spawnSync("git", ["-C", repoRoot, "show", `HEAD:${rel}`], {
			encoding: "utf-8",
			timeout: 1500,
		});
		if (r.status !== 0 || !r.stdout) return "";
		return r.stdout;
	} catch {
		return "";
	}
}

export function readDiskContent(file: string, cwd: string | undefined): string | null {
	const abs = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
	if (!existsSync(abs)) return null;
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Public API — reconstruct the proposed file content for an Edit tool call.
 * Edit/Update carry `old_string` / `new_string`, not `content`, so the
 * config-loosening gate must apply the find-replace itself to obtain the
 * proposed-after content for diffing.
 *
 * Returns `null` when the old_string isn't present or is ambiguous (matches
 * multiple positions). Ambiguous matches require `replace_all` semantics
 * we don't reproduce here — the caller should fail open in that case so a
 * Post-edit pass can still catch the regression.
 */
export function reconstructEditContent(
	currentContent: string,
	oldString: string,
	newString: string,
): string | null {
	const idx = currentContent.indexOf(oldString);
	if (idx < 0) return null;
	const lastIdx = currentContent.lastIndexOf(oldString);
	if (idx !== lastIdx) return null; // ambiguous
	return currentContent.slice(0, idx) + newString + currentContent.slice(idx + oldString.length);
}

/**
 * Public API — consumed by `evaluator/pre-tool.ts` on every file-write
 * event. Returns an `ask` decision when an edit to a known config file
 * would loosen a strictness flag relative to HEAD; null otherwise.
 *
 * Handles three tool-input shapes:
 *   - `Write` → uses `tool_input.content` directly.
 *   - `Edit` / `Update` → reads disk + applies `old_string` → `new_string`
 *     replacement to reconstruct the proposed content. Falls back silently
 *     on ambiguous old_strings (so a PostToolUse pass still has a chance
 *     to catch the regression).
 *   - Anything else → null (gate not applicable).
 */
/** Reconstruct proposed content for the non-`content` (Edit/Update) tool-input
 *  shape: reads disk and applies old_string → new_string. Returns null when
 *  the shape doesn't carry a usable old/new string pair, on ambiguous
 *  old_string matches, or when the file isn't present on disk. */
function reconstructProposedFromOldNew(
	filePath: string,
	cwd: string | undefined,
	toolInput: JsonObject,
): string | null {
	const oldString = toolInput.old_string as string | undefined;
	const newString = toolInput.new_string as string | undefined;
	if (typeof oldString !== "string" || typeof newString !== "string") return null;
	const disk = readDiskContent(filePath, cwd);
	if (disk === null) return null;
	return reconstructEditContent(disk, oldString, newString);
}

export function evaluateConfigLooseningForEvent(event: HarnessEvent): HarnessDecision | null {
	const toolInput = event.tool_input || {};
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath || !isConfigFile(filePath)) return null;

	const content = toolInput.content as string | undefined;
	const proposed =
		typeof content === "string" ? content : reconstructProposedFromOldNew(filePath, event.cwd, toolInput);
	if (proposed === null) return null;

	const head = readHeadVersion(filePath);
	const findings = detectConfigLoosening(filePath, head, proposed);
	if (findings.length === 0) return null;
	const messages = findings.map((f) => `[${f.rule}] ${f.message}`).join("\n  ");
	// tsconfig strictness is a RATCHET water-line like the `.interlinked/`
	// baselines (2026-09-01): loosening it defeats every type-level check at
	// once, so it BLOCKS rather than asks. package.json / biome loosening
	// keeps the ask-mode confirmation. Same bypass as the baseline gate.
	const isTsconfig = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(filePath.replace(/\\/g, "/"));
	if (isTsconfig && process.env.INTERLINKED_DISABLE_BASELINE_GUARD !== "1") {
		return {
			decision: "block",
			reason:
				`BLOCKED: this edit loosens TypeScript strictness in ${filePath}:\n  ${messages}\n\n` +
				"tsconfig strictness may only tighten — the flags are the water-line every type-level check trusts. Fix the code the flag rejects instead. Intentional reset: INTERLINKED_DISABLE_BASELINE_GUARD=1.",
			rule_id: "config_loosening_gate",
			severity: "high",
			category: "config",
		};
	}
	return {
		decision: "ask",
		reason:
			`This edit weakens config in ${filePath}:\n  ${messages}\n\n` +
			"Confirm the loosening is intentional. Strict flags rarely come back once relaxed.",
		rule_id: "config_loosening_gate",
		severity: "high",
		category: "config",
	};
}
