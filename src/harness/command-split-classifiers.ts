// ===========================================
// Compound Command Split Classifiers
// ===========================================
// Pure per-character decision helpers for `decomposeCommand` in
// `command-decomposition.ts`. Each takes plain values (no loop state, no
// mutation) and returns what a single character means for splitting a
// compound bash command — kept in their own module so the orchestrator loop
// stays a thin dispatch over these decisions.

/**
 * New nesting depth after consuming `ch` at a subshell/backtick-tracking
 * position, or `null` when `ch` doesn't open/close a nesting level (the
 * caller falls back to plain top-level handling). Mirrors bash's `( … )`,
 * `$( … )`, and backtick substitution nesting — backticks toggle rather
 * than counting, since a bare pair is depth 0/1 with no interior nesting
 * support in this tracker.
 */
export function nextBracketDepth(
	ch: string | undefined,
	next: string | undefined,
	depth: number,
): number | null {
	if (ch === "(" || (ch === "$" && next === "(")) return depth + 1;
	if (ch === ")" && depth > 0) return depth - 1;
	if (ch === "`") return depth === 0 ? 1 : 0;
	return null;
}

/** Result of classifying a top-level (depth-0) compound-operator position. */
interface TopLevelSplitAction {
	/** Extra characters beyond `ch` this decision consumes (1 for two-char `&&`/`||`). */
	extraChars: number;
	/** Text to append to the in-progress segment before continuing. */
	append: string;
	/** True when this position ends the in-progress segment (a split boundary). */
	split: boolean;
}

/**
 * Classify what a compound-operator character (`\n`, `&&`, `||`, `;`, `|`,
 * background `&`) does at top-level nesting: glue to the current segment
 * (line continuation, a heredoc header line, or an fd-redirect `&` form) or
 * split the command there. Returns `null` when `ch` isn't one of these
 * operators — the caller falls back to appending it literally.
 */
export function classifyTopLevelSplit(
	command: string,
	i: number,
	ch: string | undefined,
	next: string | undefined,
	heredocStartsAt: (idx: number) => boolean,
	pendingHeredocOnLine: (idx: number) => boolean,
): TopLevelSplitAction | null {
	if (ch === "\n") {
		// `\` line continuations and heredoc header newlines glue.
		if (command[i - 1] === "\\" || heredocStartsAt(i + 1)) {
			return { extraChars: 0, append: ch, split: false };
		}
		return { extraChars: 0, append: "", split: true };
	}
	if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
		if (pendingHeredocOnLine(i)) {
			return { extraChars: 1, append: ch + next, split: false };
		}
		return { extraChars: 1, append: "", split: true };
	}
	if (ch === ";" || ch === "|") {
		if (pendingHeredocOnLine(i)) {
			return { extraChars: 0, append: ch, split: false };
		}
		return { extraChars: 0, append: "", split: true };
	}
	if (ch === "&") {
		// Background `&` — but not the `2>&1` / `&>` redirect forms.
		if (command[i - 1] === ">" || next === ">") {
			return { extraChars: 0, append: ch, split: false };
		}
		if (pendingHeredocOnLine(i)) {
			return { extraChars: 0, append: ch, split: false };
		}
		return { extraChars: 0, append: "", split: true };
	}
	return null;
}
