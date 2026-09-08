import { parseWire, wireArray, wireObject, wireString, wireUnknown } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planListCommand, planShowCommand } from "./plan.js";

let cwd: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
	 cwd = mkdtempSync(join(tmpdir(), "interlinked-plan-mutation-v2-"));
	 stdout = [];
	 stderr = [];
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

function writePlanFile(name: string, contents: string): void {
	 const dir = join(cwd, ".interlinked", "plans");
	 mkdirSync(dir, { recursive: true });
	 writeFileSync(join(dir, name), contents, "utf-8");
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

function jsonOutput(): unknown[] {
	 return parseWire(JSON.parse(stdout.join("")), wireArray(wireUnknown), "test JSON value");
}

describe("plan mutation boundaries", () => {
	// test-contract: malformed and non-record JSONL entries must be ignored while a valid sibling remains observable.
	it("rejects malformed and non-object records without weakening valid parsing", async () => {
		 writePlanFile("mixed.jsonl", [
			 "null",
			 "[]",
			 "42",
			 JSON.stringify({ ...record(), session_id: "sess-valid" }),
			 JSON.stringify({ ...record(), session_id: "sess-bad-source", source: "Other" }),
		].join("\n"));
		 await planListCommand({ cwd, json: true });
		 expect(jsonOutput()).toEqual([expect.objectContaining({ session_id: "sess-valid" })]);
	});

	// test-contract: parser shape guards must skip null, arrays, primitives, and empty-intent steps while preserving valid optional fields and defaults.
	it("applies exact step and field boundary validation", async () => {
		 writePlanFile("shape.jsonl", JSON.stringify(record({
			 session_id: "sess-shape",
			 agent_name: "agent-shape",
			 created_at_step: Number.NaN,
			 steps: [null, [], "text", { intent: "", status: "executed" }, { intent: "kept", status: "unknown", tool_hint: "", target_hint: "target" }],
		})));
		 await planListCommand({ cwd, json: true });
		 expect(jsonOutput()).toEqual([expect.objectContaining({
			 session_id: "sess-shape",
			 agent_name: "agent-shape",
			 created_at_step: 0,
			 steps: [{ intent: "kept", status: "pending", target_hint: "target" }],
		})]);
	});

	// test-contract: valid timestamps sort newest-first, while one-sided and two-sided invalid timestamps have deterministic tail behavior.
	it("sorts finite and invalid timestamps at their exact boundaries", async () => {
		 const rows = [
			 record({ session_id: "both-invalid-a", created_at_iso: "not-a-date" }),
			 record({ session_id: "valid", created_at_iso: "2026-08-21T00:00:00.000Z" }),
			 record({ session_id: "one-invalid", created_at_iso: "also-invalid" }),
			 record({ session_id: "older", created_at_iso: "2026-08-20T00:00:00.000Z" }),
			 record({ session_id: "both-invalid-b", created_at_iso: "still-invalid" }),
		 ];
		 rows.forEach((row) => writePlanFile(`${row.session_id}.jsonl`, JSON.stringify(row)));
		 await planListCommand({ cwd, json: true });
		 expect((parseWire(jsonOutput(), wireArray(wireObject({ "session_id": wireString })), "test JSON value")).map((row) => row.session_id)).toEqual([
			 "valid", "older", "both-invalid-a", "both-invalid-b", "one-invalid",
		 ]);
	});

	// test-contract: only .jsonl regular files contribute plans; missing and non-directory plan roots produce an empty public result.
	it("filters the plan directory and handles absent or invalid roots", async () => {
		 await planListCommand({ cwd, json: true });
		 expect(jsonOutput()).toEqual([]);
		 const root = join(cwd, ".interlinked", "plans");
		 mkdirSync(root, { recursive: true });
		 writePlanFile("kept.jsonl", JSON.stringify(record({ session_id: "kept" })));
		 writeFileSync(join(root, "ignored.json"), JSON.stringify(record({ session_id: "ignored" })));
		 mkdirSync(join(root, "directory.jsonl"));
		 stdout.length = 0;
		 await planListCommand({ cwd, json: true });
		 expect((parseWire(jsonOutput(), wireArray(wireObject({ "session_id": wireString })), "test JSON value")).map((row) => row.session_id)).toEqual(["kept"]);
	});

	// test-contract: reverse scanning must skip blank and malformed trailing lines and show exact human-readable metadata and step numbering.
	it("shows the newest valid entry and exact formatted details", async () => {
		 writePlanFile("sess-show.jsonl", `${JSON.stringify(record({ session_id: "sess-show", created_at_step: 7, steps: [{ intent: "do it", status: "executed", tool_hint: "shell", target_hint: "src" }] }))}\n\nnot-json\n`);
		 await planShowCommand("sess-show", { cwd });
		 expect(stdout.join("")).toBe("Plan for session: sess-show\n  Agent:      agent-default\n  Captured:   2026-08-20T12:00:00.000Z\n  At step:    7\n  Source:     TaskCreate\n  Step count: 1\n\n   1. [x] do it\n      tool=shell  target=src\n");
	});
});
