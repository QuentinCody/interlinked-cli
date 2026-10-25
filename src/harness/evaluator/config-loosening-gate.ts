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
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { canonicalPath, isTrackedExtendsMember, judgeEffectiveStrictness } from "./config-loosening-extends.js";
import { reconstructEdit } from "./edit-reconstruction.js";
import { parseTsconfigObject, safeJsonParse, tsconfigParseFindings } from "./tsconfig-text-parse.js";
import { toolWriteTargets, type WriteTarget } from "./write-targets.js";
import {
	evaluateVitestCoverageWaterLine,
	isVitestConfigFile,
} from "./vitest-coverage-water-line.js";

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
	// Vitest/vite configs route here too — their `coverage.include` /
	// `coverage.exclude` arrays are a water-line (see
	// `vitest-coverage-water-line.ts`, which owns that basename pattern so the
	// routing rule exists in exactly one place).
	return CONFIG_BASENAME_RE.test(filePath.replace(/\\/g, "/")) || isVitestConfigFile(filePath);
}

// The JSONC parse moved to tsconfig-text-parse.ts (round 4); re-exported for its importers.
export { safeJsonParse };

function get(obj: unknown, ...path: string[]): unknown {
	let node: unknown = obj;
	for (const segment of path) {
		if (!isJsonObject(node)) return undefined;
		node = node[segment];
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
	const norm = filePath.replace(/\\/g, "/");
	if (/(?:^|\/)tsconfig.*\.json$/.test(norm)) {
		const unparseable = tsconfigParseFindings(filePath, beforeText, afterText);
		if (unparseable.length > 0) return unparseable;
		return detectTsconfigLoosening(filePath, parseTsconfigObject(beforeText), parseTsconfigObject(afterText));
	}
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (!after) return []; // can't parse the proposed file — let biome / npm catch it.
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
 * Public API — the result of ONE unique `old_string` → `new_string`
 * replacement, or `null` when the old_string is absent, ambiguous, or the
 * replacement has more than one possible result. Kept for API compatibility;
 * the gate itself reconstructs through `edit-reconstruction.ts`
 * (`reconstructToolInput`), which honours `replace_all` and every runner
 * spelling and fails CLOSED on an undecidable edit (red team 2026-10-21).
 */
export function reconstructEditContent(
	currentContent: string,
	oldString: string,
	newString: string,
): string | null {
	const result = reconstructEdit(currentContent, { old_string: oldString, new_string: newString });
	return result.kind === "decided" && result.contents.length === 1 ? nonNull(result.contents[0]) : null;
}

/** A config file the gate judges: a known config name, or any `.json` in a tracked tsconfig's extends chain. */
function isJudgedConfig(absPath: string): boolean {
	return isConfigFile(absPath) || isTrackedExtendsMember(absPath, parseTsconfigObject);
}

/**
 * Every config water-line a tool call writes (red team 2026-10-21 round 3): a
 * V4A patch in any tool (shell heredoc included) or a registry-classified
 * direct writer in any runner spelling, paths resolved before classification.
 */
function configTargets(event: HarnessEvent): WriteTarget[] {
	const read = (absPath: string) => readDiskContent(absPath, event.cwd);
	return toolWriteTargets(event.tool_name ?? "", event.tool_input ?? {}, event.cwd, read, isJudgedConfig);
}

const TSCONFIG_NAME_RE = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;

/** True when the target is a BLOCKING strictness water-line (tsconfig name, extends member, vitest config). */
function isBlockingConfig(absPath: string): boolean {
	return TSCONFIG_NAME_RE.test(absPath) || isVitestConfigFile(absPath) || !isConfigFile(absPath);
}

/**
 * Fail-closed decision for a config edit whose result cannot be reconstructed:
 * a block for a strictness water-line, an ask for package.json. biome.json /
 * .eslintrc have no detector yet, so an unknown result there loosens nothing
 * this gate could see.
 */
function undecidableConfigDecision(absPath: string, toolName: string, why: string): HarnessDecision | null {
	const blocking = isBlockingConfig(absPath);
	if (!blocking && !/(?:^|\/)package\.json$/.test(absPath)) return null;
	if (blocking && process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	return {
		decision: blocking ? "block" : "ask",
		reason:
			`${blocking ? "BLOCKED: " : ""}the config-loosening gate cannot determine what this ${toolName} call would leave in ${absPath} (${why}). ` +
			"A config water-line edit that cannot be judged is not allowed. Re-issue the change as a Write of the full file content." +
			(blocking ? " Intentional reset: INTERLINKED_DISABLE_BASELINE_GUARD=1." : ""),
		rule_id: "config_loosening_gate",
		severity: "high",
		category: "config",
	};
}

/**
 * Effective-strictness findings for a tsconfig edit (red team 2026-10-21,
 * extends-chain redirection): resolves the `extends` chain on the HEAD side
 * and the proposed side for the edited file and every tracked tsconfig that
 * extends it, so a repointed `extends`, a new untracked base, or a loosened
 * extends target is judged by what tsc would actually enforce. Undecidable
 * comparisons (package specifier, missing target, cycle) only warn.
 */
function effectiveTsconfigFindings(
	filePath: string,
	proposed: string,
	previous: string | null,
	own: readonly ConfigLooseningFinding[],
	warnings: string[] | undefined,
): ConfigLooseningFinding[] {
	const judgment = judgeEffectiveStrictness({
		filePath,
		proposed,
		previous,
		parse: parseTsconfigObject,
		trackedFlags: [...TSCONFIG_STRICTNESS_FLAGS, ...INVERTED_STRICTNESS_FLAGS],
		compare: (subject, before, after) =>
			detectTsconfigLoosening(subject, { compilerOptions: before }, { compilerOptions: after }),
	});
	for (const detail of judgment.undecided) {
		warnings?.push(`[interlinked:config_loosening_gate] NOT DECIDED: ${detail}; the edit is allowed.`);
	}
	const ownRules = new Set(own.map((f) => f.rule));
	return judgment.findings
		.filter((e) => !(e.isEditedFile && ownRules.has(e.finding.rule)))
		.map((e) => ({
			...e.finding,
			file: e.subject,
			message: `effective config of ${e.subject} (extends chain after the edit: ${e.chain.join(" → ")}): ${e.finding.message}`,
		}));
}

/**
 * Public API — consumed by `evaluator/pre-tool-guards.ts` for EVERY tool call
 * (the registry classifier decides which calls write). Blocks an edit that
 * loosens tsconfig strictness (a tsconfig*.json or any `.json` in a tracked
 * tsconfig's extends chain) or a vitest coverage denominator, asks on a
 * package.json loosening, and fails closed on a target it cannot reconstruct.
 */
export function evaluateConfigLooseningForEvent(
	event: HarnessEvent,
	warnings?: string[],
): HarnessDecision | null {
	let ask: HarnessDecision | null = null;
	for (const target of configTargets(event)) {
		const decisions =
			target.proposed.kind === "undecidable"
				? [undecidableConfigDecision(target.filePath, event.tool_name ?? "this tool", target.proposed.reason)]
				: target.proposed.contents.map((proposed) => judgeConfigProposal(target, proposed, warnings));
		for (const decision of decisions) {
			if (decision?.decision === "block") return decision;
			ask ??= decision;
		}
	}
	return ask;
}

/** Judge one reconstructed result of one config target. */
function judgeConfigProposal(
	target: WriteTarget,
	proposed: string,
	warnings: string[] | undefined,
): HarnessDecision | null {
	const filePath = target.filePath;
	// Git reports canonical paths, so a path through a symlink still finds HEAD.
	const head = readHeadVersion(canonicalPath(filePath));
	// Vitest/vite arm: the coverage denominator is a ratchet water-line, not a
	// JSON strictness flag, so it has its own AST comparison and its own
	// (blocking) verdict. Same bypass env as the tsconfig arm below.
	if (isVitestConfigFile(filePath)) {
		return evaluateVitestCoverageWaterLine(filePath, head, proposed, warnings);
	}
	// An extends member of any name is a tsconfig too: it gets the parse rule (round 4).
	const findings = isConfigFile(filePath)
		? detectConfigLoosening(filePath, head, proposed)
		: tsconfigParseFindings(filePath, head, proposed);
	// tsconfig strictness is a RATCHET water-line like the `.interlinked/`
	// baselines (2026-09-01): loosening it defeats every type-level check at
	// once, so it BLOCKS rather than asks. package.json / biome loosening
	// keeps the ask-mode confirmation. Same bypass as the baseline gate. A
	// `.json` of any name in a tracked tsconfig's extends chain is judged the
	// same way (round 3, WF6).
	const isTsconfig = TSCONFIG_NAME_RE.test(filePath) || !isConfigFile(filePath);
	if (isTsconfig) {
		findings.push(
			...effectiveTsconfigFindings(canonicalPath(filePath), proposed, target.before, findings, warnings),
		);
	}
	if (findings.length === 0) return null;
	const messages = findings.map((f) => `[${f.rule}] ${f.message}`).join("\n  ");
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
