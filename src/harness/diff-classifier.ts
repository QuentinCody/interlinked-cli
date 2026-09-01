// ===========================================
// Diff classifier — Phase B.4 of the Free-CLI roadmap
// ===========================================
//
// Classifies a diff (old → new text) into one of three buckets so the
// post-event check pipeline can skip semantic analysis on edits that only
// touched non-executed content (whitespace, comments, quoted strings,
// heredoc bodies). Pairs with `evaluator/spans.ts`'s `extractScannableText`,
// which masks quoted/comment/heredoc regions with same-length whitespace.
//
// Strategy:
//   1. Strip masked regions from both sides via `extractScannableText`.
//   2. If the *whitespace-collapsed* executed text is identical on both
//      sides, the diff did not touch any executed span → non-semantic.
//   3. Distinguish whitespace_only vs comment_only by re-comparing the
//      full (un-collapsed) raw text:
//        • Identical raw → whitespace_only (only whitespace runs differ).
//        • Different raw  → comment_only (the change landed in a masked
//                                          region, i.e. comment / string /
//                                          heredoc body).
//
// Limitations (v1):
//   • spans.ts is shell-oriented. It understands `'`, `"`, `#`, `<<TAG`,
//     and `$'…'` quoting. For #-comment languages (Python, Ruby, Bash,
//     YAML, TOML, Make, …) and quoted-string-only diffs in any language,
//     this works correctly. For `//`-comment and `/* … */`-comment
//     languages (TS/JS/Go/Java/C/C++/Rust/CSS), comment-only diffs may
//     classify as `semantic` because spans.ts does not strip them.
//   • Phase 3 of the Free-CLI roadmap introduces language-aware
//     classifiers; this v1 is the cheap shared baseline.
//
// Phase B.4 rationale: skipping a semantic check on a comment-only edit
// trims a 200-500 ms tsc/biome/etc. round trip on every doc tweak, while
// security-critical (severity=error) detectors still run so a credential
// leaked into a string literal is still caught.

import { extractScannableText } from "./evaluator/spans.js";

type DiffClass = "whitespace_only" | "comment_only" | "semantic";

interface ClassifiedDiff {
	diff_class: DiffClass;
	/** Executed-character count in the old text (excludes masked regions). */
	old_executed_chars: number;
	/** Executed-character count in the new text (excludes masked regions). */
	new_executed_chars: number;
}

/**
 * Classify a diff into whitespace_only, comment_only, or semantic.
 *
 * Insertion/deletion (one side empty, the other non-empty) is always
 * `semantic` — adding code or removing code by definition changes
 * executed content, even if the new content is "just" a comment.
 */
export function classifyDiff(oldText: string, newText: string): ClassifiedDiff {
	const oldExecuted = extractScannableText(oldText);
	const newExecuted = extractScannableText(newText);
	const oldExecutedTrimmed = countNonWhitespace(oldExecuted);
	const newExecutedTrimmed = countNonWhitespace(newExecuted);

	// Identity: both empty (or both whitespace-only). No content to fire on.
	if (oldText === newText) {
		return {
			diff_class: "whitespace_only",
			old_executed_chars: oldExecutedTrimmed,
			new_executed_chars: newExecutedTrimmed,
		};
	}

	// Insertion / deletion: one side empty. Always semantic — the inserted
	// or removed bytes COULD include executed code, even if structurally
	// they look comment-shaped after masking. A new `# foo` line is still a
	// new line of code as far as side-effects (file size, line count,
	// reflowed surrounding lines) are concerned.
	if (oldText.length === 0 || newText.length === 0) {
		return {
			diff_class: "semantic",
			old_executed_chars: oldExecutedTrimmed,
			new_executed_chars: newExecutedTrimmed,
		};
	}

	// Compare the executed text after collapsing every whitespace run to a
	// single sentinel. Equal → no executed-span change → non-semantic.
	const oldCollapsed = collapseWhitespace(oldExecuted);
	const newCollapsed = collapseWhitespace(newExecuted);
	if (oldCollapsed === newCollapsed) {
		// The change happened in a masked region OR in pure whitespace.
		// Distinguish: if the raw inputs are identical, every difference
		// must be a no-op (impossible since `oldText !== newText`); since
		// they differ, at least one difference must lie in either a
		// masked region (comment_only) or whitespace runs (whitespace_only).
		// We use the raw executed-text equality (without collapsing) as
		// the discriminator: if pre-collapse executed text already matches,
		// no whitespace runs changed inside executed code, so the diff
		// must live entirely in masked regions → comment_only.
		if (oldExecuted === newExecuted) {
			return {
				diff_class: "comment_only",
				old_executed_chars: oldExecutedTrimmed,
				new_executed_chars: newExecutedTrimmed,
			};
		}
		return {
			diff_class: "whitespace_only",
			old_executed_chars: oldExecutedTrimmed,
			new_executed_chars: newExecutedTrimmed,
		};
	}

	return {
		diff_class: "semantic",
		old_executed_chars: oldExecutedTrimmed,
		new_executed_chars: newExecutedTrimmed,
	};
}

/** Collapse every whitespace run to a single space — for comparison only. */
function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Count non-whitespace characters — used for telemetry-friendly executed
 *  char totals (whitespace-runs in executed code don't count toward "real"
 *  executed bytes, since indentation tweaks are handled by the diff_class
 *  branch directly). */
function countNonWhitespace(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (!/\s/.test(s[i] as string)) n++;
	}
	return n;
}
