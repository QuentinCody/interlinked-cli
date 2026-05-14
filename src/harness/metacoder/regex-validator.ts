// ===========================================
// Metacoder — Regex validator
// ===========================================
// Floor guard rules are admin-authored and trusted; the matcher does not
// validate input regexes (see rule-matching.ts::getCachedRegex comment).
// Overlay regexes come from an LLM and need bounds. Each check returns a
// short reason string when the regex is rejected. Pure functions; no I/O.

import type { MetacoderConfig } from "./types.js";

const ALLOWED_FLAGS = new Set(["i", "m", "s"]);

/** Catches the common ReDoS shapes a hallucinating LLM is most likely to
 *  emit: `(a+)+`, `(a*)*` (nested unbounded quantifiers) and `(a|b)*` /
 *  `(a|a)*` (quantified alternation). Allows `(abc)*` because the inner has
 *  no quantifier or alternation. Not exhaustive — `((a)+)*` slips past
 *  because `[^)]` won't cross the inner `)`. Plan §10 risk #9. */
const REDOS_SHAPE = /\([^)]*[|+*][^)]*\)[+*]/;

export interface RegexValidationFailure {
	reason: string;
}

/** Returns `null` when the regex is acceptable; otherwise the rejection
 *  reason as a short human-readable string. */
export function validateOverlayRegex(
	pattern: string,
	flags: string | undefined,
	config: MetacoderConfig,
): RegexValidationFailure | null {
	if (typeof pattern !== "string" || pattern.length === 0) {
		return { reason: "empty pattern" };
	}
	if (pattern.length > config.max_pattern_length) {
		return { reason: `pattern length ${pattern.length} > ${config.max_pattern_length}` };
	}
	const resolvedFlags = flags ?? "";
	for (const ch of resolvedFlags) {
		if (!ALLOWED_FLAGS.has(ch)) {
			return { reason: `flag '${ch}' not in {i,m,s}` };
		}
	}
	if (REDOS_SHAPE.test(pattern)) {
		return { reason: "nested unbounded quantifier (ReDoS shape)" };
	}
	try {
		// Compiling once at load time surfaces invalid regexes before they
		// reach the PreToolUse hot path. The compiled object is discarded —
		// the matcher's own cache compiles again at use time.
		new RegExp(pattern, resolvedFlags);
	} catch (err) {
		return { reason: `invalid: ${err instanceof Error ? err.message : String(err)}` };
	}
	return null;
}

/** Bound on patterns-per-rule for overlays. Returns the rejection reason or
 *  `null` if the count is acceptable. */
export function validateOverlayPatternCount(
	count: number,
	config: MetacoderConfig,
): RegexValidationFailure | null {
	if (count > config.max_patterns_per_rule) {
		return { reason: `${count} patterns > ${config.max_patterns_per_rule}` };
	}
	return null;
}
