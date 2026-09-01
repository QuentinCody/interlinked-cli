// ===========================================
// Coverage debt — the pair-scoped TDD decision (Phase 2 logic)
// ===========================================
// Encodes the rule: an agent's FIRST edit that leaves source uncovered — or
// leaves the suite RED (the red→green loop's legitimate intermediate) — is
// never blocked: it opens a debt (kind `coverage` / `red_suite`) and is
// allowed. While a debt is open the agent may freely keep editing the same
// source (or its companion test); the ONLY thing blocked is an edit that
// wanders to an unrelated file before the debt is covered / green again.
// "Block, but not too soon, and never for staying in the pair."
//
// This module is PURE: it takes the base coverage-gate verdict plus the current
// ledger state and a map of re-checked files, and returns the final decision +
// the obligation transitions to append. The fs ledger and the runner-backed
// re-check live in the call-site glue; this is the part that holds the rule and
// is exhaustively unit-tested (including the canonical edit pairs).

import { attachWarning, foreignDebtNote } from "./coverage-debt-foreign.js";
import {
	expectedCompanionTest,
	expectedSourceOfTest,
	inSamePair,
	pairStem,
	TEST_INFIX_RX,
} from "./coverage-pairing.js";
import { type Obligation, type ObligationTxn, obligationId } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

// Pairing primitives moved to coverage-pairing.ts (2026-07-17 line-cap
// decomposition) — re-exported so existing consumers keep this import path.
export { expectedCompanionTest, expectedSourceOfTest, inSamePair, pairStem };

/** The exact phrase the per-edit gate's uncovered-added-line producers
 *  (`blockForUncovered` / `blockForUncoveredLine` in
 *  `evaluator/coverage-write-decision.ts`) interpolate into their reasons, and
 *  that {@link isUncoveredBlock} matches on. Shared so the producer↔matcher
 *  coupling is structural — two drifting string literals cannot silently stop
 *  debt-mode from recognizing the verdict. */
export const UNCOVERED_MARKER = "uncovered by the test suite";

/** The exact phrase the red-bar producers (`blockForRedBar` in
 *  `evaluator/coverage-write-decision.ts`, `blockForDeletionRedBar` in
 *  `evaluator/coverage-write-guard-redbar.ts`) interpolate, and that
 *  {@link isRedBarBlock} matches on. `blockForCrossSuiteRedBar` deliberately
 *  does NOT carry this marker — cross-ecosystem breakage is not the pair's
 *  red→green loop, so it stays a hard block instead of folding into debt. */
export const RED_BAR_MARKER = "leaves the test suite RED";

/** True for the per-edit gate's "this added line is uncovered" block — the
 *  first verdict debt-mode downgrades. Coverage-drop / floor / CRAP blocks
 *  carry different reasons and pass through untouched. */
export function isUncoveredBlock(decision: HarnessDecision | null): boolean {
	return (
		decision !== null &&
		decision.decision === "block" &&
		typeof decision.reason === "string" &&
		decision.reason.includes(UNCOVERED_MARKER)
	);
}

/** True for the per-edit gate's red-bar block ("leaves the test suite RED") —
 *  the second verdict debt-mode downgrades, into a `red_suite` debt: the
 *  red→green loop in progress. Landing a failing test first, or a behavior
 *  redesign whose source+tests must change across edits, is PROGRESS — what's
 *  forbidden is wandering off while the pair is red (and the commit gate is
 *  the ground-truth backstop). This is what retires the old "write code + test
 *  together in one `interlinked write --batch`" workaround. */
export function isRedBarBlock(decision: HarnessDecision | null): boolean {
	return (
		decision !== null &&
		decision.decision === "block" &&
		typeof decision.reason === "string" &&
		decision.reason.includes(RED_BAR_MARKER)
	);
}

export interface CoverageDebtInput {
	/** What `checkCoverageWrite` returned for the edited file. */
	baseDecision: HarnessDecision | null;
	/** Repo-relative path of the file this edit touches. */
	editedFile: string;
	/** Currently-open coverage debts (from the ledger). */
	openDebts: Obligation[];
	/** Files the caller re-ran coverage on this edit → covered? (true = covered). */
	rechecks: ReadonlyMap<string, boolean>;
	/** Max concurrently-open debts before an out-of-pair edit blocks. Omitted ⇒ 1
	 *  (strict pair rule); >1 relaxes toward the commit backstop. */
	wipLimit?: number;
	sessionId: string;
	atMs: number;
	/**
	 * Test files the CURRENT edit can influence (repo-relative POSIX), from
	 * affected-test selection over the daemon's dependency graph (the same
	 * `selectAffectedTests` walk the gate scopes suite runs with). Feeds
	 * {@link relatedToDebt}: an edit that can move one of a red debt's recorded
	 * failing tests is part of that red episode, not a wander — the atomic
	 * cross-module change (edit A broke a test that also reads B ⇒ B is
	 * editable while red). `undefined`/`null` = unknown (no view, file not in
	 * graph, truncated walk) — relatedness then falls back to the filename
	 * pair + failing-test identity, the strict legacy shape.
	 */
	affectedTests?: ReadonlySet<string> | null | undefined;
	/**
	 * Existence probe for message accuracy (this module is pure — no fs).
	 * When provided, a RED debt's block message only names the conventional
	 * companion test if it actually exists; a phantom `foo.test.ts` told an
	 * agent to green a file that wasn't there (mcp-client-bio, 2026-07).
	 * Coverage-debt messages still name the companion unconditionally — there
	 * it is CREATE guidance ("write its test"), not a claim of existence.
	 */
	fileExists?: (relPath: string) => boolean;
	/** Debt files sitting DIRECTLY next to the edited file in the import graph.
	 *  Supplies coverage debts with the graph-aware relatedness that red_suite
	 *  debts already get via recorded failing tests. `null`/absent = unknown,
	 *  which must never widen. */
	adjacentDebtFiles?: ReadonlySet<string> | null;
	/**
	 * Foreign-debt note dedup probe (ownership scoping, 2026-07-17): called at
	 * most once per decision, with the foreign debt about to be surfaced.
	 * Return false to suppress (e.g. already noted this session). Omitted ⇒
	 * always note. An input so this module stays pure — the gate glue owns the
	 * per-session dedup state.
	 */
	shouldNoteForeignDebt?: (d: Obligation) => boolean;
}

interface CoverageDebtOutcome {
	/** The final verdict (null = allow). */
	decision: HarnessDecision | null;
	/** Ledger transitions the caller must append. */
	txns: ObligationTxn[];
}

/**
 * True when `editedFile` belongs to debt `d`'s work — the debt-mode
 * relatedness relation, in widening order:
 *   1. the filename pair (`inSamePair`) — the legacy convention, always on;
 *   2. `editedFile` IS one of the debt's recorded failing test files (fixing
 *      the failing test itself, wherever it lives — including the
 *      non-colocated integration test the pair rule can't see);
 *   3. the caller's affected-test selection for `editedFile` intersects the
 *      recorded failing tests — the edit can influence a failing test through
 *      the import graph, so it is part of driving the suite green.
 * Only `red_suite` debts carry failing-test evidence, so for coverage debts
 * this reduces to the pair rule. Evidence can only WIDEN relatedness (never
 * block more), and the commit gate remains the ground-truth backstop.
 */
export function relatedToDebt(
	editedFile: string,
	d: Obligation,
	affectedTests?: ReadonlySet<string> | null,
	adjacentDebtFiles?: ReadonlySet<string> | null,
): boolean {
	if (inSamePair(editedFile, d.file)) return true;
	// Import-graph adjacency: the edited file imports the debted file or is
	// imported by it. A coordinated change across that edge cannot green either
	// side alone, so treating it as a wander blocks correct work.
	if (adjacentDebtFiles?.has(d.file)) return true;
	const failing = d.failingTestFiles;
	if (!failing || failing.length === 0) return false;
	if (failing.includes(editedFile)) return true;
	return affectedTests != null && failing.some((t) => affectedTests.has(t));
}

/** The "other side of the pair" clause for a debt message. Role-correct when
 *  the debted file is itself a TEST (the red→green loop's canonical opener:
 *  land the failing test first) — it names the test's SOURCE instead of
 *  deriving the nonsense `foo.test.test.ts` via {@link expectedCompanionTest}. */
function pairOtherSide(d: Obligation): string {
	if (TEST_INFIX_RX.test(d.file)) {
		const src = expectedSourceOfTest(d.file);
		return d.kind === "coverage" ? `cover its source (${src})` : `its source (${src})`;
	}
	const test = expectedCompanionTest(d.file);
	return d.kind === "coverage" ? `write its test (${test}) and cover it` : `its test (${test})`;
}

/** Up to three failing-test files, `…`-elided beyond that. */
function failingFilesPhrase(files: readonly string[]): string {
	const shown = files.slice(0, 3).join(", ");
	return files.length > 3 ? `${shown}, …` : shown;
}

/** The narrow, recorded escape named in every wander block — the answer to
 *  "the gate mis-models my legitimate change and there is no discoverable
 *  bypass" (mcp-client-bio, 2026-07). Config, not env: auditable, scoped.
 *  Deliberately names ONLY the numeric, scoped lever (2026-07-17): the
 *  whole-mode `debt_mode: false` flip stays documented for repo owners in
 *  types/config.ts, but an in-band block message offering the gated party a
 *  global off-switch invites maximal loosening — baseline-integrity doctrine
 *  says hand it the narrowest lever instead. */
const WANDER_ESCAPE =
	" If this edit IS part of that work and the import graph can't see it, raise" +
	" per_edit_coverage.debt_wip_limit in .interlinked/guard-rules.local.json —" +
	" scoped, recorded, auditable.";

/** The RED-debt "keep editing …" clause. Prefers the debt's recorded
 *  failing-test evidence — real paths that ran and failed — over filename
 *  convention; the conventional companion is only NAMED when it exists (probe
 *  supplied), because a phantom `genomics.test.ts` sends the agent to green a
 *  file that isn't there. No probe (pure/legacy callers) ⇒ legacy naming. */
function redWanderGuidance(d: Obligation, fileExists?: (relPath: string) => boolean): string {
	const failing = d.failingTestFiles ?? [];
	if (failing.length > 0) {
		return (
			`the failing test(s): ${failingFilesPhrase(failing)}. Drive the suite green first — ` +
			`edit ${d.file}, a failing test file, or any file those tests exercise ` +
			`(per the import graph) — then continue.`
		);
	}
	if (TEST_INFIX_RX.test(d.file)) {
		return `Drive that pair green first — keep editing ${d.file} or its source (${expectedSourceOfTest(d.file)}) — then continue.`;
	}
	const test = expectedCompanionTest(d.file);
	const other =
		!fileExists || fileExists(test)
			? `its test (${test})`
			: `the failing test file(s) named in the suite output (no ${test} exists)`;
	return `Drive that pair green first — keep editing ${d.file} or ${other} — then continue.`;
}

function blockForWander(d: Obligation, fileExists?: (relPath: string) => boolean): HarnessDecision {
	const reason =
		d.kind === "red_suite"
			? `[interlinked:coverage] BLOCKED: the test suite is RED from your edits to ${d.file}, ` +
				`and this edit moves to an unrelated file — ${redWanderGuidance(d, fileExists)}${WANDER_ESCAPE}`
			: `[interlinked:coverage] BLOCKED: you added code to ${d.file} that no test covers yet, ` +
				`and this edit moves to an unrelated file. Keep editing ${d.file} or ` +
				`${pairOtherSide(d)} — then continue.${WANDER_ESCAPE}`;
	return {
		decision: "block",
		reason,
		rule_id: "per-edit-coverage-debt",
		severity: "medium",
		category: "coverage",
	};
}

function allowWithDebt(file: string): HarnessDecision {
	const next = TEST_INFIX_RX.test(file)
		? `cover its source (${expectedSourceOfTest(file)}) next`
		: "write its test next";
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Opened coverage debt for ${file} — the code you added isn't ` +
				`covered yet. Keep editing ${file} or ${next}; just don't move to an ` +
				`unrelated file until it's covered.`,
		],
	};
}

function allowWithRedDebt(file: string, failing: readonly string[] = []): HarnessDecision {
	const scope =
		failing.length > 0
			? `keep editing ${file}, the failing test file(s) (${failingFilesPhrase(failing)}), ` +
				"or any file those tests exercise"
			: TEST_INFIX_RX.test(file)
				? `keep editing ${file} or its source (${expectedSourceOfTest(file)}) freely`
				: `keep editing ${file} or its test freely`;
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Suite is RED after this edit — red debt opened for ${file}. ` +
				`You're in the red→green loop: ${scope}; just don't ` +
				`move to an unrelated file until the suite runs green again.`,
		],
	};
}

/** Shared argument shape for the red-bar fold and its red-verdict half. */
interface RedFoldArgs {
	baseDecision: HarnessDecision | null;
	editedFile: string;
	stillOpen: Obligation[];
	txns: ObligationTxn[];
	sessionId: string;
	atMs: number;
	affectedTests?: ReadonlySet<string> | null | undefined;
}

/**
 * The red-bar fold — the twin of the uncovered fold below. A red verdict opens
 * (or continues) the episode's `red_suite` debt and ALLOWS: landing a failing
 * test first, or a behavior change whose source + tests must move across
 * edits, is the red→green loop, not a violation. Relatedness is
 * {@link relatedToDebt} throughout — pair OR failure-evidence cone — so the
 * atomic cross-module fix continues the SAME episode instead of stacking a
 * second debt, and a landing non-red verdict on ANY related edit discharges
 * it. The discharge stays deliberately optimistic, like the coverage
 * discharge: it includes verdicts produced WITHOUT a suite run (an ungated
 * pure-test edit, a budget defer, a loud degrade), and the commit gate is the
 * ground-truth backstop. A pass-through BLOCK (drop / floor / CRAP) refuses
 * the edit, so it discharges nothing. Returns an outcome to short-circuit
 * with, or null to continue folding.
 */
function foldRedBar(args: RedFoldArgs): CoverageDebtOutcome | null {
	const { baseDecision, editedFile, stillOpen, txns, atMs, affectedTests } = args;
	if (isRedBarBlock(baseDecision)) {
		return foldRedVerdict(args);
	}
	// A pass-through BLOCK (coverage-drop / floor / CRAP) REFUSES the edit —
	// nothing lands on disk, so its non-red overlay run is no evidence the
	// pair went green: related red debts must survive. The uncovered block
	// is exempt because it downgrades to allow + coverage debt below (that
	// edit DOES land, and its overlay ran non-red).
	if (baseDecision?.decision === "block" && !isUncoveredBlock(baseDecision)) return null;
	for (const d of stillOpen) {
		if (d.kind === "red_suite" && relatedToDebt(editedFile, d, affectedTests)) {
			txns.push({ op: "discharge", id: d.id, source: "local", atMs });
		}
	}
	return null;
}

/** The red-verdict half of the fold: a RELATED red verdict continues the open
 *  episode (refreshing its evidence when the failing set moved); an unrelated
 *  one opens a fresh red debt carrying the run's failing files as evidence. */
function foldRedVerdict(args: RedFoldArgs): CoverageDebtOutcome {
	const { baseDecision, editedFile, stillOpen, txns, sessionId, atMs, affectedTests } = args;
	const evidence = baseDecision?.failing_test_files ?? [];
	const related = stillOpen.filter(
		(d) => d.kind === "red_suite" && relatedToDebt(editedFile, d, affectedTests),
	);
	if (related.length === 0) {
		txns.push({
			op: "open",
			kind: "red_suite",
			file: editedFile,
			contentHash: "",
			sessionId,
			atMs,
			...(evidence.length > 0 ? { failingTestFiles: evidence } : {}),
		});
	} else {
		refreshRedEvidence(related, evidence, txns, sessionId, atMs);
	}
	const shown = evidence.length > 0 ? evidence : (related[0]?.failingTestFiles ?? []);
	return { decision: allowWithRedDebt(editedFile, shown), txns };
}

/** A red verdict on a related edit CONTINUES the episode. When the new run's
 *  failing set differs from a related debt's recorded evidence, re-open that
 *  debt with the new set — the `applyObligationTxn` open path keeps the
 *  openedAtMs/editSeq staleness anchors and replaces the evidence, so the
 *  ledger always reflects the LATEST red run (fixed one test, broke another).
 *  An empty parse keeps the recorded set: no evidence is not new evidence. */
function refreshRedEvidence(
	related: Obligation[],
	evidence: string[],
	txns: ObligationTxn[],
	sessionId: string,
	atMs: number,
): void {
	if (evidence.length === 0) return;
	for (const d of related) {
		if (sameStringSet(d.failingTestFiles ?? [], evidence)) continue;
		txns.push({
			op: "open",
			kind: "red_suite",
			file: d.file,
			contentHash: d.contentHash,
			sessionId,
			atMs,
			failingTestFiles: evidence,
		});
	}
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((entry) => set.has(entry));
}

/** Step-2 verdict shape: a blocked wander (own debt at the WIP limit), a
 *  foreign-debt heads-up note, or neither. At most one field is set. */
interface WanderOutcome {
	block: HarnessDecision | null;
	note: string | null;
}

/**
 * The ownership-scoped wander rule (2026-07-17). Focus is a property of ONE
 * session's trajectory, so only debts THIS session opened may block its
 * wander — a session cannot "return to" work it never did, and blocking it
 * walls an innocent agent into doing someone else's WIP, editing enforcement
 * config, or evading through a harness-invisible channel (all three observed
 * live). Editing inside ANY open debt's work stays free regardless of owner.
 * A foreign debt that would have blocked surfaces as a heads-up note instead
 * (dedup'd by the caller via `shouldNoteForeignDebt`); an unattributable
 * owner is foreign — never block on a guess. The commit gate stays the
 * cross-session ground truth.
 */
function resolveWander(input: CoverageDebtInput, stillOpen: Obligation[]): WanderOutcome {
	const { editedFile, affectedTests, sessionId, wipLimit = 1, atMs, fileExists } = input;
	const related = stillOpen.some((d) =>
		relatedToDebt(editedFile, d, affectedTests, input.adjacentDebtFiles),
	);
	if (related || stillOpen.length < wipLimit) return { block: null, note: null };
	const own = stillOpen.filter((d) => d.sessionId === sessionId);
	const oldestOwn = own[0];
	if (oldestOwn && own.length >= wipLimit) {
		return { block: blockForWander(oldestOwn, fileExists), note: null };
	}
	const foreign = stillOpen.find((d) => d.sessionId !== sessionId);
	if (!foreign || !(input.shouldNoteForeignDebt?.(foreign) ?? true)) {
		return { block: null, note: null };
	}
	return { block: null, note: foreignDebtNote(foreign, atMs) };
}

/**
 * Apply the pair-scoped debt rule. Order: discharge anything the caller proved
 * covered, then enforce the pair boundary (own wander → block; foreign →
 * note), then fold the base gate verdict (red → open red debt + allow;
 * uncovered → open coverage debt + allow; covered-with-open-debt → discharge;
 * everything else → pass through), attaching any foreign note to the outcome.
 */
export function decideCoverageDebt(input: CoverageDebtInput): CoverageDebtOutcome {
	const { baseDecision, editedFile, openDebts, rechecks, sessionId, atMs } = input;
	const { affectedTests } = input;
	const txns: ObligationTxn[] = [];

	// 1. Discharge any COVERAGE debt the caller re-checked and found covered.
	//    (Scoped by kind: a companion-test edit is optimistic proof of coverage,
	//    but proves nothing about the suite being green — red debts discharge
	//    only from a non-red verdict, in foldRedBar.) Keyed by DEBT ID, not
	//    file: a coverage debt and a red debt can be open on the SAME file, and
	//    a file-keyed filter would hide the red debt from `stillOpen` here so
	//    foldRedBar could not discharge it in the same call.
	const discharged = new Set<string>();
	for (const d of openDebts) {
		if (d.kind === "coverage" && rechecks.get(d.file) === true) {
			txns.push({ op: "discharge", id: d.id, source: "local", atMs });
			discharged.add(d.id);
		}
	}
	const stillOpen = openDebts.filter((d) => !discharged.has(d.id));

	// 2. Ownership-scoped wander rule — see {@link resolveWander}: only THIS
	//    session's debts block; a foreign debt becomes a heads-up note attached
	//    to whatever step 3 decides.
	const wander = resolveWander(input, stillOpen);
	if (wander.block) return { decision: wander.block, txns };
	const finish = (o: CoverageDebtOutcome): CoverageDebtOutcome =>
		wander.note === null ? o : { decision: attachWarning(o.decision, wander.note), txns: o.txns };

	// 3. In-pair (or nothing open / foreign-only): fold the base gate verdict —
	//    red first (its discharge must run even when the verdict falls through
	//    to uncovered).
	const red = foldRedBar({ baseDecision, editedFile, stillOpen, txns, sessionId, atMs, affectedTests });
	if (red) return finish(red);

	if (isUncoveredBlock(baseDecision)) {
		// First (or continued) uncovered edit → open debt and ALLOW. Not blocked.
		txns.push({ op: "open", kind: "coverage", file: editedFile, contentHash: "", sessionId, atMs });
		return finish({ decision: allowWithDebt(editedFile), txns });
	}
	if (baseDecision === null && stillOpen.some((d) => d.kind === "coverage" && d.file === editedFile)) {
		// Edited the debted source and it now reads as covered → discharge.
		txns.push({ op: "discharge", id: obligationId("coverage", editedFile), source: "local", atMs });
		return finish({ decision: null, txns });
	}
	// Drop / floor / CRAP / clean-allow pass through untouched.
	return finish({ decision: baseDecision, txns });
}
