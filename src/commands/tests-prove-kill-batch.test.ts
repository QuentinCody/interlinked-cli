// Pins the CLI side of `interlinked tests prove-kill --all-survivors`: option
// validation, the compact table, the k/s/i/u summary line and the exit mapping.
// The orchestration is pinned in `src/harness/kill-proof/batch.test.ts`.
import { describe, expect, it } from "vitest";
import { buildProgram } from "../cli-program.js";
import { batchExitCode, type ProveKillBatchResult, type ProveKillBatchRow, summarizeBatch } from "../harness/kill-proof/batch.js";
import type { KillProofReceipt, ResolvedMutant } from "../harness/kill-proof/types.js";
import { batchOptionProblem, renderProveKillBatch, summaryLine } from "./tests-prove-kill-batch.js";

const FILE = "src/harness/recurrence-time.ts";
const TEST = "src/harness/recurrence-time.mutation-kill.test.ts";

function mutant(id: string, line: number, lexeme: string, replacement: string): ResolvedMutant {
	return { file: FILE, offset: line * 10, originalLexeme: lexeme, replacement, line, source: "manifest", mutantId: id };
}

function row(id: string, line: number, verdict: KillProofReceipt["verdict"], cases: KillProofReceipt["underMutant"]["cases"], lexeme = "ms > lastMs", replacement = "ms >= lastMs"): ProveKillBatchRow {
	const receipt: KillProofReceipt = {
		version: 1, id: id.slice(0, 16), digest: "0".repeat(64), verdict, reasons: verdict === "survived" ? ["2 case(s) passed with the mutant applied — these tests do not detect it"] : [], provedAt: "2026-11-05T00:00:00.000Z", root: "/repo",
		source: { path: FILE, sha256: "a" }, mutant: mutant(id, line, lexeme, replacement), tests: [{ path: TEST, sha256: "b" }], boundImports: [], killedTests: verdict === "killed" ? [TEST] : [],
		baseline: { cases: 2, durationMs: 900 }, underMutant: { durationMs: 700, timedOut: false, cases },
		environment: { node: "v22.0.0", vitest: "4.0.0", platform: "linux", config: null, setupFiles: [] },
	};
	return { ok: true, receipt, receiptPath: `/repo/.interlinked/test-runs/kill-proofs/${id}.json`, mutantId: id };
}

function batch(rows: ProveKillBatchRow[], extra: Partial<ProveKillBatchResult> = {}): ProveKillBatchResult {
	return { file: FILE, tests: [TEST], survivors: rows.length, skipped: 0, max: 50, generation: 3, results: rows, summary: summarizeBatch(rows), elapsedMs: 41_200, ...extra };
}

const KILLED = row("80af77afb7085336", 66, "killed", [{ test: `${TEST} › widens the upper bound`, verdict: "killed" }, { test: `${TEST} › keeps the lower bound`, verdict: "survived" }]);
const SURVIVED = row("5f9ac8fb2f36c85c", 17, "survived", [{ test: `${TEST} › widens the upper bound`, verdict: "survived" }], "MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND", "MINUTES_PER_HOUR * SECONDS_PER_MINUTE / MS_PER_SECOND");
const UNAVAILABLE: ProveKillBatchRow = { ok: false, verdict: "unavailable", reasons: ["source drift: symbol updateSeenBounds not found (mutant 91a09824f621fd65)"], mutantId: "91a09824f621fd65" };

describe("batchOptionProblem — positive (accepted)", () => {
	it("P1: --all-survivors with --file and tests, with or without --max, is accepted", () => {
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, test: [TEST] })).toBeNull();
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, test: [TEST], max: "10", runTimeout: "1000" })).toBeNull();
	});
	it("P2: without --all-survivors and without --max there is nothing to validate here", () => {
		expect(batchOptionProblem({ mutant: "0123456789abcdef" })).toBeNull();
	});
});

describe("batchOptionProblem — negative (usage errors, exit 2)", () => {
	it("N1: --all-survivors refuses --mutant, --find and --replace", () => {
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, mutant: "0123456789abcdef" })).toMatch(/do not pass --mutant, --find or --replace/);
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, find: "a", replace: "b" })).toMatch(/do not pass --mutant/);
	});
	it("N2: --all-survivors needs --file", () => {
		expect(batchOptionProblem({ allSurvivors: true, test: [TEST] })).toBe("--all-survivors needs --file <source>: the measured file whose survivors to prove");
	});
	it("N3: --max must be a positive integer and applies to --all-survivors only; a bad --run-timeout is still refused", () => {
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, max: "0" })).toBe("--max must be a positive integer");
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, max: "ten" })).toBe("--max must be a positive integer");
		expect(batchOptionProblem({ file: FILE, max: "3" })).toBe("--max applies to --all-survivors only");
		expect(batchOptionProblem({ allSurvivors: true, file: FILE, runTimeout: "soon" })).toBe("--run-timeout must be a positive number of milliseconds");
	});
});

describe("renderProveKillBatch — positive (a table per mutant, one summary)", () => {
	it("P1: the table carries id, line, lexeme → replacement, verdict and the killed cases; the summary counts k/s/i/u", () => {
		const text = renderProveKillBatch(batch([SURVIVED, KILLED, UNAVAILABLE]));
		const lines = text.split("\n");
		expect(lines[0]).toBe(`file: ${FILE} (3 open survivor(s) in the manifest, generation 3; 3 run)`);
		expect(lines[1]).toBe(`tests: ${TEST} (2 case(s) pass in the isolated copy, 900 ms, shared by every mutant)`);
		expect(lines[2]).toMatch(/^ {2}mutant {13}line {2}mutation {2,}verdict {2,}killed cases$/);
		expect(lines[3]).toMatch(/^ {2}5f9ac8fb2f36c85c {5}17 {2}"MINUTES_PER_HOUR \* SECONDS_PER_M… → "MINUTES_PER_HOUR \* SECONDS_PER_M… {2}SURVIVED +none — every case still passes$/);
		expect(lines[4]).toMatch(/^ {2}80af77afb7085336 {5}66 {2}"ms > lastMs" → "ms >= lastMs" +KILLED +1: widens the upper bound$/);
		expect(lines[5]).toMatch(/^ {2}91a09824f621fd65 {6}- {2}\(not resolved\) +UNAVAILABLE +source drift: symbol updateSeenBounds not found \(mutant 91a…$/);
		expect(lines[6]).toBe("summary: 1 killed / 1 survived / 0 inconclusive / 1 unavailable of 3 (41.2 s)");
		expect(lines[7]).toBe("1 survivor(s) still pass these tests. Assert the value each surviving line changes, then re-run the same command.");
	});
	it("P2: every row killed says so, names the re-measure command, and exits 0", () => {
		const all = batch([KILLED, { ...KILLED, mutantId: "0000000000000001" }]);
		const text = renderProveKillBatch(all);
		expect(text.split("\n").at(-1)).toBe(`Every survivor that ran is killed; one receipt per mutant is recorded. Re-measure the file to update the manifest: interlinked mutation measure ${FILE} --record`);
		expect(batchExitCode(all)).toBe(0);
	});
	it("P3: --max shows the skipped count in the summary and the next step", () => {
		const capped = batch([KILLED], { survivors: 9, skipped: 8, max: 1 });
		expect(summaryLine(capped)).toBe("summary: 1 killed / 0 survived / 0 inconclusive / 0 unavailable of 1; 8 skipped by --max 1 (41.2 s)");
		expect(renderProveKillBatch(capped)).toContain("8 survivor(s) did not run; raise --max to cover them.");
	});
	it("P4: not-passing-now rows are counted in the summary and the next step says to fix the tests first; exit 1", () => {
		const npn: ProveKillBatchRow = { ok: false, verdict: "not-passing-now", reasons: [`${TEST} › caps: failed — AssertionError: x`], mutant: mutant("80af77afb7085336", 66, "a", "b"), mutantId: "80af77afb7085336" };
		const text = renderProveKillBatch(batch([npn, npn]));
		expect(text).toContain("summary: 0 killed / 0 survived / 0 inconclusive / 0 unavailable / 2 not-passing-now of 2 (41.2 s)");
		expect(text.split("\n").at(-1)).toBe("Make the tests pass on the current code first. A test that already fails proves nothing about any mutant.");
		expect(batchExitCode(batch([npn]))).toBe(1);
	});
	it("P5: a warning is printed after the file line and changes nothing else", () => {
		const text = renderProveKillBatch(batch([KILLED], { warnings: ["[interlinked:kill-proof] copy is 400 MiB; large tracked files slow every proof"] }));
		expect(text.split("\n")[1]).toBe("warning: [interlinked:kill-proof] copy is 400 MiB; large tracked files slow every proof");
	});
});

describe("renderProveKillBatch — negative (nothing ran)", () => {
	it("N1: a batch-level reason (no manifest, file not measured) is listed, no table, exit 2", () => {
		const empty = batch([], { survivors: 0, generation: null, reasons: ["no mutation manifest yet: run `interlinked mutation measure <file>`, or prove one explicit fault with --file/--find/--replace"] });
		const text = renderProveKillBatch(empty);
		expect(text).toBe([
			`file: ${FILE} (0 open survivor(s) in the manifest; 0 run)`,
			`tests: ${TEST}`,
			"  - no mutation manifest yet: run `interlinked mutation measure <file>`, or prove one explicit fault with --file/--find/--replace",
			"summary: 0 killed / 0 survived / 0 inconclusive / 0 unavailable of 0 (41.2 s)",
			"Nothing ran. Fix the reason above and re-run. No receipt was written.",
		].join("\n"));
		expect(batchExitCode(empty)).toBe(2);
	});
	it("N2: a killed row beside an undecided row is not exit 0 and not exit 1", () => {
		const inconclusive = row("0000000000000002", 24, "inconclusive", [{ test: `${TEST} › x`, verdict: "inconclusive", reason: "TypeError: boom" }]);
		const mixed = batch([KILLED, inconclusive]);
		expect(batchExitCode(mixed)).toBe(2);
		expect(renderProveKillBatch(mixed).split("\n").at(-1)).toBe("Nothing is proven for the undecided rows: a crash, a timeout, a parse error or an unresolvable mutant is not a kill.");
	});
});

describe("prove-kill registration — the batch flags must not capture the single-mutant path", () => {
	it("N1: --max carries no commander default (a default made every `--mutant` run a refused batch request) and --all-survivors is a plain flag", () => {
		const tests = buildProgram("0.0.0").commands.find(c => c.name() === "tests");
		const proveKill = tests?.commands.find(c => c.name() === "prove-kill");
		const max = proveKill?.options.find(o => o.long === "--max");
		expect(max).toBeDefined();
		expect(max?.defaultValue).toBeUndefined();
		expect(proveKill?.options.find(o => o.long === "--all-survivors")?.defaultValue).toBeUndefined();
	});
});
