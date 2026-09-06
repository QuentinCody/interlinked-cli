// T3 eval ledger — one JSONL row per scored step under
// .interlinked/replay/eval/<run_id>/ (docs/design/reproducibility/tier3-scoring.md).
// Pins: run-id allocation is injectable-clock deterministic, rows round-trip,
// foreign/torn lines are skipped, runs are isolated by id.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	allocRunId,
	appendLedgerRow,
	ledgerPath,
	type LedgerRow,
	loadLedger,
	parseLedgerRow,
} from "./eval-ledger.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-ledger-"));
	cleanups.push(dir);
	return dir;
}

function row(runId: string, seq: number, match: boolean): LedgerRow {
	return {
		schema: "replay-eval.v1",
		run_id: runId,
		ts: "2026-07-24T15:00:00.000Z",
		mode: "off_policy",
		reference: { session_id: "sess", seq, tool_use_id: `toolu_${seq}`, model: "vendor-model-v6" },
		candidate: { model: "candidate-x", decode: "default" },
		scores: {
			action_match: { same_tool: match, same_input: match, match },
			structural: match ? { kind: "ast", comparable: true, distance: 0, normalized: 0 } : null,
		},
	};
}

describe("allocRunId", () => {
	it("is deterministic given an injected clock and slugs the candidate", () => {
		const id = allocRunId("My Model/v2", () => "2026-07-24T15:04:05.678Z");
		expect(id).toBe("run-20260724T150405-my-model-v2");
	});
});

describe("appendLedgerRow / loadLedger", () => {
	it("round-trips rows for a run and isolates runs from each other", () => {
		const cwd = tempCwd();
		appendLedgerRow(cwd, row("run-a", 1, true));
		appendLedgerRow(cwd, row("run-a", 2, false));
		appendLedgerRow(cwd, row("run-b", 1, true));
		const a = loadLedger(cwd, "run-a");
		expect(a).toHaveLength(2);
		expect(a[1]?.scores.action_match.match).toBe(false);
		expect(loadLedger(cwd, "run-b")).toHaveLength(1);
	});

	it("returns [] for an unknown run", () => {
		expect(loadLedger(tempCwd(), "run-none")).toEqual([]);
	});

	it("skips a torn/foreign JSON line but keeps the valid rows on either side of it", () => {
		const cwd = tempCwd();
		appendLedgerRow(cwd, row("run-a", 1, true));
		// Not valid JSON — JSON.parse throws, and the reader's contract is to
		// skip a torn/foreign line rather than lose the whole file to it.
		appendFileSync(ledgerPath(cwd, "run-a"), "not json{{{\n");
		appendLedgerRow(cwd, row("run-a", 2, false));
		const rows = loadLedger(cwd, "run-a");
		expect(rows.map((r) => r.reference.seq)).toEqual([1, 2]);
	});
});

describe("parseLedgerRow", () => {
	function full() {
		return {
			schema: "replay-eval.v1" as const,
			run_id: "run-a",
			ts: "2026-07-24T15:00:00.000Z",
			mode: "off_policy" as const,
			reference: { session_id: "sess", seq: 1, tool_use_id: "toolu_1", model: "vendor-model-v6" },
			candidate: { model: "candidate-x", decode: "default" },
			scores: {
				action_match: { same_tool: true, same_input: true, match: true },
				structural: { kind: "ast" as const, comparable: true, distance: 0, normalized: 0 },
			},
			reference_tool: "Bash",
		};
	}

	it("P1: accepts a fully-populated row", () => {
		const row = full();
		expect(parseLedgerRow(row)).toEqual(row);
	});

	it("P2: accepts a null structural score and an absent reference_tool", () => {
		const { reference_tool, ...rest } = full();
		void reference_tool;
		const row = { ...rest, scores: { ...rest.scores, structural: null } };
		expect(parseLedgerRow(row)).toEqual({ ...row, reference_tool: null });
	});

	it("N1: rejects the wrong schema tag", () => {
		expect(parseLedgerRow({ ...full(), schema: "other.v1" })).toBeNull();
	});

	it("N2: rejects a non-boolean action_match field", () => {
		const row = full();
		const bad = {
			...row,
			scores: { ...row.scores, action_match: { same_tool: "yes", same_input: true, match: true } },
		};
		expect(parseLedgerRow(bad)).toBeNull();
	});

	it("N3: rejects a structural score with an unknown kind", () => {
		const row = full();
		const bad = {
			...row,
			scores: { ...row.scores, structural: { ...row.scores.structural, kind: "diff" } },
		};
		expect(parseLedgerRow(bad)).toBeNull();
	});

	it("N4: rejects a missing candidate.model", () => {
		const row = full();
		const bad = { ...row, candidate: { decode: "default" } };
		expect(parseLedgerRow(bad)).toBeNull();
	});

	it("N5: rejects a non-object line (array)", () => {
		expect(parseLedgerRow(["replay-eval.v1"])).toBeNull();
	});
});
