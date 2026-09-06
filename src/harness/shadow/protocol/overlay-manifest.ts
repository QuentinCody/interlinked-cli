// ===========================================
// Shadow protocol v1 — overlay manifest: rules, deny ruleset, canonicalization
// ===========================================
// Memo §5.1 ("Untracked-but-load-bearing state") and §8.0 ("Scanner identity,
// fail-closed", which declares `OverlayManifestV1` a real record). The overlay
// manifest is an ALLOWLIST: only the gitignored paths it names travel, so the
// 3.2 GB of `reference-repos/` overlay-exec once shipped cannot recur.
//
// Two rule kinds, one grammar. `exact` is a canonical path compared bytewise;
// `gitwildmatch-v1` is the documented subset implemented here:
//   *      zero or more characters WITHIN one path segment; never a "/"
//   **     across segments — as a leading, a trailing, or an interior segment
//   ?      exactly one non-"/" character
//   [a-z]  a character class, and [!…] / [^…] its negation; never matches "/"
//   /x     a leading "/" anchors to the repo root
//   x/     a trailing "/" matches a directory prefix (everything under it)
// A pattern with no interior "/" matches its BASENAME at any depth, which is
// why the deny ruleset can say `*.local.*` once and cover every directory.
// Matching is CASE-SENSITIVE: two machines must agree on which paths travel,
// and a case-folding rule would make that depend on the local filesystem.
// A DOTFILE IS MATCHED BY `*`. This is the one place the grammar differs from
// shell globbing, and it is deliberate: the overlay exists to carry
// `.interlinked/` state, so a rule that silently skipped dotfiles would ship a
// tree that does not match the local workspace.
//
// The deny ruleset is BROKER-OWNED (§8.0): its text lives here, never in a
// caller argument, and deny always wins over include — a `*.local.*` file
// named explicitly by the manifest is still refused (memo §5.1 acceptance).

import { canonicalDigest } from "./canonical.js";
import {
	checkArray,
	checkLiteral,
	checkNoUnknownKeys,
	firstReason,
	isRecord,
	type Reason,
} from "./field-checks.js";
// The grammar documented above is implemented in `overlay-glob.js` — one
// module for the matcher, because its cost bound (O(pattern x path), no
// backtracking) is a property that has to be stated and tested on its own.
import {
	checkGitWildmatchPattern,
	type CompiledGitWildmatchV1,
	compileGitWildmatchV1,
	matchCompiledGitWildmatchV1,
	matchesGitWildmatchV1,
	normalizeGitWildmatchPattern,
} from "./overlay-glob.js";
import { asCanonicalPath, checkCanonicalPath, comparePathBytes } from "./path-rules.js";
import type { OverlayIncludeRuleV1, OverlayManifestHash, OverlayManifestV1 } from "./types-core.js";

// The grammar is part of this module's public surface — callers name the
// manifest, not the matcher that happens to implement its rules.
export {
	checkGitWildmatchPattern,
	compileGitWildmatchV1,
	matchCompiledGitWildmatchV1,
	matchesGitWildmatchV1,
	normalizeGitWildmatchPattern,
};
export type { CompiledGitWildmatchV1 };

/** Bound applied BEFORE compilation — a manifest is config, not a corpus. */
export const MAX_OVERLAY_INCLUDE_RULES = 1024;

// ── the memo's v0 default include list (§5.1) ──────────────────────────────
// The v0 default is the tsc rider's policy-input closure: seven EXACT paths,
// no pattern rule. A pattern rule over a gitignored tree (`scratch/**` was
// here until this closure was scoped down) forces the ignored-candidate scan
// to walk that whole tree looking for matches — `overlayScanRoots` derives
// its scan roots straight from the manifest's own rules — and a real
// `scratch/` full of the working tree's own bulk (repro clones, archives)
// blows past `MAX_IGNORED_CANDIDATES` before any remote work begins. Scratch
// inputs a verifier genuinely needs are OPT-IN per manifest — an explicit
// rule the CALLER adds for the rider that needs it — never a default over an
// unbounded tree.
//
// Deliberately NOT in the default, because the tsc rider does not read them
// (a later rider derives its own closure on purpose, not by widening this
// one):
//   .interlinked/function-complexity-baseline.json
//   .interlinked/check-evidence-baseline.json
//   .interlinked/skipped-tests-baseline.json
//   .interlinked/mutation-manifest.json
export const DEFAULT_OVERLAY_INCLUDE_RULES: readonly OverlayIncludeRuleV1[] = [
	exactRule(".interlinked/coverage-baseline.json"),
	exactRule(".interlinked/coverage-edit-baseline.json"),
	exactRule(".interlinked/mutation-baseline.json"),
	exactRule(".interlinked/large-files-baseline.json"),
	exactRule(".interlinked/untested-files-baseline.json"),
	exactRule(".interlinked/metric-caps.json"),
	exactRule(".interlinked/guard-rules.json"),
];

// ── the broker-owned deny ruleset ──────────────────────────────────────────
export interface ShadowOverlayDenyRulesetV1 {
	readonly id: "shadow-overlay-deny-v1";
	readonly patterns: readonly string[];
}
/** Unconditional and NOT overridable by any manifest. The three named files
 *  are also covered by `*.local.*`; they are listed because the memo names
 *  them, and because a future edit to the wildcard must not silently drop
 *  the credential-bearing files it was written for. */
export const SHADOW_OVERLAY_DENY_V1: ShadowOverlayDenyRulesetV1 = {
	id: "shadow-overlay-deny-v1",
	patterns: ["config.local.json", "mutation-cloud-v3.local.json", "guard-rules.local.json", "*.local.*"],
};

function exactRule(path: string): OverlayIncludeRuleV1 {
	return { kind: "exact", path: asCanonicalPath(path) };
}

// ── canonicalization ───────────────────────────────────────────────────────

/** Public API: the materializer and the broker both branch on this reason
 *  when turning a refused manifest into `unavailable`. `non_canonical` is
 *  raised only by the wire parser (canonical mode) — the canonicalizer sorts
 *  instead of refusing. */
export type OverlayManifestRejection =
	| "invalid_manifest"
	| "invalid_rule"
	| "duplicate_rule"
	| "too_many_rules"
	| "non_canonical";
export interface OverlayManifestRefusal {
	readonly reason: OverlayManifestRejection;
	readonly detail: string;
}
export type OverlayManifestCanonicalization =
	| { ok: true; manifest: OverlayManifestV1; hash: OverlayManifestHash }
	| ({ ok: false } & OverlayManifestRefusal);

/** How strictly a rule list is read. The WIRE parser demands `canonical`:
 *  the sender must have canonicalized, or its hash could never match. The
 *  canonicalizer reads `any-order` because sorting is its job. */
export type OverlayRuleOrderMode = "any-order" | "canonical";

const MANIFEST_KEYS = ["schema_version", "include_rules", "deny_ruleset_id"];

function refusal(reason: OverlayManifestRejection, detail: string): OverlayManifestRefusal {
	return { reason, detail };
}

function manifestFieldRefusal(value: Record<string, unknown>, where: string): OverlayManifestRefusal | null {
	const shape = firstReason(
		checkNoUnknownKeys(value, MANIFEST_KEYS, where),
		checkLiteral(value.schema_version, 1, `${where}.schema_version`),
		checkLiteral(value.deny_ruleset_id, SHADOW_OVERLAY_DENY_V1.id, `${where}.deny_ruleset_id`),
	);
	return shape === null ? null : refusal("invalid_manifest", shape);
}

/** The canonicalizer's whole-manifest check. The wire parser declares the
 *  same three fields in its own table (`parse-core-entries.ts`, so the
 *  registry can publish the key set) and delegates `include_rules` to
 *  `checkOverlayIncludeRules` — the rule logic exists ONCE. */
function manifestRefusal(value: unknown, where: string): OverlayManifestRefusal | null {
	if (!isRecord(value)) return refusal("invalid_manifest", `${where} must be an object`);
	return (
		manifestFieldRefusal(value, where) ?? checkOverlayIncludeRules(value.include_rules, `${where}.include_rules`, "any-order")
	);
}

function ruleListBoundRefusal(value: unknown, where: string): OverlayManifestRefusal | null {
	const array = checkArray(value, where, Number.MAX_SAFE_INTEGER);
	if (array !== null || !Array.isArray(value)) return refusal("invalid_manifest", array ?? `${where} must be an array`);
	if (value.length === 0) return refusal("invalid_manifest", `${where} must name at least one rule`);
	if (value.length > MAX_OVERLAY_INCLUDE_RULES) {
		return refusal("too_many_rules", `${where} exceeds ${MAX_OVERLAY_INCLUDE_RULES} rules`);
	}
	return null;
}

/** THE ONE include-rule validator: bound, non-empty, every rule well-formed,
 *  no duplicate after normalization, and — in `canonical` mode — already in
 *  the order and spelling `canonicalizeOverlayManifest` would produce. */
export function checkOverlayIncludeRules(
	value: unknown,
	where: string,
	mode: OverlayRuleOrderMode,
): OverlayManifestRefusal | null {
	const bound = ruleListBoundRefusal(value, where);
	if (bound !== null || !Array.isArray(value)) return bound;
	const invalid = firstRuleReason(value, where);
	if (invalid !== null) return refusal("invalid_rule", invalid);
	// SAFETY: every item passed `ruleReason`, which admits exactly the two
	// OverlayIncludeRuleV1 shapes with no unknown keys.
	const rules = value as readonly OverlayIncludeRuleV1[];
	const duplicate = duplicateRuleKey(rules);
	if (duplicate !== null) return refusal("duplicate_rule", `${where} contains duplicate include rule: ${duplicate}`);
	if (mode === "any-order") return null;
	const drift = nonCanonicalDetail(rules, where);
	return drift === null ? null : refusal("non_canonical", drift);
}

function ruleReason(rule: unknown, where: string): Reason {
	if (!isRecord(rule)) return `${where} must be an object`;
	if (rule.kind === "exact") {
		return firstReason(
			checkNoUnknownKeys(rule, ["kind", "path"], where),
			checkCanonicalPath(rule.path, `${where}.path`),
		);
	}
	if (rule.kind === "gitwildmatch-v1") {
		return firstReason(
			checkNoUnknownKeys(rule, ["kind", "pattern"], where),
			checkGitWildmatchPattern(rule.pattern, `${where}.pattern`),
		);
	}
	return `${where}.kind must be one of: exact, gitwildmatch-v1`;
}

function firstRuleReason(rules: readonly unknown[], where: string): Reason {
	for (let index = 0; index < rules.length; index += 1) {
		const reason = ruleReason(rules[index], `${where}[${index}]`);
		if (reason !== null) return reason;
	}
	return null;
}

/** The first index at which the list differs from its own canonical form —
 *  order drift and an un-normalized pattern both surface here. */
function nonCanonicalDetail(rules: readonly OverlayIncludeRuleV1[], where: string): string | null {
	const canonical = sortRules(rules);
	for (let index = 0; index < rules.length; index += 1) {
		const given = rules[index];
		const expected = canonical[index];
		if (given === undefined || expected === undefined) return `${where} is not in canonical order`;
		if (given.kind !== expected.kind || ruleText(given) !== ruleText(expected)) {
			return `${where}[${index}] is not in canonical order or spelling (expected ${expected.kind} "${ruleText(expected)}")`;
		}
	}
	return null;
}

/** The identity a duplicate is measured on: exact paths bytewise, patterns
 *  after normalization, and the two kinds never collide. */
function ruleKey(rule: OverlayIncludeRuleV1): string {
	return rule.kind === "exact" ? `exact:${rule.path}` : `pattern:${normalizeGitWildmatchPattern(rule.pattern)}`;
}

function duplicateRuleKey(rules: readonly OverlayIncludeRuleV1[]): string | null {
	const seen = new Set<string>();
	for (const rule of rules) {
		const key = ruleKey(rule);
		if (seen.has(key)) return key;
		seen.add(key);
	}
	return null;
}

function ruleText(rule: OverlayIncludeRuleV1): string {
	return rule.kind === "exact" ? rule.path : rule.pattern;
}

function canonicalRule(rule: OverlayIncludeRuleV1): OverlayIncludeRuleV1 {
	if (rule.kind === "exact") return { kind: "exact", path: rule.path };
	return { kind: "gitwildmatch-v1", pattern: normalizeGitWildmatchPattern(rule.pattern) };
}

/** Exact rules before pattern rules; each group bytewise by its text. Rule
 *  order is not semantic (deny wins regardless), so ONE order must be the
 *  canonical one or the same manifest would hash two ways. */
function sortRules(rules: readonly OverlayIncludeRuleV1[]): OverlayIncludeRuleV1[] {
	const canonical = rules.map(canonicalRule);
	const exact = canonical.filter((rule) => rule.kind === "exact");
	const patterns = canonical.filter((rule) => rule.kind !== "exact");
	const byText = (a: OverlayIncludeRuleV1, b: OverlayIncludeRuleV1) => comparePathBytes(ruleText(a), ruleText(b));
	return [...exact.sort(byText), ...patterns.sort(byText)];
}

/** Validate, deduplicate, sort, and hash. Non-throwing: the caller turns a
 *  rejection into `unavailable`, never into a partial manifest. Runs the
 *  SAME validator the wire parser runs (in any-order mode), so a manifest
 *  `parseOverlayManifest` accepted canonicalizes to itself with one hash. */
export function canonicalizeOverlayManifest(manifest: OverlayManifestV1): OverlayManifestCanonicalization {
	const refused = manifestRefusal(manifest, "overlay manifest");
	if (refused !== null) return { ok: false, ...refused };
	const canonical: OverlayManifestV1 = {
		schema_version: 1,
		include_rules: sortRules(manifest.include_rules),
		deny_ruleset_id: SHADOW_OVERLAY_DENY_V1.id,
	};
	return { ok: true, manifest: canonical, hash: canonicalDigest<"overlay-manifest">(canonical) };
}

// ── selection ──────────────────────────────────────────────────────────────

export interface OverlaySelectionV1 {
	included: string[];
	denied: string[];
}

/** Public API: the broker-owned deny decision, exported so the scanner and
 *  the staging path can refuse one path without building a selection. No
 *  manifest input reaches it. */
export function isDeniedOverlayPath(path: string): boolean {
	return SHADOW_OVERLAY_DENY_V1.patterns.some((pattern) => matchesGitWildmatchV1(pattern, path));
}

/** The manifest's rules compiled ONCE. A selection runs every rule against
 *  every candidate, so compiling per path would pay the parse |paths| times
 *  over for no gain — and an invalid pattern is dropped here rather than
 *  re-rejected on each path. */
interface CompiledRulesV1 {
	readonly exact: ReadonlySet<string>;
	readonly patterns: readonly CompiledGitWildmatchV1[];
	readonly deny: readonly CompiledGitWildmatchV1[];
}

function compilePatterns(patterns: readonly string[]): CompiledGitWildmatchV1[] {
	const compiled: CompiledGitWildmatchV1[] = [];
	for (const pattern of patterns) {
		const one = compileGitWildmatchV1(pattern);
		if (one !== null) compiled.push(one);
	}
	return compiled;
}

function compileRules(manifest: OverlayManifestV1): CompiledRulesV1 {
	const exact = new Set<string>();
	const patterns: string[] = [];
	for (const rule of manifest.include_rules) {
		if (rule.kind === "exact") exact.add(String(rule.path));
		else patterns.push(rule.pattern);
	}
	return { exact, patterns: compilePatterns(patterns), deny: compilePatterns(SHADOW_OVERLAY_DENY_V1.patterns) };
}

function matchesAny(compiled: readonly CompiledGitWildmatchV1[], path: string): boolean {
	return compiled.some((one) => matchCompiledGitWildmatchV1(one, path));
}

function sortedByBytes(paths: readonly string[]): string[] {
	return [...paths].sort(comparePathBytes);
}

/** Deny first, then include. A candidate that is not a canonical path is
 *  dropped silently from BOTH lists — it can never travel, and reporting it
 *  as "denied" would confuse a scanner finding with a malformed input. */
export function selectOverlayPaths(
	manifest: OverlayManifestV1,
	candidatePaths: readonly string[],
): OverlaySelectionV1 {
	const rules = compileRules(manifest);
	const included: string[] = [];
	const denied: string[] = [];
	for (const path of candidatePaths) {
		if (checkCanonicalPath(path, "candidate path") !== null) continue;
		if (matchesAny(rules.deny, path)) {
			denied.push(path);
		} else if (rules.exact.has(path) || matchesAny(rules.patterns, path)) {
			included.push(path);
		}
	}
	return { included: sortedByBytes(included), denied: sortedByBytes(denied) };
}
