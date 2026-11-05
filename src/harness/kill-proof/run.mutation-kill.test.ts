// Mutation-kill tests for kill-proof/run.ts — written from the 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md): each case pins an observable that an engine-shaped
// fault left unobserved by kill-proof.test.ts. Fake runner, real git fixture, no live vitest.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { killedByOwnCheck, mutantParses, proveKill } from "./run.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const TEST_FILE = "src/clamp.test.ts";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;

let root: string;
const git = (...args: string[]): void => { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); };
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-mk-")));
	git("init", "-q");
	write("src/clamp.ts", SOURCE);
	write(TEST_FILE, TEST);
	git("add", ".");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const passing = (name: string, file = TEST_FILE): Case => ({ file, name, title: name, status: "passed" });
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });

/** Answers by what the copy holds: unmutated → `baseline`, mutated → `mutated`, canary → every case fails. */
function fakeRunner(baseline: VitestRun, mutated: VitestRun) {
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		if (source.includes("kill-proof canary")) return okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: canary" })));
		return source === SOURCE ? baseline : mutated;
	};
}

describe("killedByOwnCheck — boundary of the snapshot-mismatch rule", () => {
	// test-contract: boundary - the snapshot rule is anchored to the message START; a crash whose text merely contains "Snapshot … mismatched" is still a crash
	it("a TypeError that mentions a snapshot mismatch mid-message is not the test's own check", () => {
		const row: Case = { file: TEST_FILE, name: "caps", title: "caps", status: "failed", message: "TypeError: Snapshot summary mismatched is not a function" };
		expect(killedByOwnCheck(row)).toBe(false);
		expect(killedByOwnCheck({ ...row, message: "Error: Snapshot `caps 1` mismatched" })).toBe(true);
		expect(killedByOwnCheck({ ...row, message: "Snapshot `caps 1` mismatched" })).toBe(true);
	});
});

describe("mutantParses — JSX in a non-JSX dialect", () => {
	// test-contract: invariant - JSX in a .js file is a compile error in that dialect, so the proof refuses to run it (review L6 / round 3 N12)
	it("refuses JSX written into a .js file and accepts it in .tsx", () => {
		const js = mutantParses("src/a.js", "export const a = <div />;\n");
		expect(js).not.toBeNull();
		expect(js?.ok).toBe(false);
		expect(js && !js.ok ? js.reason : "").toContain("contains JSX, which .js files cannot hold");
		expect(mutantParses("src/a.tsx", "export const a = <div />;\n")).toEqual({ ok: true });
	});
});

describe("judgeCases — a case without a pass or a kill under the mutant", () => {
	// test-contract: invariant - a case vitest skipped under the mutant is neither a pass nor a kill: inconclusive with the status as reason
	it("a case reported skipped under the mutant is inconclusive, never survived", async () => {
		const skipped = okRun([{ file: TEST_FILE, name: "caps", title: "caps", status: "skipped" }]);
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner(okRun([passing("caps")]), skipped), persist: false });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.verdict).toBe("inconclusive");
		expect(result.receipt.underMutant.cases).toEqual([{ test: `${TEST_FILE} › caps`, verdict: "inconclusive", reason: "skipped" }]);
	});
	// test-contract: invariant - a case that produced no result under the mutant is inconclusive ("no result under the mutant"), never survived
	it("a case absent from the mutant run is inconclusive with the no-result reason", async () => {
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner(okRun([passing("caps")]), okRun([])), persist: false });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.verdict).toBe("inconclusive");
		expect(result.receipt.underMutant.cases[0]).toEqual({ test: `${TEST_FILE} › caps`, verdict: "inconclusive", reason: "no result under the mutant" });
	});
});

describe("baseline problems — the reason names the actual failure", () => {
	// test-contract: public-api - a baseline runner timeout is reported as the timeout with its duration, not as a file with no executed case
	it("a timed-out baseline run is unavailable with the timeout named", async () => {
		const timedOut: VitestRun = { cases: [], timedOut: true, exitCode: null, durationMs: 1234 };
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner(timedOut, okRun([])), persist: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.verdict).toBe("unavailable");
		expect(result.reasons).toEqual(["baseline run timed out after 1234 ms; raise --run-timeout (default 300000)"]);
	});
	// test-contract: boundary - a baseline failure naming a file that is missing from the copy AND the live tree is the test's own problem (not-passing-now), not a copy gap
	it("a baseline failure on a file the live tree also lacks is not-passing-now", async () => {
		const failing = okRun([{ file: TEST_FILE, name: "caps", title: "caps", status: "failed", message: "Error: ENOENT: no such file or directory, open 'fixtures/absent.json'" }]);
		const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner(failing, okRun([])), persist: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.verdict).toBe("not-passing-now");
		expect(result.reasons[0]).toContain("fixtures/absent.json");
	});
});

describe("target problems — a test file is never a proof target", () => {
	// test-contract: public-api - mutating a test file is refused: a proof mutates product code, and the test is the oracle
	it("naming a test file as the mutated source is unavailable with the test-file reason", async () => {
		write("src/other.test.ts", "it('x', () => { expect(1 > 0).toBe(true); });\n");
		git("add", ".");
		const spec = { kind: "explicit", file: "src/other.test.ts", find: "1 > 0", replace: "1 < 0" } as const;
		const result = await proveKill({ root, spec, tests: [TEST_FILE], budgetMs: 1000, runner: fakeRunner(okRun([passing("caps")]), okRun([passing("caps")])), persist: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.verdict).toBe("unavailable");
		expect(result.reasons).toEqual(["src/other.test.ts is a test file; a proof mutates product code"]);
	});
});
