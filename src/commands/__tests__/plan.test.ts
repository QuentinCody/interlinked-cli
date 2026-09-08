import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireLiteral, wireNumber, wireObject, wireString } from "../../lib/value-validation.js";
// ===========================================
// interlinked plan — CLI subcommand regression suite
// ===========================================
//
// Pins the read commands:
//   - `interlinked plan list` with no captured plans → empty-list message,
//     exit 0
//   - `interlinked plan show <missing>` → clean "not found" message, exit 1
//   - `interlinked plan show <found>` returns the most-recent line
//   - `interlinked plan list` sorts by created_at_iso descending
//
// Tests point --cwd at a tmp dir and seed the JSONL fixture directly so we
// exercise the read path without spinning up the harness daemon.

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedPlan } from "../../harness/types/plan.js";
import { nonNull } from "../../lib/non-null.js";

const isCapturedPlan = wireObject<CapturedPlan>({
 session_id: wireString, agent_name: wireString, created_at_iso: wireString,
 created_at_step: wireNumber, source: wireLiteral("TaskCreate", "ExitPlanMode", "structured_userprompt"),
 steps: wireArray(wireObject<CapturedPlan["steps"][number]>({
  intent: wireString, status: wireLiteral("pending", "executed", "skipped"),
  tool_hint: wireAbsentOptional(wireString), target_hint: wireAbsentOptional(wireString),
 })),
});

import { planListCommand, planShowCommand } from "../plan.js";

let tmp = "";
let previousExitCode: number | string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-plan-cli-"));
	previousExitCode = process.exitCode;
	process.exitCode = 0;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	process.exitCode = previousExitCode;
});

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

async function captureStdio(fn: () => Promise<void>): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	});
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	});
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

function plansDir(): string {
	return join(tmp, ".interlinked", "plans");
}

function seedPlanFile(sessionId: string, plans: CapturedPlan[]): void {
	mkdirSync(plansDir(), { recursive: true });
	const path = join(plansDir(), `${sessionId}.jsonl`);
	const lines = plans.map((p) => JSON.stringify(p)).join("\n");
	writeFileSync(path, `${lines}\n`, "utf-8");
}

/** Write raw JSONL lines verbatim (no stringify wrapping) so we can seed
 *  malformed / torn / shape-violating records the typed helper can't express. */
function seedRawFile(sessionId: string, contents: string): void {
	mkdirSync(plansDir(), { recursive: true });
	writeFileSync(join(plansDir(), `${sessionId}.jsonl`), contents, "utf-8");
}

function plan(overrides: Partial<CapturedPlan>): CapturedPlan {
	return {
		session_id: overrides.session_id ?? "sess-1",
		agent_name: overrides.agent_name ?? "agent-a",
		created_at_iso: overrides.created_at_iso ?? "2026-04-23T00:00:00.000Z",
		created_at_step: overrides.created_at_step ?? 0,
		source: overrides.source ?? "TaskCreate",
		steps:
			overrides.steps ??
			[
				{ intent: "step one", status: "pending" },
				{ intent: "step two", status: "pending" },
			],
	};
}

describe("interlinked plan list", () => {
	it("prints an empty-list message and exits 0 when no plans captured", async () => {
		const captured = await captureStdio(() => planListCommand({ cwd: tmp }));
		expect(captured.stdout).toContain("no captured plans");
		expect(captured.stderr).toBe("");
		expect(process.exitCode).toBe(0);
	});

	it("returns empty array via --json when no plans captured", async () => {
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(captured.stdout.trim()).toBe("[]");
		expect(process.exitCode).toBe(0);
	});

	it("returns the newest plans first (sorted by created_at_iso desc)", async () => {
		seedPlanFile("sess-a", [
			plan({
				session_id: "sess-a",
				created_at_iso: "2026-04-20T00:00:00.000Z",
			}),
		]);
		seedPlanFile("sess-b", [
			plan({
				session_id: "sess-b",
				created_at_iso: "2026-04-22T00:00:00.000Z",
			}),
		]);
		seedPlanFile("sess-c", [
			plan({
				session_id: "sess-c",
				created_at_iso: "2026-04-21T00:00:00.000Z",
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows.map((r) => r.session_id)).toEqual(["sess-b", "sess-c", "sess-a"]);
	});

	it("returns the LAST line in a file when multiple plans (replanning)", async () => {
		seedPlanFile("sess-r", [
			plan({ session_id: "sess-r", created_at_iso: "2026-04-20T00:00:00.000Z" }),
			plan({
				session_id: "sess-r",
				created_at_iso: "2026-04-21T00:00:00.000Z",
				steps: [
					{ intent: "newer step a", status: "pending" },
					{ intent: "newer step b", status: "pending" },
					{ intent: "newer step c", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).created_at_iso).toBe("2026-04-21T00:00:00.000Z");
		expect(nonNull(rows[0]).steps).toHaveLength(3);
	});

	it("skips torn / malformed JSONL lines without crashing", async () => {
		const path = join(plansDir(), "sess-broken.jsonl");
		mkdirSync(plansDir(), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify(plan({ session_id: "sess-broken" }))}\nnot-json-at-all\n`,
			"utf-8",
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-broken");
	});
});

describe("interlinked plan show", () => {
	it("emits a clean not-found message and non-zero exit when session is missing", async () => {
		const captured = await captureStdio(() => planShowCommand("missing-sess", { cwd: tmp }));
		expect(captured.stderr).toContain("No plan captured");
		expect(captured.stderr).toContain("missing-sess");
		expect(process.exitCode).toBe(1);
	});

	it("emits machine-readable not-found via --json", async () => {
		const captured = await captureStdio(() =>
			planShowCommand("missing-sess", { cwd: tmp, json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "session_id": wireString }), "test JSON value");
		expect(parsed.ok).toBe(false);
		expect(parsed.session_id).toBe("missing-sess");
		expect(process.exitCode).toBe(1);
	});

	it("prints the most-recent captured plan for a known session", async () => {
		seedPlanFile("sess-x", [
			plan({
				session_id: "sess-x",
				agent_name: "agent-claude",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				steps: [
					{ intent: "first step", status: "pending" },
					{ intent: "second step", tool_hint: "Edit", target_hint: "src/foo.ts", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planShowCommand("sess-x", { cwd: tmp }));
		expect(captured.stdout).toContain("sess-x");
		expect(captured.stdout).toContain("agent-claude");
		expect(captured.stdout).toContain("first step");
		expect(captured.stdout).toContain("second step");
		expect(captured.stdout).toContain("tool=Edit");
		expect(captured.stdout).toContain("target=src/foo.ts");
		expect(process.exitCode).toBe(0);
	});

	it("rejects a missing session_id argument with usage", async () => {
		const captured = await captureStdio(() => planShowCommand(undefined, { cwd: tmp }));
		expect(captured.stderr).toContain("session_id");
		expect(captured.stderr).toContain("Usage:");
		expect(process.exitCode).toBe(2);
	});

	it("rejects a whitespace-only session_id as missing", async () => {
		const captured = await captureStdio(() => planShowCommand("   ", { cwd: tmp }));
		expect(captured.stderr).toContain("<session_id> is required");
		expect(process.exitCode).toBe(2);
	});
});

// ===========================================
// Human-readable table output (non-JSON list path)
// ===========================================

describe("interlinked plan list — table output", () => {
	it("renders a header + one row per plan and a footer count", async () => {
		seedPlanFile("sess-table", [
			plan({
				session_id: "sess-table",
				agent_name: "agent-table",
				created_at_iso: "2026-04-22T13:45:09.000Z",
				source: "ExitPlanMode",
				steps: [
					{ intent: "a", status: "pending" },
					{ intent: "b", status: "pending" },
					{ intent: "c", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp }));
		// Header columns.
		expect(captured.stdout).toContain("WHEN");
		expect(captured.stdout).toContain("SESSION");
		expect(captured.stdout).toContain("AGENT");
		expect(captured.stdout).toContain("SOURCE");
		expect(captured.stdout).toContain("STEPS");
		// Row content: the ISO 'T' is replaced with a space and truncated to 19 chars.
		expect(captured.stdout).toContain("2026-04-22 13:45:09");
		expect(captured.stdout).toContain("sess-table");
		expect(captured.stdout).toContain("agent-table");
		expect(captured.stdout).toContain("ExitPlanMode");
		// Step count column shows "3".
		expect(captured.stdout).toMatch(/ExitPlanMode\s+3/);
		// Footer summary.
		expect(captured.stdout).toContain("(1 plan(s)");
		expect(captured.stdout).toContain("plan show <session_id>");
		expect(captured.stderr).toBe("");
		expect(process.exitCode).toBe(0);
	});

	it("truncates over-long session and agent ids to the column widths", async () => {
		const longSession = "session-id-that-is-way-too-long-0123456789";
		const longAgent = "agent-name-that-overflows-the-column";
		seedPlanFile(longSession, [
			plan({
				session_id: longSession,
				agent_name: longAgent,
				created_at_iso: "2026-04-22T00:00:00.000Z",
			}),
		]);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp }));
		// Session truncated to 12 chars, agent to 18 chars.
		expect(captured.stdout).toContain(longSession.slice(0, 12));
		expect(captured.stdout).not.toContain(longSession);
		expect(captured.stdout).toContain(longAgent.slice(0, 18));
		expect(captured.stdout).not.toContain(longAgent);
		expect(process.exitCode).toBe(0);
	});

	it("caps the table at the 20 most-recent plans", async () => {
		for (let i = 0; i < 25; i++) {
			const day = String(i + 1).padStart(2, "0");
			seedPlanFile(`sess-${i}`, [
				plan({
					session_id: `sess-${i}`,
					created_at_iso: `2026-04-${day}T00:00:00.000Z`,
				}),
			]);
		}
		const captured = await captureStdio(() => planListCommand({ cwd: tmp }));
		// Footer reports the capped count, not 25.
		expect(captured.stdout).toContain("(20 plan(s)");
		// The 5 oldest (sess-0..sess-4) fall outside the top-20 window.
		expect(captured.stdout).not.toContain(" sess-0 ");
		// The newest (sess-24, 2026-04-25) is present.
		expect(captured.stdout).toContain("sess-24");
		expect(process.exitCode).toBe(0);
	});
});

// ===========================================
// plan show — file present but unusable / executed paths
// ===========================================

describe("interlinked plan show — degenerate files", () => {
	it("reports no-valid-entries (stderr) when the file holds only garbage", async () => {
		seedRawFile("sess-empty", "not-json\nalso-not-json\n\n");
		const captured = await captureStdio(() => planShowCommand("sess-empty", { cwd: tmp }));
		expect(captured.stderr).toContain("contained no valid entries");
		expect(captured.stderr).toContain("sess-empty");
		expect(captured.stdout).toBe("");
		expect(process.exitCode).toBe(1);
	});

	it("reports no-valid-entries when the plan path is unreadable (a directory)", async () => {
		// existsSync is true for a directory, but readFileSync throws EISDIR →
		// readNewestPlanFromFile catches and returns null → "no valid entries".
		mkdirSync(plansDir(), { recursive: true });
		mkdirSync(join(plansDir(), "sess-dir.jsonl"));
		const captured = await captureStdio(() => planShowCommand("sess-dir", { cwd: tmp }));
		expect(captured.stderr).toContain("contained no valid entries");
		expect(process.exitCode).toBe(1);
	});

	it("reports no-valid-entries (JSON) when the file holds only garbage", async () => {
		seedRawFile("sess-empty", "{bad json\n");
		const captured = await captureStdio(() =>
			planShowCommand("sess-empty", { cwd: tmp, json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "error": wireString, "session_id": wireString }), "test JSON value");
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toContain("no valid entries");
		expect(parsed.session_id).toBe("sess-empty");
		expect(captured.stderr).toBe("");
		expect(process.exitCode).toBe(1);
	});

	it("emits the full captured plan as JSON when found via --json", async () => {
		seedPlanFile("sess-json", [
			plan({
				session_id: "sess-json",
				agent_name: "agent-j",
				source: "structured_userprompt",
				created_at_step: 7,
				steps: [{ intent: "do the thing", status: "executed" }],
			}),
		]);
		const captured = await captureStdio(() =>
			planShowCommand("sess-json", { cwd: tmp, json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), isCapturedPlan, "captured plan");
		expect(parsed.session_id).toBe("sess-json");
		expect(parsed.agent_name).toBe("agent-j");
		expect(parsed.source).toBe("structured_userprompt");
		expect(parsed.created_at_step).toBe(7);
		expect(parsed.steps).toEqual([{ intent: "do the thing", status: "executed" }]);
		expect(process.exitCode).toBe(0);
	});

	it("renders the status indicators for executed / skipped / pending steps", async () => {
		seedPlanFile("sess-status", [
			plan({
				session_id: "sess-status",
				steps: [
					{ intent: "done step", status: "executed" },
					{ intent: "dropped step", status: "skipped" },
					{ intent: "todo step", status: "pending" },
				],
			}),
		]);
		const captured = await captureStdio(() => planShowCommand("sess-status", { cwd: tmp }));
		expect(captured.stdout).toContain("[x] done step");
		expect(captured.stdout).toContain("[-] dropped step");
		expect(captured.stdout).toContain("[ ] todo step");
		expect(captured.stdout).toContain("Step count: 3");
		expect(process.exitCode).toBe(0);
	});

	it("omits the meta line for a step with no tool_hint / target_hint", async () => {
		seedPlanFile("sess-bare", [
			plan({
				session_id: "sess-bare",
				steps: [{ intent: "bare step", status: "pending" }],
			}),
		]);
		const captured = await captureStdio(() => planShowCommand("sess-bare", { cwd: tmp }));
		expect(captured.stdout).toContain("[ ] bare step");
		expect(captured.stdout).not.toContain("tool=");
		expect(captured.stdout).not.toContain("target=");
		expect(process.exitCode).toBe(0);
	});
});

// ===========================================
// Defensive parser — shape validation (parsePlanLine)
// ===========================================

describe("interlinked plan — defensive JSONL parsing", () => {
	it("rejects a JSON array line (not an object)", async () => {
		seedRawFile("sess-arr", "[1,2,3]\n");
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
	});

	it("rejects a JSON null line", async () => {
		seedRawFile("sess-null", "null\n");
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
	});

	it("rejects a record missing required string fields", async () => {
		// Has session_id + created_at_iso but no agent_name → readString null → reject.
		seedRawFile(
			"sess-missing",
			`${JSON.stringify({
				session_id: "sess-missing",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: [],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
	});

	it("rejects a record whose source is not an allowed PlanSource", async () => {
		seedRawFile(
			"sess-badsrc",
			`${JSON.stringify({
				session_id: "sess-badsrc",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "NotARealSource",
				steps: [],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
	});

	it("treats an absent source field as a reject (empty-string fallback)", async () => {
		seedRawFile(
			"sess-nosrc",
			`${JSON.stringify({
				session_id: "sess-nosrc",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				steps: [],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
	});

	it("skips non-object and intent-less step entries but keeps valid ones", async () => {
		// steps: a non-object (string), an object with no intent, and a valid one.
		// steps that is non-array (object) → treated as [] elsewhere; here we test array contents.
		seedRawFile(
			"sess-steps",
			`${JSON.stringify({
				session_id: "sess-steps",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: ["just a string", { status: "executed" }, { intent: "kept", status: "pending" }],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).steps).toEqual([{ intent: "kept", status: "pending" }]);
	});

	it("falls back to 'pending' for an unknown step status", async () => {
		seedRawFile(
			"sess-badstatus",
			`${JSON.stringify({
				session_id: "sess-badstatus",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: [{ intent: "weird", status: "in_progress" }],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(nonNull(nonNull(rows[0]).steps[0]).status).toBe("pending");
	});

	it("falls back to 'pending' when step status is non-string", async () => {
		seedRawFile(
			"sess-numstatus",
			`${JSON.stringify({
				session_id: "sess-numstatus",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: [{ intent: "numbered", status: 42 }],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(nonNull(nonNull(rows[0]).steps[0]).status).toBe("pending");
	});

	it("preserves valid tool_hint / target_hint and drops empty ones", async () => {
		seedRawFile(
			"sess-hints",
			`${JSON.stringify({
				session_id: "sess-hints",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: [
					{ intent: "with hints", status: "pending", tool_hint: "Write", target_hint: "x.ts" },
					{ intent: "empty hints", status: "pending", tool_hint: "", target_hint: "" },
				],
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(nonNull(rows[0]).steps[0]).toEqual({
			intent: "with hints",
			status: "pending",
			tool_hint: "Write",
			target_hint: "x.ts",
		});
		// Empty-string hints must NOT be set as keys (readString → null).
		expect(nonNull(rows[0]).steps[1]).toEqual({ intent: "empty hints", status: "pending" });
		expect("tool_hint" in nonNull(nonNull(rows[0]).steps[1])).toBe(false);
		expect("target_hint" in nonNull(nonNull(rows[0]).steps[1])).toBe(false);
	});

	it("treats a non-array steps field as an empty step list", async () => {
		seedRawFile(
			"sess-objsteps",
			`${JSON.stringify({
				session_id: "sess-objsteps",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: { not: "an array" },
			})}\n`,
		);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).steps).toEqual([]);
	});

	it("defaults created_at_step to 0 when absent or non-finite", async () => {
		seedRawFile(
			"sess-step-default",
			`${JSON.stringify({
				session_id: "sess-step-default",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				source: "TaskCreate",
				steps: [],
			})}\n${JSON.stringify({
				session_id: "sess-step-default",
				agent_name: "a",
				created_at_iso: "2026-04-21T00:00:00.000Z",
				created_at_step: "not-a-number",
				source: "TaskCreate",
				steps: [],
			})}\n`,
		);
		// Newest valid line (line 1) has no created_at_step.
		const captured = await captureStdio(() =>
			planShowCommand("sess-step-default", { cwd: tmp, json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), isCapturedPlan, "captured plan");
		expect(parsed.created_at_step).toBe(0);
	});

	it("keeps a finite numeric created_at_step", async () => {
		seedRawFile(
			"sess-step-num",
			`${JSON.stringify({
				session_id: "sess-step-num",
				agent_name: "a",
				created_at_iso: "2026-04-22T00:00:00.000Z",
				created_at_step: 12,
				source: "TaskCreate",
				steps: [],
			})}\n`,
		);
		const captured = await captureStdio(() =>
			planShowCommand("sess-step-num", { cwd: tmp, json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), isCapturedPlan, "captured plan");
		expect(parsed.created_at_step).toBe(12);
	});
});

// ===========================================
// Directory walking edge cases (loadAllNewestPlans)
// ===========================================

describe("interlinked plan list — directory walk edge cases", () => {
	it("ignores non-.jsonl files in the plans directory", async () => {
		seedPlanFile("sess-real", [plan({ session_id: "sess-real" })]);
		// A stray non-jsonl sibling must be skipped (the .endsWith guard).
		writeFileSync(join(plansDir(), "README.txt"), "ignore me\n", "utf-8");
		writeFileSync(join(plansDir(), "notes.json"), '{"x":1}\n', "utf-8");
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-real");
	});

	it("skips a subdirectory whose name ends in .jsonl (not a file)", async () => {
		seedPlanFile("sess-ok", [plan({ session_id: "sess-ok" })]);
		// A directory named like a plan file → statSync().isFile() is false → continue.
		mkdirSync(join(plansDir(), "subdir.jsonl"), { recursive: true });
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-ok");
	});

	it("drops files that yield no parseable plan but keeps valid siblings", async () => {
		seedPlanFile("sess-good", [plan({ session_id: "sess-good" })]);
		seedRawFile("sess-garbage", "garbage\nmore garbage\n");
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-good");
	});

	it("returns [] when the plans path exists but is a file, not a directory", async () => {
		// readdirSync throws ENOTDIR → caught → returns [].
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "plans"), "i am a file\n", "utf-8");
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		expect(JSON.parse(captured.stdout)).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	it("skips an entry whose statSync throws (self-referential symlink) but keeps valid siblings", async () => {
		seedPlanFile("sess-live", [plan({ session_id: "sess-live" })]);
		// A self-referential .jsonl symlink: readdirSync lists it, statSync (which
		// follows links) throws ELOOP → the catch-continue path in the walk fires.
		const loopPath = join(plansDir(), "loop.jsonl");
		symlinkSync(loopPath, loopPath);
		// Sanity: the fixture really does make statSync throw in this environment.
		// (If a runtime ever resolved it without throwing, the production catch
		// wouldn't be exercised and we'd want to know.)
		let threw = false;
		try {
			statSync(loopPath);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-live");
	});
});

// ===========================================
// ISO sort comparator — non-finite date handling
// ===========================================

describe("interlinked plan list — created_at_iso sort comparator", () => {
	// NOTE: the comparator (compareIsoDesc) is reached via Array#sort, whose
	// call order/argument-position is engine-defined. To deterministically
	// exercise BOTH the "both timestamps unparseable" path and the
	// "first arg unparseable / second valid" path, we seed a rich mix of
	// valid and genuinely-NaN dates so every (a,b) ordering occurs across the
	// sort. (Many human strings like "nope-1" actually parse to a real Date;
	// the fixtures below use strings verified to yield NaN from new Date().)
	function badDatePlan(id: string, iso: string): string {
		return `${JSON.stringify({
			session_id: id,
			agent_name: "a",
			created_at_iso: iso,
			source: "TaskCreate",
			steps: [],
		})}\n`;
	}

	it("sorts plans with unparseable timestamps to the end, valid ones by recency", async () => {
		// Interleave valid + genuinely-NaN dates. Files are walked in directory
		// order, so alphabetically-alternating names ("c01v, c02n, c03v, ...")
		// give the comparator an array that exercises BOTH the at-NaN and bt-NaN
		// orderings (V8's sort argument position depends on neighbour layout).
		const validIso = (day: number) => `2026-04-${String(day).padStart(2, "0")}T00:00:00.000Z`;
		const validIds: string[] = [];
		for (let i = 0; i < 4; i++) {
			const vid = `c${String(i * 2 + 1).padStart(2, "0")}-valid`;
			validIds.push(vid);
			// Earlier index → earlier (older) date so we can assert recency order.
			seedPlanFile(vid, [plan({ session_id: vid, created_at_iso: validIso(10 + i) })]);
			const nid = `c${String(i * 2 + 2).padStart(2, "0")}-nan`;
			seedRawFile(nid, badDatePlan(nid, "not-a-date"));
		}

		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(8);
		// The four valid-dated plans lead, newest-first (day 13 → day 10).
		const validHead = rows.slice(0, 4).map((r) => r.session_id);
		expect(validHead).toEqual([...validIds].reverse());
		// All four NaN-dated plans are pushed to the tail (order among them
		// unspecified, but every one must survive).
		const nanTail = rows.slice(4).map((r) => r.session_id).sort();
		expect(nanTail).toEqual(["c02-nan", "c04-nan", "c06-nan", "c08-nan"]);
	});

	it("treats two unparseable timestamps as mutually equal and retains both", async () => {
		// Three genuinely-NaN dates guarantees at least one NaN-vs-NaN comparison
		// (compareIsoDesc returns 0 → stable order).
		seedRawFile("sess-bad-a", badDatePlan("sess-bad-a", "qqq"));
		seedRawFile("sess-bad-b", badDatePlan("sess-bad-b", "also-bad"));
		seedRawFile("sess-bad-c", badDatePlan("sess-bad-c", "third-bad"));
		const captured = await captureStdio(() => planListCommand({ cwd: tmp, json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.session_id).sort()).toEqual([
			"sess-bad-a",
			"sess-bad-b",
			"sess-bad-c",
		]);
	});
});

// ===========================================
// cwd defaulting (opts.cwd absent → process.cwd())
// ===========================================

describe("interlinked plan — defaults cwd to process.cwd()", () => {
	// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
	// is not supported in workers"), and Stryker's vitest runner pins its own
	// pool, so a real chdir here fails the mutation dry run for any file whose
	// graph-selected test scope includes this one. plan.ts reads `process.cwd()`
	// explicitly via `opts.cwd ?? process.cwd()`, so the spy exercises the same
	// path.
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	beforeEach(() => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
	});

	it("planListCommand resolves plans relative to process.cwd() when cwd is omitted", async () => {
		seedPlanFile("sess-cwd", [plan({ session_id: "sess-cwd" })]);
		const captured = await captureStdio(() => planListCommand({ json: true }));
		const rows = parseWire(JSON.parse(captured.stdout), wireArray(isCapturedPlan), "captured plans");
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).session_id).toBe("sess-cwd");
	});

	it("planShowCommand resolves plans relative to process.cwd() when cwd is omitted", async () => {
		seedPlanFile("sess-cwd-show", [plan({ session_id: "sess-cwd-show" })]);
		const captured = await captureStdio(() =>
			planShowCommand("sess-cwd-show", { json: true }),
		);
		const parsed = parseWire(JSON.parse(captured.stdout), isCapturedPlan, "captured plan");
		expect(parsed.session_id).toBe("sess-cwd-show");
	});
});
