// Sequence → outcome joining for trajectory rules.
//
// A single tool call is judgeable by any linter. A SEQUENCE is only visible to
// something sitting in the loop, which is why trajectory rules are the part of
// this system a static tool cannot copy. The open question has always been
// whether a given sequence rule is worth showing to an agent. This module
// answers it with evidence instead of taste.
//
// WHERE RULES COME FROM: reasoning about how agent work goes wrong — not from
// mining this repo's logs. One agent on one hardened, single-language codebase
// is a biased sample, and CLAUDE.md is explicit that fire rate measures the
// AGENT, not the check. The data's job here is narrow and negative: show that a
// proposed rule does not misfire on real work before it is allowed to nudge.
//
// THE ASYMMETRY: this report can support PROMOTION and never demotion. A rule
// that never fired here has NO verdict, because silence is not evidence against
// it — it may simply be the part of the standard this agent already clears.
// Point it at a 7B local model or human legacy code and it may earn its keep.
//
// The five labels are failure modes, each computable from state the engine
// already tracks (decisions, tool outcomes, content hashes, verifier results):
//
//   blocked   a later call was refused by a gate — the sequence led somewhere bad
//   errored   a later call failed outright
//   reverted  a file returned to a content hash it already had (thrash: work undone)
//   repair    repeated edits to one file across a red verifier, never reaching green
//   none      the horizon passed with none of the above

/** One tool call, reduced to the fields outcome labeling actually reads. */
export interface OutcomeEvent {
	tool: string;
	/** Gate verdict for this call. */
	decision: "allow" | "block" | "ask";
	/** Whether the call itself succeeded. */
	outcome: "success" | "error" | "interrupted" | "unknown";
	/** File this call touched, when it touched one. */
	file?: string;
	/** Content hash AFTER the call — the thrash signal. */
	sha?: string;
	/** Verifier result, when this call ran one (tests / typecheck / lint / build). */
	verifier?: "green" | "red";
	/** Query text, when this call was a search — the retrieval-cost signal. */
	searchTerm?: string;
}

/** Outcome labels for a window. `none` appears alone when nothing else does. */
type OutcomeLabel = "blocked" | "errored" | "reverted" | "repair" | "none";

/** Record a file's post-call content hash into the per-file history. */
function noteSha(seen: Map<string, Set<string>>, e: OutcomeEvent): void {
	if (!e.file || !e.sha) return;
	const shas = seen.get(e.file);
	if (shas) shas.add(e.sha);
	else seen.set(e.file, new Set([e.sha]));
}

/**
 * Did a file return to a content hash it had EVER held?
 *
 * `prior` seeds the history with state from before the window, because a
 * revert is thrash relative to the whole session — an edit that undoes the
 * very change the rule fired on is the clearest case, and it is invisible if
 * history starts at the window boundary.
 */
function hasRevert(window: readonly OutcomeEvent[], prior: readonly OutcomeEvent[]): boolean {
	const seen = new Map<string, Set<string>>();
	for (const e of prior) noteSha(seen, e);
	for (const e of window) {
		if (!e.file || !e.sha) continue;
		if (seen.get(e.file)?.has(e.sha)) return true;
		noteSha(seen, e);
	}
	return false;
}

/**
 * Repeated edits to ONE file spanning a red verifier that never turns green.
 *
 * The green check is what separates a repair loop from ordinary red→fix→green
 * work: reaching green means the loop closed, which is success, not thrash.
 */
function hasRepairLoop(window: readonly OutcomeEvent[]): boolean {
	const editsAfterRed = new Map<string, number>();
	let sawRed = false;
	for (const e of window) {
		if (e.verifier === "green") return false;
		if (e.verifier === "red") {
			sawRed = true;
			continue;
		}
		if (!sawRed || !e.file) continue;
		const n = (editsAfterRed.get(e.file) ?? 0) + 1;
		if (n >= 2) return true;
		editsAfterRed.set(e.file, n);
	}
	return false;
}

/**
 * Label the window of `horizon` calls FOLLOWING `index` (exclusive of it).
 *
 * Forward-looking on purpose: the question a nudge rule answers is "did this
 * moment predict trouble", so evidence before the firing is irrelevant.
 */
export function labelWindow(
	events: readonly OutcomeEvent[],
	index: number,
	horizon: number,
): OutcomeLabel[] {
	const window = events.slice(index + 1, index + 1 + horizon);
	const labels: OutcomeLabel[] = [];
	if (window.some((e) => e.decision === "block")) labels.push("blocked");
	if (window.some((e) => e.outcome === "error")) labels.push("errored");
	if (hasRevert(window, events.slice(0, index + 1))) labels.push("reverted");
	if (hasRepairLoop(window)) labels.push("repair");
	return labels.length > 0 ? labels : ["none"];
}

/** Where a rule fired within a recorded sequence. */
interface RuleFirings {
	ruleId: string;
	/** Indices into the event array. */
	firedAt: readonly number[];
}

/** What the join concluded — never "demote"; see the module header. */
type PromotionVerdict = "promote" | "hold" | "insufficient" | "no_evidence";

/** Per-rule evidence: how often it fired, and whether trouble followed. */
interface RuleOutcomeStats {
	ruleId: string;
	fires: number;
	hits: number;
	/** hits / fires, or null when the rule never fired. */
	precision: number | null;
	/** Share of ALL windows that end badly — the bar precision must clear. */
	baseRate: number;
	/** precision / baseRate. Above 1 means the rule carries real signal. */
	lift: number | null;
	verdict: PromotionVerdict;
}

/** Thresholds for a promotion verdict. Defaults are deliberately conservative. */
interface JoinOptions {
	/** Firings required before precision is treated as meaningful. */
	minFires?: number;
	/** Lift a rule must clear to be worth an agent's attention. */
	minLift?: number;
}

const DEFAULT_MIN_FIRES = 10;
const DEFAULT_MIN_LIFT = 1.5;

/** Share of all windows in the sequence that end badly. */
function baseRateOf(events: readonly OutcomeEvent[], horizon: number): number {
	if (events.length === 0) return 0;
	let bad = 0;
	for (let i = 0; i < events.length; i++) {
		if (!labelWindow(events, i, horizon).includes("none")) bad += 1;
	}
	return bad / events.length;
}

/** Decide a verdict from the measured numbers. Promotion-only by construction. */
function verdictFor(
	fires: number,
	precision: number | null,
	lift: number | null,
	opts: Required<JoinOptions>,
): PromotionVerdict {
	if (fires === 0 || precision === null) return "no_evidence";
	if (fires < opts.minFires) return "insufficient";
	return lift !== null && lift >= opts.minLift ? "promote" : "hold";
}

/**
 * Join one rule's firings against what happened next.
 *
 * `hold` means "not shown to carry signal HERE" — it is not a demotion, and a
 * rule already shipped keeps its tier regardless of this number.
 */
export function joinRuleOutcomes(
	firings: RuleFirings,
	events: readonly OutcomeEvent[],
	horizon: number,
	options: JoinOptions = {},
): RuleOutcomeStats {
	const opts: Required<JoinOptions> = {
		minFires: options.minFires ?? DEFAULT_MIN_FIRES,
		minLift: options.minLift ?? DEFAULT_MIN_LIFT,
	};
	const fires = firings.firedAt.length;
	let hits = 0;
	for (const i of firings.firedAt) {
		if (!labelWindow(events, i, horizon).includes("none")) hits += 1;
	}
	const precision = fires > 0 ? hits / fires : null;
	const baseRate = baseRateOf(events, horizon);
	const lift = precision !== null && baseRate > 0 ? precision / baseRate : null;
	return {
		ruleId: firings.ruleId,
		fires,
		hits,
		precision,
		baseRate,
		lift,
		verdict: verdictFor(fires, precision, lift, opts),
	};
}
