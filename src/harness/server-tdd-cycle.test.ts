import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ALL_TESTS_SENTINEL,
	detectTestRunFile,
	findTestForSource,
	recordImplEdit,
	recordTestRunCycle,
	recordTestWrite,
	sourceFileForTest,
	updateCycleFromTestRun,
} from "./server-tdd-cycle.js";
import type { SessionTrajectory, TddCycle } from "./types.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tdd-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const base: Partial<SessionTrajectory> = {
		session_id: "s",
		agent_name: "a",
		started_at: "2026-04-23T00:00:00.000Z",
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
		step_limit: 100,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
	return ({ ...completeSessionFixture(), ...{ ...base, ...overrides } });
}

describe("detectTestRunFile", () => {
	it("returns null for non-test commands", () => {
		expect(detectTestRunFile("ls -la", "/r")).toBeNull();
	});

	it("returns the specific test file when vitest run targets one", () => {
		const out = detectTestRunFile("npx vitest run src/foo.test.ts", "/r");
		expect(out).toBe("/r/src/foo.test.ts");
	});

	it("returns ALL_TESTS_SENTINEL for generic npm test", () => {
		expect(detectTestRunFile("npm test", "/r")).toBe(ALL_TESTS_SENTINEL);
	});

	it("keeps absolute paths as-is", () => {
		const out = detectTestRunFile("vitest run /repo/src/foo.test.ts", "/r");
		expect(out).toBe("/repo/src/foo.test.ts");
	});

	it("returns ALL_TESTS_SENTINEL for cargo test", () => {
		expect(detectTestRunFile("cargo test", "/r")).toBe(ALL_TESTS_SENTINEL);
	});
});

describe("sourceFileForTest", () => {
	it("strips .test. from the same-dir convention", () => {
		expect(sourceFileForTest("/r/src/foo.test.ts")).toBe("/r/src/foo.ts");
	});
	it("strips .spec. too", () => {
		expect(sourceFileForTest("/r/src/foo.spec.ts")).toBe("/r/src/foo.ts");
	});
	it("handles the __tests__ convention", () => {
		expect(sourceFileForTest("/r/src/__tests__/foo.test.ts")).toBe("/r/src/foo.ts");
	});
});

describe("findTestForSource", () => {
	it("finds .test.ts next to source", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		writeFileSync(join(tmp, "src", "foo.test.ts"), "");
		expect(findTestForSource(join(tmp, "src", "foo.ts"))).toBe(join(tmp, "src", "foo.test.ts"));
	});

	it("finds __tests__/foo.test.ts", () => {
		mkdirSync(join(tmp, "src", "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		writeFileSync(join(tmp, "src", "__tests__", "foo.test.ts"), "");
		expect(findTestForSource(join(tmp, "src", "foo.ts"))).toBe(
			join(tmp, "src", "__tests__", "foo.test.ts"),
		);
	});

	it("returns null for files already named .test or .spec", () => {
		expect(findTestForSource("/r/foo.test.ts")).toBeNull();
	});

	it("returns null when no test file exists", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "lonely.ts"), "");
		expect(findTestForSource(join(tmp, "src", "lonely.ts"))).toBeNull();
	});
});

describe("getOrCreateCycle + recordImplEdit", () => {
	it("creates a fresh cycle and increments impl_edits", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.ts");
		recordImplEdit(session, "/r/src/foo.ts");
		expect(session.tdd_cycles.get("/r/src/foo.ts")?.impl_edits_before_test).toBe(2);
	});

	it("skips test files (writing a test isn't an impl edit)", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.test.ts");
		expect(session.tdd_cycles.size).toBe(0);
	});
});

// ===========================================
// Junk-cycle admission + key identity
// ===========================================
//
// Regressions for the two defects that made the 2026-07-26 commit-gate wedge
// possible in the first place: cycles were created for files that can never
// have a companion test, and one file could hold two independent cycles under
// a relative and an absolute key. Both fed the whole-suite fan-out.

describe("getOrCreateCycle — admission", () => {
	it("N1: refuses a cycle for a build/tool config file", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/vitest.config.mjs");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("N2: refuses a cycle for a file literally named test.mjs", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/test.mjs");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("N3: refuses a cycle for a non-code file", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/docs/design.md");
		recordImplEdit(session, "/r/data.json");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("N4: refuses a cycle for an exempt path", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/dist/bundle.js");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("P1: still admits ordinary source files", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.ts");
		expect(session.tdd_cycles.size).toBe(1);
	});

	it("keeps refused paths out of the whole-suite fan-out entirely", () => {
		// The point of refusing at admission: a junk entry that never exists
		// cannot be reddened by a failing suite, so it can never wedge the gate.
		const session = makeSession();
		recordImplEdit(session, "/r/vitest.config.mjs");
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, false);
		expect(session.tdd_cycles.size).toBe(0);
	});
});

describe("getOrCreateCycle — key identity", () => {
	it("P1: relative and absolute paths for one file share a single cycle", () => {
		const session = makeSession();
		recordImplEdit(session, "src/harness/checks/control-bytes.ts", "/r");
		recordImplEdit(session, "/r/src/harness/checks/control-bytes.ts", "/r");
		expect(session.tdd_cycles.size).toBe(1);
		const cycle = session.tdd_cycles.get("/r/src/harness/checks/control-bytes.ts");
		expect(cycle?.impl_edits_before_test).toBe(2);
	});

	it("P2: migrates a legacy relative-keyed cycle, preserving its state", () => {
		// A session persisted before normalization existed.
		const session = makeSession();
		session.tdd_cycles.set("src/foo.ts", {
			source_file: "src/foo.ts",
			test_file: "src/foo.test.ts",
			state: "red",
			red_at: 99,
			impl_edits_before_test: 3,
		});
		recordImplEdit(session, "/r/src/foo.ts", "/r");
		expect(session.tdd_cycles.size).toBe(1);
		const migrated = session.tdd_cycles.get("/r/src/foo.ts");
		expect(migrated?.state).toBe("red");
		expect(migrated?.red_at).toBe(99);
		expect(migrated?.impl_edits_before_test).toBe(4);
		expect(migrated?.source_file).toBe("/r/src/foo.ts");
	});

	it("P3: collapses . and .. segments to one key", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/./foo.ts");
		recordImplEdit(session, "/r/src/sub/../foo.ts");
		expect(session.tdd_cycles.size).toBe(1);
	});

	it("N1: genuinely different files keep separate cycles", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.ts");
		recordImplEdit(session, "/r/src/bar.ts");
		expect(session.tdd_cycles.size).toBe(2);
	});
});

describe("recordTestWrite", () => {
	it("does not create a cycle when source file doesn't exist", () => {
		const session = makeSession();
		recordTestWrite(session, "/r/missing.test.ts");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("attaches test_written_at when source exists", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		const session = makeSession({ tool_call_count: 5 });
		recordTestWrite(session, join(tmp, "src", "foo.test.ts"));
		const cycle = session.tdd_cycles.get(join(tmp, "src", "foo.ts"));
		expect(cycle?.test_written_at).toBe(5);
	});
});

describe("updateCycleFromTestRun", () => {
	it("green after pass, red after fail", () => {
		const cycle: TddCycle = {
			source_file: "/r/foo.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 3,
		};
		updateCycleFromTestRun(cycle, false, 10);
		expect(cycle.state).toBe("red");
		expect(cycle.red_at).toBe(10);

		updateCycleFromTestRun(cycle, true, 11);
		expect(cycle.state).toBe("green");
		expect(cycle.green_at).toBe(11);
		expect(cycle.impl_edits_before_test).toBe(0);
	});

	it("green → fail is a regression", () => {
		const cycle: TddCycle = {
			source_file: "/r/foo.ts",
			test_file: null,
			state: "green",
			impl_edits_before_test: 0,
		};
		updateCycleFromTestRun(cycle, false, 20);
		expect(cycle.state).toBe("regression");
	});
});

describe("recordTestRunCycle — sentinel sweeps all cycles", () => {
	it("updates every tracked cycle", () => {
		const session = makeSession();
		session.tdd_cycles.set("/r/a.ts", {
			source_file: "/r/a.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 2,
		});
		session.tdd_cycles.set("/r/b.ts", {
			source_file: "/r/b.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		});
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, true);
		expect(session.tdd_cycles.get("/r/a.ts")?.state).toBe("green");
		expect(session.tdd_cycles.get("/r/b.ts")?.state).toBe("green");
	});
});

// A1 — a whole-suite FAILURE used to redden every tracked cycle, including
// files with no companion test (config, scripts). Those can never be greened
// by a targeted run, so a single red suite wedged the commit gate on files
// whose tests do not exist. Observed live: vitest.config.mjs and check-docs.mjs
// reported as "Tests are FAILING".
describe("recordTestRunCycle — suite failure does not redden test-less files", () => {
	function sessionWith(cycles: TddCycle[]): SessionTrajectory {
		const session = makeSession();
		for (const c of cycles) session.tdd_cycles.set(c.source_file, c);
		return session;
	}

	it("leaves a cycle with no test_file untouched on a suite failure", () => {
		const session = sessionWith([
			{ source_file: "/r/cfg.ts", test_file: null, state: "no_test", impl_edits_before_test: 1 },
		]);
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, false);
		expect(session.tdd_cycles.get("/r/cfg.ts")?.state).toBe("no_test");
	});

	it("still reddens a cycle that HAS a test file", () => {
		const session = sessionWith([
			{
				source_file: "/r/a.ts",
				test_file: "/r/a.test.ts",
				state: "green",
				impl_edits_before_test: 0,
			},
		]);
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, false);
		expect(session.tdd_cycles.get("/r/a.ts")?.state).toBe("regression");
	});

	// Passing evidence covers a file whether or not it has its own test, so a
	// green sweep must stay blanket — otherwise test-less files could never
	// leave a red set before this fix landed.
	it("greens test-less cycles on a suite pass", () => {
		const session = sessionWith([
			{ source_file: "/r/cfg.ts", test_file: null, state: "no_test", impl_edits_before_test: 3 },
		]);
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, true);
		expect(session.tdd_cycles.get("/r/cfg.ts")?.state).toBe("green");
	});
});

// A4 — the block reason named a file and nothing else, so a stale red was
// indistinguishable from a live one.
describe("recordTestRunCycle — records the command that set the red", () => {
	it("stores the failing command, truncated", () => {
		const session = makeSession();
		recordTestRunCycle(session, "/r/a.test.ts", false, "npx vitest run /r/a.test.ts");
		expect(session.tdd_cycles.get("/r/a.ts")?.red_command).toBe("npx vitest run /r/a.test.ts");
	});

	it("clears the failing command once the cycle goes green", () => {
		const session = makeSession();
		recordTestRunCycle(session, "/r/a.test.ts", false, "npx vitest run /r/a.test.ts");
		recordTestRunCycle(session, "/r/a.test.ts", true, "npx vitest run /r/a.test.ts");
		const cycle = session.tdd_cycles.get("/r/a.ts");
		expect(cycle?.state).toBe("green");
		expect(cycle?.red_command).toBeUndefined();
	});

	it("omits the command when none was supplied", () => {
		const session = makeSession();
		recordTestRunCycle(session, "/r/a.test.ts", false);
		expect(session.tdd_cycles.get("/r/a.ts")?.red_command).toBeUndefined();
	});
});
