// Mutation-kill companion for src/harness/error-history.ts.
//
// Targets the 46 (of 58) surviving mutants from the 2026-08-14 fresh
// provenance measure that are killable by strengthening assertions —
// scratch/fleet-r3/receipts/src_harness_error-history.ts.jsonl carries the
// full per-mutant receipt, and every case below is labeled with the exact
// mutantId(s) it kills. Each fixture/assertion pair is also independently
// shadow-verified against the real textual mutation (module rebuild with
// the exact replacement applied + full-output diff, real fs/real clock —
// no vi.mock) in
// scratch/fleet-r3/src_harness_error-history.ts-shadow-verify.mts (44
// mutants) and scratch/fleet-r3/eh-mkdir-shadow-verify.test.mts (2 mutants
// needing a mocked node:fs call count) — both runs report 0 survived.
//
// The remaining 12 survivors are equivalent_candidate (never reachable via
// any observable output — see scratch/fleet-r3/eh-equivalence-fuzz.mts and
// its receipts) and are deliberately NOT re-asserted here.
//
// Same automock-node:fs pattern as the companion error-history.test.ts
// (this file needs it for the appendToDisk/writeToDisk mkdirSync-guard and
// exact-write-content cases); pure-function cases (parseErrorRecord,
// buildErrorContext, buildQueryContext) don't touch fs but share the file
// for one vi.mock scope.

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorHistory, parseErrorRecord } from "./error-history.js";
import type { ErrorMemoryConfig, ModuleRole, StructuralCheckResult } from "./types.js";

vi.mock("node:fs");
const mockFs = vi.mocked(fs);

const NOW = new Date("2026-06-05T00:00:00.000Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	mockFs.existsSync.mockReturnValue(true);
	mockFs.readFileSync.mockReturnValue("");
	mockFs.appendFileSync.mockReturnValue(undefined);
	mockFs.writeFileSync.mockReturnValue(undefined);
	mockFs.mkdirSync.mockReturnValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

const DATA_DIR = "/proj/.interlinked";
const FILE_PATH = "/proj/.interlinked/error-history.jsonl";
const ROLE: ModuleRole = "internal";

function cfg(over: Partial<ErrorMemoryConfig> = {}): ErrorMemoryConfig {
	return { enabled: true, max_age_s: 100, max_records: 5000, ...over };
}
function result(over: Partial<StructuralCheckResult> = {}): StructuralCheckResult {
	return { check: "no-cycles", severity: "error", message: "boom", file: "src/foo.ts", ...over };
}
function freshHistory(config: ErrorMemoryConfig = cfg()): ErrorHistory {
	mockFs.existsSync.mockReturnValue(false);
	const h = new ErrorHistory(DATA_DIR, config);
	mockFs.existsSync.mockReturnValue(true);
	return h;
}

// =============================================================================
// parseErrorRecord — required-field type guards (kills the 6 `typeof X !==
// "string" -> false` mutants: a wrong-typed field would otherwise sail
// through validation and land in a non-null returned record).
// =============================================================================
describe("parseErrorRecord — required-field type guards", () => {
	const base = {
		timestamp: "2026-01-01T00:00:00.000Z",
		session_id: "s1",
		agent_name: "agent",
		file: "proj/a.ts",
		file_role: "internal",
		check_name: "c1",
		severity: "error",
		message: "m",
		diff_context: "d",
	};

	// Kills: f7f79065afc599a5 (typeof timestamp !== "string" -> false)
	// test-contract: public-api — parseErrorRecord is the exported JSONL-row
	// boundary validator; every required field's type guard must reject.
	it("N: rejects a non-string timestamp", () => {
		expect(parseErrorRecord({ ...base, timestamp: 123 })).toBeNull();
	});
	// Kills: 5db005b75ab9dacc (typeof session_id !== "string" -> false)
	// test-contract: public-api — parseErrorRecord's required-field type guard.
	it("N: rejects a non-string session_id", () => {
		expect(parseErrorRecord({ ...base, session_id: 123 })).toBeNull();
	});
	// Kills: 345e28a376856ce4 (typeof agent_name !== "string" -> false)
	// test-contract: public-api — parseErrorRecord's required-field type guard.
	it("N: rejects a non-string agent_name", () => {
		expect(parseErrorRecord({ ...base, agent_name: 123 })).toBeNull();
	});
	// Kills: e6bc6e70844e4ba0 (typeof file !== "string" -> false)
	// test-contract: public-api — parseErrorRecord's required-field type guard.
	it("N: rejects a non-string file", () => {
		expect(parseErrorRecord({ ...base, file: 123 })).toBeNull();
	});
	// Kills: 30b8d2b165a55ea1 (typeof check_name !== "string" -> false)
	// test-contract: public-api — parseErrorRecord's required-field type guard.
	it("N: rejects a non-string check_name", () => {
		expect(parseErrorRecord({ ...base, check_name: 123 })).toBeNull();
	});
	// Kills: 1a3e0387b78c77dc (typeof diff_context !== "string" -> false)
	// test-contract: public-api — parseErrorRecord's required-field type guard.
	it("N: rejects a non-string diff_context", () => {
		expect(parseErrorRecord({ ...base, diff_context: 123 })).toBeNull();
	});

	// Kills: 8f8b39e56b9cc564 (fix_context === "string" -> true: a non-string
	// fix_context would otherwise leak through instead of becoming undefined)
	// test-contract: public-api — parseErrorRecord's optional-field type guard
	// must fail closed to undefined, never leak a wrong-typed value through.
	it("N: drops a non-string fix_context to undefined rather than leaking it", () => {
		expect(parseErrorRecord({ ...base, fix_context: 123 })?.fix_context).toBeUndefined();
	});
	// Kills: 98eddc267d2461ab (line_start === "number" -> true)
	// test-contract: public-api — parseErrorRecord's optional-field type guard.
	it("N: drops a non-number line_start to undefined rather than leaking it", () => {
		expect(parseErrorRecord({ ...base, line_start: "x" })?.line_start).toBeUndefined();
	});
	// Kills: a14a9c56f8f7c5d8 (line_end === "number" -> true)
	// test-contract: public-api — parseErrorRecord's optional-field type guard.
	it("N: drops a non-number line_end to undefined rather than leaking it", () => {
		expect(parseErrorRecord({ ...base, line_end: "x" })?.line_end).toBeUndefined();
	});

	// Kills: 7d3007bfff711d30 (v === "leaf" -> false), 5e3fe69a415ec5f8 ("leaf" -> "")
	// test-contract: public-api — isModuleRole's per-role branch, reachable
	// only through parseErrorRecord's file_role gate.
	it('P: accepts file_role "leaf"', () => {
		expect(parseErrorRecord({ ...base, file_role: "leaf" })?.file_role).toBe("leaf");
	});
	// Kills: e71c65a4161b772a (v === "hub" -> false), 3977c175d7d04c92 ("hub" -> "")
	// test-contract: public-api — isModuleRole's per-role branch.
	it('P: accepts file_role "hub"', () => {
		expect(parseErrorRecord({ ...base, file_role: "hub" })?.file_role).toBe("hub");
	});
	// Kills: 0de7d60fb3444186 (v === "root" -> false), 0e3fbd6b3e0d519b ("root" -> "")
	// test-contract: public-api — isModuleRole's per-role branch.
	it('P: accepts file_role "root"', () => {
		expect(parseErrorRecord({ ...base, file_role: "root" })?.file_role).toBe("root");
	});
	// Kills: edb919e5929d766a (v === "warning" -> false), a871d70804f6d9fb ("warning" -> "")
	// test-contract: public-api — isRecordSeverity's "warning" branch,
	// reachable only through parseErrorRecord's severity gate.
	it('P: accepts severity "warning"', () => {
		expect(parseErrorRecord({ ...base, severity: "warning" })?.severity).toBe("warning");
	});
});

// =============================================================================
// ErrorHistory.buildErrorContext — full-string assertions (the existing
// companion suite uses toContain, which is blind to extra/missing content
// around a matched substring; several caps and separators need an exact or
// negative-containment check instead).
// =============================================================================
describe("ErrorHistory.buildErrorContext — cap/separator mutants", () => {
	// Kills: 8ac9786999bc6da5 (ArrayDeclaration `parts` init [] -> ["Stryker was here"])
	// test-contract: public-api — buildErrorContext is an exported static
	// method consumed by the harness's error-context surface.
	it("N: never leads the output with injected placeholder content", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result(),
		});
		expect(out.startsWith("File:")).toBe(true);
	});

	// Kills: 93078e04c0cddbd5 (exports.slice(0,15) -> exports; drops the cap)
	// test-contract: boundary — the documented 15-export cap.
	it("N: caps the exports list at 15 (item 16+ never appears)", () => {
		const exports = Array.from({ length: 20 }, (_, i) => `e${i}`);
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports,
			result: result(),
		});
		expect(out).toContain("e14");
		expect(out).not.toContain("e15");
	});

	// Kills: d7f20c18657838f8 (exports.length > 15 -> >= 15; boundary)
	// test-contract: boundary — the 15-export cap's exact-15 edge.
	it("N: exactly 15 exports need no overflow suffix (not > 15)", () => {
		const exports = Array.from({ length: 15 }, (_, i) => `e${i}`);
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports,
			result: result(),
		});
		expect(out).not.toContain("more");
	});

	// Kills: d485d0efa6cc080e (affectedFiles.slice(0,8) -> affectedFiles; drops the cap)
	// test-contract: boundary — the documented 8-item Affected cap.
	it("N: caps the Affected list at 8 (item 9+ never appears)", () => {
		const affectedFiles = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result({ affectedFiles }),
		});
		expect(out).toContain("f7.ts");
		expect(out).not.toContain("f8.ts");
	});

	// Kills: a9bf3b12f0ed6cb3 (StringLiteral ", " -> ""; ambiguous between the
	// exports-join and affectedFiles-join sites — this asserts the
	// affectedFiles one directly; the exports one is covered by the "e0, e1"
	// assertion in the pre-existing error-history.test.ts).
	// test-contract: public-api — buildErrorContext's Affected-list format.
	it("N: joins 2+ Affected entries with a comma-space separator", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result({ affectedFiles: ["fa.ts", "fb.ts"] }),
		});
		expect(out).toContain("fa.ts, fb.ts");
	});

	// Kills: 17d6932ff93ed3a8 (oldString.slice(0,400) -> oldString), 4bf9a91c1c0e193b (same, newString)
	// test-contract: boundary — the documented 400-char diff-snippet cap.
	it("N: caps the diff old/new strings at 400 chars each", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result(),
			oldString: `${"x".repeat(400)}OLD_TAIL_BEYOND_400`,
			newString: `${"y".repeat(400)}NEW_TAIL_BEYOND_400`,
		});
		expect(out).not.toContain("OLD_TAIL_BEYOND_400");
		expect(out).not.toContain("NEW_TAIL_BEYOND_400");
	});

	// Kills: 7fcf5b745a4dbf86 (content.slice(0,600) -> content; drops the cap).
	// Uses a marker past position 600 rather than a homogeneous repeated
	// character — a repeated-char fixture (e.g. "z".repeat(1000)) can't
	// distinguish a 600-char slice from the full 1000 chars, since any
	// shorter run of the same character is trivially a substring of a
	// longer one.
	it("N: caps the content branch at 600 chars", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			result: result(),
			content: `${"a".repeat(600)}MARKER_TAIL_CONTENT_BEYOND_600`,
		});
		expect(out).not.toContain("MARKER_TAIL_CONTENT_BEYOND_600");
	});

	// Kills: b3d5bbc8b50891b5 (StringLiteral "\n" -> ""; the final parts.join("\n"))
	it("N: joins output sections with real newlines", () => {
		const out = ErrorHistory.buildErrorContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 1,
			dependencyCount: 0,
			exports: [],
			result: result(),
		});
		expect(out).toContain("\n");
		expect(out.split("\n").length).toBeGreaterThan(1);
	});
});

// =============================================================================
// ErrorHistory.buildQueryContext — mirrors buildErrorContext (no result/
// Check/Error/Affected fields).
// =============================================================================
describe("ErrorHistory.buildQueryContext — cap/separator mutants", () => {
	// Kills: e84d71e0554e5eff (exports cap dropped)
	it("N: caps the exports list at 15", () => {
		const exports = Array.from({ length: 20 }, (_, i) => `s${i}`);
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports,
		});
		expect(out).toContain("s14");
		expect(out).not.toContain("s15");
	});

	// Kills: 8c98045025baf90d (StringLiteral ", " -> ""; exports-join separator)
	it("N: joins exports with a comma-space separator", () => {
		const exports = Array.from({ length: 17 }, (_, i) => `s${i}`);
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports,
		});
		expect(out).toContain("s0, s1");
	});

	// Kills: ea3abdbf0c63caa0 (exports.length > 15 -> >= 15; boundary)
	it("N: exactly 15 exports need no overflow suffix", () => {
		const exports = Array.from({ length: 15 }, (_, i) => `s${i}`);
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports,
		});
		expect(out).not.toContain("more");
	});

	// Kills: b8b73e940b38578b / 75c273a8250e38b6 (oldString/newString cap dropped)
	it("N: caps the change old/new strings at 400 chars each", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			oldString: `${"x".repeat(400)}OLD_TAIL_BEYOND_400`,
			newString: `${"y".repeat(400)}NEW_TAIL_BEYOND_400`,
		});
		expect(out).not.toContain("OLD_TAIL_BEYOND_400");
		expect(out).not.toContain("NEW_TAIL_BEYOND_400");
	});

	// Kills: b8a7bec8302d9f44 (content.slice(0,600) cap dropped) — marker
	// past 600 rather than a homogeneous repeated character (see rationale
	// on the buildErrorContext content-cap case above).
	it("N: caps the content branch at 600 chars", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 0,
			dependencyCount: 0,
			exports: [],
			content: `${"a".repeat(600)}MARKER_TAIL`,
		});
		expect(out).not.toContain("MARKER_TAIL");
	});

	// Kills: e5c96bd2befdbd82 (StringLiteral "\n" -> ""; the final parts.join("\n"))
	it("N: joins output sections with real newlines", () => {
		const out = ErrorHistory.buildQueryContext({
			file: "proj/a.ts",
			fileRole: "leaf",
			dependentCount: 1,
			dependencyCount: 0,
			exports: [],
		});
		expect(out.split("\n").length).toBeGreaterThan(1);
	});
});

// =============================================================================
// load() — cutoff boundary and mkdir-guard-adjacent fs behavior.
// =============================================================================
describe("ErrorHistory.load — cutoff boundary", () => {
	// Kills: b2d3ea61939c0798 (`< cutoff` -> `<= cutoff`): a record exactly AT
	// the cutoff must be KEPT (strict less-than only excludes strictly-older
	// rows).
	it("N: keeps a record exactly at the max_age_s cutoff (strict <, not <=)", () => {
		const maxAgeS = 100;
		const cutoffMs = NOW - maxAgeS * 1000;
		const boundaryRecord = {
			timestamp: new Date(cutoffMs).toISOString(),
			session_id: "s1",
			agent_name: "claude",
			file: "proj/a.ts",
			file_role: ROLE,
			check_name: "no-cycles",
			severity: "error",
			message: "boom",
			diff_context: "",
		};
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(`${JSON.stringify(boundaryRecord)}\n`);
		const h = new ErrorHistory(DATA_DIR, cfg({ max_age_s: maxAgeS }));
		expect(h.size).toBe(1);
	});
});

describe("ErrorHistory — mkdirSync is skipped when the target dir already exists", () => {
	// Kills: f8ffbb63692fbd9e (appendToDisk's `!existsSync(dir)` -> `true`)
	it("N: appendToDisk does not call mkdirSync when the dir exists", async () => {
		const h = freshHistory();
		mockFs.existsSync.mockReturnValue(true);
		mockFs.mkdirSync.mockClear();
		await h.recordError("s", "a", "proj/a.ts", ROLE, result(), "d");
		expect(mockFs.mkdirSync).not.toHaveBeenCalled();
	});

	// Kills: ccd3e31a0a8db3fe (writeToDisk's `!existsSync(dir)` -> `true`)
	it("N: writeToDisk (via recordFix) does not call mkdirSync when the dir exists", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "proj/a.ts", ROLE, result(), "d");
		mockFs.existsSync.mockReturnValue(true);
		mockFs.mkdirSync.mockClear();
		h.recordFix("proj/a.ts", "fix");
		expect(mockFs.mkdirSync).not.toHaveBeenCalled();
	});
});

// =============================================================================
// writeToDisk — exact written content (the existing suite only asserts
// `toHaveBeenCalledTimes`, never what was written).
// =============================================================================
describe("ErrorHistory — writeToDisk exact content", () => {
	// Kills: adbfa120ed5259e8 (whole `content` template -> ``` -> `` — the
	// entire computed string blanked), 080d4886810add80 (the `.join("\n")`
	// separator -> ""), 4a768fdc63466f15 (the `.map((r) => JSON.stringify(r))`
	// callback -> `() => undefined`).
	it("N: writes one JSON line per record, newline-joined, with a trailing newline", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c1" }), "d1");
		await h.recordError("s", "a", "proj/b.ts", ROLE, result({ check: "c2" }), "d2");
		mockFs.writeFileSync.mockClear();
		h.recordFix("proj/a.ts", "fixed");
		const recs = h.getRecords();
		const expected = `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`;
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(FILE_PATH, expected);
	});
});

// =============================================================================
// lookupByFile — its OWN cutoff filter, isolated from load()'s (a record
// that is fresh at load-time but has aged past max_age_s by the time
// lookupByFile runs).
// =============================================================================
describe("ErrorHistory.lookupByFile — own cutoff filter, isolated from load()", () => {
	// Kills: f5f7ace6bd55aeca (drops the whole `.filter(...)` call),
	// 7c03623c7b6073cf (`> cutoff` -> `true`), 4f146ab874256515
	// (`> cutoff` -> `>= cutoff`).
	it("N: excludes a record that ages past max_age_s between load-time and a later lookup", () => {
		const maxAgeS = 100;
		const freshRecord = {
			timestamp: new Date(NOW).toISOString(),
			session_id: "s1",
			agent_name: "claude",
			file: "proj/a.ts",
			file_role: ROLE,
			check_name: "no-cycles",
			severity: "error",
			message: "boom",
			diff_context: "",
		};
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(`${JSON.stringify(freshRecord)}\n`);
		const h = new ErrorHistory(DATA_DIR, cfg({ max_age_s: maxAgeS }));
		// Advance the clock so lookupByFile's freshly-recomputed cutoff now
		// equals the record's timestamp exactly (its OWN `>` must exclude it;
		// load() already accepted it at construction time and is not
		// re-run).
		vi.setSystemTime(NOW + maxAgeS * 1000);
		expect(h.lookupByFile("proj/a.ts")).toEqual([]);
	});
});

// =============================================================================
// getFileHistoryWarning — the top-3 cap and its join separator.
// =============================================================================
describe("ErrorHistory.getFileHistoryWarning — top-3 cap and separator", () => {
	// Kills: 803c8eb27e027047 (drops the `.slice(0, 3)` cap): with 4 distinct
	// checks, one of them must be dropped from the summary. The pre-existing
	// `error-history.test.ts` case only bounds `split(", ").length <= 4`,
	// which the mutant's own (uncapped, 4-item) output also satisfies -- this
	// asserts a dropped entry's ABSENCE directly instead.
	//
	// The dropped entry is c2, not the last-recorded c4: lookupByFile()
	// reverses insertion order (newest-first) before getFileCheckFrequency
	// counts, so the tally Map's insertion order -- which is what the
	// STABLE sort's tie-break among equal counts (c2/c3/c4 all 1x) follows
	// -- becomes [c4, c3, c2, c1], not recording order. Sorted by count
	// desc: [c1:2, c4:1, c3:1, c2:1]; slice(0,3) drops the last one, c2.
	// Verified empirically against real (unmutated) source before pinning
	// this expectation.
	// test-contract: boundary -- the documented top-3 summary cap.
	it("N: caps the summary at the top 3 most-frequent checks", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c2" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c3" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c4" }), "d");
		const msg = h.getFileHistoryWarning("proj/a.ts");
		expect(msg).toContain("c1 (2x), c4 (1x), c3 (1x)");
		expect(msg).not.toContain("c2");
	});

	// Kills: 6d0907e4fbe60171 (StringLiteral ", " -> ""; topChecks join separator)
	it("N: joins 2+ summarized checks with a comma-space separator", async () => {
		const h = freshHistory();
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c1" }), "d");
		await h.recordError("s", "a", "proj/a.ts", ROLE, result({ check: "c2" }), "d");
		const msg = h.getFileHistoryWarning("proj/a.ts");
		expect(msg).toContain("c1 (2x), c2 (1x)");
	});
});
