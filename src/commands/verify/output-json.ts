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
import { summarizeTestQualitySections } from "./output-json-test-quality.js";
import type { AuditResult, CodeQualityResults, DiagnosticResult } from "./tool-results-types.js";

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

interface OutputJsonArgs {
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
}

/**
 * Public API — consumed by `verify.ts`.
 *
 * Serialize a verify run to stdout as a single JSON object. Exit-code side
 * effects live in the caller.
 */
export function outputJson(args: OutputJsonArgs): void {
	const {
		tscResults,
		linterResults,
		linterName,
		semgrepResults,
		gitleaksResults,
		auditResult,
		cq,
		suggestions,
		totalFiles,
		setupIssues,
		registryDrift,
		decisionSurface,
		lockfileMultiplicity,
		decisionSurfaceRatchet,
		structureSection,
	} = args;

	const result: JsonObject = {
		files_scanned: totalFiles,
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
		tsc: summarizeWithDetails(tscResults),
		[linterName]: summarizeWithDetails(linterResults),
		semgrep: {
			findings: semgrepResults.length,
			files: [...new Set(semgrepResults.map((r) => r.file))].sort(),
			details: semgrepResults,
		},
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
		strong_typing: summarizeWithDetails(cq.strongTyping),
		suppressions: summarizeWithDetails(cq.suppressions),
		large_files: summarizeWithDetails(cq.largeFiles),
		untested_files: summarizeWithDetails(cq.untestedFiles),
		json_validity: summarizeWithDetails(cq.jsonValidity),
		phantom_imports: summarizeWithDetails(cq.phantomImports),
		console_statements: summarize(cq.consoleStatements),
		silent_catches: summarize(cq.silentCatches),
		test_regressions: summarize(cq.testRegressions),
		undocumented_env_vars: summarize(cq.undocumentedEnvVars),
		mock_drift: summarize(cq.mockDrift),
		incomplete_renames: summarize(cq.incompleteRenames),
		missing_return_types: summarize(cq.missingReturnTypes),
		no_test_file: summarize(cq.noTestFile),
		complexity: summarize(cq.complexity),
		code_clones: summarizeWithDetails(cq.codeClones),
		crap: summarizeWithDetails(cq.crap),
		export_ripple: summarize(cq.exportRipple),
		excessive_use_state: summarize(cq.excessiveUseState),
		dangerously_set_inner_html: summarize(cq.dangerouslySetInnerHtml),
		direct_dom_access: summarize(cq.directDomAccess),
		inline_object_props: summarize(cq.inlineObjectProps),
		async_event_handler: summarize(cq.asyncEventHandler),
		nested_ternaries: summarize(cq.nestedTernaries),
		catch_and_log: summarize(cq.catchAndLog),
		json_parse_unsafe: summarize(cq.jsonParseUnsafe),
		hardcoded_timeout: summarize(cq.hardcodedTimeout),
		disabled_tests: summarize(cq.disabledTests),
		placeholder_test: summarizeWithDetails(cq.placeholderTest),
		suppression_hygiene: summarizeWithDetails(cq.suppressionHygiene),
		target_blank_no_rel: summarize(cq.targetBlankNoRel),
		snapshot_overuse: summarize(cq.snapshotOveruse),
		test_importing_test: summarize(cq.testImportingTest),
		excessive_use_effect: summarize(cq.excessiveUseEffect),
		sequential_awaits: summarize(cq.sequentialAwaits),
		index_as_key: summarize(cq.indexAsKey),
		missing_effect_cleanup: summarize(cq.missingEffectCleanup),
		over_mocking: summarize(cq.overMocking),
		focused_tests: summarizeWithDetails(cq.focusedTests),
		migration_ordering: summarizeWithDetails(cq.migrationOrdering),
		sql_schema_consistency: summarizeWithDetails(cq.sqlSchemaConsistency),
		visibility_filter_missing: summarizeWithDetails(cq.visibilityFilterMissing),
		pii_detection: summarizeWithDetails(cq.piiDetection),
		assertion_free_test: summarizeWithDetails(cq.assertionFreeTest),
		tautological_assertion: summarizeWithDetails(cq.tautologicalAssertion),
		mocking_the_sut: summarizeWithDetails(cq.mockingTheSut),
		private_member_test_access: summarizeWithDetails(cq.privateMemberTestAccess),
		loop_nesting_depth: summarizeWithDetails(cq.loopNestingDepth),
		else_if_chain: summarizeWithDetails(cq.elseIfChain),
		duplicate_switch_discriminant: summarizeWithDetails(cq.duplicateSwitchDiscriminant),
		hybrid_class: summarizeWithDetails(cq.hybridClass),
		fuzzy_responsibility_name: summarizeWithDetails(cq.fuzzyResponsibilityName),
		law_of_demeter: summarizeWithDetails(cq.lawOfDemeter),
		flag_argument: summarizeWithDetails(cq.flagArgument),
		commented_out_code: summarizeWithDetails(cq.commentedOutCode),
		conditional_in_test: summarizeWithDetails(cq.conditionalInTest),
		non_deterministic_test: summarizeWithDetails(cq.nonDeterministicTest),
		timing_flake: summarizeWithDetails(cq.timingFlake),
		empty_catch: summarizeWithDetails(cq.emptyCatch),
		test_without_description: summarizeWithDetails(cq.testWithoutDescription),
		assertion_roulette: summarizeWithDetails(cq.assertionRoulette),
		magic_number: summarizeWithDetails(cq.magicNumber),
		function_arg_count: summarizeWithDetails(cq.functionArgCount),
		data_clump: summarizeWithDetails(cq.dataClump),
		duplicate_describe: summarizeWithDetails(cq.duplicateDescribe),
		cross_file_switch_discriminant: summarizeWithDetails(cq.crossFileSwitchDiscriminant),
		single_implementation_interface: summarizeWithDetails(cq.singleImplementationInterface),
		files_without_test: summarizeWithDetails(cq.filesWithoutTest),
		project_loc_ratio: {
			issues: cq.projectLocRatio.length,
			files: [],
			details: cq.projectLocRatio,
		},
		// === UBS Plan 04 — rows 27–30 ===
		ubs_js_loose_equality: summarizeWithDetails(cq.jsLooseEquality),
		ubs_float_equality: summarizeWithDetails(cq.floatEquality),
		ubs_java_optional_get: summarizeWithDetails(cq.javaOptionalGet),
		ubs_rust_debug_assert_side_effect: summarizeWithDetails(cq.rustDebugAssertSideEffect),
		// Bun-regression detector pack (2026-07-20)
		ubs_c_assert_side_effect: summarizeWithDetails(cq.cAssertSideEffect),
		ubs_python_assert_side_effect: summarizeWithDetails(cq.pythonAssertSideEffect),
		ubs_java_assert_side_effect: summarizeWithDetails(cq.javaAssertSideEffect),
		ubs_rust_unchecked_cast_slice: summarizeWithDetails(cq.rustUncheckedCastSlice),
		unaligned_reinterpret: summarizeWithDetails(cq.unalignedReinterpret),
		ubs_division_by_variable: summarizeWithDetails(cq.divisionByVariable),
		// === UBS Plan 04 — rows 22–26 (critical-tier) ===
		ubs_mutex_lock_unwrap: summarizeWithDetails(cq.mutexLockUnwrap),
		ubs_subprocess_shell_true: summarizeWithDetails(cq.subprocessShellTrue),
		ubs_tls_verify_disabled: summarizeWithDetails(cq.tlsVerifyDisabled),
		ubs_py_none_equality: summarizeWithDetails(cq.pyNoneEquality),
		ubs_weak_hash: summarizeWithDetails(cq.weakHash),
		ubs_weak_random_security: summarizeWithDetails(cq.weakRandom),
		// === Plan 04 D.1 partial ===
		ubs_eval_input_tainted: summarizeWithDetails(cq.evalInputTainted),
		ubs_sql_string_concat: summarizeWithDetails(cq.sqlStringConcat),
		sql_escape_hatch_non_literal: summarizeWithDetails(cq.sqlEscapeHatchNonLiteral),
		ubs_python_mutable_default_arg: summarizeWithDetails(cq.pyMutableDefaultArg),
		// === Plan 04 D.1 backlog (17 of 20) ===
		ubs_tempfile_mktemp_race: summarizeWithDetails(cq.tempfileMktempRace),
		ubs_pickle_untrusted_load: summarizeWithDetails(cq.pickleUntrustedLoad),
		ubs_xml_external_entity: summarizeWithDetails(cq.xmlExternalEntity),
		ubs_os_system_tainted: summarizeWithDetails(cq.osSystemTainted),
		ubs_unsafe_format_string: summarizeWithDetails(cq.unsafeFormatString),
		ubs_unchecked_redirect: summarizeWithDetails(cq.uncheckedRedirect),
		ubs_goroutine_no_waitgroup: summarizeWithDetails(cq.goroutineNoWaitgroup),
		ubs_defer_in_loop: summarizeWithDetails(cq.deferInLoop),
		ubs_string_concat_in_loop: summarizeWithDetails(cq.ubsStringConcatInLoop),
		ubs_numeric_comparison_chain: summarizeWithDetails(cq.numericComparisonChain),
		ubs_print_debug_leak: summarizeWithDetails(cq.printDebugLeak),
		ubs_hardcoded_localhost: summarizeWithDetails(cq.ubsHardcodedLocalhost),
		raw_control_bytes: summarizeWithDetails(cq.rawControlBytes),
		lossy_error_rethrow: summarizeWithDetails(cq.lossyErrorRethrow),
		import_from_own_barrel: summarizeWithDetails(cq.importFromOwnBarrel),
		error_dispatch_by_instanceof: summarizeWithDetails(cq.errorDispatchByInstanceof),
		silent_promise_catch: summarizeWithDetails(cq.silentPromiseSwallow),
		child_process_exec_user_input: summarizeWithDetails(cq.childProcessExecUserInput),
		mixed_sync_async_file_api: summarizeWithDetails(cq.mixedSyncAsyncFileApi),
		cookie_missing_security_flags: summarizeWithDetails(cq.cookieMissingSecurityFlags),
		logger_format_user_input: summarizeWithDetails(cq.loggerFormatUserInput),
		ubs_magic_number_no_const: summarizeWithDetails(cq.magicNumberNoConst),
		ubs_large_function: summarizeWithDetails(cq.largeFunction),
		ubs_deeply_nested_callback: summarizeWithDetails(cq.deeplyNestedCallback),
		ubs_time_format_locale_dep: summarizeWithDetails(cq.timeFormatLocaleDep),
		ubs_regex_in_loop_no_compile: summarizeWithDetails(cq.regexInLoopNoCompile),
		// === Batch 1: agent-laziness (11 entries) ===
		agent_thumbprint_prose: summarizeWithDetails(cq.agentThumbprintProse),
		stub_not_implemented_throw: summarizeWithDetails(cq.stubNotImplementedThrow),
		dead_branch_literal: summarizeWithDetails(cq.deadBranchLiteral),
		file_level_suppression: summarizeWithDetails(cq.fileLevelSuppression),
		untestable_time_in_source: summarizeWithDetails(cq.untestableTimeInSource),
		double_cast_unknown: summarizeWithDetails(cq.doubleCastUnknown),
		type_smuggling: summarizeWithDetails(cq.typeSmuggling),
		union_widened_with_string: summarizeWithDetails(cq.unionWidenedWithString),
		nodeenv_branch_in_prod: summarizeWithDetails(cq.nodeenvBranchInProd),
		fetch_without_timeout: summarizeWithDetails(cq.fetchWithoutTimeout),
		unbounded_promise_all: summarizeWithDetails(cq.unboundedPromiseAll),
		sync_io_on_hot_path: summarizeWithDetails(cq.syncIoOnHotPath),
		// Bun-regression detector pack (2026-07-20): confessed stand-ins + span pair
		placeholder_runtime_constant: summarizeWithDetails(cq.placeholderRuntimeConstant),
		rust_unsafe_span: summarizeWithDetails(cq.rustUnsafeSpan),
		suppression_block_span: summarizeWithDetails(cq.suppressionBlockSpan),
		// === Batch 2: test-hygiene (7 entries) ===
		duplicate_test_names: summarizeWithDetails(cq.duplicateTestNames),
		real_io_in_tests: summarizeWithDetails(cq.realIoInTests),
		test_nondeterminism: summarizeWithDetails(cq.testNondeterminism),
		hardcoded_timeout_in_tests: summarizeWithDetails(cq.hardcodedTimeoutInTests),
		test_missing_sut_import: summarizeWithDetails(cq.testMissingSutImport),
		mocking_the_sut_self: summarizeWithDetails(cq.mockingTheSutSelf),
		test_subprocess_default_timeout: summarizeWithDetails(cq.testSubprocessDefaultTimeout),
		// === Test-quality + test-discrimination (output-json-test-quality.ts) ===
		...summarizeTestQualitySections(cq, summarizeWithDetails),
		// === Batch 5: cross-file (4 entries) ===
		empty_body_handler: summarizeWithDetails(cq.emptyBodyHandler),
		listener_pairing: summarizeWithDetails(cq.listenerPairing),
		schema_type_drift: summarizeWithDetails(cq.schemaTypeDrift),
		migration_parity: summarizeWithDetails(cq.migrationParity),
		// === Batch 8: demo-data (3 entries) ===
		demo_data_unmarked: summarizeWithDetails(cq.demoDataUnmarked),
		silent_demo_fallback: summarizeWithDetails(cq.silentDemoFallback),
		demo_runtime_missing_banner: summarizeWithDetails(cq.demoRuntimeMissingBanner),
		placeholder_data_in_ui: summarizeWithDetails(cq.placeholderDataInUi),
		// === tsconfig strictness ===
		tsconfig_strictness: summarizeWithDetails(cq.tsconfigStrictness),
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
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
