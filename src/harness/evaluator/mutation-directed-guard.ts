// ===========================================
// Mutation-directed file-class severity profile — PreToolUse wiring
// ===========================================
// docs/design/luna-gate-audit-2026-08-14.md §3(a). Detection lives in
// checks/mutation-directed-profile.ts (pure content functions); this module
// reads config, resolves proposed/baseline content, and builds the
// HarnessDecision. Both gates are scoped to MUTATION_DIRECTED_PATH files —
// isMutationDirectedFile() is the first check in the function body, so a
// write to any other file costs exactly one regex test.
//
// GATE 1 (severity remap) and GATE 2's BLOCK behavior both live behind
// `mutation_directed_strict_profile` (default OFF — there is no
// default-config.ts entry, so the flag is simply absent/undefined until a
// repo opts in, matching the `strict_typing_block` precedent). Building and
// wiring this module changes nothing about a running daemon until that flag
// flips to true.
//
// The field is declared via `declare module` augmentation below instead of
// as a member of GuardRulesConfig in types/config.ts directly: that file is
// AT its enforced line-cap right now (a concurrent-edit congestion this
// codebase has hit before — see the INTERLINKED_DISABLE_LOCAL_LEASE_BLOCK
// precedent in pre-tool-decision-phases.ts, which used an env var for the
// same reason). Standard TS declaration merging keeps the read fully typed
// with no cast; fold it into GuardRulesConfig directly once that file has
// headroom again.
//
// GATE 2's WARNING is unconditional (not flag-gated) — the audit's own
// framing: legitimate refactors remove assertions constantly, so the block
// needs FP data before it can fire, but the warning is safe to ship now and
// is exactly what would have surfaced `kill_taste_smell_mutants`'s own
// self-reported "No mutation measurement was run" moment as a machine
// signal instead of prose nobody acted on.
//
// CROSS-FILE MOVES ARE VISIBLE ONLY FOR BATCH-SHAPED EDITS. GATE 2's sibling
// pool (`collectChangeSetSiblings`) is built from `tool_input.edits[]`
// entries that carry their OWN `file_path` — one payload naming several
// files. Claude Code sends ONE file per PreToolUse call (its MultiEdit is
// single-file; its entries carry no path), so from that runner a cross-file
// move is TWO calls: the removal, which this gate judges with no sibling in
// sight and therefore warns/blocks as a plain removal, and the addition,
// which arrives later. The addition call cannot retroactively pass the
// first — it can only REDEEM it: when the removal was allowed under the
// campaign waiver (one pending ledger row per line), the addition matches
// its introduced assertion lines against this session's pending rows and
// appends a `redeemed_by` row per match (`redeemWaivedRemovals`), so the
// audit reads "moved to <file>" instead of "waived". Without the waiver the
// first call blocks and there is nothing to redeem — that is the known limit
// of a one-file-per-call runner; `interlinked write --batch` / content-gate
// (a ChangeSet-level caller) does not run this guard today.

import { isJsonObject } from "../../lib/json-types.js";
import {
	ASSERTION_WAIVER_ENV,
	ASSERTION_WAIVER_LOG,
	appendAssertionWaivers,
	assertionMoveWaiverActive,
	buildAssertionWaiverRecords,
	redeemWaivedRemovals,
} from "../assertion-waiver-log.js";
import type { InlineMatch } from "../check-registry/types.js";
import {
	type ChangeSetSibling,
	classifyRemovedAssertions,
	evaluateMutationDirectedSignals,
	introducedAssertionLines,
	isMutationDirectedFile,
	type MutationDirectedProfileArgs,
	REMOVED_ASSERTION_CHECK_ID,
} from "../checks/mutation-directed-profile.js";
import { resolveProposedContent } from "../overlay-content.js";
import { lineList, preBlockIntroducedBlock, resolveDiskBaseline } from "../pre-block-gate.js";
import { findProjectRoot } from "../quality-checks.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { ToolInput } from "./pre-tool-context-phases.js";
import { isFileWrite } from "./tool-classifiers.js";

// See the module header: types/config.ts is at its line cap right now, so
// this field is merged in here rather than declared as a member there.
declare module "../types/config.js" {
	interface GuardRulesConfig {
		/** Mutation-directed file-class severity profile (Luna gate audit §3a,
		 *  docs/design/luna-gate-audit-2026-08-14.md). Default OFF. */
		mutation_directed_strict_profile?: { enabled?: boolean };
	}
}

function profileEnabled(rules: GuardRulesConfig): boolean {
	return rules.mutation_directed_strict_profile?.enabled === true;
}

function removedAssertionWarning(filePath: string, removed: InlineMatch[]): string {
	return (
		`[interlinked:${REMOVED_ASSERTION_CHECK_ID}] ${filePath} removes ${removed.length} test-case/` +
		`assertion line(s) vs the on-disk baseline (first at L${removed[0]?.line ?? 0}). Mutation-directed ` +
		"files are graded on kill evidence — confirm this removal is a legitimate refactor, not evidence " +
		"going missing."
	);
}

function removedAssertionBlock(
	filePath: string,
	removed: InlineMatch[],
	warnings: string[],
): HarnessDecision {
	const first = removed[0];
	const restSummary = removed.length > 1 ? ` (+ ${removed.length - 1} more at ${lineList(removed)})` : "";
	return {
		decision: "block",
		reason:
			`BLOCKED by [${REMOVED_ASSERTION_CHECK_ID}]. This edit removes ${removed.length} test-case/` +
			`assertion line(s) from ${filePath} vs the on-disk baseline. First: L${first?.line ?? 0} — ` +
			`"${first?.text ?? ""}"${restSummary}. Mutation-directed files are graded on kill evidence — ` +
			"restore the assertion, or if this is a deliberate consolidation/rename, keep the replacement " +
			"case's assertion count at or above what it replaces. File-level escape hatch: add an entry for " +
			`"${REMOVED_ASSERTION_CHECK_ID}" to .interlinked/verify-suppressions.json for ${filePath}.`,
		warnings,
		rule_id: REMOVED_ASSERTION_CHECK_ID,
		severity: "high",
		category: "pre-block",
	};
}

function preexistingSignalWarning(filePath: string, checkId: string, preexisting: InlineMatch[]): string {
	return (
		`[interlinked:mutation-directed-profile] ${filePath} carries ${preexisting.length} pre-existing ` +
		`[${checkId}] instance(s) at ${lineList(preexisting)} — not introduced by this edit, so the strict ` +
		"profile did not block."
	);
}

function stringField(obj: ToolInput, key: string): string {
	const v = obj[key];
	return typeof v === "string" ? v : "";
}

/** Sibling files carried by a multi-file edit payload: `edits[]` entries that
 *  name their OWN `file_path` (a batch-shaped MultiEdit). Claude Code's
 *  MultiEdit is single-file — its entries carry no path — and yields []. */
function collectChangeSetSiblings(toolInput: ToolInput, primaryPath: string): ChangeSetSibling[] {
	const edits = toolInput.edits;
	if (!Array.isArray(edits)) return [];
	const out: ChangeSetSibling[] = [];
	for (const entry of edits) {
		if (!isJsonObject(entry)) continue;
		const path = stringField(entry, "file_path");
		if (!path || path === primaryPath) continue;
		out.push({
			filePath: path,
			content: resolveProposedContent(path, entry),
			baselineContent: resolveDiskBaseline(path),
		});
	}
	return out;
}

/** Campaign waiver: with INTERLINKED_ASSERTION_MOVE_WAIVER=1 a would-be block
 *  becomes an allow, PROVIDED every waived removal lands in the ledger (a dry
 *  run counts as landed without writing). Returns true when waived. */
function waiveRemoval(
	event: HarnessEvent,
	args: MutationDirectedProfileArgs,
	removed: InlineMatch[],
	warnings: string[],
): boolean {
	if (!assertionMoveWaiverActive()) return false;
	const { filePath, projectRoot } = args;
	const records = buildAssertionWaiverRecords({ filePath, removed, sessionId: event.session_id });
	if (!appendAssertionWaivers(projectRoot ?? "", records, event.dry_run)) {
		warnings.push(
			`[interlinked:${REMOVED_ASSERTION_CHECK_ID}] ${ASSERTION_WAIVER_ENV}=1 is set but the waiver ledger ` +
				`${projectRoot ?? ""}/.interlinked/${ASSERTION_WAIVER_LOG} could not be written — waiver NOT honored.`,
		);
		return false;
	}
	const persisted = event.dry_run ? " (dry run: not persisted)" : "";
	warnings.push(
		`[interlinked:${REMOVED_ASSERTION_CHECK_ID}] WAIVED ${removed.length} assertion removal(s) in ${filePath} ` +
			`under ${ASSERTION_WAIVER_ENV}=1 — recorded to .interlinked/${ASSERTION_WAIVER_LOG}${persisted}.`,
	);
	return true;
}

/** GATE 2 — assertion-removal delta. A removal paid for by an equivalent
 *  addition in the same edit (a MOVE) is silent. A true removal warns
 *  unconditionally; the block is flag-gated (see module header) and can be
 *  converted to a logged allow by the campaign waiver. */
function evaluateRemovalGate(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	args: MutationDirectedProfileArgs,
	warnings: string[],
): HarnessDecision | null {
	const { removed } = classifyRemovedAssertions(args);
	if (removed.length === 0) return null;
	warnings.push(removedAssertionWarning(args.filePath, removed));
	if (!profileEnabled(rules)) return null;
	if (waiveRemoval(event, args, removed, warnings)) return null;
	return removedAssertionBlock(args.filePath, removed, warnings);
}

/** The second call of a cross-file move (module header): the assertion lines
 *  this edit introduces redeem this session's pending waived removals. Pure
 *  bookkeeping — never changes the verdict; one warning names the count. */
function redeemPendingRemovals(event: HarnessEvent, args: MutationDirectedProfileArgs, warnings: string[]): void {
	const { content, filePath, baselineContent, projectRoot } = args;
	const added = introducedAssertionLines({ filePath, content, baselineContent: baselineContent ?? null });
	const redeemed = redeemWaivedRemovals({
		projectRoot: projectRoot ?? "",
		sessionId: event.session_id,
		addingFile: filePath,
		added,
		dryRun: event.dry_run,
	});
	if (redeemed.length === 0) return;
	const persisted = event.dry_run ? " (dry run: not persisted)" : "";
	warnings.push(
		`[interlinked:${REMOVED_ASSERTION_CHECK_ID}] REDEEMED ${redeemed.length} waived removal(s) from ` +
			`${redeemed[0]?.file ?? ""} — equivalent assertion(s) added here; recorded to ` +
			`.interlinked/${ASSERTION_WAIVER_LOG}${persisted}.`,
	);
}

/**
 * PreToolUse phase. No-op unless the write touches a MUTATION_DIRECTED_PATH
 * file. Returns a block decision, or null after pushing any warnings.
 */
export function evaluateMutationDirectedProfile(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (!(isFileWrite(toolName) && (toolInput.content || toolInput.new_string))) return null;
	const filePath = stringField(toolInput, "file_path") || stringField(toolInput, "path");
	if (!filePath || !isMutationDirectedFile(filePath)) return null;

	const content = resolveProposedContent(filePath, toolInput);
	const baselineContent = resolveDiskBaseline(filePath);
	const projectRoot =
		findProjectRoot(filePath, event.cwd || process.cwd()) || event.cwd || process.cwd();
	const siblings = collectChangeSetSiblings(toolInput, filePath);
	const args: MutationDirectedProfileArgs = { content, filePath, baselineContent, projectRoot, siblings };

	const removalBlock = evaluateRemovalGate(event, rules, args, warnings);
	if (removalBlock) return removalBlock;
	redeemPendingRemovals(event, args, warnings);

	// GATE 1 — severity remap. Skip the (real) compute entirely at the
	// default OFF state: a full checkTestLegitimacy + SUT-import pass + test-
	// block extraction is not free, and this file class already paid for the
	// pre_warn version of the same work in evaluateWriteContent.
	if (!profileEnabled(rules)) return null;
	const outcomes = evaluateMutationDirectedSignals(args);
	const blocking = outcomes.find((o) => o.introduced.length > 0);
	if (blocking) return preBlockIntroducedBlock(blocking, filePath, warnings);
	for (const o of outcomes) {
		if (o.preexisting.length > 0) {
			warnings.push(preexistingSignalWarning(filePath, o.checkId, o.preexisting));
		}
	}
	return null;
}
