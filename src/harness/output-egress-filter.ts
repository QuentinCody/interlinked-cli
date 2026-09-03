// ===========================================
// Output Egress Filter — local redaction of secrets in tool responses
// ===========================================
//
// PR-N2 of the trajectory-detectors rollout (see
// docs/design/trajectories-as-primitive.md §4.1.8). Pure function: takes tool
// response content + an EgressFilterConfig and returns a redacted copy plus
// metadata about what was redacted. Detector reuses the existing
// `scanSecrets` signature scanner from ./signatures.ts — no new patterns,
// no fs I/O, no mutation.
//
// Call site (not wired here): post-tool.ts will run this *after* the existing
// `output_scanning` Bash-secret warning path, so the agent sees a sanitized
// response while keeping the existing alert. Wiring is the main agent's job.
//
// Design notes:
//   * `scanSecrets(content)` returns `SignatureMatch[]`, where each match has a
//     `rule_id` and `matched_text` (the matched substring, capped at 120 chars
//     in signatures.ts). We replace ALL occurrences of `matched_text` in the
//     full content (not just the scanned slice), so a tail-half-of-the-buffer
//     secret that also appears earlier is still scrubbed end-to-end.
//   * `ignored_rule_ids` lets callers silence known false-positive shapes
//     without touching the detector itself.
//   * The function is deterministic and side-effect-free — safe to call from
//     any hook path (no latency floor, no I/O).

import { type SignatureMatch, scanSecrets } from "./signatures.js";

// ===========================================
// Types
// ===========================================

export interface EgressFilterConfig {
	/** Master switch. When false, filterOutputEgress is a pass-through. */
	enabled: boolean;
	/** Replacement string for matched secrets. Default: "[REDACTED]". */
	redaction_marker?: string;
	/** Maximum bytes to scan. Default: 100_000 (matches existing
	 *  output_scanning.max_scan_bytes). */
	max_scan_bytes?: number;
	/** Rule ids to skip even when scanSecrets flags them (e.g.,
	 *  false-positive shapes for the caller's domain). */
	ignored_rule_ids?: ReadonlyArray<string>;
}

interface FilteredOutput {
	/** Content with secrets replaced by redaction marker. Same as input when
	 *  nothing matched or the filter is disabled. */
	filtered: string;
	/** Rule ids of matched secret patterns (deduped, in first-seen order). */
	redacted_rule_ids: string[];
	/** Number of redactions performed (count of substring replacements
	 *  across all matches and all occurrences). */
	redaction_count: number;
}

// ===========================================
// Defaults
// ===========================================

export const DEFAULT_EGRESS_FILTER_CONFIG: EgressFilterConfig = {
	enabled: true,
	redaction_marker: "[REDACTED]",
	max_scan_bytes: 100_000,
	ignored_rule_ids: [],
};

const DEFAULT_REDACTION_MARKER = "[REDACTED]";
const DEFAULT_MAX_SCAN_BYTES = 100_000;

// ===========================================
// Helpers
// ===========================================

/** Escape a literal string for use inside a RegExp. Used to perform global
 *  replaceAll of the matched substring without relying on String.replaceAll
 *  semantics (which behave identically here but we want explicit globality). */
function escapeRegex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The substring this match should redact, or null when the match must be
 *  skipped: an ignored rule id, a missing/non-string `matched_text`, or a
 *  needle that no longer occurs in `text`. */
function redactableNeedle(
	match: SignatureMatch,
	ignoredRuleIds: ReadonlySet<string>,
	text: string,
): string | null {
	if (ignoredRuleIds.has(match.rule_id)) return null;
	const needle = match.matched_text;
	if (!needle || typeof needle !== "string") return null;
	if (text.indexOf(needle) === -1) return null; // gracefully skip absent matches
	return needle;
}

/** Replace every occurrence of `needle` in `text` with `marker`, reporting how
 *  many replacements were made. String.replaceAll requires Node 15+; this
 *  project targets ES2022, so the replacement is explicitly global. */
function replaceAllOccurrences(
	text: string,
	needle: string,
	marker: string,
): { text: string; occurrences: number } {
	const pattern = new RegExp(escapeRegex(needle), "g");
	let occurrences = 0;
	const replaced = text.replace(pattern, () => {
		occurrences += 1;
		return marker;
	});
	return { text: replaced, occurrences };
}

// ===========================================
// Public API
// ===========================================

/**
 * Redact secret patterns from `content`. Pure function.
 *
 * @param content Tool response text to scan.
 * @param config  Filter config — at minimum `{ enabled: true }`.
 * @returns       Filtered copy of content plus redaction metadata.
 *
 * Logic (matches docs/design/trajectories-as-primitive.md §4.1.8):
 *   1. If disabled or empty content: pass-through.
 *   2. Slice content to `max_scan_bytes` (default 100KB) for scanning.
 *   3. Run scanSecrets on the slice.
 *   4. For each match whose rule_id is not in `ignored_rule_ids`,
 *      replaceAll(matched_text, redaction_marker) over the FULL content.
 *   5. Return filtered text + dedup'd rule_ids + total replacement count.
 */
export function filterOutputEgress(
	content: string,
	config: EgressFilterConfig,
): FilteredOutput {
	if (config.enabled === false || content === "") {
		return { filtered: content, redacted_rule_ids: [], redaction_count: 0 };
	}

	const marker = config.redaction_marker ?? DEFAULT_REDACTION_MARKER;
	const maxBytes = config.max_scan_bytes ?? DEFAULT_MAX_SCAN_BYTES;
	const ignored = new Set(config.ignored_rule_ids ?? []);

	const slice = content.slice(0, maxBytes);
	const matches = scanSecrets(slice);
	if (matches.length === 0) {
		return { filtered: content, redacted_rule_ids: [], redaction_count: 0 };
	}

	let filtered = content;
	const ruleIdsSeen: string[] = [];
	const ruleIdsAdded = new Set<string>();
	let redactionCount = 0;

	for (const match of matches) {
		const needle = redactableNeedle(match, ignored, filtered);
		if (needle === null) continue;

		// Replace ALL occurrences across the full content (not just the slice).
		const replaced = replaceAllOccurrences(filtered, needle, marker);
		filtered = replaced.text;

		if (replaced.occurrences > 0) {
			redactionCount += replaced.occurrences;
			if (!ruleIdsAdded.has(match.rule_id)) {
				ruleIdsSeen.push(match.rule_id);
				ruleIdsAdded.add(match.rule_id);
			}
		}
	}

	return {
		filtered,
		redacted_rule_ids: ruleIdsSeen,
		redaction_count: redactionCount,
	};
}
