// ===========================================
// PostToolUse flake double-run phase (DW test-adoption P0.2)
// ===========================================
// When `per_edit_coverage.flake_check` is on (opt-in, default off) and the
// completed edit touched a TEST file, re-run its affected scoped suite twice
// and surface a `[interlinked:flake]` warning if the two runs disagree. Runs
// here (PostToolUse) rather than the PreToolUse coverage gate because the edit
// is already on disk — no apply-before-disk overlay needed — and the pure
// comparison + double-run orchestration live in `evaluator/test-flake-guard.ts`
// (unit-tested). Warn-only; a rejected/undeterminable run yields no warning, so
// this never breaks the PostToolUse response.

import { join, relative, resolve } from "node:path";
import { observeFlakeOutcome } from "../calibration/flake-calibrator.js";
import { coverageLanguageForPath, coverageRunnerFor } from "../coverage-runner.js";
import { isTestPath, selectAffectedTests } from "../coverage-test-selector.js";
import { resolveDependencyView } from "../dependency-view.js";
import { runFlakeDoubleCheck } from "../evaluator/test-flake-guard.js";
import { isFileWrite } from "../evaluator/tool-classifiers.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";

/** The edited repo-relative TEST file that has a coverage language, or null for
 *  a non-write / non-test / non-coverage-language edit. */
function editedTestFile(event: HarnessEvent, cwd: string): string | null {
	if (!isFileWrite(event.tool_name)) return null;
	const input = event.tool_input ?? {};
	const named =
		(typeof input.file_path === "string" && input.file_path) ||
		(typeof input.path === "string" && input.path) ||
		"";
	if (!named) return null;
	const rel = relative(cwd, resolve(cwd, named)).replace(/\\/g, "/");
	if (!isTestPath(rel)) return null;
	return coverageLanguageForPath(rel) ? rel : null;
}

/** The scoped test set to double-run for `editedFile`. Affected-test selection
 *  over the dependency graph, defaulting to the edited test itself when the
 *  selection is null (full-suite fallback — too heavy to double-run) or empty. */
function scopedTestsFor(ctx: ServerRuntime, editedFile: string): string[] {
	try {
		const abs = resolve(ctx.cwd, editedFile);
		const depView = resolveDependencyView(abs, ctx.cwd, getGraphForFile(ctx, abs));
		const selected = selectAffectedTests({ editedRelPath: editedFile, projectRoot: ctx.cwd, depView });
		if (selected && selected.length > 0) return selected;
	} catch (e) {
		void e; // graph unavailable / selection failed — fall through to the edited test.
	}
	return [editedFile];
}

/**
 * Append the flake-check warning to `decision.warnings` when the feature is on
 * and the edit touched a test file. Fast no-op (a single config read) when off.
 */
export async function appendFlakeCheckWarning(
	ctx: ServerRuntime,
	event: HarnessEvent,
	decision: HarnessDecision,
): Promise<void> {
	const cfg = ctx.rules.per_edit_coverage;
	if (cfg?.flake_check !== true) return; // opt-in, default off

	const editedFile = editedTestFile(event, ctx.cwd);
	if (!editedFile) return;
	const language = coverageLanguageForPath(editedFile);
	if (!language) return;
	const runner = coverageRunnerFor(language);
	if (!runner) return;

	const selectedTests = scopedTestsFor(ctx, editedFile);
	const coverageDir = join(ctx.cwd, ".interlinked", "flake-coverage");
	const timeoutMs = cfg.budget_ms;
	const warning = await runFlakeDoubleCheck(() =>
		runner.run({ projectRoot: ctx.cwd, coverageDir, selectedTests, timeoutMs }),
	);
	// Feed the outcome (diverged / clean) into the persistent flake e-process
	// (P4 §6). The single warning fires on ANY divergence; the calibrated
	// escalation fires only when the flake RATE is statistically elevated.
	const escalation = observeFlakeOutcome(ctx.cwd, warning !== null);
	if (warning) {
		decision.warnings = [...(decision.warnings ?? []), warning];
	}
	if (escalation) {
		decision.warnings = [...(decision.warnings ?? []), `[interlinked:flake-calibrator] ${escalation}`];
	}
}
