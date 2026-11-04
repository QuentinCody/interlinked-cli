// ===========================================
// Kill proof — baseline run, isolated mutant run, verdict, receipt
// ===========================================
// 1. ONE git-visible copy of the project (`fail-before-fix/snapshot.ts`) is made.
//    The named test files run there UNMUTATED first; every case must pass. Running
//    the baseline in the copy — not the live tree — means an ignored fixture, a
//    cache or an environment difference cannot masquerade as a kill (review R3).
// 2. The one mutated source file is written into the same copy and the same tests
//    run again with vitest's JSON reporter.
// 3. Only cases from the NAMED files count (vitest positional filters are
//    substrings, review R1). A case is `killed` when it fails by its own check
//    (`fail-before-fix/classify.ts failedByOwnCheck`) and the failure is not a
//    `node:assert` raised from product code (review R4); `survived` when it still
//    passes; else `inconclusive` with its first failure line. A runner that times
//    out or fails to launch makes every case inconclusive — never a kill.
// The live tree is only read. The copy is removed before this returns.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { isTestPath } from "../coverage-test-selector.js";
import { failedByOwnCheck, type VitestCase } from "../fail-before-fix/classify.js";
import { runVitestDetailed, type VitestRun } from "../fail-before-fix/index.js";
import { copyWriteTarget, createProjectCopy, gitVisibleFiles } from "../fail-before-fix/snapshot.js";
import { applyMutant } from "../mutation/differential-fuzz-locate.js";
import { captureEnvironment, hashFile, receiptId, writeKillProof } from "./receipt.js";
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

/** The test's own check fired: an assertion or a plain error thrown from the test file; a product `node:assert` is not. */
export function killedByOwnCheck(row: VitestCase): boolean {
	if (!failedByOwnCheck(row)) return false;
	return !((row.message ?? "").startsWith(NODE_ASSERT_PREFIX) && row.thrownInTest !== true);
}

/** Baseline problems: a runner failure, a named file with no run case, or a case that does not pass. */
function baselineProblems(tests: readonly string[], run: VitestRun): { kind: "unavailable" | "not-passing-now"; reasons: string[] } | null {
	if (run.error !== undefined || run.timedOut) {
		return { kind: "unavailable", reasons: [`baseline run failed: ${run.timedOut ? `timed out after ${run.durationMs} ms` : run.error}`] };
	}
	const named = run.cases.filter(row => tests.includes(row.file) && !NOT_RUN.has(row.status));
	const silent = tests.filter(file => !named.some(row => row.file === file));
	if (silent.length) return { kind: "unavailable", reasons: silent.map(file => `${file} reported no executed test case in the baseline copy`) };
	const failing = named.filter(row => row.status !== "passed");
	if (failing.length) {
		return { kind: "not-passing-now", reasons: failing.map(row => `${caseKey(row)}: ${row.status}${row.message ? ` — ${row.message}` : ""}`) };
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
	const testHashes = hashAll(root, tests);
	if (typeof testHashes === "string") return unavailable([testHashes], mutant);
	const source = hashFile(root, mutant.file);
	if (source === null) return unavailable([`${mutant.file} does not exist`], mutant);
	const runnerProblem = options.runner ? null : missingVitest(root);
	if (runnerProblem !== null) return unavailable([runnerProblem], mutant);
	const files = gitVisibleFiles(root);
	if (files === null) return unavailable([`${root} is not a git work tree; the mutant cannot be isolated in a copy`], mutant);
	const content = readFileSync(join(root, mutant.file), "utf8");
	if (!content.startsWith(mutant.originalLexeme, mutant.offset)) return unavailable([`${mutant.file} changed between resolution and the run`], mutant);

	const copy = createProjectCopy(root, files, new Map());
	let baseline: VitestRun, under: VitestRun;
	try {
		if (!existsSync(join(copy.dir, mutant.file))) return unavailable([`${mutant.file} is not visible to git (ignored or outside the work tree), so it cannot be mutated in a copy`], mutant);
		baseline = await runner(copy.dir, tests, options.budgetMs);
		const baseProblem = baselineProblems(tests, baseline);
		if (baseProblem !== null) {
			return baseProblem.kind === "unavailable" ? unavailable(baseProblem.reasons, mutant) : { ok: false, verdict: "not-passing-now", reasons: baseProblem.reasons, mutant };
		}
		writeFileSync(copyWriteTarget(copy.dir, mutant.file), applyMutant(content, mutant.offset, mutant.originalLexeme, mutant.replacement));
		under = await runner(copy.dir, tests, options.budgetMs);
	} finally {
		copy.cleanup();
	}
	const passing = baseline.cases.filter(row => tests.includes(row.file) && row.status === "passed");
	const cases = judgeCases(passing, under);
	const { verdict, reasons } = overallVerdict(cases);
	const environment = captureEnvironment(root);
	const boundMutant: ResolvedMutant = { ...mutant, lineText: lineTextAt(content, mutant.offset) };
	const receipt: KillProofReceipt = {
		version: 1,
		id: receiptId({ source, mutant: boundMutant, tests: testHashes, environment }),
		verdict, reasons, provedAt: now().toISOString(), root, source, mutant: boundMutant, tests: testHashes, killedTests: killedTestFiles(cases),
		baseline: { cases: passing.length, durationMs: baseline.durationMs },
		underMutant: { durationMs: under.durationMs, timedOut: under.timedOut, cases, ...(under.error !== undefined ? { error: under.error } : {}) },
		environment,
	};
	const receiptPath = options.persist === false ? "" : writeKillProof(root, receipt);
	return { ok: true, receipt, receiptPath };
}
