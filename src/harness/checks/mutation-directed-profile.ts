// ===========================================
// Mutation-directed file-class severity profile — detection layer
// ===========================================
// docs/design/luna-gate-audit-2026-08-14.md §3(a): a Codex CLI session spawned
// 142 tests-only sub-agents against *.mutation-kill.* / *.mutation-hardening.*
// / *.survivor(s).* files; one of them (`kill_taste_smell_mutants`) wrote 30
// new assertions and self-reported "No mutation measurement was run." The
// audit's §3(a) proposal: files an agent itself opted into the mutation-
// directed naming convention deserve a STRICTER bar than ordinary test files
// — pre_block instead of pre_warn — because the agent named its own contract.
//
// Two gates live here, both scoped to MUTATION_DIRECTED_PATH
// (test-legitimacy.ts's own file-class primitive, reused verbatim):
//
//   GATE 1 — severity remap, NOT new detection. Three ALREADY-SHIPPED
//   pre_warn signals reused as-is: checkTestLegitimacy's receipt-missing
//   branch, checkTestMissingSutImport, and checkTestLegitimacy's
//   BROAD_TRUTHINESS branch narrowed to "the sole assertion in its test
//   block" — the precision qualifier that keeps a heuristic truthiness match
//   safe to hard-block (a toBeTruthy() alongside real assertions is left at
//   pre_warn; only a toBeTruthy()/toBeFalsy() carrying the whole test escalates).
//   Every finding here is produced by a detector that already ships at
//   pre_warn today, so it inherits that detector's evidence — this module
//   only recombines outputs and applies pre-block-gate.ts's introduced-only
//   multiset diff (`splitIntroduced`), never re-derives detection.
//
//   GATE 2 — assertion-removal delta. Genuinely NEW detection: did this edit
//   REMOVE an it()/test()/expect() line present in the on-disk baseline?
//   Uses `splitRemoved`, the mirror of `splitIntroduced` added alongside it
//   in pre-block-gate.ts for this purpose. See its own companion test file
//   for the evidence dossier (this detector is not grandfathered).
//   MOVE-aware (2026-09): a removed line paid for by an EQUIVALENT added
//   line in the same edit (same expect() subject + terminal matcher +
//   expected-value text; this file or a mutation-directed `siblings` entry
//   of the same ChangeSet) is a move, not a loss —
//   `classifyRemovedAssertions` splits removed/moved; only `removed` fires.
//   The campaign waiver (INTERLINKED_ASSERTION_MOVE_WAIVER=1, ledger in
//   assertion-waiver-log.ts) lives in the evaluator, not here.
//
// Suppression-aware like every other pre_block surface (pre-block-gate.ts's
// own header comment, point 2): a directive exempts a finding here exactly
// the way it exempts one in runPreBlockRegistryGate. GATE 1 findings sit on
// real (surviving) lines, so inline `// interlinked-ignore:` above the line
// works; GATE 2 findings are about a DELETED line with nowhere to place an
// inline comment, so only the file-level `.interlinked/verify-suppressions.json`
// entry applies there.
//
// Pure content functions only — no config reading, no HarnessDecision
// construction. The PreToolUse wiring (config flag, warning vs block,
// message building) lives in evaluator/mutation-directed-guard.ts.

import type { InlineMatch } from "../check-registry/types.js";
import { buildCheckInstructions } from "../check-registry/index.js";
import {
	fileSuppressionsFor,
	splitIntroduced,
	splitRemoved,
	type PreBlockCheckOutcome,
} from "../pre-block-gate.js";
import { isSuppressed, scanInlineSuppressions } from "../suppressions.js";
import { type MovedAssertionSplit, partitionMovedAssertions } from "./assertion-move.js";
import { getExtension, isStrictTestFile, JS_TS_EXTS } from "./shared.js";
import { maskCommentsAndStrings } from "./test-hygiene-masking.js";
import {
	BROAD_TRUTHINESS,
	checkTestLegitimacy,
	MUTATION_DIRECTED_PATH,
	RECEIPT_MISSING_PREFIX,
	TEST_CASE_LINE,
	TRUNCATION_SUMMARY_PREFIX,
} from "./test-legitimacy.js";
import { checkTestMissingSutImport } from "./test-hygiene-quality.js";
import { extractTestBlocks, innermostBlockAt } from "./test-structure.js";
import { stripAllLiterals } from "../strip-helpers.js";

/** Synthetic check id for GATE 2 — there is no registered detector by this
 *  name (see the module header: it is not in CHECK_REGISTRY), but a stable
 *  id is still needed for the block/warning `rule_id`, the suppression
 *  lookup key, and the companion test file's labeled cases. */
export const REMOVED_ASSERTION_CHECK_ID = "mutation_directed_assertion_removal";

/** Shared input shape for both gates — mirrors pre-block-gate.ts's own
 *  `PreBlockGateArgs` so callers building one args object can feed both. */
export interface MutationDirectedProfileArgs {
	/** Proposed FULL post-edit content. */
	content: string;
	filePath: string;
	/** Full pre-edit baseline content; null/undefined ⇒ nothing to diff
	 *  against (GATE 1 treats every finding as introduced, matching
	 *  pre-block-gate.ts's own strict-degrade rule; GATE 2 has nothing to
	 *  have removed, so it reports nothing). */
	baselineContent?: string | null | undefined;
	/** Project root, for `.interlinked/verify-suppressions.json` resolution.
	 *  Omitted ⇒ inline suppressions only (GATE 1) / no suppression (GATE 2). */
	projectRoot?: string | undefined;
	/** Other files written by the SAME edit/ChangeSet. GATE 2 only: an
	 *  assertion removed here and re-added (equivalently) in a sibling is a
	 *  MOVE, not a loss. GATE 1 ignores siblings. */
	siblings?: ChangeSetSibling[] | undefined;
}

/** One sibling file of a multi-file edit — proposed content plus its own
 *  on-disk baseline (null when the sibling is a new file). Only a sibling
 *  that is ITSELF mutation-directed (`isMutationDirectedFile`) can pay for a
 *  removal: kill evidence that leaves the graded file class — deleted from
 *  `x.mutation-kill.test.ts`, re-added to plain `x.test.ts` — is a loss for
 *  the mutation grade even though the assertion text survives, so such a
 *  sibling is ignored and the removal stays a removal. */
export interface ChangeSetSibling {
	filePath: string;
	content: string;
	baselineContent: string | null;
}

/** True when `filePath` is in the mutation-directed file class this whole
 *  profile applies to — the SAME predicate test-legitimacy.ts gates its own
 *  receipt-missing rule on, reused rather than redefined. */
export function isMutationDirectedFile(filePath: string): boolean {
	return MUTATION_DIRECTED_PATH.test(filePath.replace(/\\/g, "/"));
}

// ───────────────────────────────────────────────────────────────
// GATE 1 — severity remap (reuses existing detector output)
// ───────────────────────────────────────────────────────────────

/** checkTestLegitimacy's receipt-missing findings only, identified by the
 *  stable `.text` prefix the detector itself already emits to agents today —
 *  not a re-derivation of the marker-adjacency scan. */
function receiptMissingMatches(content: string, filePath: string): InlineMatch[] {
	return checkTestLegitimacy(content, filePath).filter((m) => m.text.startsWith(RECEIPT_MISSING_PREFIX));
}

/** Count of `expect(...)` call OPENINGS in `span` (masked — comments/strings
 *  already blanked). One count per call regardless of which matcher chain
 *  follows, so `expect(x).toBeTruthy()` and `expect(y).toEqual(1)` each
 *  count once. */
function expectCallCount(span: string): number {
	return (span.match(new RegExp(EXPECT_CALL.source, "g")) ?? []).length;
}

const EXPECT_CALL = /\bexpect(?:\.(?:soft|any))?\s*\(/;

/** checkTestLegitimacy's broad-truthiness findings, narrowed to the ones
 *  that are the ONLY `expect(...)` call in their enclosing it()/test() block
 *  — the precision qualifier that makes a heuristic match safe to hard-block.
 *  A truthiness check sitting alongside real assertions is left at pre_warn;
 *  only one that IS the test's entire evidence escalates. Ambiguous cases
 *  (no resolvable enclosing test block) are conservatively left alone. */
function soleTruthinessMatches(content: string, filePath: string): InlineMatch[] {
	const all = checkTestLegitimacy(content, filePath);
	if (all.length === 0) return [];
	const mLines = stripAllLiterals(content).split("\n");
	// The trailing count summary borrows the last listed finding's line, so a
	// truthiness line would re-match it — a count is not a location, and letting
	// it through would make the pre_block gate fire on a changed TOTAL.
	const truthy = all.filter(
		(m) => !m.text.startsWith(TRUNCATION_SUMMARY_PREFIX) && BROAD_TRUTHINESS.test(mLines[m.line - 1] ?? ""),
	);
	if (truthy.length === 0) return [];
	const blocks = extractTestBlocks(mLines);
	const out: InlineMatch[] = [];
	for (const m of truthy) {
		const idx = innermostBlockAt(blocks, m.line - 1);
		const block = idx === -1 ? undefined : blocks[idx];
		if (!block || block.kind !== "test") continue;
		const span = mLines.slice(block.startLine, block.endLine + 1).join("\n");
		if (expectCallCount(span) <= 1) out.push(m);
	}
	return out;
}

/** Filter builder for one check id's suppression state against a shared
 *  inline-suppression scan + file-suppression set. */
function notSuppressed(
	checkId: string,
	inline: ReturnType<typeof scanInlineSuppressions>,
	fileSup: ReturnType<typeof fileSuppressionsFor>,
): (m: InlineMatch) => boolean {
	return (m) => !isSuppressed(checkId, m.line, inline, fileSup);
}

/**
 * GATE 1: the three promoted signals, each split introduced-vs-pre-existing
 * against `baselineContent` and suppression-filtered on the PROPOSED side
 * only (matching runPreBlockRegistryGate: "a directive only exempts lines in
 * the proposed content"). Returns [] entirely when `filePath` is not
 * mutation-directed. Callers block iff some outcome has `introduced.length >
 * 0`; `deferrable` is always false — nothing here is a coordinated-refactor
 * transient debt.
 */
export function evaluateMutationDirectedSignals(
	args: MutationDirectedProfileArgs,
): PreBlockCheckOutcome[] {
	const { content, filePath, baselineContent, projectRoot } = args;
	if (!isMutationDirectedFile(filePath)) return [];
	const hasBaseline = baselineContent != null;
	const baseline = baselineContent ?? "";
	const instructions = buildCheckInstructions();
	const inline = scanInlineSuppressions(content);
	const fileSup = fileSuppressionsFor(filePath, projectRoot);

	const newReceipt = receiptMissingMatches(content, filePath).filter(
		notSuppressed("test_legitimacy", inline, fileSup),
	);
	const newTruthy = soleTruthinessMatches(content, filePath).filter(
		notSuppressed("test_legitimacy", inline, fileSup),
	);
	const oldReceipt = hasBaseline ? receiptMissingMatches(baseline, filePath) : [];
	const oldTruthy = hasBaseline ? soleTruthinessMatches(baseline, filePath) : [];
	const receiptSplit = splitIntroduced(newReceipt, oldReceipt);
	const truthySplit = splitIntroduced(newTruthy, oldTruthy);

	const newSut = checkTestMissingSutImport(content, filePath).filter(
		notSuppressed("test_missing_sut_import", inline, fileSup),
	);
	const oldSut = hasBaseline ? checkTestMissingSutImport(baseline, filePath) : [];
	const sutSplit = splitIntroduced(newSut, oldSut);

	return [
		{
			checkId: "test_legitimacy",
			introduced: [...receiptSplit.introduced, ...truthySplit.introduced],
			preexisting: [...receiptSplit.preexisting, ...truthySplit.preexisting],
			instruction: instructions.test_legitimacy ?? "",
			deferrable: false,
		},
		{
			checkId: "test_missing_sut_import",
			introduced: sutSplit.introduced,
			preexisting: sutSplit.preexisting,
			instruction: instructions.test_missing_sut_import ?? "",
			deferrable: false,
		},
	];
}

// ───────────────────────────────────────────────────────────────
// GATE 2 — assertion-removal delta (new detection)
// ───────────────────────────────────────────────────────────────

/** Lines that are either an it()/test()/specify() case declaration or an
 *  `expect(...)` assertion call — the two line-shapes GATE 2 tracks removal
 *  of. Scoped to real JS/TS test files, same gate `checkTestMissingSutImport`
 *  applies. */
function assertionAndCaseLines(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath) || !JS_TS_EXTS.has(getExtension(filePath))) return [];
	const lines = content.split("\n");
	const codeLines = maskCommentsAndStrings(content).split("\n");
	const out: InlineMatch[] = [];
	for (let i = 0; i < codeLines.length; i++) {
		const codeLine = codeLines[i] ?? "";
		if (TEST_CASE_LINE.test(codeLine) || EXPECT_CALL.test(codeLine)) {
			out.push({ line: i + 1, text: (lines[i] ?? "").trim().slice(0, 150) });
		}
	}
	return out;
}

/**
 * GATE 2: test-case/assertion lines present in `baselineContent` with no
 * surviving identical-text counterpart in `content` — an edit that deletes
 * kill evidence from a mutation-directed file. [] when `filePath` is not
 * mutation-directed, when there is no baseline (nothing to have removed), or
 * when the file carries a file-level suppression for
 * REMOVED_ASSERTION_CHECK_ID (inline suppression cannot apply — there is no
 * surviving line to place a directive above).
 */
export function detectRemovedAssertions(args: MutationDirectedProfileArgs): InlineMatch[] {
	return classifyRemovedAssertions(args).removed;
}

/**
 * Assertion/case lines this edit INTRODUCES in one mutation-directed file (no
 * baseline ⇒ every line is new) — the pool that can pay for a removal
 * elsewhere in the edit, or REDEEM a same-session waived removal from the
 * ledger (assertion-waiver-log.ts). [] for any file outside the graded class.
 */
export function introducedAssertionLines(file: ChangeSetSibling): InlineMatch[] {
	if (!isMutationDirectedFile(file.filePath)) return [];
	const proposed = assertionAndCaseLines(file.content, file.filePath);
	if (file.baselineContent == null) return proposed;
	return splitIntroduced(proposed, assertionAndCaseLines(file.baselineContent, file.filePath)).introduced;
}

/**
 * GATE 2 with MOVE awareness: the exact-text removals of
 * {@link detectRemovedAssertions}, split into `removed` (evidence left the
 * edit) and `moved` (an equivalent assertion — same subject, same terminal
 * matcher, same expected-value text — was ADDED by the same edit, in this
 * file or any mutation-directed `siblings` entry; see
 * checks/assertion-move.ts). Only `removed` warns or blocks. Same []
 * conditions as the plain detector.
 */
export function classifyRemovedAssertions(args: MutationDirectedProfileArgs): MovedAssertionSplit {
	const { content, filePath, baselineContent, projectRoot, siblings } = args;
	if (!isMutationDirectedFile(filePath) || baselineContent == null) return { removed: [], moved: [] };
	if (fileSuppressionsFor(filePath, projectRoot).has(REMOVED_ASSERTION_CHECK_ID)) return { removed: [], moved: [] };
	const { removed } = splitRemoved(
		assertionAndCaseLines(content, filePath),
		assertionAndCaseLines(baselineContent, filePath),
	);
	if (removed.length === 0) return { removed, moved: [] };
	const added = introducedAssertionLines({ filePath, content, baselineContent });
	for (const s of siblings ?? []) added.push(...introducedAssertionLines(s));
	return partitionMovedAssertions(removed, added);
}
