// ===========================================
// PreToolUse Evaluation (Layer 1 deterministic + lifecycle enforcement)
// ===========================================
//
// Orchestrator for every PreToolUse guard. Composes the extracted modules
// (rule-matching, tool-classifiers, write-content-guards, taint-guards,
// permission-patterns, plus the pre-tool-{guards,rules,phases} siblings) and
// the internal phase helpers below — auto-reservations, curl-to-MCP, Bash
// file-dump, exfil, markdown-first, Read-sensitive, structural context,
// supermodel graph, graph-prediction, project setup, and diagnostics.
//
// Every phase is a function returning either a `HarnessDecision` (which
// short-circuits the pipeline) or `null` to continue; phases push into a shared
// `warnings` array by reference and thread cross-phase mutable state through a
// `PreToolCtx` holder. `evaluatePreToolUse` lists the phases as an ordered array
// of thunks and runs them through a single loop, returning on the first
// non-null decision. The list order is identical to the historical inline
// order, preserving every early-return and side-effect — the array is just the
// linear sequence made data, so complexity lives in the small phase helpers
// rather than one 90+-branch function.
//
// All evaluator.test.ts cases exercise this function.

import type { SharedConfig } from "../../lib/config.js";
import type { CohortManager } from "../cohort.js";
import type { ErrorHistory } from "../error-history.js";
import { recordDeliveryForShadow } from "../event-dedup.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import { actorKeyOf } from "../session-state-mutators.js";
import type { SessionTracker } from "../session-state.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
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
	evaluateReadPhase,
	evaluateSequenceAndLockdown,
	evaluateTaintPhase,
	evaluateWriteContent,
	type PreToolCtx,
} from "./pre-tool-decision-phases.js";
import { evaluateBashEditObligationGate } from "../bash-edit-obligations.js";
import { evaluateInterpreterWriteGuard } from "./interpreter-write-guard.js";
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
import {
	evaluatePreChecksSelfKillEnv,
	evaluatePreChecksTail,
} from "./pre-tool-phases.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";
import { evaluateScratchpadWriteGuard } from "./scratchpad-write-guard.js";
import { evaluateSpecPreGates } from "./spec-pre-gates.js";

// `resetProjectSetupWarningsCache` lives in pre-tool-helpers.ts (next to the
// cache it invalidates) but is re-exported here because server.ts and
// lifecycle-events.ts import it from this module — preserve that entry point.
export { resetProjectSetupWarningsCache } from "./pre-tool-helpers.js";

/** Files that have already had git blame injected this session (dedup per session ID) */
const _blameInjectedFiles = new Map<string, Set<string>>();


/** Loop-level handling of one phase's decision. Terminal decisions — block /
 *  ask, or an allow CARRYING `updated_input` (a rewrite the runner must
 *  apply) — short-circuit the pipeline and are returned. A bare gate-level
 *  allow means "this gate is satisfied": its warnings merge into the shared
 *  array and evaluation continues (returns null). Found live 2026-07-15: the
 *  TDD gate's debt-mode allow was treated as terminal, so a brand-new
 *  test-less source file skipped the ~23 phases after it — line cap,
 *  cyclomatic gate, content checks, auto-reservation, taint — entirely. */
function phaseDecisionOutcome(
	decision: HarnessDecision,
	warnings: string[],
): HarnessDecision | null {
	if (decision.decision !== "allow" || decision.updated_input) return decision;
	if (decision.warnings && decision.warnings !== warnings) {
		warnings.push(...decision.warnings.filter((w) => !warnings.includes(w)));
	}
	return null;
}

/** Pipeline context for one PreToolUse event: the cross-phase locals start
 *  empty and the budgeted actor is resolved from the event up front, so the
 *  taint phase charges the step budget to the CALLING agent — a subagent's
 *  calls arrive under the parent's session id and must not spend the parent's
 *  budget (a 50-agent campaign put its orchestrator into read-only mode at
 *  ~79k session steps against a 10k limit, 2026-09-05). */
function newPreToolCtx(event: HarnessEvent, session: SessionTrajectory | undefined): PreToolCtx {
	return {
		escalation: undefined,
		contentScan: undefined,
		graphPredAdditionalContext: undefined,
		...(session ? { actor: actorKeyOf(event, session) } : {}),
	};
}

/** Public API — consumed by server.ts via the root evaluator.ts re-export.
 *  This is the main PreToolUse decision entry point; every hook call runs
 *  through here before a tool executes. The nine positional parameters
 *  mirror the long-standing harness contract; refactoring them into an
 *  options object would cascade into every test and caller for no semantic
 *  gain, so they are preserved as-is. */
export function evaluatePreToolUse(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	reservations: ReservationManager,
	cohort: CohortManager,
	graph?: ProjectGraph,
	sessions?: SessionTracker,
	routeMap?: RouteMap,
	errorHistory?: ErrorHistory,
	sharedConfig?: SharedConfig | null,
): HarnessDecision {
	if (!rules.enabled) return { decision: "allow" }; // early exit when harness disabled

	// Shadow-mode delivery de-dup: detect redundant hook deliveries of
	// this tool call (logged to dedup-shadow.jsonl). Detect-only, never skips.
	recordDeliveryForShadow(event);

	const warnings: string[] = [];
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};
	const cfg = sharedConfig ?? null;

	// Meta-test wrapper short-circuit: `interlinked harness test "..."` is the
	// CLI's own command for evaluating a synthetic tool call against the rule
	// set. See evaluateMetaTestWrapper for the full rationale. Kept ahead of the
	// pipeline so it never instantiates the trajectory/sequence machinery.
	{
		const d = evaluateMetaTestWrapper(toolName, toolInput);
		if (d) return d;
	}

	const ctx = newPreToolCtx(event, session);
	void _blameInjectedFiles; // reserved for future blame-injection dedup

	// The PreToolUse pipeline as an ordered list of phases. Each phase pushes
	// warnings by reference and returns either a `HarnessDecision` (short-circuit)
	// or `null` (continue). Side-effect-only phases return null. The order is the
	// historical inline order verbatim — see the per-phase helpers for what each
	// does and why. Running them through one loop keeps this orchestrator's
	// branching minimal while preserving every early-return and side-effect.
	const phases: Array<() => HarnessDecision | null> = [
		// Trajectory detector (warning-only, lazy/no-op until flags flip).
		() => {
			evaluateTrajectoryDetectorPhase(event, session, cfg, warnings);
			return null;
		},
		// Sequence detectors + lockdown (pre_block short-circuits, pre_warn warns).
		() => evaluateSequenceAndLockdown(event, session, warnings),
		// Supermodel `.graph.*` shard write protection — apply_patch layer.
		() => evaluateSupermodelShardGuard(event),
		// Supply-chain — block package-install shell commands not on the allowlist.
		() => evaluatePackageInstallGuard(event, toolName, toolInput),
		// Git session-scope gate — ask before staging/committing unwritten files.
		() => evaluateGitScopeGate(event, rules, session, toolName, toolInput, warnings),
		// Destructive patterns — Bash/Write/Edit + Bash-routed write bypass.
		() => evaluateDestructiveRules(event, rules, session, warnings),
		// Inline-interpreter writes into repo source (`python3 - <<EOF … open(…,"w")`).
		// MUST follow evaluateDestructiveRules: its Bash-routed write detector owns
		// shell REDIRECTS (`> file`, `tee`, `sed -i`), so running second is what keeps
		// the two gates from double-firing on one command.
		() => evaluateInterpreterWriteGuard(event, toolName, toolInput, warnings),
		// Protected files.
		() => evaluateProtectedFilesGuard(toolName, toolInput, rules, warnings),
		// Scratchpad/temp write policy — tmp-secrets block + authored-code
		// placement steer. MUST precede repo confinement, whose session-
		// scratchpad carve-out would otherwise allow these uninspected.
		() => evaluateScratchpadWriteGuard(event, toolName, toolInput, rules, warnings),
		// Repo confinement — block writes outside CWD.
		() => evaluateRepoConfinementGuard(event, toolName, toolInput, rules, warnings),
		// TDD gate — block new non-test .ts/.tsx without a companion test.
		() => evaluateTddGate(event, rules, session, toolName, warnings),
		// Config-loosening gate — ask before strict-flag relaxations.
		() => evaluateConfigLooseningGate(event, toolName, warnings),
		// Baseline-integrity gate — block lowering a committed ratchet water-line.
		() => evaluateBaselineIntegrityGate(event, toolName, warnings),
		// Bash-edit obligations — the Ring-2 equalizer: a bash-channel edit that
		// introduced pre_block findings gates write-class calls until fixed.
		() => evaluateBashEditObligationGate(event, toolName, warnings),
		// Auto file reservation.
		() =>
			evaluateAutoReservation(event, session, toolName, toolInput, reservations, cohort, warnings),
		// curl-to-MCP detection (warning-only).
		() => {
			evaluateCurlMcpPhase(session, rules, toolName, toolInput, warnings);
			return null;
		},
		// tail/head/cat output-budget enforcement.
		() => evaluateFileDumpPhase(toolName, toolInput, warnings),
		// Pipe-to-bash / exfiltration / dropper-staging.
		() => evaluateExfilPhase(event, session, graph, toolName, toolInput, warnings, ctx),
		// Edit contract (LG-1…LG-5): stale-read warning, blind-edit provenance,
		// apply_patch context validation, and the doomed-Edit/MultiEdit block
		// with one-round-trip rescue. Composes the old old_string guard.
		() => evaluateEditContractPhase(event, session, rules, toolName, toolInput, warnings),
		// Write/Edit content validation.
		() => evaluateWriteContent(event, session, rules, toolName, toolInput, warnings, ctx),
		// Mutation-directed file-class severity profile (GATE 1 escalation +
		// GATE 2 assertion-removal delta). No-op unless the write touches a
		// MUTATION_DIRECTED_PATH file; block behavior is additionally gated
		// behind mutation_directed_strict_profile (default off).
		() => evaluateMutationDirectedProfile(event, rules, toolName, toolInput, warnings),
		// WebFetch — exfiltration and safety.
		() => evaluateWebFetchGuard(toolName, toolInput, warnings),
		// Markdown-first web-fetching nudges (warning-only).
		() => {
			evaluateMarkdownFirstPhase(toolName, toolInput, warnings);
			return null;
		},
		// Read — block sensitive files, warn on oversized files.
		() => evaluateReadPhase(toolName, toolInput, warnings),
		// Structural context injection (warning-only).
		() => {
			evaluateStructuralContextPhase(
				event,
				rules,
				graph,
				sessions,
				session,
				routeMap,
				warnings,
			);
			return null;
		},
		// Supermodel graph awareness (warning-only).
		() => {
			evaluateSupermodelGraphContext(event, toolName, warnings);
			return null;
		},
		// Graph-prediction protocol.
		() => evaluateGraphPrediction(event, graph, cfg, warnings, ctx),
		// One-time project-setup validation (warning-only).
		() => {
			evaluateProjectSetupPhase(event, warnings);
			return null;
		},
		// PreToolUse file diagnostics (warning-only).
		() => {
			evaluateDiagnosticsPhase(event, rules, toolName, toolInput, warnings);
			return null;
		},
		// Pre-checks (head): self-kill + env-leak-to-git.
		() => evaluatePreChecksSelfKillEnv(event, toolName, toolInput, warnings),
		// Supply-chain — block unapproved new deps; warn on license-policy drift.
		() => evaluateManifestEditGuard(event, toolName, toolInput, warnings),
		// Pre-checks (tail): line-cap / stale-branch / dirty-tree / large-file /
		// concurrent-edit.
		() => evaluatePreChecksTail(event, session, sessions, toolName, toolInput, warnings),
		// Spec pre-gates: markdown declared-marker "ask" + anchor-removal /
		// introduced-drift warnings (was imported but never wired — sol-max #1).
		() => evaluateSpecPreGates(event, toolName, rules, warnings),
		// Taint: sensitivity tracking, network blocking, step budget.
		() => evaluateTaintPhase(rules, session, toolName, toolInput, warnings, ctx),
		// Late side-effects (escalation / permission-pattern / error-memory /
		// content-scan); never blocks.
		() => {
			evaluateLateSideEffects(
				event,
				rules,
				session,
				graph,
				errorHistory,
				toolName,
				toolInput,
				warnings,
				ctx,
			);
			return null;
		},
	];

	for (const phase of phases) {
		const decision = phase();
		if (!decision) continue;
		const terminal = phaseDecisionOutcome(decision, warnings);
		if (terminal) return terminal;
	}

	return {
		decision: "allow",
		warnings: warnings.length > 0 ? warnings : undefined,
		additional_context: ctx.graphPredAdditionalContext,
		_escalation: ctx.escalation,
		_contentScan: ctx.contentScan,
	};
}
