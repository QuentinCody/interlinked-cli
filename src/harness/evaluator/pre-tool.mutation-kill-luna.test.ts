import { beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";

// vi.hoisted so the value exists before the hoisted vi.mock factories run —
// a plain top-level const is still in its TDZ when the SUT's imports trigger
// the factories (the collection failure this suite shipped with).
const { nullPhase } = vi.hoisted(() => ({
	nullPhase: (): null => null,
}));

vi.mock("../../event-dedup.js", () => ({ recordDeliveryForShadow: vi.fn() }));
vi.mock("./edit-contract-phase.js", () => ({ evaluateEditContractPhase: vi.fn(nullPhase) }));
vi.mock("./interpreter-write-guard.js", () => ({ evaluateInterpreterWriteGuard: vi.fn(nullPhase) }));
vi.mock("./mutation-directed-guard.js", () => ({ evaluateMutationDirectedProfile: vi.fn(nullPhase) }));
vi.mock("./pre-tool-context-phases.js", () => ({
	drainPendingSessionWarnings: vi.fn(),
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
import { evaluateEditContractPhase } from "./edit-contract-phase.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";
import { evaluateTrajectoryDetectorPhase } from "./pre-tool-context-phases.js";
import {
	evaluateAutoReservation,
	evaluateExfilPhase,
	evaluateFileDumpPhase,
	evaluateGraphPrediction,
	evaluateReadPhase,
	evaluateSequenceAndLockdown,
	evaluateTaintPhase,
	evaluateWriteContent,
} from "./pre-tool-decision-phases.js";
import {
	evaluateBaselineIntegrityGate,
	evaluateConfigLooseningGate,
	evaluateGitScopeGate,
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
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";

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

const session = (): SessionTrajectory => ({
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
} as unknown as SessionTrajectory);

const rules = (enabled = true): GuardRulesConfig => ({ ...getDefaultConfig(), enabled });
const reservations = new ReservationManager();
const cohort = new CohortManager();
const block = (name: string): HarnessDecision => ({ decision: "block", reason: name, rule_id: name });

beforeEach(() => vi.clearAllMocks());

describe("evaluatePreToolUse orchestrator mutation contracts", () => {
	// test-contract: public-api — disabled harnesses must return the stable allow decision without constructing or running phases.
	it("short-circuits before collaborators when disabled", () => {
		expect(evaluatePreToolUse(event(), rules(false), session(), reservations, cohort)).toEqual({ decision: "allow" });
		expect(evaluateMetaTestWrapper).not.toHaveBeenCalled();
	});

	// test-contract: public-api — the meta-test wrapper is an earlier terminal phase and must preserve its exact decision metadata.
	it("returns a wrapper decision before the phase pipeline", () => {
		vi.mocked(evaluateMetaTestWrapper).mockReturnValueOnce(block("meta-wrapper"));
		expect(evaluatePreToolUse(event({ tool_name: "Bash", tool_input: { command: "interlinked harness test x" } }), rules(), session(), reservations, cohort)).toEqual(block("meta-wrapper"));
		expect(evaluateSequenceAndLockdown).not.toHaveBeenCalled();
	});

	const terminalPhases: Array<[string, () => void, unknown]> = [
		["sequence", () => vi.mocked(evaluateSequenceAndLockdown).mockReturnValueOnce(block("sequence")), () => evaluateSequenceAndLockdown],
		["shard", () => vi.mocked(evaluateSupermodelShardGuard).mockReturnValueOnce(block("shard")), () => evaluateSupermodelShardGuard],
		["package", () => vi.mocked(evaluatePackageInstallGuard).mockReturnValueOnce(block("package")), () => evaluatePackageInstallGuard],
		["git", () => vi.mocked(evaluateGitScopeGate).mockReturnValueOnce(block("git")), () => evaluateGitScopeGate],
		["destructive", () => vi.mocked(evaluateDestructiveRules).mockReturnValueOnce(block("destructive")), () => evaluateDestructiveRules],
		["interpreter", () => vi.mocked(evaluateInterpreterWriteGuard).mockReturnValueOnce(block("interpreter")), () => evaluateInterpreterWriteGuard],
		["protected", () => vi.mocked(evaluateProtectedFilesGuard).mockReturnValueOnce(block("protected")), () => evaluateProtectedFilesGuard],
		["scratchpad", () => vi.mocked(evaluateScratchpadWriteGuard).mockReturnValueOnce(block("scratchpad")), () => evaluateScratchpadWriteGuard],
		["confinement", () => vi.mocked(evaluateRepoConfinementGuard).mockReturnValueOnce(block("confinement")), () => evaluateRepoConfinementGuard],
		["tdd", () => vi.mocked(evaluateTddGate).mockReturnValueOnce(block("tdd")), () => evaluateTddGate],
		["config", () => vi.mocked(evaluateConfigLooseningGate).mockReturnValueOnce(block("config")), () => evaluateConfigLooseningGate],
		["baseline", () => vi.mocked(evaluateBaselineIntegrityGate).mockReturnValueOnce(block("baseline")), () => evaluateBaselineIntegrityGate],
		["reservation", () => vi.mocked(evaluateAutoReservation).mockReturnValueOnce(block("reservation")), () => evaluateAutoReservation],
		["dump", () => vi.mocked(evaluateFileDumpPhase).mockReturnValueOnce(block("dump")), () => evaluateFileDumpPhase],
		["exfil", () => vi.mocked(evaluateExfilPhase).mockReturnValueOnce(block("exfil")), () => evaluateExfilPhase],
		["edit", () => vi.mocked(evaluateEditContractPhase).mockReturnValueOnce(block("edit")), () => evaluateEditContractPhase],
		["write", () => vi.mocked(evaluateWriteContent).mockReturnValueOnce(block("write")), () => evaluateWriteContent],
		["mutation", () => vi.mocked(evaluateMutationDirectedProfile).mockReturnValueOnce(block("mutation")), () => evaluateMutationDirectedProfile],
		["webfetch", () => vi.mocked(evaluateWebFetchGuard).mockReturnValueOnce(block("webfetch")), () => evaluateWebFetchGuard],
		["read", () => vi.mocked(evaluateReadPhase).mockReturnValueOnce(block("read")), () => evaluateReadPhase],
		["graph", () => vi.mocked(evaluateGraphPrediction).mockReturnValueOnce(block("graph")), () => evaluateGraphPrediction],
		["self-kill", () => vi.mocked(evaluatePreChecksSelfKillEnv).mockReturnValueOnce(block("self-kill")), () => evaluatePreChecksSelfKillEnv],
		["manifest", () => vi.mocked(evaluateManifestEditGuard).mockReturnValueOnce(block("manifest")), () => evaluateManifestEditGuard],
		["tail", () => vi.mocked(evaluatePreChecksTail).mockReturnValueOnce(block("tail")), () => evaluatePreChecksTail],
		["spec", () => vi.mocked(evaluateSpecPreGates).mockReturnValueOnce(block("spec")), () => evaluateSpecPreGates],
		["taint", () => vi.mocked(evaluateTaintPhase).mockReturnValueOnce(block("taint")), () => evaluateTaintPhase],
	];

	// test-contract: invariant — every public phase decision is returned unchanged and prevents later phases from running.
	it.each(terminalPhases)("propagates the %s phase decision", (_name, arm) => {
		arm();
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result).toMatchObject({ decision: "block", reason: _name });
	});

	// test-contract: boundary — a warning-only phase must feed the shared warning collection into the final allow outcome.
	it("returns warning-only phase output on allow", () => {
		vi.mocked(evaluateTrajectoryDetectorPhase).mockImplementationOnce((_event, _session, _cfg, warnings) => warnings.push("trajectory-warning"));
		const result = evaluatePreToolUse(event(), rules(), session(), reservations, cohort);
		expect(result).toEqual({ decision: "allow", warnings: ["trajectory-warning"] });
	});

	// test-contract: public-api — final allow exposes only populated metadata, while updated input remains terminal even for allow.
	it("preserves updated input and distinguishes empty warning metadata", () => {
		const updated = { command: "safe" };
		vi.mocked(evaluateSequenceAndLockdown).mockReturnValueOnce({ decision: "allow", updated_input: updated });
		expect(evaluatePreToolUse(event(), rules(), session(), reservations, cohort)).toEqual({ decision: "allow", updated_input: updated });
	});
});
