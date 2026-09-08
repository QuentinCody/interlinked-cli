// Behavioral unit tests for ErrorHistory — cross-session error memory.
//
// ErrorHistory is pure given (a) its constructor config and (b) the filesystem
// + wall clock. We automock `node:fs` (the writer.test.ts / imports.test.ts
// pattern) so existsSync / readFileSync / appendFileSync / writeFileSync /
// mkdirSync are fully controlled — no real disk — and pin the clock with
// vi.useFakeTimers so every age-cutoff branch (load filter, lookupByFile
// filter) is deterministic. `node:path` (dirname / join) is left real: it is
// pure and the assertions inspect the joined error-history.jsonl path.
//
// Coverage intent: every export and every branch — the recordError severity
// ternary and optional-chaining, recordFix's first-unfixed scan + early
// return, lookupByFile's `|| []` and reverse, getFileHistoryWarning's
// unfixed>0 vs all-resolved arms, both static context builders' if/ternary
// ladder (exports>15 +N more, oldString&&newString vs content vs neither),
// load's existsSync gate + per-line JSON.parse catch + outer readFileSync
// catch + age skip, indexRecord first-vs-existing bucket, appendToDisk /
// writeToDisk mkdir-when-missing + swallowed throws, and enforceMaxRecords'
// under-cap return vs splice+reindex+rewrite.

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { ErrorHistory, parseErrorRecord } from "./error-history.js";
import type {
	ErrorMemoryConfig,
	ErrorRecord,
	ModuleRole,
	StructuralCheckResult,
} from "./types.js";

vi.mock("node:fs");

const mockFs = vi.mocked(fs);

// A fixed "now" so age math is deterministic. 2026-06-05T00:00:00Z.
const NOW = new Date("2026-06-05T00:00:00.000Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	// Default: no history file on disk, all dirs exist. Individual tests
	// override these implementations.
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readFileSync.mockReturnValue("");
	mockFs.appendFileSync.mockReturnValue(undefined);
	mockFs.writeFileSync.mockReturnValue(undefined);
	mockFs.mkdirSync.mockReturnValue(undefined);
});

// vitest 4: resetAllMocks keeps the automock in place (restoreAllMocks would
// un-mock node:fs and leak the real module) while clearing call history.
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

// --- fixture helpers ---------------------------------------------------------

const DATA_DIR = "/proj/.interlinked";
const FILE_PATH = "/proj/.interlinked/error-history.jsonl";
const DIR = "/proj/.interlinked";

function cfg(over: Partial<ErrorMemoryConfig> = {}): ErrorMemoryConfig {
	return { enabled: true, max_age_s: 7 * 24 * 60 * 60, max_records: 5000, ...over };
}

function result(over: Partial<StructuralCheckResult> = {}): StructuralCheckResult {
	return {
		check: "no-cycles",
		severity: "error",
		message: "circular dependency",
		file: "src/foo.ts",
		...over,
	};
}

// A real ModuleRole value (not "core" — that was never a valid member of the
// union and only compiled via an unsafe cast; parseErrorRecord's file_role
// gate now rejects anything outside "leaf"|"internal"|"hub"|"root").
const ROLE: ModuleRole = "internal";

/** Fresh ErrorHistory with no file on disk (existsSync(filePath) === false). */
function freshHistory(config: ErrorMemoryConfig = cfg()): ErrorHistory {
	mockFs.existsSync.mockReturnValue(false);
	const h = new ErrorHistory(DATA_DIR, config);
	// Reset to the all-exist default for the body of the test.
	mockFs.existsSync.mockReturnValue(true);
	return h;
}

function rec(over: Partial<ErrorRecord> = {}): ErrorRecord {
	return {
		timestamp: new Date(NOW).toISOString(),
		session_id: "s1",
		agent_name: "claude",
		file: "src/a.ts",
		file_role: ROLE,
		check_name: "no-cycles",
		severity: "error",
		message: "boom",
		diff_context: "",
		...over,
	};
}

// =============================================================================
// parseErrorRecord — the JSONL-row boundary validator behind load()
// =============================================================================

describe("parseErrorRecord — positive (must parse)", () => {
	it("P1: parses a full record, keeping every optional field", () => {
		const input = {
			...rec(),
			affected_files: ["a.ts", "b.ts"],
			fix_context: "patched",
			line_start: 1,
			line_end: 2,
			co_edited_files: ["c.ts"],
			pre_error_sequence: ["Read", "Edit"],
		};
		expect(parseErrorRecord(input)).toEqual(input);
	});

	it("P2: parses a minimal record (required fields only), optionals come back undefined", () => {
		const input = rec();
		const parsed = parseErrorRecord(input);
		expect(parsed).toEqual(input);
		expect(parsed?.affected_files).toBeUndefined();
		expect(parsed?.fix_context).toBeUndefined();
		expect(parsed?.line_start).toBeUndefined();
	});

	it("P3: drops non-string entries from an optional string-array field rather than throwing", () => {
		const input = { ...rec(), affected_files: ["ok.ts", 42, null] };
		// affected_files fails the isStringArray gate as a whole -> undefined,
		// not a partially-filtered array (fail-closed per field, not per-element).
		expect(parseErrorRecord(input)?.affected_files).toBeUndefined();
	});
});

describe("parseErrorRecord — negative (must reject)", () => {
	it("N1: rejects non-object JSON (array)", () => {
		expect(parseErrorRecord(["not", "a", "record"])).toBeNull();
	});

	it("N2: rejects non-object JSON (primitive)", () => {
		expect(parseErrorRecord("just a string")).toBeNull();
		expect(parseErrorRecord(42)).toBeNull();
		expect(parseErrorRecord(null)).toBeNull();
	});

	it("N3: rejects a record missing a required field (message)", () => {
		const { message, ...withoutMessage } = rec();
		void message;
		expect(parseErrorRecord(withoutMessage)).toBeNull();
	});

	it("N4: rejects a file_role outside the leaf|internal|hub|root union", () => {
		expect(parseErrorRecord({ ...rec(), file_role: "core" })).toBeNull();
	});

	it("N5: rejects a severity outside the error|warning union", () => {
		expect(parseErrorRecord({ ...rec(), severity: "info" })).toBeNull();
	});

	it("N6: rejects a wrong-typed required field (message as number)", () => {
		expect(parseErrorRecord({ ...rec(), message: 123 })).toBeNull();
	});
});

// =============================================================================
// constructor / load
// =============================================================================

describe("constructor + load", () => {
	it("starts empty when no history file exists (load early-returns)", () => {
		mockFs.existsSync.mockReturnValue(false);
		const h = new ErrorHistory(DATA_DIR, cfg());
		expect(h.size).toBe(0);
		expect(h.getRecords()).toEqual([]);
		expect(mockFs.readFileSync).not.toHaveBeenCalled();
	});

	it("loads valid in-window records and skips blanks, bad JSON, and stale rows", () => {
		const fresh = rec({ file: "src/fresh.ts", timestamp: new Date(NOW - 1000).toISOString() });
		const stale = rec({
			file: "src/stale.ts",
			// 8 days old > 7-day max_age_s cutoff → skipped.
			timestamp: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const raw = [
			JSON.stringify(fresh),
			"", // blank line skipped
			"   ", // whitespace-only skipped (line.trim() falsy)
			"{not json", // JSON.parse throws → inner catch (void e)
			JSON.stringify(stale),
		].join("\n");
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(raw);

		const h = new ErrorHistory(DATA_DIR, cfg());

		expect(h.size).toBe(1);
		expect(nonNull(h.getRecords()[0]).file).toBe("src/fresh.ts");
		expect(mockFs.readFileSync).toHaveBeenCalledWith(FILE_PATH, "utf-8");
	});

	it("swallows a readFileSync throw (outer catch) and stays empty", () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		const h = new ErrorHistory(DATA_DIR, cfg());
		expect(h.size).toBe(0);
	});
});

// =============================================================================
// recordError
// =============================================================================

describe("recordError", () => {
	it("persists a record, indexes it, appends to disk, and maps severity 'info' → 'warning'", async () => {
		const h = freshHistory();
		await h.recordError(
			"sess",
			"agent",
			"src/a.ts",
			ROLE,
			result({ severity: "info", message: "fyi", affectedFiles: ["src/b.ts"] }),
			"DIFF",
		);

		expect(h.size).toBe(1);
		const r = h.getRecords()[0];
		expect(nonNull(r).severity).toBe("warning"); // info → warning ternary
		expect(nonNull(r).affected_files).toEqual(["src/b.ts"]); // affectedFiles?.map present
		expect(nonNull(r).session_id).toBe("sess");
		expect(nonNull(r).timestamp).toBe(new Date(NOW).toISOString());
		// indexed so lookups see it immediately
		expect(h.lookupByFile("src/a.ts")).toHaveLength(1);
		// appended to disk (not full rewrite)
		expect(mockFs.appendFileSync).toHaveBeenCalledTimes(1);
		expect(mockFs.appendFileSync).toHaveBeenCalledWith(
			FILE_PATH,
			`${JSON.stringify(r)}\n`,
		);
	});

	it("keeps non-info severity and leaves affected_files undefined when absent", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ severity: "error" }), "d");
		const r = h.getRecords()[0];
		expect(nonNull(r).severity).toBe("error"); // ternary false branch
		expect(nonNull(r).affected_files).toBeUndefined(); // affectedFiles?.map → undefined
	});

	it("caps diff_context at 2000 chars", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "x".repeat(3000));
		expect(nonNull(h.getRecords()[0]).diff_context).toHaveLength(2000);
	});

	it("records the `extra` fields when provided (optional-chaining present branch)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d", {
			line_start: 10,
			line_end: 20,
			co_edited_files: ["src/x.ts"],
			pre_error_sequence: ["Read", "Edit"],
		});
		const r = h.getRecords()[0];
		expect(nonNull(r).line_start).toBe(10);
		expect(nonNull(r).line_end).toBe(20);
		expect(nonNull(r).co_edited_files).toEqual(["src/x.ts"]);
		expect(nonNull(r).pre_error_sequence).toEqual(["Read", "Edit"]);
	});

	it("leaves extra fields undefined when `extra` is omitted (optional-chaining absent branch)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		const r = h.getRecords()[0];
		expect(nonNull(r).line_start).toBeUndefined();
		expect(nonNull(r).co_edited_files).toBeUndefined();
		expect(nonNull(r).pre_error_sequence).toBeUndefined();
	});

	it("swallows an appendFileSync throw (appendToDisk catch) without losing the in-memory record", async () => {
		const h = freshHistory();
		mockFs.appendFileSync.mockImplementation(() => {
			throw new Error("ENOSPC");
		});
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		expect(h.size).toBe(1); // memory write survives the disk failure
	});

	it("creates the data dir when missing before appending (appendToDisk mkdir branch)", async () => {
		const h = freshHistory();
		// dir does not exist on the append path
		mockFs.existsSync.mockReturnValue(false);
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(DIR, { recursive: true });
	});
});

// =============================================================================
// enforceMaxRecords (via recordError)
// =============================================================================

describe("enforceMaxRecords", () => {
	it("does nothing while at/under the cap (early return, no rewrite)", async () => {
		const h = freshHistory(cfg({ max_records: 2 }));
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		expect(h.size).toBe(2);
		expect(mockFs.writeFileSync).not.toHaveBeenCalled(); // append-only path
	});

	it("trims oldest excess, reindexes, and rewrites the file once over the cap", async () => {
		const h = freshHistory(cfg({ max_records: 2 }));
		await h.recordError("s", "a", "src/old.ts", ROLE, result(), "first");
		await h.recordError("s", "a", "src/mid.ts", ROLE, result(), "second");
		mockFs.writeFileSync.mockClear();
		await h.recordError("s", "a", "src/new.ts", ROLE, result(), "third");

		expect(h.size).toBe(2);
		const files = h.getRecords().map((r) => r.file);
		expect(files).toEqual(["src/mid.ts", "src/new.ts"]); // oldest spliced off
		// reindex dropped the evicted file from byFile
		expect(h.lookupByFile("src/old.ts")).toEqual([]);
		expect(h.lookupByFile("src/new.ts")).toHaveLength(1);
		expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1); // full rewrite after trim
	});
});

// =============================================================================
// recordFix
// =============================================================================

describe("recordFix", () => {
	it("no-ops when the file has no records (early return, no write)", () => {
		const h = freshHistory();
		h.recordFix("src/unknown.ts", "the fix");
		expect(mockFs.writeFileSync).not.toHaveBeenCalled();
	});

	it("fills fix_context on the most recent UNFIXED record and rewrites disk", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "first");
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "second");
		mockFs.writeFileSync.mockClear();

		h.recordFix("src/a.ts", "patched");

		const recs = h.getRecords();
		// scans from the end → newest unfixed gets the fix
		expect(nonNull(recs[1]).fix_context).toBe("patched");
		expect(nonNull(recs[0]).fix_context).toBeUndefined();
		expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
	});

	it("skips already-fixed trailing records and fills the next unfixed one", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "older");
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "newer");
		h.recordFix("src/a.ts", "fix-newer"); // fills index 1
		mockFs.writeFileSync.mockClear();

		h.recordFix("src/a.ts", "fix-older"); // index 1 already fixed → falls to index 0

		const recs = h.getRecords();
		expect(nonNull(recs[1]).fix_context).toBe("fix-newer");
		expect(nonNull(recs[0]).fix_context).toBe("fix-older");
		expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
	});

	it("does not write when every record for the file is already fixed (loop completes, no break)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "only");
		h.recordFix("src/a.ts", "done"); // fixes the single record
		mockFs.writeFileSync.mockClear();

		h.recordFix("src/a.ts", "again"); // nothing unfixed left

		expect(mockFs.writeFileSync).not.toHaveBeenCalled();
		expect(nonNull(h.getRecords()[0]).fix_context).toBe("done"); // unchanged
	});

	it("caps fix_context at 1000 chars", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		h.recordFix("src/a.ts", "y".repeat(2000));
		expect(nonNull(h.getRecords()[0]).fix_context).toHaveLength(1000);
	});

	it("swallows a writeFileSync throw (writeToDisk catch) but keeps the in-memory fix", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		mockFs.writeFileSync.mockImplementation(() => {
			throw new Error("EROFS");
		});
		h.recordFix("src/a.ts", "patched");
		expect(nonNull(h.getRecords()[0]).fix_context).toBe("patched");
	});

	it("creates the data dir when missing before rewriting (writeToDisk mkdir branch)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		mockFs.existsSync.mockReturnValue(false);
		mockFs.mkdirSync.mockClear();
		h.recordFix("src/a.ts", "patched");
		expect(mockFs.mkdirSync).toHaveBeenCalledWith(DIR, { recursive: true });
	});
});

// =============================================================================
// lookupByFile
// =============================================================================

describe("lookupByFile", () => {
	it("returns [] for an unknown file (`|| []` branch)", () => {
		const h = freshHistory();
		expect(h.lookupByFile("src/nope.ts")).toEqual([]);
	});

	it("returns in-window records newest-first and drops stale ones", () => {
		// Seed via load so we control timestamps precisely.
		const recent = rec({ file: "src/a.ts", message: "recent", timestamp: new Date(NOW - 1000).toISOString() });
		const older = rec({ file: "src/a.ts", message: "older", timestamp: new Date(NOW - 2000).toISOString() });
		const stale = rec({
			file: "src/a.ts",
			message: "stale",
			timestamp: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
		});
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			[JSON.stringify(older), JSON.stringify(recent), JSON.stringify(stale)].join("\n"),
		);
		const h = new ErrorHistory(DATA_DIR, cfg());

		const got = h.lookupByFile("src/a.ts");
		// stale filtered out; .reverse() flips insertion order [older, recent] → [recent, older]
		expect(got.map((r) => r.message)).toEqual(["recent", "older"]);
	});
});

// =============================================================================
// getFileCheckFrequency
// =============================================================================

describe("getFileCheckFrequency", () => {
	it("counts checks per file (the `|| 0` accumulator)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "no-cycles" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "no-cycles" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "dead-export" }), "d");

		const freq = h.getFileCheckFrequency("src/a.ts");
		expect(freq.get("no-cycles")).toBe(2);
		expect(freq.get("dead-export")).toBe(1);
	});

	it("returns an empty map for a file with no records", () => {
		const h = freshHistory();
		expect(h.getFileCheckFrequency("src/x.ts").size).toBe(0);
	});
});

// =============================================================================
// getFileHistoryWarning
// =============================================================================

describe("getFileHistoryWarning", () => {
	it("returns null when the file has no history (records.length === 0)", () => {
		const h = freshHistory();
		expect(h.getFileHistoryWarning("src/x.ts")).toBeNull();
	});

	it("reports the unresolved variant with top-3 checks when some are unfixed (unfixed > 0)", async () => {
		const h = freshHistory();
		// 4 distinct checks so the top-3 slice actually drops one.
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c2" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c3" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c4" }), "d");

		const msg = h.getFileHistoryWarning("src/a.ts");
		expect(msg).not.toBeNull();
		expect(msg).toContain("This file has had 5 check failure(s) across sessions");
		expect(msg).toContain("c1 (2x)"); // most frequent first
		expect(msg).toContain("may still be unresolved");
		// top-3 only: the 4th distinct check by frequency is dropped from the summary
		expect((nonNull(msg)).split(", ").length).toBeLessThanOrEqual(4);
	});

	it("reports the all-resolved variant when every record is fixed (unfixed === 0)", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "src/a.ts", ROLE, result({ check: "c1" }), "d");
		// Fix both records so unfixed becomes 0.
		h.recordFix("src/a.ts", "fix1");
		h.recordFix("src/a.ts", "fix2");

		const msg = h.getFileHistoryWarning("src/a.ts");
		expect(msg).toContain("all resolved");
		expect(msg).toContain("Take extra care");
		expect(msg).not.toContain("may still be unresolved");
	});
});

// =============================================================================
// ErrorHistory.buildErrorContext (static)
// =============================================================================

describe("ErrorHistory.buildErrorContext", () => {
	it("emits all optional sections incl. exports overflow and the diff branch", () => {
		const exports = Array.from({ length: 20 }, (_, i) => `e${i}`);
		const out = ErrorHistory.buildErrorContext({
			file: "src/a.ts",
			fileRole: "core",
			dependentCount: 3,
			dependencyCount: 2,
			exports,
			result: result({ check: "no-cycles", message: "cycle", affectedFiles: ["src/b.ts"] }),
			oldString: "old-code",
			newString: "new-code",
		});
		expect(out).toContain("File: src/a.ts (core)");
		expect(out).toContain("Depended on by: 3 files"); // dependentCount > 0
		expect(out).toContain("Imports from: 2 modules"); // dependencyCount > 0
		expect(out).toContain("e0, e1"); // exports present
		expect(out).toContain("+5 more"); // 20 - 15 overflow ternary
		expect(out).toContain("Check: no-cycles");
		expect(out).toContain("Error: cycle");
		expect(out).toContain("Affected: src/b.ts"); // affectedFiles present
		expect(out).toContain("Diff:\n-old-code\n+new-code"); // oldString && newString branch
	});

	it("omits zero-count/empty sections, uses the content branch, and skips the exports overflow", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: ["only"],
			result: result({ affectedFiles: [] }), // empty → Affected line omitted
			content: "z".repeat(1000),
		});
		expect(out).not.toContain("Depended on by"); // dependentCount === 0
		expect(out).not.toContain("Imports from"); // dependencyCount === 0
		expect(out).toContain("Exports: only");
		expect(out).not.toContain("more"); // 1 export → no overflow
		expect(out).not.toContain("Affected:"); // affectedFiles.length === 0
		expect(out).toContain(`Content: ${"z".repeat(600)}`); // content slice(0,600), no diff
		expect(out).not.toContain("Diff:");
	});

	it("omits exports + affected entirely and emits neither diff nor content when both absent", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [], // exports.length === 0
			result: result({}), // undefined → Affected omitted
		});
		expect(out).not.toContain("Exports:");
		expect(out).not.toContain("Affected:");
		expect(out).not.toContain("Diff:");
		expect(out).not.toContain("Content:");
	});

	it("falls through to neither diff nor content when only oldString is present", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result(),
			oldString: "only-old", // newString missing → && short-circuits, no content fallback
		});
		expect(out).not.toContain("Diff:");
		expect(out).not.toContain("Content:");
	});
});

// =============================================================================
// ErrorHistory.buildQueryContext (static)
// =============================================================================

describe("ErrorHistory.buildQueryContext", () => {
	it("emits all optional sections incl. exports overflow and the change/diff branch", () => {
		const exports = Array.from({ length: 17 }, (_, i) => `s${i}`);
		const out = ErrorHistory.buildQueryContext({
			file: "src/a.ts",
			fileRole: "core",
			dependentCount: 1,
			dependencyCount: 4,
			exports,
			oldString: "old",
			newString: "new",
		});
		expect(out).toContain("File: src/a.ts (core)");
		expect(out).toContain("Depended on by: 1 files");
		expect(out).toContain("Imports from: 4 modules");
		expect(out).toContain("+2 more"); // 17 - 15 overflow
		expect(out).toContain("Change:\n-old\n+new"); // oldString && newString
	});

	it("omits empties, skips overflow, and uses the content branch", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: ["x"],
			content: "c".repeat(1000),
		});
		expect(out).not.toContain("Depended on by");
		expect(out).not.toContain("Imports from");
		expect(out).toContain("Exports: x");
		expect(out).not.toContain("more");
		expect(out).toContain(`Content: ${"c".repeat(600)}`);
		expect(out).not.toContain("Change:");
	});

	it("emits neither change nor content when both diff and content are absent", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
		});
		expect(out).toBe("File: src/a.ts (leaf)");
	});

	it("falls through to neither change nor content when only newString is present", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "src/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			newString: "only-new", // oldString missing → && short-circuits
		});
		expect(out).not.toContain("Change:");
		expect(out).not.toContain("Content:");
	});
});

// =============================================================================
// indexRecord (exercised transitively): first bucket vs append-to-existing
// =============================================================================

describe("indexRecord (via recordError)", () => {
	it("creates a new byFile bucket then appends to it for the same file", async () => {
		const h = freshHistory();
		// First record for the file → !fileRecords branch creates the bucket.
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		// Second record for the same file → existing-bucket branch.
		await h.recordError("s", "a", "src/a.ts", ROLE, result(), "d");
		expect(h.lookupByFile("src/a.ts")).toHaveLength(2);
	});
});
