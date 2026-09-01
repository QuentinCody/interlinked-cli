// interlinked-tdd: exempt
// ===========================================
// Commit gate — per-source violation scan + decision/degrade builders
// ===========================================
// The presentation/scan layer of the commit gate, extracted from
// `commit-gate.ts` to keep the orchestration entry small. Every function here
// is pure-ish: it takes explicit inputs and returns a Violation list or a
// HarnessDecision; none touch the orchestration state. The suite engine
// (`commit-gate-suite.ts`) and the entry (`commit-gate.ts`) import from here.

import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { newFailures, readSuiteBaseline } from "../suite-baseline.js";
import type { HarnessDecision } from "../types.js";
import {
	type ChangedSource,
	coverageViolation,
	crapViolation,
	cyclomaticViolation,
	isTypeOnlySource,
	missingCoverageViolation,
	type Violation,
} from "./commit-gate-scan.js";

/**
 * A per-function cyclomatic counter for one language. Returns `null` when the
 * backing analyzer is unavailable (typescript / radon absent) — the loud "do not
 * treat as simple" signal, which the cyclomatic + CRAP checks fail-open on.
 */
export type CyclomaticAnalyzer = (
	content: string,
	filePath: string,
) => FunctionComplexityEntry[] | null;

/** Cap on the number of named violations in a block reason (keep it scannable). */
const MAX_NAMED_VIOLATIONS = 8;

// ===========================================
// Per-source violation detection
// ===========================================

/** Inputs to the per-file violation scan — explicit so it needs no broader ctx. */
interface ScanInput {
	source: ChangedSource;
	cov: PerFileCoverage | undefined;
	content: string;
	analyzer: CyclomaticAnalyzer | null;
	crapThreshold: number;
	/** `per_edit_coverage.block_on_crap` — CRAP violations count only when true
	 *  (finding 2026-06: the commit gate scored CRAP unconditionally, making the
	 *  documented opt-out ineffective at commit time). */
	blockOnCrap: boolean;
	/** Effective per-repo cyclomatic cap (`maxCyclomaticFor(repoRoot)`). Optional:
	 *  when omitted the shipped default applies. Threading it here is what makes a
	 *  repo's `interlinked caps set cyclomatic` cap honored at commit time, not
	 *  just per-edit (finding 2026-06, round 8). */
	cyclomaticCap?: number;
}

/**
 * Collect every violation for one changed file: an uncovered executable line, a
 * function over the cyclomatic cap, and a function over the CRAP threshold. The
 * cyclomatic + CRAP checks need the analyzer; when it is unavailable (null) they
 * are skipped for this file (the loud-degrade is logged once by the caller).
 * Coverage checks run whenever the file appears in the report.
 */
export function scanFile(input: ScanInput): Violation[] {
	const { source, cov, content, analyzer, crapThreshold, blockOnCrap, cyclomaticCap } = input;
	const violations: Violation[] = [];

	// The cyclomatic + CRAP checks need a per-function analysis. An UNAVAILABLE
	// analyzer (null) or one that returned null (typescript / radon absent, or a
	// parse failure) loud-degrades — exactly like the per-edit gate fail-opens on
	// an unmeasured suite — and those two checks are skipped for this file.
	const complexities = analyzer ? analyzer(content, source.relPath) : null;

	if (cov) {
		const covViolation = coverageViolation(source, cov);
		if (covViolation) violations.push(covViolation);
	} else if (!isTypeOnlySource(content)) {
		// The full suite ran, yet this changed source is ABSENT from the coverage
		// report → no test loaded it → its executable code is UNCOVERED. Block instead
		// of silently skipping (finding 4). The ONLY exemption is a genuinely type-only
		// file (imports / interfaces / type aliases / re-exports): gating on "the
		// analyzer found ≥1 function" let function-less top-level code — `console.log`,
		// an initializing call, an enum — pass untested (finding 2026-06).
		violations.push(missingCoverageViolation(source));
	}

	if (!complexities) {
		loudDegrade(`no cyclomatic analysis for ${source.relPath} — CRAP / cyclomatic checks skipped`);
		return violations;
	}
	const cycViolation = cyclomaticViolation(source, complexities, cyclomaticCap);
	if (cycViolation) violations.push(cycViolation);
	if (cov && blockOnCrap) {
		const crapV = crapViolation(source, complexities, cov, crapThreshold);
		if (crapV) violations.push(crapV);
	}

	return violations;
}

// ===========================================
// Block / degrade builders
// ===========================================

/** Loud-degrade: warn on stderr, then allow (return null). Fail-open. */
export function loudDegrade(why: string): null {
	process.stderr.write(
		`[interlinked:commit-gate] WARNING: commit-time quality gate degraded (${why}) — ` +
			"allowing the commit (fail-open). The quality bar was NOT enforced for this commit.\n",
	);
	return null;
}

/** The red-bar (failing-suite) phrase for the block reason. */
export function failingTestPhrase(failingTests: string[]): string {
	if (failingTests.length === 0) return "one or more tests are failing";
	const shown = failingTests.slice(0, 3);
	const suffix = failingTests.length > shown.length ? ", …" : "";
	return `failing test(s): ${shown.join(", ")}${suffix}`;
}

/** Attach warnings to a decision only when there are any (exactOptionalPropertyTypes). */
function withWarnings(decision: HarnessDecision, warnings: string[]): HarnessDecision {
	return warnings.length > 0 ? { ...decision, warnings } : decision;
}

/** Build the red-bar commit block — a failing suite is the hardest failure. */
export function blockForRedBar(failingTests: string[], warnings: string[]): HarnessDecision {
	return withWarnings(
		{
			decision: "block",
			reason:
				"[interlinked:commit-gate] BLOCKED: the full test suite is RED on the working tree " +
				`you are about to commit — ${failingTestPhrase(failingTests)}. ` +
				"Fix the failing test(s) before committing — a commit must not capture a red bar.",
			rule_id: "commit-gate",
			severity: "high",
			category: "coverage",
		},
		warnings,
	);
}

/** Build the red-bar block for NEW failures beyond a recorded red baseline. */
function blockForNewRedBar(
	fresh: string[],
	toleratedCount: number,
	warnings: string[],
): HarnessDecision {
	return withWarnings(
		{
			decision: "block",
			reason:
				"[interlinked:commit-gate] BLOCKED: the full test suite is RED with NEW " +
				`failure(s) beyond the recorded suite baseline — ${failingTestPhrase(fresh)}. ` +
				`${toleratedCount} pre-existing failure(s) were tolerated per the recorded ` +
				"baseline. Fix the NEW failing test(s) before committing; once the suite is " +
				"green, re-record the baseline with `interlinked adopt --suite-baseline`.",
			rule_id: "commit-gate",
			severity: "high",
			category: "coverage",
		},
		warnings,
	);
}

/**
 * Red-bar decision, aware of a recorded suite baseline (foreign repos arrive
 * with pre-existing red — see `suite-baseline.ts`). Returns a block decision,
 * or null to tolerate the red bar (a one-line NOTE is pushed onto `warnings`;
 * the caller proceeds to the scan — the other gate axes are untouched).
 *
 *   - No baseline / green baseline → the historical unconditional block
 *     (byte-identical to the pre-baseline behavior).
 *   - UNNAMED red (the runner reported red without failure names) → block:
 *     it cannot be matched against the baseline, so fail toward blocking.
 *   - Red baseline → subtract the inherited failures; only NEW failures
 *     block (naming them), all-inherited red is tolerated with a warning.
 */
export function decideRedBar(
	failingTests: string[],
	warnings: string[],
	projectRoot: string,
): HarnessDecision | null {
	const baseline = readSuiteBaseline(projectRoot);
	if (baseline === null || baseline.green || failingTests.length === 0) {
		return blockForRedBar(failingTests, warnings);
	}
	const fresh = newFailures(failingTests, baseline);
	if (fresh.length > 0) {
		return blockForNewRedBar(fresh, failingTests.length - fresh.length, warnings);
	}
	warnings.push(
		`[interlinked:commit-gate] NOTE: the full suite is RED but all ${failingTests.length} ` +
			"failure(s) are pre-existing per the recorded suite baseline — not blocking on the " +
			"red bar. Re-record after greening: `interlinked adopt --suite-baseline`.",
	);
	return null;
}

/** Build the violations commit block, naming each violation. */
export function blockForViolations(violations: Violation[], warnings: string[]): HarnessDecision {
	const shown = violations.slice(0, MAX_NAMED_VIOLATIONS);
	const more =
		violations.length > shown.length ? `\n  … and ${violations.length - shown.length} more` : "";
	const lines = shown.map((v) => `  - [${v.kind}] ${v.file}: ${v.detail}`).join("\n");
	return withWarnings(
		{
			decision: "block",
			reason:
				"[interlinked:commit-gate] BLOCKED: the working tree you are about to commit violates " +
				`the quality bar (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n` +
				lines +
				more +
				"\n\nResolve these in the changed files (add coverage, decompose complex functions) " +
				"before committing — this repo enforces the quality bar at commit time because its " +
				"suite is too large for per-edit enforcement.",
			rule_id: "commit-gate",
			severity: "high",
			category: "coverage",
		},
		warnings,
	);
}

/** The `--no-verify` advisory warning, surfaced whenever the bypass is requested. */
export function noVerifyWarnings(noVerify: boolean): string[] {
	if (!noVerify) return [];
	return [
		"[interlinked:commit-gate] NOTE: `--no-verify` was passed — it bypasses git's own " +
			"commit hooks. The interlinked commit-time quality gate still evaluated this commit.",
	];
}

/**
 * Loud-degrade (allow) that still carries any accumulated warnings (e.g. the
 * `--no-verify` note). Returns an allow decision with warnings when present, else
 * the bare `loudDegrade` null — so the no-warning path stays a clean no-op.
 */
export function degradeWithWarnings(why: string, warnings: string[]): HarnessDecision | null {
	loudDegrade(why);
	return warnings.length > 0 ? { decision: "allow", warnings } : null;
}
