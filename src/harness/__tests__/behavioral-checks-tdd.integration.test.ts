import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkAssertionDensity,
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTddCycleViolation,
	checkTddRegression,
	checkTppLeapfrog,
	countAssertions,
	gitNumstatDelta,
} from "../behavioral-checks-tdd.js";
import type { SessionTrajectory, TddCycle } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Fixed, deterministic timestamps. Session start is 60s before "now";
// last_coordination is "now". Values are arbitrary but stable.
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_SESSION_STARTED_AT,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		...overrides,
	};
}

// ===========================================
// 6. checkProdDeltaWithoutTestDelta (git commit gate)
// ===========================================

describe("checkProdDeltaWithoutTestDelta", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prod-delta-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags prod file edited with existing but un-edited test file", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([prodFile]) });
		const results = checkProdDeltaWithoutTestDelta(session);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("prod_delta_no_test_delta");
	});

	it("passes when prod and test are both edited", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([prodFile, testFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("ignores prod files with no corresponding test on disk", () => {
		const prodFile = join(dir, "bar.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		const session = makeSession({ files_written: new Set([prodFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("ignores test files themselves", () => {
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([testFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("suppresses when an edited test references a symbol the source EXPORTS (barrel coverage)", () => {
		// The prod file is exercised by a test that imports it via a BARREL: the
		// edited test carries the source's exported symbol (`evaluateThing`) but
		// NOT the source basename in its import path, so the basename match misses
		// it. This is the pre-tool.ts ← evaluator-files.test.ts (via the evaluator
		// barrel + `evaluatePreToolUse`) false positive.
		const prodFile = join(dir, "thing.ts");
		const siblingTest = join(dir, "thing.test.ts"); // exists → the check proceeds
		const barrelTest = join(dir, "feature.test.ts"); // the test we actually edited
		writeFileSync(prodFile, "export function evaluateThing() {\n\treturn 1;\n}\n");
		writeFileSync(siblingTest, "it('placeholder', () => {});\n");
		writeFileSync(
			barrelTest,
			"import { evaluateThing } from './barrel.js';\nit('covers it', () => {\n\tevaluateThing();\n});\n",
		);
		const session = makeSession({ files_written: new Set([prodFile, barrelTest]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("still flags when the edited test references neither the basename nor an export", () => {
		const prodFile = join(dir, "widget.ts");
		const siblingTest = join(dir, "widget.test.ts");
		const unrelatedTest = join(dir, "unrelated.test.ts");
		writeFileSync(prodFile, "export function renderWidget() {\n\treturn 1;\n}\n");
		writeFileSync(siblingTest, "it('placeholder', () => {});\n");
		writeFileSync(unrelatedTest, "it('something else', () => {\n\texpect(1).toBe(1);\n});\n");
		const session = makeSession({ files_written: new Set([prodFile, unrelatedTest]) });
		const results = checkProdDeltaWithoutTestDelta(session);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("prod_delta_no_test_delta");
	});
});

// ===========================================
// 7. checkProdTestLocRatio (git commit gate)
// ===========================================

describe("checkProdTestLocRatio", () => {
	// Delta-LOC based: pass a stub `getDelta` so tests don't depend on
	// the working-tree git state. The contract is "ratio of touched-line
	// counts," not "ratio of file-size totals."

	it("warns when prod-delta / test-delta exceeds 5:1", () => {
		const session = makeSession({ files_written: new Set() });
		const results = checkProdTestLocRatio(session, () => ({ prodLoc: 60, testLoc: 10 }));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toMatch(/6\.0:1/);
	});

	it("passes when ratio is healthy", () => {
		const session = makeSession({ files_written: new Set() });
		expect(
			checkProdTestLocRatio(session, () => ({ prodLoc: 30, testLoc: 20 })),
		).toEqual([]);
	});

	it("warns when prod-delta exists but no test-delta", () => {
		const session = makeSession({ files_written: new Set() });
		const results = checkProdTestLocRatio(session, () => ({ prodLoc: 30, testLoc: 0 }));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toMatch(/no tests written/);
	});

	it("is silent when delta is zero", () => {
		const session = makeSession({ files_written: new Set() });
		expect(checkProdTestLocRatio(session, () => ({ prodLoc: 0, testLoc: 0 }))).toEqual([]);
	});

	it("is silent under the limit even when prod is large (delta-aware)", () => {
		// The previous file-total implementation would have fired here
		// because session.files_written includes a 1000-line file. Delta
		// semantics: only a small change was actually made.
		const dir = mkdtempSync(join(tmpdir(), "loc-ratio-delta-"));
		const huge = join(dir, "huge.ts");
		writeFileSync(huge, "a\n".repeat(1000));
		const test = join(dir, "tiny.test.ts");
		writeFileSync(test, "a\n".repeat(5));
		const session = makeSession({ files_written: new Set([huge, test]) });
		try {
			expect(
				checkProdTestLocRatio(session, () => ({ prodLoc: 4, testLoc: 5 })),
			).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================
// 8. checkTppLeapfrog (git diff based)
// ===========================================

function initGitRepo(dir: string): void {
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.email test@example.com", { cwd: dir });
	execSync("git config user.name test", { cwd: dir });
}

function commitInitial(dir: string, file: string, content: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file}`, { cwd: dir });
	execSync('git commit -q -m "initial"', { cwd: dir });
}

function stageUpdate(dir: string, file: string, content: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file}`, { cwd: dir });
}

describe("checkTppLeapfrog", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tpp-"));
		initGitRepo(dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags commit adding ≥2 heavy constructs without a TDD cycle", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	const out = [];
	for (const i of items) {
		while (i > 0) { out.push(i); }
	}
	return out;
}
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("tpp_leapfrog");
		expect(nonNull(results[0]).severity).toBe("info");
	});

	it("does not flag when only one heavy construct was added", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	for (const i of items) { console.log(i); }
}
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("suppresses when a disciplined red→green TDD cycle occurred", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export class Widget {
	constructor() {}
	run() { while (true) break; for (;;) break; }
}
`,
		);
		const cycle: TddCycle = {
			source_file: abs,
			test_file: join(dir, "foo.test.ts"),
			state: "green",
			red_at: 3,
			green_at: 5,
			impl_edits_before_test: 0,
			previous_state: "red",
		};
		const session = makeSession({
			files_written: new Set([abs]),
			tdd_cycles: new Map([[abs, cycle]]),
		});
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("ignores test files", () => {
		const file = "foo.test.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "it('x', () => {});\n");
		stageUpdate(
			dir,
			file,
			`it('x', () => {
	for (const a of xs) { while (a > 0) { break; } }
	class C {}
});
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("is silent on a file with no staged/unstaged diff at all", () => {
		const file = "untouched.ts";
		commitInitial(dir, file, "export const x = 1;\n");
		// No stageUpdate — getStagedDiff returns "" for both diff attempts.
		const abs = join(dir, file);
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("is silent when the diff exists but adds no lines (deletion-only change)", () => {
		const file = "shrink.ts";
		const abs = join(dir, file);
		commitInitial(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	for (const i of items) { while (i > 0) { break; } }
}
`,
		);
		// Pure removal — no "+"-prefixed content lines, only "-" lines.
		stageUpdate(dir, file, "export const x = 1;\n");
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("uses the multiplied label when the SAME heavy construct appears more than once", () => {
		const file = "repeat.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	for (const i of items) { console.log(i); }
	for (const j of items) { console.log(j); }
	switch (items.length) { case 0: break; default: break; }
}
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("2× for loop");
	});
});

// ===========================================
// checkAssertionDensity (Plan 09 Phase 1)
// ===========================================

describe("checkAssertionDensity", () => {
	const TEST_FILE = "/r/src/foo.test.ts";
	const SOURCE_FILE = "/r/src/foo.ts";

	it("is silent on first sight of any test file (silent baseline)", () => {
		const session = makeSession();
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			"it('a', () => {});\n",
		);
		// First visit must not fire — even if the file has zero assertions —
		// because we cannot distinguish "agent just wrote this" from "agent
		// touched a pre-existing assertion-free test."
		expect(result).toBeNull();
		// And it MUST have stored the baseline so the next call sees `before`.
		expect(session.assertion_counts.get(TEST_FILE)).toEqual({
			blocks: 1,
			assertions: 0,
		});
	});

	it("stays silent when blocks and assertions both grow", () => {
		const session = makeSession();
		// First sight establishes baseline
		checkAssertionDensity(session, TEST_FILE, "it('a', () => { expect(1).toBe(1); });\n");
		// Second edit: +2 blocks, +2 expects
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			`it('a', () => { expect(1).toBe(1); });
it('b', () => { expect(2).toBe(2); });
it('c', () => { expect(3).toBe(3); });
`,
		);
		expect(result).toBeNull();
	});

	it("fires when blocks grow but assertions stay flat", () => {
		const session = makeSession();
		checkAssertionDensity(session, TEST_FILE, "it('a', () => { expect(1).toBe(1); });\n");
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			`it('a', () => { expect(1).toBe(1); });
it('b', () => { /* TODO */ });
it('c', () => { /* TODO */ });
`,
		);
		expect(result).not.toBeNull();
		expect(result?.name).toBe("assertion_density");
		expect(result?.severity).toBe("warning");
		expect(result?.determinism).toBe("heuristic");
		expect(result?.message).toContain("2 test block(s)");
		expect(result?.message).toContain("0 new assertions");
	});

	it("fires when assertions are removed even if blocks are added", () => {
		const session = makeSession();
		checkAssertionDensity(
			session,
			TEST_FILE,
			`it('a', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); });\n`,
		);
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			`it('a', () => { expect(1).toBe(1); });
it('b', () => {});
`,
		);
		expect(result).not.toBeNull();
		// 3 → 1 = -2 fewer assertions; 1 → 2 = +1 block. dBlocks=1, dAssertions=-2.
		expect(result?.message).toContain("1 test block(s)");
		expect(result?.message).toContain("2 fewer assertions");
	});

	it("stays silent when only assertions are added", () => {
		const session = makeSession();
		checkAssertionDensity(session, TEST_FILE, "it('a', () => { expect(1).toBe(1); });\n");
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			`it('a', () => {
	expect(1).toBe(1);
	expect(2).toBe(2);
	expect(3).toBe(3);
});
`,
		);
		expect(result).toBeNull();
	});

	it("never fires on non-test source files", () => {
		const session = makeSession();
		// Even with zero assertions and many `function` blocks, source files
		// are out of scope.
		expect(checkAssertionDensity(session, SOURCE_FILE, "function a(){}\nfunction b(){}\n"))
			.toBeNull();
		expect(checkAssertionDensity(session, SOURCE_FILE, "function a(){}\nfunction b(){}\n"))
			.toBeNull();
		// Source files are not even baselined — assertion_counts must stay empty.
		expect(session.assertion_counts.size).toBe(0);
	});

	it("honors the // interlinked-tdd: exempt directive", () => {
		const session = makeSession();
		const exempt = `// interlinked-tdd: exempt
it('a', () => {});
it('b', () => {});
`;
		// First call baselines (still silent because first sight)
		expect(checkAssertionDensity(session, TEST_FILE, exempt)).toBeNull();
		// Even on the second visit with an obvious "blocks grew, no expects"
		// pattern, the directive opts out.
		const second = exempt + "\nit('c', () => {});\nit('d', () => {});\n";
		expect(checkAssertionDensity(session, TEST_FILE, second)).toBeNull();
	});

	it("counts node:assert named imports correctly", () => {
		// `strictEqual` is bare-name FP-prone, so the detector only credits
		// it when imported from `node:assert`.
		const withImport = `import { strictEqual, deepStrictEqual } from "node:assert";
it('a', () => { strictEqual(1, 1); deepStrictEqual({}, {}); });
`;
		expect(countAssertions(withImport)).toEqual({ blocks: 1, assertions: 2 });

		// Without the import, identically-named calls don't count.
		const withoutImport = `it('a', () => { strictEqual(1, 1); deepStrictEqual({}, {}); });\n`;
		expect(countAssertions(withoutImport)).toEqual({ blocks: 1, assertions: 0 });
	});

	it("counts chai.assert.* and snapshot matchers", () => {
		// `chai.assert.X(` matches once (the alternation prefers `chai\.assert`
		// at position 0 of `chai`). `expect(x).toMatchSnapshot()` matches
		// twice (both `expect(` and `toMatchSnapshot(` independently fire) —
		// the over-count is by design: it cancels out across pre/post deltas.
		const content = `it('a', () => {
	chai.assert.equal(1, 1);
	chai.assert.deepEqual([], []);
	expect(snap).toMatchSnapshot();
	expect(snap2).toMatchInlineSnapshot();
});
`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 6 });
	});

	it("counts data-driven test variants (.each, .skip, .only, etc.) as blocks", () => {
		const content = `
it('plain', () => {});
it.skip('skipped', () => {});
it.only('only', () => {});
it.concurrent('conc', () => {});
test.each([1, 2, 3])('table %i', (n) => {});
test.each\`${1} | ${2}\`('tagged %i', (n) => {});
it.todo('todo');
`;
		const counts = countAssertions(content);
		// 7 blocks total, 0 assertions.
		expect(counts.blocks).toBe(7);
		expect(counts.assertions).toBe(0);
	});

	it("counts should-style assertion chains", () => {
		const content = `
it('a', () => {
	result.should.equal(1);
	should(result).equal(1);
});
`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 2 });
	});

	it("ignores expect( inside comments and strings", () => {
		const content = `
it('a', () => {
	// expect(1).toBe(1)  -- in a comment, must not count
	const s = "expect(stub).toBe(1)"; // string literal, must not count
	expect(2).toBe(2);
});
`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 1 });
	});

	it("counts standalone describe() as zero blocks", () => {
		const content = `describe('outer', () => { /* no it() */ });\n`;
		expect(countAssertions(content)).toEqual({ blocks: 0, assertions: 0 });
	});

	it("does not fire on the second edit when blocks didn't grow", () => {
		const session = makeSession();
		checkAssertionDensity(
			session,
			TEST_FILE,
			"it('a', () => {});\nit('b', () => {});\n",
		);
		// Same number of blocks, still no assertions — but no growth ⇒ no fire.
		const result = checkAssertionDensity(
			session,
			TEST_FILE,
			"it('a', () => {});\nit('b', () => {});\n",
		);
		expect(result).toBeNull();
	});

	it("handles common test-file path conventions", () => {
		const session = makeSession();
		// First-sight behavior confirms the path regex matches: a populated
		// `assertion_counts` entry means the file passed the gate. The shared
		// TEST_FILE_RE requires a leading slash before `tests/`, so a repo
		// using top-level `tests/` (no leading slash) is not currently
		// recognized — that gap is shared with other behavioral checks and
		// out of scope for Phase 1.
		const recognized = [
			"src/foo.test.ts",
			"src/foo.spec.ts",
			"src/__tests__/foo.ts",
			"/repo/tests/foo.ts",
		];
		for (const p of recognized) {
			expect(checkAssertionDensity(session, p, "it('x', () => {});\n")).toBeNull();
			expect(session.assertion_counts.has(p)).toBe(true);
		}
	});
});

// ===========================================
// FP-fix regression: tdd_commit_gate disk-awareness
// ===========================================

// ===========================================
// Suite-wide red must not be attributed to individual files
// ===========================================
//
// Regression for a real block (2026-07-26): ONE failing whole-suite run fanned
// out through recordTestRunCycle's ALL_TESTS_SENTINEL branch and reddened 16
// unrelated files at the same step. Because a later suite green is never
// recorded when the run's outcome is unproven, every one of those files stayed
// permanently uncommittable on evidence that never implicated them.

describe("checkTddCommitGate — whole-suite red is not per-file evidence", () => {
	const SUITE = "__all_tests__";
	const SRC = "/repo/src/thing.ts";
	const TEST = "/repo/src/thing.test.ts";

	function sessionWithSuiteRed(over: Partial<TddCycle> = {}): SessionTrajectory {
		const s = makeSession({ tool_call_count: 146 });
		s.test_runs.set(SUITE, { status: "fail", at_step: 99 });
		s.tdd_cycles.set(SRC, {
			source_file: SRC,
			test_file: TEST,
			state: "red",
			red_at: 99,
			impl_edits_before_test: 0,
			...over,
		});
		return s;
	}

	it("N1: does NOT block a commit when the red came from the suite fan-out", () => {
		const results = checkTddCommitGate(sessionWithSuiteRed(), "enforce");
		const gate = results.filter((r) => r.name === "tdd_commit_gate");
		expect(gate).toHaveLength(1);
		expect(gate[0]?.severity).toBe("warning");
	});

	it("N2: says the failure is not attributed to the file", () => {
		const gate = checkTddCommitGate(sessionWithSuiteRed(), "enforce")[0];
		expect(gate?.message).toMatch(/not attributed to this file/);
	});

	it("N3: applies to a regression state from the same fan-out", () => {
		const s = sessionWithSuiteRed({ state: "regression" });
		expect(checkTddCommitGate(s, "enforce")[0]?.severity).toBe("warning");
	});

	it("P1: STILL blocks when a targeted run for the file's own tests went red", () => {
		// Sound per-file evidence overrides the fan-out attribution.
		const s = sessionWithSuiteRed();
		s.test_runs.set(TEST, { status: "fail", at_step: 99 });
		const gate = checkTddCommitGate(s, "enforce")[0];
		expect(gate?.severity).toBe("error");
		expect(gate?.message).toMatch(/Tests are FAILING/);
	});

	it("P2: STILL blocks when the red predates the suite run", () => {
		// A red at a different step was not produced by this fan-out.
		//
		// red_at moved 40 -> 140 when the staleness downgrade landed: against
		// this fixture's tool_call_count of 146, a red at step 40 is 106 tool
		// calls old and is now softened for AGE, which would make this case pass
		// for the wrong reason. 140 keeps it "a different step from the suite
		// run" — the property under test — while staying recent.
		const s = sessionWithSuiteRed({ red_at: 140 });
		expect(checkTddCommitGate(s, "enforce")[0]?.severity).toBe("error");
	});

	// A2 — a red nobody has re-measured in a long time is not evidence about
	// the current tree. It kept blocking commits for hours against a green
	// suite (2026-07-26), so past the window it asks for a re-run instead.
	it("A2: downgrades to a warning once the red is stale, and says why", () => {
		const s = sessionWithSuiteRed({ red_at: 40 });
		s.test_runs.delete(SUITE); // isolate age from suite attribution
		const gate = checkTddCommitGate(s, "enforce")[0];
		expect(gate?.severity).toBe("warning");
		expect(gate?.message).toMatch(/no longer evidence about the current tree/);
		expect(gate?.message).toMatch(/106 tool calls ago/);
	});

	it("A2: still blocks a red that was observed recently", () => {
		const s = sessionWithSuiteRed({ red_at: 140 });
		s.test_runs.delete(SUITE);
		const gate = checkTddCommitGate(s, "enforce")[0];
		expect(gate?.severity).toBe("error");
		expect(gate?.message).toMatch(/Tests are FAILING/);
		expect(gate?.message).not.toMatch(/no longer evidence about the current tree/);
	});

	it("P3: STILL blocks when the recorded suite run PASSED", () => {
		const s = sessionWithSuiteRed();
		s.test_runs.set(SUITE, { status: "pass", at_step: 99 });
		expect(checkTddCommitGate(s, "enforce")[0]?.severity).toBe("error");
	});

	it("P4: STILL blocks when no suite run was recorded at all", () => {
		const s = sessionWithSuiteRed();
		s.test_runs.delete(SUITE);
		expect(checkTddCommitGate(s, "enforce")[0]?.severity).toBe("error");
	});

	it("does not silence the finding — it still reports, at lower severity", () => {
		const results = checkTddCommitGate(sessionWithSuiteRed(), "enforce");
		expect(results.some((r) => r.name === "tdd_commit_gate" && r.file === SRC)).toBe(true);
	});
});

describe("checkTddCommitGate — disk reality check", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tdd-gate-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does NOT fire when state='no_test' but a test file exists on disk", () => {
		// Reproduces the FP we hit: write test file first (red), then impl,
		// then test run sets state=green; but a harness restart or path
		// hydration gap can leave the cycle marooned at "no_test" with
		// impl_edits>0. Disk-truth wins: tests exist, no warning.
		const sourceFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(sourceFile, "export const x = 1;\n");
		writeFileSync(testFile, "it('x', () => {});\n");

		const cycle: TddCycle = {
			source_file: sourceFile,
			test_file: testFile,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([sourceFile]),
			tdd_cycles: new Map([[sourceFile, cycle]]),
		});

		const out = checkTddCommitGate(session, "warn");
		expect(out).toEqual([]);
	});

	it("STILL fires when state='no_test' and no test file exists anywhere", () => {
		const sourceFile = join(dir, "bar.ts");
		writeFileSync(sourceFile, "export const x = 1;\n");

		const cycle: TddCycle = {
			source_file: sourceFile,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([sourceFile]),
			tdd_cycles: new Map([[sourceFile, cycle]]),
		});

		const out = checkTddCommitGate(session, "warn");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).name).toBe("tdd_commit_gate");
	});
});

// ===========================================
// FP-fix regression: tdd_commit_gate exempt-path / non-source / deleted
// ===========================================
//
// Captures the false-positives observed on the 2026-05-26 commit of the
// audit-chain landing: a transient `.interlinked/*.patch` file the agent
// wrote and deleted in the same session tripped the gate (gitignored
// path + non-source extension), as did a metadata-only edit to a file
// whose own tests aren't conventionally named. These checks now share
// the same exemption surface as the in-edit TDD checks.

describe("checkTddCommitGate — exemption surface (post-2026-05 refinement)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tdd-gate-exempt-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does NOT fire on a non-source-extension file (.patch)", () => {
		const patchFile = join(dir, "fix.patch");
		writeFileSync(patchFile, "diff --git a/x b/x\n");

		const cycle: TddCycle = {
			source_file: patchFile,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([patchFile]),
			tdd_cycles: new Map([[patchFile, cycle]]),
		});

		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("does NOT fire on a file under .interlinked/ (gitignored)", () => {
		const ilDir = join(dir, ".interlinked");
		const stagedPatch = join(ilDir, "stage.patch");
		// Create the file so existsSync passes — the exempt-path check is
		// what we want to verify here, not the missing-file shortcut.
		writeFileSync(join(dir, ".gitkeep"), ""); // mkdir-equivalent
		execSync(`mkdir -p ${ilDir}`);
		writeFileSync(stagedPatch, "diff");

		const cycle: TddCycle = {
			source_file: stagedPatch,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([stagedPatch]),
			tdd_cycles: new Map([[stagedPatch, cycle]]),
		});

		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("does NOT fire on a .ts file under an exempt path (.interlinked/)", () => {
		// .ts file passes the extension filter, exempt path filter drops it.
		const ilDir = join(dir, ".interlinked");
		execSync(`mkdir -p ${ilDir}`);
		const tsInInterlinked = join(ilDir, "scratch.ts");
		writeFileSync(tsInInterlinked, "export const x = 1;\n");

		const cycle: TddCycle = {
			source_file: tsInInterlinked,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([tsInInterlinked]),
			tdd_cycles: new Map([[tsInInterlinked, cycle]]),
		});

		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("does NOT fire on a file that no longer exists on disk (deleted in same session)", () => {
		// Path that was Written earlier in the session but is gone now —
		// covers the transient-file case. The cycle still has impl_edits>0
		// because recordImplEdit ran on the Write event.
		const deleted = join(dir, "ephemeral.ts");
		// Note: NOT writing the file — simulating post-delete state.

		const cycle: TddCycle = {
			source_file: deleted,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([deleted]),
			tdd_cycles: new Map([[deleted, cycle]]),
		});

		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("STILL fires on a real source file with no test and no exemption", () => {
		// Belt-and-suspenders: the refinements don't widen the exemption
		// surface beyond what's intended.
		const sourceFile = join(dir, "src", "real.ts");
		execSync(`mkdir -p ${join(dir, "src")}`);
		writeFileSync(sourceFile, "export function real() { return 1; }\n");

		const cycle: TddCycle = {
			source_file: sourceFile,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([sourceFile]),
			tdd_cycles: new Map([[sourceFile, cycle]]),
		});

		const out = checkTddCommitGate(session, "warn");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).name).toBe("tdd_commit_gate");
	});
});

// ===========================================
// FP-fix regression: prod_delta_no_test_delta sibling-test detection
// ===========================================

describe("checkProdDeltaWithoutTestDelta — sibling-test detection", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prod-delta-sibling-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does NOT fire when a non-conventionally-named test edited this session imports the source", () => {
		// Real-world shape: src/foo/multi-impl.ts has tests in
		// __tests__/specific-feature.test.ts (not multi-impl.test.ts).
		// The conventional-name gate would FP; sibling detection rescues it.
		const sourceFile = join(dir, "multi-impl.ts");
		const conventionalTest = join(dir, "multi-impl.test.ts");
		const siblingTest = join(dir, "specific-feature.test.ts");
		writeFileSync(sourceFile, "export const x = 1;\n");
		writeFileSync(conventionalTest, "// stub\n");
		writeFileSync(siblingTest, 'import { x } from "./multi-impl.js";\n');

		const session = makeSession({
			files_written: new Set([sourceFile, siblingTest]),
		});
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("STILL fires when no edited test references the source", () => {
		const sourceFile = join(dir, "alone.ts");
		const conventionalTest = join(dir, "alone.test.ts");
		const unrelatedTest = join(dir, "other.test.ts");
		writeFileSync(sourceFile, "export const x = 1;\n");
		writeFileSync(conventionalTest, "// stub\n");
		writeFileSync(unrelatedTest, 'import { y } from "./other.js";\n');

		const session = makeSession({
			files_written: new Set([sourceFile, unrelatedTest]),
		});
		const out = checkProdDeltaWithoutTestDelta(session);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).name).toBe("prod_delta_no_test_delta");
	});

	it("still fires (does not throw) when the source file itself no longer exists on disk", () => {
		// exportedSymbolsOf(sourceFile) tries to read the SOURCE file (not the
		// test) — a source that vanished mid-session must fall through its
		// catch to an empty symbol list rather than throwing, and the
		// prod-delta finding still fires since nothing rescues it.
		const ghostSource = join(dir, "ghost.ts");
		const ghostTest = join(dir, "ghost.test.ts"); // exists, found by findTestFilePath
		writeFileSync(ghostTest, "it('x', () => {});\n");
		// ghostSource intentionally never written.
		const session = makeSession({ files_written: new Set([ghostSource]) });
		const out = checkProdDeltaWithoutTestDelta(session);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).name).toBe("prod_delta_no_test_delta");
	});

	it("rescues via an `export { a, b as c }` re-export list referenced by a barrel test", () => {
		// Exercises exportedSymbolsOf's list-export loop (distinct from the
		// `export function NAME` regex path): the source only re-exports
		// names via a list, and the aliased name `renamedThing` is what the
		// barrel test actually references.
		const sourceFile = join(dir, "reexport.ts");
		const siblingTest = join(dir, "reexport.test.ts");
		const barrelTest = join(dir, "consumer.test.ts");
		writeFileSync(
			sourceFile,
			// A trailing empty segment (double comma) and an invalid identifier
			// specifier are both skipped by the list-export loop's `if (exported
			// && /^[A-Za-z_$][\w$]*$/.test(exported))` guard — neither should
			// throw or wrongly register, while the two valid specifiers still do.
			"const internalThing = () => 1;\nexport { internalThing as renamedThing, , 123bad, internalThing };\n",
		);
		writeFileSync(siblingTest, "it('placeholder', () => {});\n");
		writeFileSync(
			barrelTest,
			"import { renamedThing } from './barrel.js';\nit('covers it', () => {\n\trenamedThing();\n});\n",
		);
		const session = makeSession({ files_written: new Set([sourceFile, barrelTest]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});
});

// ===========================================
// gitNumstatDelta — covers tracked + untracked files
// ===========================================

describe("gitNumstatDelta", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "numstat-"));
		execSync("git init -q", { cwd: dir });
		execSync("git config user.email t@example.com", { cwd: dir });
		execSync("git config user.name Test", { cwd: dir });
		execSync("git commit --allow-empty -q -m initial", { cwd: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("counts untracked new files as full LOC (tests + prod each routed)", () => {
		writeFileSync(join(dir, "new-prod.ts"), "a\n".repeat(40));
		writeFileSync(join(dir, "new-prod.test.ts"), "a\n".repeat(20));

		// Note: split("\n") on "a\n".repeat(N) returns N+1 entries (trailing
		// empty string after the final newline). The check counts split-length,
		// not actual lines, which matches what numstat reports for tracked files.
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(41);
		expect(testLoc).toBe(21);
	});

	it("counts tracked modifications via numstat (added + deleted)", () => {
		const tracked = join(dir, "tracked.ts");
		writeFileSync(tracked, "a\nb\nc\n");
		execSync("git add tracked.ts", { cwd: dir });
		execSync("git commit -q -m base", { cwd: dir });
		// Modify: replace 1 line, add 2 → numstat says 2 added, 1 deleted = 3 churn
		writeFileSync(tracked, "a\nb-modified\nc\nd\ne\n");

		const { prodLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBeGreaterThanOrEqual(3);
	});

	it("returns zero when there are no changes", () => {
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(0);
		expect(testLoc).toBe(0);
	});

	// Regression: a session that only edited CLAUDE.md fired the
	// "wrote N lines of production code with no tests" warning because
	// the bipartite test-vs-everything split routed every non-test path
	// into prodLoc. Docs/data files must be in a third (ignored) bucket.
	it("ignores doc files (markdown, txt, rst) — neither prod nor test", () => {
		writeFileSync(join(dir, "CLAUDE.md"), "a\n".repeat(50));
		writeFileSync(join(dir, "notes.txt"), "a\n".repeat(30));
		writeFileSync(join(dir, "guide.rst"), "a\n".repeat(20));
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(0);
		expect(testLoc).toBe(0);
	});

	it("ignores data files (json, lockfiles) — not production code", () => {
		writeFileSync(join(dir, "package-lock.json"), "a\n".repeat(500));
		writeFileSync(join(dir, "config.json"), "a\n".repeat(40));
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(0);
		expect(testLoc).toBe(0);
	});

	it("counts only the code portion when mixed with docs", () => {
		writeFileSync(join(dir, "feature.ts"), "a\n".repeat(20));
		writeFileSync(join(dir, "README.md"), "a\n".repeat(200));
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(21);
		expect(testLoc).toBe(0);
	});

	it("ignores doc edits on tracked files via numstat", () => {
		const tracked = join(dir, "DOCS.md");
		writeFileSync(tracked, "line one\n");
		execSync("git add DOCS.md", { cwd: dir });
		execSync("git commit -q -m base", { cwd: dir });
		writeFileSync(tracked, "line one updated\nline two\n");
		const { prodLoc, testLoc } = gitNumstatDelta(dir);
		expect(prodLoc).toBe(0);
		expect(testLoc).toBe(0);
	});
});

// ===========================================
// FP-fix regression: TEST_FILE_RE bare-basename edge
// ===========================================
// A scratch file literally named `test.ts` (no `.test.` infix) was
// classified as implementation code and told to write a test for itself
// (recurrence log: 7 tdd_cycle_violation events on bare "test.ts").

describe("checkTddCycleViolation — bare test.ts basename", () => {
	function sessionWithNoTestCycle(file: string): SessionTrajectory {
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 3,
		};
		return makeSession({ tdd_cycles: new Map([[file, cycle]]) });
	}

	it("does NOT flag a file literally named test.ts", () => {
		const file = "test.ts";
		expect(checkTddCycleViolation(sessionWithNoTestCycle(file), file)).toBeNull();
	});

	it("does NOT flag a nested scratch/spec.mts (bare spec basename)", () => {
		const file = "scratch/spec.mts";
		expect(checkTddCycleViolation(sessionWithNoTestCycle(file), file)).toBeNull();
	});

	it("does NOT flag conventional test paths (foo.test.ts / __tests__/)", () => {
		for (const file of ["src/foo.test.ts", "src/__tests__/foo.ts"]) {
			expect(checkTddCycleViolation(sessionWithNoTestCycle(file), file)).toBeNull();
		}
	});

	it("STILL flags an implementation file with 3 untested edits", () => {
		const file = "src/widgets/foo.ts";
		const result = checkTddCycleViolation(sessionWithNoTestCycle(file), file);
		expect(result?.name).toBe("tdd_cycle_violation");
	});

	it("STILL flags a file whose name merely contains 'test' (contest.ts)", () => {
		// Guard against over-broad basename matching: `contest.ts` is
		// implementation code, not a test file.
		const file = "src/contest.ts";
		const result = checkTddCycleViolation(sessionWithNoTestCycle(file), file);
		expect(result?.name).toBe("tdd_cycle_violation");
	});

	it("does NOT flag a file under an exempt path (.interlinked/)", () => {
		const file = ".interlinked/scratch.ts";
		expect(checkTddCycleViolation(sessionWithNoTestCycle(file), file)).toBeNull();
	});
});

describe("checkTddRegression — extension and exemption gates", () => {
	function sessionWithRegression(file: string): SessionTrajectory {
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "regression",
			previous_state: "green",
			impl_edits_before_test: 0,
		};
		return makeSession({ tdd_cycles: new Map([[file, cycle]]) });
	}

	it("is silent on a non-source extension (e.g. markdown)", () => {
		const file = "docs/CHANGES.md";
		expect(checkTddRegression(sessionWithRegression(file), file)).toBeNull();
	});

	it("is silent on a file under an exempt path even in regression", () => {
		const file = ".interlinked/scratch.ts";
		expect(checkTddRegression(sessionWithRegression(file), file)).toBeNull();
	});

	it("STILL flags a real source file in green→red regression", () => {
		const file = "src/widgets/foo.ts";
		const result = checkTddRegression(sessionWithRegression(file), file);
		expect(result?.name).toBe("tdd_regression");
		expect(result?.severity).toBe("error");
	});
});

describe("isTypeOnlySourceFile — reached from checkTddCycleViolation and checkTddCommitGate", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "type-only-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("exempts a pure type-definition module from the in-edit no-test nudge", () => {
		const file = join(dir, "types.ts");
		writeFileSync(file, "export interface Foo {\n\tbar: string;\n}\nexport type Baz = number;\n");
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 3,
		};
		const session = makeSession({ tdd_cycles: new Map([[file, cycle]]) });
		expect(checkTddCycleViolation(session, file)).toBeNull();
	});

	it("exempts a pure type-definition module from the commit gate's no-test finding", () => {
		const file = join(dir, "types.ts");
		writeFileSync(file, "export interface Foo {\n\tbar: string;\n}\n");
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({
			files_written: new Set([file]),
			tdd_cycles: new Map([[file, cycle]]),
		});
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("falls through to false (does not exempt) when the 'file' is actually a directory (readFileSync throws)", () => {
		// existsSync(dir) is true for a directory, so isTypeOnlySourceFile
		// reaches readFileSync — which throws EISDIR on a directory — and
		// must fall through the catch to `return false` rather than crashing
		// or wrongly exempting.
		const asDir = join(dir, "weird.ts");
		mkdirSync(asDir);
		const cycle: TddCycle = {
			source_file: asDir,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 3,
		};
		const session = makeSession({ tdd_cycles: new Map([[asDir, cycle]]) });
		const result = checkTddCycleViolation(session, asDir);
		expect(result?.name).toBe("tdd_cycle_violation");
	});
});

describe("checkTddCommitGate — findTestFilePath edge shapes", () => {
	it("is silent (and does not throw) for a source file with no extension at all", () => {
		// findTestFilePath's `!ext` early return fires BEFORE the commit
		// gate's own extension filter runs, so an extension-less path must
		// not throw or otherwise misbehave along the way.
		const file = "Makefile";
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({ tdd_cycles: new Map([[file, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	it("is silent for a cycle keyed on a bare .test.ts basename (findTestFilePath rejects it)", () => {
		const file = "foo.test.ts";
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({ tdd_cycles: new Map([[file, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});
});
