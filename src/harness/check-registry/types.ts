// Check-registry types: shared by entry files and builders.

import type { Determinism } from "../types.js";

/** A single match found by an inline check */
export interface InlineMatch {
    /** Optional full source span; UTF-16 half-open offsets. */
    startOffset?: number;
    endOffset?: number;
    endLine?: number;
	/** 1-based line number */
	line: number;
	/** Trimmed text of the matching line (truncated to 150 chars) */
	text: string;
}

/**
 * Phase at which a check runs.
 *
 * - `pre_block`: runs in PreToolUse, fires `decision: "ask"` (user-confirmed
 *   bypass). Reserved for fully-deterministic, zero-FP errors where blocking
 *   at edit time trains the agent that the rule is a hard rail.
 * - `pre_warn`: runs in PreToolUse, emits a warning before the write lands so
 *   the agent sees the rule at edit time (behavioral priming) without
 *   blocking. Reserved for fully-deterministic or low-FP partial-deterministic
 *   checks.
 * - `post`: runs in PostToolUse only. Default for heuristic warnings where
 *   pre-block would train the model to distrust all rails.
 *
 * Each check has exactly one phase. A `pre_block` check that lands anyway
 * (user approved the bypass) is not re-surfaced in Post — the user's
 * decision is authoritative.
 */
export type CheckPhase = "pre_block" | "pre_warn" | "post";

/** Complete definition of an inline check */
export interface CheckRegistration {
	/** Unique snake_case identifier (e.g., "misused_promises") */
	id: string;
	/** Display name (e.g., "Misused Promises") */
	name: string;
	/** Description */
	description: string;
	/** Performance tier: 1=sub-100ms, 2=sub-1s, 3=conditional */
	tier: 1 | 2 | 3;
	/** Determinism classification */
	determinism: Determinism;
	/** Severity when check fires */
	severity: "error" | "warning";
	/** Which pipeline runs this check */
	pipeline: "agent_safety" | "suggestion";
	/** When this check fires — see CheckPhase for semantics */
	phase: CheckPhase;
	/**
	 * DEFERRABLE: the finding is real, but its wrongness is a property of a
	 * not-yet-complete tree — an unused import, a reference to a symbol the next
	 * edit declares — so the coordinated change's other half resolves it.
	 *
	 * Orthogonal to `phase`, which says WHETHER a finding blocks. This says
	 * BY WHEN. A deferrable `pre_block` check does not refuse the edit that
	 * introduces the finding; it records a transient debt (`transient-debt.ts`)
	 * and refuses the edit that walks away from it with the debt still open.
	 *
	 * The decision rule (from `docs/design/open-obligation-ledger.md`): if the
	 * action's blast radius is realized at EXECUTION time and no later edit can
	 * undo it — a destructive command, a secret leaving the machine, an install
	 * — it is never deferrable. If the wrongness is static text in a
	 * half-written tree, it is.
	 */
	deferrable?: true;
	/** Fix instruction shown to agent */
	fix_instruction: string;
	/** Check function — takes (content, filePath), returns InlineMatch[] */
	fn: (content: string, filePath: string) => InlineMatch[];
	/** camelCase property name for CodeQualityResults (e.g., "misusedPromises") */
	resultsPropName: string;
	/**
	 * Substrings that gate detector evaluation. If non-empty, the detector
	 * runs ONLY when at least one substring appears (case-insensitively) in
	 * the file content. Empty/missing = always-eval (legacy behavior).
	 *
	 * Architectural twin of `evaluator/keyword-quick-reject.ts` for guard
	 * rules — same trick, applied to file content instead of command tokens.
	 * Sub-millisecond `String.prototype.includes` per substring; saves a
	 * regex pass when the pattern's anchor word is absent.
	 *
	 * Examples:
	 *   - `subprocess_shell_true` → `["subprocess"]`
	 *   - `mutex_lock_unwrap`     → `["Mutex", "lock"]`
	 *   - `weak_hash`             → `["md5", "sha1"]`
	 *
	 * The pre-filter is consumed by the file-checks dispatch in
	 * `commands/verify/file-checks.ts` and the daemon's PostToolUse path.
	 */
	content_keywords?: string[];
}
