import { makeGuardRules } from "./__tests__/fixtures.js";
// Targeted branch-coverage fills for pre-tool-decision-phases.ts, complementing
// the behavioral and reservations suites. Each case below is named after the
// specific uncovered branch it exercises (see coverage/lcov.info gap list).

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { describe, expect, it, vi } from "vitest";

const driveGraphPredictionMock = vi.fn();
vi.mock("../graph-prediction-pre-tool.js", () => ({
	driveGraphPrediction: (...args: unknown[]) => driveGraphPredictionMock(...args),
}));

import { CohortManager } from "../cohort.js";
import {
	type ReservationBatchOptions,
	ReservationManager,
} from "../reservations.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	ReservationConflict,
	SessionTrajectory,
} from "../types.js";
import {
	evaluateAutoReservation,
	evaluateExfilPhase,
	evaluateFileDumpPhase,
	evaluateGraphPrediction,
	evaluateTaintPhase,
	evaluateWriteContent,
	type PreToolCtx,
} from "./pre-tool-decision-phases.js";

const CWD = "/repo";

function makeCtx(): PreToolCtx {
	return { escalation: undefined, contentScan: undefined, graphPredAdditionalContext: undefined };
}

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		session_id: "t",
		agent_name: "agent",
		started_at: "2026-04-01T00:00:00.000Z",
		tool_call_count: 0,
		tool_sequence: [],
		sensitivity_level: "Public",
		soft_blocks: new Set(),
		fired_reminders: new Set(),
		suggested_permissions: new Set(),
		consecutive_pattern: null,
		curl_localhost_count: {},
		injection_detected_steps: [],
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		...overrides,
	} satisfies SessionTrajectory);
}

function makeRules(overrides?: Partial<GuardRulesConfig>): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: { enabled: false, localhost_ports: [], escalate_after: 5, message: "" },
		quality_checks: {},
		structural_checks: { ...makeGuardRules().structural_checks, },
		error_memory: { ...makeGuardRules().error_memory,  enabled: false, max_age_s: 0, max_records: 0 },
		taint_tracking: { ...makeGuardRules().taint_tracking,  enabled: false },
		output_scanning: { ...makeGuardRules().output_scanning,  enabled: false },
		...overrides,
	} satisfies GuardRulesConfig);
}

function mockReservations(conflict: ReservationConflict | null): Pick<ReservationManager, "checkAndReserveBatch"> {
	return ({
		checkAndReserveBatch: ({ filePaths, shouldBlock }: ReservationBatchOptions) => {
			if (!conflict) return null;
			const filePath = filePaths[0] ?? "";
			return shouldBlock(filePath, conflict) ? { filePath, conflict } : null;
		},
	} satisfies Pick<ReservationManager, "checkAndReserveBatch">);
}

// ============================================================
// evaluateAutoReservation — writeTargetPaths cwd fallback (L155)
// ============================================================

describe("evaluateAutoReservation — writeTargetPaths cwd fallback", () => {
	it("falls back to process.cwd() when the event carries no cwd, for an apply_patch payload", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s-cwd",
			agent_source: "codex",
			agent_name: "codex-session",
			tool_name: "apply_patch",
			tool_input: { command: patch },
			timestamp: "2026-07-09T00:00:00Z",
			// deliberately no cwd
		};
		const decision = evaluateAutoReservation(
			event,
			undefined,
			"apply_patch",
			{ command: patch },
			reservations,
			cohort,
			[],
		);
		expect(decision).toBeNull();
		const resolved = `${process.cwd()}/src/a.ts`;
		expect(reservations.checkAndReserve(resolved, "lease-probe", cohort)).not.toBeNull();
	});
});

// ============================================================
// evaluateAutoReservation — remote-block message branches (L172)
// ============================================================

describe("evaluateAutoReservation — remote block message branches", () => {
	it("includes the human clause and 'soon' fallback when human is set and expires_at is empty", () => {
		const conflict: ReservationConflict = {
			agent_name: "remote-bot",
			cohort: "remote",
			expires_at: "",
			human: "Alice",
		};
		const reservations = mockReservations(conflict);
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			agent_name: "writer",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/c.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		const decision = evaluateAutoReservation(
			event,
			undefined,
			"Write",
			{ file_path: `${CWD}/src/c.ts`, content: "x" },
			reservations,
			cohort,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toBe(
			"File reserved by remote-bot (Alice). Expires soon. Coordinate via MCP messages.",
		);
	});

	it("omits the human clause and uses the real expires_at when human is absent", () => {
		const conflict: ReservationConflict = {
			agent_name: "remote-bot",
			cohort: "remote",
			expires_at: "2026-07-09T00:05:00Z",
		};
		const reservations = mockReservations(conflict);
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			agent_name: "writer",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/c.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		const decision = evaluateAutoReservation(
			event,
			undefined,
			"Write",
			{ file_path: `${CWD}/src/c.ts`, content: "x" },
			reservations,
			cohort,
			[],
		);
		expect(decision?.reason).toBe(
			"File reserved by remote-bot. Expires 2026-07-09T00:05:00Z. Coordinate via MCP messages.",
		);
	});
});

// ============================================================
// evaluateAutoReservation — local sibling-lease branches (L205, L208)
// ============================================================

describe("evaluateAutoReservation — local sibling-lease active-count and expiry-fallback branches", () => {
	it("does NOT block when both agents are known, not lineage, but active count is under 2 (L205)", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		cohort.agentJoined({
			hook_event: "SessionStart",
			session_id: "s-me",
			agent_source: "claude",
			agent_name: "me",
			timestamp: "2026-07-10T00:00:00Z",
		});
		cohort.agentJoined({
			hook_event: "SessionStart",
			session_id: "s-holder",
			agent_source: "claude",
			agent_name: "holder",
			timestamp: "2026-07-10T00:00:00Z",
		});
		// Mark "holder" idle so the active count drops below 2 while both
		// agents remain known to the cohort.
		cohort.agentLeft({
			hook_event: "SessionEnd",
			session_id: "s-holder",
			agent_source: "claude",
			agent_name: "holder",
			timestamp: "2026-07-10T00:01:00Z",
		});
		expect(cohort.getCounts().active).toBe(1);
		reservations.checkAndReserve(`${CWD}/src/a.ts`, "holder", cohort);
		const warnings: string[] = [];
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s-me",
			agent_source: "claude",
			agent_name: "me",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/a.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-10T00:02:00Z",
		};
		const decision = evaluateAutoReservation(
			event,
			undefined,
			"Write",
			{ file_path: `${CWD}/src/a.ts`, content: "x" },
			reservations,
			cohort,
			warnings,
		);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes('sibling agent "holder"'))).toBe(true);
	});

	it("uses the '5min' fallback in the block reason when expires_at is empty (L208)", () => {
		const conflict: ReservationConflict = {
			agent_name: "sibling",
			cohort: "local",
			expires_at: "",
		};
		const reservations = mockReservations(conflict);
		const cohort = new CohortManager();
		cohort.agentJoined({
			hook_event: "SessionStart",
			session_id: "s-writer",
			agent_source: "claude",
			agent_name: "writer",
			timestamp: "2026-07-10T00:00:00Z",
		});
		cohort.agentJoined({
			hook_event: "SessionStart",
			session_id: "s-sib",
			agent_source: "claude",
			agent_name: "sibling",
			timestamp: "2026-07-10T00:00:00Z",
		});
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s-writer",
			agent_source: "claude",
			agent_name: "writer",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/a.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-10T00:02:00Z",
		};
		const decision = evaluateAutoReservation(
			event,
			undefined,
			"Write",
			{ file_path: `${CWD}/src/a.ts`, content: "x" },
			reservations,
			cohort,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("TTL 5min");
	});
});

// ============================================================
// evaluateAutoReservation — agentName fallback chain (L238)
// ============================================================

describe("evaluateAutoReservation — agentName fallback chain", () => {
	it("falls back to session.agent_name when event.agent_name is absent", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/d.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		const session = makeSession({ agent_name: "session-agent" });
		expect(
			evaluateAutoReservation(
				event,
				session,
				"Write",
				{ file_path: `${CWD}/src/d.ts`, content: "x" },
				reservations,
				cohort,
				[],
			),
		).toBeNull();
		expect(
			reservations.checkAndReserve(`${CWD}/src/d.ts`, "lease-probe", cohort),
		).not.toBeNull();
	});

	it("falls back to 'unknown' when neither event.agent_name nor session.agent_name is present", () => {
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: `${CWD}/src/e.ts`, content: "x" },
			cwd: CWD,
			timestamp: "2026-07-09T00:00:00Z",
		};
		expect(
			evaluateAutoReservation(
				event,
				undefined,
				"Write",
				{ file_path: `${CWD}/src/e.ts`, content: "x" },
				reservations,
				cohort,
				[],
			),
		).toBeNull();
		expect(reservations.checkAndReserve(`${CWD}/src/e.ts`, "lease-probe", cohort)).not.toBeNull();
	});
});

// ============================================================
// evaluateFileDumpPhase / evaluateExfilPhase — missing command fallback (L266, L292)
// ============================================================

describe("evaluateFileDumpPhase — missing command falls back to empty string", () => {
	it("returns null when a Bash call carries no command key at all", () => {
		const warnings: string[] = [];
		expect(evaluateFileDumpPhase("Bash", {}, warnings)).toBeNull();
		expect(warnings).toEqual([]);
	});
});

describe("evaluateExfilPhase — missing command falls back to empty string", () => {
	it("returns null when a Bash call carries no command key at all", () => {
		const ctx = makeCtx();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "t",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: {},
			cwd: CWD,
			timestamp: "2026-04-01T00:00:00.000Z",
		};
		const decision = evaluateExfilPhase(event, undefined, undefined, "Bash", {}, [], ctx);
		expect(decision).toBeNull();
	});
});

// ============================================================
// evaluateWriteContent — merge of the block's own warnings (L336, truthy side)
// ============================================================

describe("evaluateWriteContent — merges the block decision's own non-empty warnings", () => {
	it("carries a prior in-guard warning (invalid JSON) alongside a later block (merge markers)", () => {
		const ctx = makeCtx();
		const outer: string[] = ["[interlinked] outer warning"];
		// Invalid JSON (in a .json file) pushes a soft warning inside
		// evaluateWriteContentGuards; merge-conflict markers in the same
		// content then trip the unconditional block. The block's own
		// `warnings` array (threaded through the guard) is non-empty by the
		// time it returns, exercising the truthy side of the `|| []` merge.
		const content = ["{ not valid json", "<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> branch"].join(
			"\n",
		);
		const decision = evaluateWriteContent(
			{
				hook_event: "PreToolUse",
				session_id: "t",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: {},
				cwd: CWD,
				timestamp: "2026-04-01T00:00:00.000Z",
			},
			undefined,
			makeRules(),
			"Write",
			{ file_path: `${CWD}/config.json`, content },
			outer,
			ctx,
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("Merge conflict markers");
		expect(decision?.warnings).toEqual([
			"[interlinked] outer warning",
			expect.stringContaining("Invalid JSON"),
		]);
	});
});

// ============================================================
// evaluateTaintPhase — merges the block decision's own non-empty warnings (L436, truthy side)
// ============================================================

describe("evaluateTaintPhase — merges the block decision's own non-empty warnings", () => {
	it("carries the step-budget warning alongside the step-limit-exceeded block", () => {
		const ctx = makeCtx();
		const outer: string[] = ["[interlinked] outer warning"];
		const rules = makeRules({
			taint_tracking: {
				enabled: true,
				file_sensitivity: [],
				step_limits: {
					Public: Number.POSITIVE_INFINITY,
					Internal: Number.POSITIVE_INFINITY,
					Confidential: Number.POSITIVE_INFINITY,
					HighlyConfidential: Number.POSITIVE_INFINITY,
				},
				network_block_at: "Confidential",
			},
		});
		// step_limit exceeded (11 > 10) AND at >=95% budget so
		// getStepBudgetWarning pushes into the same local `warnings` array
		// that the step-limit block below then carries out.
		const session = makeSession({ step_limit: 10, tool_call_count: 11 });
		const decision = evaluateTaintPhase(
			rules,
			session,
			"Bash",
			{ command: "echo hi" },
			outer,
			ctx,
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("Step limit (10) exceeded");
		expect(decision?.warnings).toEqual([
			"[interlinked] outer warning",
			expect.stringContaining("[interlinked:budget]"),
		]);
	});
});

// ============================================================
// evaluateGraphPrediction — cwd fallback, block path, additional_context path
// (L382, L384, L387, L393)
// ============================================================

describe("evaluateGraphPrediction — cwd fallback and result-handling branches", () => {
	const enabledConfig = ({ version: 1, server_url: "https://example.test",
		harness: { graph_prediction: { enabled: true, mode: "enforced" } },
	} satisfies import("../../lib/config.js").SharedConfig);

	it("falls back to process.cwd() when event.cwd is absent (L382)", () => {
		driveGraphPredictionMock.mockReturnValueOnce(null);
		const ctx = makeCtx();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "t",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: "src/x.ts" },
			timestamp: "2026-04-01T00:00:00.000Z",
			// no cwd
		};
		const decision = evaluateGraphPrediction(event, undefined, enabledConfig, [], ctx);
		expect(decision).toBeNull();
		expect(driveGraphPredictionMock).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: process.cwd() }),
		);
	});

	it("returns a block decision with a default reason when the predicted result carries no reason (L384, L387)", () => {
		driveGraphPredictionMock.mockReturnValueOnce({ decision: "block" });
		const ctx = makeCtx();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "t",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: "src/x.ts" },
			cwd: CWD,
			timestamp: "2026-04-01T00:00:00.000Z",
		};
		const decision = evaluateGraphPrediction(event, undefined, enabledConfig, [], ctx);
		expect(decision).toEqual({
			decision: "block",
			reason: "graph_prediction required",
			rule_id: "graph-prediction-protocol",
			severity: "medium",
			category: "graph-prediction",
		});
	});

	it("returns a block decision carrying the predicted reason when present (L384, L387)", () => {
		driveGraphPredictionMock.mockReturnValueOnce({
			decision: "block",
			reason: "predicted target not revealed",
		});
		const ctx = makeCtx();
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "t",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: "src/x.ts" },
			cwd: CWD,
			timestamp: "2026-04-01T00:00:00.000Z",
		};
		const decision = evaluateGraphPrediction(event, undefined, enabledConfig, [], ctx);
		expect(decision).toEqual({
			decision: "block",
			reason: "predicted target not revealed",
			rule_id: "graph-prediction-protocol",
			severity: "medium",
			category: "graph-prediction",
		});
	});

	it("mirrors additional_context into both warnings and ctx when present (L393)", () => {
		driveGraphPredictionMock.mockReturnValueOnce({
			decision: "allow",
			additional_context: "reveal: 2 shards observed",
		});
		const ctx = makeCtx();
		const warnings: string[] = [];
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "t",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: "src/x.ts" },
			cwd: CWD,
			timestamp: "2026-04-01T00:00:00.000Z",
		};
		const decision = evaluateGraphPrediction(event, undefined, enabledConfig, warnings, ctx);
		expect(decision).toBeNull();
		expect(warnings).toEqual(["reveal: 2 shards observed"]);
		expect(ctx.graphPredAdditionalContext).toBe("reveal: 2 shards observed");
	});
});
