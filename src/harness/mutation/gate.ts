// ===========================================
// Per-edit mutation — PreToolUse gate orchestration (build steps 1 & 7)
// ===========================================
// The entry point the hook pipeline calls: normalize the tool_input, pick the
// edited code file, and — capability-aware (spec §12) — either run the injected
// MutationRunner and evaluate, or return a not-measured allow. Default-off; the
// runner is null until the cloud Sandbox runner is wired, so an enabled-but-
// runnerless install honestly discloses `[mutation:not-measured]` and never
// claims a clean pass. The wiring into pre-tool-pipeline.ts is a thin call site.

import { expectedSourceOfTest } from "../coverage-debt.js";
import { isTestPath } from "../coverage-test-selector.js";
import type { HarnessDecision } from "../types/decisions.js";
import { changedPaths, normalizeChangeSet } from "./changeset.js";
import { evaluateMutation } from "./evaluate.js";
import * as gateDecision from "./gate-decision.js";
import {
	buildMutationOverlays,
	type FileOverlay,
	overlayContentFor,
} from "./gate-overlays.js";
import {
	isMutationTarget,
	MUTATION_CODE_EXT,
	multiSourceNotMeasuredReason,
} from "./mutation-target.js";
import type { MutationRunOutput } from "./stryker-adapter.js";
import { testEditEffect } from "./test-edit-effect.js";
import type { MutationManifest, MutationReceipt } from "./types.js";

/** Default small-scope ceiling (spec §6) — clj-mutate's "consider splitting a file
 *  over 50 sites" precedent. Per-repo configurable via `site_count_threshold`. */
export const DEFAULT_SITE_COUNT_THRESHOLD = 50;

export interface PerEditMutationConfig {
	enabled: boolean;
	mode: "block" | "warn" | "off";
	unavailable_behavior: "allow_unmeasured" | "block";
	/** Spec §6 small-scope ceiling; over this many changed-region sites ⇒ "split
	 *  this patch" block. Omitted ⇒ {@link DEFAULT_SITE_COUNT_THRESHOLD}. */
	site_count_threshold?: number | undefined;
	/** Wall-clock budget for the cloud runner round-trip (spec §12). Expiry ⇒
	 *  honest not-measured, never a forged pass. Omitted ⇒ 25 000 ms. Tune DOWN
	 *  when the runner is known-unmeasurable for this repo (e.g. scaffolding not
	 *  yet on the remote) so the per-edit latency tax stays small. */
	budget_ms?: number | undefined;
	/** How long the PostToolUse window will WAIT for a run that outlived
	 *  {@link PerEditMutationConfig.budget_ms}. This is the second half of the
	 *  two-window design: PostToolUse fires milliseconds after the write while
	 *  the run still needs seconds, so without a wait the work is discarded.
	 *  Bounds how long the agent's turn is held. Omitted ⇒ 25 000 ms. An
	 *  unreachable runner returns immediately regardless. */
	harvest_budget_ms?: number | undefined;
	/** Ceiling on graph-selected test files per mutation run (plan 25 Class-2
	 *  knob). Absent ⇒ test-scope.ts's MAX_MUTATION_TEST_SCOPE (150, calibrated
	 *  against THIS repo's largest hub — another repo's hub may legitimately
	 *  need more). Over the ceiling the scope declines to the companion set,
	 *  never silently widens toward the whole suite. */
	max_test_scope?: number | undefined;
	/** Cloud Sandbox runner endpoint; absent → no runner → honest not-measured. */
	runner_url?: string | undefined;
	/**
	 * OBSOLETE (v1, review passes 11-19): line-range partitioning across
	 * multiple endpoints is RETIRED — a mutant spanning a split vanished from
	 * both sides. Extra entries are NOT used (no partition, no failover yet);
	 * configuring them emits a loud one-time deprecation warning so nobody
	 * believes three endpoints are serving when only the first is.
	 */
	runner_urls?: string[] | undefined;
	/**
	 * OBSOLETE (v1, review passes 11-19): cloud-side shard fan-out is RETIRED
	 * with the rest of line-range execution. The value is IGNORED and emits a
	 * loud one-time deprecation warning. Future exact-mutant-ID sharding is
	 * plan 27 Appendix B work, behind new configuration, not this knob.
	 */
	cloud_shards?: number | undefined;
	token?: string | undefined;
}

export type { FileOverlay } from "./gate-overlays.js";

/** Exact tests selected by the CLI's dependency graph for this mutation run. */
export interface MutationRunOptions {
	testFiles: readonly string[];
	scopeMode: "import_graph" | "companion_fallback";
}

/**
 * Production test-scope decision made before the mutation runner is invoked.
 * A reduced companion scope can still prove a survivor or red suite, but it
 * can never certify clean. An unavailable scope does not run at all.
 */
export type MutationTestSelection =
	| { kind: "selected"; options: MutationRunOptions; partial: boolean }
	| { kind: "unavailable"; reason: string };

/**
 * The mutation execution backend (cloud Sandbox runner / local Stryker).
 * `overlays` carries the FULL proposed state — every ChangeSet file plus the
 * primary's companion test when it exists on local disk (the cloud clone comes
 * from git, so a test-first test that only exists locally must travel with the
 * edit or red/green + RED-witness can't see it). Always includes the primary.
 */
export interface MutationRunner {
	available(): boolean;
	/**
	 * One file, one WHOLE-FILE Stryker run (v1, review passes 11-19): line-range
	 * execution is retired — a ranged run was a partial view that could find
	 * adverse evidence but never certify clean, and a boundary-spanning mutant
	 * could vanish from both sides of a split.
	 */
	run(
		file: string,
		overlayContent: string,
		overlays?: FileOverlay[],
		options?: MutationRunOptions,
	): Promise<MutationRunOutput>;
}

export interface MutationGateContext {
	toolName: string;
	toolInput: unknown;
	config: PerEditMutationConfig;
	runner: MutationRunner | null;
	baseManifest: MutationManifest;
	readDisk: (file: string) => string | null;
	/**
	 * Dependency-graph-selected tests. The daemon always supplies this. Omitted
	 * only by legacy/direct callers, which preserves their existing behavior
	 * while the production path refuses to manufacture completeness.
	 */
	testSelection?: MutationTestSelection | undefined;
	/** Production resolver, invoked only after normalization chooses the actual
	 * source target (including a companion-test edit whose target is the SUT). */
	selectTests?: ((target: string) => MutationTestSelection) | undefined;
	/** Persistence sink for a measured-clean pass (manifest snapshot + receipt).
	 *  Absent → evaluate-only. Persistence failures are swallowed — they must
	 *  never break the gate (the allow still stands). */
	persist?: ((manifest: MutationManifest, receipt: MutationReceipt) => void) | undefined;
	/** Called when a run outlives the budget but is still computing remotely.
	 *  Handing the handles out here is what makes the PostToolUse window able to
	 *  claim work this window paid for but could not wait for. Absent → the
	 *  results are simply dropped, which is the old single-window behaviour. */
	onPending?: ((file: string, overlayContent: string, pending: readonly PendingHandle[]) => void) | undefined;
	at: string;
	/** Repo root to resolve an absolute `file_path` against when keying the
	 *  manifest (manifest.ts's `normalizeManifestKey`) — pass the daemon's actual
	 *  `ctx.cwd`, which can diverge from `process.cwd()` under an explicit
	 *  `--cwd`. Omitted callers fall back to `process.cwd()`. */
	cwd?: string;
}

/** The minimum a caller needs to come back for an unfinished run. */
export interface PendingHandle {
	jobId: string;
	runnerUrl: string;
}

/**
 * Pull the still-running job handles out of whatever a runner threw.
 *
 * Both shapes matter: a single runner rejects with `MutationRunPendingError`
 * directly, while a wrapper that aggregates several rejections carries them in
 * a `pending` array. Anything else is a real failure with nothing to claim.
 * Structural checks, not `instanceof`, so this stays free of an import cycle
 * with the runners that depend on this module's types.
 */
export function pendingHandlesFrom(err: unknown): PendingHandle[] {
	const isHandle = (v: unknown): v is PendingHandle =>
		typeof v === "object" &&
		v !== null &&
		// SAFETY: object-ness is established above; these two reads are the
		// predicate's actual test, and `typeof` on a missing key is "undefined",
		// so a non-handle fails rather than throwing.
		typeof (v as PendingHandle).jobId === "string" &&
		typeof (v as PendingHandle).runnerUrl === "string";

	if (isHandle(err)) return [err];
	const nested = errRecord(err)?.pending;
	if (Array.isArray(nested)) return nested.filter(isHandle);
	return [];
}

/**
 * Narrow an `unknown` thrown value to a plain object, or `undefined` if it
 * isn't one — `err` genuinely can be `null`/a primitive/anything at runtime
 * (it comes from a `catch`), so every field read below goes through this
 * instead of an `as {..}` cast that would silently assert non-nullish-ness
 * the type checker can't actually verify.
 */
function errRecord(err: unknown): Record<string, unknown> | undefined {
	return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
}

/**
 * Why the run produced no verdict.
 *
 * Three outcomes that used to read identically as "the mutation runner failed",
 * which is the least useful of them and was wrong most of the time:
 *   - still working  -> results ARE coming, in the PostToolUse window
 *   - not measurable -> the runner succeeded; there is nothing to measure
 *                       (usually: no test exercises this file)
 *   - failed         -> actually broken
 */
function notMeasuredReason(err: unknown, pendingCount: number): string {
	if (pendingCount > 0) return "mutation still running past the budget";
	if (isRunnerBusy(err)) {
		return "the mutation runner is busy with another job right now — not measured this edit, and NOT evidence this file has no tests (retry on the next edit)";
	}
	const reason = notMeasurableReasonOf(err);
	if (reason === "no_tests") {
		return "no test exercises this file, so mutation cannot measure it — add one and the gate starts protecting this code";
	}
	if (reason !== null) return `mutation not measurable here (${reason})`;
	return describeRunnerFailure(err);
}

/**
 * Quote the runner's own words.
 *
 * "the mutation runner failed" was the terminal string for every unclassified
 * error, and it was the DOMINANT live outcome — 12 occurrences in the last 4000
 * activity records, against zero measured verdicts. It names the component and
 * withholds the cause, which is the one combination nobody can act on: the
 * reader cannot separate a dead endpoint from a failed clone from a crashed
 * engine, so re-running is the only move left. The client now carries the
 * response body up (`describeErrorResponse`), so there is finally something to
 * say.
 */
function describeRunnerFailure(err: unknown): string {
	const message = errRecord(err)?.message;
	if (typeof message !== "string" || message.trim() === "") return "the mutation runner failed";
	return `the mutation runner failed — ${message.trim()}`;
}

/**
 * A contended runner is not a broken one, and it is definitely not a
 * "no tests" verdict — collapsing "busy" into either is the exact
 * measurement-integrity defect this check exists to prevent (a contended
 * runner silently drops the file out of the denominator). Detected
 * structurally — by error name (a runner that throws the dedicated
 * `MutationRunnerBusyError`) or by message (the generic HTTP-status error a
 * plain non-ok response produces) — rather than `instanceof`, so this module
 * stays free of an import cycle with the runners it evaluates.
 */
function isRunnerBusy(err: unknown): boolean {
	const name = errRecord(err)?.name;
	if (name === "MutationRunnerBusyError") return true;
	const message = errRecord(err)?.message;
	return typeof message === "string" && /\bHTTP 503\b/.test(message);
}

/** Structural read, so this module stays free of an import cycle with the runners. */
function notMeasurableReasonOf(err: unknown): string | null {
	const name = errRecord(err)?.name;
	if (name !== "MutationNotMeasurableError") return null;
	const reason = errRecord(err)?.reason;
	return typeof reason === "string" && reason !== "" ? reason : "unspecified";
}

/**
 * The file in this change set worth mutating.
 *
 * Test files are NOT worth mutating, and excluding them is a measurement
 * decision rather than an optimisation: mutation testing asks whether the tests
 * would notice a defect in the code, so mutating the tests themselves asks
 * whether anything would notice a changed test — for which the answer is almost
 * always no. The result would be a near-100% survivor rate that means nothing.
 *
 * It also failed concretely: a run targeting `harvest.test.ts` derived the test
 * scope `harvest.test.test.ts`, matched no tests, and reported the same opaque
 * "runner failed" as every other mis-scoped run.
 */
export function primaryCodeFile(paths: string[]): string | null {
	return paths.find(isMutationTarget) ?? null;
}

/**
 * MUT-AC-26 (review passes 15-18): a change set with MORE THAN ONE eligible
 * source file is NOT-MEASURED, honestly — measuring the first file while
 * silently skipping the rest implied the whole set passed (the multi-file
 * analog of the empty-report forged clean). Per-file aggregation is bar-C
 * work; until it exists the gate refuses to pick a favorite. Today's
 * normalizers (Write/Edit/MultiEdit) are single-file, so this fires only
 * once a multi-file adapter (e.g. apply_patch) lands — it is the guard that
 * keeps that adapter from silently under-measuring on day one.
 */
export { multiSourceNotMeasuredReason } from "./mutation-target.js";

/**
 * What this change set should be measured against, including the TEST-EDIT case.
 *
 * Editing a test used to measure nothing at all: `primaryCodeFile` correctly
 * refuses to mutate a test, and with no code file in the set the gate returned
 * null. But "I added a test" is precisely the claim mutation testing exists to
 * check, and it was the one edit shape that went unchecked — a test could be
 * added, pass, and kill nothing, and the harness would say nothing.
 *
 * So a test-only change set resolves to the code that test protects, and the
 * run measures THAT with the new test overlaid. The comparison against the
 * manifest baseline then answers the real question: did the survivor count go
 * down?
 *
 * The companion convention (`foo.test.ts` -> `foo.ts`) is the same one the
 * coverage gate pairs on — `expectedSourceOfTest`, not a second opinion. A test
 * with no such source (an integration or end-to-end suite protecting no single
 * module) resolves to null and is skipped, because guessing a target for it
 * would measure something the edit was not about.
 */
export function mutationTargetFor(paths: string[], exists: (path: string) => boolean): string | null {
	const direct = primaryCodeFile(paths);
	if (direct !== null) return direct;
	for (const path of paths) {
		if (!isTestPath(path) || !MUTATION_CODE_EXT.test(path)) continue;
		const source = expectedSourceOfTest(path);
		if (source !== path && isMutationTarget(source) && exists(source)) return source;
	}
	return null;
}

/**
 * Is this path product code the tests are supposed to protect?
 *
 * `scratch/` is excluded through the repo's ONE product-code domain definition
 * rather than a second opinion — a probe script has no companion test by design,
 * so targeting it can only ever produce "no tests were executed".
 */
/** The run's evidence fields, forwarded to the evaluator only when the runner
 *  actually reported them.
 *
 *  Absent must stay absent rather than becoming a value: the evaluator draws a
 *  distinction between "the runner said nothing about this" and "the runner
 *  reported it", and a default here would quietly erase that distinction and
 *  manufacture evidence the run never produced. */
function runEvidenceFields(result: {
	droppedMutants?: number;
	engineExitCode?: number | null;
	executedTestCount?: number | null;
}): { droppedMutants?: number; engineExitCode?: number | null; executedTestCount?: number | null } {
	return {
		...(result.droppedMutants !== undefined ? { droppedMutants: result.droppedMutants } : {}),
		...(result.engineExitCode !== undefined ? { engineExitCode: result.engineExitCode } : {}),
		...(result.executedTestCount !== undefined ? { executedTestCount: result.executedTestCount } : {}),
	};
}

function unavailableTestSelection(selection: MutationTestSelection | undefined): string | null {
	return selection?.kind === "unavailable" ? selection.reason : null;
}

function resolvedTestSelection(ctx: MutationGateContext, target: string): MutationTestSelection | undefined {
	return ctx.selectTests?.(target) ?? ctx.testSelection;
}

function selectedRunOptions(selection: MutationTestSelection | undefined): MutationRunOptions | undefined {
	return selection?.kind === "selected" ? selection.options : undefined;
}

function testSelectionIsPartial(selection: MutationTestSelection | undefined): boolean {
	return selection?.kind === "selected" && selection.partial;
}

function runSelectedMutation(
	runner: MutationRunner,
	target: string,
	overlayContent: string,
	overlays: FileOverlay[],
	options: MutationRunOptions | undefined,
): Promise<MutationRunOutput> {
	if (options === undefined) return runner.run(target, overlayContent, overlays);
	return runner.run(target, overlayContent, overlays, options);
}

/** PreToolUse per-edit mutation gate (spec §4 / §12). Default-off; capability-aware. */
export async function runPerEditMutationGate(ctx: MutationGateContext): Promise<HarnessDecision | null> {
	if (!ctx.config.enabled || ctx.config.mode === "off") return null;
	const changeSet = normalizeChangeSet(ctx.toolName, ctx.toolInput);
	if (changeSet === null) return null;
	const paths = changedPaths(changeSet);
	const multiSourceReason = multiSourceNotMeasuredReason(paths);
	if (multiSourceReason !== null) {
		return gateDecision.unavailableDecision(ctx.config, multiSourceReason);
	}
	const target = mutationTargetFor(paths, (p) => ctx.readDisk(p) !== null);
	if (target === null) return null;

	if (ctx.runner === null || !ctx.runner.available()) {
		return gateDecision.unavailableDecision(ctx.config, "no mutation runner configured");
	}
	const testSelection = resolvedTestSelection(ctx, target);
	const unavailableScope = unavailableTestSelection(testSelection);
	if (unavailableScope !== null) return gateDecision.unavailableDecision(ctx.config, unavailableScope);

	const disk = ctx.readDisk(target);
	if (disk === null) {
		// A NEW file. It has a legitimate empty baseline and real proposed
		// content, so it is squarely in scope — but v1 cannot certify it: with
		// no prior manifest entry every mutant is first-sighting, which is
		// baseline ADOPTION, not evidence that this edit is safe (the
		// distinction the whole evidence contract turns on). Returning `null`
		// here made the highest-risk edit in the tree — brand-new, untested
		// code — the ONE edit that silently skipped the gate, and skipped it
		// without leaving a trace anyone could audit. Not-measured is the
		// honest answer: it warns, and under a fail-closed
		// `unavailable_behavior` it blocks, exactly like every other case where
		// the gate cannot see enough.
		return gateDecision.unavailableDecision(
			ctx.config,
			`new file has no on-disk baseline to measure against (${target})`,
		);
	}
	const overlayContent = overlayContentFor(changeSet, target, disk);
	if (overlayContent === null) {
		// The edit could not be applied to the on-disk content (a stale Edit
		// whose old_string no longer matches, an unsupported payload shape).
		// Silence here would report the same nothing as "not eligible".
		return gateDecision.unavailableDecision(
			ctx.config,
			`could not reconstruct the proposed content for ${target}`,
		);
	}

	// v1 measures the WHOLE FILE (review passes 11-18): line-range execution is
	// removed entirely — Stryker only emits mutants whose full AST span fits a
	// range, so EVERY ranged run was a partial view that could find adverse
	// evidence but never certify clean (a cost with no conclusive answer), and
	// a boundary-spanning mutant could vanish from both sides of a split. The
	// changed-region VERDICT scoping is unaffected: the evaluator still judges
	// only changed symbols via the manifest's symbol hashes.
	let result: MutationRunOutput;
	try {
		const runOptions = selectedRunOptions(testSelection);
		const overlays = buildMutationOverlays({
			changeSet,
			target,
			overlayContent,
			readDisk: ctx.readDisk,
			testFiles: runOptions?.testFiles ?? [],
		});
		result = await runSelectedMutation(ctx.runner, target, overlayContent, overlays, runOptions);
	} catch (err) {
		// A budget expiry is not a failure — the engine is still working and the
		// runner retains the report, so hand the handles up for the next window.
		// The answer is still "not measured", because right now it genuinely is.
		const pending = pendingHandlesFrom(err);
		if (pending.length > 0 && ctx.onPending) ctx.onPending(target, overlayContent, pending);
		return gateDecision.unavailableDecision(ctx.config, notMeasuredReason(err, pending.length));
	}
	// Completeness gate (external review 2026-08-23, second pass, finding 1): a
	// sharded run with ANY missing shard is a partial view — a survivor in the
	// missing tile would be invisible, so evaluating it could persist a forged
	// clean pass. Incomplete ⇒ honest not-measured; the manifest never moves.
	if ((result.incompleteShards ?? 0) > 0) {
		return gateDecision.unavailableDecision(
			ctx.config,
			`${result.incompleteShards} of the planned mutation shard(s) did not report — partial results never count as measured (a missing shard could be hiding survivors)`,
		);
	}
	const outcome = evaluateMutation({
		file: target,
		baseManifest: ctx.baseManifest,
		overlayContent,
		adapted: result.mutants,
		siteCountThreshold: ctx.config.site_count_threshold ?? DEFAULT_SITE_COUNT_THRESHOLD,
		testRun: result.testRun,
		...runEvidenceFields(result),
		at: ctx.at,
		// v1 runs are always whole-file (line-range execution removed, review
		// passes 11-18), so the run is never a partial view. The evaluator's
		// partial-scope guards stay in place for any future scoped mode.
		partialScope: testSelectionIsPartial(testSelection),
		...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
	});
	// An unavailable verdict from the evaluator (typescript missing, partial run
	// with no finding, inconclusive statuses) obeys unavailable_behavior like
	// every other "could not measure" exit (review 2026-08-24, item 4).
	if (outcome.kind === "unavailable") {
		return gateDecision.unavailableDecision(ctx.config, outcome.reason);
	}
	// One exit for measured + adoption outcomes: adoption persists FIRST and
	// declares "adopted" only on success (review 2026-08-28 item 1); a measured
	// clean persists with its failure downgraded to a warning, as before.
	const decision = gateDecision.decideAndPersist(outcome, ctx.persist, ctx.config.mode);
	// A test-only edit leaves the source untouched, so the ordinary "no new
	// survivors" verdict is trivially satisfied and says nothing about whether
	// the test was worth adding. Answer that question directly.
	const effect = testEditEffect(changedPaths(changeSet), target, ctx.baseManifest, result.mutants);
	if (effect) decision.warnings = [...(decision.warnings ?? []), effect];
	return decision;
}
