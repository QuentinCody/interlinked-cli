// ===========================================
// JSON output formatter
// ===========================================
// Single entry point `outputJson` writes a consolidated JSON object to stdout.
// Structure is load-bearing — downstream tooling (CI, parity tests, test
// fixtures) reads the top-level keys. When adding a new check, append a new
// key here AND in `streaming-output.ts`.

import type { ProjectSetupIssue } from "../../harness/generic-checks.js";
import type {
	DecisionSurfaceReport,
	LockfileMultiplicityResult,
} from "../../harness/quality-checks/decision-surface.js";
import type { DecisionSurfaceRatchetResult } from "../../harness/quality-checks/decision-surface-ratchet.js";
import type { RegistryDriftFinding } from "../../harness/registry-parity.js";
import type { Finding } from "../../harness/suggestion-scorer.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { RulesFingerprint } from "../../lib/rules-fingerprint.js";
import { summarizeTestQualitySections } from "./output-json-test-quality.js";
import type { AuditResult, CodeQualityResults, DiagnosticResult } from "./tool-results-types.js";
import type { CatalogueResult } from "./catalogue-types.js";
import { verifyActions } from "./action-projection.js";
import type { CheckReport, ToolInputScope } from "../../harness/check-engine/types.js";
import type { VerifyCheckTiming } from "./check-timing.js";
import { summarizeNotMeasured, summarizeSetAside, type ScanLedger } from "./scan-ledger.js";
import type { NotRunContext, NotRunEntry } from "./not-run.js";
import { addPlacementSections } from "./output-json-placement.js";

/**
 * Shape tag for the `verify --json` object. Bump when a top-level key changes
 * meaning or disappears; adding a key is backward-compatible and keeps it.
 */
export const VERIFY_JSON_SCHEMA = "interlinked.verify/1";

/** Row shape we care about for section summarization. */
interface FileKeyedRow {
	file: string;
}

/** Compact a list into the summary shape (issues count + sorted unique files). */
function summarize(list: readonly FileKeyedRow[]): JsonObject {
	return {
		issues: list.length,
		files: [...new Set(list.map((r) => r.file))].sort(),
	};
}

/** Same as summarize, but includes the raw details array. */
function summarizeWithDetails(list: readonly FileKeyedRow[]): JsonObject {
	return {
		...summarize(list),
		details: list,
	};
}

type ReportSection = readonly [key: string, bucket: keyof CodeQualityResults, render: typeof summarize];

const CORE_SECTIONS = [
	["strong_typing", "strongTyping", summarizeWithDetails],
	["suppressions", "suppressions", summarizeWithDetails],
	["large_files", "largeFiles", summarizeWithDetails],
	["untested_files", "untestedFiles", summarizeWithDetails],
	["commander_option_attribute", "commanderOptionAttribute", summarizeWithDetails],
	["omitted_private_parameter", "omittedPrivateParameter", summarizeWithDetails],
	["expression_size", "expressionSize", summarizeWithDetails],
	["inline_callback_count", "inlineCallbackCount", summarizeWithDetails],
	["control_flow_depth", "controlFlowDepth", summarizeWithDetails],
	["expression_measurement", "expressionMeasurement", summarizeWithDetails],
	["required_braces", "requiredBraces", summarizeWithDetails],
	["statements_per_line", "statementsPerLine", summarizeWithDetails],
	["json_validity", "jsonValidity", summarizeWithDetails],
	["html_duplicate_id", "htmlDuplicateId", summarizeWithDetails],
	["python_simplification", "pythonSimplification", summarizeWithDetails],
	["repeated_implementation", "repeatedImplementation", summarizeWithDetails],
	["phantom_imports", "phantomImports", summarizeWithDetails],
	["console_statements", "consoleStatements", summarize],
	["silent_catches", "silentCatches", summarize],
	["test_regressions", "testRegressions", summarize],
	["undocumented_env_vars", "undocumentedEnvVars", summarize],
	["mock_drift", "mockDrift", summarize],
	["incomplete_renames", "incompleteRenames", summarize],
	["missing_return_types", "missingReturnTypes", summarize],
	["no_test_file", "noTestFile", summarize],
	["complexity", "complexity", summarize],
	["code_clones", "codeClones", summarizeWithDetails],
	["crap", "crap", summarizeWithDetails],
	["export_ripple", "exportRipple", summarize],
	["excessive_use_state", "excessiveUseState", summarize],
	["dangerously_set_inner_html", "dangerouslySetInnerHtml", summarize],
	["direct_dom_access", "directDomAccess", summarize],
	["inline_object_props", "inlineObjectProps", summarize],
	["async_event_handler", "asyncEventHandler", summarize],
	["nested_ternaries", "nestedTernaries", summarize],
	["catch_and_log", "catchAndLog", summarize],
	["json_parse_unsafe", "jsonParseUnsafe", summarize],
	["hardcoded_timeout", "hardcodedTimeout", summarize],
	["disabled_tests", "disabledTests", summarize],
	["placeholder_test", "placeholderTest", summarizeWithDetails],
	["suppression_hygiene", "suppressionHygiene", summarizeWithDetails],
	["target_blank_no_rel", "targetBlankNoRel", summarize],
	["snapshot_overuse", "snapshotOveruse", summarize],
	["test_importing_test", "testImportingTest", summarize],
	["excessive_use_effect", "excessiveUseEffect", summarize],
	["sequential_awaits", "sequentialAwaits", summarize],
	["index_as_key", "indexAsKey", summarize],
	["missing_effect_cleanup", "missingEffectCleanup", summarize],
	["over_mocking", "overMocking", summarize],
	["focused_tests", "focusedTests", summarizeWithDetails],
	["migration_ordering", "migrationOrdering", summarizeWithDetails],
	["sql_schema_consistency", "sqlSchemaConsistency", summarizeWithDetails],
	["visibility_filter_missing", "visibilityFilterMissing", summarizeWithDetails],
	["pii_detection", "piiDetection", summarizeWithDetails],
	["assertion_free_test", "assertionFreeTest", summarizeWithDetails],
	["tautological_assertion", "tautologicalAssertion", summarizeWithDetails],
	["mocking_the_sut", "mockingTheSut", summarizeWithDetails],
	["private_member_test_access", "privateMemberTestAccess", summarizeWithDetails],
	["loop_nesting_depth", "loopNestingDepth", summarizeWithDetails],
	["else_if_chain", "elseIfChain", summarizeWithDetails],
	["duplicate_switch_discriminant", "duplicateSwitchDiscriminant", summarizeWithDetails],
	["hybrid_class", "hybridClass", summarizeWithDetails],
	["fuzzy_responsibility_name", "fuzzyResponsibilityName", summarizeWithDetails],
	["law_of_demeter", "lawOfDemeter", summarizeWithDetails],
	["flag_argument", "flagArgument", summarizeWithDetails],
	["commented_out_code", "commentedOutCode", summarizeWithDetails],
	["conditional_in_test", "conditionalInTest", summarizeWithDetails],
	["non_deterministic_test", "nonDeterministicTest", summarizeWithDetails],
	["timing_flake", "timingFlake", summarizeWithDetails],
	["empty_catch", "emptyCatch", summarizeWithDetails],
	["test_without_description", "testWithoutDescription", summarizeWithDetails],
	["assertion_roulette", "assertionRoulette", summarizeWithDetails],
	["magic_number", "magicNumber", summarizeWithDetails],
	["function_arg_count", "functionArgCount", summarizeWithDetails],
	["data_clump", "dataClump", summarizeWithDetails],
	["duplicate_describe", "duplicateDescribe", summarizeWithDetails],
	["cross_file_switch_discriminant", "crossFileSwitchDiscriminant", summarizeWithDetails],
	["single_implementation_interface", "singleImplementationInterface", summarizeWithDetails],
	["files_without_test", "filesWithoutTest", summarizeWithDetails],
] as const satisfies readonly ReportSection[];

const DIAGNOSTIC_SECTIONS = [
	["ubs_js_loose_equality", "jsLooseEquality", summarizeWithDetails],
	["ubs_float_equality", "floatEquality", summarizeWithDetails],
	["ubs_java_optional_get", "javaOptionalGet", summarizeWithDetails],
	["ubs_rust_debug_assert_side_effect", "rustDebugAssertSideEffect", summarizeWithDetails],
	["ubs_c_assert_side_effect", "cAssertSideEffect", summarizeWithDetails],
	["ubs_python_assert_side_effect", "pythonAssertSideEffect", summarizeWithDetails],
	["ubs_java_assert_side_effect", "javaAssertSideEffect", summarizeWithDetails],
	["ubs_rust_unchecked_cast_slice", "rustUncheckedCastSlice", summarizeWithDetails],
	["unaligned_reinterpret", "unalignedReinterpret", summarizeWithDetails],
	["ubs_division_by_variable", "divisionByVariable", summarizeWithDetails],
	["ubs_mutex_lock_unwrap", "mutexLockUnwrap", summarizeWithDetails],
	["ubs_subprocess_shell_true", "subprocessShellTrue", summarizeWithDetails],
	["ubs_tls_verify_disabled", "tlsVerifyDisabled", summarizeWithDetails],
	["ubs_py_none_equality", "pyNoneEquality", summarizeWithDetails],
	["ubs_weak_hash", "weakHash", summarizeWithDetails],
	["ubs_weak_random_security", "weakRandom", summarizeWithDetails],
	["ubs_eval_input_tainted", "evalInputTainted", summarizeWithDetails],
	["ubs_sql_string_concat", "sqlStringConcat", summarizeWithDetails],
	["sql_escape_hatch_non_literal", "sqlEscapeHatchNonLiteral", summarizeWithDetails],
	["ubs_python_mutable_default_arg", "pyMutableDefaultArg", summarizeWithDetails],
	["ubs_tempfile_mktemp_race", "tempfileMktempRace", summarizeWithDetails],
	["ubs_pickle_untrusted_load", "pickleUntrustedLoad", summarizeWithDetails],
	["ubs_xml_external_entity", "xmlExternalEntity", summarizeWithDetails],
	["ubs_os_system_tainted", "osSystemTainted", summarizeWithDetails],
	["ubs_unsafe_format_string", "unsafeFormatString", summarizeWithDetails],
	["ubs_unchecked_redirect", "uncheckedRedirect", summarizeWithDetails],
	["ubs_goroutine_no_waitgroup", "goroutineNoWaitgroup", summarizeWithDetails],
	["ubs_defer_in_loop", "deferInLoop", summarizeWithDetails],
	["ubs_string_concat_in_loop", "ubsStringConcatInLoop", summarizeWithDetails],
	["ubs_numeric_comparison_chain", "numericComparisonChain", summarizeWithDetails],
	["ubs_print_debug_leak", "printDebugLeak", summarizeWithDetails],
	["ubs_hardcoded_localhost", "ubsHardcodedLocalhost", summarizeWithDetails],
	["raw_control_bytes", "rawControlBytes", summarizeWithDetails],
	["lossy_error_rethrow", "lossyErrorRethrow", summarizeWithDetails],
	["json_stringify_error", "jsonStringifyError", summarizeWithDetails],
	["catch_rewrap_loses_cause", "catchRewrapLosesCause", summarizeWithDetails],
	["resource_handle_leak", "resourceHandleLeak", summarizeWithDetails],
	["public_api_leaks_internal_type", "publicApiLeaksInternalType", summarizeWithDetails],
	["jsdoc_param_drift", "jsdocParamDrift", summarizeWithDetails],
	["unvalidated_input_boundary", "unvalidatedInputBoundary", summarizeWithDetails],
	["numeric_zero_default", "numericZeroDefault", summarizeWithDetails],
	["import_from_own_barrel", "importFromOwnBarrel", summarizeWithDetails],
	["error_dispatch_by_instanceof", "errorDispatchByInstanceof", summarizeWithDetails],
	["silent_promise_catch", "silentPromiseSwallow", summarizeWithDetails],
	["child_process_exec_user_input", "childProcessExecUserInput", summarizeWithDetails],
	["mixed_sync_async_file_api", "mixedSyncAsyncFileApi", summarizeWithDetails],
	["cookie_missing_security_flags", "cookieMissingSecurityFlags", summarizeWithDetails],
	["logger_format_user_input", "loggerFormatUserInput", summarizeWithDetails],
	["ubs_magic_number_no_const", "magicNumberNoConst", summarizeWithDetails],
	["ubs_large_function", "largeFunction", summarizeWithDetails],
	["ubs_deeply_nested_callback", "deeplyNestedCallback", summarizeWithDetails],
	["ubs_time_format_locale_dep", "timeFormatLocaleDep", summarizeWithDetails],
	["ubs_regex_in_loop_no_compile", "regexInLoopNoCompile", summarizeWithDetails],
	["agent_thumbprint_prose", "agentThumbprintProse", summarizeWithDetails],
	["stub_not_implemented_throw", "stubNotImplementedThrow", summarizeWithDetails],
	["dead_branch_literal", "deadBranchLiteral", summarizeWithDetails],
	["file_level_suppression", "fileLevelSuppression", summarizeWithDetails],
	["untestable_time_in_source", "untestableTimeInSource", summarizeWithDetails],
	["double_cast_unknown", "doubleCastUnknown", summarizeWithDetails],
	["type_smuggling", "typeSmuggling", summarizeWithDetails],
	["union_widened_with_string", "unionWidenedWithString", summarizeWithDetails],
	["nodeenv_branch_in_prod", "nodeenvBranchInProd", summarizeWithDetails],
	["fetch_without_timeout", "fetchWithoutTimeout", summarizeWithDetails],
	["unbounded_promise_all", "unboundedPromiseAll", summarizeWithDetails],
	["sync_io_on_hot_path", "syncIoOnHotPath", summarizeWithDetails],
	["placeholder_runtime_constant", "placeholderRuntimeConstant", summarizeWithDetails],
	["rust_unsafe_span", "rustUnsafeSpan", summarizeWithDetails],
	["suppression_block_span", "suppressionBlockSpan", summarizeWithDetails],
	["duplicate_test_names", "duplicateTestNames", summarizeWithDetails],
	["real_io_in_tests", "realIoInTests", summarizeWithDetails],
	["test_nondeterminism", "testNondeterminism", summarizeWithDetails],
	["hardcoded_timeout_in_tests", "hardcodedTimeoutInTests", summarizeWithDetails],
	["test_missing_sut_import", "testMissingSutImport", summarizeWithDetails],
	["mocking_the_sut_self", "mockingTheSutSelf", summarizeWithDetails],
	["test_subprocess_default_timeout", "testSubprocessDefaultTimeout", summarizeWithDetails],
] as const satisfies readonly ReportSection[];

const CROSS_FILE_SECTIONS = [
	["empty_body_handler", "emptyBodyHandler", summarizeWithDetails],
	["listener_pairing", "listenerPairing", summarizeWithDetails],
	["schema_type_drift", "schemaTypeDrift", summarizeWithDetails],
	["migration_parity", "migrationParity", summarizeWithDetails],
	["demo_data_unmarked", "demoDataUnmarked", summarizeWithDetails],
	["silent_demo_fallback", "silentDemoFallback", summarizeWithDetails],
	["demo_runtime_missing_banner", "demoRuntimeMissingBanner", summarizeWithDetails],
	["placeholder_data_in_ui", "placeholderDataInUi", summarizeWithDetails],
	["tsconfig_strictness", "tsconfigStrictness", summarizeWithDetails],
] as const satisfies readonly ReportSection[];

function summarizeSections(cq: CodeQualityResults, sections: readonly ReportSection[]): JsonObject {
	const report: JsonObject = {};
	for (const [key, bucket, render] of sections) report[key] = render(cq[bucket]);
	return report;
}

export interface OutputJsonArgs {
	/** Set-aside files, not-measured pairs and the early-stop record of this run (`scan-ledger.ts`). */
	scanLedger?: ScanLedger | null;
	/** Catalog check ids this run did not execute, each with one reason code (`not-run.ts`). */
	notRun?: Record<string, NotRunEntry>;
	/** What this invocation selected; decides which opt-in result sections exist (`not-run.ts`). */
	runContext?: NotRunContext;
	externalDiagnostics?: readonly DiagnosticResult[];
	toolInputScopes?: readonly ToolInputScope[];
	unavailableChecks?: readonly { check: string; reason: string }[];
	checkCoverage?: Pick<CheckReport, "toolsRun" | "skipped">;
	/** Invocation selection only. Excluded IDs are the configured skip set, not executed checks. */
	checkSelection?: { inlineRequested: boolean; externalOnly: string | null; excludedIds: string[] };
	checkTimings?: readonly VerifyCheckTiming[];
	catalogue?: Record<string, CatalogueResult> | undefined;
	tscResults: DiagnosticResult[];
	linterResults: DiagnosticResult[];
	linterName: string;
	semgrepResults: DiagnosticResult[];
	gitleaksResults: DiagnosticResult[];
	auditResult: AuditResult | null;
	cq: CodeQualityResults;
	suggestions: Map<string, Finding[]> | null;
	totalFiles: number;
	setupIssues?: ProjectSetupIssue[];
	registryDrift?: RegistryDriftFinding[];
	decisionSurface?: DecisionSurfaceReport;
	lockfileMultiplicity?: LockfileMultiplicityResult;
	decisionSurfaceRatchet?: DecisionSurfaceRatchetResult;
	structureSection?: JsonObject | undefined;
	/** F6: the project e2e verdict (`verify/project-e2e-section.ts`); absent → `{status: "unconfigured"}`. */
	projectE2e?: JsonObject;
	/** Which rules judged this run (`rules-fingerprint.ts`); absent → emitted as null. */
	rules?: RulesFingerprint;
	/** E18 fp_filter would-suppress counts (`verify/fp-filter-section.ts`); absent → no key. */
	fpFilter?: JsonObject | undefined;
	/** Kill-proof receipts (`verify/kill-proofs-section.ts`); absent (no receipt on disk) → no key. */
	killProofs?: JsonObject | undefined;
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Serialize a verify run to stdout as a single JSON object. Exit-code side
 * effects live in the caller.
 */
export function outputJson(args: OutputJsonArgs): void {
	process.stdout.write(`${JSON.stringify(buildVerifyJson(args), null, 2)}\n`);
}

function summarizeProjectChecks({ setupIssues, registryDrift, decisionSurface, lockfileMultiplicity, decisionSurfaceRatchet }: OutputJsonArgs): JsonObject {
	return {
		project_setup: {
			issues: setupIssues?.length ?? 0,
			details:
				setupIssues?.map((i) => ({ file: i.file, message: i.message, fix: i.fix })) ?? [],
		},
		registry_parity: {
			issues: registryDrift?.length ?? 0,
			details:
				registryDrift?.map((f) => ({
					pair: f.pair,
					kind: f.kind,
					id: f.id,
					source_file: f.source_file,
					target_file: f.target_file,
					message: f.message,
				})) ?? [],
		},
		decision_surface: decisionSurface
			? {
					by_category: decisionSurface.byCategory,
					total_surface: decisionSurface.totalSurface,
				}
			: { by_category: {}, total_surface: 0 },
		multiple_lockfiles:
			lockfileMultiplicity && lockfileMultiplicity.multiplicity
				? {
						issues: 1,
						details: [
							{
								lockfiles: lockfileMultiplicity.lockfiles,
								managers: lockfileMultiplicity.managers,
								message: `Multiple lockfiles found (${lockfileMultiplicity.lockfiles.join(" + ")}) implying ${lockfileMultiplicity.managers.join(" / ")}. Installs are non-deterministic until one is chosen.`,
							},
						],
					}
				: { issues: 0, details: [] },
		decision_surface_growth: decisionSurfaceRatchet
			? {
					baseline_ref: decisionSurfaceRatchet.baselineRef,
					skipped: decisionSurfaceRatchet.skipped,
					total_growth: decisionSurfaceRatchet.totalGrowth,
					growth_by_category: decisionSurfaceRatchet.growthByCategory,
					warnings: decisionSurfaceRatchet.warnings,
				}
			: {
					baseline_ref: null,
					skipped: "not-computed",
					total_growth: 0,
					growth_by_category: {},
					warnings: [],
				},
	};
}

function summarizeExternalChecks({ tscResults, linterResults, linterName, semgrepResults, gitleaksResults, auditResult, notRun }: OutputJsonArgs): JsonObject {
	return {
		tsc: summarizeWithDetails(tscResults),
		[linterName]: summarizeWithDetails(linterResults),
		...(notRun?.["tool_quality:semgrep"] ? {} : { semgrep: {
			findings: semgrepResults.length,
			files: [...new Set(semgrepResults.map((r) => r.file))].sort(),
			details: semgrepResults,
		} }),
		gitleaks: {
			secrets: gitleaksResults.length,
			files: [...new Set(gitleaksResults.map((r) => r.file))].sort(),
			details: gitleaksResults,
		},
		dependency_audit: auditResult
			? {
					vulnerabilities: auditResult.total,
					critical: auditResult.critical,
					high: auditResult.high,
					moderate: auditResult.moderate,
					low: auditResult.low,
					tool: auditResult.tool,
				}
			: { vulnerabilities: 0 },
	};
}

/** The verify report as an object (tests read it without capturing stdout). */
export function buildVerifyJson(args: OutputJsonArgs): JsonObject {
	const { cq, suggestions, totalFiles, structureSection } = args;

	const ledger = args.scanLedger;
	const result: JsonObject = {
		files_scanned: totalFiles,
		files_measured: ledger ? ledger.measuredFiles : null,
		partial: ledger?.partial != null,
		partial_detail: ledger?.partial ? { ...ledger.partial } : null,
		set_aside: summarizeSetAside(ledger?.setAside ?? []),
		not_measured: summarizeNotMeasured(ledger?.notMeasured ?? []),
		not_run: args.notRun ? { ...args.notRun } : {},
		external_diagnostics: args.externalDiagnostics ?? null,
		...summarizeProjectChecks(args),
		...summarizeExternalChecks(args),
		...summarizeSections(cq, CORE_SECTIONS),
		project_loc_ratio: {
			issues: cq.projectLocRatio.length,
			files: [],
			details: cq.projectLocRatio,
		},
		...summarizeSections(cq, DIAGNOSTIC_SECTIONS),
		// === Test-quality + test-discrimination (output-json-test-quality.ts) ===
		...summarizeTestQualitySections(cq, summarizeWithDetails),
		...summarizeSections(cq, CROSS_FILE_SECTIONS),
	};

	if (suggestions) {
		const suggObj: Record<string, unknown[]> = {};
		for (const [file, findings] of suggestions.entries()) {
			suggObj[file] = findings;
		}
		result.suggestions = suggObj;
	}
	if (structureSection) {
		result.structure = structureSection;
	}
	result.actions = verifyActions(args);
	result.check_coverage = { tools: args.checkCoverage ?? null, timings: args.checkTimings ?? null, selection: args.checkSelection ?? null,
		input_scopes: args.toolInputScopes?.map(scope => ({ ...scope })) ?? [] };
	addPlacementSections(result, args);
	return tagVerifyJson(result, args);
}

/**
 * Prepend the shape tag and the rules fingerprint so they are the first two
 * keys a consumer sees. `rules` is null (never absent) when no fingerprint was
 * computed, so "not computed" stays distinguishable from a pre-schema report.
 */
function tagVerifyJson(result: JsonObject, { rules, projectE2e, fpFilter, catalogue, killProofs }: Pick<OutputJsonArgs, "rules" | "projectE2e" | "fpFilter" | "catalogue" | "killProofs">): JsonObject {
	const tagged: JsonObject = {
		schema_version: VERIFY_JSON_SCHEMA,
		rules: rules ? { schema: rules.schema, rules_hash: rules.rules_hash, inputs: rules.inputs } : null,
		...result,
		...(fpFilter ? { fp_filter: fpFilter } : {}),
		...(catalogue ? { catalogue_advisories: JSON.parse(JSON.stringify(catalogue)) as JsonObject } : {}),
		// F6: the project e2e verdict (`verify/project-e2e-section.ts`); absent policy ⇒ unconfigured.
		project_e2e: projectE2e ?? { status: "unconfigured" },
		// Kill-proof receipts (`verify/kill-proofs-section.ts`); no receipt on disk ⇒ no key, zero cost.
		...(killProofs ? { kill_proofs: killProofs } : {}),
	};
	return tagged;
}
