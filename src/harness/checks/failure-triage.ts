// ===========================================
// Phase 1 Channel 2 — Failure triage
// ===========================================
// Local heuristic classifier: regex match → triage label. Drives Channel 3
// (recovery suggestion) and Channel 6 (failure-cause explanation). Cloud
// upgrade tier (LLM classifier for unknown shapes) lands in Phase 3 — the
// public surface stays the same so callers don't change.
//
// Adding a new triage rule:
//   1. Append to TRIAGE_RULES below in the most-specific-first order
//      (regex.test is greedy across the table; the first match wins).
//   2. Update src/harness/checks/__tests__/failure-triage.test.ts with at
//      least 3 positives + 3 negatives to pin behavior.
//
// The category strings are load-bearing: Channel 3 (recovery-suggestion.ts)
// and Channel 6 (failure-explanation.ts) key off `${label}/${category}` so
// any new category needs matching entries there or it falls back to a
// generic suggestion.

import type { ToolFailureEvent, TriageResult, TriageRule } from "../types.js";

/** Built-in triage rules — most-specific patterns first. */
const TRIAGE_RULES: TriageRule[] = [
	// TypeScript compiler errors — `tsc` reports `error TSxxxx: ...`.
	{
		match: /\bTS2307\b.*Cannot find module/i,
		classify: "agent-error",
		category: "missing-import",
	},
	{
		match: /\bTS2304\b.*Cannot find name/i,
		classify: "agent-error",
		category: "missing-symbol",
	},
	{
		match: /\bTS2345\b.*Argument of type/i,
		classify: "agent-error",
		category: "type-mismatch",
	},
	{
		match: /\bTS2322\b.*Type .* is not assignable/i,
		classify: "agent-error",
		category: "type-mismatch",
	},
	{
		match: /\bTS2339\b.*Property .* does not exist/i,
		classify: "agent-error",
		category: "missing-property",
	},
	{
		match: /\bTS6133\b.*declared but .* never read/i,
		classify: "agent-error",
		category: "unused-declaration",
	},
	{
		match: /\bTS\d{4}\b/,
		classify: "agent-error",
		category: "type-error",
	},
	// Filesystem / OS errors — match before generic "permission denied".
	{
		match: /\bENOENT\b|no such file or directory/i,
		classify: "environmental",
		category: "filesystem-missing",
	},
	{
		match: /\bEACCES\b|permission denied/i,
		classify: "environmental",
		category: "filesystem-permission",
	},
	{
		match: /\bEISDIR\b|is a directory/i,
		classify: "agent-error",
		category: "filesystem-shape",
	},
	{
		match: /\bENOTDIR\b|not a directory/i,
		classify: "agent-error",
		category: "filesystem-shape",
	},
	{
		match: /\bEEXIST\b|file already exists/i,
		classify: "agent-error",
		category: "filesystem-shape",
	},
	// Network — transient by default unless DNS resolution fails outright.
	{
		match: /\bECONNREFUSED\b/,
		classify: "transient",
		category: "network-refused",
	},
	{
		match: /\bETIMEDOUT\b|connection timed out/i,
		classify: "transient",
		category: "network-timeout",
	},
	{
		match: /\bEAI_AGAIN\b/,
		classify: "transient",
		category: "dns",
	},
	{
		match: /\bENOTFOUND\b|getaddrinfo .* failed/i,
		classify: "agent-error",
		category: "dns-resolution",
	},
	// HTTP / API rate limits.
	{
		match: /\b429\b|too many requests|rate ?limit/i,
		classify: "transient",
		category: "rate-limit",
	},
	{
		match: /\b401\b.*unauthor|invalid credentials|invalid api key/i,
		classify: "agent-error",
		category: "auth",
	},
	{
		match: /\b403\b.*forbidden/i,
		classify: "agent-error",
		category: "auth",
	},
	// Package managers.
	{
		match: /npm\s+ERR!\s+code\s+E429/i,
		classify: "transient",
		category: "rate-limit",
	},
	{
		match: /npm\s+ERR!\s+code\s+ENOTFOUND/i,
		classify: "agent-error",
		category: "dns-resolution",
	},
	{
		match: /npm\s+ERR!\s+(?:404 |Cannot find module)/i,
		classify: "agent-error",
		category: "missing-package",
	},
	{
		match: /npm\s+ERR!\s+code\s+ELIFECYCLE/i,
		classify: "agent-error",
		category: "package-script",
	},
	// Git.
	{
		match: /\bgit\b.*not a git repository/i,
		classify: "environmental",
		category: "git-state",
	},
	{
		match: /\b(merge conflict|conflict in)\b/i,
		classify: "agent-error",
		category: "git-conflict",
	},
	{
		match: /pre-commit hook .* failed|husky .* failed/i,
		classify: "agent-error",
		category: "pre-commit",
	},
	{
		match: /CONFLICT \(content\)/,
		classify: "agent-error",
		category: "git-conflict",
	},
	// Test runners.
	{
		match: /^\s*(?:Test ?Suites?|Tests?):\s+\d+ failed/im,
		classify: "agent-error",
		category: "test-failure",
	},
	{
		match: /\bAssertionError\b/,
		classify: "agent-error",
		category: "assertion",
	},
	{
		match: /Expected .* (?:to|but)/i,
		classify: "agent-error",
		category: "assertion",
	},
	// Process-level failures — least specific, must come last.
	{
		match: /SIGSEGV|segmentation fault/i,
		classify: "unrecoverable",
		category: "process-crash",
	},
	{
		match: /SIGKILL|killed/i,
		classify: "unrecoverable",
		category: "process-killed",
	},
	{
		match: /heap (?:out of memory|allocation failed)/i,
		classify: "environmental",
		category: "out-of-memory",
	},
	// User-side intent.
	{
		match: /interrupt|user cancell?ed|aborted/i,
		classify: "transient",
		category: "user-interrupt",
	},
];

/** Public API consumed by the harness handler. Classify a tool failure into
 *  triage label + category. Walks TRIAGE_RULES in declaration order; first
 *  match wins. Returns a `unknown` fallback rather than null so callers can
 *  always render a row — Channels 3/6 also handle the unknown case.
 *
 *  The match input is the union of error_message + stderr (whichever is
 *  populated). `tool_input.command` is sometimes the only diagnostic for
 *  Bash failures with empty stderr, so it gets included as a tertiary
 *  fallback. */
export function classifyFailure(event: ToolFailureEvent): TriageResult {
	const haystack = buildHaystack(event);
	if (!haystack) {
		return {
			label: "unknown",
			category: "no-diagnostic",
			confidence: 0,
			source: "local-heuristic",
		};
	}
	for (const rule of TRIAGE_RULES) {
		if (rule.tools && !rule.tools.includes(event.tool_name)) continue;
		if (rule.match.test(haystack)) {
			return {
				label: rule.classify,
				category: rule.category,
				confidence: 0.85,
				source: "local-heuristic",
				matched_rule: rule.match.source,
			};
		}
	}
	return {
		label: "unknown",
		category: "uncategorized",
		confidence: 0.2,
		source: "local-heuristic",
	};
}

/** Public API for tests: lets us assert the rule table doesn't regress on
 *  refactors. Stable across versions; new rows are appended, not reordered
 *  arbitrarily. */
export function listTriageRules(): readonly TriageRule[] {
	return TRIAGE_RULES;
}

const BASH_LIKE_TOOLS = new Set(["Bash", "Shell", "shell", "run_command"]);

function buildHaystack(event: ToolFailureEvent): string {
	const parts: string[] = [];
	if (event.error_message) parts.push(event.error_message);
	if (event.stderr && event.stderr !== event.error_message) parts.push(event.stderr);
	// Some Bash invocations emit the diagnostic to stdout (e.g. test runners
	// that don't separate streams). We only consult stdout when stderr is
	// empty — otherwise stdout is mostly noise.
	if (event.stdout && !event.stderr && BASH_LIKE_TOOLS.has(event.tool_name)) {
		parts.push(event.stdout);
	}
	const cmd =
		event.tool_input && typeof event.tool_input.command === "string"
			? event.tool_input.command
			: "";
	if (cmd) parts.push(cmd);
	return parts.join("\n");
}
