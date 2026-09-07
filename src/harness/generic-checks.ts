// ===========================================
// Generic Checks — Language-agnostic and language-specific inline analysis
// ===========================================
// Pure functions that analyze file content (<1ms each for inline checks).
// Each check returns matches (line number + text) or a boolean verdict.
// Dependencies: Node.js stdlib only (fs, path, child_process for cross-file checks).
//
// As of 2026-04, implementation lives in the `./checks/` sub-package. This
// module is kept as a thin named-export barrel so existing importers, the
// harness impact-analyzer, and docs generators keep working. New code
// should import from `./checks/<family>.js` directly.

// ---- agent-laziness (Batch 1) ----
export {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkDoubleCastUnknown,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkNodeEnvBranchInProd,
	checkStubNotImplementedThrow,
	checkSyncIoOnHotPath,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
	checkUntestableTimeInSource,
} from "./checks/agent-laziness.js";
// ---- agent-safety ----
export {
	checkAesEcbMode,
	checkAsyncPromiseExecutor,
	checkBroadObjectTypes,
	checkConstantCondition,
	checkEvalUsage,
	checkExtraneousDependencies,
	checkFloatingPromises,
	checkInnerHtmlUsage,
	checkJsLooseEquality,
	checkMagicLiteralInConditional,
	checkMisusedPromises,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkPhantomDependencies,
	checkRecursiveWalkerLstat,
	checkSelfImport,
	checkSilentPromiseSwallow,
	checkTlsVerifyDisabled,
	checkUnsafeOptionalChaining,
	checkWeakHash,
	checkWeakRandom,
} from "./checks/agent-safety.js";
// ---- agent-safety-advanced ----
export {
	checkAccumulatingSpread,
	checkCircularImports,
	checkDeadExports,
	checkDefaultExport,
	checkLifecycleCleanup,
	checkManualFieldCopy,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkThrowLiteral,
	checkUnvalidatedJsonBoundary,
} from "./checks/agent-safety-advanced.js";
// ---- archive-extract ----
export { checkArchiveExtractTraversal } from "./checks/archive-extract.js";
// ---- assert-side-effects (tautology + the C/Python/Java assert-erasure
//      siblings of ubs_rust_debug_assert_side_effect) ----
export {
	checkCAssertSideEffects,
	checkJavaAssertSideEffects,
	checkPythonAssertSideEffects,
	checkPythonAssertTautology,
} from "./checks/assert-side-effects.js";
// ---- b-series ----
export {
	checkAssertionFreeTests,
	checkFloatEquality,
	checkHardcodedCredentials,
	checkInfiniteRecursion,
	checkParseIntRadix,
	checkSilentCatch,
	checkSuppressionDensity,
	checkSyncIoInAsync,
	checkTrivialAssertions,
	checkUnreachableCode,
} from "./checks/b-series.js";
// ---- c-cpp ----
export {
	checkCIncludeGuard,
	checkCSprintfUsage,
	checkCStrcmpBooleanMisuse,
	checkCUncheckedMalloc,
	checkCUnsafeFunctions,
} from "./checks/c-cpp.js";
// ---- cleanup-early-exit ----
export { checkCleanupSkippedOnEarlyExit } from "./checks/cleanup-early-exit.js";
// ---- comment-drift (Mythos Phase 2) ----
export {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
} from "./checks/comment-drift.js";
// ---- sql-migrations (real implementations; stubs until 2026-08-09) ----
export {
	checkMigrationOrdering,
	checkSqlSchemaConsistency,
	checkVisibilityFilterMissing,
} from "./checks/sql-migrations.js";
// ---- complexity ----
export { checkFunctionComplexity } from "./checks/complexity.js";
// ---- cross-file (Batch 5) ----
export {
	checkEmptyBodyHandler,
	checkListenerPairing,
	checkMigrationParity,
	checkSchemaTypeDrift,
} from "./checks/cross-file.js";
// ---- cross-language ----
export { checkSqlInjection } from "./checks/cross-language.js";
// ---- deletion-hygiene ----
export {
	checkDeletionComments,
	checkDeprecationNotice,
	checkEmptyFunctionBody,
	checkNotImplementedStubs,
	checkOrphanedTestStub,
} from "./checks/deletion-hygiene.js";
// ---- demo-data (Batch 8) ----
export {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkPlaceholderDataInUi,
	checkSilentDemoFallback,
} from "./checks/demo-data.js";
// ---- dry (Jaccard code-clone detector) ----
export { checkCodeClones } from "./checks/dry-check.js";
// ---- error-handling ----
export {
	checkBareCatchBlock,
	checkCatchReturnNull,
	checkErrorDispatchByInstanceof,
	checkErrorStringComparison,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
	checkThrowAsControlFlow,
	checkUntypedCatch,
} from "./checks/error-handling.js";
// ---- exhaustiveness ----
export { checkDiscriminatedUnionExhaustiveness } from "./checks/exhaustiveness.js";
// ---- export-ripple ----
export {
	checkExportRipple,
	getGitSourceFiles,
} from "./checks/export-ripple.js";
// ---- flow-safety ----
export {
	checkAwaitStateToctou,
	checkBoundaryCopyNoRevalidation,
	checkCleanupReentrancy,
} from "./checks/flow-safety.js";
// ---- focused-tests ----
export { checkFocusedTests } from "./checks/focused-tests.js";
// ---- github-actions (workflow-injection detector) ----
export { checkGithubActionsInjection } from "./checks/github-actions.js";
// ---- imports (own-barrel re-import, Effect-TS port) ----
export { checkImportFromOwnBarrel } from "./checks/imports.js";
// ---- index-as-key ----
export { checkIndexAsKey } from "./checks/index-as-key.js";
// ---- index-bounds ----
export { checkIndexBoundsUnchecked } from "./checks/index-bounds.js";
// ---- introverted-test (assertion → SUT provenance, 2026-06) ----
export { checkIntrovertedTest } from "./checks/introverted-test.js";
// ---- test-discrimination + test-isolation (coverage-campaign corpus, 2026-09-06) ----
export { checkCatchWithoutAssertionGuard } from "./checks/test-discrimination-catch.js";
export { checkFallbackOnlyAssertion } from "./checks/test-discrimination-fallback.js";
export { checkDuplicateExpectedLiteralPosNeg } from "./checks/test-discrimination-posneg.js";
export { checkSpyCallUnpinnedArgs } from "./checks/test-discrimination-spy.js";
export { checkDuplicateThrowMessageAssertion } from "./checks/test-discrimination-throw.js";
export { checkWildcardInObservable } from "./checks/test-discrimination-wildcard.js";
export { checkInTreeTempFixture } from "./checks/test-isolation-fixture-dir.js";
export { checkFixedPortInTest } from "./checks/test-isolation-port.js";
// ---- test-discrimination round 2 (prototyped on the tree, 2026-09-07) ----
export { checkDuplicateTestBody } from "./checks/test-duplicate-body.js";
export { checkSpyWithoutRestore } from "./checks/test-spy-without-restore.js";
export { checkExportExistenceSmokeTest } from "./checks/test-export-existence.js";
export { checkCommentedOutAssertion } from "./checks/test-commented-assertion.js";
export { checkMockReturnEcho } from "./checks/test-mock-return-echo.js";
export { checkVacuousLoopAssertion } from "./checks/test-vacuous-loop.js";
// ---- iteration-safety ----
export {
	checkFreshCollectionKeyLookup,
	checkIteratorInvalidation,
} from "./checks/iteration-safety.js";
// ---- js-ts-general ----
export {
	checkCatchAndLog,
	checkDisabledTests,
	checkHardcodedTimeout,
	checkJsonParseUnsafe,
	checkNestedTernaries,
	checkTargetBlankNoRel,
} from "./checks/js-ts-general.js";
// ---- language-agnostic ----
export {
	checkBinaryContent,
	checkConsoleDebug,
	checkEmptyFile,
} from "./checks/language-agnostic.js";
// ---- markdown ----
export { checkPlaceholderMarkdownLinks } from "./checks/markdown.js";
// ---- missing-effect-cleanup ----
export { checkMissingEffectCleanup } from "./checks/missing-effect-cleanup.js";
// ---- over-mocking ----
export { checkOverMocking } from "./checks/over-mocking.js";
// ---- package-json ----
export {
	checkPackageJsonPublishInvariants,
	checkPackageJsonPublishInvariantsWithPublint,
	checkPackageJsonScriptPaths,
} from "./checks/package-json.js";
// ---- performance ----
export {
	checkArrayFromMap,
	checkAwaitInLoop,
	checkCloneInLoop,
	checkCollectThenIterate,
	checkDoubleTypeCast,
	checkFilterLength,
	checkJsonClonePattern,
	checkJsonInLoop,
	checkLenListGenerator,
	checkMallocInLoop,
	checkMathSpread,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSpreadInReduce,
	checkSprintfInLoop,
	checkStringConcatInLoop,
	checkStrlenInLoopCondition,
} from "./checks/performance.js";
export type { PiiPattern } from "./checks/pii.js";
// ---- pii ----
export {
	checkMixedErrorStrategy,
	checkPiiInSource,
} from "./checks/pii.js";
// ---- placeholder-constants (confessed stand-in numeric constants) ----
export { checkPlaceholderRuntimeConstant } from "./checks/placeholder-constants.js";
// ---- placeholder-tests ----
export { checkPlaceholderTests } from "./checks/placeholder-tests.js";
export type { ProjectSetupIssue } from "./checks/project-setup.js";
// ---- project-setup ----
export { checkProjectSetup } from "./checks/project-setup.js";
// ---- property-testing ----
export { checkUntestedIdempotent, checkUntestedInversePair } from "./checks/property-testing.js";
// ---- react ----
export {
	checkAsyncEventHandler,
	checkDangerouslySetInnerHTML,
	checkDirectDomAccess,
	checkExcessiveUseState,
	checkInlineObjectProps,
} from "./checks/react.js";
// ---- redos (catastrophic-backtracking) ----
export { checkRedosCatastrophic } from "./checks/redos-catastrophic.js";
// ---- reinterpret-alignment (Bun #31188 class: byte buffer cast to wider type) ----
export {
	checkRustUncheckedCastSlice,
	checkUnalignedReinterpret,
} from "./checks/reinterpret-alignment.js";
// ---- return-types ----
export { checkMissingReturnTypes } from "./checks/return-types.js";
// ---- sequential-awaits ----
export { checkRustTestDeterminism } from "./checks/rust-test-determinism.js";
export { checkSequentialAwaits } from "./checks/sequential-awaits.js";
// ---- shared helpers ----
export type { InlineMatch } from "./checks/shared.js";
export {
	getExtension,
	isCliFile,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./checks/shared.js";
// ---- supply-chain ----
export {
	checkErrorMessageLeakage,
	checkHardcodedLocalhost,
	checkImportFromDist,
	checkInfiniteRetryLoop,
	checkPlaceholderValues,
	checkProcessExitInLibrary,
	checkTyposquatDependencies,
} from "./checks/supply-chain.js";
// ---- swift ----
export {
	checkSwiftAbbreviations,
	checkSwiftDelegateNotWeak,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftImplicitlyUnwrappedOptional,
	checkSwiftLegacyHashValue,
	checkSwiftLegacyRandom,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
	checkTestRegressions,
	extractEnvReferences,
	extractMockDefinitions,
	extractModuleExportNames,
	parseEnvDocumentation,
} from "./checks/swift.js";
// ---- tainted-sink ----
export { checkTaintedToPrivilegedSink } from "./checks/tainted-sink.js";
// ---- taste ----
export {
	checkBooleanTrap,
	checkCatchAndIgnore,
	checkFunctionArity,
	checkGodFile,
	checkManyOptionalParams,
	checkNarrativeNaming,
	checkPositionalOptionalBoolean,
	checkTestDescriptionQuality,
} from "./checks/taste.js";
// ---- taste-smell ----
export {
	checkCommentedOutCode,
	checkFlagArguments,
	checkMagicNumbers,
	checkNegatedConditionWithElse,
	checkNestedTernary,
	checkSameTypedPrimitiveParams,
} from "./checks/taste-smell.js";
// ---- test-file-exists ----
export { checkTestFileExists } from "./checks/test-file-exists.js";
// ---- test-hygiene (Batch 2) ----
export {
	checkDuplicateTestNames,
	checkHappyPathOnlyTest,
	checkHardcodedTimeoutInTests,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkRealIoInTests,
	checkTestMissingSutImport,
	checkTestLegitimacy,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "./checks/test-hygiene.js";
// ---- test-portability (env-divergent tests, finding 2026-06) ----
export {
	checkPlatformConditionalAssertion,
	checkSilentDependencySkip,
} from "./checks/test-portability.js";
// ---- testing ----
export {
	checkExcessiveUseEffect,
	checkSnapshotOveruse,
	checkTestImportingTest,
} from "./checks/testing.js";
// ---- tsconfig-strictness ----
export { checkTsconfigStrictness } from "./checks/tsconfig-strictness.js";
// ---- type-smuggling ----
export { checkTypeSmuggling } from "./checks/type-smuggling.js";
// ---- ubs-language-specific (Plan 04 rows 22, 23, 25, 29, 30 + D.1 backlog) ----
export {
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkDeeplyNestedCallback,
	checkDeferInLoop,
	checkDivisionByVariable,
	checkDocumentWrite,
	checkEvalInputTainted,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkInsertAdjacentHtml,
	checkJavaOptionalGet,
	checkLargeFunction,
	checkLoggerFormatUserInput,
	checkMagicNumberNoConst,
	checkMarshalLoad,
	checkMixedSyncAsyncFileApi,
	checkMutexLockUnwrap,
	checkNaiveDatetime,
	checkNodeCreateCipher,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkOuterHtmlAssignment,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPrintDebugLeak,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkRegexInLoopNoCompile,
	checkRustDebugAssertSideEffects,
	checkScriptWithoutSri,
	checkShelveOpen,
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTimeFormatLocaleDep,
	checkTorchUnsafeLoad,
	checkUbsHardcodedLocalhost,
	checkUbsStringConcatInLoop,
	checkUncheckedRedirect,
	checkUnsafeFormatString,
	checkXmlExternalEntity,
	checkYamlUnsafeLoad,
} from "./checks/ubs-language-specific.js";
// ---- unsafe-span (escape-hatch SCOPE: wide unsafe{} / eslint-disable regions) ----
export {
	checkRustUnsafeSpan,
	checkSuppressionSpan,
} from "./checks/unsafe-span.js";
