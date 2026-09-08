import { describe, expect, it } from "vitest";
import {
	computeEffectivenessSummary,
	recordWarningsIssued,
} from "./feedback-effectiveness.js";
import type { SessionTrajectory, WarningRecord } from "./types.js";

// ===========================================
// Helpers
// ===========================================

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_SESSION_STARTED_AT,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		...overrides,
		// SAFETY: this object lists every SessionTrajectory field the current
		// type declares; the cast only silences the checker's inability to
		// prove object-literal-plus-spread completeness, not a real shape gap.
	};
}

function makeRecord(overrides: Partial<WarningRecord>): WarningRecord {
	return {
		check_name: "chk",
		issue_count: 1,
		first_issued_at: 0,
		last_issued_at: 0,
		resolved: false,
		...overrides,
	};
}

// ===========================================
// recordWarningsIssued: string-vs-object item discrimination
// (kills the `typeof item === "string"` mutants — true / false / !== / "")
// ===========================================

describe("recordWarningsIssued — item name resolution", () => {
	// test-contract: public-api — recordWarningsIssued must key warnings_issued
	// by the resolved check name for both evidence shapes it documents accepting.
	it("resolves the check name correctly for both string and object evidence items", () => {
		const session = makeSession();

		recordWarningsIssued(session, "src/foo.ts", ["nameOnly", { name: "objName" }]);

		expect(session.warnings_issued.has("src/foo.ts::nameOnly")).toBe(true);
		expect(session.warnings_issued.get("src/foo.ts::nameOnly")!.check_name).toBe("nameOnly");
		expect(session.warnings_issued.has("src/foo.ts::objName")).toBe(true);
		expect(session.warnings_issued.get("src/foo.ts::objName")!.check_name).toBe("objName");
		// No corrupted keys from a broken ternary (object stringified, or "undefined").
		expect(session.warnings_issued.size).toBe(2);
	});

	// test-contract: invariant — only the {name,line} evidence shape carries
	// line info per the WarningEvidence contract; plain strings never do.
	it("carries the line only for object evidence, never for plain string evidence", () => {
		const session = makeSession();

		recordWarningsIssued(session, "src/foo.ts", [
			"stringCheck",
			{ name: "objectCheck", line: 7 },
		]);

		expect(session.warnings_issued.get("src/foo.ts::stringCheck")!.last_lines).toBeUndefined();
		expect(session.warnings_issued.get("src/foo.ts::objectCheck")!.last_lines).toEqual([7]);
	});
});

// ===========================================
// recordWarningsIssued: line accumulation + !linesByCheck.has(name) reset guard
// ===========================================

describe("recordWarningsIssued — line accumulation per check within one call", () => {
	// test-contract: bug — the `!linesByCheck.has(name)` reset guard must not
	// re-initialize (and thereby drop) an already-accumulating line list.
	it("accumulates multiple lines for the same check name in one evidence array", () => {
		const session = makeSession();

		recordWarningsIssued(session, "src/foo.ts", [
			{ name: "c1", line: 5 },
			{ name: "c1", line: 10 },
			"c2",
		]);

		expect(session.warnings_issued.get("src/foo.ts::c1")!.last_lines).toEqual([5, 10]);
		expect(session.warnings_issued.get("src/foo.ts::c2")!.last_lines).toBeUndefined();
	});
});

// ===========================================
// recordWarningsIssued: finite-number line guard
// (kills the `typeof line === "number" && Number.isFinite(line)` family)
// ===========================================

describe("recordWarningsIssued — finite-number line filtering", () => {
	// test-contract: invariant — the finite-number guard must reject NaN and
	// Infinity, not just non-number typeof values.
	it("drops non-finite line values (NaN, Infinity) instead of recording them", () => {
		const session = makeSession();

		recordWarningsIssued(session, "src/foo.ts", [
			{ name: "nan-check", line: Number.NaN },
			{ name: "inf-check", line: Number.POSITIVE_INFINITY },
		]);

		expect(session.warnings_issued.get("src/foo.ts::nan-check")!.last_lines).toBeUndefined();
		expect(session.warnings_issued.get("src/foo.ts::inf-check")!.last_lines).toBeUndefined();
	});

	// test-contract: invariant — a valid finite line must still pass the guard.
	it("still records a genuinely finite line value", () => {
		const session = makeSession();

		recordWarningsIssued(session, "src/foo.ts", [{ name: "ok-check", line: 42 }]);

		expect(session.warnings_issued.get("src/foo.ts::ok-check")!.last_lines).toEqual([42]);
	});
});

// ===========================================
// recordWarningsIssued: `lines.length > 0` guard on creation (ternary)
// ===========================================

describe("recordWarningsIssued — last_lines on first creation", () => {
	// test-contract: invariant — the creation-time ternary must populate
	// last_lines when the first issuance carries line evidence.
	it("sets last_lines when the first issuance carries a line", () => {
		const session = makeSession();
		recordWarningsIssued(session, "g.ts", [{ name: "d", line: 7 }]);
		expect(session.warnings_issued.get("g.ts::d")!.last_lines).toEqual([7]);
	});

	// test-contract: invariant — the creation-time ternary must fall to
	// undefined (not an empty array) when the first issuance has no line.
	it("leaves last_lines undefined (not an empty array) when the first issuance carries no line", () => {
		const session = makeSession();
		recordWarningsIssued(session, "h.ts", ["e"]);
		expect(session.warnings_issued.get("h.ts::e")!.last_lines).toBeUndefined();
	});
});

// ===========================================
// recordWarningsIssued: `lines.length > 0` guard on re-issue (if-statement)
// ===========================================

describe("recordWarningsIssued — last_lines on re-issue", () => {
	// test-contract: invariant — the re-issue guard must not overwrite an
	// existing last_lines with an empty list when the re-issue has no lines.
	it("preserves the previous last_lines when a re-issue carries no line info", () => {
		const session = makeSession();

		recordWarningsIssued(session, "f.ts", [{ name: "c", line: 1 }]);
		expect(session.warnings_issued.get("f.ts::c")!.last_lines).toEqual([1]);

		recordWarningsIssued(session, "f.ts", ["c"]); // no line this time
		expect(session.warnings_issued.get("f.ts::c")!.last_lines).toEqual([1]);
	});

	// test-contract: invariant — the re-issue guard must overwrite last_lines
	// when the re-issue does carry new, non-empty line evidence.
	it("overwrites last_lines when a re-issue does carry new line info", () => {
		const session = makeSession();

		recordWarningsIssued(session, "f.ts", [{ name: "c", line: 1 }]);
		recordWarningsIssued(session, "f.ts", ["c"]); // preserved at [1]
		recordWarningsIssued(session, "f.ts", [{ name: "c", line: 99 }]);

		expect(session.warnings_issued.get("f.ts::c")!.last_lines).toEqual([99]);
	});
});

// ===========================================
// computeEffectivenessSummary: `existing.resolved +=` aggregation
// ===========================================

describe("computeEffectivenessSummary — resolved-count aggregation across records", () => {
	// test-contract: bug — the byCheck aggregation must add each record's
	// resolved contribution, not subtract it.
	it("adds resolved counts across multiple records for the same check (not subtracts)", () => {
		const warnings = new Map<string, WarningRecord>([
			["a.ts::chk", makeRecord({ check_name: "chk", issue_count: 1, resolved: false })],
			["b.ts::chk", makeRecord({ check_name: "chk", issue_count: 1, resolved: true })],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);
		const stats = summary.per_check.find((s) => s.check_name === "chk");

		expect(stats!.times_resolved).toBe(1);
		expect(stats!.times_resolved).not.toBe(-1);
	});
});

// ===========================================
// computeEffectivenessSummary: per-check `stats.issued > 0` guard + division
// ===========================================

describe("computeEffectivenessSummary — per-check resolution_rate", () => {
	// test-contract: boundary — the `stats.issued > 0` guard must return the
	// zero default, not attempt a divide-by-zero, when issued count is 0.
	it("returns exactly 0 (not NaN) when a check has zero issued count", () => {
		const warnings = new Map<string, WarningRecord>([
			["a.ts::zero", makeRecord({ check_name: "zero", issue_count: 0, resolved: false })],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);
		const stats = summary.per_check.find((s) => s.check_name === "zero");

		expect(stats!.resolution_rate).toBe(0);
	});

	// test-contract: bug — the per-check resolution_rate must be a division,
	// not the ArithmeticOperator-mutated multiplication.
	it("divides resolved by issued (not multiplies) for a real resolution rate", () => {
		const warnings = new Map<string, WarningRecord>([
			["a.ts::half", makeRecord({ check_name: "half", issue_count: 2, resolved: true })],
			["b.ts::half", makeRecord({ check_name: "half", issue_count: 2, resolved: false })],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);
		const stats = summary.per_check.find((s) => s.check_name === "half");

		// issued = 4, resolved = 1 -> rate 0.25 (multiply would give 4)
		expect(stats!.times_issued).toBe(4);
		expect(stats!.times_resolved).toBe(1);
		expect(stats!.resolution_rate).toBe(0.25);
	});
});

// ===========================================
// computeEffectivenessSummary: overall `totalResolved / totalIssued` division
// ===========================================

describe("computeEffectivenessSummary — overall_resolution_rate", () => {
	// test-contract: bug — overall_resolution_rate must be a division, not
	// the ArithmeticOperator-mutated multiplication.
	it("divides total resolved by total issued (not multiplies)", () => {
		const warnings = new Map<string, WarningRecord>([
			["a.ts::x", makeRecord({ check_name: "x", issue_count: 3, resolved: true })],
			["b.ts::y", makeRecord({ check_name: "y", issue_count: 1, resolved: false })],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);

		// issued = 4, resolved = 1 -> rate 0.25 (multiply would give 4)
		expect(summary.total_issued).toBe(4);
		expect(summary.total_resolved).toBe(1);
		expect(summary.overall_resolution_rate).toBe(0.25);
	});
});
