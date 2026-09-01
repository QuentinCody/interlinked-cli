// ===========================================
// Test-signal erosion pre-warn (DW test-adoption P0.3 b/c)
// ===========================================
// Two of §9.1b's test-sabotage vectors, shifted to PreToolUse as WARNINGS:
//   (b) emptying/gutting a test file (fewer test blocks) while its prod pair
//       changed this session;
//   (c) dropping assertion density in a test file.
// Both fold into one signal: a test-file edit that REDUCES its test-block or
// assertion count vs the on-disk version erodes the test signal. Warn-only,
// never blocks — a legitimate refactor (dead test, consolidation) also reduces
// counts, and blocking those was the whole reason these are pre_warn not
// pre_block. Trajectory-aware: the warning is STRONGER when the prod pair also
// changed this session (weakening the test right as the behavior moves is the
// regression-mask shape). The post-time assertion-density check stays as the
// authoritative session-delta backstop; this is the earlier nudge.
//
// PURE: counting + the erosion verdict are functions of (before, after) text;
// the on-disk read, proposed-content reconstruction, and session lookup live in
// the pre-tool wiring.

const JS_TEST_BLOCK_RE = /\b(?:it|test)\s*\(/g;
const JS_ASSERT_RE = /\bexpect\s*\(|\bassert(?:\w*)?\s*\(/g;
const PY_TEST_BLOCK_RE = /^\s*def\s+test_\w*\s*\(/gm;
const PY_ASSERT_RE = /^\s*assert\b/gm;

/** Counts of test blocks and assertions in a source string. */
interface TestSignals {
	tests: number;
assertions: number;
}

function count(s: string, re: RegExp): number {
	return (s.match(re) ?? []).length;
}

/** Count test blocks (`it`/`test`/`def test_`) and assertions
 *  (`expect`/`assert`) in a test file's content. Python vs JS/TS by extension. */
export function countTestSignals(content: string, filePath: string): TestSignals {
	const isPy = filePath.endsWith(".py");
	return {
		tests: count(content, isPy ? PY_TEST_BLOCK_RE : JS_TEST_BLOCK_RE),
		assertions: count(content, isPy ? PY_ASSERT_RE : JS_ASSERT_RE),
	};
}

/**
 * A `[interlinked:test-integrity]` warning when the edit ERODES the test signal
 * (fewer test blocks or fewer assertions than before), else null. Never a
 * block. `prodPairChangedThisSession` strengthens the wording — the weakening
 * coincides with a behavior change, the regression-mask shape.
 */
export function testSignalErosion(
	before: TestSignals,
	after: TestSignals,
	opts: { relPath: string; prodPairChangedThisSession: boolean },
): string | null {
	const droppedTests = before.tests - after.tests;
	const droppedAsserts = before.assertions - after.assertions;
	if (droppedTests <= 0 && droppedAsserts <= 0) return null;

	const parts: string[] = [];
	if (droppedTests > 0) parts.push(`${droppedTests} test block(s)`);
	if (droppedAsserts > 0) parts.push(`${droppedAsserts} assertion(s)`);
	const pairNote = opts.prodPairChangedThisSession
		? " — and its source changed earlier this session, so this weakens the test right as the behavior moves"
		: "";
	return (
		`[interlinked:test-integrity] this edit removes ${parts.join(" and ")} from ${opts.relPath}${pairNote}. ` +
		"If that is intentional (a dead test, a refactor), fine — but don't quietly drop coverage to make a change pass."
	);
}
