// ===========================================
// Operational check deferrals
// ===========================================
// These ids mean a check produced no verdict because execution capacity or
// another operational dependency was unavailable. They stay in structured
// check telemetry and remain model-visible as NOT CHECKED, but they are not
// source-code feedback: editing the target cannot resolve them.

const OPERATIONAL_CHECK_DEFERRAL_IDS: ReadonlySet<string> = new Set([
	"affected_tests_deferred",
	"external_check_deferred",
	"project_tests_deferred",
	"project_typecheck_deferred",
]);

export function isOperationalCheckDeferral(checkId: string): boolean {
	return OPERATIONAL_CHECK_DEFERRAL_IDS.has(checkId);
}
