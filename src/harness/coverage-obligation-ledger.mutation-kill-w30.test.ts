import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CoverageObligation,
	readFileCoverageBaselineEntry,
	readOpenCoverageObligations,
	readRuntimeEstimateMs,
	recordCoverageDischarge,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "./coverage-obligation-ledger.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-ledger-w30-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function baselinePath(): string {
	return join(root, ".interlinked", "coverage-edit-baseline.json");
}

function writeRawBaseline(content: string): void {
	const dir = join(root, ".interlinked");
	mkdirSync(dir, { recursive: true });
	writeFileSync(baselinePath(), content);
}

function obligationsPath(): string {
	return join(root, ".interlinked", "coverage-obligations.jsonl");
}

function appendRawLine(row: unknown): void {
	const dir = join(root, ".interlinked");
	mkdirSync(dir, { recursive: true });
	appendFileSync(obligationsPath(), `${JSON.stringify(row)}\n`);
}

const validObligation: CoverageObligation = {
	kind: "coverage",
	file: "src/a.ts",
	reason: "budget_exceeded",
	estimated_suite_ms: 100,
	budget_ms: 50,
	session_id: "s1",
	timestamp: "2026-01-01T00:00:00.000Z",
};

describe("updateRuntimeEstimateMs — guard boundaries", () => {
	// test-contract: boundary — updateRuntimeEstimateMs rejects measuredMs < 0
	it("rejects a negative measured duration and leaves the estimate unset", () => {
		updateRuntimeEstimateMs(root, -5, () => 0);
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});

	// test-contract: boundary — 0 is the exact lower edge of the accepted range
	it("accepts a zero measured duration and seeds the estimate", () => {
		updateRuntimeEstimateMs(root, 0, () => 0);
		expect(readRuntimeEstimateMs(root)).toBe(0);
	});
});

describe("decodeBaselineValue via readFileCoverageBaselineEntry — non-finite / null / wrong-type inputs", () => {
	// test-contract: invariant — a legacy bare-number baseline must be finite (module header:
	// "a missing or malformed file reads as no data"); JSON overflow literals (1e400) parse to Infinity.
	it("treats a non-finite legacy number (JSON overflow) as no baseline, not Infinity", () => {
		writeRawBaseline(`{"src/a.ts": 1e400}`);
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toBeNull();
	});

	// test-contract: invariant — same finiteness requirement applies to the scoped-object shape's fraction
	it("treats a non-finite fraction inside a scoped object as no baseline", () => {
		writeRawBaseline(`{"src/a.ts": {"f": 1e400, "scope": "full"}}`);
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toBeNull();
	});

	// test-contract: bug — a stored null value must decode to null, not throw
	// (reading `.f` off a null baseline entry would otherwise crash the read path)
	it("does not throw and returns null for a stored null value", () => {
		writeRawBaseline(`{"src/a.ts": null}`);
		expect(() => readFileCoverageBaselineEntry(root, "src/a.ts")).not.toThrow();
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toBeNull();
	});

	// test-contract: public-api — readFileCoverageBaselineEntry's scope field is `string | null`;
	// a non-string stored scope must normalize to null, not pass through
	it("drops a non-string scope on a scoped entry instead of passing it through", () => {
		writeRawBaseline(`{"src/a.ts": {"f": 0.5, "scope": 42}}`);
		expect(readFileCoverageBaselineEntry(root, "src/a.ts")).toEqual({ fraction: 0.5, scope: null });
	});
});

describe("writeFileCoverageBaseline — guard + shape", () => {
	// test-contract: invariant — writeFileCoverageBaseline's own guard ("if (!Number.isFinite(fraction)) return;")
	// must return before any file I/O for a non-finite fraction
	it("does not create the baseline file for a non-finite fraction", () => {
		writeFileCoverageBaseline(root, "src/a.ts", Number.NaN);
		expect(existsSync(baselinePath())).toBe(false);
	});

	// test-contract: public-api — writeFileCoverageBaseline(root, path, fraction) with no scope
	// arg must store the bare fraction (StoredBaselineValue's `number` variant), not an
	// object wrapper with a dropped-undefined scope key
	it("stores an unscoped write as a bare number, not an object", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.5);
		// SAFETY: this file is written exclusively by writeFileCoverageBaseline in this test,
		// so its parsed shape is the CoverageBaseline map asserted below.
		const data = JSON.parse(readFileSync(baselinePath(), "utf-8")) as Record<string, unknown>;
		expect(data).toEqual({ "src/a.ts": 0.5 });
	});
});

describe("readOpenCoverageObligations — obligation-row field validation", () => {
	// test-contract: public-api — recordCoverageObligation + readOpenCoverageObligations round-trip
	it("returns a recorded obligation for its session", () => {
		recordCoverageObligation(root, validObligation);
		expect(readOpenCoverageObligations(root, "s1")).toEqual([validObligation]);
	});

	// test-contract: invariant — parseCoverageObligationFor requires kind === "coverage"
	it("ignores a row whose kind does not match", () => {
		appendRawLine({ ...validObligation, kind: "bogus" });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — parseCoverageObligationFor requires file to be a string
	it("ignores a row whose file is not a string", () => {
		appendRawLine({ ...validObligation, file: 123 });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — parseCoverageObligationFor requires reason === "budget_exceeded"
	it("ignores a row with an unrecognized reason", () => {
		appendRawLine({ ...validObligation, reason: "manual_skip" });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — estimated_suite_ms must be a number even when budget_ms alone is valid
	it("ignores a row whose estimated_suite_ms is not a number", () => {
		appendRawLine({ ...validObligation, estimated_suite_ms: "slow" });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — budget_ms must be a number even when estimated_suite_ms alone is valid
	it("ignores a row whose budget_ms is not a number", () => {
		appendRawLine({ ...validObligation, budget_ms: "cap" });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — parseCoverageObligationFor requires timestamp to be a string
	it("ignores a row whose timestamp is not a string", () => {
		appendRawLine({ ...validObligation, timestamp: 12345 });
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});
});

describe("readOpenCoverageObligations — discharge-row field validation", () => {
	// test-contract: public-api — recordCoverageDischarge closes a matching open obligation
	it("a valid discharge closes an open obligation for the same file", () => {
		recordCoverageObligation(root, validObligation);
		recordCoverageDischarge(root, "src/a.ts", "other-session", "2026-01-02T00:00:00.000Z");
		expect(readOpenCoverageObligations(root, "s1")).toEqual([]);
	});

	// test-contract: invariant — parseCoverageDischarge requires kind === "coverage_discharge"
	it("ignores a discharge-shaped row whose kind does not match", () => {
		recordCoverageObligation(root, validObligation);
		appendRawLine({ kind: "bogus_discharge", file: "src/a.ts", session_id: "s2", timestamp: "2026-01-02T00:00:00.000Z" });
		expect(readOpenCoverageObligations(root, "s1")).toHaveLength(1);
	});

	// test-contract: invariant — session_id must be a string even when timestamp alone is valid
	it("ignores a discharge row whose session_id is not a string", () => {
		recordCoverageObligation(root, validObligation);
		appendRawLine({ kind: "coverage_discharge", file: "src/a.ts", session_id: 123, timestamp: "2026-01-02T00:00:00.000Z" });
		expect(readOpenCoverageObligations(root, "s1")).toHaveLength(1);
	});

	// test-contract: invariant — timestamp must be a string even when session_id alone is valid
	it("ignores a discharge row whose timestamp is not a string", () => {
		recordCoverageObligation(root, validObligation);
		appendRawLine({ kind: "coverage_discharge", file: "src/a.ts", session_id: "s2", timestamp: 999 });
		expect(readOpenCoverageObligations(root, "s1")).toHaveLength(1);
	});
});
