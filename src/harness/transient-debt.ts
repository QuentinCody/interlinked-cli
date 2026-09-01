// ===========================================
// Transient debt — the deferred-verdict gate for coordinated edits
// ===========================================
// The middle rung of `docs/design/open-obligation-ledger.md`'s three-scope
// ladder, built for the class of finding whose wrongness is a property of a
// not-yet-complete tree: an unused import, a symbol referenced before it is
// declared, an import of an export that lands in the very next edit.
//
// The old answer to that class was a permanent demotion — `TSC_WARN_ONLY_CODES`
// in `diff-overlay.ts` turns those diagnostics into a warning FOREVER. That
// trades one failure mode for another: it stops false-blocking half-landed
// refactors, and in exchange a genuinely forgotten unused import never blocks
// at all. The finding was real; only the DEADLINE was wrong.
//
// So: warn at the edit that introduces it, and hold the finding open as a debt.
// A later edit to the same file re-runs the SAME checker (never a cheaper
// proxy) and discharges it when the diagnostic is gone. Edits that walk away
// from it spend the debt's slack, and once the slack is gone the next wander
// BLOCKS with the original finding in the reason.
//
// PURE: no fs, no clock, no config lookup. Ledger state, the current findings,
// timestamps, and the relatedness set are all INPUTS, so every decision is a
// total function of them — the same contract `obligations.ts` and
// `block-fingerprint.ts` hold, and the reason the wiring layer
// (`evaluator/transient-debt-guard.ts`) can stay a thin adapter.

import { inSamePair } from "./coverage-pairing.js";
import type { Obligation, ObligationTxn } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

/**
 * How many edits to UNRELATED files a transient debt tolerates before the gate
 * blocks. ONE, deliberately — not zero, not a countdown.
 *
 * Zero would false-block the exact case this whole mechanism exists to permit:
 * you add `import { helper } from "./b.js"` to `a.ts` (unused for one beat),
 * then edit `b.ts` to export `helper`. `b.ts` is "unrelated" to `a.ts` by any
 * cheap filename rule, so a zero-slack gate refuses the second half of the very
 * refactor it deferred. One free wander covers the coordinated counterpart edit.
 *
 * A second unrelated edit is a different animal: the agent has moved on with the
 * debt still open, which is precisely "forgot", and it is what the permanent
 * warn-only demotion could never catch.
 */
export const DEFAULT_TRANSIENT_SLACK = 1;

/**
 * A debt open longer than this stops BLOCKING and only warns.
 *
 * The ledger is repo-wide, so under a parallel agent wave one agent's in-flight
 * breakage blocks every other agent — and the victims cannot fix it, because the
 * offending file is outside their assigned scope. Measured 2026-08-05: a 20-agent
 * mutation wave had two agents produce ZERO work (188 survivors untouched)
 * because every edit to their OWN file was refused over a `TS2532` in an
 * unrelated file owned by a different agent. Their strike counters climbed while
 * they had no legal move.
 *
 * Age separates the two cases without needing agent identity (which the ledger
 * does not carry — subagents share the parent's sessionId). A real single-agent
 * wander is detected within a minute or two of opening the debt; a debt still
 * open ten minutes later, while this actor keeps working elsewhere, is almost
 * always someone else's. Warning still fires, so nothing is hidden — only the
 * hard block is withheld.
 */
export const CROSS_ACTOR_STALE_MS = 10 * 60 * 1000;

/** What a deferrable checker reported for the proposed content. `detector` is
 *  the checker's own id — a TS diagnostic code (`TS6133`) or a registry check
 *  id — and doubles as the debt's discharge key. */
export interface DeferrableFinding {
	detector: string;
	line: number;
	message: string;
}

/** Enforcement strength. `warn` runs the full lifecycle but never blocks (the
 *  rollout / legacy-repo setting); `off` is a pure pass-through that opens
 *  nothing, so turning it off cannot leave orphan debt behind. */
export type TransientDebtMode = "block" | "warn" | "off";

export interface TransientDebtInput {
	/** Repo-relative POSIX path of the file this write targets. */
	editedFile: string;
	/**
	 * Deferrable findings the PROPOSED content carries — the checker's full
	 * answer for this file, NOT the new-since-disk diff.
	 *
	 * The distinction is load-bearing for discharge. A diff would report an
	 * unchanged, still-present diagnostic as "no finding", and the debt would
	 * discharge itself on the next unrelated-but-same-file edit while the
	 * problem sat there untouched. Discharge means "the checker no longer sees
	 * it", which only the absolute answer can say.
	 */
	findings: readonly DeferrableFinding[];
	/** Currently-open `transient` obligations (any file). */
	openDebts: readonly Obligation[];
	/** Files that count as reconciling work for a debt beyond the filename pair
	 *  — e.g. direct import-graph neighbours, when the caller has a dependency
	 *  view. Absent ⇒ pair-relatedness only; the slack absorbs the difference. */
	relatedFiles?: ReadonlySet<string> | undefined;
	sessionId: string;
	atMs: number;
	/** Hash of the proposed content — the ledger's re-edit reconcile key. */
	contentHash: string;
	mode: TransientDebtMode;
	/** Wander tolerance; defaults to {@link DEFAULT_TRANSIENT_SLACK}. */
	slack?: number | undefined;
}

interface TransientDebtOutcome {
	/** A block decision, or null to let the write through. */
	decision: HarnessDecision | null;
	/** Warnings to surface on the allowed write (introduction notes, the
	 *  spent-slack heads-up, discharge confirmations). */
	warnings: string[];
	/** Ledger transitions the caller must persist, in order. */
	txns: ObligationTxn[];
}

/** True when editing `editedFile` is plausibly work ON `debt` rather than work
 *  away from it: the debt's own file, its source/test pair, or a caller-supplied
 *  neighbour. */
export function isReconcilingEdit(
	editedFile: string,
	debt: Obligation,
	relatedFiles?: ReadonlySet<string>,
): boolean {
	if (editedFile === debt.file) return true;
	if (relatedFiles?.has(debt.file)) return true;
	return inSamePair(editedFile, debt.file);
}

/** `L12 TS6133 'foo' is declared but never read` — the finding as the agent
 *  will see it in a warning or block reason. */
function renderFinding(f: DeferrableFinding): string {
	return `L${f.line} ${f.detector} ${f.message}`;
}

/** Debt identity is (file, detector); a debt whose detector is absent predates
 *  the field and is keyed on the file alone. */
function detectorOf(debt: Obligation): string {
	return debt.detector ?? "";
}

/** Open transient debts for one file, keyed by detector. */
function debtsForFile(debts: readonly Obligation[], file: string): Map<string, Obligation> {
	const out = new Map<string, Obligation>();
	for (const d of debts) {
		if (d.file === file) out.set(detectorOf(d), d);
	}
	return out;
}

/** The open/refresh transitions for the findings this write leaves behind, plus
 *  the "you have introduced a deferred finding" warnings. A finding already
 *  open re-opens with its strike count intact — re-stating a debt is not
 *  progress, but it is not a wander either. */
function openTxnsForFindings(
	input: TransientDebtInput,
	existing: Map<string, Obligation>,
): { txns: ObligationTxn[]; warnings: string[] } {
	const txns: ObligationTxn[] = [];
	const warnings: string[] = [];
	const byDetector = new Map<string, DeferrableFinding[]>();
	for (const f of input.findings) {
		const list = byDetector.get(f.detector);
		if (list) list.push(f);
		else byDetector.set(f.detector, [f]);
	}
	for (const [detector, group] of byDetector) {
		const prior = existing.get(detector);
		txns.push({
			op: "open",
			kind: "transient",
			file: input.editedFile,
			contentHash: input.contentHash,
			sessionId: input.sessionId,
			atMs: input.atMs,
			detector,
			strikes: prior?.strikes ?? 0,
		});
		if (prior) continue; // already announced; do not re-nag on every edit
		warnings.push(
			`[interlinked:transient-debt] ${input.editedFile} — ${detector} deferred: ` +
				`${group.map(renderFinding).join("; ")}. Not blocking: this is the shape a ` +
				"coordinated edit's other half resolves. Land that half next — after " +
				`${(input.slack ?? DEFAULT_TRANSIENT_SLACK) + 1} edits away from this file it becomes a block.`,
		);
	}
	return { txns, warnings };
}

/** Discharge transitions for debts on this file whose detector no longer
 *  appears in the checker's answer — the "same checker, re-run" rule. */
function dischargeTxns(
	input: TransientDebtInput,
	existing: Map<string, Obligation>,
): { txns: ObligationTxn[]; warnings: string[] } {
	const stillFiring = new Set(input.findings.map((f) => f.detector));
	const txns: ObligationTxn[] = [];
	const warnings: string[] = [];
	for (const [detector, debt] of existing) {
		if (stillFiring.has(detector)) continue;
		txns.push({ op: "discharge", id: debt.id, source: "local", atMs: input.atMs });
		warnings.push(
			`[interlinked:transient-debt] ✓ ${input.editedFile} — ${detector || "finding"} reconciled.`,
		);
	}
	return { txns, warnings };
}

/** The debt this write walks away from, and the strike it earns. Only debts on
 *  OTHER files can be wandered from, and the oldest-with-most-strikes one is the
 *  one that decides the verdict. */
function wanderTarget(input: TransientDebtInput): Obligation | null {
	let worst: Obligation | null = null;
	for (const d of input.openDebts) {
		if (isReconcilingEdit(input.editedFile, d, input.relatedFiles)) continue;
		const strikes = d.strikes ?? 0;
		if (worst === null || strikes > (worst.strikes ?? 0)) worst = d;
	}
	return worst;
}

/** Bump every wandered-from debt's strike count — the write is landing (or
 *  being refused) and either way the agent has now spent slack on it. */
function strikeTxns(input: TransientDebtInput): ObligationTxn[] {
	const txns: ObligationTxn[] = [];
	for (const d of input.openDebts) {
		if (isReconcilingEdit(input.editedFile, d, input.relatedFiles)) continue;
		txns.push({
			op: "open",
			kind: "transient",
			file: d.file,
			contentHash: d.contentHash,
			sessionId: d.sessionId,
			atMs: input.atMs,
			// `exactOptionalPropertyTypes`: an absent detector must be ABSENT, not
			// present-and-undefined, or the re-open changes the debt's identity.
			...(d.detector === undefined ? {} : { detector: d.detector }),
			strikes: (d.strikes ?? 0) + 1,
		});
	}
	return txns;
}

function wanderBlock(debt: Obligation, editedFile: string): HarnessDecision {
	const what = debt.detector ? `[${debt.detector}]` : "a deferred finding";
	return {
		decision: "block",
		reason:
			`BLOCKED by transient debt: ${debt.file} still carries ${what}, deferred ` +
			`${(debt.strikes ?? 0) + 1} edits ago because it looked like one half of a coordinated ` +
			`change. This edit to ${editedFile} walks away from it again.\n` +
			`Go back to ${debt.file} and resolve ${what} — use the symbol, drop the import, or land ` +
			"the counterpart that makes it resolve. The next write to that file re-runs the same " +
			"check and clears the debt automatically.\n" +
			"If the finding is deliberate, mark it in place (`// interlinked-ignore: <check> — <why>`); " +
			"if the gate mis-modeled a legitimate change, that is a gate defect worth reporting.",
		warnings: [],
		rule_id: "transient_debt",
		severity: "medium",
		category: "pre-block",
	};
}

/**
 * The whole verdict for one write.
 *
 * Order matters: discharge before strike, so an edit that fixes one debt while
 * wandering from another is credited for the fix; and the wander check reads
 * only PRE-EXISTING debts, so the debt this very write opens can never block
 * the write that opened it.
 */
/** The wander warning for this edit, or null when there is nothing to say.
 *  A STALE debt gets a different message: it is not blocking, and the reader
 *  needs to know that is deliberate rather than a missed check. */
function describeWander(
	wandered: Obligation | null,
	stale: boolean,
	mode: TransientDebtInput["mode"],
): string | null {
	if (!wandered) return null;
	const what = wandered.detector ? `[${wandered.detector}]` : "a deferred finding";
	if (stale) {
		return (
			`[interlinked:transient-debt] ${wandered.file} has carried ${what} for over ` +
			`${Math.round(CROSS_ACTOR_STALE_MS / 60000)} minutes. Not blocking this edit — a debt that old is ` +
			"usually another session's in-flight work, and blocking on it deadlocks every other actor. " +
			"Someone should still fix it."
		);
	}
	return (
		`[interlinked:transient-debt] ${wandered.file} still carries ${what} and this edit moves ` +
		`elsewhere. Slack spent — the next edit away from it ${mode === "block" ? "will be blocked" : "escalates"}.`
	);
}

export function decideTransientDebt(input: TransientDebtInput): TransientDebtOutcome {
	if (input.mode === "off") return { decision: null, warnings: [], txns: [] };

	const existing = debtsForFile(input.openDebts, input.editedFile);
	const discharged = dischargeTxns(input, existing);
	const opened = openTxnsForFindings(input, existing);

	const slack = input.slack ?? DEFAULT_TRANSIENT_SLACK;
	const wandered = wanderTarget(input);
	const overSlack = wandered !== null && (wandered.strikes ?? 0) >= slack;
	const stale = wandered !== null && input.atMs - wandered.openedAtMs > CROSS_ACTOR_STALE_MS;

	if (overSlack && !stale && input.mode === "block") {
		// Refused: the file never changes, so nothing about THIS file's debts
		// moved. Strike anyway — otherwise a refused wander is free and the agent
		// can knock on every other file in the repo at no cost.
		return { decision: wanderBlock(wandered, input.editedFile), warnings: [], txns: strikeTxns(input) };
	}

	const warnings = [...discharged.warnings, ...opened.warnings];
	const wanderWarning = describeWander(wandered, stale, input.mode);
	if (wanderWarning) warnings.push(wanderWarning);
	return {
		decision: null,
		warnings,
		txns: [...discharged.txns, ...opened.txns, ...strikeTxns(input)],
	};
}
