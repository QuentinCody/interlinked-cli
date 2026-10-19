// ===========================================
// Interlinked Harness — Type Definitions (barrel)
// ===========================================
// Shared types for the harness server, evaluator, cohort, and reservations.
//
// This file is a BARREL. The actual declarations live in `src/harness/types/`,
// split by domain. It re-exports 100% of the prior public surface so every
// existing `import { ... } from "./types.js"` / `"../types.js"` keeps working
// with zero changes. Add new harness types to the relevant `types/<domain>.ts`
// module and re-export them here.
//
// Modules:
//   events.ts            — Determinism, hook events, agent classification, HarnessEvent
//   decisions.ts         — HarnessDecision, CheckResultEntry, GrepStats, LogEntry, ReservationAction
//   rules.ts             — GuardRule, RulePattern, InputRewrite, ActiveWhen scoping
//   config.ts            — GuardRulesConfig and every nested config interface
//   cohort-reservations.ts — agent cohort + file reservation types
//   taint.ts             — sensitivity / taint tracking + output scanning config
//   session.ts           — SessionTrajectory, TDD-cycle, session-level tracking
//   graph.ts             — project graph, structural & impact analysis types
//   language.ts          — language profiles + tool concurrency classification
//   policy.ts            — escalation request + LLM policy classifier types
//   failure-recovery.ts  — Phase 1 failure-recovery channel types
//   env-vars.ts          — SAFE_ENV_VARS / DANGEROUS_ENV_VARS runtime constants


// --- agent cohort + file reservations ---
export type {
	AgentStatus,
	CohortAgent,
	ReservationConflict,
	ReservationEntry,
} from "./types/cohort-reservations.js";
// --- guard rules configuration ---
export type {
	CommitCadenceConfig,
	CurlMcpConfig,
	DiffAwareConfig,
	ErrorMemoryConfig,
	ErrorRecord,
	FileReminder,
	FpFilterConfig,
	GitSessionScopeGateConfig,
	GuardRulesConfig,
	PlanCaptureConfig,
	PreEditBaseline,
	ProjectWideCheckConfig,
	ProtectedFileRule,
	QualityCheckConfig,
	ScratchpadArchiveConfig,
	StructuralChecksConfig,
	VerificationStopChecksConfig,
} from "./types/config.js";

// --- decisions ---
export type {
	CheckResultEntry,
	GrepStats,
	HarnessDecision,
	LogEntry,
	ReservationAction,
	ResolvedTarget,
	TscSchedulerRecord,
} from "./types/decisions.js";
// --- env var safety classification (runtime constants) ---
export { DANGEROUS_ENV_VARS, SAFE_ENV_VARS } from "./types/env-vars.js";
// --- events ---
export type {
	AgentRole,
	AgentSource,
	Determinism,
	HarnessEvent,
	HookEventName,
} from "./types/events.js";
export type {
	WorkspaceChangeSet,
	WorkspaceEffectKind,
	WorkspaceFileEffect,
	WorkspaceFileFingerprint,
	WorkspaceSnapshot,
} from "./workspace-effects.js";
export { ASK_CAPABLE_AGENTS, agentSupportsAsk } from "./types/events.js";
// --- Phase 1 failure-recovery channels ---
export type {
	ExplanationTemplate,
	FailureRecord,
	RecoveryContext,
	RecoverySuggestion,
	RollbackAssessment,
	ToolFailureEvent,
	TriageLabel,
	TriageResult,
	TriageRule,
} from "./types/failure-recovery.js";
// --- project graph, structural & impact analysis ---
export type {
	ExportedSymbol,
	ImpactAnalysisResult,
	ImpactSeverity,
	ImportEdge,
	ModuleRole,
	ReachabilityVerdict,
	StructuralCheckResult,
} from "./types/graph.js";
// --- language profiles + tool concurrency ---
export type {
	InlineCheckDef,
	LanguageCheckDef,
	LanguageId,
	LanguageProfile,
	LanguageTestDef,
	ToolConcurrencyClass,
} from "./types/language.js";
// --- captured agent plans ---
export type {
	CapturedPlan,
	PlanSource,
	PlanStep,
	PlanStepStatus,
} from "./types/plan.js";
// --- escalation request + LLM policy classifier ---
export type {
	ClassifierConfig,
	EscalationRequest,
	PolicyClassification,
	PolicyEvidence,
	PolicyRule,
} from "./types/policy.js";
// --- guard rules ---
export type {
	ActiveSkillRecord,
	ActiveWhen,
	AfterCommandSpec,
	GuardRule,
	InputRewrite,
	PhaseSpec,
	RulePattern,
	SessionPredicateSpec,
	TemporalPredicate,
	ToolExternality,
} from "./types/rules.js";
// --- session trajectory + TDD cycle ---
export type {
	AssertionCounts,
	CheckEffectivenessStats,
	EditMechanics,
	FailedFileEntry,
	FeedbackEffectivenessSummary,
	FileView,
	LearnedRule,
	ObservedCheck,
	PendingCompletion,
	RouteInfo,
	SessionTrajectory,
	TddCycle,
	TddCycleState,
	TurnEndSummary,
	WarningRecord,
} from "./types/session.js";
// --- sensitivity / taint tracking + output scanning ---
export type {
	OutputScanningConfig,
	SensitivityLevel,
	TaintProvenance,
	TaintSource,
	TaintTrackingConfig,
} from "./types/taint.js";
