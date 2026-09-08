import { parseWire, wireArray, wireObject, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap node:fs as a passthrough (every real fn intact) so real fixture files
// on disk keep working, but track call-args for readdirSync/readFileSync so
// tests can prove a guard clause skipped a call entirely (not just that the
// final output matched, which several removed-guard mutants leave unchanged).
// SAFETY: widening an empty array literal to its accumulator type; no value
// is actually asserted, only the element type of a list that starts empty.
const fsCalls = vi.hoisted(() => ({
	readdirSyncArgs: [] as unknown[][],
	readFileSyncArgs: [] as unknown[][],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: (...args: unknown[]) => {
			fsCalls.readdirSyncArgs.push(args);
			// SAFETY: the mock forwards the exact captured arguments to the real
			// overloaded function and preserves its runtime return value.
			return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
		},
		readFileSync: (...args: unknown[]) => {
			fsCalls.readFileSyncArgs.push(args);
			// SAFETY: the mock forwards the exact captured arguments to the real
			// overloaded function and preserves its runtime return value.
			return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
		},
	};
});

const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const { planListCommand, planShowCommand } = await import("./plan.js");

let cwd: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "interlinked-plan-mutation-w40-"));
	stdout = [];
	stderr = [];
	fsCalls.readdirSyncArgs = [];
	fsCalls.readFileSyncArgs = [];
	vi.spyOn(process.stdout, "write").mockImplementation((value) => {
		stdout.push(String(value));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((value) => {
		stderr.push(String(value));
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(cwd, { recursive: true, force: true });
});

function plansDir(): string {
	return join(cwd, ".interlinked", "plans");
}

function writePlanFile(name: string, contents: string): void {
	mkdirSync(plansDir(), { recursive: true });
	writeFileSync(join(plansDir(), name), contents, "utf-8");
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: "sess-default",
		agent_name: "agent-default",
		created_at_iso: "2026-08-20T12:00:00.000Z",
		created_at_step: 4,
		source: "TaskCreate",
		steps: [{ intent: "default step", status: "pending" }],
		...overrides,
	};
}

describe("plan.ts mutation-kill w40", () => {
	// test-contract: public-api — the WHEN column truncates the ISO string to exactly 19 chars (drops millis/zone).
	it("planListCommand table row: 'when' column is truncated to 19 chars, not just T->space", async () => {
		writePlanFile(
			"sess-fmt.jsonl",
			JSON.stringify(
				record({
					session_id: "sess-fmt",
					agent_name: "agent-fmt",
					created_at_iso: "2026-08-20T12:00:00.123Z",
					source: "TaskCreate",
					steps: [{ intent: "x", status: "pending" }],
				}),
			),
		);
		await planListCommand({ cwd });
		const full = stdout.join("");
		const rowLine = full.split("\n").find((l) => l.includes("sess-fmt"));
		expect(rowLine).toBeDefined();
		// "2026-08-20 12:00:00" (19 chars) padEnd(22) + "  " separator = 5 trailing spaces.
		expect(rowLine).toContain("2026-08-20 12:00:00     sess-fmt");
		expect(full).not.toContain("12:00:00.123");
	});

	// test-contract: public-api — a blank line separates the table body from the footer summary line.
	it("planListCommand: exact full non-json output including the blank separator line", async () => {
		writePlanFile(
			"sess-one.jsonl",
			JSON.stringify(
				record({
					session_id: "sess-one",
					agent_name: "agent-one",
					created_at_iso: "2026-08-20T12:00:00.000Z",
					source: "TaskCreate",
					steps: [{ intent: "x", status: "pending" }],
				}),
			),
		);
		await planListCommand({ cwd });
		const full = stdout.join("");
		const expected =
			`${"WHEN".padEnd(22)}  ${"SESSION".padEnd(12)}  ${"AGENT".padEnd(18)}  ${"SOURCE".padEnd(22)}  STEPS\n` +
			`${"2026-08-20 12:00:00".padEnd(22)}  ${"sess-one".padEnd(12)}  ${"agent-one".padEnd(18)}  ${"TaskCreate".padEnd(22)}  1\n` +
			"\n" +
			"(1 plan(s); run `interlinked plan show <session_id>` for details)\n";
		expect(full).toBe(expected);
	});

	// test-contract: public-api — the missing-session stderr message includes the "run plan list" hint line verbatim.
	it("planShowCommand: exact stderr for missing session includes the run-hint line", async () => {
		await planShowCommand("nope-sess", { cwd });
		expect(stderr.join("")).toBe(
			"No plan captured for session: nope-sess\n" +
				"(run `interlinked plan list` to see known session ids)\n",
		);
	});

	// test-contract: public-api — a step with no tool_hint/target_hint prints no meta line at all (exact output).
	it("planShowCommand: exact stdout when a step has no hints (no stray blank meta line)", async () => {
		writePlanFile(
			"sess-bare.jsonl",
			JSON.stringify(
				record({
					session_id: "sess-bare",
					agent_name: "agent-bare",
					created_at_iso: "2026-08-20T12:00:00.000Z",
					created_at_step: 1,
					source: "TaskCreate",
					steps: [{ intent: "bare step", status: "pending" }],
				}),
			),
		);
		await planShowCommand("sess-bare", { cwd });
		expect(stdout.join("")).toBe(
			"Plan for session: sess-bare\n" +
				"  Agent:      agent-bare\n" +
				"  Captured:   2026-08-20T12:00:00.000Z\n" +
				"  At step:    1\n" +
				"  Source:     TaskCreate\n" +
				"  Step count: 1\n" +
				"\n" +
				"   1. [ ] bare step\n",
		);
	});

	// test-contract: invariant — when the plans directory does not exist, readdirSync must never be called (early return).
	it("loadAllNewestPlans: readdirSync is never invoked when the plans dir is absent", async () => {
		await planListCommand({ cwd, json: true });
		expect(fsCalls.readdirSyncArgs).toHaveLength(0);
		expect(JSON.parse(stdout.join(""))).toEqual([]);
	});

	// test-contract: invariant — a directory named "*.jsonl" is filtered by the statSync/isFile guard before ever reaching readFileSync.
	it("loadAllNewestPlans: readFileSync is never called for a directory entry named *.jsonl", async () => {
		writePlanFile("sess-live.jsonl", JSON.stringify(record({ session_id: "sess-live" })));
		mkdirSync(join(plansDir(), "trap.jsonl"), { recursive: true });
		await planListCommand({ cwd, json: true });
		const trapPath = join(plansDir(), "trap.jsonl");
		const calledWithTrap = fsCalls.readFileSyncArgs.some((call) => call[0] === trapPath);
		expect(calledWithTrap).toBe(false);
		// SAFETY: fixture writes one valid CapturedPlan JSON line; shape matches.
		const rows = parseWire(JSON.parse(stdout.join("")), wireArray(wireObject({ "session_id": wireString })), "test JSON value");
		expect(rows.map((r) => r.session_id)).toEqual(["sess-live"]);
	});

	// test-contract: invariant — when statSync throws (broken symlink), the catch must skip the entry before readFileSync is ever attempted on it.
	it("loadAllNewestPlans: readFileSync is never called for an entry whose statSync throws", async () => {
		writePlanFile("sess-live2.jsonl", JSON.stringify(record({ session_id: "sess-live2" })));
		const loopPath = join(plansDir(), "loop.jsonl");
		symlinkSync(loopPath, loopPath);
		await planListCommand({ cwd, json: true });
		const calledWithLoop = fsCalls.readFileSyncArgs.some((call) => call[0] === loopPath);
		expect(calledWithLoop).toBe(false);
		// SAFETY: fixture writes one valid CapturedPlan JSON line; shape matches.
		const rows = parseWire(JSON.parse(stdout.join("")), wireArray(wireObject({ "session_id": wireString })), "test JSON value");
		expect(rows.map((r) => r.session_id)).toEqual(["sess-live2"]);
	});

	// test-contract: invariant — reverse-scan must skip blank/whitespace-only lines WITHOUT ever handing them to JSON.parse.
	it("readNewestPlanFromFile: JSON.parse is called exactly once, never for blank/whitespace lines", async () => {
		const validLine = JSON.stringify(record({ session_id: "sess-valid-line" }));
		writePlanFile("sess-ws.jsonl", `${validLine}\n\n   \n`);
		const parseSpy = vi.spyOn(JSON, "parse");
		await planListCommand({ cwd, json: true });
		expect(parseSpy).toHaveBeenCalledTimes(1);
		expect(parseSpy).toHaveBeenCalledWith(validLine);
		// SAFETY: fixture writes one valid CapturedPlan JSON line; shape matches.
		const rows = parseWire(JSON.parse(stdout.join("")), wireArray(wireObject({ "session_id": wireString })), "test JSON value");
		expect(rows.map((r) => r.session_id)).toEqual(["sess-valid-line"]);
		parseSpy.mockRestore();
	});

	// test-contract: boundary — a non-string session_id must be rejected, never smuggled through as-is.
	it("parsePlanLine/readString: a numeric session_id is rejected, not coerced through", async () => {
		writePlanFile(
			"sess-numid.jsonl",
			`${JSON.stringify({
				session_id: 12345,
				agent_name: "agent-x",
				created_at_iso: "2026-08-20T12:00:00.000Z",
				source: "TaskCreate",
				steps: [],
			})}\n`,
		);
		await planListCommand({ cwd, json: true });
		expect(JSON.parse(stdout.join(""))).toEqual([]);
	});

	// test-contract: boundary — created_at_step must require BOTH typeof number AND Number.isFinite (AND, not OR).
	it("parsePlanLine: an out-of-range numeric created_at_step (parses to Infinity) falls back to 0, not Infinity", async () => {
		writePlanFile(
			"sess-inf.jsonl",
			`{"session_id":"sess-inf","agent_name":"agent-inf","created_at_iso":"2026-08-20T12:00:00.000Z","created_at_step":1e400,"source":"TaskCreate","steps":[]}\n`,
		);
		await planShowCommand("sess-inf", { cwd });
		expect(stdout.join("")).toContain("At step:    0\n");
		expect(stdout.join("")).not.toContain("Infinity");
	});

	// test-contract: boundary — an explicit empty-string step status must fall back to "pending", not pass through as "".
	it("parsePlanLine: an explicit empty-string step status normalizes to 'pending'", async () => {
		writePlanFile(
			"sess-emptystatus.jsonl",
			`${JSON.stringify({
				session_id: "sess-emptystatus",
				agent_name: "agent-x",
				created_at_iso: "2026-08-20T12:00:00.000Z",
				source: "TaskCreate",
				steps: [{ intent: "y", status: "" }],
			})}\n`,
		);
		await planListCommand({ cwd, json: true });
		// SAFETY: fixture writes one valid record with one step; shape matches.
		const rows = parseWire(JSON.parse(stdout.join("")), wireArray(wireObject({ "steps": wireArray(wireObject({ "status": wireString })) })), "test JSON value");
		expect(rows[0]?.steps[0]?.status).toBe("pending");
	});
});
