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

/** Runner invocations we can locate inside a command string. */
const RUNNER_RE =
	/\b(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|pytest|rspec)\b|\bnpm\s+(?:run\s+)?test\b|\b(?:cargo|go|deno|bun)\s+test\b/g;

/** Shell control operators that hand the exit status to something else. */
const CONTROL_OP_RE = /(\|\||&&|[;|])/;

/** Replace quoted spans with same-length filler so operators inside a `-t "a || b"`
 *  filter are not mistaken for shell control operators. */
function maskQuoted(cmd: string): string {
	return cmd.replace(/"[^"]*"|'[^']*'/g, (m) => "_".repeat(m.length));
}

/**
 * True when the command's exit status reflects the TEST RUNNER's result.
 *
 * Operators BEFORE the runner are fine — `cd pkg && npx vitest run` still ends
 * with the runner, so its status is the command's. Operators AFTER it are not:
 * whatever runs last owns the exit code.
 *
 * Commands with no recognizable runner return true; callers only ask about
 * commands already classified as test runs, and answering "un-attributable"
 * for an unrelated string would be noise.
 */
export function isOutcomeAttributable(command: string): boolean {
	const masked = maskQuoted(command);
	RUNNER_RE.lastIndex = 0;
	let lastEnd = -1;
	for (let m = RUNNER_RE.exec(masked); m !== null; m = RUNNER_RE.exec(masked)) {
		lastEnd = m.index + m[0].length;
	}
	if (lastEnd < 0) return true;
	return !CONTROL_OP_RE.test(masked.slice(lastEnd));
}

/** A vitest/jest "no tests matched" outcome — a targeting mistake, not a test
 *  failure. Recording it as red would wedge a cycle whose tests never ran. */
const NO_TESTS_RE = /No test files found|No tests found|matched no test files/i;

/** vitest: `Tests  2 failed | 21845 passed`. jest: `Tests: 1 failed, 2 passed`. */
// Accept a single rg/grep -n line prefix, not arbitrary source-file prefixes.
const SUMMARY_LINE_RE = /^\s*(?:\d+:\s*)?(?:Tests|Test Files)[:\s]\s*.+$/gm;

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
    return summaries.some(summary => /\b[1-9]\d*\s+(?:passed|skipped)\b/.test(summary)) ? "green" : null;
}
