// ===========================================
// Kill proof — review round 6 regressions (2026-11-05, external review of mutation-proof@7e09452)
// ===========================================
// Each case here was a defect read from the source by the reviewer and reproduced before its fix.
// Finding 3: receipts were judged one at a time — one receipt had to be killed by EVERY new case,
// so two good cases proven against two different faults kept the nudge and the Stop check warning.
// Finding 4: an explicit-fault receipt's renew command printed `--mutant <id>` (see tests-prove-kill.test.ts P2).
// Finding 2: every comparison copy was made from the LIVE tree again and the helpers and runtime were hashed
// after the runs, so an edit landing mid-proof could change what the second copy held and what the receipt bound.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import { hashFile } from "./receipt.js";
import { certifyCases, freshKillsForTest, receiptCertifies, verifyKillProof } from "./receipt-freshness.js";
import { resolveMutant } from "./resolve.js";
import { openProofContext, proveKill, proveResolved } from "./run.js";
import type { MutantSpec } from "./types.js";

const SOURCE = "export function clamp(n: number, lo: number, hi: number): number {\n\tif (n < lo) return lo;\n\tif (n > hi) return hi;\n\treturn n;\n}\n";
const TEST_FILE = "src/clamp.mutation-kill.test.ts";
const TEST = "import { clamp } from './clamp.js';\nit('rejects an invalid lower bound', () => { expect(clamp(-1, 0, 9)).toBe(0); });\nit('rejects an invalid upper bound', () => { expect(clamp(10, 0, 9)).toBe(9); });\n";
const LOWER = "rejects an invalid lower bound", UPPER = "rejects an invalid upper bound";
const FAULT_A: MutantSpec = { kind: "explicit", file: "src/clamp.ts", find: "n < lo", replace: "n <= lo - 1" };
const FAULT_B: MutantSpec = { kind: "explicit", file: "src/clamp.ts", find: "n > hi", replace: "n >= hi + 1" };

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r6-")));
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src/clamp.ts"), SOURCE);
	writeFileSync(join(root, TEST_FILE), TEST);
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const row = (name: string, status: Case["status"], message?: string): Case => ({ file: TEST_FILE, name, title: name, status, ...(message !== undefined ? { message } : {}) });
const run = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: cases.some(c => c.status === "failed") ? 1 : 0, durationMs: 10 });
const PASSING = run([row(LOWER, "passed"), row(UPPER, "passed")]);

/** The copy's source decides: unmutated → both pass; fault A → only the lower-bound case fails; fault B → only the upper-bound case. */
async function runner(dir: string): Promise<VitestRun> {
	const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
	if (source.includes("kill-proof canary")) return run([row(LOWER, "failed", "Error: canary"), row(UPPER, "failed", "Error: canary")]);
	if (source.includes("n <= lo - 1")) return run([row(LOWER, "failed", "AssertionError: expected -1 to be 0"), row(UPPER, "passed")]);
	if (source.includes("n >= hi + 1")) return run([row(LOWER, "passed"), row(UPPER, "failed", "AssertionError: expected 10 to be 9")]);
	return PASSING;
}

async function prove(spec: MutantSpec) {
	const result = await proveKill({ root, spec, tests: [TEST_FILE], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(result.reasons.join("; "));
	expect(result.receipt.verdict).toBe("killed");
	return result.receipt;
}

describe("finding 3 — positive (two cases, two faults, two receipts certify together)", () => {
	it("P1: each new case is covered by the receipt whose fault it killed; no single receipt covers both, and the pair certifies", async () => {
		const a = await prove(FAULT_A), b = await prove(FAULT_B);
		// Each receipt alone still fails the per-receipt question (the old rule): the other case survived its fault.
		const aAlone = receiptCertifies(root, a.id, TEST_FILE, [LOWER, UPPER]);
		expect(aAlone.certified).toBe(false);
		expect(!aAlone.certified && aAlone.uncovered).toEqual([UPPER]);
		expect(receiptCertifies(root, b.id, TEST_FILE, [LOWER, UPPER]).certified).toBe(false);
		// Judged together: both cases have fresh executed evidence, each against its own mutant.
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [LOWER, UPPER] });
		expect(cert.certified).toBe(true);
		expect(cert.uncovered).toEqual([]);
		expect(cert.fresh.map(r => r.id).sort()).toEqual([a.id, b.id].sort());
		expect(freshKillsForTest(root, TEST_FILE, [LOWER, UPPER]).map(r => r.id).sort()).toEqual([a.id, b.id].sort());
		expect(killProofNudge({ root, relPath: TEST_FILE, newCases: [LOWER, UPPER] })).toBeNull();
	});
});

describe("finding 3 — negative (a case nobody killed is still uncovered)", () => {
	it("N1: a third new case covered by neither receipt is named, and the pair does not certify it", async () => {
		await prove(FAULT_A);
		await prove(FAULT_B);
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [LOWER, UPPER, "rejects NaN"] });
		expect(cert.certified).toBe(false);
		expect(cert.uncovered).toEqual(["rejects NaN"]);
		expect(cert.fresh).toHaveLength(2);
		expect(freshKillsForTest(root, TEST_FILE, [LOWER, UPPER, "rejects NaN"])).toEqual([]);
		const nudge = killProofNudge({ root, relPath: TEST_FILE, newCases: [LOWER, UPPER, "rejects NaN"] });
		expect(nudge).toContain("2 fresh kill proof(s) cover this file, but not the newly added case(s): rejects NaN");
	});
	it("N2: a stale receipt contributes nothing to the union — its killed case is uncovered again", async () => {
		const a = await prove(FAULT_A);
		await prove(FAULT_B);
		writeFileSync(join(root, "src/clamp.ts"), `${SOURCE}// edited\n`); // both receipts are stale now
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [LOWER, UPPER] });
		expect(cert.certified).toBe(false);
		expect(cert.fresh).toEqual([]);
		expect(cert.uncovered).toEqual([LOWER, UPPER]);
		expect(cert.results.filter(r => !r.certified && r.receipt?.id === a.id)).toHaveLength(1);
	});
});

const HELPER = "src/helper.ts", HELPER_SOURCE = "export const expectIn = (n: number, lo: number, hi: number): boolean => n >= lo && n <= hi;\n";
const TEST_WITH_HELPER = "import { clamp } from './clamp.js';\nimport { expectIn } from './helper.js';\nit('rejects an invalid lower bound', () => { expect(expectIn(clamp(-1, 0, 9), 0, 9) && clamp(-1, 0, 9) === 0).toBe(true); });\n";
const LIVE_EDIT = "// another agent edited this mid-proof\n";
const copiesNow = (): Set<string> => new Set(readdirSync(tmpdir()).filter(name => name.startsWith("interlinked-fail-before-fix-")));

describe("finding 2 — positive (the compared runs and the receipt share ONE frozen input)", () => {
	it("P1: a live edit to the test, a helper and the source DURING the baseline run reaches no copy and is not what the receipt binds", async () => {
		writeFileSync(join(root, HELPER), HELPER_SOURCE);
		writeFileSync(join(root, TEST_FILE), TEST_WITH_HELPER);
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const frozenHashes = { source: hashFile(root, "src/clamp.ts")?.sha256, test: hashFile(root, TEST_FILE)?.sha256, helper: hashFile(root, HELPER)?.sha256 };
		const seen: Array<{ helper: string; test: string; source: string }> = [];
		let edited = false;
		const racing = async (dir: string): Promise<VitestRun> => {
			seen.push({ helper: readFileSync(join(dir, HELPER), "utf8"), test: readFileSync(join(dir, TEST_FILE), "utf8"), source: readFileSync(join(dir, "src/clamp.ts"), "utf8").replace("n <= lo - 1", "n < lo") });
			if (!edited) {
				// The concurrent edit lands in the LIVE tree while the baseline is running.
				for (const file of [HELPER, TEST_FILE, "src/clamp.ts"]) writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + LIVE_EDIT);
				edited = true;
			}
			const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
			return source.includes("n <= lo - 1") ? run([row(LOWER, "failed", "AssertionError: expected false to be true")]) : run([row(LOWER, "passed")]);
		};
		const before = copiesNow();
		const result = await proveKill({ root, spec: FAULT_A, tests: [TEST_FILE], budgetMs: 1000, runner: racing });
		if (!result.ok) throw new Error(result.reasons.join("; "));
		// pass, FAIL, pass, pass: four copies, every one holding the frozen (pre-edit) bytes.
		expect(seen).toHaveLength(4);
		expect(seen.every(copy => copy.helper === HELPER_SOURCE && copy.test === TEST_WITH_HELPER && copy.source === SOURCE)).toBe(true);
		expect(result.receipt.verdict).toBe("killed");
		expect(result.receipt.source.sha256).toBe(frozenHashes.source);
		expect(result.receipt.tests.map(t => t.sha256)).toEqual([frozenHashes.test]);
		expect(result.receipt.boundImports.find(f => f.path === HELPER)?.sha256).toBe(frozenHashes.helper);
		// Against the live tree the receipt is STALE — the edit is visible as a change, never as certified bytes.
		const verdict = verifyKillProof(root, result.receipt);
		expect(verdict.fresh).toBe(false);
		expect(!verdict.fresh && verdict.reasons).toEqual(expect.arrayContaining([`source src/clamp.ts changed since the proof`, `test ${TEST_FILE} changed since the proof`, `helper ${HELPER} changed since the proof`]));
		// The frozen copy is removed with the proof.
		expect([...copiesNow()].filter(name => !before.has(name))).toEqual([]);
	});
	it("P2: a batch context proves a second mutant against the SAME frozen bytes after a live edit, and close() removes the frozen copy", async () => {
		const opened = openProofContext({ root, tests: [TEST_FILE], budgetMs: 1000, runner });
		if (!opened.ok) throw new Error(opened.reasons.join("; "));
		const a = resolveMutant(root, FAULT_A), b = resolveMutant(root, FAULT_B);
		if (!a.ok || !b.ok) throw new Error("fixture mutants must resolve");
		const first = await proveResolved(opened.context, a.mutant);
		writeFileSync(join(root, "src/clamp.ts"), `${SOURCE}${LIVE_EDIT}`);
		const second = await proveResolved(opened.context, b.mutant);
		if (!first.ok || !second.ok) throw new Error("both proofs must produce receipts");
		expect(second.receipt.verdict).toBe("killed");
		expect(second.receipt.source.sha256).toBe(first.receipt.source.sha256);
		const frozen = await opened.context.frozen();
		if ("problem" in frozen) throw new Error(frozen.problem);
		expect(existsSync(frozen.dir)).toBe(true);
		await opened.context.close();
		expect(existsSync(frozen.dir)).toBe(false);
	});
});

const DECIDER = "src/bounds.ts", DECIDER_SOURCE = "export const LO = 0, HI = 9;\n";
const SOURCE_VIA_DECIDER = "import { HI, LO } from './bounds.js';\nexport function clamp(n: number, lo: number = LO, hi: number = HI): number {\n\tif (n < lo) return lo;\n\tif (n > hi) return hi;\n\treturn n;\n}\n";

describe("finding 1 — positive (a helper reached only THROUGH the mutated source is bound)", () => {
	it("P1: test → target → helper: the helper is bound, credited to the test, and editing it stales the receipt", async () => {
		writeFileSync(join(root, DECIDER), DECIDER_SOURCE);
		writeFileSync(join(root, "src/clamp.ts"), SOURCE_VIA_DECIDER);
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const receipt = await prove(FAULT_A);
		const bound = receipt.boundImports.find(file => file.path === DECIDER);
		expect(bound).toMatchObject({ path: DECIDER, sha256: hashFile(root, DECIDER)?.sha256, importedBy: [TEST_FILE] });
		expect(receipt.boundImports.map(file => file.path)).not.toContain("src/clamp.ts"); // the source is bound as `source`, never as a helper
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
		writeFileSync(join(root, DECIDER), "export const LO = -1, HI = 9;\n"); // the behaviour-deciding helper changes; test and target bytes do not
		const verdict = verifyKillProof(root, receipt);
		expect(verdict).toEqual({ fresh: false, reasons: [`helper ${DECIDER} changed since the proof`] });
		expect(receiptCertifies(root, receipt.id, TEST_FILE).certified).toBe(false);
	});
});

describe("finding 1 — negative (the walk through the source binds only what it reaches)", () => {
	it("N1: a file the source does not import is not bound, and editing it leaves the receipt fresh", async () => {
		writeFileSync(join(root, DECIDER), DECIDER_SOURCE);
		writeFileSync(join(root, "src/unrelated.ts"), "export const nothing = 1;\n");
		writeFileSync(join(root, "src/clamp.ts"), SOURCE_VIA_DECIDER);
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const receipt = await prove(FAULT_A);
		expect(receipt.boundImports.map(file => file.path)).toEqual([DECIDER]);
		writeFileSync(join(root, "src/unrelated.ts"), "export const nothing = 2;\n");
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
	});
});

describe("finding 2 — negative (a change BEFORE the freeze is the proof's input, not a race)", () => {
	it("N1: a test file edited before the proof starts is what the receipt binds, and it is fresh against the live tree", async () => {
		writeFileSync(join(root, TEST_FILE), `${TEST}${LIVE_EDIT}`);
		const receipt = await prove(FAULT_A);
		expect(receipt.tests[0]?.sha256).toBe(hashFile(root, TEST_FILE)?.sha256);
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
	});
});
