import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkDomainSensitiveTestNudge,
	checkPersistentWarningEscalation,
	checkRepeatedEditWithoutTest,
	checkSuppressionAsWorkaround,
	runBehavioralChecks,
} from "../behavioral-checks.js";
import type { CheckResultEntry, SessionTrajectory } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Fixed, deterministic timestamps. Session start is 60s before "now";
// last_coordination is "now". Values are arbitrary but stable.
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
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

// ===========================================
// 1. checkRepeatedEditWithoutTest
// ===========================================

describe("checkRepeatedEditWithoutTest", () => {
	it("fires when file_edit_counts >= 3 and no test_runs", () => {
		const edits = new Map([["src/utils/parser.ts", 3]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).not.toBeNull();
		expect(result!.name).toBe("repeated_edit_without_test");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("3 times");
	});

	it("does NOT fire when file_edit_counts < 3", () => {
		const edits = new Map([["src/utils/parser.ts", 2]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire when test_runs has entries", () => {
		const edits = new Map([["src/utils/parser.ts", 5]]);
		const tests = new Map([
			["src/utils/parser.test.ts", { status: "pass" as const, at_step: 2 }],
		]);
		const session = makeSession({ file_edit_counts: edits, test_runs: tests });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire for test files (path contains .test.)", () => {
		const edits = new Map([["src/utils/parser.test.ts", 5]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.test.ts");
		expect(result).toBeNull();
	});
});

// ===========================================
// 2. checkSuppressionAsWorkaround
// ===========================================

describe("checkSuppressionAsWorkaround", () => {
	it("fires when currentSuppression > previousSuppression AND file in failed_files", () => {
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
		expect(result).not.toBeNull();
		expect(result!.name).toBe("suppression_as_workaround");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("2 suppression");
	});

	it("does NOT fire when currentSuppression <= previousSuppression", () => {
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

		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 1, 1);
		expect(result).toBeNull();
	});

	it("does NOT fire when file NOT in failed_files", () => {
		const session = makeSession({ failed_files: new Map() });

		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 3, 1);
		expect(result).toBeNull();
	});
});

// ===========================================
// 3. checkDomainSensitiveTestNudge
// ===========================================

describe("checkDomainSensitiveTestNudge", () => {
	it("fires for path like src/auth/login.ts with empty test_runs", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result).not.toBeNull();
		expect(result!.name).toBe("domain_sensitive_test_nudge");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("auth");
	});

	it("fires for src/crypto/aes.c", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/crypto/aes.c");
		expect(result).not.toBeNull();
		expect(result!.message).toContain("crypto");
	});

	it("does NOT fire for src/ui/button.ts", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/ui/button.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire when test_runs has entries", () => {
		const tests = new Map([["src/auth/auth.test.ts", { status: "pass" as const, at_step: 1 }]]);
		const session = makeSession({ test_runs: tests });

		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result).toBeNull();
	});
});

// ===========================================
// 4. checkPersistentWarningEscalation
// ===========================================

describe("checkPersistentWarningEscalation", () => {
	it("escalates when warnings_issued has matching file::check entry", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 2,
					last_issued_at: 4,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
		expect(nonNull(results[0]).name).toBe("persistent_warning_escalation");
		expect(nonNull(results[0]).message).toContain("typescript");
	});

	it("does NOT escalate for checks not previously issued", () => {
		const session = makeSession({ warnings_issued: new Map() });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(0);
	});

	it("does NOT escalate for different files", () => {
		const warnings = new Map([
			[
				"src/bar.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 2,
					first_issued_at: 1,
					last_issued_at: 3,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(0);
	});
});

// ===========================================
// 5. checkPersistentWarningEscalation — diff-aware proximity (refinement 2026-05)
// ===========================================
//
// Captures the FP class where pre-existing findings re-fire on every edit
// to a file (regardless of whether the edit touched their lines), causing
// the escalation to amplify the noise without value. The two refinements
// gate that behavior:
//   1. once-per-record rate limit (no amplification across an edit storm)
//   2. edited-line proximity (only escalate findings near the edit)

describe("checkPersistentWarningEscalation — diff-aware refinement", () => {
	function priorRecord(checkName: string, lines: number[]) {
		return new Map([
			[
				`src/foo.ts::${checkName}`,
				{
					check_name: checkName,
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 1,
					resolved: false,
					last_lines: lines,
				},
			],
		]);
	}

	it("suppresses escalation when the edit's lines are FAR from the finding's line", () => {
		// Pre-existing finding at line 200 of the file. Agent's current edit
		// is at lines 1-3 — completely unrelated. No escalation.
		const session = makeSession({ warnings_issued: priorRecord("magic_literal", [200]) });
		const editedLines = new Set([1, 2, 3]);
		const currentResults = [{ name: "magic_literal", line: 200 }];

		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			currentResults,
			editedLines,
		);
		expect(out).toEqual([]);
	});

	it("STILL escalates when the edit's lines are NEAR the finding's line", () => {
		// Agent edited line 198 — finding at line 200 is within ±3.
		// Persistent warning still nags.
		const session = makeSession({ warnings_issued: priorRecord("magic_literal", [200]) });
		const editedLines = new Set([198]);
		const currentResults = [{ name: "magic_literal", line: 200 }];

		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			currentResults,
			editedLines,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).name).toBe("persistent_warning_escalation");
	});

	it("rate-limits — fires once per (file, check) per session, not on every re-edit", () => {
		const warnings = priorRecord("magic_literal", [200]);
		const session = makeSession({ warnings_issued: warnings });
		const editedLines = new Set([198]);
		const currentResults = [{ name: "magic_literal", line: 200 }];

		// First escalation in the session fires.
		const first = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			currentResults,
			editedLines,
		);
		expect(first).toHaveLength(1);

		// Second consecutive edit on the same file → still in agency range,
		// the issue still persists, but the once-per-record gate suppresses it.
		const second = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			currentResults,
			editedLines,
		);
		expect(second).toEqual([]);
	});

	it("fails open (escalates) when editedLines is omitted — legacy callers preserved", () => {
		const session = makeSession({ warnings_issued: priorRecord("typescript", [50]) });
		// String[]-shaped legacy call — no line info, no edit info — old behavior.
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(out).toHaveLength(1);
	});

	it("fails open when editedLines is empty (e.g. tool we couldn't decode)", () => {
		const session = makeSession({ warnings_issued: priorRecord("magic_literal", [200]) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "magic_literal", line: 200 }],
			new Set(),
		);
		expect(out).toHaveLength(1);
	});

	// --- FALSE-POSITIVE regression: stable pre-existing findings on UNTOUCHED
	// lines must not escalate when the edit touched an unrelated region. This
	// is the exact production FP: the agent edited lines around 300, while a
	// pre-existing advisory sat on line 18 — the escalation amplified it to an
	// error every single edit. With per-finding line attribution + fail-closed
	// (when edit data is present), the finding's own line decides agency.

	it("FP: pre-existing finding (lines from `lines[]`) FAR from a real edit does NOT escalate", () => {
		// Finding fired on lines 18 + 655 (recovered from a detail block); the
		// agent's edit touched lines 298-318. None within ±3. No escalation.
		// (Default-gate check name — the tier gate must not be what suppresses it.)
		const session = makeSession({ warnings_issued: priorRecord("nan_coercion_guard", [18]) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "nan_coercion_guard", lines: [18, 655] }],
			new Set([298, 299, 300, 301, 302, 318]),
		);
		expect(out).toEqual([]);
	});

	it("FP: finding with NO recoverable line does NOT escalate when edit data is present (fail-closed)", () => {
		// A file-level / line-less finding cannot be attributed to the edited
		// lines, so the agent is not provably responsible. The old gate failed
		// OPEN here (escalated); the sharpened gate fails closed.
		const session = makeSession({ warnings_issued: priorRecord("code_clones", [655]) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "code_clones" }], // no line, no lines[]
			new Set([298, 299, 300]),
		);
		expect(out).toEqual([]);
	});

	it("FP: multi-line finding where EVERY line is far from the edit does NOT escalate", () => {
		const session = makeSession({ warnings_issued: priorRecord("floating_promises", [248]) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "floating_promises", lines: [248, 254, 277, 300] }],
			new Set([700, 701, 702]),
		);
		expect(out).toEqual([]);
	});

	it("TP preserved: a finding on a line the edit ADDED still escalates (lines[] near edit)", () => {
		// The agent edited line 252 and a finding sits on line 254 (within ±3),
		// so the agent IS responsible — the persistent nag must still fire.
		// (Default-gate check id: floating_promises is not advisory-tier.)
		const session = makeSession({ warnings_issued: priorRecord("floating_promises", [254]) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "floating_promises", lines: [254] }],
			new Set([252]),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).name).toBe("persistent_warning_escalation");
	});
});

// ===========================================
// 5c. checkPersistentWarningEscalation — tier gate (noise governance 2026-07)
// ===========================================
//
// persistent_warning_escalation was 18% of the dogfood recurrence log,
// dominated by advisory-tier heuristics (magic_literal_in_conditional,
// complexity, ubs_*) the agent often cannot legitimately fix. The tier gate
// restricts amplification to default-gate, proven-or-low-FP findings:
// advisory ids and heuristic-determinism findings never escalate.

describe("checkPersistentWarningEscalation — advisory/heuristic tier gate", () => {
	function repeatedRecord(checkName: string, issueCount: number) {
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

	it("advisory-tier check repeated 5x does NOT escalate (legacy string path)", () => {
		const session = makeSession({
			warnings_issued: repeatedRecord("magic_literal_in_conditional", 5),
		});
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", [
			"magic_literal_in_conditional",
		]);
		expect(out).toEqual([]);
	});

	it("advisory-tier check does NOT escalate even when its line IS near the edit", () => {
		// Proximity alone must not resurrect an advisory finding.
		const session = makeSession({ warnings_issued: repeatedRecord("complexity", 5) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "complexity", lines: [100], determinism: "heuristic" }],
			new Set([100]),
		);
		expect(out).toEqual([]);
	});

	it("advisory UBS heuristic (ubs_magic_number_no_const) does NOT escalate", () => {
		const session = makeSession({
			warnings_issued: repeatedRecord("ubs_magic_number_no_const", 8),
		});
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", [
			"ubs_magic_number_no_const",
		]);
		expect(out).toEqual([]);
	});

	it("heuristic-determinism finding does NOT escalate even for a non-advisory id", () => {
		// unvalidated_json_sibling is not in the advisory set, but the finding
		// itself is tagged heuristic — the determinism arm of the gate holds.
		const session = makeSession({
			warnings_issued: repeatedRecord("unvalidated_json_sibling", 5),
		});
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "unvalidated_json_sibling", lines: [64], determinism: "heuristic" }],
			new Set([64]),
		);
		expect(out).toEqual([]);
	});

	it.each([
		"external_check_deferred",
		"affected_tests_deferred",
		"project_typecheck_deferred",
		"project_tests_deferred",
	])("operational non-verdict %s never escalates into a source error", (checkName) => {
		const session = makeSession({ warnings_issued: repeatedRecord(checkName, 5) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: checkName, lines: [40], determinism: "fully_deterministic" }],
			new Set([40]),
		);
		expect(out).toEqual([]);
	});

	it("default-gate proven warning (typescript) repeated still escalates as before", () => {
		const session = makeSession({ warnings_issued: repeatedRecord("typescript", 5) });
		const out = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).severity).toBe("error");
		expect(nonNull(out[0]).message).toContain("typescript");
	});

	it("default-gate fully_deterministic finding near the edit still escalates", () => {
		const session = makeSession({ warnings_issued: repeatedRecord("nan_coercion_guard", 2) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "nan_coercion_guard", lines: [40], determinism: "fully_deterministic" }],
			new Set([41]),
		);
		expect(out).toHaveLength(1);
	});

	it("partially_deterministic default-gate finding stays eligible", () => {
		const session = makeSession({ warnings_issued: repeatedRecord("import_resolution", 3) });
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[{ name: "import_resolution", lines: [12], determinism: "partially_deterministic" }],
			new Set([12]),
		);
		expect(out).toHaveLength(1);
	});
});

// ===========================================
// 5b. checkPersistentWarningEscalation via runBehavioralChecks — the production
// integration path. In production, finding line numbers reach the escalation
// only through each CheckResultEntry's `detail` block (the `line` field is
// almost never populated by the inline/quality checks). These tests pin that
// the detail-line recovery + attribution gate together suppress the observed
// FP end-to-end.
// ===========================================

describe("runBehavioralChecks — persistent escalation attribution (detail-line path)", () => {
	function priorRecord(checkName: string): Map<string, import("../types.js").WarningRecord> {
		return new Map([
			[
				`src/foo.ts::${checkName}`,
				{
					check_name: checkName,
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 1,
					resolved: false,
				},
			],
		]);
	}

	// Default-gate determinism so the tier gate is not what suppresses the
	// finding — these cases pin the detail-line attribution path itself.
	function findingWithDetail(
		name: string,
		detail: string,
		determinism: CheckResultEntry["determinism"] = "fully_deterministic",
	): CheckResultEntry {
		return {
			source: "quality",
			name,
			severity: "warning",
			message: `${name} fired`,
			file: "src/foo.ts",
			detail,
			determinism,
		};
	}

	it("FP: pre-existing finding whose detail lines are FAR from the edit does NOT escalate", () => {
		const session = makeSession({
			warnings_issued: priorRecord("nan_coercion_guard"),
			tdd_cycles: new Map(), // no TDD interference
		});
		// Detail block in the harness's canonical `  L<n>: ...` format.
		const detail = "  L18: export function captureGitBaseline(cwd: string): {\n  L655: helper()";
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[findingWithDetail("nan_coercion_guard", detail)],
			undefined,
			undefined,
			new Set([298, 299, 300]), // edit touched an unrelated region
		);
		expect(out.filter((r) => r.name === "persistent_warning_escalation")).toEqual([]);
	});

	it("FP: finding whose detail carries NO line prefix does NOT escalate (fail-closed)", () => {
		const session = makeSession({ warnings_issued: priorRecord("export_surface") });
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[findingWithDetail("export_surface", "exported a new symbol with no companions")],
			undefined,
			undefined,
			new Set([298, 299, 300]),
		);
		expect(out.filter((r) => r.name === "persistent_warning_escalation")).toEqual([]);
	});

	it("TP preserved: a finding whose detail line is NEAR the edit still escalates", () => {
		const session = makeSession({ warnings_issued: priorRecord("floating_promises") });
		const detail = "  L254: void fireAndForget();";
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[findingWithDetail("floating_promises", detail)],
			undefined,
			undefined,
			new Set([252, 253, 254, 255]), // edit landed on the finding's line
		);
		const esc = out.filter((r) => r.name === "persistent_warning_escalation");
		expect(esc).toHaveLength(1);
	});

	it("tier gate holds on the production path: heuristic finding near the edit does NOT escalate", () => {
		const session = makeSession({ warnings_issued: priorRecord("magic_literal_in_conditional") });
		const detail = "  L254: if (cycle.state === 2) return;";
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[findingWithDetail("magic_literal_in_conditional", detail, "heuristic")],
			undefined,
			undefined,
			new Set([252, 253, 254, 255]),
		);
		expect(out.filter((r) => r.name === "persistent_warning_escalation")).toEqual([]);
	});
});

// ===========================================
// 6. extractDetailLines — via runBehavioralChecks (not directly exported)
// ===========================================
//
// Exercises the branch inside extractDetailLines that a `detail`-less finding
// short-circuits to [] (line 163's true arm), plus the extreme-magnitude
// digit string that makes Number.parseInt overflow to Infinity, tripping the
// `Number.isFinite` guard's false arm (line 169).

describe("extractDetailLines (via runBehavioralChecks) — detail-block edge cases", () => {
	it("a finding with NO detail field contributes zero recovered lines (fails closed, no escalation)", () => {
		const session = makeSession({
			warnings_issued: new Map([
				[
					"src/foo.ts::export_surface",
					{
						check_name: "export_surface",
						issue_count: 1,
						first_issued_at: 1,
						last_issued_at: 1,
						resolved: false,
					},
				],
			]),
		});
		const finding: CheckResultEntry = {
			source: "structural",
			name: "export_surface",
			severity: "warning",
			message: "exported a new symbol with no companions",
			file: "src/foo.ts",
			determinism: "fully_deterministic",
			// no `detail` field at all
		};
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[finding],
			undefined,
			undefined,
			new Set([1, 2, 3]),
		);
		expect(out.filter((r) => r.name === "persistent_warning_escalation")).toEqual([]);
	});

	it("an astronomically large L<n> line number overflows to Infinity and is dropped, not escalated", () => {
		const session = makeSession({
			warnings_issued: new Map([
				[
					"src/foo.ts::nan_coercion_guard",
					{
						check_name: "nan_coercion_guard",
						issue_count: 1,
						first_issued_at: 1,
						last_issued_at: 1,
						resolved: false,
					},
				],
			]),
		});
		// 400 nines — Number.parseInt of this digit string overflows past
		// Number.MAX_VALUE to Infinity, which Number.isFinite must reject.
		const hugeDigits = "9".repeat(400);
		const finding: CheckResultEntry = {
			source: "quality",
			name: "nan_coercion_guard",
			severity: "warning",
			message: "nan_coercion_guard fired",
			file: "src/foo.ts",
			detail: `  L${hugeDigits}: something()`,
			determinism: "fully_deterministic",
		};
		const out = runBehavioralChecks(
			session,
			"src/foo.ts",
			[finding],
			undefined,
			undefined,
			new Set([1, 2, 3]),
		);
		// No finite line was recovered, so the diff-aware gate has nothing to
		// compare against an edited line — must fail closed (no escalation).
		expect(out.filter((r) => r.name === "persistent_warning_escalation")).toEqual([]);
	});
});

// ===========================================
// 7. groupEscalationInputs — via checkPersistentWarningEscalation, duplicate
// check names within one currentResults array (not exercised elsewhere).
// ===========================================

describe("checkPersistentWarningEscalation — duplicate finding names in one call", () => {
	it("merges lines from two findings with the SAME check name into one group", () => {
		// First entry establishes the group + its determinism; the second entry
		// (same name) must NOT overwrite the already-set determinism, and its
		// `lines[]` must merge into the same group's line list.
		const session = makeSession({
			warnings_issued: new Map([
				[
					"src/foo.ts::floating_promises",
					{
						check_name: "floating_promises",
						issue_count: 1,
						first_issued_at: 1,
						last_issued_at: 1,
						resolved: false,
					},
				],
			]),
		});
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[
				{ name: "floating_promises", lines: [900], determinism: "fully_deterministic" },
				// Second entry: no determinism (would be ignored since group already
				// has one) and a line that IS near the edit.
				{ name: "floating_promises", lines: [10] },
			],
			new Set([10]),
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).name).toBe("persistent_warning_escalation");
	});

	it("filters non-finite/non-number entries out of a finding's lines[] array", () => {
		const session = makeSession({
			warnings_issued: new Map([
				[
					"src/foo.ts::floating_promises",
					{
						check_name: "floating_promises",
						issue_count: 1,
						first_issued_at: 1,
						last_issued_at: 1,
						resolved: false,
					},
				],
			]),
		});
		const out = checkPersistentWarningEscalation(
			session,
			"src/foo.ts",
			[
				{
					name: "floating_promises",
					lines: [Number.NaN, 900],
					determinism: "fully_deterministic",
				},
			],
			new Set([10]),
		);
		// Only 900 survives the filter, and it's far from the edited line 10 —
		// so no escalation (proves the bad entries were dropped, not counted).
		expect(out).toEqual([]);
	});
});

// ===========================================
// 8. runBehavioralChecks orchestrator — branch coverage for each numbered
// step's guard (steps 1, 2, 3, 5).
// ===========================================

describe("runBehavioralChecks — orchestrator step gating", () => {
	it("step 1 is SKIPPED when a TDD cycle is active for the file (even with 3+ edits, no tests)", () => {
		const edits = new Map([["src/foo.ts", 5]]);
		const cycles = new Map([
			[
				"src/foo.ts",
				{
					source_file: "src/foo.ts",
					test_file: null,
					state: "no_test" as const,
					impl_edits_before_test: 1,
				},
			],
		]);
		const session = makeSession({ file_edit_counts: edits, tdd_cycles: cycles });
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "repeated_edit_without_test")).toBe(false);
	});

	it("step 1 FIRES when no TDD cycle is active and the file was edited 3+ times with no tests", () => {
		const edits = new Map([["src/foo.ts", 3]]);
		const session = makeSession({ file_edit_counts: edits });
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "repeated_edit_without_test")).toBe(true);
	});

	it("step 2 FIRES a suppression finding when counts + failed_files line up", () => {
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
		const out = runBehavioralChecks(session, "src/foo.ts", [], 0, 2);
		expect(out.some((r) => r.name === "suppression_as_workaround")).toBe(true);
	});

	it("step 2 does NOT fire when suppression count did not increase", () => {
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
		const out = runBehavioralChecks(session, "src/foo.ts", [], 2, 2);
		expect(out.some((r) => r.name === "suppression_as_workaround")).toBe(false);
	});

	it("step 3 FIRES the domain-sensitive nudge for a security-domain path", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/auth/login.ts", []);
		expect(out.some((r) => r.name === "domain_sensitive_test_nudge")).toBe(true);
	});

	it("step 3 does NOT fire for a non-security path", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/ui/button.ts", []);
		expect(out.some((r) => r.name === "domain_sensitive_test_nudge")).toBe(false);
	});

	it("step 5a (checkTddCycleViolation) FIRES via the orchestrator when impl edits pile up with no test", () => {
		const cycles = new Map([
			[
				"src/foo.ts",
				{
					source_file: "src/foo.ts",
					test_file: null,
					state: "no_test" as const,
					impl_edits_before_test: 3,
				},
			],
		]);
		const session = makeSession({ tdd_cycles: cycles });
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_cycle_violation")).toBe(true);
	});

	it("step 5a does NOT fire when there is no active TDD cycle for the file", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_cycle_violation")).toBe(false);
	});

	it("step 5b (checkTddRegression) FIRES via the orchestrator on a green→regression transition", () => {
		const cycles = new Map([
			[
				"src/foo.ts",
				{
					source_file: "src/foo.ts",
					test_file: "src/foo.test.ts",
					state: "regression" as const,
					previous_state: "green" as const,
					impl_edits_before_test: 0,
				},
			],
		]);
		const session = makeSession({ tdd_cycles: cycles });
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_regression")).toBe(true);
	});

	it("step 5b does NOT fire when the cycle is not in a regression state", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_regression")).toBe(false);
	});

	it("step 5c (checkTddGreenConfirmation) FIRES via the orchestrator on a red→green transition", () => {
		const cycles = new Map([
			[
				"src/foo.ts",
				{
					source_file: "src/foo.ts",
					test_file: "src/foo.test.ts",
					state: "green" as const,
					previous_state: "red" as const,
					impl_edits_before_test: 0,
				},
			],
		]);
		const session = makeSession({ tdd_cycles: cycles });
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_green_confirmation")).toBe(true);
	});

	it("step 5c does NOT fire when the cycle is not transitioning from red to green", () => {
		const session = makeSession();
		const out = runBehavioralChecks(session, "src/foo.ts", []);
		expect(out.some((r) => r.name === "tdd_green_confirmation")).toBe(false);
	});
});
