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
 * A newline at top level: `\` line continuations and heredoc header newlines
 * glue to the current segment; every other newline is a split boundary.
 */
function classifyNewline(
	command: string,
	i: number,
	heredocStartsAt: (idx: number) => boolean,
): TopLevelSplitAction {
	if (command[i - 1] === "\\" || heredocStartsAt(i + 1)) {
		return { extraChars: 0, append: "\n", split: false };
	}
	return { extraChars: 0, append: "", split: true };
}

/**
 * A separator operator (`&&`, `||`, `;`, `|`) glues when a heredoc is still
 * pending on this line (its body has not been consumed yet); otherwise it
 * ends the segment.
 */
function glueWhenHeredocPending(
	i: number,
	operator: string,
	extraChars: number,
	pendingHeredocOnLine: (idx: number) => boolean,
): TopLevelSplitAction {
	if (pendingHeredocOnLine(i)) {
		return { extraChars, append: operator, split: false };
	}
	return { extraChars, append: "", split: true };
}

/**
 * A lone `&`: background operator (a split boundary) unless it is part of the
 * `2>&1` / `&>` fd-redirect forms, or a heredoc is still pending on this line.
 */
function classifyBackgroundAmpersand(
	command: string,
	i: number,
	next: string | undefined,
	pendingHeredocOnLine: (idx: number) => boolean,
): TopLevelSplitAction {
	if (command[i - 1] === ">" || next === ">") {
		return { extraChars: 0, append: "&", split: false };
	}
	return glueWhenHeredocPending(i, "&", 0, pendingHeredocOnLine);
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
	if (ch === "\n") return classifyNewline(command, i, heredocStartsAt);
	if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
		return glueWhenHeredocPending(i, ch + next, 1, pendingHeredocOnLine);
	}
	if (ch === ";" || ch === "|") {
		return glueWhenHeredocPending(i, ch, 0, pendingHeredocOnLine);
	}
	if (ch === "&") {
		return classifyBackgroundAmpersand(command, i, next, pendingHeredocOnLine);
	}
	return null;
}
