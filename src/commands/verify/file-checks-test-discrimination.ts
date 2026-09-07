// Test-discrimination + test-isolation batch (2026-09-06): the nine static
// test-quality detectors distilled from the coverage campaign's falsifier
// corpus. Mirrors the shape of `file-checks-endpoint-laziness.ts`; each
// detector mutates `r` in place through `toIssues`. All nine are advisory
// (`DEFAULT_ADVISORY_SKIPS`), so they surface under `verify --all-checks`.

import {
	checkCatchWithoutAssertionGuard,
	checkDuplicateExpectedLiteralPosNeg,
	checkDuplicateTestBody,
	checkSpyWithoutRestore,
	checkExportExistenceSmokeTest,
	checkCommentedOutAssertion,
	checkDuplicateThrowMessageAssertion,
	checkFallbackOnlyAssertion,
	checkFixedPortInTest,
	checkInTreeTempFixture,
	checkMockReturnEcho,
	checkSpyCallUnpinnedArgs,
	checkVacuousLoopAssertion,
	checkWildcardInObservable,
} from "../../harness/generic-checks.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

/** Public API — consumed by `file-checks.ts` (the per-file dispatcher). */
export function runTestDiscriminationChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, r } = ctx;

	r.duplicateThrowMessageAssertion.push(
		...toIssues(
			"duplicate_throw_message_assertion",
			relPath,
			checkDuplicateThrowMessageAssertion(content, file),
		),
	);
	r.fallbackOnlyAssertion.push(
		...toIssues("fallback_only_assertion", relPath, checkFallbackOnlyAssertion(content, file)),
	);
	r.spyCallUnpinnedArgs.push(
		...toIssues("spy_call_unpinned_args", relPath, checkSpyCallUnpinnedArgs(content, file)),
	);
	r.wildcardInObservable.push(
		...toIssues("wildcard_in_observable", relPath, checkWildcardInObservable(content, file)),
	);
	r.fixedPortInTest.push(
		...toIssues("fixed_port_in_test", relPath, checkFixedPortInTest(content, file)),
	);
	r.inTreeTempFixture.push(
		...toIssues("in_tree_temp_fixture", relPath, checkInTreeTempFixture(content, file)),
	);
	r.catchWithoutAssertionGuard.push(
		...toIssues(
			"catch_without_assertion_guard",
			relPath,
			checkCatchWithoutAssertionGuard(content, file),
		),
	);
	r.duplicateExpectedLiteralPosNeg.push(
		...toIssues(
			"duplicate_expected_literal_pos_neg",
			relPath,
			checkDuplicateExpectedLiteralPosNeg(content, file),
		),
	);
	// Round 2 (2026-09-07)
	r.vacuousLoopAssertion.push(
		...toIssues("vacuous_loop_assertion", relPath, checkVacuousLoopAssertion(content, file)),
	);
	r.mockReturnEcho.push(...toIssues("mock_return_echo", relPath, checkMockReturnEcho(content, file)));
	r.duplicateTestBody.push(
		...toIssues("duplicate_test_body", relPath, checkDuplicateTestBody(content, file)),
	);
	r.spyWithoutRestore.push(...toIssues("spy_without_restore", relPath, checkSpyWithoutRestore(content, file)));
	r.exportExistenceSmokeTest.push(...toIssues("export_existence_smoke_test", relPath, checkExportExistenceSmokeTest(content, file)));
	r.commentedOutAssertion.push(...toIssues("commented_out_assertion", relPath, checkCommentedOutAssertion(content, file)));
}
