import { nonNull } from "../../lib/non-null.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./default-config.js";

export type OptionalSectionKey = "plan_capture" | "git_session_scope_gate" | "tsc_overlay"
	| "per_edit_coverage" | "per_edit_mutation" | "trajectory_shadow" | "scratchpad_guard"
	| "spec_checks" | "edit_contract" | "verification_stop_checks" | "scratchpad_archive"
	| "baseline_autofold" | "mutation_directed_strict_profile" | "commit_cadence"
	| "diff_aware" | "project_wide_checks";

/** Used only when an override supplies a section missing from the input config. */
export const SECTION_DEFAULTS: { [K in OptionalSectionKey]: NonNullable<GuardRulesConfig[K]> } = {
	plan_capture: DEFAULT_CONFIG.plan_capture ?? { enabled: false, parse_userprompt: false },
	git_session_scope_gate: DEFAULT_CONFIG.git_session_scope_gate ?? { enabled: false, mode: "off" },
	tsc_overlay: DEFAULT_CONFIG.tsc_overlay ?? { mode: "sidecar" },
	per_edit_coverage: nonNull(DEFAULT_CONFIG.per_edit_coverage),
	per_edit_mutation: nonNull(DEFAULT_CONFIG.per_edit_mutation),
	trajectory_shadow: nonNull(DEFAULT_CONFIG.trajectory_shadow),
	scratchpad_guard: DEFAULT_CONFIG.scratchpad_guard ?? {},
	spec_checks: nonNull(DEFAULT_CONFIG.spec_checks),
	edit_contract: DEFAULT_CONFIG.edit_contract ?? {},
	verification_stop_checks: nonNull(DEFAULT_CONFIG.verification_stop_checks),
	scratchpad_archive: DEFAULT_CONFIG.scratchpad_archive ?? {},
	baseline_autofold: DEFAULT_CONFIG.baseline_autofold ?? {},
	mutation_directed_strict_profile: DEFAULT_CONFIG.mutation_directed_strict_profile ?? { enabled: false },
	commit_cadence: nonNull(DEFAULT_CONFIG.commit_cadence),
	diff_aware: nonNull(DEFAULT_CONFIG.diff_aware),
	project_wide_checks: nonNull(DEFAULT_CONFIG.project_wide_checks),
};

type PartialSectionKey = OptionalSectionKey | "curl_mcp_detection" | "error_memory" | "structural_checks";
type ScannerConfig = NonNullable<GuardRulesConfig["content_scanner"]>;
type ScannerNestedKey = "local" | "huggingface" | "custom_http" | "scan_points";
export type ContentScannerOverrides = Omit<Partial<ScannerConfig>, ScannerNestedKey> & {
	[K in ScannerNestedKey]?: Partial<ScannerConfig[K]>;
};

/** Merge inputs may omit individual settings; the loaded config remains complete. */
export type GuardRulesOverrides = Omit<Partial<GuardRulesConfig>, PartialSectionKey | "content_scanner" | "quality_checks"> & {
	[K in PartialSectionKey]?: Partial<NonNullable<GuardRulesConfig[K]>>;
} & {
	content_scanner?: ContentScannerOverrides;
	quality_checks?: Record<string, Partial<QualityCheckConfig>>;
};

/** Committed quality-check entries are validated field by field before use. */
export type TeamRulesOverrides = Omit<GuardRulesOverrides, "quality_checks"> & { quality_checks?: unknown };
