// ===========================================
// Per-file check battery — UBS group
// ===========================================
// Extracted from `file-checks.ts` to keep that orchestrator under the
// 1000-line file-size threshold. Covers every UBS ("undefined-behavior /
// unsafe") Plan 04 detector: rows 22–30, the D.1 backlog (20 entries), and
// the D.2 pattern-parity expansion. Behaviour-preserving: same checks, same
// per-bucket order.

import { checkIdenticalBranches } from "../../harness/checks/identical-branches.js";
import {
	checkAesEcbMode,
	checkCAssertSideEffects,
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkDeeplyNestedCallback,
	checkDeferInLoop,
	checkDivisionByVariable,
	checkDocumentWrite,
	checkEvalInputTainted,
	checkFloatEquality,
	checkGithubActionsInjection,
	checkGoroutineNoWaitgroup,
	checkGoShellInjection,
	checkInsertAdjacentHtml,
	checkJavaAssertSideEffects,
	checkJavaOptionalGet,
	checkJsLooseEquality,
	checkLargeFunction,
	checkLoggerFormatUserInput,
	checkMagicNumberNoConst,
	checkMarshalLoad,
	checkMixedSyncAsyncFileApi,
	checkMutexLockUnwrap,
	checkNodeCreateCipher,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkOuterHtmlAssignment,
	checkPickleUntrustedLoad,
	checkPickleWrapperLoad,
	checkPrintDebugLeak,
	checkPyMutableDefaultArg,
	checkPyNoneEquality,
	checkPythonAssertSideEffects,
	checkRegexInLoopNoCompile,
	checkRustDebugAssertSideEffects,
	checkRustUncheckedCastSlice,
	checkScriptWithoutSri,
	checkShelveOpen,
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkSubprocessShellTrue,
	checkTempfileMktempRace,
	checkTimeFormatLocaleDep,
	checkTlsVerifyDisabled,
	checkTorchUnsafeLoad,
	checkUbsHardcodedLocalhost,
	checkUbsStringConcatInLoop,
	checkUnalignedReinterpret,
	checkUncheckedRedirect,
	checkUnsafeFormatString,
	checkWeakHash,
	checkWeakRandom,
	checkXmlExternalEntity,
	checkYamlUnsafeLoad,
} from "../../harness/generic-checks.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";

/**
 * Every UBS Plan 04 detector. Mirrors the inline blocks from "=== UBS Plan 04
 * — rows 27–30 ===" through "=== Plan 04 D.2 (2026-05): pattern-parity
 * expansion ===".
 */
export function runUbsChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, r } = ctx;

	// === UBS Plan 04 — rows 27–30 ===
	r.jsLooseEquality.push(
		...toIssues("ubs_js_loose_equality", relPath, checkJsLooseEquality, content, file),
	);
	r.floatEquality.push(
		...toIssues("ubs_float_equality", relPath, checkFloatEquality, content, file),
	);
	r.javaOptionalGet.push(
		...toIssues("ubs_java_optional_get", relPath, checkJavaOptionalGet, content, file),
	);
	r.rustDebugAssertSideEffect.push(
		...toIssues(
			"ubs_rust_debug_assert_side_effect",
			relPath,
			checkRustDebugAssertSideEffects, content, file,
		),
	);
	// Bun-regression detector pack (2026-07-20): assert-erasure siblings +
	// reinterpret-alignment pair.
	r.cAssertSideEffect.push(
		...toIssues(
			"ubs_c_assert_side_effect",
			relPath,
			checkCAssertSideEffects, content, file,
		),
	);
	r.pythonAssertSideEffect.push(
		...toIssues(
			"ubs_python_assert_side_effect",
			relPath,
			checkPythonAssertSideEffects, content, file,
		),
	);
	r.javaAssertSideEffect.push(
		...toIssues(
			"ubs_java_assert_side_effect",
			relPath,
			checkJavaAssertSideEffects, content, file,
		),
	);
	r.rustUncheckedCastSlice.push(
		...toIssues(
			"ubs_rust_unchecked_cast_slice",
			relPath,
			checkRustUncheckedCastSlice, content, file,
		),
	);
	r.unalignedReinterpret.push(
		...toIssues(
			"unaligned_reinterpret",
			relPath,
			checkUnalignedReinterpret, content, file,
		),
	);
	r.divisionByVariable.push(
		...toIssues(
			"ubs_division_by_variable",
			relPath,
			checkDivisionByVariable, content, file,
		),
	);

	// === UBS Plan 04 — rows 22–26 (critical-tier) ===
	r.mutexLockUnwrap.push(
		...toIssues("ubs_mutex_lock_unwrap", relPath, checkMutexLockUnwrap, content, file),
	);
	r.subprocessShellTrue.push(
		...toIssues(
			"ubs_subprocess_shell_true",
			relPath,
			checkSubprocessShellTrue, content, file,
		),
	);
	r.tlsVerifyDisabled.push(
		...toIssues("ubs_tls_verify_disabled", relPath, checkTlsVerifyDisabled, content, file),
	);
	r.pyNoneEquality.push(
		...toIssues("ubs_py_none_equality", relPath, checkPyNoneEquality, content, file),
	);
	r.weakHash.push(...toIssues("ubs_weak_hash", relPath, checkWeakHash, content, file));
	r.weakRandom.push(...toIssues("ubs_weak_random_security", relPath, checkWeakRandom, content, file));
	// Plan 04 D.1 partial — high-leverage backlog
	r.evalInputTainted.push(
		...toIssues(
			"ubs_eval_input_tainted",
			relPath,
			checkEvalInputTainted, content, file,
		),
	);
	r.sqlStringConcat.push(
		...toIssues("ubs_sql_string_concat", relPath, checkSqlStringConcat, content, file),
	);
	r.sqlEscapeHatchNonLiteral.push(
		...toIssues(
			"sql_escape_hatch_non_literal",
			relPath,
			checkSqlEscapeHatchNonLiteral, content, file,
		),
	);
	r.pyMutableDefaultArg.push(
		...toIssues(
			"ubs_python_mutable_default_arg",
			relPath,
			checkPyMutableDefaultArg, content, file,
		),
	);
	// Plan 04 D.1 backlog (17 of 20)
	r.tempfileMktempRace.push(
		...toIssues(
			"ubs_tempfile_mktemp_race",
			relPath,
			checkTempfileMktempRace, content, file,
		),
	);
	r.pickleUntrustedLoad.push(
		...toIssues(
			"ubs_pickle_untrusted_load",
			relPath,
			checkPickleUntrustedLoad, content, file,
		),
	);
	r.xmlExternalEntity.push(
		...toIssues(
			"ubs_xml_external_entity",
			relPath,
			checkXmlExternalEntity, content, file,
		),
	);
	r.osSystemTainted.push(
		...toIssues("ubs_os_system_tainted", relPath, checkOsSystemTainted, content, file),
	);
	r.unsafeFormatString.push(
		...toIssues(
			"ubs_unsafe_format_string",
			relPath,
			checkUnsafeFormatString, content, file,
		),
	);
	r.uncheckedRedirect.push(
		...toIssues(
			"ubs_unchecked_redirect",
			relPath,
			checkUncheckedRedirect, content, file,
		),
	);
	r.goroutineNoWaitgroup.push(
		...toIssues(
			"ubs_goroutine_no_waitgroup",
			relPath,
			checkGoroutineNoWaitgroup, content, file,
		),
	);
	r.deferInLoop.push(
		...toIssues("ubs_defer_in_loop", relPath, checkDeferInLoop, content, file),
	);
	r.ubsStringConcatInLoop.push(
		...toIssues(
			"ubs_string_concat_in_loop",
			relPath,
			checkUbsStringConcatInLoop, content, file,
		),
	);
	r.numericComparisonChain.push(
		...toIssues(
			"ubs_numeric_comparison_chain",
			relPath,
			checkNumericComparisonChain, content, file,
		),
	);
	r.printDebugLeak.push(
		...toIssues("ubs_print_debug_leak", relPath, checkPrintDebugLeak, content, file),
	);
	r.ubsHardcodedLocalhost.push(
		...toIssues(
			"ubs_hardcoded_localhost",
			relPath,
			checkUbsHardcodedLocalhost, content, file,
		),
	);
	r.childProcessExecUserInput.push(
		...toIssues(
			"child_process_exec_user_input",
			relPath,
			checkChildProcessExecUserInput, content, file,
		),
	);
	r.mixedSyncAsyncFileApi.push(
		...toIssues(
			"mixed_sync_async_file_api",
			relPath,
			checkMixedSyncAsyncFileApi, content, file,
		),
	);
	r.cookieMissingSecurityFlags.push(
		...toIssues(
			"cookie_missing_security_flags",
			relPath,
			checkCookieMissingSecurityFlags, content, file,
		),
	);
	r.loggerFormatUserInput.push(
		...toIssues(
			"logger_format_user_input",
			relPath,
			checkLoggerFormatUserInput, content, file,
		),
	);
	r.magicNumberNoConst.push(
		...toIssues(
			"ubs_magic_number_no_const",
			relPath,
			checkMagicNumberNoConst, content, file,
		),
	);
	r.largeFunction.push(
		...toIssues("ubs_large_function", relPath, checkLargeFunction, content, file),
	);
	r.deeplyNestedCallback.push(
		...toIssues(
			"ubs_deeply_nested_callback",
			relPath,
			checkDeeplyNestedCallback, content, file,
		),
	);
	r.timeFormatLocaleDep.push(
		...toIssues(
			"ubs_time_format_locale_dep",
			relPath,
			checkTimeFormatLocaleDep, content, file,
		),
	);
	r.regexInLoopNoCompile.push(
		...toIssues(
			"ubs_regex_in_loop_no_compile",
			relPath,
			checkRegexInLoopNoCompile, content, file,
		),
	);

	// === Plan 04 D.2 (2026-05): pattern-parity expansion ===
	r.marshalLoad.push(
		...toIssues("ubs_marshal_load", relPath, checkMarshalLoad, content, file),
	);
	r.shelveOpen.push(...toIssues("ubs_shelve_open", relPath, checkShelveOpen, content, file));
	r.yamlUnsafeLoad.push(
		...toIssues("ubs_yaml_unsafe_load", relPath, checkYamlUnsafeLoad, content, file),
	);
	r.torchUnsafeLoad.push(
		...toIssues("ubs_torch_unsafe_load", relPath, checkTorchUnsafeLoad, content, file),
	);
	r.pickleWrapperLoad.push(
		...toIssues("ubs_pickle_wrapper_load", relPath, checkPickleWrapperLoad, content, file),
	);
	r.aesEcbMode.push(
		...toIssues("ubs_aes_ecb_mode", relPath, checkAesEcbMode, content, file),
	);
	r.nodeCreateCipher.push(
		...toIssues("ubs_node_create_cipher", relPath, checkNodeCreateCipher, content, file),
	);
	r.scriptWithoutSri.push(
		...toIssues("ubs_script_without_sri", relPath, checkScriptWithoutSri, content, file),
	);
	r.goShellInjection.push(
		...toIssues("ubs_go_shell_injection", relPath, checkGoShellInjection, content, file),
	);
	r.githubActionsInjection.push(
		...toIssues(
			"ubs_github_actions_injection",
			relPath,
			checkGithubActionsInjection, content, file,
		),
	);
	r.documentWrite.push(
		...toIssues("ubs_document_write", relPath, checkDocumentWrite, content, file),
	);
	r.outerHtmlAssignment.push(
		...toIssues(
			"ubs_outer_html_assignment",
			relPath,
			checkOuterHtmlAssignment, content, file,
		),
	);
	r.insertAdjacentHtml.push(
		...toIssues(
			"ubs_insert_adjacent_html",
			relPath,
			checkInsertAdjacentHtml, content, file,
		),
	);
	r.identicalConditionalBranches.push(
		...toIssues(
			"identical_conditional_branches",
			relPath,
			checkIdenticalBranches, content, file,
		),
	);
}
