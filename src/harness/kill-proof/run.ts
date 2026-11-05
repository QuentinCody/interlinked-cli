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
//    (`fail-before-fix/classify.ts failedByOwnCheck`) and the failure is not a
//    `node:assert` raised from product code (review R4); `survived` when it still
//    passes; else `inconclusive` with its first failure line. A runner that times
//    out or fails to launch makes every case inconclusive — never a kill.
// The live tree is only read. Both copies are removed before this returns.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { isTestPath } from "../coverage-test-selector.js";
import { failedByOwnCheck, type VitestCase } from "../fail-before-fix/classify.js";
import { runVitestDetailed, type VitestRun } from "../fail-before-fix/index.js";
import { createProjectCopy, gitVisibleFiles } from "../fail-before-fix/snapshot.js";
import { loadTsModule } from "../mutation/differential-fuzz-deps.js";
import { applyMutant } from "../mutation/differential-fuzz-locate.js";
import { captureEnvironment, hashFile, receiptId, sealReceipt, writeKillProof } from "./receipt.js";
import { lineTextAt, resolveMutant } from "./resolve.js";
import type { CaseOutcome, HashedFile, KillProofReceipt, MutantSpec, ProveKillResult, ResolvedMutant } from "./types.js";

export interface ProveKillOptions {
	root: string;
	spec: MutantSpec;
	tests: readonly string[];
	/** Budget for EACH vitest run (baseline, then under the mutant). */
	budgetMs: number;
	now?: () => Date;
	/** Test hook: replaces the vitest runner. */
	runner?: (dir: string, files: readonly string[], budgetMs: number) => Promise<VitestRun>;
	/** When false the receipt is returned but not written. Default true. */
	persist?: boolean;
}

/** Cases vitest reports but does not run: not evidence either way (review R14). */
const NOT_RUN = new Set(["skipped", "todo", "pending", "disabled"]);
/** `node:assert` failures carry this code; raised from product code they are not the test's check (review R4). */
const NODE_ASSERT_PREFIX = "AssertionError [ERR_ASSERTION]";

const caseKey = (row: Pick<VitestCase, "file" | "name">): string => `${row.file} › ${row.name}`;

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
	if (lstatSync(abs).isDirectory()) return `${test} is a directory; name test files`;
	const real = realpathSync(abs);
	if (real !== root && !real.startsWith(root + sep)) return `${test} resolves outside the project (${real}); a test outside the copy would run against the live source`;
	return null;
}

/** The test's own check fired: an assertion or a plain error thrown from the test file; a product `node:assert` is not. */
export function killedByOwnCheck(row: VitestCase): boolean {
	if (!failedByOwnCheck(row)) return false;
	return !((row.message ?? "").startsWith(NODE_ASSERT_PREFIX) && row.thrownInTest !== true);
}

/** The mutated source must still parse: a syntax error is a compile error, not behaviour (review K5). */
export function mutantParses(file: string, mutated: string): { ok: true } | { ok: false; reason: string } | null {
	const ts = loadTsModule();
	if (ts === null) return null;
	const out = ts.transpileModule(mutated, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
	const syntax = (out.diagnostics ?? []).find(d => d.category === ts.DiagnosticCategory.Error);
	if (syntax === undefined) return { ok: true };
	const text = ts.flattenDiagnosticMessageText(syntax.messageText, " ");
	return { ok: false, reason: `the mutated ${file} does not parse (${text}); a compile error is not a kill` };
}

type BaselineProblem = { kind: "unavailable" | "not-passing-now"; reasons: string[]; failing: VitestCase[] };

/** Baseline problems: a runner failure, a named file with no run case, or a case that does not pass. */
function baselineProblems(tests: readonly string[], run: VitestRun): BaselineProblem | null {
	if (run.error !== undefined || run.timedOut) {
		return { kind: "unavailable", reasons: [`baseline run failed: ${run.timedOut ? `timed out after ${run.durationMs} ms` : run.error}`], failing: [] };
	}
	const named = run.cases.filter(row => tests.includes(row.file) && !NOT_RUN.has(row.status));
	const silent = tests.filter(file => !named.some(row => row.file === file));
	if (silent.length) return { kind: "unavailable", reasons: silent.map(file => `${file} reported no executed test case in the baseline copy`), failing: [] };
	const failing = named.filter(row => row.status !== "passed");
	if (failing.length) {
		return { kind: "not-passing-now", reasons: failing.map(row => `${caseKey(row)}: ${row.status}${row.message ? ` — ${row.message}` : ""}`), failing };
	}
	return null;
}

function judgeCases(passing: readonly VitestCase[], under: VitestRun): CaseOutcome[] {
	const seen = new Map(under.cases.map(row => [caseKey(row), row]));
	const runnerFailure = under.timedOut ? `runner timed out after ${under.durationMs} ms` : under.error;
	return passing.map(row => {
		const test = caseKey(row);
		if (runnerFailure !== undefined) return { test, verdict: "inconclusive", reason: runnerFailure };
		const result = seen.get(test);
		if (result?.status === "passed") return { test, verdict: "survived" };
		if (result !== undefined && killedByOwnCheck(result)) return { test, verdict: "killed" };
		return { test, verdict: "inconclusive", reason: result?.message ?? (result ? result.status : "no result under the mutant") };
	});
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

const OTHER_RUNNERS = ["jest", "ava", "mocha", "uvu", "tap", "node:test", "jasmine", "bun:test"];

/** v1 runs vitest only; say so, and name the runner the project does declare (review: a jest repo blamed its tests). */
export function missingVitest(root: string): string | null {
	if (existsSync(join(root, "node_modules", ".bin", "vitest"))) return null;
	let declared = "";
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (typeof pkg === "object" && pkg !== null) {
			const deps = { ...(pkg as { dependencies?: Record<string, string> }).dependencies, ...(pkg as { devDependencies?: Record<string, string> }).devDependencies };
			const found = OTHER_RUNNERS.filter(name => name in deps);
			const script = (pkg as { scripts?: Record<string, string> }).scripts?.test;
			if (found.length) declared = ` (this project declares ${found.join(", ")})`;
			else if (script) declared = ` (its test script is \`${script}\`)`;
		}
	} catch {
		declared = "";
	}
	return `vitest is not installed in this project${declared}; v1 of prove-kill runs vitest only`;
}

function targetProblem(mutant: ResolvedMutant, tests: readonly string[]): string | null {
	if (tests.includes(mutant.file)) return `${mutant.file} is both the mutated source and a named test`;
	if (!JS_TS_EXTS.has(getExtension(mutant.file))) return `${mutant.file} is not a JS/TS source file; a proof mutates product code, not data or fixtures`;
	if (isTestPath(mutant.file)) return `${mutant.file} is a test file; a proof mutates product code`;
	if (mutant.file.split("/").includes("node_modules")) return `${mutant.file} is under node_modules`;
	return null;
}

/** A copy-only baseline failure (ignored fixture, environment) is not the test's fault: check the live tree, read only (review K6). */
async function explainBaselineFailure(root: string, problem: BaselineProblem, tests: readonly string[], runner: NonNullable<ProveKillOptions["runner"]>, budgetMs: number, mutant: ResolvedMutant): Promise<ProveKillResult> {
	if (problem.kind === "unavailable") return unavailable(problem.reasons, mutant);
	const live = await runner(root, tests, budgetMs);
	const liveFailing = problem.failing.filter(row => live.cases.find(c => caseKey(c) === caseKey(row))?.status !== "passed");
	if (live.error === undefined && !live.timedOut && liveFailing.length === 0) {
		return unavailable([
			`${problem.failing.length} case(s) pass on the live tree but fail in the isolated git-visible copy (ignored or untracked files are not copied):`,
			...problem.reasons,
		], mutant);
	}
	return { ok: false, verdict: "not-passing-now", reasons: problem.reasons, mutant };
}

/** Run the proof. Reads the live tree, writes only under `.interlinked/test-runs/kill-proofs/` (when `persist`). */
export async function proveKill(options: ProveKillOptions): Promise<ProveKillResult> {
	const root = realpathSync(options.root), runner = options.runner ?? runVitestDetailed, now = options.now ?? (() => new Date());
	const tests = normalizeTestPaths(root, options.tests);
	if (tests === null) return unavailable(["a --test path escapes the project root"]);
	if (tests.length === 0) return unavailable(["name at least one test file (--test <file>)"]);
	const resolved = resolveMutant(root, options.spec);
	if (!resolved.ok) return unavailable([resolved.reason]);
	const mutant = resolved.mutant;
	const problem = targetProblem(mutant, tests);
	if (problem !== null) return unavailable([problem], mutant);
	const testProblems = tests.map(test => testFileProblem(root, test)).filter((p): p is string => p !== null);
	if (testProblems.length) return unavailable(testProblems, mutant);
	const testHashes = hashAll(root, tests);
	if (typeof testHashes === "string") return unavailable([testHashes], mutant);
	const source = hashFile(root, mutant.file);
	if (source === null) return unavailable([`${mutant.file} does not exist`], mutant);
	const runnerProblem = options.runner ? null : missingVitest(root);
	if (runnerProblem !== null) return unavailable([runnerProblem], mutant);
	const files = gitVisibleFiles(root);
	if (files === null) return unavailable([`${root} is not a git work tree; the mutant cannot be isolated in a copy`], mutant);
	if (!files.includes(mutant.file)) return unavailable([`${mutant.file} is not visible to git (ignored or outside the work tree), so it cannot be mutated in a copy`], mutant);
	const content = readFileSync(join(root, mutant.file), "utf8");
	if (!content.startsWith(mutant.originalLexeme, mutant.offset)) return unavailable([`${mutant.file} changed between resolution and the run`], mutant);
	const mutated = applyMutant(content, mutant.offset, mutant.originalLexeme, mutant.replacement);
	const parse = mutantParses(mutant.file, mutated);

	const baselineCopy = createProjectCopy(root, files, new Map());
	let baseline: VitestRun;
	try {
		baseline = await runner(baselineCopy.dir, tests, options.budgetMs);
	} finally {
		baselineCopy.cleanup();
	}
	const baseProblem = baselineProblems(tests, baseline);
	if (baseProblem !== null) return explainBaselineFailure(root, baseProblem, tests, runner, options.budgetMs, mutant);
	const passing = baseline.cases.filter(row => tests.includes(row.file) && row.status === "passed");

	let under: VitestRun;
	if (parse !== null && !parse.ok) {
		under = { cases: [], timedOut: false, error: parse.reason, exitCode: null, durationMs: 0 };
	} else {
		const mutantCopy = createProjectCopy(root, files, new Map([[mutant.file, mutated]]));
		try {
			under = await runner(mutantCopy.dir, tests, options.budgetMs);
		} finally {
			mutantCopy.cleanup();
		}
	}
	const cases = judgeCases(passing, under);
	const { verdict, reasons } = overallVerdict(cases);
	const environment = captureEnvironment(root);
	const boundMutant: ResolvedMutant = { ...mutant, lineText: lineTextAt(content, mutant.offset) };
	const receipt = sealReceipt({
		version: 1,
		id: receiptId({ source, mutant: boundMutant, tests: testHashes, environment }),
		digest: "",
		verdict, reasons, provedAt: now().toISOString(), root, source, mutant: boundMutant, tests: testHashes, killedTests: killedTestFiles(cases),
		baseline: { cases: passing.length, durationMs: baseline.durationMs },
		underMutant: { durationMs: under.durationMs, timedOut: under.timedOut, cases, ...(under.error !== undefined ? { error: under.error } : {}) },
		environment,
	});
	const receiptPath = options.persist === false ? "" : writeKillProof(root, receipt);
	return { ok: true, receipt, receiptPath };
}
