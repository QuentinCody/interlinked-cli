// ===========================================
// Kill proof — baseline run, isolated mutant run, verdict, receipt
// ===========================================
// 1. The named test files run UNMUTATED in a fresh git-visible copy of the project
//    (`fail-before-fix/snapshot.ts`); every case must pass. A baseline that fails in
//    the copy is re-run on the live tree (read only): passing live means the copy
//    lacks something the test needs (an ignored fixture) → `unavailable`, not the
//    test's fault; failing live is `not-passing-now` (review K6).
// 2. The mutant runs in a SECOND fresh copy holding the mutated file, so nothing
//    the baseline left behind (a marker, a snapshot, a log) can fail the second
//    run (review K1). A replacement that does not parse is `inconclusive` — a
//    compile error, as mutation tools classify it, never a kill (review K5).
// 3. Only cases from the NAMED files count (vitest positional filters are
//    substrings, review R1). A case is `killed` when it fails by its own check
//    (`fail-before-fix/classify.ts failedByOwnCheck` — the ONE rule, property-test
//    reports judged by the error they wrap) and the judged failure is not a
//    `node:assert` raised from product code (review R4); `survived` when it still
//    passes; else `inconclusive` with its first failure line. A runner that times
//    out or fails to launch makes every case inconclusive — never a kill.
// Every vitest run is private (round 4, M2): `--no-cache` (vitest's results cache would land in the LIVE
// node_modules through the copy's link and reorder files between runs) and a fresh TMPDIR per run
// (`fail-before-fix/index.ts runVitestDetailed`), so no run can see the previous run's tmpdir state.
// The live tree is only read. Every copy is removed before the next stage starts.
// The flow is split in two so `batch.ts` can prove every survivor of a file against ONE baseline:
// `openProofContext` validates the tests and the project once and memoizes the shared copies (baseline,
// canary, control); `proveResolved` runs the per-mutant part. `proveKill` is the two in sequence.


import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeFailure, failedByOwnCheck, judgedFailure, type VitestCase } from "../fail-before-fix/classify.js";
import { runVitestDetailed, STDERR_HEAD_BYTES, type VitestRun } from "../fail-before-fix/index.js";
import { applyOverrides, createProjectCopyAsync, gitVisibleFiles } from "../fail-before-fix/snapshot.js";
import { applyMutant } from "../mutation/differential-fuzz-locate.js";
import { boundImportClosure, testsReachingByRelativeImport } from "./bound-imports.js";
import { explicitVitestConfig, hoistLayout, missingVitest, mutantParses, targetProblem } from "./proof-preconditions.js";

import { captureEnvironment, hashFile, receiptId, resolveVitestConfig, sealReceipt, writeKillProof } from "./receipt.js";
import { lineTextAt, resolveMutant } from "./resolve.js";
import type { CaseOutcome, HashedFile, KillProofReceipt, MutantSpec, ProofEnvironment, ProveKillResult, ResolvedMutant } from "./types.js";

export interface ProveKillOptions {
	root: string;
	spec: MutantSpec;
	tests: readonly string[];
	/** Budget for EACH vitest run (baseline, then under the mutant). */
	budgetMs: number;
	/** vitest config to pass as `--config` (repo-relative); default: the one `scripts.test` declares, else vitest's discovery. */
	vitestConfig?: string;
	now?: () => Date;
	/** Test hook: replaces the vitest runner. */
	runner?: (dir: string, files: readonly string[], budgetMs: number, vitestArgs: readonly string[]) => Promise<VitestRun>;
	/** When false the receipt is returned but not written. Default true. */
	persist?: boolean;
}

/** Written into the mutated file's place for the reachability canary (review N6/N7): a test that still passes never loaded the copy's file. */
// (The message must not read like an `interlinked <command>` line: cli-program.test.ts scans source strings for printed commands.)
const CANARY_SOURCE = 'throw new Error("kill-proof canary (prove-kill): the tests must load this file from the copy");\nexport {};\n';
/** Stands in for every named test in the canary CONTROL run (round-4 M3): it imports nothing of the project. */
const CONTROL_TEST = 'import { it } from "vitest";\nit("kill-proof control (prove-kill): the environment alone must not fail this case", () => {});\n';
const CANARY_INCOMPLETE = "canary run did not complete; cannot show the tests load the copy";


/** Cases vitest reports but does not run: not evidence either way (review R14). */
const NOT_RUN = new Set(["skipped", "todo", "pending", "disabled"]);
/** `node:assert` failures carry this code; raised from product code they are not the test's check (review R4). */
const NODE_ASSERT_PREFIX = "AssertionError [ERR_ASSERTION]";

const caseKey = (row: Pick<VitestCase, "file" | "name">): string => `${row.file} › ${row.name}`;

/** Above this many git-visible bytes a proof warns (round-4 M10): each run copies the tree again, three to five times per proof. */
export const COPY_BUDGET_BYTES = 256 * 1024 * 1024;
export function copySizeWarning(bytes: number): string | null {
	if (bytes <= COPY_BUDGET_BYTES) return null;
	return `[interlinked:kill-proof] copy is ${Math.round(bytes / 1024 / 1024)} MiB; large tracked files slow every proof`;
}

/** Attach run-level warnings to a result without changing its verdict. */
function withWarnings<T extends ProveKillResult>(result: T, warnings: readonly string[]): T {
	return warnings.length ? { ...result, warnings: [...warnings] } : result;
}

/**
 * Each row with its identity key: file, full name AND the ordinal among rows sharing that
 * full name, in report order (review M3: two cases may carry one full name — a duplicate
 * `it("caps at max")`, an `it.each` title without a placeholder — and vitest reports both
 * in definition order on every run, so the n-th same-named row of one run is the n-th of
 * the other; keying by name alone let the last row's outcome overwrite the others).
 */
function withOrdinals<T extends Pick<VitestCase, "file" | "name">>(rows: readonly T[]): Array<{ key: string; row: T }> {
	const seen = new Map<string, number>();
	return rows.map(row => {
		const base = caseKey(row), ordinal = seen.get(base) ?? 0;
		seen.set(base, ordinal + 1);
		return { key: `${base}#${ordinal}`, row };
	});
}

const keyedRows = (rows: readonly VitestCase[]): Map<string, VitestCase> => new Map(withOrdinals(rows).map(entry => [entry.key, entry.row]));

function unavailable(reasons: string[], mutant?: ResolvedMutant): ProveKillResult {
	return { ok: false, verdict: "unavailable", reasons, ...(mutant ? { mutant } : {}) };
}

/** Repo-relative POSIX paths; null when a path escapes the root. */
export function normalizeTestPaths(root: string, tests: readonly string[]): string[] | null {
	const out: string[] = [];
	for (const test of tests) {
		const rel = relative(root, isAbsolute(test) ? test : resolve(root, test)).replace(/\\/g, "/");
		if (!rel || rel.startsWith("..")) return null;
		if (!out.includes(rel)) out.push(rel);
	}
	return out;
}

/** A named test must be a regular file whose real location is inside the root (review K8b, K9). */
function testFileProblem(root: string, test: string): string | null {
	const abs = join(root, test);
	if (!existsSync(abs)) return `${test} does not exist`;
	if (lstatSync(abs).isDirectory()) return `${test} is a directory; pass each test file with its own --test`;
	const real = realpathSync(abs);
	if (real !== root && !real.startsWith(root + sep)) return `${test} resolves outside the project (${real}). It would test the live source, not the copy`;
	return null;
}

/** vitest reports a snapshot mismatch as `Error: Snapshot … mismatched` (vitest 2) — the test's own check, not a crash
 *  (foreign round 2: esrap on vitest 2.1.1 reported 4 real kills as inconclusive). */
const SNAPSHOT_MISMATCH = /^(?:Error: )?Snapshot .*mismatched/;

/** The test's own check fired (`failedByOwnCheck`, plus a snapshot mismatch); a product `node:assert` is not — read on the
 *  failure the rule judged, so a property run that wraps one is excluded the same way. */
export function killedByOwnCheck(row: VitestCase): boolean {
	if (row.status === "failed" && SNAPSHOT_MISMATCH.test(row.message ?? "")) return true;
	if (!failedByOwnCheck(row)) return false;
	const judged = judgedFailure(row);
	return !(judged.message.startsWith(NODE_ASSERT_PREFIX) && !judged.thrownInTest);
}

type BaselineProblem = { kind: "unavailable" | "not-passing-now"; reasons: string[]; failing: VitestCase[] };

/** Baseline problems: a runner failure, a named file with no run case, or a case that does not pass. */
function baselineProblems(tests: readonly string[], run: VitestRun): BaselineProblem | null {
	if (run.error !== undefined || run.timedOut) {
		const failure = run.timedOut ? `baseline run timed out after ${run.durationMs} ms; raise --run-timeout (default 300000)` : `baseline run failed: ${run.error}`;
		return { kind: "unavailable", reasons: [failure, ...stderrReason(run)], failing: [] };
	}
	const named = run.cases.filter(row => tests.includes(row.file) && !NOT_RUN.has(row.status));
	const silent = tests.filter(file => !named.some(row => row.file === file));
	if (silent.length) {
		const hint = "Check that the vitest config includes it (or pass --vitest-config <file>) and that it loads without ignored files.";
		return { kind: "unavailable", reasons: [...silent.map(file => `${file} ran no test case in the isolated copy${suiteFailureOf(run, file)}`), hint], failing: [] };
	}
	const failing = named.filter(row => row.status !== "passed");
	if (failing.length) {
		return { kind: "not-passing-now", reasons: failing.map(row => `${caseKey(row)}: ${row.status}${row.message ? ` — ${row.message}` : ""}`), failing };
	}
	return null;
}

/** vitest's own startup output when a run produced no report (round-4 layouts M6: "failed to load config …" was discarded). */
function stderrReason(run: VitestRun): string[] {
	return run.stderrHead !== undefined ? [`vitest stderr (first ${STDERR_HEAD_BYTES} bytes):\n${run.stderrHead}`] : [];
}

/** The file-level load error vitest reported for a file that ran no case (M6), as a suffix; empty when none. */
function suiteFailureOf(run: VitestRun, file: string): string {
	const message = run.suiteFailures?.[file];
	return message !== undefined ? ` — the file failed to load: ${message}` : "";
}

/** One outcome per baseline-passing row, in baseline order; a duplicated full name yields one row per case. */
function judgeCases(passing: readonly VitestCase[], under: VitestRun): CaseOutcome[] {
	const seen = keyedRows(under.cases);
	const runnerFailure = under.timedOut ? `runner timed out after ${under.durationMs} ms` : under.error === undefined ? undefined : [under.error, ...stderrReason(under)].join("\n");
	return withOrdinals(passing).map(({ key, row }) => {
		const test = caseKey(row);
		if (runnerFailure !== undefined) return { test, verdict: "inconclusive", reason: runnerFailure };
		const result = seen.get(key);
		if (result?.status === "passed") return { test, verdict: "survived" };
		if (result !== undefined && killedByOwnCheck(result)) return { test, verdict: "killed" };
		const suite = suiteFailureOf(under, row.file);
		const missing = suite !== "" ? `no result under the mutant${suite}` : "no result under the mutant";
		return { test, verdict: "inconclusive", reason: result?.message !== undefined ? describeFailure(result) : (result ? result.status : missing) };
	});
}

type RunIn = (overrides: ReadonlyMap<string, string>, another?: boolean) => Promise<VitestRun>;

/** How many unmutated copies must pass again after a kill (round-4 M1). */
export const KILL_REPEATS = 2;

/**
 * A kill must be REPEATABLE (review L1; round-4 M1). State a run leaves outside its copy — $HOME, /var, a path
 * beside the project — can fail the next run of a test whatever the mutant did. Two unmutated copies run AFTER the
 * kill, so the sequence a kill needs is pass, FAIL, pass, pass: state that flips on every run (period 2: a counter
 * that forbids its second reading, a marker the next run deletes) fails the second repeat and the case is "not
 * repeatable", never a kill. One repeat accepted exactly that pattern (round-4 N1/N2). Residual, stated in the
 * guide's Limits: state with period 3 or longer, and probabilistic flakiness — repeats lower the odds, they do not
 * end them. The copies' own tmpdir and vitest cache are private per run (M2), so this covers what is left.
 */
async function confirmKills(cases: readonly CaseOutcome[], passing: readonly VitestCase[], runIn: RunIn): Promise<CaseOutcome[]> {
	let out = [...cases];
	// `cases` is in `passing` order, so the same-name ordinals (review M3) re-derive from the same rows.
	const keys = withOrdinals(passing).map(entry => entry.key);
	for (let repeat = 1; repeat <= KILL_REPEATS && out.some(row => row.verdict === "killed"); repeat++) {
		const again = await runIn(new Map(), repeat < KILL_REPEATS);
		const repeats = keyedRows(again.cases);
		out = out.map((row, index) => {
			if (row.verdict !== "killed") return row;
			const result = repeats.get(keys[index] ?? "");
			if (again.error === undefined && !again.timedOut && result?.status === "passed") return row;
			const why = result?.message ?? again.error ?? result?.status ?? "no result";
			return { test: row.test, verdict: "inconclusive", reason: `not repeatable: it also fails on a fresh unmutated copy (repeat ${repeat} of ${KILL_REPEATS}: ${why}). A run left state outside the copy` };
		});
	}
	return out;
}


/**
 * Reachability (reviews N6/N7; round-4 M3/M4). A survivor means something only if the named tests loaded the
 * COPY's file. A canary copy holds a module-level throw in the file's place; the survivor stands only when:
 *  1. the canary run completed — a timeout or launch failure is no evidence (M4), never "survived";
 *  2. PER FILE, every baseline-passing case stopped passing (M3): a case still passing never reached the file,
 *     or caught its import error (M11);
 *  3. the break is the TESTS' doing: a test whose static relative imports reach the file is evidence by itself
 *     (a relative import resolves inside the copy); for any other named test a CONTROL copy — canary plus every
 *     named test replaced by one trivial case — must pass. If the control breaks too, a setup file or the config
 *     loads the file (the setup-file hole, M3): nothing shows the tests themselves did.
 * Returns the `unavailable` reasons, or null when the survivor is attributable to the copy's file.
 */
async function canaryProblem(root: string, mutant: ResolvedMutant, tests: readonly string[], passing: readonly VitestCase[], runIn: RunIn): Promise<string[] | null> {
	const reaching = testsReachingByRelativeImport(root, tests, mutant.file);
	const canary = await runIn(new Map([[mutant.file, CANARY_SOURCE]]), !tests.every(test => reaching.has(test)));
	if (canary.error !== undefined || canary.timedOut) return [`${CANARY_INCOMPLETE} (${canary.timedOut ? `timed out after ${canary.durationMs} ms` : canary.error})`];
	const canaryRows = keyedRows(canary.cases);
	const stillPassing = withOrdinals(passing).filter(({ key }) => canaryRows.get(key)?.status === "passed").map(entry => entry.row);
	if (stillPassing.length) {
		return [
			`the named tests never load ${mutant.file} from the copy, or catch its import error: a module-level throw in its place left ${stillPassing.length} case(s) passing — ${stillPassing.map(caseKey).join(", ")}.`,
			"A mock, an alias, an absolute path or a link into the live tree bypasses the copy (a workspace package reached through node_modules/<name> → ../../packages/<name> is such a link: cross-package imports resolve into the live tree).",
		];
	}
	if (tests.every(test => reaching.has(test))) return null;
	const control = await runIn(new Map([[mutant.file, CANARY_SOURCE], ...tests.map(test => [test, CONTROL_TEST] as const)]));
	if (control.error !== undefined || control.timedOut) return [`${CANARY_INCOMPLETE} (control run: ${control.timedOut ? `timed out after ${control.durationMs} ms` : control.error})`];
	const unattributed = tests.filter(test => !reaching.has(test) && !control.cases.some(c => c.file === test && c.status === "passed"));
	if (unattributed.length === 0) return null;
	return [
		`the canary breaks the run through a setup file or the config, not through ${unattributed.join(", ")}: no static relative import there reaches ${mutant.file}, so a survivor cannot be attributed to the copy's file.`,
		"Import the source from the test by a relative path, or name a test that does.",
	];
}

function overallVerdict(cases: readonly CaseOutcome[]): { verdict: KillProofReceipt["verdict"]; reasons: string[] } {


	const killed = cases.filter(row => row.verdict === "killed"), inconclusive = cases.filter(row => row.verdict === "inconclusive");
	if (killed.length) return { verdict: "killed", reasons: killed.map(row => `${row.test} failed by its own check under the mutant`) };
	if (inconclusive.length) return { verdict: "inconclusive", reasons: inconclusive.map(row => `${row.test}: ${row.reason ?? "no result"}`) };
	return { verdict: "survived", reasons: [`${cases.length} case(s) passed with the mutant applied — these tests do not detect it`] };
}

/** Test files with at least one killed case — the only files a receipt certifies (review R2). */
export function killedTestFiles(cases: readonly CaseOutcome[]): string[] {
	return [...new Set(cases.filter(row => row.verdict === "killed").map(row => row.test.slice(0, row.test.indexOf(" › "))))];
}

function hashAll(root: string, paths: readonly string[]): HashedFile[] | string {
	const out: HashedFile[] = [];
	for (const path of paths) {
		const hashed = hashFile(root, path);
		if (hashed === null) return `${path} does not exist`;
		out.push(hashed);
	}
	return out;
}

/** Paths a failure message names (ENOENT, "Cannot find module", open/read errors), as written. */
function pathsInMessage(message: string): string[] {
	return [...message.matchAll(/(?:ENOENT|Cannot find module|no such file|Failed to resolve import)[^'"`\n]*['"`]([^'"`]+)['"`]/g)].map(m => m[1] ?? "").filter(Boolean);
}

/**
 * A copy-only baseline failure is not the test's fault: a failing case that names a
 * file the COPY lacks but the live tree has (an ignored fixture) is `unavailable`
 * (review K6). Decided from the failure text, with no run on the live tree — a live
 * run writes caches into the live tree and changed the next verdict (review L8).
 */
function explainBaselineFailure(root: string, copyDir: string, problem: BaselineProblem, mutant: ResolvedMutant): ProveKillResult {
	if (problem.kind === "unavailable") return unavailable(problem.reasons, mutant);
	const lacking = problem.failing.flatMap(row => pathsInMessage(row.message ?? "")).map(path => {
		const inCopy = path.startsWith(copyDir) ? relative(copyDir, path) : isAbsolute(path) ? null : path;
		return inCopy !== null && !existsSync(join(copyDir, inCopy)) && existsSync(join(root, inCopy)) ? inCopy : null;
	}).filter((p): p is string => p !== null);
	if (lacking.length) {
		return unavailable([
			`the isolated copy lacks ${[...new Set(lacking)].join(", ")}: ignored files are not copied. Track the file, then re-run.`,
			...problem.reasons,
		], mutant);
	}
	return { ok: false, verdict: "not-passing-now", reasons: problem.reasons, mutant };
}

export type ProofContextOptions = Omit<ProveKillOptions, "spec">;

/**
 * What every mutant of one file shares, opened ONCE: the validated test files, the git-visible file list, the
 * vitest config, the copy runner, and the memoized shared copies — the unmutated BASELINE (identical for every
 * mutant of the file: same tests, same tree), and the reachability canary with its control (identical for every
 * mutant of the same file and tests). `proveKill` opens one per mutant; `batch.ts` opens one per file and proves
 * every survivor against it, so a batch of n mutants runs one baseline, not n. The per-kill repeats stay per
 * mutant: a kill is the sequence pass, FAIL, pass, pass around THAT mutant run.
 */
export interface ProofContext {
	root: string;
	tests: string[];
	testHashes: HashedFile[];
	files: string[];
	configPath: string | null;
	budgetMs: number;
	now: () => Date;
	persist: boolean;
	/** Run-level notes shared by every proof of the context (the copy-size budget). */
	warnings: string[];
	runIn: (overrides: ReadonlyMap<string, string>) => Promise<VitestRun & { dir: string }>;
	/** The shared unmutated baseline run; executed on first use. */
	baseline: () => Promise<VitestRun & { dir: string }>;
	/** The reachability canary (and control) for a file; executed on first use per file. */
	canary: (mutant: ResolvedMutant, passing: readonly VitestCase[]) => Promise<string[] | null>;
	environment: () => ProofEnvironment;
}

export type OpenedProofContext = { ok: true; context: ProofContext } | { ok: false; reasons: string[] };

/** Validate the tests and the project once and build the shared runner; no vitest run happens here. */
export function openProofContext(options: ProofContextOptions): OpenedProofContext {
	const root = realpathSync(options.root), runner = options.runner ?? runVitestDetailed;
	const tests = normalizeTestPaths(root, options.tests);
	if (tests === null) return { ok: false, reasons: ["a --test path escapes the project root"] };
	if (tests.length === 0) return { ok: false, reasons: ["name at least one test file (--test <file>)"] };
	const testProblems = tests.map(test => testFileProblem(root, test)).filter((p): p is string => p !== null);
	if (testProblems.length) return { ok: false, reasons: testProblems };
	const testHashes = hashAll(root, tests);
	if (typeof testHashes === "string") return { ok: false, reasons: [testHashes] };
	const runnerProblem = options.runner ? null : missingVitest(root);
	if (runnerProblem !== null) return { ok: false, reasons: [runnerProblem] };
	const files = gitVisibleFiles(root);
	if (files === null) return { ok: false, reasons: [`${root} is not a git work tree; the mutant cannot be isolated in a copy`] };
	const explicitConfig = options.vitestConfig === undefined ? undefined : explicitVitestConfig(root, options.vitestConfig);
	if (typeof explicitConfig === "object") return { ok: false, reasons: [explicitConfig.reason] };
	const configPath = resolveVitestConfig(root, explicitConfig);
	const vitestArgs = configPath !== null ? ["--config", configPath] : [];
	const warnings: string[] = [];
	const hoist = options.runner ? undefined : hoistLayout(root);
	const runIn = async (overrides: ReadonlyMap<string, string>): Promise<VitestRun & { dir: string }> => {
		// Speed (docs/reviews/kill-proof-performance.md): the regular-file copies are issued 64 at a time; the tree is
		// identical to the synchronous copy. Each copy is removed before the next stage starts.
		const copy = await createProjectCopyAsync(root, files, new Map(), hoist);
		try {
			const sizeWarning = copySizeWarning(copy.bytes);
			if (sizeWarning !== null && !warnings.includes(sizeWarning)) warnings.push(sizeWarning);
			applyOverrides(copy.dir, overrides);
			return { ...(await runner(copy.dir, tests, options.budgetMs, vitestArgs)), dir: copy.dir };
		} finally {
			await copy.cleanup();
		}
	};
	let baseline: Promise<VitestRun & { dir: string }> | null = null;
	const canaries = new Map<string, Promise<string[] | null>>();
	let environment: ProofEnvironment | null = null;
	return {
		ok: true,
		context: {
			root, tests, testHashes, files, configPath, budgetMs: options.budgetMs, now: options.now ?? (() => new Date()), persist: options.persist !== false, warnings, runIn,
			baseline: () => (baseline ??= runIn(new Map())),
			canary: (mutant, passing) => {
				const memo = canaries.get(mutant.file) ?? canaryProblem(root, mutant, tests, passing, runIn);
				canaries.set(mutant.file, memo);
				return memo;
			},
			environment: () => (environment ??= captureEnvironment(root, configPath ?? undefined)),
		},
	};
}

/** The per-mutant source checks: the file exists, git sees it, and the lexeme is still at the resolved offset. */
function mutantSite(context: ProofContext, mutant: ResolvedMutant): { source: HashedFile; content: string; mutated: string } | ProveKillResult {
	const problem = targetProblem(mutant, context.tests);
	if (problem !== null) return unavailable([problem], mutant);
	const source = hashFile(context.root, mutant.file);
	if (source === null) return unavailable([`${mutant.file} does not exist`], mutant);
	if (!context.files.includes(mutant.file)) return unavailable([`${mutant.file} is not visible to git (ignored or outside the work tree), so it cannot be mutated in a copy`], mutant);
	const content = readFileSync(join(context.root, mutant.file), "utf8");
	if (!content.startsWith(mutant.originalLexeme, mutant.offset)) return unavailable([`${mutant.file} changed between resolution and the run`], mutant);
	return { source, content, mutated: applyMutant(content, mutant.offset, mutant.originalLexeme, mutant.replacement) };
}

/**
 * Prove one RESOLVED mutant against an open context: the shared baseline, then the mutant copy, the repeats
 * (on a kill) or the canary (on a survivor), then the receipt. Every verdict rule lives here, once, so a mutant
 * proved inside a batch gets exactly the result `proveKill` gives it alone.
 */
export async function proveResolved(context: ProofContext, mutant: ResolvedMutant): Promise<ProveKillResult> {
	const { root, tests, warnings } = context;
	const site = mutantSite(context, mutant);
	if ("ok" in site) return site;
	const parse = mutantParses(mutant.file, site.mutated, site.content);

	const baseline = await context.baseline();
	const baseProblem = baselineProblems(tests, baseline);
	if (baseProblem !== null) return withWarnings(explainBaselineFailure(root, baseline.dir, baseProblem, mutant), warnings);

	const passing = baseline.cases.filter(row => tests.includes(row.file) && row.status === "passed");

	const under: VitestRun = parse !== null && !parse.ok
		? { cases: [], timedOut: false, error: parse.reason, exitCode: null, durationMs: 0 }
		: await context.runIn(new Map([[mutant.file, site.mutated]]));
	let cases = judgeCases(passing, under);
	if (cases.some(row => row.verdict === "killed")) cases = await confirmKills(cases, passing, context.runIn);
	const { verdict, reasons } = overallVerdict(cases);

	if (verdict === "survived") {
		const problem = await context.canary(mutant, passing);
		if (problem !== null) return withWarnings(unavailable(problem, mutant), warnings);
	}

	const environment = context.environment();
	const boundMutant: ResolvedMutant = { ...mutant, lineText: lineTextAt(site.content, mutant.offset) };
	const boundImports = boundImportClosure(root, tests, mutant.file);
	const receipt = sealReceipt({
		version: 1,
		id: receiptId({ source: site.source, mutant: boundMutant, tests: context.testHashes, boundImports, environment }),
		digest: "",
		verdict, reasons, provedAt: context.now().toISOString(), root, source: site.source, mutant: boundMutant, tests: context.testHashes, boundImports, killedTests: killedTestFiles(cases),
		baseline: { cases: passing.length, durationMs: baseline.durationMs },
		underMutant: { durationMs: under.durationMs, timedOut: under.timedOut, cases, ...(under.error !== undefined ? { error: under.error } : {}) },
		environment,
	});
	const receiptPath = context.persist ? writeKillProof(root, receipt) : "";
	return withWarnings({ ok: true, receipt, receiptPath }, warnings);
}

/** Run the proof. Reads the live tree, writes only under `.interlinked/test-runs/kill-proofs/` (when `persist`). */
export async function proveKill(options: ProveKillOptions): Promise<ProveKillResult> {
	const root = realpathSync(options.root);
	const resolved = resolveMutant(root, options.spec);
	if (!resolved.ok) return unavailable([resolved.reason]);
	const opened = openProofContext({ ...options, root });
	if (!opened.ok) return unavailable(opened.reasons, resolved.mutant);
	return proveResolved(opened.context, resolved.mutant);
}
