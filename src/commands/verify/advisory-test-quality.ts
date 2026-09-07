// ===========================================
// Advisory ids — the test-quality family
// ===========================================
// Split out of `advisory.ts` (at the 500-line cap) on 2026-09-06 when the
// nine test-discrimination checks landed. Spread into `DEFAULT_ADVISORY_SKIPS`
// there; the harness-side mirror is `src/harness/advisory-check-ids.ts` and
// the parity test pins the two sets equal. Per-entry rationale lives here.

/** Public API — consumed by `advisory.ts` (spread into DEFAULT_ADVISORY_SKIPS). */
export const TEST_QUALITY_ADVISORY_IDS: readonly string[] = [
	// Real signal but FP-prone. mock_only_test fires on legitimate
	// fire-and-forget assertions ("the event was emitted") that have no value
	// to check; happy_path_only_test fires on pure-function test files
	// (formatters, getters) that genuinely have no failure path.
	"mock_only_test",
	"happy_path_only_test",
	// introverted_test is a static AST dataflow heuristic — helper-inlining is
	// v0-limited, so it stays silent on uncertainty but can still miss/over-fire
	// on unusual SUT-reach patterns.
	"introverted_test",
	// Mutation score cannot prove that a call-order or internal-surface
	// assertion represents a supported behavior.
	"test_legitimacy",
	// A /proc path literal in a test hangs Linux CI, but the literal alone
	// cannot prove intent — an assertion string or a fixture list can carry it.
	"procfs_probe_in_test",
	// Test-discrimination + isolation family (2026-09-06), distilled from the
	// coverage campaign's 55 falsifier verdicts. Sampled precision on THIS
	// repo (hardened, boundary-test-heavy — fire rate measures the corpus):
	// spy 8/8, wildcard 8/8, throw ~4/8 file-wide (callee-scoped variant
	// pending), fallback ~4/8 with sibling visibility, pos/neg ~5/8, port /
	// fixture / catch 0 hits after FP removal. The title-claim check measured
	// 0/8 three times and is NOT registered. Advisory until a foreign corpus
	// shows ≥90% on a check; none blocks.
	"duplicate_throw_message_assertion",
	"fallback_only_assertion",
	"spy_call_unpinned_args",
	"wildcard_in_observable",
	"fixed_port_in_test",
	"in_tree_temp_fixture",
	"catch_without_assertion_guard",
	"duplicate_expected_literal_pos_neg",
	// Round 2: six advisory shapes. Builder samples are not independent
	// precision measurements; current behavior and calibration limits live
	// in the detector headers and docs/design/test-discrimination-checks.md.
	"vacuous_loop_assertion",
	"mock_return_echo",
	"duplicate_test_body",
	"spy_without_restore",
	"export_existence_smoke_test",
	"commented_out_assertion",
];
