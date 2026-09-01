// interlinked-tdd: exempt
// ===========================================
// Red-bar-only enforcement for NON-TARGET gated sections (findings 2026-06)
// ===========================================
// Extracted VERBATIM from coverage-write-guard.ts to keep that module under the
// per-file line cap. Coverage targets cover only files the gate can SCAN. A patch
// can also carry gated-language sections with no target: deletions / move sources
// (nothing to scan) and — in a DIFFERENT ecosystem than every target — test or
// non-cappable sections. Those sections still land in the overlay and can break
// THEIR language's suite while every target language stays green (finding 2026-06:
// a TS update + Python deletion ran only vitest, and the pytest breakage shipped
// undetected). The red bar is the one decidable axis for them, so:
//   - a delete-only plan (no targets at all) runs EVERY gated overlay language;
//   - a target-bearing plan additionally runs every gated overlay language whose
//     RUNNER no target already runs (the Vitest runner serves js+ts, so a ts
//     target's run covers a js section).
// Both paths are opt-in via `block_on_test_failure`, budget-gated (the deferred
// obligation lands on the language-aware commit gate), and fail-open. No behavior
// changed — same text, same control flow.

import { RED_BAR_MARKER } from "../coverage-debt.js";
import {
	readRuntimeEstimateMs,
	updateRuntimeEstimateMs,
} from "../coverage-obligation-ledger.js";
import type { OverlayFile } from "../coverage-overlay.js";
import { type CoverageLanguage, coverageLanguageForPath } from "../coverage-runner.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { CoverageEditPlan } from "./coverage-edit-targets.js";
import { failingTestPhrase } from "./coverage-write-decision.js";
import type { CoverageWriteDeps } from "./coverage-write-guard.js";
import {
	deferForBudget,
	loudDegrade,
	loudRunnerUnavailable,
} from "./coverage-write-guard-degrade.js";

/** The plan's overlay DELETIONS whose language the gate covers. */
function gatedDeletions(
	plan: CoverageEditPlan,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
): OverlayFile[] {
	return plan.overlayFiles.filter((f) => {
		if (!f.delete) return false;
		const language = coverageLanguageForPath(f.relPath);
		return language !== null && cfg.languages.includes(language);
	});
}

/** Every gated-language overlay section grouped by language — targets, tests,
 *  deletions, move sources: the full set the patch materializes. */
function gatedSectionsByLanguage(
	plan: CoverageEditPlan,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
): Map<CoverageLanguage, OverlayFile[]> {
	const byLanguage = new Map<CoverageLanguage, OverlayFile[]>();
	for (const f of plan.overlayFiles) {
		const language = coverageLanguageForPath(f.relPath);
		if (language === null || !cfg.languages.includes(language)) continue;
		const list = byLanguage.get(language) ?? [];
		list.push(f);
		byLanguage.set(language, list);
	}
	return byLanguage;
}

/** The red-bar block for a deletion that breaks the suite. Interpolates
 *  {@link RED_BAR_MARKER} deliberately: under debt_mode this verdict folds into
 *  the pair's `red_suite` debt like any other red bar — so it also carries the
 *  failing test FILES as `failing_test_files`, the evidence that debt records.
 *  Exported for the producer↔matcher pin test in coverage-debt.test.ts. */
export function blockForDeletionRedBar(
	relPaths: string[],
	failingTests: string[] | undefined,
	failingTestFiles?: string[],
): HarnessDecision {
	const shown = relPaths.slice(0, 3).join(", ") + (relPaths.length > 3 ? ", …" : "");
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: deleting ${shown} ${RED_BAR_MARKER} — ` +
			`${failingTestPhrase(failingTests)}. Other code still depends on what this patch ` +
			"removes; update or remove the dependents in the SAME patch (the overlay sees the " +
			"whole patch together), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
		...(failingTestFiles && failingTestFiles.length > 0
			? { failing_test_files: failingTestFiles }
			: {}),
	};
}

/** The red-bar block for a cross-ecosystem section (a language no target's
 *  runner serves) that breaks ITS suite. Deliberately does NOT interpolate
 *  {@link RED_BAR_MARKER} ("leave the ${language} test suite RED" ≠ the
 *  marker): cross-ecosystem breakage is not the edited pair's red→green loop,
 *  so debt-mode must NOT fold it — it stays a hard block. Exported for the
 *  producer↔matcher pin test in coverage-debt.test.ts. */
export function blockForCrossSuiteRedBar(
	language: CoverageLanguage,
	relPaths: string[],
	failingTests: string[] | undefined,
): HarnessDecision {
	const shown = relPaths.slice(0, 3).join(", ") + (relPaths.length > 3 ? ", …" : "");
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this patch's ${language} sections (${shown}) leave the ` +
			`${language} test suite RED — ${failingTestPhrase(failingTests)}. The patch's coverage ` +
			`targets are in a different ecosystem, so that suite would not otherwise run; fix the ` +
			`${language} breakage in the SAME patch, then retry.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Materialize ONE overlay carrying the whole patch and run each language's
 *  suite red-bar-only, once per distinct runner (the Vitest runner serves both
 *  js and ts — dedup by execution key like the commit gate). Returns the
 *  `block(...)` decision for the first red language, a loud degrade, or null
 *  (all green). */
async function runRedBarSuites(
	byLanguage: Map<CoverageLanguage, OverlayFile[]>,
	plan: CoverageEditPlan,
	projectRoot: string,
	deps: CoverageWriteDeps,
	block: (
		language: CoverageLanguage,
		relPaths: string[],
		failingTests: string[] | undefined,
		failingTestFiles?: string[],
	) => HarnessDecision,
): Promise<HarnessDecision | null> {
	const entries = [...byLanguage.entries()];
	const anchor = entries[0]?.[1]?.[0];
	if (!anchor) return null;
	// The anchor's own content rides the `proposed` slot (the overlay skips its
	// duplicate non-delete entry); a deleted anchor materializes as "" and its
	// delete marker then removes it (finding 2026-06).
	const overlay = deps.createOverlay(
		projectRoot,
		anchor.relPath,
		anchor.delete ? "" : anchor.content,
		plan.overlayFiles,
	);
	try {
		const ranKeys = new Set<string>();
		for (const [language, sections] of entries) {
			const runner = deps.runnerFor(language);
			if (!runner) {
				return loudRunnerUnavailable(
					{ projectRoot, relPath: anchor.relPath, language },
					`no coverage runner for ${language}`,
				);
			}
			const key = runner.id ?? language;
			if (ranKeys.has(key)) continue;
			ranKeys.add(key);
			const result = await runner.run({
				projectRoot: overlay.overlayRoot,
				coverageDir: `${overlay.overlayRoot}/.interlinked/coverage`,
			});
			updateRuntimeEstimateMs(projectRoot, result.suiteMs, deps.clock);
			if (!result.ok) {
				return loudRunnerUnavailable(
					{ projectRoot, relPath: anchor.relPath, language },
					result.error ?? "coverage run failed",
				);
			}
			if (result.testsPassed === false) {
				return block(
					language,
					sections.map((s) => s.relPath),
					result.failingTests,
					result.failingTestFiles,
				);
			}
		}
		return null;
	} finally {
		overlay.cleanup();
	}
}

/**
 * Enforcement for a plan with NO coverage targets: a DELETE-ONLY source patch.
 * The deletion has nothing to scan, but it can break the suite — every importer
 * of the removed module fails to resolve — and the old `targets.length === 0 →
 * null` skipped enforcement entirely (finding 2026-06). This path materializes
 * the whole-patch overlay (the suite sees the files ABSENT) and runs
 * RED-BAR-ONLY across EVERY gated overlay language — the deletions' own
 * languages plus any sibling section's (a deletion paired with a test file in
 * another ecosystem must run both suites, finding 2026-06):
 *   - only when `block_on_test_failure` is on — with it off the gate has no
 *     decision it could make for a deletion (no coverage target), so no suite
 *     is spent. A patch with NO gated deletion (pure test/non-code) stays
 *     ungated: a failing NEW test is legal TDD, not a regression;
 *   - budget-gated like every full-suite route (the deferred obligation lands
 *     on the commit gate, which runs delete-only suites too);
 *   - fail-open on any error (loud-degrade), like every other gate path.
 */
export async function decideForDeletionOnly(
	event: HarnessEvent,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
	deps: CoverageWriteDeps,
	plan: CoverageEditPlan,
	projectRoot: string,
): Promise<HarnessDecision | null> {
	const deletions = gatedDeletions(plan, cfg);
	const first = deletions[0];
	if (!first) return null; // nothing gated deleted (non-code / pure-test / not a patch)
	if (cfg.block_on_test_failure !== true) return null; // no decidable axis
	try {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, first.relPath, event, estimate, cfg.budget_ms);
		}
		// A red language with a deletion blocks AS a deletion (the trigger); a red
		// sibling language with none blocks as the cross-ecosystem section it is.
		const block = (
			language: CoverageLanguage,
			relPaths: string[],
			failingTests: string[] | undefined,
			failingTestFiles?: string[],
		): HarnessDecision => {
			const dels = deletions
				.filter((d) => coverageLanguageForPath(d.relPath) === language)
				.map((d) => d.relPath);
			return dels.length > 0
				? blockForDeletionRedBar(dels, failingTests, failingTestFiles)
				: blockForCrossSuiteRedBar(language, relPaths, failingTests);
		};
		return await runRedBarSuites(gatedSectionsByLanguage(plan, cfg), plan, projectRoot, deps, block);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(first.relPath, why);
	}
}

/**
 * Enforcement for the gated overlay languages a TARGET-BEARING plan does NOT
 * already run: a patch updating TypeScript while deleting (or moving, or adding
 * a test in) Python ran only the targets' runner — vitest green shipped a
 * pytest breakage undetected (finding 2026-06). Languages whose runner some
 * target already runs are excluded by EXECUTION KEY (a ts target's Vitest run
 * covers js sections). Red-bar-only, opt-in via `block_on_test_failure`,
 * budget-gated, fail-open — the same contract as the delete-only path.
 */
export async function decideForResidualLanguages(
	event: HarnessEvent,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
	deps: CoverageWriteDeps,
	plan: CoverageEditPlan,
	projectRoot: string,
): Promise<HarnessDecision | null> {
	if (cfg.block_on_test_failure !== true) return null; // red bar is the only axis here
	const targetKeys = new Set<string>();
	for (const t of plan.targets) targetKeys.add(deps.runnerFor(t.language)?.id ?? t.language);
	const residual = new Map<CoverageLanguage, OverlayFile[]>();
	for (const [language, sections] of gatedSectionsByLanguage(plan, cfg)) {
		const key = deps.runnerFor(language)?.id ?? language;
		if (!targetKeys.has(key)) residual.set(language, sections);
	}
	const anchor = [...residual.values()][0]?.[0];
	if (!anchor) return null; // every gated section's runner already ran
	try {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, anchor.relPath, event, estimate, cfg.budget_ms);
		}
		return await runRedBarSuites(residual, plan, projectRoot, deps, blockForCrossSuiteRedBar);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(anchor.relPath, why);
	}
}
