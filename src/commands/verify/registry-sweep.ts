// ===========================================
// Registry sweep — inline checks that the per-file battery does not run
// ===========================================
// 60 registered inline checks had a detector `(content, filePath) => InlineMatch[]` but no verify result key, so a
// whole tree could not be measured against them. This sweep runs those detectors over each file that is not set aside
// and records findings in the run ledger. It runs only with `--all-checks`: the default gate gains no check, and an id
// named in `--skip` stays skipped. The file-level budget (`runBudgeted`) bounds each (check, file) pair.

import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import type { CheckRegistration } from "../../harness/check-registry/types.js";
import { scanInlineSuppressions } from "../../harness/suppressions.js";
import { currentScanLedger, isVerifyAllChecks, isVerifyCheckSelected, recordVerifyInputDeferral } from "./check-timing.js";
import { runBudgeted } from "./file-checks-shared.js";
import { directiveLineFor } from "./suppression-hygiene.js";

/** Inline check ids run by the sweep, not by `file-checks.ts`. `registry-sweep.test.ts` and `not-run.test.ts` pin the split. */
export const SWEEP_INLINE_IDS: readonly string[] = [
	"builtin_prototype_mutation", "c_include_guard", "c_sprintf_usage", "c_unsafe_functions", "cjs_in_esm_module",
	"cognitive_complexity", "conditional_empty_object_spread", "contradictory_nullness_chain", "dynamic_code_execution",
	"fetch_without_abort_signal", "float_equality_comparison", "implicit_switch_fallthrough", "numeric_sort_without_comparator",
	"package_json_publish_invariants", "package_json_script_paths", "placeholder_markdown_link", "process_env_outside_config",
	"python_portability_trap", "redos_catastrophic", "rust_test_nondeterminism", "spec_capacity_claim", "spec_claim_untagged",
	"spec_count_claim", "spec_dangling_anchor", "spec_numbering", "spec_pitfall", "spec_stage_order", "spec_table_sum",
	"swift_abbreviations", "swift_ats_arbitrary_loads", "swift_combine_no_store", "swift_dispatch_main_sync", "swift_empty_catch",
	"swift_fatalerror_in_guard", "swift_file_id_over_file_path", "swift_filter_count", "swift_global_var_no_isolation",
	"swift_http_url_literal", "swift_notification_observer_no_removal", "swift_nsurl_legacy_bridge", "swift_print_in_view_body",
	"swift_self_in_escaping_closure", "swift_task_detached", "swift_task_sleep_legacy", "swift_timer_no_invalidate",
	"swift_try_question_discarded", "swift_unhandled_task_error", "swift_userdefaults_for_secret", "swift_weak_crypto",
	"tag_reflection_type_check", "test_contract_annotation", "test_platform_conditional", "test_silent_dependency_skip",
	"timeout_unit_mismatch", "top_level_burden", "top_level_side_effect", "ubs_archive_extract_traversal", "ubs_naive_datetime",
	"ubs_python_assert_tautology", "unjustified_cast", "unknown_type_alias",
];

function sweepEntries(): CheckRegistration[] {
	const wanted = new Set(SWEEP_INLINE_IDS);
	return CHECK_REGISTRY.filter((entry) => wanted.has(entry.id));
}

function mayRun(entry: CheckRegistration, lowerContent: string): boolean {
	const keywords = entry.content_keywords;
	if (!keywords || keywords.length === 0) return true;
	return keywords.some((keyword) => lowerContent.includes(keyword.toLowerCase()));
}

interface SweepInput { file: string; relPath: string; content: string }

/** Run the sweep checks on one file and record findings in the run ledger. No effect without `--all-checks`. */
export function sweepFileChecks({ file, relPath, content }: SweepInput): void {
	const ledger = currentScanLedger();
	if (!ledger || !isVerifyAllChecks()) return;
	const lower = content.toLowerCase();
	const suppressions = scanInlineSuppressions(content);
	for (const entry of sweepEntries()) {
		if (!isVerifyCheckSelected(entry.id) || !mayRun(entry, lower)) continue;
		let matches: ReturnType<CheckRegistration["fn"]>;
		try {
			matches = runBudgeted(entry.id, relPath, () => entry.fn(content, file));
		} catch (error) {
			recordVerifyInputDeferral(entry.id, { file: relPath, reason: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown check error" });
			continue;
		}
		for (const match of matches) {
			if (suppressions.size > 0 && directiveLineFor(entry.id.toLowerCase(), match.line, suppressions) !== null) continue;
			const key = `inline:${entry.id}`;
			const rows = ledger.sweep.get(key) ?? [];
			rows.push({ check: entry.id, file: relPath, line: match.line, message: match.text });
			ledger.sweep.set(key, rows);
		}
	}
}
