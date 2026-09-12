// Tests for the check-results sink: mapping a HarnessDecision's structured
// check_results into a compact filmstrip row, and the fail-open append.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as capturedData from "../lib/data/capture.js";
import { appendCheckResults, buildCheckRow } from "./check-results-sink.js";
import type { CheckResultEntry, HarnessDecision } from "./types/decisions.js";
import type { HarnessEvent } from "./types/events.js";

function postEvent(over: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-06-24T00:00:00Z",
		...over,
	};
}

function decisionWith(over: Partial<HarnessDecision>): HarnessDecision {
	return { decision: "allow", ...over };
}

const tsFinding: CheckResultEntry = {
	source: "quality", name: "typescript", severity: "error",
	message: "boom", file: "src/db.ts", determinism: "fully_deterministic", phase: "post",
};
const magicFinding: CheckResultEntry = {
	source: "suggestion", name: "magic_number", severity: "warning",
	message: "meh", determinism: "heuristic",
};

describe("buildCheckRow", () => {
	it("maps a blocking decision with findings", () => {
		const ev = postEvent({ tool_use_id: "t1", tool_name: "Edit", tool_input: { file_path: "src/x.ts" } });
		const row = buildCheckRow(
			ev,
			decisionWith({ decision: "block", checks_ran: ["typescript", "biome", "empty_catch"], check_results: [tsFinding, magicFinding] }),
		);
		expect(row).not.toBeNull();
		expect(row?.tool_use_id).toBe("t1");
		expect(row?.session).toBe("s"); // session attribution — noise is sliceable per session
		expect(row?.tool).toBe("Edit");
		expect(row?.file).toBe("src/db.ts"); // a finding's own file wins over tool_input
		expect(row?.decision).toBe("block");
		expect(row?.ran).toBe(3);
		expect(row?.checks).toEqual([
			{ id: "typescript", severity: "error", determinism: "proven", phase: "post" },
			{ id: "magic_number", severity: "warning", determinism: "heuristic" },
		]);
	});

	it("records a clean call (checks ran, nothing fired) with the file from tool_input", () => {
		const ev = postEvent({ tool_use_id: "t2", tool_name: "Write", tool_input: { file_path: "src/clean.ts" } });
		const row = buildCheckRow(ev, decisionWith({ decision: "allow", checks_ran: ["typescript"], check_results: [] }));
		expect(row?.decision).toBe("allow");
		expect(row?.checks).toEqual([]);
		expect(row?.ran).toBe(1);
		expect(row?.file).toBe("src/clean.ts");
	});

	it("retains a no-verdict row in structured telemetry without claiming the check ran", () => {
		const deferred: CheckResultEntry = {
			source: "quality",
			name: "external_check_deferred",
			severity: "warning",
			message: "External check deferred for src/x.ts (typescript)",
			file: "src/x.ts",
			determinism: "fully_deterministic",
		};
		const row = buildCheckRow(
			postEvent({ tool_use_id: "t-deferred", tool_input: { file_path: "src/x.ts" } }),
			decisionWith({ check_results: [deferred] }),
		);
		expect(row?.checks).toEqual([
			{ id: "external_check_deferred", severity: "warning", determinism: "proven" },
		]);
		expect(row?.ran).toBeUndefined();
	});

	it("records per-subagent identity and model while retaining the parent session", () => {
		const ev = postEvent({
			tool_use_id: "t-sub",
			agent_name: "/root/kill_a_survivors",
			subagent_id: "sub-thread",
			parent_agent: "parent-thread",
			model: "vendor-model-luna",
		});
		const row = buildCheckRow(ev, decisionWith({ checks_ran: ["typescript"] }));
		expect(row).toMatchObject({
			session: "s",
			agent_name: "/root/kill_a_survivors",
			subagent_id: "sub-thread",
			parent_agent: "parent-thread",
			model: "vendor-model-luna",
		});
	});

	it("maps an 'ask' decision to a deviation (block)", () => {
		const ev = postEvent({ tool_use_id: "t3", tool_input: {} });
		const row = buildCheckRow(ev, decisionWith({ decision: "ask", check_results: [magicFinding] }));
		expect(row?.decision).toBe("block");
	});

	it("falls back to files_modified for the file", () => {
		const ev = postEvent({ tool_use_id: "t4", files_modified: ["src/touched.ts"] });
		const row = buildCheckRow(ev, decisionWith({ check_results: [magicFinding] }));
		expect(row?.file).toBe("src/touched.ts");
	});

	it("returns null without a tool_use_id (no correlation key)", () => {
		expect(buildCheckRow(postEvent({ tool_name: "Edit" }), decisionWith({ check_results: [magicFinding] }))).toBeNull();
	});

	it("returns null when no checks ran and nothing fired", () => {
		expect(buildCheckRow(postEvent({ tool_use_id: "t5" }), decisionWith({ decision: "allow" }))).toBeNull();
	});
});

describe("appendCheckResults", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "check-sink-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("does not create capture artifacts for a dry-run event with findings", () => {
		const root = mkdtempSync(join(tmpdir(), "check-sink-dry-run-"));
		try {
			appendCheckResults(root, postEvent({ dry_run: true, tool_use_id: "probe", tool_name: "Edit" }), decisionWith({ check_results: [tsFinding] }));
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("appends a row to .interlinked/check-results.jsonl, creating the dir", () => {
		const ev = postEvent({ tool_use_id: "t1", tool_name: "Edit", tool_input: { file_path: "src/x.ts" } });
		appendCheckResults(dir, ev, decisionWith({ checks_ran: ["typescript"], check_results: [magicFinding] }));
		const written = readFileSync(join(dir, ".interlinked", "check-results.jsonl"), "utf-8").trim();
		expect(JSON.parse(written)).toMatchObject({ tool_use_id: "t1", tool: "Edit" });
	});

	it("writes nothing when there is no row to record", () => {
		const empty = mkdtempSync(join(tmpdir(), "check-sink-empty-"));
		appendCheckResults(empty, postEvent({ tool_use_id: "t9" }), decisionWith({ decision: "allow" }));
		expect(() => readFileSync(join(empty, ".interlinked", "check-results.jsonl"))).toThrow();
		rmSync(empty, { recursive: true, force: true });
	});

	it("never throws even when the path is unwritable (fail-open)", () => {
		const asFile = join(dir, "not-a-dir");
		writeFileSync(asFile, "x");
		const ev = postEvent({ tool_use_id: "t1", tool_input: { file_path: "a.ts" } });
		expect(() => appendCheckResults(asFile, ev, decisionWith({ check_results: [magicFinding] }))).not.toThrow();
	});

	it("contains an unexpected native capture failure before recording check results", () => {
		const writer = vi.spyOn(capturedData, "appendCapturedData").mockImplementation(() => { throw new Error("capture writer failed"); });
		try {
			expect(() => appendCheckResults(dir, postEvent({ tool_use_id: "writer-failure" }), decisionWith({ check_results: [magicFinding] }))).not.toThrow();
			expect(writer).toHaveBeenCalledWith({ cwd: dir, producer: "harness/data-capture-native", session: "s", provider: "claude" }, "files-touched", []);
		} finally {
			writer.mockRestore();
		}
	});
});
