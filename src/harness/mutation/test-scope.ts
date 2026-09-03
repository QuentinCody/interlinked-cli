// ===========================================
// Mutation test-scope selection — reverse import graph, not filename globs
// ===========================================
// The runner (scratch/two-box-runner/runner.mjs::testScopeFor) picks which test
// files Stryker loads by trying four fixed path-stem candidates
// (`<base>.test.ts`, `<base>.test.tsx`, `__tests__/<base>.test.ts`,
// `__tests__/<base>.test.tsx`). That misses any sibling test file exercising the
// same module under a different stem — measured live: `session-state.ts` has
// FOUR such siblings (`session-state-roundtrip.test.ts`,
// `session-state-provenance.test.ts`, `session-state-outcome.test.ts`,
// `event-ordinal.test.ts`) invisible to the naive glob. Stryker then runs an
// incomplete suite, so mutants only those siblings would kill report
// `NoCoverage` — not because the code is untested, but because the WRONG tests
// ran. `session-state.ts` alone showed 152 such false NoCoverage mutants.
//
// The fix already exists: `coverage-test-selector.ts::selectAffectedTests` BFS-
// walks the REVERSE import graph the per-edit COVERAGE gate already uses. This
// module is a thin, mutation-specific wrapper: it adds the one thing mutation
// scoping needs that coverage scoping doesn't — a SIZE CAP, because "the
// correct suite" and "a bigger suite" are different goals. A hub file's
// transitive dependents can run into dozens of tests (real example: this
// repo's own `session-state.ts` resolves to 61); loading all of them keeps
// correctness but can blow the per-edit mutation budget, so past a threshold
// this deliberately falls back to the (smaller, if incomplete) filename-glob
// scope and SAYS SO, rather than silently loading everything.
//
// Client-side by design (spec ask, not incidental): the reverse import graph is
// built and held by the harness/CLI, not by any one mutation runner backend —
// computing the scope here and forwarding it on the wire means ANY runner (this
// prototype, a future cloud Worker, a from-scratch third backend) gets the
// correct suite for free, and a repo with no graph available degrades to
// exactly the runner's own prior behavior. Baking selection into
// `runner.mjs` instead would only ever help the one personal prototype.

import { readdirSync } from "node:fs";
import { selectAffectedTests } from "../coverage-test-selector.js";
import type { DependencyView } from "../dependency-view.js";
import { InternalDependencyView } from "../dependency-view.js";
import { ProjectGraph } from "../project-graph.js";

/**
 * Ceiling on how many graph-selected tests one mutation run will load. Past
 * this, the correctness win of the graph walk is outweighed by the run
 * getting slow enough to blow the per-edit budget — fall back instead of
 * silently widening to "basically the whole suite".
 *
 * Calibrated against this repo's own worst case, not guessed: `session-state.ts`
 * (a genuine hub — imported by `server.ts`, which nearly every integration test
 * imports) resolves to 61 transitively-affected tests, measured live. That is
 * the correct suite for that file, not an inflated one — an earlier guess of
 * 40 would have capped it out and silently thrown away the exact fix this
 * module exists to ship. Set comfortably above the measured worst case
 * (this repo's largest hub) while staying far short of "the whole suite"
 * (~800 test files here).
 */
export const MAX_MUTATION_TEST_SCOPE = 150;

/**
 * Filename-convention half only of `isTestSourcePath` (checks/shared.ts) — no
 * directory-membership clause. `selectAffectedTests`'s BFS deliberately
 * widens "is this a test" to ANY file under a `__tests__/`/`tests/`/`test/`
 * directory (safe for its own consumers: coverage-gate scoping and manifest/
 * mutation-target exclusion, where over-inclusion only ever adds coverage or
 * removes a target). It is NOT safe here: this scope is handed directly to a
 * test runner's `--include` glob (`vitest.stryker.config.ts`'s
 * `INTERLINKED_MUTATION_TESTS`), and a non-test HELPER living in that same
 * directory — e.g. `src/harness/__tests__/sequence-fixtures.ts`, a fixture
 * factory with zero `it()`/`describe()` blocks — makes vitest fail the whole
 * dry run with "No test suite found in file …" (no `passWithNoTests`
 * configured). Stryker then reports that as "There were failed tests in the
 * initial test run", indistinguishable from a genuinely broken test.
 * Measured live 2026-08-01: `session-state.ts`'s 61-file graph scope
 * includes exactly this fixture via directory membership alone, and
 * forwarding the unfiltered scope reproduced the failure verbatim.
 */
function isRunnableTestEntry(relPath: string): boolean {
	const name = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
	if (/\.(?:test|spec)\.[^/]+$/.test(name)) return true;
	if (name.startsWith("test_") && (name.endsWith(".py") || name.endsWith(".swift"))) return true;
	if (/_test\.(?:py|go)$/.test(name)) return true;
	if (/Tests?\.(?:java|swift)$/.test(name)) return true;
	return false;
}

export interface MutationTestScopeResult {
	/**
	 * Repo-relative test paths to hand the runner, or `null` when the graph
	 * could not produce one (unknown file, no affected test, or the
	 * graph-selected set was over cap) — callers fall back to the runner's own
	 * filename-glob scoping in that case, never to "no scope" (which would
	 * silently run the WHOLE suite; see `vitest.stryker.config.ts`'s own
	 * empty-glob guard). Over-cap is the exception that STILL carries a scope:
	 * `tests` is null (the full set was declined) but {@link companionScope}
	 * holds the target's own companion kill tests, which callers ship instead
	 * of the lossy glob.
	 */
	tests: string[] | null;
	/** Why `tests` is null, when it is. Absent when `tests` is non-null. */
	reason?: "unknown_file" | "no_affected_tests" | "over_cap";
	/** Set only for `reason: "over_cap"` — the true count before capping, so a
	 *  caller can report "N tests found, using filename fallback instead"
	 *  rather than silently truncating to an arbitrary N. */
	uncappedCount?: number;
	/**
	 * On `reason: "over_cap"` ONLY: a REDUCED, non-empty scope of the target's
	 * OWN co-located companion/kill tests — its `<base>.test.ts`/`.spec`, any
	 * `<base>.<descriptor>.test.ts` (`.mutation-kill`, `.survivors`, …), and any
	 * co-located `*.survivor(s).*` — each of which statically depends on the SUT
	 * (they are drawn from the affected-test set). The full graph scope is
	 * declined because it is over cap, but these must STILL run: a plain
	 * filename-stem glob (the runner's own `testScopeFor`) matches only
	 * `<base>.test.ts` and silently drops `<base>.mutation-kill.test.ts`, so
	 * every mutant that only the kill test would catch reports as a FALSE
	 * survivor. Callers ship this as the runner `testScope` AND in the overlay
	 * closure. Absent when the target has no such companion in the affected set
	 * (nothing to ship — behavior is then exactly the prior glob fallback).
	 */
	companionScope?: string[];
	/**
	 * BFS dependents that matched `isTestSourcePath`'s directory-membership
	 * rule but are NOT a runnable spec by filename convention (a fixture/
	 * helper living under `__tests__/`) — dropped from `tests` because handing
	 * one to the runner's `--include` glob fails the whole dry run. Reported,
	 * never silently absorbed: a caller can log "N helper file(s) excluded"
	 * so a scope that shrank isn't mistaken for a graph miss. Present only
	 * when non-empty.
	 */
	excludedNonRunnable?: string[];
}

function resolveAbs(editedRelPath: string, projectRoot: string): string {
	// `hasFile` operates on absolute paths (see dependency-view.ts and its
	// callers) — resolve once here so this function's own callers only ever
	// hand it repo-relative paths, matching `selectAffectedTests`'s own input.
	return projectRoot.endsWith("/") ? `${projectRoot}${editedRelPath}` : `${projectRoot}/${editedRelPath}`;
}

/**
 * The target's OWN companion kill tests among `candidates` (repo-relative POSIX
 * paths already known to statically depend on the SUT — i.e. entries of the
 * affected-test set). A companion is a runnable test file CO-LOCATED with the
 * SUT (its directory, or that directory's `__tests__/`) whose stem is:
 *   - exactly `<base>` — the conventional `<base>.test.ts`/`.spec` companion; or
 *   - `<base>.<descriptor>` — a sibling kill/variant test such as
 *     `<base>.mutation-kill.test.ts` or `<base>.survivors.test.ts`; or
 *   - any co-located `*.survivor(s).*` — the spec's explicit survivor glob.
 *
 * This is the set an over-cap decline must still ship: the runner's own
 * filename-stem fallback (`testScopeFor`) only ever tries the four `<base>.test`
 * candidates, so a `<base>.mutation-kill.test.ts` — and every mutant it alone
 * kills — vanishes when the graph scope is declined to nothing. Order-preserving
 * over `candidates`, which the caller already sorted + deduped.
 */
/** The unknown-file decline, carrying the target's ON-DISK co-located
 *  companions. A stale/incomplete graph made checks/shared.ts and the
 *  brace-scan module "unknown" (wave-20 falsification, 2026-08-18): the bare
 *  decline dropped their `.mutation-kill` companions, the runner's four-stem
 *  glob never found them, and 37 verified kills measured as zero effect. The
 *  same reduced-companion principle as the over-cap decline applies — the
 *  graph can't answer, but the co-location convention still can. */
/** The test-file names directly inside `dir` (repo-relative, POSIX), or `[]`
 *  when `dir` doesn't exist — the loop body `unknownFileDecline` runs once
 *  per candidate directory (the SUT's own dir and its `__tests__/`). */
function testFilesInDir(dir: string, projectRoot: string): string[] {
	let names: string[] = [];
	try {
		names = readdirSync(resolveAbs(dir || ".", projectRoot));
	} catch (err) {
		void err; // absent dir — no candidates from it
		return [];
	}
	return names
		.filter((name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name))
		.map((name) => (dir ? `${dir}/${name}` : name));
}

function unknownFileDecline(editedRelPath: string, projectRoot: string): MutationTestScopeResult {
	const sut = editedRelPath.replace(/\\/g, "/");
	const slash = sut.lastIndexOf("/");
	const sutDir = slash >= 0 ? sut.slice(0, slash) : "";
	const candidates: string[] = [];
	for (const dir of [sutDir, sutDir ? `${sutDir}/__tests__` : "__tests__"]) {
		candidates.push(...testFilesInDir(dir, projectRoot));
	}
	const companionScope = companionKillTests(sut, candidates);
	return {
		tests: null,
		reason: "unknown_file",
		...(companionScope.length > 0 ? { companionScope } : {}),
	};
}

function companionKillTests(sutRel: string, candidates: readonly string[]): string[] {
	const sut = sutRel.replace(/\\/g, "/");
	const slash = sut.lastIndexOf("/");
	const sutDir = slash >= 0 ? sut.slice(0, slash) : "";
	const sutBase = (slash >= 0 ? sut.slice(slash + 1) : sut).replace(/\.[cm]?[jt]sx?$/i, "");
	return candidates.filter((raw) => {
		const t = raw.replace(/\\/g, "/");
		const ts = t.lastIndexOf("/");
		// Strip a trailing `/__tests__` so an umbrella test resolves to the
		// SUT's own directory — the same co-location rule coverage-pairing uses.
		const dir = (ts >= 0 ? t.slice(0, ts) : "").replace(/\/__tests__$/, "");
		if (dir !== sutDir) return false;
		const name = ts >= 0 ? t.slice(ts + 1) : t;
		const stem = name.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/i, "");
		if (stem === sutBase) return true; // <base>.test.ts / <base>.spec.ts
		if (stem.startsWith(`${sutBase}.`)) return true; // <base>.mutation-kill / <base>.survivors / …
		return /(?:^|[.\-])survivors?(?:[.\-]|$)/i.test(stem); // *.survivor(s).*
	});
}

/**
 * Select the tests for a mutation run of `editedRelPath` via the reverse
 * import graph, capped and with the reason recorded when it declines.
 *
 * Deliberately does NOT itself fall back to filename globs — that fallback is
 * the RUNNER's existing `testScopeFor`, and this function returning `tests:
 * null` is precisely the signal "let the runner do that". Duplicating the
 * glob logic here would just be a second copy to keep in sync.
 */
export function computeMutationTestScope(args: {
	editedRelPath: string;
	projectRoot: string;
	depView: DependencyView;
	/** Per-repo ceiling override (`per_edit_mutation.max_test_scope`);
	 *  absent ⇒ {@link MAX_MUTATION_TEST_SCOPE}. */
	maxScope?: number;
}): MutationTestScopeResult {
	const { editedRelPath, projectRoot, depView } = args;
	const scopeCap = args.maxScope ?? MAX_MUTATION_TEST_SCOPE;
	if (depView.answerScope !== "repo" || !depView.hasFile(resolveAbs(editedRelPath, projectRoot))) {
		return unknownFileDecline(editedRelPath, projectRoot);
	}
	const selected = selectAffectedTests({ editedRelPath, projectRoot, depView });
	if (selected === null) return unknownFileDecline(editedRelPath, projectRoot);
	const runnable = selected.filter(isRunnableTestEntry);
	const excludedNonRunnable = selected.filter((t) => !isRunnableTestEntry(t));
	const extra = excludedNonRunnable.length > 0 ? { excludedNonRunnable } : {};
	if (runnable.length === 0) return { tests: null, reason: "no_affected_tests", ...extra };
	if (runnable.length > scopeCap) {
		// Declining the full (over-cap) set to `tests: null` would drop the
		// target's own companion kill tests too, and the runner's four-stem
		// filename fallback never finds `<base>.mutation-kill.test.ts` — so ship
		// the reduced companion scope alongside the decline. Non-empty only.
		const companionScope = companionKillTests(editedRelPath, runnable);
		return {
			tests: null,
			reason: "over_cap",
			uncappedCount: runnable.length,
			...(companionScope.length > 0 ? { companionScope } : {}),
			...extra,
		};
	}
	return { tests: runnable, ...extra };
}

/**
 * CLI-facing convenience: build a FRESH `ProjectGraph` for `projectRoot` and
 * run {@link computeMutationTestScope} against it in one call.
 *
 * Only for one-shot callers (the `mutation measure` command) that have no
 * long-lived daemon graph to reuse — the daemon's own per-edit mutation gate
 * should pass its ALREADY-BUILT graph through `computeMutationTestScope`
 * directly instead of paying this function's full-repo (re-)scan per edit.
 * Cost is a full regex-based project parse (no `tsc`), typically low
 * single-digit seconds even on a repo with hundreds of files — negligible
 * next to the mutation run itself.
 */
export function computeMutationTestScopeForRepo(args: {
	editedRelPath: string;
	projectRoot: string;
	/** Per-repo ceiling override (`per_edit_mutation.max_test_scope`). */
	maxScope?: number;
}): MutationTestScopeResult {
	const graph = new ProjectGraph(args.projectRoot);
	graph.initialize();
	const depView = new InternalDependencyView(graph);
	return computeMutationTestScope({
		editedRelPath: args.editedRelPath,
		projectRoot: args.projectRoot,
		depView,
		...(args.maxScope !== undefined ? { maxScope: args.maxScope } : {}),
	});
}
