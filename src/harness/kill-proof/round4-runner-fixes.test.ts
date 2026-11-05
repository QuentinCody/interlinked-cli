// Kill proof — pins for the round-4 RUNNER fixes (docs/reviews/kill-proof-review-round4-runner.md,
// Resolution table). The review's own red cases live in review-regressions-round4-runner.test.ts;
// these pin the MECHANISM each fix relies on so a later refactor cannot remove it silently.
// Real-vitest fixtures are throwaway git repos; `node_modules` is a REAL directory of links to
// this checkout's entries, so anything a run writes under node_modules shows up in the fixture.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PRIVATE_VITEST_ARGS, runVitestDetailed, type VitestRun } from "../fail-before-fix/index.js";
import { allocatedBytes, createProjectCopy, gitVisibleFiles } from "../fail-before-fix/snapshot.js";
import { testsReachingByRelativeImport } from "./bound-imports.js";
import { COPY_BUDGET_BYTES, copySizeWarning, KILL_REPEATS, proveKill } from "./run.js";



const COMMENT_FAULT = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: "// helper: add 2 numbers" } as const;
const MINUS_FAULT = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;


const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const NODE_MODULES = join(CHECKOUT, "node_modules");
const REAL_RUN_MS = 120_000;
const roots: string[] = [];

function makeRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4fix-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	const all: Record<string, string> = {
		".gitignore": "node_modules\n.interlinked\n",
		"package.json": '{"name":"fx","type":"module"}\n',
		"vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n',
		"src/math.ts": "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text.replaceAll("<ROOT>", root));
	}
	// A real directory of links: a cache written to `<fixture>/node_modules/.vite` is visible HERE, not hidden in the checkout.
	mkdirSync(join(root, "node_modules"));
	for (const entry of readdirSync(NODE_MODULES)) symlinkSync(join(NODE_MODULES, entry), join(root, "node_modules", entry));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M2 — every vitest run is private: no results cache, a fresh tmpdir per run", () => {
	it("P1: the run passes --no-cache, points os.tmpdir() at a directory that is gone afterwards, and writes nothing under node_modules", async () => {
		const probe = 'import { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { writeFileSync("seen-tmpdir.txt", tmpdir()); expect(add(1, 2)).toBe(3); });\n';
		const root = makeRepo({ "test/probe.test.ts": probe });
		expect(PRIVATE_VITEST_ARGS).toContain("--no-cache");
		const before = readdirSync(join(root, "node_modules")).sort();
		const run = await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		expect(run.error).toBeUndefined();
		expect(run.cases.map(row => [row.name, row.status])).toEqual([["adds", "passed"]]);
		const seen = readFileSync(join(root, "seen-tmpdir.txt"), "utf8");
		expect(seen).not.toBe(tmpdir());
		expect(seen.startsWith(root)).toBe(false); // outside the project: a test asserting "tmp is not in-tree" still holds
		expect(existsSync(seen)).toBe(false); // removed with the run — nothing survives to the next one
		expect(readdirSync(join(root, "node_modules")).sort()).toEqual(before); // no `.vite` appeared
	}, REAL_RUN_MS);

	it("P2: two consecutive runs see two different tmpdirs (period-2 state through os.tmpdir() cannot line up with the mutant run)", async () => {
		const probe = 'import { appendFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { expect, it } from "vitest";\nit("records", () => { appendFileSync("tmpdirs.txt", tmpdir() + "\\n"); expect(1).toBe(1); });\n';
		const root = makeRepo({ "test/probe.test.ts": probe });
		await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		const lines = readFileSync(join(root, "tmpdirs.txt"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toBe(lines[1]);
	}, REAL_RUN_MS);
});

describe("M1 — a kill must survive TWO unmutated repeats (pass, FAIL, pass, pass)", () => {
	it("N1: period-2 state kept OUTSIDE tmpdir and the copies (an ignored path in the live tree) does not turn a comment-only mutant into a kill", async () => {
		// baseline n=0 pass, mutant n=1 FAIL (looks like a kill), repeat 1 n=2 pass, repeat 2 n=3 FAIL → not repeatable
		const test = [
			'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
			'import { expect, it } from "vitest";',
			'import { add } from "../src/math";',
			'const STATE = "<ROOT>/.interlinked/kp-counter"; // .interlinked is ignored: never copied, so it crosses every run',
			'it("adds", () => {',
			'\tmkdirSync("<ROOT>/.interlinked", { recursive: true });',
			'\tconst n = existsSync(STATE) ? Number(readFileSync(STATE, "utf8")) : 0;',
			'\twriteFileSync(STATE, String(n + 1));',
			'\texpect(add(1, 2)).toBe(3);',
			'\texpect(n % 2).toBe(0);',
			'});',
			'',
		].join("\n");
		const root = makeRepo({ "test/odd.test.ts": test });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/odd.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		expect(result.ok && result.receipt.underMutant.cases[0]?.reason).toMatch(/^not repeatable: .*repeat 2 of 2/);
		expect(readFileSync(join(root, ".interlinked/kp-counter"), "utf8")).toBe("4"); // baseline, mutant, repeat, repeat — four runs, none on the live tree's tests
	}, REAL_RUN_MS);

	it("P1: a real kill passes both repeats and is still KILLED after four runs", async () => {
		const root = makeRepo({ "test/adds.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n' });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/adds.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(KILL_REPEATS).toBe(2);
	}, REAL_RUN_MS);
});

// ---- M3/M4: the canary must show the TESTS load the copy's file ------------------------------------------
// Scripted runners answer by what the copy holds (the same convention as kill-proof.test.ts): the unmutated
// source → baseline, the mutated source → mutant, the canary source → `canary`, a canary copy whose test files
// are the CONTROL stand-ins → `control`.
type Case = VitestRun["cases"][number];
const ADDS_TEST = "test/adds.test.ts";
const pass = (file: string, name: string): Case => ({ file, name, title: name, status: "passed" });
const fail = (file: string, name: string, message = "Error: kill-proof canary (prove-kill): the tests must load this file from the copy"): Case => ({ file, name, title: name, status: "failed", message });
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const TIMED_OUT: VitestRun = { cases: [], timedOut: true, error: "timed out after 10 ms", exitCode: null, durationMs: 10 };
const SOURCE = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";

function scripted(baseline: VitestRun, mutated: VitestRun, canary: VitestRun, control: VitestRun) {
	const calls: { source: string; tests: string[] }[] = [];
	const runner = async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/math.ts"), "utf8");
		const tests = readdirSync(join(dir, "test")).map(name => readFileSync(join(dir, "test", name), "utf8"));
		calls.push({ source, tests });
		if (!source.includes("kill-proof canary")) return source === SOURCE ? baseline : mutated;
		return tests.every(text => text.includes("kill-proof control")) ? control : canary;
	};
	return { runner, calls };
}
const RELATIVE = 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\nit("typed", () => { expect(typeof add).toBe("function"); });\n';
const ABSOLUTE = 'import { expect, it } from "vitest";\nimport { add } from "<ROOT>/src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\nit("typed", () => { expect(typeof add).toBe("function"); });\n';
const BOTH_PASS = okRun([pass(ADDS_TEST, "adds"), pass(ADDS_TEST, "typed")]);
const BOTH_BROKEN = okRun([fail(ADDS_TEST, "adds"), fail(ADDS_TEST, "typed")]);
const CONTROL_OK = okRun([pass(ADDS_TEST, "kill-proof control (prove-kill): the environment alone must not fail this case")]);

describe("M3/M4 — canary per file, canary completion, and attribution to the tests", () => {
	it("N1: a canary run that times out is UNAVAILABLE with the did-not-complete reason, never survived (M4)", async () => {
		const root = makeRepo({ [ADDS_TEST]: RELATIVE });
		const { runner, calls } = scripted(BOTH_PASS, BOTH_PASS, TIMED_OUT, CONTROL_OK);
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toMatch(/^canary run did not complete; cannot show the tests load the copy/);
		expect(calls).toHaveLength(3);
	});
	it("N2: a canary that leaves ONE of a file's cases passing names it and is unavailable, not survived (M3, M11)", async () => {
		const root = makeRepo({ [ADDS_TEST]: RELATIVE });
		const { runner } = scripted(BOTH_PASS, BOTH_PASS, okRun([fail(ADDS_TEST, "adds"), pass(ADDS_TEST, "typed")]), CONTROL_OK);
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toContain("left 1 case(s) passing — test/adds.test.ts › typed");
	});
	it("N3: a test with no relative import whose canary break is ALSO produced by the control (a setup file loads the copy) is unavailable (M3)", async () => {
		const root = makeRepo({ [ADDS_TEST]: ABSOLUTE });
		const { runner, calls } = scripted(BOTH_PASS, BOTH_PASS, BOTH_BROKEN, okRun([])); // control: no rows — the setup file threw first
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toMatch(/through a setup file or the config, not through test\/adds\.test\.ts/);
		expect(calls).toHaveLength(4);
		expect(calls[3]?.tests.every(text => text.includes("kill-proof control"))).toBe(true);
	});
	it("N4: a control run that does not complete is unavailable, never survived (M4)", async () => {
		const root = makeRepo({ [ADDS_TEST]: ABSOLUTE });
		const { runner } = scripted(BOTH_PASS, BOTH_PASS, BOTH_BROKEN, TIMED_OUT);
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(!result.ok && result.verdict).toBe("unavailable");
		expect(!result.ok && result.reasons[0]).toMatch(/^canary run did not complete.*control run/);
	});
	it("P1: a test that reaches the file by a relative import needs no control run — three runs, SURVIVED", async () => {
		const root = makeRepo({ [ADDS_TEST]: RELATIVE });
		const { runner, calls } = scripted(BOTH_PASS, BOTH_PASS, BOTH_BROKEN, okRun([]));
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("survived");
		expect(calls).toHaveLength(3);
	});
	it("P2: a test with a dynamic (non-relative-static) route whose control passes is SURVIVED after the fourth run", async () => {
		const root = makeRepo({ [ADDS_TEST]: ABSOLUTE });
		const { runner, calls } = scripted(BOTH_PASS, BOTH_PASS, BOTH_BROKEN, CONTROL_OK);
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("survived");
		expect(calls).toHaveLength(4);
	});
	it("P3: testsReachingByRelativeImport follows relative static imports through helpers and ignores absolute ones", () => {
		const root = makeRepo({
			"test/via-helper.test.ts": 'import { helper } from "./helper";\nit("x", () => helper());\n',
			"test/helper.ts": 'import { add } from "../src/math";\nexport const helper = () => add(1, 2);\n',
			"test/abs.test.ts": ABSOLUTE,
		});
		const reaching = testsReachingByRelativeImport(root, ["test/via-helper.test.ts", "test/abs.test.ts"], "src/math.ts");
		expect([...reaching]).toEqual(["test/via-helper.test.ts"]);
	});
});

describe("M10 — the git-visible copy has a size budget; over it the proof WARNS, never blocks", () => {
	it("P1: the warning names the size in MiB above 256 MiB and is silent at or below it", () => {
		expect(COPY_BUDGET_BYTES).toBe(256 * 1024 * 1024);
		expect(copySizeWarning(COPY_BUDGET_BYTES)).toBeNull();
		expect(copySizeWarning(COPY_BUDGET_BYTES + 1)).toBe("[interlinked:kill-proof] copy is 256 MiB; large tracked files slow every proof");
		expect(copySizeWarning(400 * 1024 * 1024)).toBe("[interlinked:kill-proof] copy is 400 MiB; large tracked files slow every proof");
	});
	it("P2: createProjectCopy reports the regular-file bytes it copied (links and overrides excluded) — allocated blocks since round 5 (R5-12)", () => {
		const root = makeRepo({ "data/big.bin": "x".repeat(10_000) });
		const files = gitVisibleFiles(root) ?? [];
		const expected = files.reduce((sum, rel) => sum + allocatedBytes(statSync(join(root, rel))), 0);
		const copy = createProjectCopy(root, files, new Map([["src/math.ts", "replaced\n"]]));
		try {
			expect(copy.bytes).toBe(expected);
			expect(copy.bytes).toBeGreaterThan(10_000);
		} finally { copy.cleanup(); }
	});
	it("P3: a small repository's result carries no warnings; a scripted proof is unchanged by the budget", async () => {
		const root = makeRepo({ [ADDS_TEST]: RELATIVE });
		const { runner } = scripted(BOTH_PASS, okRun([fail(ADDS_TEST, "adds", "AssertionError: expected -1 to be 3"), pass(ADDS_TEST, "typed")]), BOTH_BROKEN, CONTROL_OK);
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [ADDS_TEST], budgetMs: 1000, runner, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect("warnings" in result).toBe(false);
	});
});
