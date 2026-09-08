import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	checkDomainSensitiveTestNudge,
	checkPersistentWarningEscalation,
	checkRepeatedEditWithoutTest,
	checkSuppressionAsWorkaround,
	runBehavioralChecks,
} from "./behavioral-checks.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// Wave-38 survivor-kill suite for src/harness/behavioral-checks.ts
// ===========================================

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();
const FIXED_RECORDED_AT = new Date(FIXED_NOW - 30_000).toISOString();

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
	};
}

function priorRecord(checkName: string, issueCount = 1) {
	return new Map([
		[
			`src/foo.ts::${checkName}`,
			{
				check_name: checkName,
				issue_count: issueCount,
				first_issued_at: 1,
				last_issued_at: issueCount,
				resolved: false,
			},
		],
	]);
}

// --- Mutants 1-3: checkRepeatedEditWithoutTest ---

describe("checkRepeatedEditWithoutTest — mutant kills", () => {
	// test-contract: boundary — count===undefined must short-circuit to null, not fall through
	it("abb5a922: returns null when file_edit_counts has no entry for the path (count undefined)", () => {
		const session = makeSession({ file_edit_counts: new Map() });
		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).toBeNull();
	});

	// test-contract: public-api — source tag must be "structural"
	it("9acbecdb: source is exactly 'structural'", () => {
		const edits = new Map([["src/utils/parser.ts", 3]]);
		const session = makeSession({ file_edit_counts: edits });
		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result?.source).toBe("structural");
	});

	// test-contract: public-api — determinism tag must be "heuristic"
	it("f85f3716: determinism is exactly 'heuristic'", () => {
		const edits = new Map([["src/utils/parser.ts", 3]]);
		const session = makeSession({ file_edit_counts: edits });
		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result?.determinism).toBe("heuristic");
	});
});

// --- Mutants 4-6: checkSuppressionAsWorkaround ---

describe("checkSuppressionAsWorkaround — mutant kills", () => {
	// test-contract: invariant — delta must be current - previous, not current + previous
	it("6217692f: message reports the SUBTRACTED delta, not the sum", () => {
		const failed = new Map([
			[
				"src/index.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });
		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 5, 2);
		expect(result?.message).toContain("3 suppression");
		expect(result?.message).not.toContain("7 suppression");
	});

	// test-contract: public-api — source tag must be "structural"
	it("67cb7ccc: source is exactly 'structural'", () => {
		const failed = new Map([
			[
				"src/index.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });
		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 2, 0);
		expect(result?.source).toBe("structural");
	});

	// test-contract: public-api — determinism tag must be "partially_deterministic"
	it("56b32739: determinism is exactly 'partially_deterministic'", () => {
		const failed = new Map([
			[
				"src/index.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });
		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 2, 0);
		expect(result?.determinism).toBe("partially_deterministic");
	});
});

// --- Mutants 7-8: checkDomainSensitiveTestNudge ---

describe("checkDomainSensitiveTestNudge — mutant kills", () => {
	// test-contract: public-api — source tag must be "structural"
	it("accb5a6f: source is exactly 'structural'", () => {
		const session = makeSession();
		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result?.source).toBe("structural");
	});

	// test-contract: public-api — determinism tag must be "heuristic"
	it("441bd6da: determinism is exactly 'heuristic'", () => {
		const session = makeSession();
		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result?.determinism).toBe("heuristic");
	});
});

// --- Mutant 13: editedLineWithinRadius boundary (<=  vs <) ---

describe("checkPersistentWarningEscalation — editedLineWithinRadius boundary", () => {
	// test-contract: boundary — distance exactly equal to radius must still match (<=, not <)
	it("eb3ce583: escalates when the distance is EXACTLY the radius (3)", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript") });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "typescript", line: 200 }],
			new Set([197]), // |200-197| === 3
		);
		expect(out).toHaveLength(1);
	});
});

// --- Mutant 14: groupEscalationInputs !group -> true (always new group) ---

describe("groupEscalationInputs — group re-use across duplicate names", () => {
	// test-contract: invariant — a second entry with the same name must merge into
	// the EXISTING group (preserving the first entry's determinism), not replace it
	it("9a3bcbe3: merges duplicate-name entries into one group instead of overwriting it", () => {
		const session = makeSession({ warnings_issued: priorRecord("foo") });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[
				{ name: "foo", lines: [900], determinism: "heuristic" },
				{ name: "foo", lines: [10] },
			],
			new Set([10]),
		);
		// heuristic determinism (set by the FIRST entry) is tier-ineligible, so a
		// properly-merged group never escalates.
		expect(out).toEqual([]);
	});
});

// --- Mutants 15 + 17: typeof r === "string" (ConditionalExpression->false, StringLiteral->"") ---

describe("groupEscalationInputs — legacy string-caller name resolution", () => {
	// test-contract: public-api — a bare-string legacy entry's own value IS the check
	// name; it must not fall through to reading `.name` off the string primitive
	it("a0261af3 / ae948531: a legacy string entry resolves its OWN value as the check name", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript") });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("typescript");
	});
});

// --- Mutant 18: group.determinism === undefined -> true (always overwritten) ---

describe("groupEscalationInputs — determinism first-write-wins", () => {
	// test-contract: invariant — the FIRST entry's determinism tag must stick;
	// later entries in the same group must not overwrite it
	it("ca287aba: first entry's determinism tag wins over a later entry's", () => {
		const session = makeSession({ warnings_issued: priorRecord("foo") });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[
				{ name: "foo", lines: [10], determinism: "fully_deterministic" },
				{ name: "foo", lines: [10], determinism: "heuristic" },
			],
			new Set([10]),
		);
		// First tag (fully_deterministic) must win -> tier-eligible -> escalates.
		expect(out).toHaveLength(1);
	});
});

// --- Mutant 24: record.issue_count < 1 -> false ---

describe("checkPersistentWarningEscalation — issue_count floor gate", () => {
	// test-contract: invariant — a record with issue_count 0 (no prior issuance)
	// must never escalate
	it("4cd3abed: issue_count of 0 does NOT escalate", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript", 0) });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(out).toEqual([]);
	});
});

// --- Mutant 26: source "structural" -> "" on the escalated entry ---

describe("checkPersistentWarningEscalation — escalated entry shape", () => {
	// test-contract: public-api — the escalated entry's source tag must be "structural"
	it("680f77b5: escalated entry source is exactly 'structural'", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript") });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(nonNull(out[0]).source).toBe("structural");
	});

	// test-contract: invariant — the message must report issue_count + 1, not - 1
	it("969159ef: message reports issue_count + 1 (ADDED), not subtracted", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript", 2) });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(nonNull(out[0]).message).toContain("issued 3 times");
		expect(nonNull(out[0]).message).not.toContain("issued 1 times");
	});

	// test-contract: public-api — determinism of the escalated entry itself must be
	// "fully_deterministic" regardless of the underlying finding's tag
	it("14d65dc0: escalated entry determinism is exactly 'fully_deterministic'", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript") });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(nonNull(out[0]).determinism).toBe("fully_deterministic");
	});
});

// --- Mutant 29: runBehavioralChecks results array init ArrayDeclaration [] -> ["Stryker was here"] ---

describe("runBehavioralChecks — clean-session output shape", () => {
	// test-contract: invariant — a session with nothing to flag must return an
	// EMPTY array, not one seeded with a placeholder element
	it("fc8050b5: returns exactly [] when no check has anything to report", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/ui/button.ts", []);
		expect(out).toEqual([]);
	});
});

// --- Mutants 30-33: previousSuppressionCount / currentSuppressionCount guard combinations ---

describe("runBehavioralChecks — suppression-count guard (both must be defined)", () => {
	// test-contract: boundary — previous defined but current UNDEFINED must skip
	// step 2 entirely (kills full-true, AND->OR, and current!==undefined->true mutants)
	it("cf117a9c / 3422c101 / 8dfc19e5: current suppression count undefined skips the check", () => {
		const failed = new Map([
			[
				"src/foo.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[],
			2,
			undefined,
		);
		expect(out.some((r) => r.name === "suppression_as_workaround")).toBe(false);
	});

	// test-contract: boundary — current defined but previous UNDEFINED must skip
	// step 2 entirely (kills previous!==undefined->true mutant)
	it("0ef6ab63: previous suppression count undefined skips the check", () => {
		const failed = new Map([
			[
				"src/foo.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[],
			undefined,
			5,
		);
		expect(out.some((r) => r.name === "suppression_as_workaround")).toBe(false);
	});
});
