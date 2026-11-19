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
import { contentCheckRunner } from "./file-checks-content.js";

/**
 * React-hooks / DOM detectors, the coding-agent feedback pack, PII detection,
 * and taste checks. Mirrors the inline blocks from "--- 13 additional agent
 * safety checks ---" through "--- Taste checks ---".
 */
export function runReactAndTasteChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, piiOpts, r } = ctx;
	const runCheck = contentCheckRunner(ctx);

	// --- 13 additional agent safety checks ---
	runCheck("excessive_use_state", r.excessiveUseState, checkExcessiveUseState);
	runCheck("dangerously_set_inner_html", r.dangerouslySetInnerHtml, checkDangerouslySetInnerHTML);
	runCheck("direct_dom_access", r.directDomAccess, checkDirectDomAccess);
	runCheck("inline_object_props", r.inlineObjectProps, checkInlineObjectProps);
	runCheck("async_event_handler", r.asyncEventHandler, checkAsyncEventHandler);
	runCheck("nested_ternaries", r.nestedTernaries, checkNestedTernaries);
	runCheck("catch_and_log", r.catchAndLog, checkCatchAndLog);
	runCheck("json_parse_unsafe", r.jsonParseUnsafe, checkJsonParseUnsafe);
	runCheck("unvalidated_json_boundary", r.unvalidatedJsonBoundary, checkUnvalidatedJsonBoundary);
	runCheck("hardcoded_timeout", r.hardcodedTimeout, checkHardcodedTimeout);
	runCheck("disabled_tests", r.disabledTests, checkDisabledTests);
	runCheck("placeholder_test", r.placeholderTest, checkPlaceholderTests);
	runCheck("target_blank_no_rel", r.targetBlankNoRel, checkTargetBlankNoRel);
	runCheck("snapshot_overuse", r.snapshotOveruse, checkSnapshotOveruse);
	runCheck("test_importing_test", r.testImportingTest, checkTestImportingTest);

	// --- 5 additional agent safety checks ---
	runCheck("excessive_use_effect", r.excessiveUseEffect, checkExcessiveUseEffect);
	runCheck("sequential_awaits", r.sequentialAwaits, checkSequentialAwaits);
	runCheck("index_as_key", r.indexAsKey, checkIndexAsKey);
	runCheck("missing_effect_cleanup", r.missingEffectCleanup, checkMissingEffectCleanup);
	runCheck("over_mocking", r.overMocking, checkOverMocking);

	// --- Coding-agent feedback checks ---
	runCheck("focused_tests", r.focusedTests, checkFocusedTests);
	runCheck("migration_ordering", r.migrationOrdering, checkMigrationOrdering);
	runCheck("sql_schema_consistency", r.sqlSchemaConsistency, checkSqlSchemaConsistency);
	runCheck("visibility_filter_missing", r.visibilityFilterMissing, checkVisibilityFilterMissing);

	// PII detection
	r.piiDetection.push(
		...toIssues("pii_detection", relPath, checkPiiInSource, content, file, piiOpts),
	);

	runTasteChecks(ctx);
}

function runTasteChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	runCheck("assertion_free_test", r.assertionFreeTest, checkAssertionFreeTest);
	runCheck("tautological_assertion", r.tautologicalAssertion, checkTautologicalAssertion);
	runCheck("mocking_the_sut", r.mockingTheSut, checkMockingTheSUT);
	runCheck("private_member_test_access", r.privateMemberTestAccess, checkPrivateMemberTestAccess);
	runCheck("loop_nesting_depth", r.loopNestingDepth, checkLoopNestingDepth);
	runCheck("else_if_chain", r.elseIfChain, checkElseIfChain);
	runCheck("duplicate_switch_discriminant", r.duplicateSwitchDiscriminant, checkDuplicateSwitchDiscriminant);
	runCheck("hybrid_class", r.hybridClass, checkHybridClass);
	runCheck("fuzzy_responsibility_name", r.fuzzyResponsibilityName, checkFuzzyResponsibilityName);
	runCheck("law_of_demeter", r.lawOfDemeter, checkLawOfDemeter);
	runCheck("flag_argument", r.flagArgument, checkFlagArgument);
	runCheck("commented_out_code", r.commentedOutCode, checkCommentedOutCode);
	runCheck("conditional_in_test", r.conditionalInTest, checkConditionalInTest);
	runCheck("non_deterministic_test", r.nonDeterministicTest, checkNonDeterministicTest);
	runCheck("timing_flake", r.timingFlake, checkTimingFlake);
	runCheck("empty_catch", r.emptyCatch, checkEmptyCatch);
	runCheck("test_without_description", r.testWithoutDescription, checkTestWithoutDescription);
	runCheck("assertion_roulette", r.assertionRoulette, checkAssertionRoulette);
	runCheck("magic_number", r.magicNumber, checkMagicNumber);
	runCheck("function_arg_count", r.functionArgCount, checkFunctionArgCount);
	runCheck("data_clump", r.dataClump, checkDataClump);
	runCheck("duplicate_describe", r.duplicateDescribe, checkDuplicateDescribe);
}
