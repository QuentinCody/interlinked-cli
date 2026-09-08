// ===========================================
// Content Scanner — Allowlist
// ===========================================
//
// Deterministic FP-suppression layer applied AFTER the OPF model emits
// findings, BEFORE `decideFromFindings()` decides allow vs ask. Matching
// findings are dropped silently — they never reach the user's permission
// prompt, never land in the systemMessage, never get written to a pending
// file.
//
// Why a separate layer (not a model retraining loop):
//   1. The OPF model is opaque and slow to iterate on. False positives we
//      see in practice ("noreply@anthropic.com" labeled private_email,
//      "content_scanner" labeled private_person) need to be suppressible
//      without waiting for upstream releases.
//   2. Determinism beats heuristics here: a regex either matches or doesn't,
//      and the suppression behavior is auditable from a config file.
//   3. Two-tier merging means teams can ship a curated default list while
//      individuals add personal entries in their gitignored local config.
//
// Security note: the allowlist DROPS findings — it cannot synthesize them.
// A malicious team config can hide PII detection but cannot inject false
// flags on the user. The asymmetry matters.

import type { AllowlistEntry, ScanFinding } from "./types.js";

import { isJsonObject } from "../../lib/json-types.js";

/** A pre-compiled allowlist entry. Building these once at config-load time
 *  avoids re-compiling the regex on every scan. Exported so callers that
 *  thread a compiled list through their own pipelines (the WebFetch proxy,
 *  the post-scan path) can typed-pass it instead of re-compiling. */
export interface CompiledEntry {
	entry: AllowlistEntry;
	matches: (text: string) => boolean;
}

/** Result of filtering a finding list through the allowlist. */
export interface AllowlistResult {
	/** Findings that survived the filter — what the policy layer should see. */
	kept: ScanFinding[];
	/** Per-suppression record, kept for telemetry/logging. The text field is
	 *  internal-only; callers must not echo it back to the agent. */
	suppressed: Array<{ finding: ScanFinding; entry: AllowlistEntry }>;
}

/**
 * Compile validated allowlist entries once. Malformed entries and unknown
 * kinds are logged and skipped without disabling valid neighboring entries.
 */
export function compileAllowlist(allowlist: unknown): CompiledEntry[] {
	if (!Array.isArray(allowlist)) return [];
	const compiled: CompiledEntry[] = [];
	for (const entry of allowlist) {
		if (!isAllowlistEntry(entry)) {
			const kind = isJsonObject(entry) && typeof entry.kind === "string" ? entry.kind : "(missing)";
			process.stderr.write(`[interlinked:scanner] allowlist entry skipped — invalid shape or unknown kind "${kind}"\n`);
			continue;
		}
		compiled.push({ entry, matches: compileEntry(entry) });
	}
	return compiled;
}

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
	if (!isJsonObject(value)) return false;
	if (value.label !== undefined && typeof value.label !== "string") return false;
	if (value.reason !== undefined && typeof value.reason !== "string") return false;
	switch (value.kind) {
		case "exact":
		case "prefix":
		case "suffix":
		case "contains":
		case "email_domain":
			return typeof value.pattern === "string";
		case "snake_case_identifier":
		case "uuid":
			return true;
		default:
			return false;
	}
}

// Hardcoded shape regexes — compiled once at module load. These are the ONLY
// regexes the allowlist runs. User-supplied patterns route through string
// operations (===, startsWith, endsWith, includes), never into `new RegExp`.
// Eliminating the dynamic-RegExp surface eliminates the ReDoS class entirely.
const SNAKE_CASE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const UUID_V1_TO_V5 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function compileEntry(entry: AllowlistEntry): (text: string) => boolean {
	switch (entry.kind) {
		case "exact": {
			const literal = entry.pattern;
			// Case-sensitive literal equality — fast and unambiguous.
			return (text) => text === literal;
		}
		case "prefix": {
			const lower = entry.pattern.toLowerCase();
			return (text) => text.toLowerCase().startsWith(lower);
		}
		case "suffix": {
			const lower = entry.pattern.toLowerCase();
			return (text) => text.toLowerCase().endsWith(lower);
		}
		case "contains": {
			const lower = entry.pattern.toLowerCase();
			return (text) => text.toLowerCase().includes(lower);
		}
		case "email_domain": {
			// "example.com" matches *@example.com (case-insensitive). The "@"
			// anchor prevents accidental matches on substrings of larger
			// addresses (e.g., "example.com" wouldn't accidentally allowlist
			// "evilexample.com"-suffixed addresses).
			const lower = `@${entry.pattern.toLowerCase()}`;
			return (text) => text.toLowerCase().endsWith(lower);
		}
		case "snake_case_identifier":
			return (text) => SNAKE_CASE_IDENTIFIER.test(text);
		case "uuid":
			return (text) => UUID_V1_TO_V5.test(text);
	}
}

/**
 * Filter a list of findings through the compiled allowlist. A finding is
 * suppressed when ANY entry matches its `text` AND (the entry has no
 * `label` constraint OR the labels match). Suppression is silent on the
 * agent-facing path — the caller decides whether to log.
 */
export function applyAllowlist(
	findings: ScanFinding[],
	compiled: CompiledEntry[],
): AllowlistResult {
	if (compiled.length === 0) return { kept: findings, suppressed: [] };
	const kept: ScanFinding[] = [];
	const suppressed: AllowlistResult["suppressed"] = [];
	for (const finding of findings) {
		const hit = findMatchingEntry(finding, compiled);
		if (hit) {
			suppressed.push({ finding, entry: hit.entry });
		} else {
			kept.push(finding);
		}
	}
	return { kept, suppressed };
}

function findMatchingEntry(
	finding: ScanFinding,
	compiled: CompiledEntry[],
): CompiledEntry | null {
	for (const c of compiled) {
		// Label gate: entries with a `label` only apply to findings of that
		// category. An entry without `label` is category-agnostic — usually
		// not what you want, but supported for power users.
		if (c.entry.label !== undefined && c.entry.label !== finding.label) continue;
		if (c.matches(finding.text)) return c;
	}
	return null;
}
