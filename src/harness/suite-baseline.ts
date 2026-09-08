/**
 * Suite baseline — the test suite's state recorded at adopt/install time.
 *
 * Purpose: red-bar gates need to distinguish *pre-existing* red (the suite
 * was already failing when the harness arrived — a foreign-repo reality)
 * from *agent-caused* red (a test that went red under this agent's edits).
 * Recording the failing set once at adoption lets `newFailures` subtract
 * the inherited red from any later observation.
 *
 * Pure IO + compare — this module never executes a test suite. Whoever
 * records the baseline runs the suite out-of-band and hands us the names.
 *
 * Matching contract: failing-test names are compared by EXACT string match
 * only — no fuzzy matching, no normalization beyond identity. Baseline and
 * current names MUST come from the same runner's reporting format (e.g.
 * both from vitest's `file > describe > it` ids, or both from pytest
 * nodeids); mixing formats makes every failure look new (fail-loud in the
 * safe direction for a gate input).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SUITE_BASELINE_REL = join(".interlinked", "suite-baseline.json");

export interface SuiteBaseline {
	/** ISO-8601 timestamp of when the suite state was recorded. */
	recorded_at: string;
	/** Detected primary language / runner family (e.g. "typescript", "python"). */
	language: string;
	/** True when the suite was fully green at record time. */
	green: boolean;
	/** Exact failing-test identifiers at record time (empty when green). */
	failing_tests: string[];
}

/** Expected raw shape of a parsed baseline file — every field is `unknown`
 *  until validated by `normalizeSuiteBaseline`. */
interface RawSuiteBaseline {
	recorded_at?: unknown;
	language?: unknown;
	green?: unknown;
	failing_tests?: unknown;
}

/** Validate + normalize a parsed baseline; returns null when unusable (torn). */
function normalizeSuiteBaseline(raw: unknown): SuiteBaseline | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj: RawSuiteBaseline = raw;
	if (typeof obj.recorded_at !== "string") return null;
	if (typeof obj.language !== "string") return null;
	if (typeof obj.green !== "boolean") return null;
	if (!Array.isArray(obj.failing_tests)) return null;
	const failing: string[] = [];
	for (const entry of obj.failing_tests) {
		if (typeof entry !== "string") return null; // torn/foreign shape -> fail-open
		failing.push(entry);
	}
	return {
		recorded_at: obj.recorded_at,
		language: obj.language,
		green: obj.green,
		failing_tests: failing,
	};
}

/**
 * Read `.interlinked/suite-baseline.json` for `projectRoot`.
 * Returns null on missing, malformed JSON, or schema-torn content — fail-open:
 * with no baseline, `newFailures` treats every current failure as new, which
 * is exactly today's (pre-baseline) behavior.
 */
export function readSuiteBaseline(projectRoot: string): SuiteBaseline | null {
	const path = join(projectRoot, SUITE_BASELINE_REL);
	try {
		if (!existsSync(path)) return null;
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeSuiteBaseline(raw);
	} catch {
		return null;
	}
}

/**
 * Persist a suite baseline to `.interlinked/suite-baseline.json`, creating
 * the directory if needed. Plain `fs` write from the CLI process — same
 * carve-out as the other baseline writers (never passes through the
 * PreToolUse baseline-integrity gate).
 */
export function writeSuiteBaseline(projectRoot: string, b: SuiteBaseline): void {
	const path = join(projectRoot, SUITE_BASELINE_REL);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`, "utf-8");
}

/**
 * Failing tests NOT present in the baseline's failing set — i.e. failures
 * the agent plausibly caused, as opposed to inherited red.
 *
 * - `baseline === null` (missing/torn) or `baseline.green === true`: nothing
 *   was inherited, so every current failure is new — `currentFailing` is
 *   returned unchanged (same contents, order preserved).
 * - Red baseline: exact-string set subtraction against
 *   `baseline.failing_tests`. Duplicate entries in `currentFailing` are
 *   preserved as-is when not baselined (no dedup — callers own presentation).
 */
export function newFailures(currentFailing: string[], baseline: SuiteBaseline | null): string[] {
	if (baseline === null || baseline.green) return currentFailing;
	const inherited = new Set(baseline.failing_tests);
	return currentFailing.filter((name) => !inherited.has(name));
}
