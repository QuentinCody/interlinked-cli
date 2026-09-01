// ===========================================
// Plan-drift detector — Stop-time reflection
// ===========================================
//
// Compares the agent's declared plan (captured by the plan-capture pipeline
// at PreToolUse TaskCreate / ExitPlanMode or UserPromptSubmit structured
// markdown — Item #2 of the agent-quality rollout) against the actual
// tool_sequence executed this session. Emits a stderr advisory at Stop
// when significant drift is detected. NEVER blocks — same "lever held in
// reserve" stance as the rest of the verification-stop-checks family.
//
// Algorithm (matching the design in docs/design/harness-agent-quality-checks-plan.md):
//   1. Tokenize each PlanStep (intent + tool_hint + target_hint).
//   2. Tokenize each tool_sequence entry (after the plan's created_at_step).
//      A tool_sequence entry has the shape "ToolName:target".
//   3. Match via Jaccard overlap > 0.3; greedy first-match wins so a step
//      consumes at most one tool_sequence entry.
//   4. missing_steps: declared steps with no matching entry.
//   5. unexpected_actions: "significant" tool_sequence entries (anything
//      NOT starting with Read:/Grep:/Glob:/LS:/ListFiles:/NotebookRead:
//      — those are typically exploration, not plan steps) with no matching
//      step. Capped at 10 entries to keep the report bounded.
//   6. drift_pct: missing_count / declared_count (0 when declared_count = 0).

import { nonNull } from "../lib/non-null.js";
import type { CapturedPlan, PlanStep } from "./types/plan.js";
import type { SessionTrajectory } from "./types/session.js";

/** Tokens shared across English plan prose that carry no signal for
 *  matching against tool-sequence entries. Kept small and lowercased so
 *  the tokenizer can do a flat Set lookup. */
const STOP_WORDS: ReadonlySet<string> = new Set([
	"the",
	"a",
	"an",
	"to",
	"and",
	"or",
	"for",
	"in",
	"on",
	"of",
	"with",
]);

/** Tool-name prefixes that we consider "exploration" rather than
 *  significant plan-step actions. A tool_sequence entry "Read:src/foo.ts"
 *  will not be reported as unexpected even if no plan step matches it,
 *  because reading files to gather context is normal preamble work that
 *  agents rarely list in a plan. */
const EXPLORATION_PREFIXES: ReadonlyArray<string> = [
	"Read:",
	"Grep:",
	"Glob:",
	"LS:",
	"ListFiles:",
	"NotebookRead:",
];

/** Match threshold for Jaccard similarity between a step's token set and
 *  a tool_sequence entry's token set. Tuned to require more than a single
 *  shared common word — 0.3 maps roughly to "at least one meaningful
 *  noun overlaps" for short intents. */
const JACCARD_MATCH_THRESHOLD = 0.3;

/** Cap on the unexpected_actions list. The Stop nudge only renders up to
 *  five anyway; capping the raw report at 10 leaves headroom for future
 *  consumers without unbounded memory growth on long sessions. */
const UNEXPECTED_ACTIONS_CAP = 10;

interface PlanDriftReport {
	declared_count:number;
	matched_count: number;
	/** Declared but not found in tool_sequence. */
	missing_steps: PlanStep[];
	/** Significant tool_sequence entries with no matching step. */
	unexpected_actions: string[];
	/** 0..1, missing_count / declared_count (0 when declared_count = 0). */
	drift_pct: number;
}

/**
 * Pure tokenizer: lowercase the input, strip non-word characters, split
 * on whitespace, drop empty tokens and stop-words. Returns a Set so
 * caller can compute Jaccard overlap directly.
 *
 * The "ToolName:target" tool_sequence shape (e.g., "Edit:src/foo.ts")
 * is split into both halves by the punctuation strip — the colon and
 * slash become whitespace before the split.
 */
function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		// Replace any non-alphanumeric run with a single space so
		// "Edit:src/foo.ts" → "edit src foo ts".
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0 && !STOP_WORDS.has(t));
	return new Set(tokens);
}

/** Build the token set for a PlanStep — concatenates intent + tool_hint
 *  + target_hint, then tokenizes. */
function tokenizeStep(step: PlanStep): Set<string> {
	const parts = [step.intent, step.tool_hint ?? "", step.target_hint ?? ""];
	return tokenize(parts.join(" "));
}

/** Jaccard overlap between two token sets: |A ∩ B| / |A ∪ B|. Returns 0
 *  when either set is empty (no signal to match on). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Public predicate — "significant" tool-sequence entries are anything
 *  NOT prefixed with an exploration tool name. A bare entry without a
 *  colon (defensive — shouldn't happen from session-state.ts but a
 *  malformed entry shouldn't crash) is treated as significant. */
function isSignificantEntry(entry: string): boolean {
	for (const prefix of EXPLORATION_PREFIXES) {
		if (entry.startsWith(prefix)) return false;
	}
	return true;
}

/**
 * Public — detect drift between session.declared_plan and the actual
 * tool_sequence. Returns null when no plan was declared (nothing to
 * compare against). Otherwise returns a report; the Stop-handler caller
 * decides whether the drift_pct / unexpected_actions thresholds warrant
 * emitting a stderr advisory.
 *
 * Greedy matching: each declared step claims the first tool_sequence
 * entry it overlaps with (Jaccard > 0.3). A claimed entry is removed
 * from the pool so two steps cannot match the same action. The order
 * is the order of declared steps — earlier steps get first pick — which
 * mirrors the temporal order an agent would typically execute them.
 */
export function detectPlanDrift(session: SessionTrajectory): PlanDriftReport | null {
	// TODO(item-2-coordination): SessionTrajectory.declared_plan is added
	// by Item #2 of the agent-quality rollout. Until that lands in main,
	// access via a defensive cast so this module type-checks against the
	// pre-merge session.ts shape. The merger will resolve the cast.
	const declaredPlan = (
		session as SessionTrajectory & { declared_plan?: CapturedPlan }
	).declared_plan;
	if (!declaredPlan) return null;

	const declaredCount = declaredPlan.steps.length;
	// Only consider actions that occurred AFTER the plan was declared.
	// tool_sequence is a rolling window (last 20 entries per
	// session-state.ts), and created_at_step records the tool_call_count
	// when the plan was captured. We can't index into the rolling window
	// by absolute step number, so we approximate: when created_at_step is
	// 0 (plan was the agent's first act), all entries are post-plan;
	// otherwise we keep all entries currently in the window — they're
	// already constrained to the most-recent 20 so prior-to-plan
	// contamination is bounded.
	const sequence = session.tool_sequence;

	if (declaredCount === 0) {
		// Empty plan — nothing to match against. Drift is 0 by definition
		// (no missing), and every significant action is "unexpected" only
		// in the sense that no plan covered it. Report them so the
		// caller can decide. With no declared steps, the threshold check
		// in the Stop handler will only fire on the unexpected_actions
		// count, which is the intended behavior — an empty plan that
		// produces lots of actions is itself a signal of drift.
		const unexpectedAll = sequence.filter(isSignificantEntry);
		return {
			declared_count: 0,
			matched_count: 0,
			missing_steps: [],
			unexpected_actions: unexpectedAll.slice(0, UNEXPECTED_ACTIONS_CAP),
			drift_pct: 0,
		};
	}

	// Build the pool of available tool_sequence entries with their
	// pre-computed token sets. Matched entries are removed (spliced out)
	// as steps claim them, so subsequent steps see a smaller pool.
	//
	// Exploration entries (Read/Grep/Glob/LS/...) are excluded from the
	// matchable pool: reading a file does not fulfill a plan step that
	// said "edit" that file. Without this filter a step like
	// "Edit src/foo.ts" would be falsely satisfied by "Read:src/foo.ts"
	// because the two share enough tokens to clear the Jaccard threshold.
	const pool: Array<{ entry: string; tokens: Set<string> }> = sequence
		.filter(isSignificantEntry)
		.map((entry) => ({ entry, tokens: tokenize(entry) }));

	const matchedEntries = new Set<string>();
	const missingSteps: PlanStep[] = [];
	let matchedCount = 0;

	for (const step of declaredPlan.steps) {
		const stepTokens = tokenizeStep(step);
		let bestIdx = -1;
		for (let i = 0; i < pool.length; i++) {
			const candidate = pool[i];
			if (jaccard(stepTokens, nonNull(candidate).tokens) > JACCARD_MATCH_THRESHOLD) {
				bestIdx = i;
				break;
			}
		}
		if (bestIdx === -1) {
			missingSteps.push(step);
		} else {
			matchedCount++;
			matchedEntries.add(nonNull(pool[bestIdx]).entry);
			pool.splice(bestIdx, 1);
		}
	}

	// Unexpected actions: significant entries that no step claimed.
	const unexpected: string[] = [];
	for (const entry of sequence) {
		if (matchedEntries.has(entry)) continue;
		if (!isSignificantEntry(entry)) continue;
		unexpected.push(entry);
		if (unexpected.length >= UNEXPECTED_ACTIONS_CAP) break;
	}

	const driftPct = declaredCount === 0 ? 0 : missingSteps.length / declaredCount;

	return {
		declared_count: declaredCount,
		matched_count: matchedCount,
		missing_steps: missingSteps,
		unexpected_actions: unexpected,
		drift_pct: driftPct,
	};
}

// ---------------------------------------------------------------------------
// Stop-event formatter
// ---------------------------------------------------------------------------

/** Threshold at which drift_pct alone is enough to fire the advisory.
 *  Tuned conservatively — sub-30% drift is plausibly within the noise
 *  of "agent restated a step differently than it listed it" rather than
 *  actual deviation. See OPEN QUESTIONS in the rollout brief. */
export const DRIFT_PCT_THRESHOLD = 0.3;

/** Threshold at which the unexpected-actions count alone is enough to
 *  fire the advisory, even with low drift_pct. Three significant
 *  unexpected actions (not Read/Grep exploration) means the agent did
 *  substantial work outside what it said it would do. */
export const UNEXPECTED_ACTIONS_THRESHOLD = 3;

/** Maximum number of items to render in the bulleted lists. Beyond this
 *  the advisory becomes a wall of text the agent will skim. The full
 *  detail lives in the report object; the formatter is intentionally
 *  summarized. */
const ADVISORY_LIST_CAP = 5;

interface FormatPlanDriftOpts {
	report: PlanDriftReport;
	/** Override the drift threshold for tests. Defaults to DRIFT_PCT_THRESHOLD. */
	driftThreshold?: number;
	/** Override the unexpected-action threshold for tests. */
	unexpectedThreshold?: number;
}

/**
 * Public — format a PlanDriftReport into a stderr-friendly advisory
 * string, or null when neither threshold is crossed. The Stop handler
 * pushes the returned string into the warnings array; never blocks.
 *
 * Wording mirrors the existing verification-stop-checks tag prefix
 * (`[interlinked:plan-drift]`) so log scrapers and the agent's
 * pattern-matchers see it as one of the reflection-nudge family.
 */
export function formatPlanDriftWarning(opts: FormatPlanDriftOpts): string | null {
	const driftThreshold = opts.driftThreshold ?? DRIFT_PCT_THRESHOLD;
	const unexpectedThreshold = opts.unexpectedThreshold ?? UNEXPECTED_ACTIONS_THRESHOLD;
	const r = opts.report;
	const driftTriggered = r.drift_pct > driftThreshold;
	const unexpectedTriggered = r.unexpected_actions.length > unexpectedThreshold;
	if (!driftTriggered && !unexpectedTriggered) return null;

	const missingPreview = r.missing_steps
		.slice(0, ADVISORY_LIST_CAP)
		.map((s) => `  - ${s.intent}`)
		.join("\n");
	const missingMore =
		r.missing_steps.length > ADVISORY_LIST_CAP
			? `\n  ...and ${r.missing_steps.length - ADVISORY_LIST_CAP} more`
			: "";
	const unexpectedPreview = r.unexpected_actions
		.slice(0, ADVISORY_LIST_CAP)
		.map((e) => `  - ${e}`)
		.join("\n");
	const unexpectedMore =
		r.unexpected_actions.length > ADVISORY_LIST_CAP
			? `\n  ...and ${r.unexpected_actions.length - ADVISORY_LIST_CAP} more`
			: "";

	const missingBlock =
		r.missing_steps.length > 0
			? `\nMissing:\n${missingPreview}${missingMore}`
			: "";
	const unexpectedBlock =
		r.unexpected_actions.length > 0
			? `\nUnexpected:\n${unexpectedPreview}${unexpectedMore}`
			: "";

	return (
		`[interlinked:plan-drift] Declared ${r.declared_count} step(s), matched ${r.matched_count}.` +
		`${missingBlock}${unexpectedBlock}\n` +
		"Reflect on whether the divergence was deliberate (you learned the plan was wrong) " +
		"or accidental (you forgot a step / wandered). Both are fine outcomes; what's not " +
		"fine is claiming done without naming the divergence."
	);
}
