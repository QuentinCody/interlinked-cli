import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Behavioral tests for suggestion-scorer.ts — score/rank/filter heuristic
// findings, format them as warning strings, and append telemetry JSONL.
// All I/O is exercised against a real tmp dir (deterministic, self-cleaning).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	type Finding,
	formatScoredFindings,
	scoreFindings,
	writeTelemetry,
} from "./suggestion-scorer.js";
import type { FileSuppressions, InlineSuppressions } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

// --- fixtures -------------------------------------------------------------

const NO_INLINE: InlineSuppressions = new Map();
const NO_FILE: FileSuppressions = new Set();

function finding(over: Partial<Finding> = {}): Finding {
	return {
		check: "sql-injection",
		line: 10,
		message: "raw SQL concatenation",
		source: "security",
		...over,
	};
}

/** Minimal session — scoreFindings only ever reads `files_written`. */
function sessionWith(...written: string[]): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{ files_written: new Set(written) } });
}

/** Base opts that satisfy the required suppression maps. */
function baseOpts(over: Partial<Parameters<typeof scoreFindings>[1]> = {}) {
	return {
		filePath: "src/db.ts",
		inlineSuppressions: NO_INLINE,
		fileSuppressions: NO_FILE,
		...over,
	};
}

// =========================================================================
// scoreFindings
// =========================================================================

describe("scoreFindings", () => {
	it("scores a known-severity finding with no session at full relevance/proximity", () => {
		// no session => fileRelevance 1.0; line>0 but no edit bounds => proximity 0.75
		// not perf => perfBoost 1.0. score = 0.85 * 1.0 * 0.75 * 1.0 = 0.6375
		const out = scoreFindings([finding()], baseOpts());
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).score).toBeCloseTo(0.6375, 6);
		// the spread preserves the original finding fields
		expect(nonNull(out[0]).check).toBe("sql-injection");
		expect(nonNull(out[0]).message).toBe("raw SQL concatenation");
	});

	it("falls back to default base severity (0.5) for an unknown check", () => {
		// 0.5 * 1.0 * 0.75 * 1.0 = 0.375 -> below default threshold 0.5 -> filtered out
		const out = scoreFindings([finding({ check: "totally-unknown-check" })], baseOpts());
		expect(out).toHaveLength(0);
	});

	it("keeps an unknown-check finding when threshold is lowered", () => {
		const out = scoreFindings(
			[finding({ check: "totally-unknown-check" })],
			baseOpts({ threshold: 0 }),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).score).toBeCloseTo(0.375, 6);
	});

	it("skips suppressed findings entirely (suppression always wins)", () => {
		const fileSupp: FileSuppressions = new Set(["sql-injection"]);
		const out = scoreFindings([finding()], baseOpts({ fileSuppressions: fileSupp }));
		expect(out).toHaveLength(0);
	});

	it("applies file-relevance 1.0 when the session wrote this exact file", () => {
		const out = scoreFindings(
			[finding()],
			baseOpts({ session: sessionWith("src/db.ts") }),
		);
		// 0.85 * 1.0 * 0.75 * 1.0 = 0.6375
		expect(nonNull(out[0]).score).toBeCloseTo(0.6375, 6);
	});

	it("applies file-relevance 0.5 when the session did NOT write this file", () => {
		const out = scoreFindings(
			[finding()],
			baseOpts({ session: sessionWith("src/other.ts") }),
		);
		// 0.85 * 0.5 * 0.75 * 1.0 = 0.31875 -> below threshold -> filtered
		expect(out).toHaveLength(0);
		// confirm it WAS scored at the half-relevance value by dropping threshold
		const out2 = scoreFindings(
			[finding()],
			baseOpts({ session: sessionWith("src/other.ts"), threshold: 0 }),
		);
		expect(nonNull(out2[0]).score).toBeCloseTo(0.31875, 6);
	});

	it("uses edit proximity 1.0 when finding is within 20 lines of the edit region", () => {
		const out = scoreFindings(
			[finding({ line: 30 })],
			baseOpts({ editStartLine: 25, editEndLine: 40 }),
		);
		// dist = min(|30-25|, |30-40|) = 5 < 20 => proximity 1.0
		// 0.85 * 1.0 * 1.0 * 1.0 = 0.85
		expect(nonNull(out[0]).score).toBeCloseTo(0.85, 6);
	});

	it("uses edit proximity 0.7 when finding is 20-49 lines away", () => {
		const out = scoreFindings(
			[finding({ line: 100 })],
			baseOpts({ editStartLine: 60, editEndLine: 70 }),
		);
		// dist = min(40, 30) = 30 => 20<=dist<50 => proximity 0.7
		// 0.85 * 1.0 * 0.7 * 1.0 = 0.595
		expect(nonNull(out[0]).score).toBeCloseTo(0.595, 6);
	});

	it("uses edit proximity 0.5 when finding is 50+ lines away", () => {
		const out = scoreFindings(
			[finding({ line: 200 })],
			baseOpts({ editStartLine: 10, editEndLine: 20 }),
		);
		// dist = min(190, 180) = 180 >= 50 => proximity 0.5
		// 0.85 * 1.0 * 0.5 * 1.0 = 0.425 -> below threshold -> filtered
		expect(out).toHaveLength(0);
		const out2 = scoreFindings(
			[finding({ line: 200 })],
			baseOpts({ editStartLine: 10, editEndLine: 20, threshold: 0 }),
		);
		expect(nonNull(out2[0]).score).toBeCloseTo(0.425, 6);
	});

	it("uses default proximity 0.75 when line is 0 even if edit bounds are given", () => {
		const out = scoreFindings(
			[finding({ line: 0 })],
			baseOpts({ editStartLine: 5, editEndLine: 9 }),
		);
		// line>0 is false => proximity stays default 0.75
		// 0.85 * 1.0 * 0.75 * 1.0 = 0.6375
		expect(nonNull(out[0]).score).toBeCloseTo(0.6375, 6);
	});

	it("uses default proximity 0.75 when edit bounds are missing", () => {
		// editStartLine present but editEndLine absent => the && guard is false
		const out = scoreFindings(
			[finding({ line: 30 })],
			baseOpts({ editStartLine: 25 }),
		);
		expect(nonNull(out[0]).score).toBeCloseTo(0.6375, 6);
	});

	it("applies hot-path perf boost for perf- checks (handlers => 0.9)", () => {
		const out = scoreFindings(
			[finding({ check: "perf-query-in-loop", source: "performance" })],
			baseOpts({ filePath: "src/tools/handlers/x.ts" }),
		);
		// base 0.7 * relevance 1.0 * proximity 0.75 * perfBoost 0.9 = 0.4725
		// below threshold -> filtered; verify via threshold 0
		expect(out).toHaveLength(0);
		const out2 = scoreFindings(
			[finding({ check: "perf-query-in-loop", source: "performance" })],
			baseOpts({ filePath: "src/tools/handlers/x.ts", threshold: 0 }),
		);
		expect(nonNull(out2[0]).score).toBeCloseTo(0.4725, 6);
	});

	it("zeroes perf score in test files (hot path likelihood 0)", () => {
		const out = scoreFindings(
			[finding({ check: "perf-await-in-loop", source: "performance" })],
			baseOpts({ filePath: "src/foo.test.ts", threshold: 0 }),
		);
		// perfBoost 0 => score 0
		expect(nonNull(out[0]).score).toBe(0);
	});

	it("does not apply perf boost to non-perf checks even in a cold path", () => {
		const out = scoreFindings(
			[finding({ check: "sql-injection" })],
			baseOpts({ filePath: "src/__tests__/x.test.ts" }),
		);
		// non-perf => perfBoost 1.0 regardless of hot-path likelihood
		expect(nonNull(out[0]).score).toBeCloseTo(0.6375, 6);
	});

	it("sorts descending and slices to the default limit of 3", () => {
		const findings: Finding[] = [
			finding({ check: "silent-catch", line: 1 }), // 0.3 -> below threshold? 0.3*0.75=0.225 filtered
			finding({ check: "sql-injection", line: 2 }), // 0.6375
			finding({ check: "secrets_in_source", line: 3 }), // 0.75*0.75=0.5625
			finding({ check: "recursive-walker-lstat", line: 4 }), // 0.7*0.75=0.525
			finding({ check: "strong-typing", line: 5 }), // 0.65*0.75=0.4875 filtered
		];
		const out = scoreFindings(findings, baseOpts());
		expect(out).toHaveLength(3); // limit
		// descending by score
		expect(nonNull(out[0]).check).toBe("sql-injection"); // 0.6375
		expect(nonNull(out[1]).check).toBe("secrets_in_source"); // 0.5625
		expect(nonNull(out[2]).check).toBe("recursive-walker-lstat"); // 0.525
	});

	it("respects an explicit limit smaller than the number of passing findings", () => {
		const findings: Finding[] = [
			finding({ check: "sql-injection", line: 2 }),
			finding({ check: "secrets_in_source", line: 3 }),
		];
		const out = scoreFindings(findings, baseOpts({ limit: 1 }));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).check).toBe("sql-injection");
	});

	it("returns an empty array when given no findings", () => {
		expect(scoreFindings([], baseOpts())).toEqual([]);
	});

	it("filters out everything below the threshold", () => {
		// silent-catch 0.3 * 0.75 = 0.225 < 0.5
		const out = scoreFindings([finding({ check: "silent-catch" })], baseOpts());
		expect(out).toHaveLength(0);
	});

	it("includes a finding whose score exactly equals the threshold (>=)", () => {
		// Choose threshold equal to the computed score: 0.6375
		const out = scoreFindings([finding()], baseOpts({ threshold: 0.6375 }));
		expect(out).toHaveLength(1);
	});
});

// Exercise every distinct hotPathLikelihood branch through perf scoring.
describe("scoreFindings — hot path likelihood branches (via perf scoring)", () => {
	const perf = (filePath: string): number => {
		const out = scoreFindings(
			[finding({ check: "perf-await-in-loop", source: "performance" })],
			baseOpts({ filePath, threshold: 0 }),
		);
		// score = 0.5 (base) * 1.0 * 0.75 * perfBoost => perfBoost = score / 0.375
		return nonNull(out[0]).score / 0.375;
	};

	it("test paths => 0", () => {
		expect(perf("src/__tests__/a.ts")).toBe(0);
		expect(perf("src/a.test.ts")).toBe(0);
		expect(perf("src/a.spec.ts")).toBe(0);
		expect(perf("a/test/b.ts")).toBe(0);
	});
	it("scripts/migration => 0.1", () => {
		expect(perf("scripts/seed.ts")).toBeCloseTo(0.1, 6);
		expect(perf("src/migration/v1.ts")).toBeCloseTo(0.1, 6);
	});
	it("schema => 0.2", () => {
		expect(perf("src/schema/users.ts")).toBeCloseTo(0.2, 6);
	});
	it("ui => 0.6", () => {
		expect(perf("src/ui/button.ts")).toBeCloseTo(0.6, 6);
	});
	it("codemode => 0.8", () => {
		expect(perf("src/codemode/run.ts")).toBeCloseTo(0.8, 6);
	});
	it("tools/handlers => 0.9", () => {
		expect(perf("src/tools/handlers/x.ts")).toBeCloseTo(0.9, 6);
	});
	it("default => 0.5", () => {
		expect(perf("src/lib/util.ts")).toBeCloseTo(0.5, 6);
	});
});

// =========================================================================
// formatScoredFindings
// =========================================================================

describe("formatScoredFindings", () => {
	it("returns an empty array for no findings", () => {
		expect(formatScoredFindings([])).toEqual([]);
	});

	it("formats a finding with a line reference when line > 0", () => {
		const scored = scoreFindings([finding({ line: 42 })], baseOpts());
		const out = formatScoredFindings(scored);
		expect(out).toEqual(["[interlinked:finding 0.64] raw SQL concatenation (line 42)"]);
	});

	it("omits the line reference when line is 0", () => {
		const scored = scoreFindings([finding({ line: 0 })], baseOpts());
		const out = formatScoredFindings(scored);
		expect(out).toEqual(["[interlinked:finding 0.64] raw SQL concatenation"]);
		expect(out[0]).not.toContain("line");
	});

	it("formats multiple findings, one string each", () => {
		const scored = scoreFindings(
			[
				finding({ check: "sql-injection", line: 2, message: "A" }),
				finding({ check: "secrets_in_source", line: 3, message: "B" }),
			],
			baseOpts(),
		);
		const out = formatScoredFindings(scored);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain("A");
		expect(out[1]).toContain("B");
		// score formatted to two decimals
		expect(out[0]).toMatch(/^\[interlinked:finding \d\.\d{2}\] /);
	});
});

// =========================================================================
// writeTelemetry
// =========================================================================

describe("writeTelemetry", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "scorer-telemetry-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const telemetryOpts = (over: Record<string, unknown> = {}) => ({
		interlinkedDir: dir,
		sessionId: "sess-1",
		agentName: "agent-a",
		filePath: "src/db.ts",
		threshold: 0.5,
		...over,
	});

	it("writes one JSONL line per finding, marking shown vs unshown with scores", () => {
		const all: Finding[] = [
			finding({ check: "sql-injection", line: 2, message: "shown one" }),
			finding({ check: "silent-catch", line: 9, message: "unshown one" }),
		];
		const shown = scoreFindings(all, baseOpts());
		// sql-injection passes (0.6375), silent-catch does not
		expect(shown.map((s) => s.check)).toEqual(["sql-injection"]);

		writeTelemetry(all, shown, telemetryOpts());

		const raw = readFileSync(join(dir, "suggestion-telemetry.jsonl"), "utf-8");
		const records = raw.trim().split("\n").map((l) => JSON.parse(l));
		expect(records).toHaveLength(2);

		const sql = records.find((r) => r.check === "sql-injection");
		expect(sql.shown).toBe(true);
		expect(sql.score).toBeCloseTo(0.6375, 6);
		expect(sql.session_id).toBe("sess-1");
		expect(sql.agent_name).toBe("agent-a");
		expect(sql.file).toBe("src/db.ts");
		expect(sql.threshold).toBe(0.5);
		expect(sql.outcome).toBeNull();
		expect(typeof sql.ts).toBe("string");

		const cat = records.find((r) => r.check === "silent-catch");
		expect(cat.shown).toBe(false);
		expect(cat.score).toBeCloseTo(0.225, 6); // hidden candidates retain their measured score
		expect(cat.line).toBe(9);
	});

	it("creates the target directory if it does not exist", () => {
		const nested = join(dir, "deep", "nested");
		writeTelemetry([finding({ line: 1 })], [], telemetryOpts({ interlinkedDir: nested }));
		const raw = readFileSync(join(nested, "suggestion-telemetry.jsonl"), "utf-8");
		expect(raw.trim().split("\n")).toHaveLength(1);
	});

	it("appends across multiple calls rather than overwriting", () => {
		writeTelemetry([finding({ check: "sql-injection", line: 1 })], [], telemetryOpts());
		writeTelemetry([finding({ check: "secrets_in_source", line: 2 })], [], telemetryOpts());
		const raw = readFileSync(join(dir, "suggestion-telemetry.jsonl"), "utf-8");
		const records = raw.trim().split("\n").map((l) => JSON.parse(l));
		expect(records).toHaveLength(2);
		expect(records[0].check).toBe("sql-injection");
		expect(records[1].check).toBe("secrets_in_source");
	});

	it("writes nothing (no file content) when there are no findings", () => {
		writeTelemetry([], [], telemetryOpts());
		// lines.length === 0 => appendFileSync never called => no file created
		expect(() => readFileSync(join(dir, "suggestion-telemetry.jsonl"), "utf-8")).toThrow();
	});

	it("truncates long messages to 200 chars in telemetry", () => {
		const longMsg = "x".repeat(500);
		writeTelemetry([finding({ line: 1, message: longMsg })], [], telemetryOpts());
		const raw = readFileSync(join(dir, "suggestion-telemetry.jsonl"), "utf-8");
		const rec = JSON.parse(raw.trim());
		expect(rec.message).toHaveLength(200);
	});

	it("is non-fatal when the write fails (interlinkedDir points at a non-dir path)", () => {
		// Pass a path whose parent is a FILE so mkdirSync throws (ENOTDIR),
		// exercising the catch branch. We use the telemetry file of a prior
		// successful write as the bogus "directory".
		writeTelemetry([finding({ line: 1 })], [], telemetryOpts());
		const fileAsDir = join(dir, "suggestion-telemetry.jsonl"); // an existing FILE
		const bogus = join(fileAsDir, "subdir"); // treating a file as a directory
		expect(() =>
			writeTelemetry([finding({ line: 2 })], [], telemetryOpts({ interlinkedDir: bogus })),
		).not.toThrow();
	});

	it("matches shown findings by both check AND line for scoring", () => {
		// Two findings, same check, different lines — only one is "shown".
		const all: Finding[] = [
			finding({ check: "sql-injection", line: 2, message: "near edit" }),
			finding({ check: "sql-injection", line: 999, message: "far edit" }),
		];
		// Constrain the edit region so only line 2 passes the threshold.
		const shown = scoreFindings(all, baseOpts({ editStartLine: 1, editEndLine: 3 }));
		expect(shown).toHaveLength(1);
		expect(nonNull(shown[0]).line).toBe(2);

		writeTelemetry(all, shown, telemetryOpts());
		const records = readFileSync(join(dir, "suggestion-telemetry.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const near = records.find((r) => r.line === 2);
		const far = records.find((r) => r.line === 999);
		expect(near.shown).toBe(true);
		expect(near.score).toBeGreaterThan(0);
		expect(far.shown).toBe(false);
		expect(far.score).toBeCloseTo(0.425, 6);
	});
});
