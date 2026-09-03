// ===========================================
// Pre-block registry gate — introduced-only findings + suppressions
// ===========================================
// ONE semantics for both pre_block surfaces — the PreToolUse write guard
// (evaluator/write-content-guards.ts) and the batch content gate
// (content-gate.ts) — so their parity is structural, not mirrored:
//
//   1. INTRODUCED-ONLY BLOCKING. A pre_block finding blocks only when the
//      edit introduces it: the proposed content carries more instances of
//      that finding's line text than the on-disk baseline. A pre-existing
//      finding never blocks an unrelated edit — the bio-orchestrator wall
//      (2026-07): one legacy match at L49 made a ~1,100-line registry file
//      un-editable for every future entry. Pre-existing findings surface as
//      warnings instead (fix-what-you-touch), and `interlinked verify` still
//      reports them. Matches are keyed by whitespace-normalized line TEXT
//      (multiset), not line number, so pure moves/renumbering stay
//      "pre-existing" while a genuine second copy of a flagged line counts
//      as introduced. This matches the biome/tsc diff-overlays beside it,
//      which have been new-findings-only from day one.
//   2. SUPPRESSIONS HONORED. `// interlinked-ignore: <check_id> — reason`
//      above a line, and file-level entries in
//      `.interlinked/verify-suppressions.json`, exempt a finding — the same
//      grammar the PostToolUse and verify pipelines already honor; pre_block
//      was the one surface that ignored it, leaving no way to say "this
//      line is deliberate". The suppression_ratchet counts directive growth,
//      so this is an auditable exception, not a silent bypass.
//   3. STRICT DEGRADE. No baseline (new file, unreadable disk) ⇒ every
//      finding is introduced — the legacy behavior.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildAgentSafetyChecks, buildCheckInstructions } from "./check-registry/builders.js";
import { CHECK_REGISTRY } from "./check-registry/registry.js";
import type { InlineMatch } from "./check-registry/types.js";
import {
	type FileSuppressions,
	type InlineSuppressions,
	isSuppressed,
	loadFileSuppressions,
	scanInlineSuppressions,
} from "./suppressions.js";
import type { HarnessDecision } from "./types.js";

/** One pre_block check's findings, split by whether this edit introduces them. */
export interface PreBlockCheckOutcome {
	checkId: string;
	/** Findings the proposed content adds over the baseline — these block. */
	introduced: InlineMatch[];
	/** Findings already present in the baseline — warning only, never block. */
	preexisting: InlineMatch[];
	/** The check's fix_instruction, for message building. */
	instruction: string;
	/** True when the check is marked `deferrable` — the caller routes these to
	 *  the transient-debt ledger instead of refusing the edit outright. */
	deferrable: boolean;
}

export interface PreBlockGateArgs {
	/** Proposed FULL post-edit content. */
	content: string;
	filePath: string;
	/** Full pre-edit baseline content; null/undefined ⇒ strict (all introduced). */
	baselineContent?: string | null | undefined;
	/** Project root, for `.interlinked/verify-suppressions.json` resolution.
	 *  Omitted ⇒ inline suppressions only. */
	projectRoot?: string | undefined;
}

/** The on-disk content of `filePath`, or null (new file / unreadable). The
 *  full-file baseline for introduced-only comparison — deliberately NOT the
 *  Edit tool's `old_string` snippet, which is delta-granular and would make
 *  every pre-existing finding outside the snippet read as "introduced". */
export function resolveDiskBaseline(filePath: string): string | null {
	try {
		if (filePath && existsSync(filePath)) return readFileSync(filePath, "utf-8");
	} catch (e) {
		void e; // intentional: stat/read failure ⇒ no baseline ⇒ strict gate
	}
	return null;
}

/** Whitespace-normalized multiset key for a finding — line-number-free so an
 *  edit that shifts or reflows unrelated lines cannot re-classify a
 *  pre-existing finding as introduced. */
/** Check ids marked `deferrable` in the registry. Built once — the registry is
 *  a module-level constant, so a per-edit scan would be pure waste. */
const DEFERRABLE_CHECK_IDS: ReadonlySet<string> = new Set(
	CHECK_REGISTRY.filter((c) => c.deferrable === true).map((c) => c.id),
);

function matchKey(m: InlineMatch): string {
	return m.text.replace(/\s+/g, " ").trim();
}

/** Split `newMatches` into introduced/pre-existing against the baseline's
 *  matches: each baseline occurrence "pays for" one identical-text new
 *  occurrence; the surplus is introduced.
 *
 *  Exported: mutation-kill-evidence-stop-check.ts (the Stop-time kill-evidence
 *  nudge) reuses this exact introduced-only semantics against a DIFFERENT
 *  check's output (checkTestLegitimacy's missing-contract findings) rather
 *  than re-deriving the multiset diff. */
export function splitIntroduced(
	newMatches: InlineMatch[],
	baselineMatches: InlineMatch[],
): { introduced: InlineMatch[]; preexisting: InlineMatch[] } {
	const budget = new Map<string, number>();
	for (const m of baselineMatches) {
		const k = matchKey(m);
		budget.set(k, (budget.get(k) ?? 0) + 1);
	}
	const introduced: InlineMatch[] = [];
	const preexisting: InlineMatch[] = [];
	for (const m of newMatches) {
		const k = matchKey(m);
		const n = budget.get(k) ?? 0;
		if (n > 0) {
			budget.set(k, n - 1);
			preexisting.push(m);
		} else {
			introduced.push(m);
		}
	}
	return { introduced, preexisting };
}

/** Mirror of {@link splitIntroduced} for the opposite diff direction: which
 *  `baselineMatches` have no surviving counterpart in `newMatches` — a line
 *  this edit REMOVES rather than one it introduces. Each new occurrence "pays
 *  for" one identical-text baseline occurrence; the leftover baseline matches
 *  are the ones this edit deleted. `splitIntroduced` only ever answered "did
 *  this edit ADD a bad line" — this answers the mirror question, "did this
 *  edit REMOVE a good line" (docs/design/luna-gate-audit-2026-08-14.md §3,
 *  GATE 2 — assertion-removal delta on mutation-directed test files). */
export function splitRemoved(
	newMatches: InlineMatch[],
	baselineMatches: InlineMatch[],
): { removed: InlineMatch[] } {
	const budget = new Map<string, number>();
	for (const m of newMatches) {
		const k = matchKey(m);
		budget.set(k, (budget.get(k) ?? 0) + 1);
	}
	const removed: InlineMatch[] = [];
	for (const m of baselineMatches) {
		const k = matchKey(m);
		const n = budget.get(k) ?? 0;
		if (n > 0) {
			budget.set(k, n - 1);
		} else {
			removed.push(m);
		}
	}
	return { removed };
}

/** File-level suppressions for `filePath`, or an empty set when no
 *  `projectRoot` was supplied. Path is repo-relativized (POSIX) to match the
 *  keys `verify-suppressions.json` is written with. Exported: reused by
 *  mutation-directed-profile.ts so a file-level suppression of GATE
 *  1/2's synthetic check ids works the same way every other pre_block
 *  surface's file-level suppression does — one FileSuppressions loader. */
export function fileSuppressionsFor(filePath: string, projectRoot: string | undefined): FileSuppressions {
	if (!projectRoot) return new Set();
	const rel = relative(projectRoot, resolve(projectRoot, filePath)).replace(/\\/g, "/");
	return loadFileSuppressions(join(projectRoot, ".interlinked"), rel);
}

/** Lazily-populated state shared across one gate run's check loop: the
 *  suppression scans (each computed at most once) and the baseline check
 *  run (computed at most once, only if some new-content check fired). */
interface PreBlockLazyState {
	inline: InlineSuppressions | null;
	fileSup: FileSuppressions | null;
	baselineByCheck: Map<string, InlineMatch[]> | null;
}

/** Evaluate one pre_block check's raw findings against suppressions and the
 *  baseline, returning the outcome to record — or null when the check found
 *  nothing, or everything it found is suppressed. Populates `state`'s lazy
 *  caches on first use so the whole check loop pays for each of them once. */
function evaluatePreBlockCheck(
	check: { name: string; severity: "error" | "warning"; fn: () => InlineMatch[] },
	content: string,
	filePath: string,
	baselineContent: string | null | undefined,
	projectRoot: string | undefined,
	instructions: Record<string, string>,
	state: PreBlockLazyState,
): PreBlockCheckOutcome | null {
	const rawMatches = check.fn();
	if (rawMatches.length === 0) return null;

	// Suppression filter (lazy scans, shared across checks). Suppressed
	// findings are dropped entirely — "a suppressed finding is never
	// shown" (suppressions.ts) — and the suppression ratchet keeps the
	// directives themselves loud.
	state.inline ??= scanInlineSuppressions(content);
	state.fileSup ??= fileSuppressionsFor(filePath, projectRoot);
	const inlineSup = state.inline;
	const fileSupSet = state.fileSup;
	const matches = rawMatches.filter(
		(m) => !isSuppressed(check.name, m.line, inlineSup, fileSupSet),
	);
	if (matches.length === 0) return null;

	// Baseline findings (lazy, one pass for all fired checks). The
	// baseline run applies the SAME registry pipeline so old and new
	// findings are comparable; suppressions are not subtracted from the
	// baseline — a directive only exempts lines in the proposed content.
	if (state.baselineByCheck === null) {
		state.baselineByCheck = new Map();
		if (baselineContent != null && baselineContent !== "") {
			for (const old of buildAgentSafetyChecks(baselineContent, filePath, "pre_block")) {
				state.baselineByCheck.set(old.name, old.fn());
			}
		}
	}
	const { introduced, preexisting } = splitIntroduced(
		matches,
		state.baselineByCheck.get(check.name) ?? [],
	);
	return {
		checkId: check.name,
		introduced,
		preexisting,
		instruction: instructions[check.name] ?? "",
		deferrable: DEFERRABLE_CHECK_IDS.has(check.name),
	};
}

/**
 * Run every pre_block registry check against the proposed content and return
 * one outcome per check that (still) has findings after suppression
 * filtering, split introduced/pre-existing against the baseline. Callers
 * block iff some outcome has `introduced.length > 0`, and surface
 * `preexisting` as warnings. Baseline detectors run lazily — only when a
 * new-content check actually fired (the common all-clean edit pays nothing
 * extra).
 */
export function runPreBlockRegistryGate(args: PreBlockGateArgs): PreBlockCheckOutcome[] {
	const { content, filePath, baselineContent, projectRoot } = args;
	const checks = buildAgentSafetyChecks(content, filePath, "pre_block");
	const instructions = buildCheckInstructions();
	const outcomes: PreBlockCheckOutcome[] = [];
	const state: PreBlockLazyState = { inline: null, fileSup: null, baselineByCheck: null };

	for (const check of checks) {
		const outcome = evaluatePreBlockCheck(
			check,
			content,
			filePath,
			baselineContent,
			projectRoot,
			instructions,
			state,
		);
		if (outcome) outcomes.push(outcome);
	}
	return outcomes;
}

/** Render `L12, L48, …` (capped at five) for a finding list. */
export function lineList(matches: InlineMatch[]): string {
	const shown = matches.slice(0, 5).map((m) => `L${m.line}`);
	return matches.length > 5 ? `${shown.join(", ")}, …` : shown.join(", ");
}

/** The "this line is deliberate" clause every pre_block message points at —
 *  the auditable exception grammar (already ratcheted + honored by verify). */
export function suppressionHint(checkId: string): string {
	return (
		`If a flagged line is deliberate, mark it: \`// interlinked-ignore: ${checkId} — <why>\` ` +
		"on the line above (counted by the suppression ratchet), or add a file entry to " +
		".interlinked/verify-suppressions.json."
	);
}

/** The block decision for a pre_block outcome this edit INTRODUCES findings
 *  for: names only the introduced lines, notes (without blocking on) any
 *  pre-existing instances, and points at the auditable suppression grammar.
 *  `warnings` is the caller's accumulated warning list, carried on the
 *  decision like every other write-guard block. */
export function preBlockIntroducedBlock(
	o: PreBlockCheckOutcome,
	filePath: string,
	warnings: string[],
): HarnessDecision {
	const preexistingNote =
		o.preexisting.length > 0
			? ` (${o.preexisting.length} pre-existing instance(s) at ${lineList(o.preexisting)} did not block.)`
			: "";
	return {
		decision: "block",
		reason:
			`BLOCKED by pre-block rule [${o.checkId}]. This edit INTRODUCES ` +
			`${o.introduced.length} violation(s) at ${lineList(o.introduced)} in ${filePath}.` +
			`${preexistingNote} Fix the introduced line(s), then retry.\n` +
			`${o.instruction}\n${suppressionHint(o.checkId)}`,
		warnings,
		rule_id: o.checkId,
		severity: "high",
		category: "pre-block",
	};
}

/** Fix-what-you-touch warnings for outcomes carrying ONLY pre-existing
 *  findings — visible, never blocking (the bio-orchestrator wall fix). */
export function preexistingPreBlockWarnings(
	outcomes: PreBlockCheckOutcome[],
	filePath: string,
): string[] {
	return outcomes
		.filter((o) => o.preexisting.length > 0)
		.map(
			(o) =>
				`[interlinked:pre-block] ${filePath} carries ${o.preexisting.length} pre-existing ` +
				`[${o.checkId}] finding(s) at ${lineList(o.preexisting)} — not introduced by this ` +
				`edit, so it did not block. Fix them while you're in this file, or mark ` +
				`deliberate lines with \`// interlinked-ignore: ${o.checkId} — <why>\`.`,
		);
}
