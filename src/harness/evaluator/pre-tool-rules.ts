// ===========================================
// PreToolUse — destructive-pattern rule loop + Bash-routed-write + compound
// ===========================================
//
// Extracted verbatim from `evaluatePreToolUse` (pre-tool.ts) to keep the
// orchestrator under the per-file line cap. Behavior is identical: the helper
// pushes into the shared `warnings` array by reference and returns a
// `HarnessDecision` to short-circuit (the orchestrator returns it immediately)
// or `null` to continue. Control-flow order is preserved exactly.

import { readToolString } from "./tool-input-values.js";
import type { JsonObject } from "../../lib/json-types.js";
import {
	applyRewrite,
	evaluateCompoundCommand,
	inferAgentRole,
	ruleAppliesToRole,
} from "../command-decomposition.js";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "../pre-checks.js";
import {
	buildPatchApplierReason,
	detectPatchApplierExecution,
	isPatchApplierGuardDisabled,
} from "./patch-applier-guard.js";
import type {
	GuardRule,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { evaluateActiveWhen } from "./active-when.js";
import { sessionScratchpadAllows } from "./filesystem-guards.js";
import { commandKeywordTokens, shouldEvaluateByKeywords } from "./keyword-quick-reject.js";
import { formatAskReason, formatAskSystemMessage, formatReason, matchesRule, shouldEvaluateRule } from "./rule-matching.js";
import {
	buildScratchpadCodeReason,
	isScratchGuardDisabled,
	scratchpadCodeWriteMode,
} from "./scratchpad-write-guard.js";
import { isBash } from "./tool-classifiers.js";

const SOFT_BLOCK_KEY_MAX = 120;

/**
 * Resolve a single matched rule's action. Mirrors the original inline branch
 * cascade (`block` / `ask` / `soft_block` / `rewrite`) exactly: returns a
 * `HarnessDecision` to short-circuit the rule loop, or `null` to fall through
 * to the next rule. `warnings` is mutated by reference. Note the deliberate
 * fall-through behaviors preserved verbatim:
 *   • a soft_block whose key is already in `session.soft_blocks` pushes the
 *     "retry allowed" warning AND then the generic `warn` warning below;
 *   • a `rewrite` that produces no change, and the `warn` action, both fall
 *     through to the trailing generic warning.
 */
function applyRuleAction(
	rule: GuardRule,
	event: HarnessEvent,
	cmd: string,
	toolInput: JsonObject,
	session: SessionTrajectory | undefined,
	warnings: string[],
): HarnessDecision | null {
	if (rule.action === "block") {
		return {
			decision: "block",
			reason: formatReason(rule),
			warnings,
			rule_id: rule.id,
			severity: rule.severity,
			category: rule.category,
		};
	}
	if (rule.action === "ask") {
		// "ask" surfaces a per-call user prompt on agents that support
		// it (Claude Code, Cursor). On agents that lack an ask primitive
		// (Copilot, Codex, Gemini) the per-client encoders downgrade
		// ask → deny so the user still sees the reason: the .mjs path
		// goes through formatCopilotResponse / formatCodexResponse in
		// hook-template-chunks/provider-responses.ts, and the adapter
		// path goes through copilot-cli.encodeDecision /
		// codex.encodeDecision / gemini-cli.encodeDecision. Both must
		// stay in sync — if you add a new runner without an ask
		// primitive, mirror the deny mapping in BOTH places or
		// destructive rules will silently proceed on that runner.
		return {
			decision: "ask",
			reason: formatAskReason(rule),
			system_message: formatAskSystemMessage(rule, event),
			warnings,
			rule_id: rule.id,
			severity: rule.severity,
			category: rule.category,
		};
	}
	if (rule.action === "soft_block") {
		const softKey = `${rule.id}::${cmd.slice(0, SOFT_BLOCK_KEY_MAX)}`;
		if (session?.soft_blocks.has(softKey)) {
			warnings.push(`[interlinked] Warning (retry allowed): ${rule.reason}`);
		} else {
			if (session) session.soft_blocks.add(softKey);
			return {
				decision: "block",
				reason: formatReason(rule),
				warnings,
				rule_id: rule.id,
				severity: rule.severity,
				category: rule.category,
			};
		}
	}
	if (rule.action === "rewrite" && rule.rewrite && cmd) {
		const rewritten = applyRewrite(cmd, rule.rewrite);
		if (rewritten !== cmd) {
			warnings.push(`[interlinked:rewrite] Rewrote command per rule ${rule.id}`);
			return {
				decision: "allow",
				warnings,
				updated_input: { ...toolInput, command: rewritten },
				rule_id: rule.id,
			};
		}
	}
	warnings.push(`[interlinked] Warning: ${rule.reason}`);
	return null;
}

/**
 * Walk the rule corpus in order, applying the same quick-reject guard chain
 * (`shouldEvaluateRule` → role → active-when → keyword → `matchesRule`) the
 * inline loop used, then dispatching the matched rule's action through
 * `applyRuleAction`. Returns the first short-circuiting `HarnessDecision`, or
 * `null` when every rule was a non-returning warn / soft-retry. `warnings` is
 * mutated by reference.
 */
function evaluateRuleLoop(
	rules: GuardRulesConfig,
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	toolName: string,
	cmd: string,
	toolInput: JsonObject,
	matchInput: JsonObject,
	cmdTokens: Set<string>,
	agentRole: ReturnType<typeof inferAgentRole>,
	warnings: string[],
): HarnessDecision | null {
	for (const rule of rules.rules) {
		if (!shouldEvaluateRule(rule, "PreToolUse", toolName)) continue;
		if (!ruleAppliesToRole(rule, agentRole)) continue;
		if (!evaluateActiveWhen(rule, session, event)) continue;
		if (cmd && !shouldEvaluateByKeywords(rule, cmdTokens)) continue;
		if (
			!matchesRule({
				command: cmd,
				toolInput: matchInput,
				rule,
				extraExceptions: rules.extra_exceptions,
				toolName,
				session,
			})
		)
			continue;

		const decision = applyRuleAction(rule, event, cmd, toolInput, session, warnings);
		if (decision) return decision;
	}
	return null;
}

/**
 * GUARD: Bash-routed code-file writes (bypass content gate). Extracted verbatim
 * from the inline block. Returns a `block` decision when a Bash command writes
 * to a tracked source file via redirect/tee, else `null`.
 */
/** Scratch-placement steer (warn-only 2026-07-07; upgraded 2026-07-09): an
 *  out-of-repo code-file write is pointed at <repo>/scratch/ — the sanctioned
 *  session-script home (gated + greppable). When the resolved target is THIS
 *  session's scratchpad and `scratchpad_guard.code_write_mode` is "block"
 *  (the default), the write is blocked with the same redirect the Write/Edit
 *  path uses (scratchpad-write-guard.ts); every other out-of-repo path keeps
 *  the warn-only nudge (system paths stay writable). Mode "off" silences both. */
function steerOutOfRepoCodeWrite(opts: {
	cmd: string;
	projectRoot: string;
	sessionId: string | undefined;
	rules: GuardRulesConfig;
	warnings: string[];
}): HarnessDecision | null {
	const anywhere = detectBashCodeFileWrite(opts.cmd);
	if (!anywhere) return null;
	if (detectBashCodeFileWrite(opts.cmd, opts.projectRoot)) return null; // in-repo → block path owns it
	const mode = scratchpadCodeWriteMode(opts.rules);
	if (mode === "off") return null;
	const resolved = resolveBashWriteTarget(opts.cmd, anywhere.target, opts.projectRoot);
	if (
		mode === "block" &&
		!isScratchGuardDisabled() &&
		resolved !== null &&
		sessionScratchpadAllows(resolved, opts.sessionId)
	) {
		return {
			decision: "block",
			reason: buildScratchpadCodeReason({
				target: anywhere.target,
				projectRoot: opts.projectRoot,
			}),
			warnings: opts.warnings,
			rule_id: "builtin-scratchpad-code-write",
			severity: "medium",
			category: "harness-integrity",
		};
	}
	opts.warnings.push(
		`[interlinked:scratch] This command writes a code file outside the repo (${anywhere.target}). ` +
			`Session/agent scripts belong in <repo>/scratch/ — gitignored but quality-gated and ` +
			`rg-searchable (see scratch/README.md).`,
	);
	return null;
}

function evaluateBashRoutedWrite(
	toolName: string,
	cmd: string,
	warnings: string[],
	rules: GuardRulesConfig,
	sessionId: string | undefined,
	projectRoot?: string,
): HarnessDecision | null {
	if (isBash(toolName) && cmd) {
		// Root-confined (2026-07-06): only writes landing INSIDE the guarded
		// project count as tracked source files — scratchpad//tmp/out-of-repo
		// targets pass through (measured dogfood FP on a scratchpad probe),
		// with a scratch/ steer: warn-only for arbitrary out-of-repo paths,
		// block-with-redirect for this session's scratchpad (2026-07-09).
		if (projectRoot) {
			const placement = steerOutOfRepoCodeWrite({
				cmd,
				projectRoot,
				sessionId,
				rules,
				warnings,
			});
			if (placement) return placement;
		}
		const redirectHit = detectBashCodeFileWrite(cmd, projectRoot);
		if (redirectHit) {
			return {
				decision: "block",
				reason:
					`BLOCKED: This Bash command writes to a tracked source file (${redirectHit.target}) ` +
					`via ${redirectHit.mechanism}, which bypasses the content-quality gates that run on ` +
					"the Write and Edit tools (pre_block registry, biome diff-overlay, tsc diff-overlay). " +
					"Use the Write or Edit tool so the content is checked before it lands — including for " +
					"a coordinated multi-site change (adding an import AND its use site). A transiently " +
					"non-compiling intermediate no longer blocks: it opens a transient debt that the " +
					"counterpart edit discharges, so land the halves as ordinary sequential edits. If you " +
					"genuinely need one atomic multi-file write, PIPE the manifest on stdin " +
					"(`… | interlinked multi-edit --stdin`) — do not stage it as a file first; a manifest " +
					"written to a temp path is an ungated artifact that outlives the edit it served.",
				warnings,
				rule_id: "bash-code-file-write-bypass",
				severity: "high",
				category: "harness-integrity",
			};
		}
		const applierBlock = evaluateApplierExecution(cmd, warnings, projectRoot);
		if (applierBlock) return applierBlock;
	}
	return null;
}

/** Gap 5 (2026-08-25): executing a PRE-EXISTING applier script evades the
 *  write-time patch-applier guard — classify the script file at exec time. */
function evaluateApplierExecution(
	cmd: string,
	warnings: string[],
	projectRoot?: string,
): HarnessDecision | null {
	if (!projectRoot || isPatchApplierGuardDisabled()) return null;
	const exec = detectPatchApplierExecution(cmd, projectRoot);
	if (!exec) return null;
	return {
		decision: "block",
		reason: buildPatchApplierReason({ target: exec.scriptPath, evidence: exec.evidence }),
		warnings,
		rule_id: "builtin-patch-applier",
		severity: "high",
		category: "harness-integrity",
	};
}

/**
 * Compound command decomposition: split && / || / ; and check each subcommand.
 * Extracted verbatim from the inline block. Returns a `block` decision when a
 * subcommand trips a rule, an `allow` decision when a subcommand rewrote the
 * input, or `null` to continue. `warnings` is mutated by reference.
 */
function evaluateCompoundDecomposition(
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	toolName: string,
	cmd: string,
	toolInput: JsonObject,
	warnings: string[],
): HarnessDecision | null {
	// Any shell separator triggers decomposition — including newlines, pipes
	// and background `&`. Restricting this to `&&`/`||`/`;` left a compound
	// bypass open: `npm publish --dry-run\nnpm publish` never decomposed, so
	// the first segment's `--dry-run` suppressed the rule for the second.
	if (isBash(toolName) && /[;&|\n]/.test(cmd)) {
		const compoundResult = evaluateCompoundCommand(
			cmd,
			rules.rules,
			rules.extra_exceptions,
			(c, inp, rule, extras) =>
				matchesRule({
					command: c,
					toolInput: inp,
					rule,
					extraExceptions: extras,
					toolName,
					session,
				}),
		);
		if (compoundResult.decision === "block") {
			return {
				decision: "block",
				reason: compoundResult.reason,
				warnings: [...warnings, ...compoundResult.warnings],
				rule_id: compoundResult.rule_id,
				severity: compoundResult.severity,
				category: compoundResult.category,
			};
		}
		warnings.push(...compoundResult.warnings);
		if (compoundResult.updated_input) {
			return {
				decision: "allow",
				warnings,
				updated_input: { ...toolInput, ...compoundResult.updated_input },
			};
		}
	}
	return null;
}

/**
 * GUARD: Destructive patterns — Bash, Write, Edit, all tools — plus the
 * Bash-routed code-file write bypass and compound-command decomposition.
 * Mirrors the original inline block (control flow unchanged). `warnings` is
 * mutated by reference. Returns a `HarnessDecision` to short-circuit, else
 * `null` to continue evaluation.
 */
export function evaluateDestructiveRules(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	warnings: string[],
): HarnessDecision | null {
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};
	const cmd = readToolString(toolInput.command);
	// Plan 01 §1.3 keyword-quick-reject — pre-filter rules against the
	// command's tokenized words so platform-specific rules (`kubectl`,
	// `terraform`, etc.) don't run their regex on every Bash call. Rules
	// with no `keywords` field are always evaluated (preserves legacy
	// behavior for existing rules until they're backfilled).
	//
	// Wrapper-normalization (Plan 01 §1.1) and span-classification
	// (§1.2) are intentionally NOT globally applied in this matching
	// path. The existing rule corpus contains:
	//   • sudo-specific patterns (`\bsudo\s+rm\b`) that depend on
	//     seeing the raw `sudo` prefix.
	//   • SQL/argument-payload rules (`\bDROP\s+TABLE\b`) that need to
	//     match the quoted argument of `psql -c "DROP TABLE x"`.
	//   • Process-kill rules that NEGATE on quoted argument shape
	//     (`pkill -f 'wrangler dev'` should allow but `pkill node`
	//     should block).
	// Globally projecting wrapper-stripped + scannable text breaks all
	// three. The two modules remain available for explicit opt-in by
	// new rules / Plan 02-03 entries that prefer the cleaner semantics.
	const cmdTokens = cmd ? commandKeywordTokens(cmd) : new Set<string>();
	const agentRole = inferAgentRole(event);
	// Synthesize a richer match-input that exposes tool_name and
	// agent_source as top-level fields so guard-rule patterns can
	// match against them via `field: "tool_name"` / "agent_source"
	// without callers having to mutate the agent's actual tool_input.
	// Required by MCP destructive guards (mcp__*__delete*) and the
	// Railway MCP family that pattern-match on tool name rather than
	// command text.
	const matchInput = {
		...toolInput,
		tool_name: toolName,
		agent_source: event.agent_source,
	};

	const ruleDecision = evaluateRuleLoop(
		rules,
		event,
		session,
		toolName,
		cmd,
		toolInput,
		matchInput,
		cmdTokens,
		agentRole,
		warnings,
	);
	if (ruleDecision) return ruleDecision;

	const bashWriteDecision = evaluateBashRoutedWrite(
		toolName,
		cmd,
		warnings,
		rules,
		event.session_id,
		event.cwd,
	);
	if (bashWriteDecision) return bashWriteDecision;

	return evaluateCompoundDecomposition(rules, session, toolName, cmd, toolInput, warnings);
}
