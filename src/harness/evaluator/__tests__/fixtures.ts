import { getDefaultConfig } from "../../rules-loader.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../../types.js";

/** A complete, inert config for isolated guard tests; each case enables its own guard. */
export function makeGuardRules(): GuardRulesConfig {
	const defaults = getDefaultConfig();
	return {
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: { ...defaults.curl_mcp_detection, enabled: false },
		quality_checks: {},
		structural_checks: { ...defaults.structural_checks, enabled: false },
		error_memory: { ...defaults.error_memory, enabled: false },
		taint_tracking: { ...defaults.taint_tracking, enabled: false },
		output_scanning: { ...defaults.output_scanning, enabled: false },
	};
}

export function makeQualityCheck(overrides: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return { enabled: false, file_types: [], timeout_ms: 1000, severity: "warning", ...overrides };
}
