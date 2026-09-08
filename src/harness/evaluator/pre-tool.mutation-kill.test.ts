import { nonNull } from "../../lib/non-null.js";
import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";

const { nullPhase } = vi.hoisted(() => ({
	nullPhase: (): unknown => null,
}));

vi.mock("../event-dedup.js", () => ({ recordDeliveryForShadow: vi.fn() }));
vi.mock("./edit-contract-phase.js", () => ({ evaluateEditContractPhase: vi.fn(nullPhase) }));
vi.mock("./interpreter-write-guard.js", () => ({ evaluateInterpreterWriteGuard: vi.fn(nullPhase) }));
vi.mock("./mutation-directed-guard.js", () => ({ evaluateMutationDirectedProfile: vi.fn(nullPhase) }));
vi.mock("./pre-tool-context-phases.js", () => ({
	evaluateCurlMcpPhase: vi.fn(),
	evaluateDiagnosticsPhase: vi.fn(),
	evaluateMarkdownFirstPhase: vi.fn(),
	evaluateProjectSetupPhase: vi.fn(),
	evaluateStructuralContextPhase: vi.fn(),
	evaluateSupermodelGraphContext: vi.fn(),
	evaluateTrajectoryDetectorPhase: vi.fn(),
}));
vi.mock("./pre-tool-decision-phases.js", () => ({
	evaluateAutoReservation: vi.fn(nullPhase),
	evaluateExfilPhase: vi.fn(nullPhase),
	evaluateFileDumpPhase: vi.fn(nullPhase),
	evaluateGraphPrediction: vi.fn(nullPhase),
	evaluateLateSideEffects: vi.fn(),
	evaluateReadPhase: vi.fn(nullPhase),
	evaluateSequenceAndLockdown: vi.fn(nullPhase),
	evaluateTaintPhase: vi.fn(nullPhase),
	evaluateWriteContent: vi.fn(nullPhase),
}));
vi.mock("./pre-tool-guards.js", () => ({
	evaluateBaselineIntegrityGate: vi.fn(nullPhase),
	evaluateConfigLooseningGate: vi.fn(nullPhase),
	evaluateGitScopeGate: vi.fn(nullPhase),
	evaluateManifestEditGuard: vi.fn(nullPhase),
	evaluateMetaTestWrapper: vi.fn(nullPhase),
	evaluatePackageInstallGuard: vi.fn(nullPhase),
	evaluateProtectedFilesGuard: vi.fn(nullPhase),
	evaluateRepoConfinementGuard: vi.fn(nullPhase),
	evaluateSupermodelShardGuard: vi.fn(nullPhase),
	evaluateTddGate: vi.fn(nullPhase),
	evaluateWebFetchGuard: vi.fn(nullPhase),
}));
vi.mock("./pre-tool-phases.js", () => ({
	evaluatePreChecksSelfKillEnv: vi.fn(nullPhase),
	evaluatePreChecksTail: vi.fn(nullPhase),
}));
vi.mock("./pre-tool-rules.js", () => ({ evaluateDestructiveRules: vi.fn(nullPhase) }));
vi.mock("./scratchpad-write-guard.js", () => ({ evaluateScratchpadWriteGuard: vi.fn(nullPhase) }));
vi.mock("./spec-pre-gates.js", () => ({ evaluateSpecPreGates: vi.fn(nullPhase) }));

import { evaluatePreToolUse } from "./pre-tool.js";
import { recordDeliveryForShadow } from "../event-dedup.js";
import { evaluateEditContractPhase } from "./edit-contract-phase.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";
import {
	evaluateCurlMcpPhase,
	evaluateDiagnosticsPhase,
	evaluateMarkdownFirstPhase,
	evaluateProjectSetupPhase,
	evaluateStructuralContextPhase,
	evaluateSupermodelGraphContext,
	evaluateTrajectoryDetectorPhase,
} from "./pre-tool-context-phases.js";
import {
	evaluateAutoReservation,
	evaluateExfilPhase,
	evaluateFileDumpPhase,
	evaluateGraphPrediction,
	evaluateLateSideEffects,
	evaluateSequenceAndLockdown,
	evaluateTaintPhase,
	evaluateWriteContent,
} from "./pre-tool-decision-phases.js";
import {
	evaluateBaselineIntegrityGate,
	evaluateConfigLooseningGate,
	evaluateManifestEditGuard,
	evaluateMetaTestWrapper,
	evaluatePackageInstallGuard,
	evaluateProtectedFilesGuard,
	evaluateRepoConfinementGuard,
	evaluateSupermodelShardGuard,
	evaluateTddGate,
	evaluateWebFetchGuard,
} from "./pre-tool-guards.js";
import { evaluatePreChecksSelfKillEnv, evaluatePreChecksTail } from "./pre-tool-phases.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";
import { evaluateScratchpadWriteGuard } from "./scratchpad-write-guard.js";
import { evaluateSpecPreGates } from "./spec-pre-gates.js";
import { evaluateInterpreterWriteGuard } from "./interpreter-write-guard.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { SharedConfig } from "../../lib/config.js";

const event = (overrides: Partial<HarnessEvent> = {}): HarnessEvent => ({
	hook_event: "PreToolUse",
	session_id: "session-1",
	agent_source: "claude",
	tool_name: "Bash",
	tool_input: { command: "printf ok" },
	cwd: "/workspace/project",
	timestamp: "2026-08-20T00:00:00.000Z",
	...overrides,
});

const session = (): SessionTrajectory =>
	({ ...makeSessionFixture(),
		session_id: "session-1",
		agent_name: "agent",
		started_at: "2026-08-20T00:00:00.000Z",
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
		// SAFETY: this fixture includes the session fields consumed by the public evaluator.
	} satisfies SessionTrajectory);

const rules = (enabled = true): GuardRulesConfig => ({ ...getDefaultConfig(), enabled });
const reservations = new ReservationManager();
const cohort = new CohortManager();
const block = (name: string): HarnessDecision => ({ decision: "block", reason: name, rule_id: name });

beforeEach(() => vi.clearAllMocks());

describe("evaluatePreToolUse orchestrator — additional mutation contracts", () => {
	// test-contract: public-api — the disabled short-circuit must occur before ANY collaborator (including the dedup recorder) is invoked.
	it("never invokes the shadow-dedup recorder when rules are disabled", () => {
		const result = evaluatePreToolUse(event(), rules(false), session(), reservations, cohort);
		expect(result).toEqual({ decision: "allow" });
		expect(recordDeliveryForShadow).not.toHaveBeenCalled();
		expect(evaluateMetaTestWrapper).not.toHaveBeenCalled();
	});

	// test-contract: boundary — with no phase pushing a warning, the final allow decision must omit `warnings` entirely (not an empty array).
	it("omits warnings when no phase pushed one", () => {
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result).toEqual({ decision: "allow" });
		expect(result.warnings).toBeUndefined();
	});

	// test-contract: boundary — a single pushed warning must survive verbatim into the final allow decision's `warnings` array.
	it("surfaces exactly the warnings pushed by phases", () => {
		vi.mocked(evaluateTrajectoryDetectorPhase).mockImplementationOnce((_event, _session, _cfg, warnings: string[]) => {
			warnings.push("trajectory-only-warning");
		});
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result.warnings).toEqual(["trajectory-only-warning"]);
	});

	// test-contract: public-api — a truthy sharedConfig must be forwarded to phases by identity, not replaced by null/undefined.
	it("forwards a truthy sharedConfig by identity into cfg-consuming phases", () => {
		const cfgObj = ({ version: 1, server_url: "https://example.test", } satisfies SharedConfig);
		evaluatePreToolUse(
			event(),
			rules(),
			session(),
			reservations,
			cohort,
			undefined,
			undefined,
			undefined,
			undefined,
			cfgObj,
		);
		const call = vi.mocked(evaluateTrajectoryDetectorPhase).mock.calls[0];
		expect(call?.[2]).toBe(cfgObj);
	});

	// test-contract: public-api — the meta-test wrapper decision must be returned verbatim and ahead of the phase pipeline.
	it("returns the meta-test wrapper decision and skips the phase pipeline", () => {
		vi.mocked(evaluateMetaTestWrapper).mockReturnValueOnce(block("meta-wrapper"));
		const result = evaluatePreToolUse(
			event({ tool_name: "Bash", tool_input: { command: "interlinked harness test x" } }),
			rules(),
			session(),
			reservations,
			cohort,
		);
		expect(result).toEqual(block("meta-wrapper"));
		expect(evaluateSequenceAndLockdown).not.toHaveBeenCalled();
	});

	// test-contract: invariant — the ctx holder threaded through downstream phases must carry its three named keys as own-enumerable properties, plus the budgeted `actor` whenever a live session exists (`newPreToolCtx`).
	it("initializes ctx with escalation/contentScan/graphPredAdditionalContext as own keys", () => {
		evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		const ctxArg = vi.mocked(evaluateExfilPhase).mock.calls[0]?.[6];
		// SAFETY: the mock captures whatever object the SUT passed as the 7th arg; we only inspect its own keys.
		expect(Object.keys(nonNull(ctxArg)).sort()).toEqual(["actor", "contentScan", "escalation", "graphPredAdditionalContext"]);
	});

	// test-contract: invariant — with no live session there is no actor to budget, so the ctx carries only its three cross-phase locals.
	it("omits the actor key from ctx when no session is passed", () => {
		evaluatePreToolUse(event(), rules(), undefined, reservations, cohort);
		const ctxArg = vi.mocked(evaluateExfilPhase).mock.calls[0]?.[6];
		// SAFETY: same capture as above; only the own keys are inspected.
		expect(Object.keys(nonNull(ctxArg)).sort()).toEqual(["contentScan", "escalation", "graphPredAdditionalContext"]);
	});

	// test-contract: invariant — a bare (non-terminal) allow decision from an earlier phase must not short-circuit the pipeline; a later phase's block must still win.
	it("continues past a non-terminal bare-allow decision to a later phase's block", () => {
		vi.mocked(evaluateSequenceAndLockdown).mockReturnValueOnce({ decision: "allow" });
		vi.mocked(evaluateSupermodelShardGuard).mockReturnValueOnce(block("later"));
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result).toEqual(block("later"));
	});

	const terminalPhases: Array<[string, () => void]> = [
		["sequence", () => vi.mocked(evaluateSequenceAndLockdown).mockReturnValueOnce(block("sequence"))],
		["shard", () => vi.mocked(evaluateSupermodelShardGuard).mockReturnValueOnce(block("shard"))],
		["package", () => vi.mocked(evaluatePackageInstallGuard).mockReturnValueOnce(block("package"))],
		["destructive", () => vi.mocked(evaluateDestructiveRules).mockReturnValueOnce(block("destructive"))],
		["interpreter", () => vi.mocked(evaluateInterpreterWriteGuard).mockReturnValueOnce(block("interpreter"))],
		["protected", () => vi.mocked(evaluateProtectedFilesGuard).mockReturnValueOnce(block("protected"))],
		["scratchpad", () => vi.mocked(evaluateScratchpadWriteGuard).mockReturnValueOnce(block("scratchpad"))],
		["confinement", () => vi.mocked(evaluateRepoConfinementGuard).mockReturnValueOnce(block("confinement"))],
		["tdd", () => vi.mocked(evaluateTddGate).mockReturnValueOnce(block("tdd"))],
		["config", () => vi.mocked(evaluateConfigLooseningGate).mockReturnValueOnce(block("config"))],
		["baseline", () => vi.mocked(evaluateBaselineIntegrityGate).mockReturnValueOnce(block("baseline"))],
		[
			"reservation",
			() => vi.mocked(evaluateAutoReservation).mockReturnValueOnce(block("reservation")),
		],
		["dump", () => vi.mocked(evaluateFileDumpPhase).mockReturnValueOnce(block("dump"))],
		["exfil", () => vi.mocked(evaluateExfilPhase).mockReturnValueOnce(block("exfil"))],
		["edit", () => vi.mocked(evaluateEditContractPhase).mockReturnValueOnce(block("edit"))],
		["write", () => vi.mocked(evaluateWriteContent).mockReturnValueOnce(block("write"))],
		["mutation", () => vi.mocked(evaluateMutationDirectedProfile).mockReturnValueOnce(block("mutation"))],
		["webfetch", () => vi.mocked(evaluateWebFetchGuard).mockReturnValueOnce(block("webfetch"))],
		["graph", () => vi.mocked(evaluateGraphPrediction).mockReturnValueOnce(block("graph"))],
		["self-kill", () => vi.mocked(evaluatePreChecksSelfKillEnv).mockReturnValueOnce(block("self-kill"))],
		["manifest", () => vi.mocked(evaluateManifestEditGuard).mockReturnValueOnce(block("manifest"))],
		["tail", () => vi.mocked(evaluatePreChecksTail).mockReturnValueOnce(block("tail"))],
		["spec", () => vi.mocked(evaluateSpecPreGates).mockReturnValueOnce(block("spec"))],
		["taint", () => vi.mocked(evaluateTaintPhase).mockReturnValueOnce(block("taint"))],
	];

	// test-contract: invariant — each phase thunk must actually invoke its underlying collaborator and return its decision unchanged; a stubbed-out (`() => undefined`) arrow would silently drop it.
	it.each(terminalPhases)("propagates the %s phase's decision unchanged", (_name, arm) => {
		arm();
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result).toEqual(block(_name));
	});

	const warnOnlyPhases: Array<[string, () => void]> = [
		[
			"trajectory",
			() =>
				vi
					.mocked(evaluateTrajectoryDetectorPhase)
					.mockImplementationOnce((_e, _s, _c, warnings: string[]) => warnings.push("trajectory")),
		],
		[
			"curl",
			() =>
				vi
					.mocked(evaluateCurlMcpPhase)
					.mockImplementationOnce((_s, _r, _t, _i, warnings: string[]) => warnings.push("curl")),
		],
		[
			"markdown",
			() =>
				vi
					.mocked(evaluateMarkdownFirstPhase)
					.mockImplementationOnce((_t, _i, warnings: string[]) => warnings.push("markdown")),
		],
		[
			"structural",
			() =>
				vi
					.mocked(evaluateStructuralContextPhase)
					.mockImplementationOnce((_e, _r, _g, _s, _sess, _rm, warnings: string[]) =>
						warnings.push("structural"),
					),
		],
		[
			"supermodel-graph",
			() =>
				vi
					.mocked(evaluateSupermodelGraphContext)
					.mockImplementationOnce((_e, _t, warnings: string[]) => warnings.push("supermodel-graph")),
		],
		[
			"project-setup",
			() =>
				vi
					.mocked(evaluateProjectSetupPhase)
					.mockImplementationOnce((_e, warnings: string[]) => warnings.push("project-setup")),
		],
		[
			"diagnostics",
			() =>
				vi
					.mocked(evaluateDiagnosticsPhase)
					.mockImplementationOnce((_e, _r, _t, _i, warnings: string[]) => warnings.push("diagnostics")),
		],
		[
			"late-side-effects",
			() =>
				vi
					.mocked(evaluateLateSideEffects)
					.mockImplementationOnce((_e, _r, _s, _g, _eh, _t, _i, warnings: string[]) =>
						warnings.push("late-side-effects"),
					),
		],
	];

	// test-contract: invariant — each warning-only phase block must actually call its underlying collaborator; a body replaced with `{}` would silently drop the call and its warning.
	it.each(warnOnlyPhases)("invokes the %s warn-only phase and surfaces its warning", (name, arm) => {
		arm();
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result.warnings).toEqual([name]);
	});
});
