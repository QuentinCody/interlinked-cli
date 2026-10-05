// `fcAssert` — the one fast-check entry point for this repo's property tests.
// It is `fc.assert` plus the three ideas the Hegel trial said to port
// (.interlinked/agent-output/hegel-bombadil/hegel-trial.md §7):
//
// 1. Replay-first failures: a failure records `{seed, path}` under the VITEST
//    test id in `.interlinked/fast-check-examples.json`; the next run replays
//    that seed+path before the random search, so a known failure costs one body
//    call instead of N. Keyed by test id, never by source text.
// 2. CI seed pin: under `CI` with no explicit seed, the seed is a stable hash of
//    the test id, so CI runs reproduce and the failure message names the seed.
//    Local runs stay random (fast-check's clock seed).
// 3. Heavy-rejection warning: after the run, `numSkips / (numRuns + numSkips)`
//    above the ratio emits ONE `[interlinked:fast-check] heavy rejection` line
//    to stderr per test id. Read from fast-check's own RunDetails, no patching.
//
// 4. Replay clearing: a replay that passes removes the stored entry and emits one
//    `[interlinked:fast-check] cleared stored failure for <id> (replay passed)`
//    line (Hypothesis's example-database rule). A failing replay keeps and
//    refreshes the entry; disabled writes leave the store untouched.
//
// 5. Unshrunk replay (BugBash S1E11; antithesis intake backlog #38): a stored
//    path is `<run index>:<shrink steps…>`, so its first segment replays the
//    failure BEFORE shrinking. The replay phase runs both. A shrunk path that
//    passes while the unshrunk one fails is still a failure; two failures at
//    different origins (error name + first non-dependency frame) emit one
//    `shrink slippage` line, because shrinking can move to a different bug. A
//    cleared entry also prints a ready `examples:` literal to pin the case.
//
// The per-edit property budget (`INTERLINKED_PROPERTY_NUMRUNS`, set by the
// coverage runner for a scoped run) caps the random phase here even when the
// caller passes an explicit `numRuns` — plain `fc.assert` lets an explicit
// value override the global cap. The replay phase adds at most a handful of
// body calls (measured 1 on a failing, 8 on a passing replay; +1 for the
// unshrunk path when the stored path has shrink steps).
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { expect } from "vitest";
import { parsePropertyBudget } from "./property-budget.js";
import { canReplay, replayBinding, type ReplayBinding } from "./replay-compatibility.js";
import {
	examplesStorePath,
	exampleWritesDisabled,
	FAST_CHECK_EXAMPLES_FILE,
	projectRoot,
	pruneStoreOnDisk,
	readExampleStore,
	recordExample,
	removeExample,
	stableSeed,
	testFileOf,
	testIdFor,
	truncateCounterexample,
    type StoredExample,
} from "./fast-check-examples.js";

export const DEFAULT_HEAVY_REJECTION_RATIO = 0.5;
/** fast-check's own default when neither the call nor the global config sets numRuns. */
const FC_DEFAULT_NUM_RUNS = 100;
const PERCENT = 100;
const WARN_PREFIX = "[interlinked:fast-check]";
const OWN_MODULE = fileURLToPath(import.meta.url);

export type SeedSource = "explicit" | "ci-test-id" | "random";

export interface FcAssertOptions {
    /** Version for generator/helper/environment inputs outside the test source. */
    replayCompatibility?: string;
	/** Skip ratio above which the heavy-rejection warning fires (0 < r <= 1). Env: `INTERLINKED_FC_REJECTION_WARN`. */
	heavyRejectionRatio?: number;
	/** Override the example store file (tests). Default: `<project>/.interlinked/fast-check-examples.json`. */
	storePath?: string;
	/** Override the test id; `null` disables the store. Default: derived from `expect.getState()`. */
	testId?: string | null;
	env?: NodeJS.ProcessEnv;
	/** Warning sink. Default: one line to stderr. */
	warn?: (line: string) => void;
}

export type FcAssertParams<Ts> = fc.Parameters<Ts> & FcAssertOptions;

export interface RunPlan<Ts> {
    compatibility: ReplayBinding;
    storedExample: StoredExample | null;
	testId: string | null;
	seedSource: SeedSource;
	/** Stored failure to replay first, or null when none is recorded. */
	replay: fc.Parameters<Ts> | null;
	/** The stored failure before shrinking (first path segment), or null when the path has no shrink steps. */
	replayOriginal: fc.Parameters<Ts> | null;
	random: fc.Parameters<Ts>;
	storePath: string;
	heavyRejectionRatio: number;
	writesDisabled: boolean;
	warn: (line: string) => void;
}

const warnedTestIds = new Set<string>();
const prunedFiles = new Set<string>();

function defaultWarn(line: string): void {
	process.stderr.write(`${line}\n`);
}

function vitestTestId(root: string): string | null {
	const state = expect.getState();
	return testIdFor(state.testPath, state.currentTestName, root);
}

function rejectionRatio(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
	const candidate = explicit ?? Number(env.INTERLINKED_FC_REJECTION_WARN);
	return Number.isFinite(candidate) && candidate > 0 && candidate <= 1 ? candidate : DEFAULT_HEAVY_REJECTION_RATIO;
}

function cappedNumRuns(requested: number | undefined, env: NodeJS.ProcessEnv): number {
	const base = requested ?? fc.readConfigureGlobal().numRuns ?? FC_DEFAULT_NUM_RUNS;
	const budget = parsePropertyBudget(env.INTERLINKED_PROPERTY_NUMRUNS);
	return budget === null ? base : Math.min(base, budget);
}

/** Pure-ish planning step (reads the store file): exported so the seed / budget / replay rules are unit-testable. */
export function resolveRunPlan<Ts>(params: FcAssertParams<Ts>): RunPlan<Ts> {
	const { heavyRejectionRatio, storePath, testId, env: envOverride, warn, replayCompatibility, ...fcParams } = params;
	const env = envOverride ?? process.env;
	const root = projectRoot(env);
	const file = storePath ?? examplesStorePath(root);
	const id = testId === undefined ? vitestTestId(root) : testId;
    const warning = warn ?? defaultWarn;
    pruneRunStore({ file, root, id, explicitId: testId !== undefined, env, warn: warning });

    const { seed, seedSource } = chooseSeed(fcParams.seed, id, env);
	const numRuns = cappedNumRuns(fcParams.numRuns, env);
	const random: fc.Parameters<Ts> = { ...fcParams, numRuns, ...(seed === undefined ? {} : { seed }) };

	const stored = id === null ? undefined : readExampleStore(file).entries[id];
    const compatibility = replayBinding(root, id, replayCompatibility);
	const { examples: _examples, ...replayBase } = fcParams;
	void _examples;
    const replay = compatibleReplay({ stored, compatibility, replayBase, warning });

	return {
        compatibility, storedExample: stored ?? null,
		testId: id,
		seedSource,
		replay,
		replayOriginal: unshrunkReplay(replay),
		random,
		storePath: file,
		heavyRejectionRatio: rejectionRatio(heavyRejectionRatio, env),
		writesDisabled: exampleWritesDisabled(env),
		warn: warning,
	};
}

function chooseSeed(explicit: number | undefined, id: string | null, env: NodeJS.ProcessEnv): { seed: number | undefined; seedSource: SeedSource } {
    if (explicit !== undefined) return { seed: explicit, seedSource: "explicit" };
    if (env.CI && env.INTERLINKED_FC_EXPLORE !== "1" && id !== null) return { seed: stableSeed(id), seedSource: "ci-test-id" };
    return { seed: undefined, seedSource: "random" };
}
function pruneRunStore(args: { file: string; root: string; id: string | null; explicitId: boolean; env: NodeJS.ProcessEnv; warn: (line: string) => void }): void {
    if (exampleWritesDisabled(args.env) || args.explicitId || args.id === null) return;
    try { pruneOnce(args.file, args.root, testFileOf(args.id)); }
    catch (error) { args.warn(`${WARN_PREFIX} replay pruning unavailable: ${String(error)}`); }
}
function compatibleReplay<Ts>(args: { stored: StoredExample | undefined; compatibility: ReplayBinding; replayBase: fc.Parameters<Ts>; warning: (line: string) => void }): fc.Parameters<Ts> | null {
    if (!args.stored) return null;
    if (!canReplay(args.stored.compatibility, args.compatibility)) {
        args.warning(`${WARN_PREFIX} stored failure retained but not replayed: incompatible or unknown engine/test/generator binding`);
        return null;
    }
    return { ...args.replayBase, seed: args.stored.seed, path: args.stored.path, numRuns: 1, endOnFailure: true };
}
/** fast-check's path is `<run index>:<shrink step>…`; its first segment replays the failure before shrinking. */
export function unshrunkPathOf(path: string): string {
    const at = path.indexOf(":");
    return at < 0 ? path : path.slice(0, at);
}
function unshrunkReplay<Ts>(replay: fc.Parameters<Ts> | null): fc.Parameters<Ts> | null {
    if (replay?.path === undefined) return null;
    const original = unshrunkPathOf(replay.path);
    return original === replay.path ? null : { ...replay, path: original };
}
function pruneOnce(file: string, root: string, testFile: string): void {
	const key = `${file}\n${testFile}`;
	if (prunedFiles.has(key)) return;
	prunedFiles.add(key);
	pruneStoreOnDisk(file, root, testFile);
}

function warnHeavyRejection<Ts>(plan: RunPlan<Ts>, details: fc.RunDetails<Ts>): void {
	const total = details.numRuns + details.numSkips;
	if (total === 0 || details.numSkips / total <= plan.heavyRejectionRatio) return;
	const key = plan.testId ?? "<no test id>";
	if (warnedTestIds.has(key)) return;
	warnedTestIds.add(key);
	const pct = Math.round((details.numSkips / total) * PERCENT);
	const limit = Math.round(plan.heavyRejectionRatio * PERCENT);
	plan.warn(
		`${WARN_PREFIX} heavy rejection: ${key} skipped ${details.numSkips}/${total} draws (${pct}%), above ${limit}% — ` +
			"generate the shape directly instead of fc.pre / .filter",
	);
}

function recordFailure<Ts>(plan: RunPlan<Ts>, details: fc.RunDetails<Ts>): void {
	if (plan.testId === null || plan.writesDisabled || details.counterexamplePath === null) return;
	recordExample(plan.storePath, plan.testId, {
        compatibility: plan.compatibility,
		seed: details.seed,
		path: details.counterexamplePath,
		counterexample: truncateCounterexample(fc.stringify(details.counterexample)),
		ts: new Date().toISOString(),
	});
}

/** Passing replay only establishes that the prior failure was not reproduced. */
function clearFixedFailure<Ts>(plan: RunPlan<Ts>): void {
	if (plan.testId === null || plan.writesDisabled) return;
	if (!plan.storedExample || !removeExample(plan.storePath, plan.testId, plan.storedExample)) return;
	plan.warn(`${WARN_PREFIX} cleared stored failure for ${plan.testId} (replay passed; not reproduced, not proof of a fix)`);
	const shown = plan.storedExample.counterexample;
	if (!shown.endsWith("…")) plan.warn(`${WARN_PREFIX} to keep it as a regression case, add to the fcAssert params: examples: [${shown}]`);
}

function isOwnCodeFrame(line: string): boolean {
	const external = line.includes("node_modules") || line.includes("node:") || line.includes(OWN_MODULE);
	return line.startsWith("at ") && !external;
}

/** Where a failure came from: error name plus the first stack frame outside dependencies, Node internals and this
 *  wrapper (Hypothesis's origin rule). A property that returns false fails inside fast-check, so its first own frame
 *  is the caller's `fcAssert` line, the same for both replays. */
export function failureOrigin(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const frames = (error.stack ?? "").split("\n").slice(1).map((line) => line.trim());
	const frame = frames.find(isOwnCodeFrame);
	const location = frame?.match(/\(?([^\s()]+:\d+):\d+\)?$/)?.[1];
	return `${error.name} at ${location ?? error.message}`;
}

/** Judges the two replays: the unshrunk failure still counts when the shrunk path stops failing. */
function settleReplay<Ts>(plan: RunPlan<Ts>, shrunk: fc.RunDetails<Ts>, original: fc.RunDetails<Ts> | null): void {
	if (original?.failed) {
		const id = plan.testId ?? "<no test id>";
		if (!shrunk.failed) {
			plan.warn(`${WARN_PREFIX} ${id}: the shrunk path no longer fails, but the unshrunk failure (path "${plan.replayOriginal?.path}") still does`);
			return settle(plan, original, "replay");
		}
		const [before, after] = [failureOrigin(original.errorInstance), failureOrigin(shrunk.errorInstance)];
		if (before !== after) {
			plan.warn(`${WARN_PREFIX} shrink slippage for ${id}: unshrunk failure ${before}, shrunk failure ${after} — they may be different bugs`);
		}
	}
	settle(plan, shrunk, "replay");
}

function failureError<Ts>(plan: RunPlan<Ts>, details: fc.RunDetails<Ts>, phase: "replay" | "random"): Error {
	const seedNote = plan.seedSource === "ci-test-id" ? "seed pinned from the test id (CI)" : `seed ${plan.seedSource}`;
	const replayNote = phase === "replay" ? ` — replayed from ${FAST_CHECK_EXAMPLES_FILE}` : "";
	const header = `${WARN_PREFIX} ${plan.testId ?? "<no test id>"} — ${seedNote}${replayNote}`;
	const report = fc.defaultReportMessage(details) ?? "Property failed (no report)";
	return new Error(`${header}\n${report}`, { cause: details.errorInstance });
}

function settle<Ts>(plan: RunPlan<Ts>, details: fc.RunDetails<Ts>, phase: "replay" | "random"): void {
	if (phase === "random") warnHeavyRejection(plan, details);
	if (!details.failed) {
		if (phase === "replay") {
            try { clearFixedFailure(plan); }
            catch (error) { plan.warn(`${WARN_PREFIX} passing replay history unavailable: ${String(error)}`); }
        }
		return;
	}
    try { recordFailure(plan, details); }
    catch (error) { plan.warn(`${WARN_PREFIX} failure persistence unavailable: ${String(error)}`); }
	throw failureError(plan, details, phase);
}

/** `fc.assert` for a synchronous property, with replay-first, CI seed pin, budget cap and the rejection warning. */
export function fcAssert<Ts>(property: fc.IProperty<Ts>, params: FcAssertParams<Ts> = {}): void {
	const plan = resolveRunPlan(params);
	if (plan.replay) {
		const shrunk = fc.check(property, plan.replay);
		settleReplay(plan, shrunk, plan.replayOriginal ? fc.check(property, plan.replayOriginal) : null);
	}
	settle(plan, fc.check(property, plan.random), "random");
}

/** The async twin of `fcAssert`. */
export async function fcAssertAsync<Ts>(property: fc.IAsyncProperty<Ts>, params: FcAssertParams<Ts> = {}): Promise<void> {
	const plan = resolveRunPlan(params);
	if (plan.replay) {
		const shrunk = await fc.check(property, plan.replay);
		settleReplay(plan, shrunk, plan.replayOriginal ? await fc.check(property, plan.replayOriginal) : null);
	}
	settle(plan, await fc.check(property, plan.random), "random");
}
