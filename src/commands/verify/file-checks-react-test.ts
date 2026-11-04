// ===========================================
// Per-file check battery — React / test-smell / taste group
// ===========================================
// Extracted from `file-checks.ts` to keep that orchestrator under the
// 1000-line file-size threshold. Covers the React-hooks / DOM detectors,
// the "coding-agent feedback" pack, PII detection, and Robert-C-Martin
// taste checks. Behaviour-preserving: same checks, same per-bucket order.

import {
	checkAsyncEventHandler,
	checkCatchAndLog,
	checkDangerouslySetInnerHTML,
	checkDirectDomAccess,
	checkDisabledTests,
	checkExcessiveUseEffect,
	checkExcessiveUseState,
	checkFocusedTests,
	checkHardcodedTimeout,
	checkIndexAsKey,
	checkInlineObjectProps,
	checkJsonParseUnsafe,
	checkMigrationOrdering,
	checkMissingEffectCleanup,
	checkNestedTernaries,
	checkOverMocking,
	checkPiiInSource,
	checkPlaceholderTests,
	checkSequentialAwaits,
	checkSnapshotOveruse,
	checkSqlSchemaConsistency,
	checkTargetBlankNoRel,
	checkTestImportingTest,
	checkUnvalidatedJsonBoundary,
	checkVisibilityFilterMissing,
} from "../../harness/generic-checks.js";
import {
	checkAssertionFreeTest,
	checkAssertionRoulette,
	checkCommentedOutCode,
	checkConditionalInTest,
	checkDataClump,
	checkDuplicateDescribe,
	checkDuplicateSwitchDiscriminant,
	checkElseIfChain,
	checkEmptyCatch,
	checkFlagArgument,
	checkFunctionArgCount,
	checkFuzzyResponsibilityName,
	checkHybridClass,
	checkLawOfDemeter,
	checkLoopNestingDepth,
	checkMagicNumber,
	checkMockingTheSUT,
	checkNonDeterministicTest,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
	checkTestWithoutDescription,
} from "../../harness/taste-checks.js";
import { checkTimingFlake } from "../../harness/checks/timing-flake.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

/**
 * React-hooks / DOM detectors, the coding-agent feedback pack, PII detection,
 * and taste checks. Mirrors the inline blocks from "--- 13 additional agent
 * safety checks ---" through "--- Taste checks ---".
 */
export function runReactAndTasteChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, piiOpts, r } = ctx;

	// --- 13 additional agent safety checks ---
	r.excessiveUseState.push(
		...toIssues("excessive_use_state", relPath, checkExcessiveUseState, content, file),
	);
	r.dangerouslySetInnerHtml.push(
		...toIssues(
			"dangerously_set_inner_html",
			relPath,
			checkDangerouslySetInnerHTML, content, file,
		),
	);
	r.directDomAccess.push(
		...toIssues("direct_dom_access", relPath, checkDirectDomAccess, content, file),
	);
	r.inlineObjectProps.push(
		...toIssues("inline_object_props", relPath, checkInlineObjectProps, content, file),
	);
	r.asyncEventHandler.push(
		...toIssues("async_event_handler", relPath, checkAsyncEventHandler, content, file),
	);
	r.nestedTernaries.push(
		...toIssues("nested_ternaries", relPath, checkNestedTernaries, content, file),
	);
	r.catchAndLog.push(...toIssues("catch_and_log", relPath, checkCatchAndLog, content, file));
	r.jsonParseUnsafe.push(
		...toIssues("json_parse_unsafe", relPath, checkJsonParseUnsafe, content, file),
	);
	r.unvalidatedJsonBoundary.push(
		...toIssues(
			"unvalidated_json_boundary",
			relPath,
			checkUnvalidatedJsonBoundary, content, file,
		),
	);
	r.hardcodedTimeout.push(
		...toIssues("hardcoded_timeout", relPath, checkHardcodedTimeout, content, file),
	);
	r.disabledTests.push(...toIssues("disabled_tests", relPath, checkDisabledTests, content, file));
	r.placeholderTest.push(
		...toIssues("placeholder_test", relPath, checkPlaceholderTests, content, file),
	);
	r.targetBlankNoRel.push(
		...toIssues("target_blank_no_rel", relPath, checkTargetBlankNoRel, content, file),
	);
	r.snapshotOveruse.push(
		...toIssues("snapshot_overuse", relPath, checkSnapshotOveruse, content, file),
	);
	r.testImportingTest.push(
		...toIssues("test_importing_test", relPath, checkTestImportingTest, content, file),
	);

	// --- 5 additional agent safety checks ---
	r.excessiveUseEffect.push(
		...toIssues("excessive_use_effect", relPath, checkExcessiveUseEffect, content, file),
	);
	r.sequentialAwaits.push(
		...toIssues("sequential_awaits", relPath, checkSequentialAwaits, content, file),
	);
	r.indexAsKey.push(...toIssues("index_as_key", relPath, checkIndexAsKey, content, file));
	r.missingEffectCleanup.push(
		...toIssues("missing_effect_cleanup", relPath, checkMissingEffectCleanup, content, file),
	);
	r.overMocking.push(...toIssues("over_mocking", relPath, checkOverMocking, content, file));

	// --- Coding-agent feedback checks ---
	r.focusedTests.push(...toIssues("focused_tests", relPath, checkFocusedTests, content, file));
	r.migrationOrdering.push(
		...toIssues("migration_ordering", relPath, checkMigrationOrdering, content, file),
	);
	r.sqlSchemaConsistency.push(
		...toIssues("sql_schema_consistency", relPath, checkSqlSchemaConsistency, content, file),
	);
	r.visibilityFilterMissing.push(
		...toIssues(
			"visibility_filter_missing",
			relPath,
			checkVisibilityFilterMissing, content, file,
		),
	);

	// PII detection
	r.piiDetection.push(
		...toIssues("pii_detection", relPath, checkPiiInSource, content, file, piiOpts),
	);

	// --- Taste checks ---
	r.assertionFreeTest.push(
		...toIssues("assertion_free_test", relPath, checkAssertionFreeTest, content, file),
	);
	r.tautologicalAssertion.push(
		...toIssues("tautological_assertion", relPath, checkTautologicalAssertion, content, file),
	);
	r.mockingTheSut.push(
		...toIssues("mocking_the_sut", relPath, checkMockingTheSUT, content, file),
	);
	r.privateMemberTestAccess.push(
		...toIssues(
			"private_member_test_access",
			relPath,
			checkPrivateMemberTestAccess, content, file,
		),
	);
	r.loopNestingDepth.push(
		...toIssues("loop_nesting_depth", relPath, checkLoopNestingDepth, content, file),
	);
	r.elseIfChain.push(...toIssues("else_if_chain", relPath, checkElseIfChain, content, file));
	r.duplicateSwitchDiscriminant.push(
		...toIssues(
			"duplicate_switch_discriminant",
			relPath,
			checkDuplicateSwitchDiscriminant, content, file,
		),
	);
	r.hybridClass.push(...toIssues("hybrid_class", relPath, checkHybridClass, content, file));
	r.fuzzyResponsibilityName.push(
		...toIssues(
			"fuzzy_responsibility_name",
			relPath,
			checkFuzzyResponsibilityName, content, file,
		),
	);
	r.lawOfDemeter.push(...toIssues("law_of_demeter", relPath, checkLawOfDemeter, content, file));
	r.flagArgument.push(...toIssues("flag_argument", relPath, checkFlagArgument, content, file));
	r.commentedOutCode.push(
		...toIssues("commented_out_code", relPath, checkCommentedOutCode, content, file),
	);
	r.conditionalInTest.push(
		...toIssues("conditional_in_test", relPath, checkConditionalInTest, content, file),
	);
	r.nonDeterministicTest.push(
		...toIssues("non_deterministic_test", relPath, checkNonDeterministicTest, content, file),
	);
	r.timingFlake.push(...toIssues("timing_flake", relPath, checkTimingFlake, content, file));
	r.emptyCatch.push(...toIssues("empty_catch", relPath, checkEmptyCatch, content, file));
	r.testWithoutDescription.push(
		...toIssues(
			"test_without_description",
			relPath,
			checkTestWithoutDescription, content, file,
		),
	);
	r.assertionRoulette.push(
		...toIssues("assertion_roulette", relPath, checkAssertionRoulette, content, file),
	);
	r.magicNumber.push(...toIssues("magic_number", relPath, checkMagicNumber, content, file));
	r.functionArgCount.push(
		...toIssues("function_arg_count", relPath, checkFunctionArgCount, content, file),
	);
	r.dataClump.push(...toIssues("data_clump", relPath, checkDataClump, content, file));
	r.duplicateDescribe.push(
		...toIssues("duplicate_describe", relPath, checkDuplicateDescribe, content, file),
	);
}
