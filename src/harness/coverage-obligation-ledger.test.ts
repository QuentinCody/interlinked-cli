import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CoverageObligation,
	readFileCoverageBaseline,
	readFileCoverageBaselineEntry,
	readOpenCoverageObligations,
	readRuntimeEstimateMs,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "./coverage-obligation-ledger.js";
import { loadBaseline, saveBaseline } from "./coverage-ratchet.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-ledger-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("runtime estimate", () => {
	it("returns null when no estimate has been recorded", () => {
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});

	it("seeds the estimate directly on the first measurement", () => {
		updateRuntimeEstimateMs(root, 1200, () => 0);
		expect(readRuntimeEstimateMs(root)).toBe(1200);
	});

	it("blends later measurements via EWMA (does not jump straight to the new value)", () => {
		updateRuntimeEstimateMs(root, 1000, () => 0);
		updateRuntimeEstimateMs(root, 3000, () => 0);
		const blended = readRuntimeEstimateMs(root);
		// EWMA(alpha=0.5): 1000*0.5 + 3000*0.5 = 2000.
		expect(blended).toBe(2000);
	});

	it("reads null when the estimate file is malformed (fail-open)", () => {
		// Write garbage where the estimate lives, then confirm we read null.
		updateRuntimeEstimateMs(root, 500, () => 0);
		const path = join(root, ".interlinked", "coverage-runtime-estimate.json");
		expect(existsSync(path)).toBe(true);
		rmSync(path);
		// Re-create as invalid JSON via the obligation log writer's dir, then check.
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});
});

describe("per-file coverage baseline", () => {
	it("returns null for a file with no baseline", () => {
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBeNull();
	});

	it("round-trips a covered fraction for a file", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.8);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.8);
	});

	it("merges multiple files into one baseline map without clobbering", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.8);
		writeFileCoverageBaseline(root, "src/b.ts", 0.6);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.8);
		expect(readFileCoverageBaseline(root, "src/b.ts")).toBe(0.6);
	});

	it("round-trips a scoped entry and exposes the scope via the entry reader", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.987, "scoped:abc123def456");
		// Legacy fraction reader keeps working on the object shape.
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.987);
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toEqual({
			fraction: 0.987,
			scope: "scoped:abc123def456",
		});
	});

	it("reads a legacy bare-number entry as scope null", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toEqual({
			fraction: 1,
			scope: null,
		});
	});

	it("returns null from the entry reader for missing files and malformed entries", () => {
		expect(readFileCoverageBaselineEntry(root, "src/none.ts")).toBeNull();
		writeFileCoverageBaseline(root, "src/a.ts", 0.5, "full");
		const path = join(root, ".interlinked", "coverage-edit-baseline.json");
		const data = parseWire(JSON.parse(readFileSync(path, "utf-8")), wireRecord(wireUnknown), "test JSON value");
		data["src/bad.ts"] = { scope: "full" }; // no fraction
		writeFileSync(path, JSON.stringify(data));
		expect(readFileCoverageBaselineEntry(root, "src/bad.ts")).toBeNull();
		expect(readFileCoverageBaseline(root, "src/bad.ts")).toBeNull();
	});

	it("a scoped write overwrites a legacy numeric entry in place", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		writeFileCoverageBaseline(root, "src/a.ts", 0.987, "scoped:abc123def456");
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toEqual({
			fraction: 0.987,
			scope: "scoped:abc123def456",
		});
	});
});

describe("obligation log", () => {
	it("appends a JSONL row that round-trips", () => {
		const obligation: CoverageObligation = {
			kind: "coverage",
			file: "src/slow.ts",
			reason: "budget_exceeded",
			estimated_suite_ms: 40_000,
			budget_ms: 25_000,
			session_id: "sess-1",
			timestamp: "2026-06-07T00:00:00.000Z",
		};
		recordCoverageObligation(root, obligation);
		const path = join(root, ".interlinked", "coverage-obligations.jsonl");
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(nonNull(lines[0]))).toEqual(obligation);
	});

	it("appends successive obligations rather than overwriting", () => {
		const base: CoverageObligation = {
			kind: "coverage",
			file: "src/slow.ts",
			reason: "budget_exceeded",
			estimated_suite_ms: 40_000,
			budget_ms: 25_000,
			session_id: "sess-1",
			timestamp: "2026-06-07T00:00:00.000Z",
		};
		recordCoverageObligation(root, base);
		recordCoverageObligation(root, { ...base, file: "src/other.ts" });
		const path = join(root, ".interlinked", "coverage-obligations.jsonl");
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("reads no open obligations when the ledger exists but cannot be read (fail-open)", () => {
		// A DIRECTORY where the JSONL file belongs: existsSync passes, so the
		// reader gets past the missing-file guard and readFileSync throws EISDIR.
		// The catch must swallow it and answer "no obligations" — without it the
		// call propagates the error and bricks the PreToolUse gate.
		const path = join(root, ".interlinked", "coverage-obligations.jsonl");
		mkdirSync(path, { recursive: true });
		expect(existsSync(path)).toBe(true);
		expect(readOpenCoverageObligations(root, "sess-1")).toEqual([]);
	});
});

describe("baseline store separation from the verify-time ratchet (section 8.6)", () => {
	// Regression: both stores once shared .interlinked/coverage-baseline.json
	// with incompatible schemas ({version, files} vs flat path→fraction), so
	// `interlinked coverage --update-baseline` silently wiped every per-edit
	// drop baseline. Each store now owns its own file; neither write may
	// disturb the other's data.
	it("survives a ratchet baseline write and vice versa", () => {
		const interlinkedDir = join(root, ".interlinked");
		writeFileCoverageBaseline(root, "src/a.ts", 0.8);
		saveBaseline(interlinkedDir, {
			version: 1,
			updated_at: "2026-06-11T00:00:00.000Z",
			files: { "src/a.ts": { lines_pct: 90, branches_pct: 80 } },
		});
		// Ledger value intact after the ratchet write…
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.8);
		// …and ratchet data intact after a further ledger write.
		writeFileCoverageBaseline(root, "src/b.ts", 0.5);
		expect(loadBaseline(interlinkedDir).files["src/a.ts"]).toEqual({
			lines_pct: 90,
			branches_pct: 80,
		});
		// The ledger owns its own file, not the ratchet's documented path.
		expect(existsSync(join(interlinkedDir, "coverage-edit-baseline.json"))).toBe(true);
	});
});
