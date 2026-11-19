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
import { contentCheckRunner } from "./file-checks-content.js";

/**
 * Every UBS Plan 04 detector. Mirrors the inline blocks from "=== UBS Plan 04
 * — rows 27–30 ===" through "=== Plan 04 D.2 (2026-05): pattern-parity
 * expansion ===".
 */
export function runUbsChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);

	// === UBS Plan 04 — rows 27–30 ===
	runCheck("ubs_js_loose_equality", r.jsLooseEquality, checkJsLooseEquality);
	runCheck("ubs_float_equality", r.floatEquality, checkFloatEquality);
	runCheck("ubs_java_optional_get", r.javaOptionalGet, checkJavaOptionalGet);
	runCheck("ubs_rust_debug_assert_side_effect", r.rustDebugAssertSideEffect, checkRustDebugAssertSideEffects);
	// Bun-regression detector pack (2026-07-20): assert-erasure siblings +
	// reinterpret-alignment pair.
	runCheck("ubs_c_assert_side_effect", r.cAssertSideEffect, checkCAssertSideEffects);
	runCheck("ubs_python_assert_side_effect", r.pythonAssertSideEffect, checkPythonAssertSideEffects);
	runCheck("ubs_java_assert_side_effect", r.javaAssertSideEffect, checkJavaAssertSideEffects);
	runCheck("ubs_rust_unchecked_cast_slice", r.rustUncheckedCastSlice, checkRustUncheckedCastSlice);
	runCheck("unaligned_reinterpret", r.unalignedReinterpret, checkUnalignedReinterpret);
	runCheck("ubs_division_by_variable", r.divisionByVariable, checkDivisionByVariable);

	// === UBS Plan 04 — rows 22–26 (critical-tier) ===
	runCheck("ubs_mutex_lock_unwrap", r.mutexLockUnwrap, checkMutexLockUnwrap);
	runCheck("ubs_subprocess_shell_true", r.subprocessShellTrue, checkSubprocessShellTrue);
	runCheck("ubs_tls_verify_disabled", r.tlsVerifyDisabled, checkTlsVerifyDisabled);
	runCheck("ubs_py_none_equality", r.pyNoneEquality, checkPyNoneEquality);
	runCheck("ubs_weak_hash", r.weakHash, checkWeakHash);
	runCheck("ubs_weak_random_security", r.weakRandom, checkWeakRandom);
	// Plan 04 D.1 partial — high-leverage backlog
	runCheck("ubs_eval_input_tainted", r.evalInputTainted, checkEvalInputTainted);
	runCheck("ubs_sql_string_concat", r.sqlStringConcat, checkSqlStringConcat);
	runCheck("sql_escape_hatch_non_literal", r.sqlEscapeHatchNonLiteral, checkSqlEscapeHatchNonLiteral);
	runCheck("ubs_python_mutable_default_arg", r.pyMutableDefaultArg, checkPyMutableDefaultArg);
	// Plan 04 D.1 backlog (17 of 20)
	runCheck("ubs_tempfile_mktemp_race", r.tempfileMktempRace, checkTempfileMktempRace);
	runCheck("ubs_pickle_untrusted_load", r.pickleUntrustedLoad, checkPickleUntrustedLoad);
	runCheck("ubs_xml_external_entity", r.xmlExternalEntity, checkXmlExternalEntity);
	runCheck("ubs_os_system_tainted", r.osSystemTainted, checkOsSystemTainted);
	runCheck("ubs_unsafe_format_string", r.unsafeFormatString, checkUnsafeFormatString);
	runCheck("ubs_unchecked_redirect", r.uncheckedRedirect, checkUncheckedRedirect);
	runCheck("ubs_goroutine_no_waitgroup", r.goroutineNoWaitgroup, checkGoroutineNoWaitgroup);
	runCheck("ubs_defer_in_loop", r.deferInLoop, checkDeferInLoop);
	runCheck("ubs_string_concat_in_loop", r.ubsStringConcatInLoop, checkUbsStringConcatInLoop);
	runCheck("ubs_numeric_comparison_chain", r.numericComparisonChain, checkNumericComparisonChain);
	runCheck("ubs_print_debug_leak", r.printDebugLeak, checkPrintDebugLeak);
	runCheck("ubs_hardcoded_localhost", r.ubsHardcodedLocalhost, checkUbsHardcodedLocalhost);
	runCheck("child_process_exec_user_input", r.childProcessExecUserInput, checkChildProcessExecUserInput);
	runCheck("mixed_sync_async_file_api", r.mixedSyncAsyncFileApi, checkMixedSyncAsyncFileApi);
	runCheck("cookie_missing_security_flags", r.cookieMissingSecurityFlags, checkCookieMissingSecurityFlags);
	runCheck("logger_format_user_input", r.loggerFormatUserInput, checkLoggerFormatUserInput);
	runCheck("ubs_magic_number_no_const", r.magicNumberNoConst, checkMagicNumberNoConst);
	runCheck("ubs_large_function", r.largeFunction, checkLargeFunction);
	runCheck("ubs_deeply_nested_callback", r.deeplyNestedCallback, checkDeeplyNestedCallback);
	runCheck("ubs_time_format_locale_dep", r.timeFormatLocaleDep, checkTimeFormatLocaleDep);
	runCheck("ubs_regex_in_loop_no_compile", r.regexInLoopNoCompile, checkRegexInLoopNoCompile);

	runSerializationAndPlatformChecks(ctx);
}

function runSerializationAndPlatformChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	runCheck("ubs_marshal_load", r.marshalLoad, checkMarshalLoad);
	runCheck("ubs_shelve_open", r.shelveOpen, checkShelveOpen);
	runCheck("ubs_yaml_unsafe_load", r.yamlUnsafeLoad, checkYamlUnsafeLoad);
	runCheck("ubs_torch_unsafe_load", r.torchUnsafeLoad, checkTorchUnsafeLoad);
	runCheck("ubs_pickle_wrapper_load", r.pickleWrapperLoad, checkPickleWrapperLoad);
	runCheck("ubs_aes_ecb_mode", r.aesEcbMode, checkAesEcbMode);
	runCheck("ubs_node_create_cipher", r.nodeCreateCipher, checkNodeCreateCipher);
	runCheck("ubs_script_without_sri", r.scriptWithoutSri, checkScriptWithoutSri);
	runCheck("ubs_go_shell_injection", r.goShellInjection, checkGoShellInjection);
	runCheck("ubs_github_actions_injection", r.githubActionsInjection, checkGithubActionsInjection);
	runCheck("ubs_document_write", r.documentWrite, checkDocumentWrite);
	runCheck("ubs_outer_html_assignment", r.outerHtmlAssignment, checkOuterHtmlAssignment);
	runCheck("ubs_insert_adjacent_html", r.insertAdjacentHtml, checkInsertAdjacentHtml);
	runCheck("identical_conditional_branches", r.identicalConditionalBranches, checkIdenticalBranches);
}
