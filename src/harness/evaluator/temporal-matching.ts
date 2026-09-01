// ===========================================
// Temporal-Precondition Predicate Evaluator
// ===========================================
//
// Pure-function evaluators for the `requires_prior` / `forbids_after`
// axes on a `GuardRule`. Both predicates read against
// `SessionTrajectory` — `tool_sequence`, `commands_run`, `files_read`,
// `verification_observed` — and never mutate or perform I/O.
//
// Semantics:
//   - `requires_prior`: the rule should fire when the predicate is NOT
//     satisfied (the required precondition is missing).
//   - `forbids_after`:  the rule should fire when the predicate IS
//     satisfied (the forbidden earlier action is present).
//
// Callers wire these into the rule-matching pipeline AFTER content
// patterns match, so the rule still has to "hit" the tool call first.
// A predicate with multiple fields set is AND-combined — every populated
// field must hold.
//
// See docs/design/harness-active-when-scoping.md for the sibling axes
// (`active_when`); this module is the trajectory-only cousin.

import type { SessionTrajectory, TemporalPredicate } from "../types.js";

/** Result of evaluating a temporal predicate. `reason` is populated only
 *  on the unsatisfied path so callers can surface "missed precondition"
 *  details without re-deriving them. */
interface TemporalEvaluation {
	satisfied: boolean;
	reason?: string;
}

/** Shared regex cache for `bash_match` patterns. Predicates come from
 *  admin-authored built-in rules; user-supplied / distilled rules go
 *  through the ReDoS gate at load time (see `rules/distilled-rules.ts`). */
const _temporalRegexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string): RegExp {
	let re = _temporalRegexCache.get(pattern);
	if (!re) {
		// Reason: pattern comes from trusted rule config, not user/agent
		// input. Validated at load time for user-supplied rules.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		re = new RegExp(pattern, "i");
		_temporalRegexCache.set(pattern, re);
	}
	re.lastIndex = 0;
	return re;
}

/** Tail-slice an array by `within_last_n`. Non-positive / undefined =
 *  full array. Bounded to the actual length so callers don't need to
 *  defend against off-by-one when the array is shorter than the window. */
function tail<T>(arr: readonly T[], within_last_n: number | undefined): readonly T[] {
	if (!within_last_n || within_last_n <= 0) return arr;
	if (within_last_n >= arr.length) return arr;
	return arr.slice(-within_last_n);
}

/** "*" matches any tool. Otherwise: case-sensitive prefix on the
 *  ToolName portion of a `"ToolName:target"` tool_sequence entry. We
 *  split on the first `:` because the target (file path / command) may
 *  legitimately contain `:` (e.g., `Bash:git log --oneline`). */
function toolSequenceMatches(entry: string, wanted: string): boolean {
	if (wanted === "*") return true;
	const colon = entry.indexOf(":");
	const toolPart = colon >= 0 ? entry.slice(0, colon) : entry;
	return toolPart === wanted;
}

/** Pure check: does the predicate's `tool` field have a match in the
 *  windowed `tool_sequence`? `undefined` => no requirement (returns
 *  true so AND-combination doesn't accidentally short-circuit). */
function toolFieldSatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): boolean {
	if (pred.tool === undefined) return true;
	const window = tail(session.tool_sequence, pred.within_last_n);
	for (const entry of window) {
		if (toolSequenceMatches(entry, pred.tool)) return true;
	}
	return false;
}

/** Pure check: does any windowed `commands_run` entry match the regex?
 *  `undefined` => no requirement. */
function bashFieldSatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): boolean {
	if (pred.bash_match === undefined) return true;
	const window = tail(session.commands_run, pred.within_last_n);
	if (window.length === 0) return false;
	const re = getCachedRegex(pred.bash_match);
	for (const cmd of window) {
		if (re.test(cmd)) return true;
	}
	return false;
}

/** Pure check: does `session.files_read` contain a match for the
 *  predicate's `file_read` field? Plain (no `*`) strings test
 *  set membership; glob-flavored strings compile to a regex.
 *
 *  Glob vocabulary:
 *    `*`  — matches any sequence of non-slash characters (one path segment).
 *    `**` — matches any sequence including slashes (cross-segment).
 *  All other regex metacharacters are escaped. */
function fileReadFieldSatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): boolean {
	if (pred.file_read === undefined) return true;
	const wanted = pred.file_read;
	if (!wanted.includes("*")) {
		return session.files_read.has(wanted);
	}
	const re = globToRegex(wanted);
	for (const f of session.files_read) {
		if (re.test(f)) return true;
	}
	return false;
}

/** Glob → RegExp. Single-pass translation: escape every regex
 *  metacharacter EXCEPT `*` first, then a single alternating regex
 *  consumes the `*` tokens in one walk. `**` (matched greedily before
 *  the single-`*` arm of the alternation) becomes `.*` (cross-segment),
 *  while a lone `*` becomes `[^/]*` (one path segment). */
function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const body = escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
	const pattern = `^${body}$`;
	// Reason: glob comes from trusted built-in rule definitions, not user input.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(pattern);
}

/** Pure check: is the predicate's `verification_kind` in
 *  `session.verification_observed`? */
function verificationFieldSatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): boolean {
	if (pred.verification_kind === undefined) return true;
	const observed = session.verification_observed;
	if (!observed || observed.size === 0) return false;
	return observed.has(pred.verification_kind);
}

/** Pure AND-combination of every populated predicate field. A predicate
 *  with no fields populated is vacuously satisfied (returns true) — that
 *  matches the existing convention in `evaluateActiveWhen`. */
function predicateSatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): boolean {
	if (!toolFieldSatisfied(pred, session)) return false;
	if (!bashFieldSatisfied(pred, session)) return false;
	if (!fileReadFieldSatisfied(pred, session)) return false;
	if (!verificationFieldSatisfied(pred, session)) return false;
	return true;
}

/** Human-readable explanation of which predicate fields could not be
 *  satisfied. Used by the rule-matching layer to surface the gap in
 *  the agent-facing reason. */
function describeUnsatisfied(
	pred: TemporalPredicate,
	session: SessionTrajectory,
): string {
	const missing: string[] = [];
	if (pred.tool !== undefined && !toolFieldSatisfied(pred, session)) {
		missing.push(`no prior \`${pred.tool}\` tool call`);
	}
	if (pred.bash_match !== undefined && !bashFieldSatisfied(pred, session)) {
		missing.push(`no prior command matching /${pred.bash_match}/`);
	}
	if (pred.file_read !== undefined && !fileReadFieldSatisfied(pred, session)) {
		missing.push(`no prior file read matching ${pred.file_read}`);
	}
	if (
		pred.verification_kind !== undefined &&
		!verificationFieldSatisfied(pred, session)
	) {
		missing.push(`no prior ${pred.verification_kind} verification`);
	}
	if (missing.length === 0) return "predicate not satisfied";
	if (pred.within_last_n && pred.within_last_n > 0) {
		return `${missing.join("; ")} (within last ${pred.within_last_n} actions)`;
	}
	return missing.join("; ");
}

/** Public API — evaluate a `requires_prior` predicate against the session.
 *  `satisfied` is `true` when the precondition holds (i.e. the rule
 *  should NOT fire). When `false`, `reason` carries a one-line summary
 *  of which fields couldn't be met. */
export function evaluateRequiresPrior(
	session: SessionTrajectory,
	pred: TemporalPredicate,
): TemporalEvaluation {
	const ok = predicateSatisfied(pred, session);
	if (ok) return { satisfied: true };
	return { satisfied: false, reason: describeUnsatisfied(pred, session) };
}

/** Public API — evaluate a `forbids_after` predicate against the session.
 *  `satisfied` is `true` when the forbidden state is present (i.e. the
 *  rule SHOULD fire). When `false`, the `reason` is omitted because
 *  there is nothing actionable to surface — the forbidden state is
 *  absent and the rule stays dormant. */
export function evaluateForbidsAfter(
	session: SessionTrajectory,
	pred: TemporalPredicate,
): TemporalEvaluation {
	const triggered = predicateSatisfied(pred, session);
	return { satisfied: triggered };
}
