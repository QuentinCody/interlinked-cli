// `proveKillBatch`: every manifest survivor of one file against one shared baseline.
// Fake runner (the real one is exercised by kill-proof-batch.story.test.ts); the
// manifest comes through the repo adapter (`seedFileBaseline` over a Stryker-shaped
// report), never hand-written.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { seedFileBaseline } from "../mutation/adopt.js";
import { emptyManifest, saveManifest } from "../mutation/manifest.js";
import { batchExitCode, listFileSurvivors, type ProveKillBatchResult, proveKillBatch, summarizeBatch } from "./batch.js";
import { proveKill } from "./run.js";
import type { ProveKillResult } from "./types.js";

const FILE = "src/clamp.ts";
const SOURCE = ["export function clamp(n: number, max: number): number {", "\tif (n > max) return max;", "\tif (n < 0) return 0;", "\treturn n;", "}", ""].join("\n");
const TEST_FILE = "src/clamp.test.ts";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\nit('floors', () => { expect(clamp(-1, 3)).toBe(0); });\n";
const NOW = () => new Date("2026-11-05T12:00:00Z");

let root: string;
function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

/** A Stryker-shaped mutant row at `needle`'s first occurrence on 1-based `line`. */
function mutantAt(line: number, needle: string, replacement: string, status: string, mutatorName = "EqualityOperator") {
	const text = SOURCE.split("\n")[line - 1] ?? "";
	const column = text.indexOf(needle) + 1;
	return { mutatorName, replacement, status, location: { start: { line, column }, end: { line, column: column + needle.length } } };
}

/** Three survivors (two in `clamp`'s conditions, one literal) and one killed mutant, through the repo adapter. */
function seedManifest(): void {
	const report = { files: { [FILE]: { source: SOURCE, mutants: [
		mutantAt(2, ">", ">=", "Survived"),
		mutantAt(3, "<", "<=", "Survived"),
		mutantAt(3, "0", "1", "Survived", "NumericLiteral"),
		mutantAt(4, "n", "0", "Killed", "NumericLiteral"),
	] } } };
	const at = NOW().toISOString();
	const base = emptyManifest({ engine: "stryker", engineVersion: "9.6.1", dependencyGraphVersion: "0", environmentHash: "test", authoritativeAt: at });
	const manifest = seedFileBaseline({ base, file: FILE, content: SOURCE, report, at, cwd: root });
	if (manifest === null) throw new Error("seedFileBaseline refused the report");
	saveManifest(join(root, ".interlinked"), manifest);
}

type Case = VitestRun["cases"][number];
const passing = (name: string): Case => ({ file: TEST_FILE, name, title: name, status: "passed" });
const failing = (name: string, message: string): Case => ({ file: TEST_FILE, name, title: name, status: "failed", message });
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });

/** Answers by what the copy's source holds: `>=` is killed by an assertion, `<=` survives, `< 1` crashes. */
function fakeRunner(baseline: VitestRun = okRun([passing("caps"), passing("floors")])) {
	const calls: { source: string }[] = [];
	const runner = async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, FILE), "utf8");
		calls.push({ source });
		if (source.includes("kill-proof canary")) return okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: canary" })));
		if (source === SOURCE) return baseline;
		if (source.includes("n >= max")) return okRun([failing("caps", "AssertionError: expected 5 to be 3"), passing("floors")]);
		if (source.includes("n <= 0")) return okRun([passing("caps"), passing("floors")]);
		return okRun([passing("caps"), failing("floors", "TypeError: boom")]);
	};
	return { runner, calls };
}

const verdicts = (batch: ProveKillBatchResult): string[] => batch.results.map(row => (row.ok ? row.receipt.verdict : row.verdict));

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-batch-")));
	git("init", "-q");
	write(FILE, SOURCE);
	write(TEST_FILE, TEST);
	write(".gitignore", ".interlinked\n");
	git("add", ".");
	seedManifest();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("proveKillBatch — positive (must run every survivor)", () => {
	it("P1: three survivors share ONE baseline copy and one canary; each gets its own mutant copy and, on a kill, its own two repeats", async () => {
		const { runner, calls } = fakeRunner();
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner, now: NOW, persist: false });
		expect(batch.survivors).toBe(3);
		expect(batch.skipped).toBe(0);
		expect(verdicts(batch)).toEqual(["killed", "survived", "inconclusive"]);
		expect(batch.results.map(row => row.ok && row.receipt.mutant.line)).toEqual([2, 3, 3]);
		// 1 baseline + 2 repeats after the one kill — never one baseline per mutant.
		expect(calls.filter(call => call.source === SOURCE)).toHaveLength(3);
		expect(calls[0]?.source).toBe(SOURCE);
		expect(calls.filter(call => call.source.includes("kill-proof canary"))).toHaveLength(1);
		expect(calls.filter(call => call.source !== SOURCE && !call.source.includes("kill-proof canary"))).toHaveLength(3);
		expect(batch.summary).toEqual({ killed: 1, survived: 1, inconclusive: 1, unavailable: 0, notPassingNow: 0, total: 3 });
		// A survivor among the rows is exit 1 (the loop has work left), whatever the undecided row says.
		expect(batchExitCode(batch)).toBe(1);
	});

	it("P2: every per-mutant result equals the single-mutant result for the same inputs (receipt, id and digest included)", async () => {
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner().runner, now: NOW, persist: false });
		expect(batch.results).toHaveLength(3);
		for (const row of batch.results) {
			const single = await proveKill({ root, spec: { kind: "manifest", mutantId: row.mutantId, file: FILE }, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner().runner, now: NOW, persist: false });
			const { mutantId: _id, ...fromBatch } = row;
			expect(fromBatch).toEqual(single);
			expect(single.ok && single.receipt.mutant.mutantId).toBe(row.mutantId);
		}
	});

	it("P3: the result carries the JSON shape the CLI returns: file, tests, generation, per-mutant rows with ids, summary", async () => {
		const batch = await proveKillBatch({ root, file: `./${FILE}`, tests: [`./${TEST_FILE}`], budgetMs: 1000, runner: fakeRunner().runner, now: NOW, persist: false });
		expect(batch).toMatchObject({ file: FILE, tests: [TEST_FILE], generation: 1, survivors: 3, skipped: 0, max: 50 });
		expect(batch.results.every(row => /^[0-9a-f]{16}$/.test(row.mutantId))).toBe(true);
		expect(batch.reasons).toBeUndefined();
		expect(typeof batch.elapsedMs).toBe("number");
	});

	it("P4: --max caps the batch in source order and reports how many were skipped", async () => {
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner().runner, now: NOW, persist: false, max: 2 });
		expect(batch.results).toHaveLength(2);
		expect(batch.skipped).toBe(1);
		expect(batch.survivors).toBe(3);
		expect(verdicts(batch)).toEqual(["killed", "survived"]);
	});

	it("P5: every row killed exits 0 and writes one receipt per mutant", async () => {
		const runner = async (dir: string): Promise<VitestRun> => {
			const source = readFileSync(join(dir, FILE), "utf8");
			return source === SOURCE ? okRun([passing("caps")]) : okRun([failing("caps", "AssertionError: x")]);
		};
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner, now: NOW });
		expect(verdicts(batch)).toEqual(["killed", "killed", "killed"]);
		expect(batchExitCode(batch)).toBe(0);
		const paths = batch.results.map(row => (row.ok ? row.receiptPath : ""));
		expect(new Set(paths).size).toBe(3);
		expect(paths.every(path => path.startsWith(join(root, ".interlinked/test-runs/kill-proofs/")))).toBe(true);
	});

	it("P6: listFileSurvivors lists the open survivors by manifest key, normalizing the spelling", () => {
		const listed = listFileSurvivors(root, `./src/../${FILE}`);
		expect(listed.ok && listed.mutantIds).toHaveLength(3);
		expect(listed.file).toBe(FILE);
	});
});

describe("proveKillBatch — negative (must not run, must not claim)", () => {
	it("N1: no manifest is a batch-level reason, no rows, exit 2", async () => {
		rmSync(join(root, ".interlinked"), { recursive: true, force: true });
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner().runner, persist: false });
		expect(batch.results).toEqual([]);
		expect(batch.reasons?.[0]).toMatch(/no mutation manifest yet/);
		expect(batchExitCode(batch)).toBe(2);
	});

	it("N2: a file the manifest does not hold names the measure command, exit 2", async () => {
		write("src/other.ts", "export const x = 1;\n");
		const batch = await proveKillBatch({ root, file: "src/other.ts", tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner().runner, persist: false });
		expect(batch.reasons).toEqual(["src/other.ts is not in the mutation manifest (generation 1); measure it first: interlinked mutation measure src/other.ts"]);
		expect(batchExitCode(batch)).toBe(2);
	});

	it("N3: a baseline that fails makes every row not-passing-now after exactly ONE run, exit 1, no receipt", async () => {
		const { runner, calls } = fakeRunner(okRun([failing("caps", "AssertionError: red"), passing("floors")]));
		const batch = await proveKillBatch({ root, file: FILE, tests: [TEST_FILE], budgetMs: 1000, runner, now: NOW });
		expect(verdicts(batch)).toEqual(["not-passing-now", "not-passing-now", "not-passing-now"]);
		expect(calls).toHaveLength(1);
		expect(batch.results.every(row => !row.ok && row.mutant?.file === FILE)).toBe(true);
		expect(batchExitCode(batch)).toBe(1);
	});

	it("N4: a test file that does not exist makes every row unavailable with its mutant attached, exit 2, nothing runs", async () => {
		const { runner, calls } = fakeRunner();
		const batch = await proveKillBatch({ root, file: FILE, tests: ["src/nope.test.ts"], budgetMs: 1000, runner, persist: false });
		expect(verdicts(batch)).toEqual(["unavailable", "unavailable", "unavailable"]);
		expect(batch.results.every(row => !row.ok && row.reasons[0] === "src/nope.test.ts does not exist" && row.mutant !== undefined)).toBe(true);
		expect(calls).toHaveLength(0);
		expect(batchExitCode(batch)).toBe(2);
	});

	it("N5: one survivor among kills exits 1; summarizeBatch counts each verdict once", () => {
		const killed = { ok: true, receipt: { verdict: "killed" } } as unknown as ProveKillResult;
		const survived = { ok: true, receipt: { verdict: "survived" } } as unknown as ProveKillResult;
		const npn: ProveKillResult = { ok: false, verdict: "not-passing-now", reasons: [] };
		expect(summarizeBatch([killed, killed, survived])).toEqual({ killed: 2, survived: 1, inconclusive: 0, unavailable: 0, notPassingNow: 0, total: 3 });
		expect(batchExitCode({ summary: summarizeBatch([killed, killed, survived]) })).toBe(1);
		expect(batchExitCode({ summary: summarizeBatch([killed, npn]) })).toBe(1);
		expect(batchExitCode({ summary: summarizeBatch([killed]) })).toBe(0);
		expect(batchExitCode({ summary: summarizeBatch([]) })).toBe(2);
	});
});
