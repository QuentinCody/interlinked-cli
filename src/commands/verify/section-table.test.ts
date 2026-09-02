// ===========================================
// section-table unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { SECTIONS } from "./section-table.js";
import { agentSafetySections } from "./section-table-agent-safety.js";
import { batchSections } from "./section-table-batches.js";
import { coreSections } from "./section-table-core.js";
import { ubsSections } from "./section-table-ubs.js";

// Golden ordered key list — pins the exact composition order and length of
// the SECTIONS table. `streaming-output.ts` and the verify skip-id pipeline
// depend on this order, so any reordering / add / remove must show in a diff
// here. Keep in lockstep with the fragment files.
const EXPECTED_KEY_ORDER = [
	// coreSections
	"jsonValidity",
	"phantomImports",
	"exportRipple",
	"deadExports",
	"deadTypeExports",
	"duplicateTypeDeclaration",
	"newExportWithoutImporter",
	"extractedHelperDuplicate",
	"circularImports",
	"untestedInversePair",
	"untestedIdempotent",
	"lifecycleCleanup",
	"defaultExport",
	"codeClones",
	"largeFiles",
	"untestedFiles",
	"strongTyping",
	"suppressions",
	"consoleStatements",
	"silentCatches",
	"testRegressions",
	"missingReturnTypes",
	"mockDrift",
	"incompleteRenames",
	"noTestFile",
	"complexity",
	"crap",
	// agentSafetySections
	"misusedPromises",
	"floatingPromises",
	"broadObjectTypes",
	"booleanTrap",
	"positionalOptionalBoolean",
	"manyOptionalParams",
	"sameTypedPrimitiveParams",
	"commentClaimsLimitNoGuard",
	"commentClaimsNullThrowsInstead",
	"commentClaimsValidationMissing",
	"commentClaimsIdempotentMutates",
	"commentClaimsThrowsDoesnt",
	"designSlop",
	"iteratorInvalidation",
	"freshCollectionKeyLookup",
	"discriminatedUnionExhaustiveness",
	"indexBoundsUnchecked",
	"cleanupSkippedOnEarlyExit",
	"taintedToPrivilegedSink",
	"awaitStateToctou",
	"cleanupReentrancy",
	"boundaryCopyNoRevalidation",
	"magicLiteralInConditional",
	"nanCoercionGuard",
	"unawaitedAsyncAssertion",
	"arrayPushReturnUsed",
	"arrayIterateeVariadicBuiltin",
	"writeWithoutMkdir",
	"homedirWriteEscape",
	"duplicatedPolicyConstant",
	"typePredicateDrift",
	"snapshotHygiene",
	"anonymousRegistration",
	"payloadFieldCasing",
	"gitignoredWrittenConfig",
	"halsteadDifficulty",
	"propertyTestCandidate",
	"readmeScriptDrift",
	"specPathRef",
	"placeholderRuntimeConstant",
	"rustUnsafeSpan",
	"suppressionBlockSpan",
	"asyncPromiseExecutor",
	"selfImports",
	"extraneousDeps",
	"evalUsage",
	"innerHtml",
	"nanComparison",
	"constantCondition",
	"unsafeOptionalChaining",
	"numberPrecisionLoss",
	"nonNullAssertions",
	"throwLiteral",
	"promiseRejectNonError",
	"rawControlBytes",
	"lossyErrorRethrow",
	"importFromOwnBarrel",
	"errorDispatchByInstanceof",
	"silentPromiseSwallow",
	"requireAwait",
	"accumulatingSpread",
	"manualFieldCopy",
	"excessiveUseState",
	"dangerouslySetInnerHtml",
	"directDomAccess",
	"inlineObjectProps",
	"asyncEventHandler",
	"nestedTernaries",
	"catchAndLog",
	"jsonParseUnsafe",
	"unvalidatedJsonBoundary",
	"hardcodedTimeout",
	"disabledTests",
	"placeholderTest",
	"suppressionHygiene",
	"targetBlankNoRel",
	"snapshotOveruse",
	"testImportingTest",
	"excessiveUseEffect",
	"sequentialAwaits",
	"indexAsKey",
	"missingEffectCleanup",
	"overMocking",
	"focusedTests",
	"migrationOrdering",
	"sqlSchemaConsistency",
	"visibilityFilterMissing",
	"piiDetection",
	"assertionFreeTest",
	"tautologicalAssertion",
	"mockingTheSut",
	"privateMemberTestAccess",
	"loopNestingDepth",
	"elseIfChain",
	"duplicateSwitchDiscriminant",
	"hybridClass",
	"fuzzyResponsibilityName",
	"lawOfDemeter",
	"flagArgument",
	"commentedOutCode",
	"conditionalInTest",
	"nonDeterministicTest",
	"timingFlake",
	"emptyCatch",
	"testWithoutDescription",
	"assertionRoulette",
	"magicNumber",
	"functionArgCount",
	"dataClump",
	"duplicateDescribe",
	"crossFileSwitchDiscriminant",
	"singleImplementationInterface",
	"filesWithoutTest",
	"projectLocRatio",
	// ubsSections
	"jsLooseEquality",
	"floatEquality",
	"javaOptionalGet",
	"rustDebugAssertSideEffect",
	"cAssertSideEffect",
	"pythonAssertSideEffect",
	"javaAssertSideEffect",
	"rustUncheckedCastSlice",
	"unalignedReinterpret",
	"divisionByVariable",
	"mutexLockUnwrap",
	"subprocessShellTrue",
	"tlsVerifyDisabled",
	"pyNoneEquality",
	"weakHash",
	"weakRandom",
	"evalInputTainted",
	"sqlStringConcat",
	"sqlEscapeHatchNonLiteral",
	"pyMutableDefaultArg",
	"tempfileMktempRace",
	"pickleUntrustedLoad",
	"xmlExternalEntity",
	"osSystemTainted",
	"unsafeFormatString",
	"uncheckedRedirect",
	"goroutineNoWaitgroup",
	"deferInLoop",
	"ubsStringConcatInLoop",
	"numericComparisonChain",
	"printDebugLeak",
	"ubsHardcodedLocalhost",
	"childProcessExecUserInput",
	"mixedSyncAsyncFileApi",
	"cookieMissingSecurityFlags",
	"loggerFormatUserInput",
	"magicNumberNoConst",
	"largeFunction",
	"deeplyNestedCallback",
	"timeFormatLocaleDep",
	"regexInLoopNoCompile",
	"marshalLoad",
	"shelveOpen",
	"yamlUnsafeLoad",
	"torchUnsafeLoad",
	"pickleWrapperLoad",
	"aesEcbMode",
	"nodeCreateCipher",
	"scriptWithoutSri",
	"goShellInjection",
	"githubActionsInjection",
	"documentWrite",
	"outerHtmlAssignment",
	"insertAdjacentHtml",
	"identicalConditionalBranches",
	// batchSections
	"agentThumbprintProse",
	"stubNotImplementedThrow",
	"deadBranchLiteral",
	"fileLevelSuppression",
	"untestableTimeInSource",
	"doubleCastUnknown",
	"typeSmuggling",
	"unionWidenedWithString",
	"nodeenvBranchInProd",
	"fetchWithoutTimeout",
	"unboundedPromiseAll",
	"syncIoOnHotPath",
	"duplicateTestNames",
	"realIoInTests",
	"testNondeterminism",
	"hardcodedTimeoutInTests",
	"testMissingSutImport",
	"mockingTheSutSelf",
	"testSubprocessDefaultTimeout",
	"mockOnlyTest",
	"happyPathOnlyTest",
	"introvertedTest",
	"testLegitimacy",
	"procfsProbeInTest",
	"emptyBodyHandler",
	"listenerPairing",
	"schemaTypeDrift",
	"migrationParity",
	"demoDataUnmarked",
	"silentDemoFallback",
	"demoRuntimeMissingBanner",
	"placeholderDataInUi",
	"tsconfigStrictness",
	"endpointAuthMissing",
	"endpointIdorShape",
	"endpointMissingTenantFilter",
	"endpointSsrfShape",
	"endpointMassAssignment",
] as const;

describe("SECTIONS", () => {
	it("is non-empty", () => {
		expect(SECTIONS.length).toBeGreaterThan(0);
	});

	it("composes the fragments in order without dropping or reordering entries", () => {
		// Length is the sum of the fragments — no entry lost or duplicated.
		expect(SECTIONS.length).toBe(
			coreSections.length +
				agentSafetySections.length +
				ubsSections.length +
				batchSections.length,
		);
		// Exact key order is pinned to the golden list.
		expect(SECTIONS.map((s) => s.key)).toEqual([...EXPECTED_KEY_ORDER]);
		// Composition equals concatenation of the four fragments, in order.
		expect(SECTIONS).toEqual([
			...coreSections,
			...agentSafetySections,
			...ubsSections,
			...batchSections,
		]);
	});

	it("each entry has required fields", () => {
		for (const spec of SECTIONS) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(typeof spec.color).toBe("string");
		}
	});

	it("labels are unique", () => {
		const labels = SECTIONS.map((s) => s.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("colors use ANSI severity codes (31=red or 33=yellow)", () => {
		for (const spec of SECTIONS) {
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("pins explicit skip ids for labels that do not normalize to check ids", () => {
		const byKey = new Map(SECTIONS.map((spec) => [spec.key, spec]));
		expect(byKey.get("mockOnlyTest")?.skipId).toBe("mock_only_test");
		expect(byKey.get("happyPathOnlyTest")?.skipId).toBe("happy_path_only_test");
	});
});
