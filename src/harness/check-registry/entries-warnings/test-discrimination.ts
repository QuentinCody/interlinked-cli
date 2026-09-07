// Test-discrimination + test-isolation warning entries (2026-09-06). Built
// from the coverage campaign's falsifier corpus: 55 must/should-fix verdicts
// across 89 + 107 units, ~35 of them "covered but not discriminated" — the
// test runs the branch and would still pass with the branch inverted or
// deleted. No existing static check flagged any of them; these are the
// regex/AST-visible sub-shapes. Every entry is advisory (deep-audit cadence)
// until its sampled precision on a foreign corpus earns the default gate; the
// hit counts below are this repo's, which is a hardened, atypical corpus.
// Extracted into its own submodule: `test-and-demo.ts` sits under the
// 500-line cap and nine entries would cross it.

import { checkCatchWithoutAssertionGuard } from "../../checks/test-discrimination-catch.js";
import { checkFallbackOnlyAssertion } from "../../checks/test-discrimination-fallback.js";
import { checkDuplicateExpectedLiteralPosNeg } from "../../checks/test-discrimination-posneg.js";
import { checkSpyCallUnpinnedArgs } from "../../checks/test-discrimination-spy.js";
import { checkDuplicateThrowMessageAssertion } from "../../checks/test-discrimination-throw.js";
import { checkWildcardInObservable } from "../../checks/test-discrimination-wildcard.js";
import { checkDuplicateTestBody } from "../../checks/test-duplicate-body.js";
import { checkSpyWithoutRestore } from "../../checks/test-spy-without-restore.js";
import { checkExportExistenceSmokeTest } from "../../checks/test-export-existence.js";
import { checkCommentedOutAssertion } from "../../checks/test-commented-assertion.js";
import { checkInTreeTempFixture } from "../../checks/test-isolation-fixture-dir.js";
import { checkFixedPortInTest } from "../../checks/test-isolation-port.js";
import { checkMockReturnEcho } from "../../checks/test-mock-return-echo.js";
import { checkVacuousLoopAssertion } from "../../checks/test-vacuous-loop.js";
import type { CheckRegistration } from "../types.js";

export const TEST_DISCRIMINATION_ENTRIES: CheckRegistration[] = [
	{
		id: "duplicate_throw_message_assertion",
		phase: "post",
		name: "Duplicate Throw Message Assertion",
		description:
			"A literal throw assertion matches multiple throw sites in the resolved SUT callee; review whether the tested guard is distinguished from other errors.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Give each guard a distinct message (or a distinct error class / cause) and assert the one the input under test should trip; alternatively assert the observable that only that guard produces. A shared message makes the two guards indistinguishable to every test.",
		fn: checkDuplicateThrowMessageAssertion,
		resultsPropName: "duplicateThrowMessageAssertion",
		content_keywords: ["toThrow", "rejects"],
	},
	{
		id: "fallback_only_assertion",
		phase: "post",
		name: "Fallback-Only Assertion",
		description:
			"A test asserts only default outcomes on targets with no recognized non-default pin in the same file or a same-SUT sibling test file.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pin the non-default output somewhere in the file: add (or fix) the positive case that asserts a literal value for the same call, so the default-outcome case becomes the negative half of a discriminated pair.",
		fn: checkFallbackOnlyAssertion,
		resultsPropName: "fallbackOnlyAssertion",
		content_keywords: ["expect"],
	},
	{
		id: "spy_call_unpinned_args",
		phase: "post",
		name: "Spy Call With Unpinned Arguments",
		description:
			"A test asserts positive spy call counts without inspecting arguments, and its remaining assertions are default outcomes; review the collaboration contract.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Assert the arguments: toHaveBeenCalledWith(<literal>) or inspect mock.calls[0]; if the call carries no arguments, assert the returned value or the side effect the call produces instead.",
		fn: checkSpyCallUnpinnedArgs,
		resultsPropName: "spyCallUnpinnedArgs",
		content_keywords: ["toHaveBeenCalled"],
	},
	{
		id: "wildcard_in_observable",
		phase: "post",
		name: "Wildcard In Observable",
		description:
			"A test uses only wildcard-shaped assertions on observables. Imported-export-only smoke tests are reported by export_existence_smoke_test instead.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the wildcard with the literal the input under test must produce (the exact count, the exact string). Keep expect.any() only for fields that genuinely vary, next to at least one literal field.",
		fn: checkWildcardInObservable,
		resultsPropName: "wildcardInObservable",
		content_keywords: ["expect"],
	},
	// NOT REGISTERED: `test_name_matcher_mismatch` (checks/test-discrimination-title.ts)
	// was built and measured three times on this corpus — 0/8, 0/8, then 0/4
	// precision with `rejects` dropped — because a title claim ("returns an empty
	// aggregation", "throws (caught as …)") is routinely verified by a structured
	// literal or stderr text the title family cannot see. The detector and its
	// companion stay in the tree as a measured negative result; wire it only
	// after a foreign corpus shows the claim vocabulary means what it says.
	{
		id: "fixed_port_in_test",
		phase: "post",
		name: "Fixed Port In Test",
		description:
			"A test binds or targets a fixed TCP port ≥1024 (listen(8787), port: 8787, a loopback URL literal passed to fetch/connect) — the test fails whenever another process on the machine holds that port (inference-proxy, 2026-09-05, EADDRINUSE under a wrangler dev).",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Bind port 0 and read server.address().port; pass that port to the client. Asserting a default port in a log line is fine — binding it is not.",
		fn: checkFixedPortInTest,
		resultsPropName: "fixedPortInTest",
		content_keywords: ["listen", "port", "127.0.0.1", "localhost"],
	},
	{
		id: "in_tree_temp_fixture",
		phase: "post",
		name: "In-Tree Temp Fixture",
		description:
			"A test creates its temp fixture directory inside the repository (mkdtempSync(resolve(CLI_ROOT, …))) instead of the OS temp dir. A cut-off run leaks the directory; gitignored, so git status stays clean while whole-project typecheck and the coverage report pick it up (harness-debt row 30: four leaks in one day).",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Root the fixture in os.tmpdir() (mkdtempSync(join(tmpdir(), 'x-'))). If the code under test needs an in-tree-shaped path, give the temp dir its own tsconfig/package.json instead of placing it under src/.",
		fn: checkInTreeTempFixture,
		resultsPropName: "inTreeTempFixture",
		content_keywords: ["mkdtemp", "mkdirSync"],
	},
	{
		id: "catch_without_assertion_guard",
		phase: "post",
		name: "Catch Without Assertion Guard",
		description:
			"A test whose only assertions sit inside a catch block, with no expect.assertions(n), no fail sentinel closing the try, and no toThrow elsewhere — if the code under test stops throwing, the test passes vacuously.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Prefer expect(() => …).toThrow(<message>) / await expect(p).rejects.toThrow(<message>); if try/catch is needed, add expect.assertions(n) or end the try body with throw new Error('expected to throw').",
		fn: checkCatchWithoutAssertionGuard,
		resultsPropName: "catchWithoutAssertionGuard",
		content_keywords: ["catch"],
	},
	{
		id: "duplicate_expected_literal_pos_neg",
		phase: "post",
		name: "Duplicate Expected Literal Across Positive And Negative Cases",
		description:
			"Within one describe, a negative-titled it() (rejects / invalid / missing / N-prefixed) and a positive sibling assert the SAME literal on the same call target — the invalid input is rejected with the same observable the valid input produces, so the guard under test is not discriminated (u017 ×5, u020 ×2, u074, p2u023). Trivial sentinels (0, 1, '', 'ok') are ignored.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Make the rejection observable differ from the acceptance observable (a distinct message, a null vs a populated result, a thrown error) and assert that difference in the negative case; or feed an input that trips only the guard under test.",
		fn: checkDuplicateExpectedLiteralPosNeg,
		resultsPropName: "duplicateExpectedLiteralPosNeg",
		content_keywords: ["expect"],
	},
	// Round 2 (2026-09-07): three shapes the deterministic census of the first
	// eight surfaced, each prototyped on the tree BEFORE it was built
	// (scratch/test-quality-checks/proto-scan.mts) and corpus-calibrated by its
	// builder; the module headers carry the CLASS / FIRES WHEN / DOES NOT FIRE /
	// CALIBRATION contract. Design note: docs/design/test-discrimination-checks.md.
	{
		id: "vacuous_loop_assertion",
		phase: "post",
		name: "Vacuous Loop Assertion",
		description:
			"Every assertion in a test lies inside a collection loop without a recognized non-empty pin, literal collection, or positive assertion-count guard.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pin the collection first — expect(C).toHaveLength(n) or expect(C.length).toBeGreaterThan(0) — or add expect.assertions(n); only then do the loop's assertions prove anything.",
		fn: checkVacuousLoopAssertion,
		resultsPropName: "vacuousLoopAssertion",
		content_keywords: ["expect"],
	},
	{
		id: "mock_return_echo",
		phase: "post",
		name: "Mock Return Echo",
		description:
			"A test asserts only literals found in configured mock returns; unmatched, negated, throwing, and computed evidence is exempt, and coarse literals require one discovered mock target.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Assert something the code under test computes from the mocked value — a transformed field, the arguments it forwarded (toHaveBeenCalledWith), or a side effect — next to the echoed literal.",
		fn: checkMockReturnEcho,
		resultsPropName: "mockReturnEcho",
		content_keywords: ["mockReturnValue", "mockResolvedValue", "vi.fn", "mockImplementation"],
	},
	{
		id: "duplicate_test_body",
		phase: "post",
		name: "Duplicate Test Body",
		description:
			"Different test titles have identical normalized bodies and equivalent enclosing setup. Review redundant cases or inputs that were not changed after copying.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Change the input or expected value the second title promises, or delete the copy; if both rows are wanted, parametrize with it.each so the differing input is visible.",
		fn: checkDuplicateTestBody,
		resultsPropName: "duplicateTestBody",
		content_keywords: ["expect"],
	},
	{
		id: "spy_without_restore",
		phase: "post",
		name: "Spy Without Restore",
		description: "A spy has no visible applicable restoration in its test, ancestor teardown, or discovered runner settings; it may leak a replaced method into later tests.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction: "Use mockRestore in finally or teardown, using declarations, or restoreMocks in the runner config. clearAllMocks and resetAllMocks do not restore the original method.",
		fn: checkSpyWithoutRestore,
		resultsPropName: "spyWithoutRestore",
		content_keywords: ["spyOn"],
	},
	{
		id: "export_existence_smoke_test",
		phase: "post",
		name: "Export Existence Smoke Test",
		description: "Every assertion checks that a statically imported export exists or is a function, without exercising its behavior. This shape is owned separately from wildcard assertions.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction: "Exercise a public behavior with concrete inputs and expected results, or document that export availability itself is the intended compatibility contract.",
		fn: checkExportExistenceSmokeTest,
		resultsPropName: "exportExistenceSmokeTest",
		content_keywords: ["expect"],
	},
	{
		id: "commented_out_assertion",
		phase: "post",
		name: "Commented Out Assertion",
		description: "An actual comment inside an active test contains an assertion that cannot run; string, template, prose, and skipped-test examples are excluded.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction: "Restore the intended assertion so it can fail when behavior regresses, or remove the obsolete assertion and explain the current test contract.",
		fn: checkCommentedOutAssertion,
		resultsPropName: "commentedOutAssertion",
		content_keywords: ["expect"],
	},
];
