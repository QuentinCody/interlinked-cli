import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { killedByOwnCheck, killedTestFiles, missingVitest, normalizeTestPaths, proveKill } from "./run.js";
import { freshKillsForTest, hashFile, parseKillProof, readKillProof, readKillProofIndex, rebuildKillProofIndex, verifyKillProof, writeKillProof } from "./receipt.js";
import { lineTextAt, resolveMutant } from "./resolve.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const TEST_FILE = "src/clamp.test.ts";

let root: string;
function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-")));
	git("init", "-q");
	write("src/clamp.ts", SOURCE);
	write(TEST_FILE, TEST);
	git("add", ".");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const passing = (name: string, file = TEST_FILE): Case => ({ file, name, title: name, status: "passed" });
const failing = (name: string, message: string, extra: Partial<Case> = {}): Case => ({ file: TEST_FILE, name, title: name, status: "failed", message, ...extra });
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;

/** A fake runner that answers by what the copy holds: the unmutated source → `baseline` (also the repeat baseline
 *  after a kill), the mutated source → `mutated`, the reachability canary → `canary` (default: every case fails,
 *  i.e. the tests DID load the file). */
function fakeRunner(baseline: VitestRun, mutated: VitestRun, canary?: VitestRun) {
	const calls: { dir: string; source: string; args: readonly string[] }[] = [];
	const loaded: VitestRun = okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: interlinked kill-proof canary" })));
	const runner = async (dir: string, _files: readonly string[], _budgetMs: number, args: readonly string[]): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		calls.push({ dir, source, args });
		if (source.includes("kill-proof canary")) return canary ?? loaded;
		return source === SOURCE ? baseline : mutated;
	};
	return { runner, calls };
}
const KILLED = okRun([failing("caps", "AssertionError: expected 5 to be 3")]);

async function provenKill() {
	const { runner } = fakeRunner(okRun([passing("caps")]), KILLED);
	const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(`expected a receipt: ${result.reasons.join("; ")}`);
	return result.receipt;
}

describe("resolveMutant — positive (must fire)", () => {
	it("P1: an explicit fault whose anchor occurs once resolves to its offset and line", () => {
		const resolved = resolveMutant(root, SPEC);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.mutant).toMatchObject({ file: "src/clamp.ts", offset: SOURCE.indexOf("n > max"), line: 2, source: "explicit" });
		expect(lineTextAt(SOURCE, resolved.mutant.offset)).toBe("\treturn n > max ? max : n;");
	});
});

describe("resolveMutant — negative (must not fire)", () => {
	it("N1: an anchor that occurs twice is refused with the count", () => {
		write("src/clamp.ts", `${SOURCE}// n > max\n`);
		expect(resolveMutant(root, SPEC)).toEqual({ ok: false, reason: "the --find text occurs 2 times in src/clamp.ts; it must occur exactly once" });
	});
	it("N2: a manifest id without a manifest names the measure command", () => {
		const resolved = resolveMutant(root, { kind: "manifest", mutantId: "0123456789abcdef" });
		expect(!resolved.ok && resolved.reason).toMatch(/no mutation manifest/);
	});
	it("N3: a missing source file is refused", () => {
		expect(resolveMutant(root, { ...SPEC, file: "src/nope.ts" })).toEqual({ ok: false, reason: "src/nope.ts does not exist in the working tree" });
	});
});

describe("proveKill — positive (must fire)", () => {
	it("P1: a case that fails by assertion under the mutant is a kill; the receipt binds source, tests, mutant, runtime and the killing file", async () => {
		const { runner, calls } = fakeRunner(okRun([passing("caps")]), KILLED);
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, now: () => new Date("2026-11-04T23:00:00Z") });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.verdict).toBe("killed");
		expect(result.receipt.underMutant.cases).toEqual([{ test: `${TEST_FILE} › caps`, verdict: "killed" }]);
		expect(result.receipt.killedTests).toEqual([TEST_FILE]);
		expect(result.receipt.source).toEqual(hashFile(root, "src/clamp.ts"));
		expect(result.receipt.tests).toEqual([hashFile(root, TEST_FILE)]);
		expect(result.receipt.mutant.lineText).toBe("\treturn n > max ? max : n;");
		expect(result.receipt.environment.node).toBe(process.version);
		expect(readKillProof(root, result.receipt.id)).toEqual(result.receipt);
		expect(readKillProofIndex(root).receipts.map(row => row.id)).toEqual([result.receipt.id]);
		// fresh copies, never the live tree: baseline, the mutant copy, then the repeat baseline after a kill (reviews K1, L1)
		expect(calls).toHaveLength(3);
		expect(calls.every(call => call.dir !== root)).toBe(true);
		expect(new Set(calls.map(call => call.dir)).size).toBe(3);
		expect(calls[2]?.source).toBe(SOURCE);
		expect(result.receipt.digest).toHaveLength(64);
		expect(calls[0]?.source).toBe(SOURCE);
		expect(calls[1]?.source).toBe(SOURCE.replace("n > max", "n >= max"));
		expect(readFileSync(join(root, "src/clamp.ts"), "utf8")).toBe(SOURCE);
	});
	it("P2: a plain error thrown from the test file itself counts as the test's own check", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([failing("caps", "Error: should have capped", { thrownInTest: true })]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("killed");
	});
	it("P5: a vitest snapshot mismatch is the test's own check (foreign round 2, esrap on vitest 2)", () => {
		expect(killedByOwnCheck(failing("x", "Error: Snapshot `x 1` mismatched"))).toBe(true);
		expect(killedByOwnCheck(failing("x", "Snapshot `x 1` mismatched"))).toBe(true);
	});
	it("P3: a `node:assert` failure thrown FROM the test file is still the test's check", () => {
		expect(killedByOwnCheck(failing("x", "AssertionError [ERR_ASSERTION]: out >= 0", { thrownInTest: true }))).toBe(true);
	});
	it("P6: `--vitest-config` (vitestConfig) is passed to every vitest run as --config and bound into the receipt; the one `scripts.test` names is the default", async () => {
		write("vitest.unit.config.ts", "export default {};\n");
		write("package.json", '{"name":"x","type":"module","scripts":{"test":"vitest run --config vitest.unit.config.ts"}}\n');
		git("add", ".");
		const { runner, calls } = fakeRunner(okRun([passing("caps")]), KILLED);
		const declared = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(calls.every(call => call.args.join(" ") === "--config vitest.unit.config.ts")).toBe(true);
		expect(declared.ok && declared.receipt.environment.config?.path).toBe("vitest.unit.config.ts");
		write("vitest.other.config.ts", "export default {};\n");
		const { runner: runner2, calls: calls2 } = fakeRunner(okRun([passing("caps")]), KILLED);
		const explicit = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: runner2, persist: false, vitestConfig: "vitest.other.config.ts" });
		expect(calls2[0]?.args).toEqual(["--config", "vitest.other.config.ts"]);
		expect(explicit.ok && explicit.receipt.environment.config?.path).toBe("vitest.other.config.ts");
		const missing = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: runner2, persist: false, vitestConfig: "nope.config.ts" });
		expect(!missing.ok && missing.reasons[0]).toBe("nope.config.ts does not exist");
	});
	it("P4: `./`-prefixed and absolute test paths normalize to repo-relative", () => {
		expect(normalizeTestPaths(root, [`./${TEST_FILE}`, join(root, TEST_FILE)])).toEqual([TEST_FILE]);
	});
});

describe("proveKill — negative (must not fire)", () => {
	it("N1: every case still passing is `survived`, never a kill", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([passing("caps")]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("survived");
		expect(result.ok && result.receipt.killedTests).toEqual([]);
	});
	it("N2: a crash under the mutant is inconclusive with its first failure line", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([failing("caps", "TypeError: clamp is not a function")]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		expect(result.ok && result.receipt.underMutant.cases[0]).toEqual({ test: `${TEST_FILE} › caps`, verdict: "inconclusive", reason: "TypeError: clamp is not a function" });
	});
	it("N3: a runner timeout under the mutant is inconclusive for every case", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), { cases: [], timedOut: true, error: "timed out after 1000 ms", exitCode: null, durationMs: 1000 });
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		expect(result.ok && result.receipt.underMutant.cases[0]?.reason).toBe("runner timed out after 1000 ms");
	});
	it("N4: a case that fails in the baseline copy for its own reason is not-passing-now; no mutant run, no receipt, no live run", async () => {
		const red = okRun([failing("caps", "AssertionError: x")]);
		const { runner, calls } = fakeRunner(red, red);
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(result).toMatchObject({ ok: false, verdict: "not-passing-now", reasons: [`${TEST_FILE} › caps: failed — AssertionError: x`] });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.dir).not.toBe(root);
		expect(readKillProofIndex(root).receipts).toEqual([]);
	});
	it("N16: a survivor whose tests never load the copy's file is unavailable, not survived (review N6/N7 canary)", async () => {
		const { runner, calls } = fakeRunner(okRun([passing("caps")]), okRun([passing("caps")]), okRun([passing("caps")]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toMatch(/do not load src\/clamp\.ts from the copy/);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.source).toMatch(/kill-proof canary/);
	});
	it("N13: a case that fails because the copy lacks an ignored fixture the live tree has is unavailable, decided without a live run (reviews K6, L8)", async () => {
		write("fixtures/case.json", "[]");
		write(".gitignore", "fixtures/\nnode_modules\n");
		const calls: string[] = [];
		const runner = async (dir: string): Promise<VitestRun> => {
			calls.push(dir);
			return okRun([failing("caps", `Error: ENOENT: no such file or directory, open '${join(dir, "fixtures/case.json")}'`)]);
		};
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toMatch(/the isolated git-visible copy lacks fixtures\/case\.json/);
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toBe(root);
	});
	it("N17: a kill that is not repeatable on an unmutated copy is inconclusive, never a kill (review L1)", async () => {
		const red = okRun([failing("caps", "AssertionError: marker already present")]);
		let seen = 0;
		const runner = async (dir: string): Promise<VitestRun> => {
			seen += 1;
			const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
			return seen === 1 ? okRun([passing("caps")]) : source === SOURCE ? red : red;
		};
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		expect(result.ok && result.receipt.underMutant.cases[0]?.reason).toMatch(/not repeatable/);
	});
	it("N14: a replacement that does not parse is inconclusive, never a kill (review K5)", async () => {
		const { runner, calls } = fakeRunner(okRun([passing("caps")]), KILLED);
		const result = await proveKill({ root, spec: { ...SPEC, replace: "n > ;" }, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		expect(result.ok && result.receipt.underMutant.error).toMatch(/does not parse/);
		expect(calls).toHaveLength(1);
	});
	it("N15: a --test directory or a test that resolves outside the project is unavailable (review K8b, K9)", async () => {
		const { runner } = fakeRunner(okRun([]), okRun([]));
		const dir = await proveKill({ root, spec: SPEC, tests: ["src"], budgetMs: 1000, runner });
		expect(!dir.ok && dir.reasons[0]).toBe("src is a directory; name test files");
		const outside = mkdtempSync(join(tmpdir(), "kill-proof-outside-"));
		writeFileSync(join(outside, "far.test.ts"), TEST);
		symlinkSync(join(outside, "far.test.ts"), join(root, "src/far.test.ts"));
		const linked = await proveKill({ root, spec: SPEC, tests: ["src/far.test.ts"], budgetMs: 1000, runner });
		expect(!linked.ok && linked.reasons[0]).toMatch(/resolves outside the project/);
		rmSync(outside, { recursive: true, force: true });
	});
	it("N5: a named test file that reports no executed case is unavailable, not a pass", async () => {
		const { runner } = fakeRunner(okRun([{ ...passing("caps"), status: "skipped" }]), okRun([]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(result).toMatchObject({ ok: false, verdict: "unavailable", reasons: [`${TEST_FILE} reported no executed test case in the baseline copy`] });
	});
	it("N6: an unresolvable mutant is unavailable and nothing runs", async () => {
		const { runner, calls } = fakeRunner(okRun([]), okRun([]));
		const result = await proveKill({ root, spec: { kind: "manifest", mutantId: "deadbeefdeadbeef" }, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(calls).toEqual([]);
	});
	it("N7: cases from files NOT named by --test are ignored even when vitest's substring filter runs them (review R1)", async () => {
		const foreign = failing("strong", "AssertionError: 1 ≠ 2", { file: "other/src/clamp.test.ts" });
		const { runner } = fakeRunner(okRun([passing("caps"), { ...foreign, status: "passed" }]), okRun([passing("caps"), foreign]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("survived");
		expect(result.ok && result.receipt.baseline.cases).toBe(1);
	});
	it("N8: a `node:assert` raised by PRODUCT code is not the test's check (review R4)", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([failing("caps", "AssertionError [ERR_ASSERTION]: out >= 0")]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
	});
	it("N9: a skipped case in the baseline is neither passing nor failing (review R14)", async () => {
		const { runner } = fakeRunner(okRun([passing("caps"), { ...passing("later"), status: "skipped" }]), KILLED);
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(result.ok && result.receipt.baseline.cases).toBe(1);
	});
	it("N10: a fixture or data file is not a proof target (review R5)", async () => {
		write("fixtures/data.json", '{"a": 1}\n');
		git("add", ".");
		const { runner, calls } = fakeRunner(okRun([]), okRun([]));
		const result = await proveKill({ root, spec: { kind: "explicit", file: "fixtures/data.json", find: '"a": 1', replace: '"a": 2' }, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(!result.ok && result.reasons[0]).toMatch(/not a JS\/TS source file/);
		expect(calls).toEqual([]);
	});
	it("N11: a project without vitest is unavailable and names the runner it declares", () => {
		write("package.json", '{"name":"x","devDependencies":{"jest":"^30.0.0"}}\n');
		expect(missingVitest(root)).toBe("vitest is not installed in this project (this project declares jest); v1 of prove-kill runs vitest only");
	});
	it("N12: killedTestFiles lists only files with a killed case", () => {
		expect(killedTestFiles([{ test: "a.test.ts › x", verdict: "killed" }, { test: "b.test.ts › y", verdict: "survived" }, { test: "a.test.ts › z", verdict: "killed" }])).toEqual(["a.test.ts"]);
	});
});

describe("receipt freshness — positive (must fire)", () => {
	it("P1: an untouched tree keeps the proof fresh and the Stop reader finds it", async () => {
		const receipt = await provenKill();
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
		expect(freshKillsForTest(root, TEST_FILE).map(row => row.id)).toEqual([receipt.id]);
	});
	it("P2: the index is rebuilt from the receipt files, so a lost index row is recovered (review R12)", async () => {
		const receipt = await provenKill();
		writeFileSync(join(root, ".interlinked/test-runs/kill-proofs/index.json"), '{"version":1,"receipts":[]}\n');
		expect(rebuildKillProofIndex(root).receipts.map(row => row.id)).toEqual([receipt.id]);
		writeKillProof(root, receipt);
		expect(readKillProofIndex(root).receipts.map(row => row.id)).toEqual([receipt.id]);
	});
});

describe("receipt freshness — negative (must not fire)", () => {
	it("N1: an edit to the source after the proof makes it stale", async () => {
		const receipt = await provenKill();
		write("src/clamp.ts", `${SOURCE}// later\n`);
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: ["source src/clamp.ts changed since the proof"] });
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
	it("N2: an edit to the test after the proof makes it stale", async () => {
		const receipt = await provenKill();
		write(TEST_FILE, `${TEST}\n`);
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: [`test ${TEST_FILE} changed since the proof`] });
	});
	it("N3: a `survived` receipt never satisfies the Stop reader", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([passing("caps")]));
		await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
	it("N4: a receipt file that does not match the shape reads as null", () => {
		expect(parseKillProof({ version: 1, id: "x" })).toBeNull();
		expect(parseKillProof({ version: 2 })).toBeNull();
	});
	it("N5: a hand-flipped verdict is stale: the id no longer re-derives and the cases disagree (review R7)", async () => {
		const receipt = await provenKill();
		const path = join(root, ".interlinked/test-runs/kill-proofs", `${receipt.id}.json`);
		const survivedReceipt = { ...receipt, verdict: "survived" as const };
		writeFileSync(path, JSON.stringify(survivedReceipt));
		const forged = { ...readKillProof(root, receipt.id)!, verdict: "killed" as const, underMutant: { ...receipt.underMutant, cases: [{ test: `${TEST_FILE} › caps`, verdict: "survived" as const }] } };
		writeFileSync(path, JSON.stringify(forged));
		const verdict = verifyKillProof(root, forged);
		expect(verdict.fresh).toBe(false);
		expect(!verdict.fresh && verdict.reasons).toContain("verdict disagrees with the recorded cases");
		expect(!verdict.fresh && verdict.reasons).toContain("receipt digest does not match its contents (edited receipt)");
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
	it("N9: a SURVIVED receipt edited consistently (cases, verdict, killedTests) is caught by the digest (review K3)", async () => {
		const { runner } = fakeRunner(okRun([passing("caps")]), okRun([passing("caps")]));
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
		if (!result.ok) throw new Error("expected a receipt");
		const forged = { ...result.receipt, verdict: "killed" as const, killedTests: [TEST_FILE], underMutant: { ...result.receipt.underMutant, cases: [{ test: `${TEST_FILE} › caps`, verdict: "killed" as const }] } };
		writeFileSync(join(root, ".interlinked/test-runs/kill-proofs", `${result.receipt.id}.json`), JSON.stringify(forged));
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
		const verdict = verifyKillProof(root, forged);
		expect(!verdict.fresh && verdict.reasons[0]).toMatch(/digest does not match/);
	});
	it("N10: an old strong case does not certify a NEW case that kills nothing (review K4)", async () => {
		const receipt = await provenKill();
		expect(freshKillsForTest(root, TEST_FILE, ["caps"]).map(r => r.id)).toEqual([receipt.id]);
		expect(freshKillsForTest(root, TEST_FILE, ["kills boundary"])).toEqual([]);
	});
	it("N6: a receipt copied from another checkout is stale (review R7)", async () => {
		const receipt = await provenKill();
		expect(verifyKillProof(join(root, "elsewhere"), receipt)).toMatchObject({ fresh: false });
	});
	it("N7: an index row with no receipt file is nothing (review R8)", async () => {
		const receipt = await provenKill();
		rmSync(join(root, ".interlinked/test-runs/kill-proofs", `${receipt.id}.json`));
		expect(readKillProofIndex(root).receipts).toHaveLength(1);
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
	it("N8: a receipt whose runtime changed is stale for the Stop reader too (review R9)", async () => {
		const receipt = await provenKill();
		const path = join(root, ".interlinked/test-runs/kill-proofs", `${receipt.id}.json`);
		writeFileSync(path, JSON.stringify({ ...receipt, environment: { ...receipt.environment, node: "v0.0.1" } }));
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
});
