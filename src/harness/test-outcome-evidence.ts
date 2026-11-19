// ===========================================
// Test-run outcome evidence
// ===========================================
// Decides whether a test run's red/green can actually be BELIEVED, and reads
// the runner's own verdict when the shell's cannot be.
//
// The defect this exists to close: `tool_outcome` / `exit_code` describe the
// whole shell command, not the runner. Both of these exit 0 whether or not the
// tests passed —
//
//     npx vitest run … | tail -12          (exit is tail's)
//     npx vitest run … > log 2>&1; echo x  (exit is echo's)
//
// — so trusting them recorded GREEN for a failing suite. That is the same
// pipe-masking mistake the harness exists to catch, occurring inside the
// harness's own observation path, and it is worse than a missed pass: a red
// tree could satisfy the commit gate.
//
// Note that REDIRECTION is innocent. `> log 2>&1` does not change exit status,
// so a redirected run stays attributable — an earlier diagnosis blamed the
// redirect and was wrong. What matters is whether a shell control operator
// follows the runner.

import type { HarnessEvent } from "./types.js";
import {
	blankReadSegments,
	lastInvocationOfKind,
	type VerificationSignal,
} from "./verification-stop-checks-predicates.js";

/** Runner invocations we can locate inside a command string. */
const RUNNER_RE =
	/(?<![\w./-])(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|pytest|rspec)\b(?!\.\w)|\bnode(?:\s+--?[\w=.:/-]+(?:\s+[^\s;|&-][^\s;|&]*)?)*?\s+--test\b|\bnpm\s+(?:run\s+)?test\b|\b(?:cargo|go|deno|bun)\s+test\b/g;

/** Shell control operators that hand the exit status to something else. A
 *  newline separates commands exactly as `;` does. */
const CONTROL_OP_RE = /(\|\||&&|[;|\n])/;

/** The operators that still hand the status away when `pipefail` is on. */
const NON_PIPE_OP_RE = /(\|\||&&|[;\n])/;

/** `set -o pipefail` / `set -euo pipefail` / `setopt pipefail` as its own command. */
const PIPEFAIL_RE = /(?:^|[;&\n])\s*(?:set\s+-[A-Za-z]*o\s+pipefail|setopt\s+pipefail)\b/;

/** Replace quoted spans with same-length filler so operators inside a `-t "a || b"`
 *  filter are not mistaken for shell control operators. A backslash-newline is
 *  a line continuation, not a separator, so it becomes blanks too. */
function maskQuoted(cmd: string): string {
	return cmd.replace(/"[^"]*"|'[^']*'/g, (m) => "_".repeat(m.length)).replace(/\\\n/g, "  ");
}

/** Span of the last invocation of `kind` in an already-masked command. Test
 *  runs are located by BOTH patterns, so a runner only one of them names
 *  (`pnpm test`, `npx jest`) is still found. */
function lastInvocation(
	masked: string,
	kind: VerificationSignal,
): { start: number; end: number } | null {
	let last = lastInvocationOfKind(masked, kind);
	if (kind !== "test") return last;
	for (const m of blankReadSegments(masked).matchAll(RUNNER_RE)) {
		const end = m.index + m[0].length;
		if (last === null || end > last.end) last = { start: m.index, end };
	}
	return last;
}

/**
 * True when the command's exit status reflects the result of its last
 * verification invocation of `kind` (default: the TEST RUNNER).
 *
 * Operators BEFORE the invocation are fine — `cd pkg && npx vitest run` still
 * ends with the runner, so its status is the command's. Operators AFTER it are
 * not: whatever runs last owns the exit code. One exception: when `pipefail`
 * is set before the invocation and only pipes follow, a failing stage fails
 * the whole pipeline, so the status is the invocation's again.
 *
 * Commands with no recognizable invocation return true; callers only ask about
 * commands already classified as that kind, and answering "un-attributable"
 * for an unrelated string would be noise.
 */
export function isOutcomeAttributable(command: string, kind: VerificationSignal = "test"): boolean {
	const masked = maskQuoted(command);
	const span = lastInvocation(masked, kind);
	if (span === null) return true;
	const after = masked.slice(span.end).trimEnd();
	if (!CONTROL_OP_RE.test(after)) return true;
	return PIPEFAIL_RE.test(masked.slice(0, span.start)) && !NON_PIPE_OP_RE.test(after);
}

/** Runner output as the hook captured it: stdout/stderr when present, else a
 *  string tool_response. The one text every summary reader works from. */
export function observedOutput(event: HarnessEvent): string | undefined {
	const parts = [event.stdout, event.stderr].filter((s): s is string => typeof s === "string");
	if (parts.length > 0) return parts.join("\n");
	return typeof event.tool_response === "string" ? event.tool_response : undefined;
}

/** A vitest/jest "no tests matched" outcome — a targeting mistake, not a test
 *  failure. Recording it as red would wedge a cycle whose tests never ran. */
const NO_TESTS_RE = /No test files found|No tests found|matched no test files/i;

/** vitest: `Tests  2 failed | 21845 passed`. jest: `Tests: 1 failed, 2 passed`. */
// Accept a single rg/grep -n line prefix, not arbitrary source-file prefixes.
const SUMMARY_LINE_RE = /^\s*(?:\d+:\s*)?(?:Tests|Test Files)[:\s]\s*.+$/gm;

/** Node test runner (TAP) summary lines: `# pass 13`, `# fail 1`. */
const TAP_PASS_RE = /^#\s+pass\s+[1-9]\d*\s*$/m;
const TAP_FAIL_RE = /^#\s+fail\s+[1-9]\d*\s*$/m;

/**
 * The runner's own verdict, independent of shell plumbing. Returns null when
 * the output carries no summary — the caller must then treat the run as
 * unproven rather than assume either direction.
 */
export function parseTestSummary(output: string | undefined): "green" | "red" | null {
	if (!output) return null;
	if (NO_TESTS_RE.test(output)) return null;

    const summaries = [...output.matchAll(SUMMARY_LINE_RE)].map(match => match[0]);
    if (summaries.some(summary => /\b[1-9]\d*\s+failed\b/.test(summary))) return "red";
    if (TAP_FAIL_RE.test(output)) return "red";
    if (summaries.some(summary => /\b[1-9]\d*\s+(?:passed|skipped)\b/.test(summary))) return "green";
    return TAP_PASS_RE.test(output) ? "green" : null;
}
