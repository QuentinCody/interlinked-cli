// ===========================================
// graph-prediction cache I/O — JSONL append + read
// ===========================================
// Two append-only logs:
//   .interlinked/graph-predictions.jsonl   — Case E-fresh predictions only
//   .interlinked/graph-observations.jsonl  — Case B/D/E-stale telemetry
//
// Cache key: {session_id, file_path, source_mtime, shard_mtime}.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	appendObservationRow,
	appendPredictionRow,
	appendReconciliationRow,
	findPredictionRow,
	type GraphObservationRow,
	type GraphPredictionRow,
	type GraphReconciliationRow,
} from "../graph-prediction-cache.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "graph-pred-cache-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sampleRow = (overrides: Partial<GraphPredictionRow> = {}): GraphPredictionRow => ({
	session_id: "sess-1",
	file_path: "src/foo.ts",
	source_mtime: "2026-05-10T12:00:00.000Z",
	shard_mtime: "2026-05-10T12:01:00.000Z",
	shard_path: "src/foo.graph.ts",
	emitted_at: "2026-05-10T12:02:00.000Z",
	tool_input_hash: "deadbeef",
	case: "E-fresh",
	prediction: {
		deps: { imports: ["node:net"], imported_by: ["src/index.ts"] },
		calls: { callers: [], callees: [] },
		impact: null,
	},
	comparison_status: "pending",
	...overrides,
});

describe("appendPredictionRow + findPredictionRow", () => {
	it("creates the JSONL file when first row is appended", () => {
		const path = join(dir, ".interlinked", "graph-predictions.jsonl");
		expect(existsSync(path)).toBe(false);
		appendPredictionRow(dir, sampleRow());
		expect(existsSync(path)).toBe(true);
	});

	it("reads back the row appended", () => {
		appendPredictionRow(dir, sampleRow());
		const found = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found?.shard_path).toBe("src/foo.graph.ts");
	});

	it("returns null when no row matches the key", () => {
		appendPredictionRow(dir, sampleRow());
		const found = findPredictionRow(dir, {
			session_id: "sess-DOES-NOT-EXIST",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found).toBeNull();
	});

	it("returns the LAST row when multiple share the same key (later overwrites)", () => {
		appendPredictionRow(dir, sampleRow({ comparison_status: "pending" }));
		appendPredictionRow(dir, sampleRow({ comparison_status: "complete" }));
		const found = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found?.comparison_status).toBe("complete");
	});

	it("ignores rows with mismatched session_id, source_mtime, or shard_mtime", () => {
		appendPredictionRow(dir, sampleRow({ session_id: "sess-2" }));
		appendPredictionRow(dir, sampleRow({ source_mtime: "2026-05-10T12:00:00.001Z" }));
		appendPredictionRow(dir, sampleRow({ shard_mtime: "2026-05-10T12:01:00.001Z" }));
		const found = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found).toBeNull();
	});

	it("tolerates malformed JSONL lines (skips them, returns matching valid rows)", () => {
		appendPredictionRow(dir, sampleRow());
		const path = join(dir, ".interlinked", "graph-predictions.jsonl");
		const existing = readFileSync(path, "utf8");
		writeFileSync(path, `garbage line not json\n${existing}{ broken json\n`);
		const found = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found?.shard_path).toBe("src/foo.graph.ts");
	});

	it("returns null when the JSONL file does not yet exist", () => {
		const found = findPredictionRow(dir, {
			session_id: "sess-x",
			file_path: "src/x.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found).toBeNull();
	});

	it("returns null (instead of throwing) when the predictions path exists but cannot be read as a file", () => {
		const path = join(dir, ".interlinked", "graph-predictions.jsonl");
		// A directory at the log path exists but readFileSync on it throws
		// EISDIR — this exercises the read-error catch, distinct from the
		// "does not exist" case above.
		mkdirSync(path, { recursive: true });
		const found = findPredictionRow(dir, {
			session_id: "sess-1",
			file_path: "src/foo.ts",
			source_mtime: "2026-05-10T12:00:00.000Z",
			shard_mtime: "2026-05-10T12:01:00.000Z",
		});
		expect(found).toBeNull();
	});
});

describe("appendReconciliationRow — predictions-vs-reality log", () => {
	const recon = (overrides: Partial<GraphReconciliationRow> = {}): GraphReconciliationRow => ({
		session_id: "sess-1",
		file_path: "src/foo.ts",
		source_mtime: "2026-05-10T12:00:00Z",
		shard_mtime: "2026-05-10T12:01:00Z",
		reconciled_at: "2026-05-10T12:05:00Z",
		severity: "low",
		decision: "reveal_and_allow",
		triggers: [],
		high_impact_oracle: false,
		per_section_score: { "deps.imports": 1.0 },
		weighted_avg: 0.85,
		oracle_summary: {
			risk: "MEDIUM",
			direct: 3,
			transitive: 8,
			domains_count: 1,
			importers_count: 1,
			callers_count: 2,
		},
		prediction_summary: {
			risk: "medium",
			direct: 3,
			transitive: 8,
			domains_count: 1,
			importers_count: 1,
			callers_count: 2,
		},
		miss_set: {},
		...overrides,
	});

	it("appends to graph-reconciliations.jsonl (separate from predictions/observations)", () => {
		appendReconciliationRow(dir, recon());
		const reconPath = join(dir, ".interlinked", "graph-reconciliations.jsonl");
		expect(existsSync(reconPath)).toBe(true);
		expect(existsSync(join(dir, ".interlinked", "graph-predictions.jsonl"))).toBe(false);
		expect(existsSync(join(dir, ".interlinked", "graph-observations.jsonl"))).toBe(false);
	});

	it("preserves severity / triggers across rows", () => {
		appendReconciliationRow(
			dir,
			recon({ severity: "high", triggers: ["risk_underestimated_low_to_high"] }),
		);
		appendReconciliationRow(dir, recon({ severity: "low", triggers: [] }));
		const path = join(dir, ".interlinked", "graph-reconciliations.jsonl");
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(nonNull(lines[0]));
		const second = JSON.parse(nonNull(lines[1]));
		expect(first.severity).toBe("high");
		expect(first.triggers).toEqual(["risk_underestimated_low_to_high"]);
		expect(second.severity).toBe("low");
	});

	it("retains the oracle + prediction summaries (for retrospective analysis)", () => {
		appendReconciliationRow(dir, recon());
		const path = join(dir, ".interlinked", "graph-reconciliations.jsonl");
		const row = JSON.parse(readFileSync(path, "utf8").trim());
		expect(row.oracle_summary.risk).toBe("MEDIUM");
		expect(row.prediction_summary.risk).toBe("medium");
		expect(typeof row.weighted_avg).toBe("number");
		expect(typeof row.reconciled_at).toBe("string");
	});
});

describe("appendObservationRow", () => {
	const obs = (overrides: Partial<GraphObservationRow> = {}): GraphObservationRow => ({
		session_id: "sess-1",
		file_path: "src/x.ts",
		case: "D",
		tool_input_hash: "abc",
		emitted_at: "2026-05-10T12:00:00Z",
		...overrides,
	});

	it("appends to the observations JSONL (separate file from predictions)", () => {
		appendObservationRow(dir, obs());
		const obsPath = join(dir, ".interlinked", "graph-observations.jsonl");
		expect(existsSync(obsPath)).toBe(true);
		const predPath = join(dir, ".interlinked", "graph-predictions.jsonl");
		expect(existsSync(predPath)).toBe(false);
	});

	it("supports B/C/D/E-stale cases (predictions JSONL is reserved for E-fresh)", () => {
		appendObservationRow(dir, obs({ case: "B" }));
		appendObservationRow(dir, obs({ case: "C" }));
		appendObservationRow(dir, obs({ case: "D" }));
		appendObservationRow(dir, obs({ case: "E-stale" }));
		const obsPath = join(dir, ".interlinked", "graph-observations.jsonl");
		const lines = readFileSync(obsPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(4);
	});
});
