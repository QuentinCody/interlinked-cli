// ===========================================
// Per-file check battery — endpoint-security / agent-laziness / test-hygiene
// ===========================================
// Extracted from `file-checks.ts` to keep that orchestrator under the
// 1000-line file-size threshold. Covers the Phase B endpoint-security pack,
// the agent-laziness batch, the test-hygiene batch, the cross-file batch, and
// the demo-data batch. Behaviour-preserving: same checks, same per-bucket
// order.

import {
	adaptEndpointAuthMissing,
	adaptEndpointIdorShape,
	adaptEndpointMassAssignment,
	adaptEndpointMissingTenantFilter,
	adaptEndpointSsrfShape,
} from "../../harness/check-registry/endpoint-security-adapters.js";
import {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkDoubleCastUnknown,
	checkDuplicateTestNames,
	checkEmptyBodyHandler,
	checkFetchWithoutTimeout,
	checkFileLevelSuppression,
	checkHappyPathOnlyTest,
	checkHardcodedTimeoutInTests,
	checkIntrovertedTest,
	checkListenerPairing,
	checkMigrationParity,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkNodeEnvBranchInProd,
	checkPlaceholderDataInUi,
	checkRealIoInTests,
	checkSchemaTypeDrift,
	checkSilentDemoFallback,
	checkStubNotImplementedThrow,
	checkSyncIoOnHotPath,
	checkTestMissingSutImport,
	checkTestLegitimacy,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
	checkTypeSmuggling,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
	checkUntestableTimeInSource,
} from "../../harness/generic-checks.js";
import { detectProcfsProbeInTest } from "../../harness/checks/procfs-probe.js";
import type { FileCheckContext } from "./file-checks-shared.js";
import { contentCheckRunner } from "./file-checks-content.js";

/**
 * Endpoint-security pack, agent-laziness batch, test-hygiene batch, cross-file
 * batch, and demo-data batch. Mirrors the inline blocks from "=== Phase B
 * endpoint-security pack (2026-05) ===" through "=== Batch 8: demo-data
 * checks ===".
 */
export function runEndpointAndLazinessChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);

	// === Phase B endpoint-security pack (2026-05) ===
	// Five PostToolUse warning detectors run through a registry-call-site
	// shim (`harness/check-registry/endpoint-security-adapters.ts`) so they
	// fit the standard `(content, filePath) => InlineMatch[]` shape while
	// internally loading RouteMap + SecurityConfig + SanitizerRegistry.
	runCheck("endpoint_auth_missing", r.endpointAuthMissing, adaptEndpointAuthMissing);
	runCheck("endpoint_idor_shape", r.endpointIdorShape, adaptEndpointIdorShape);
	runCheck("endpoint_missing_tenant_filter", r.endpointMissingTenantFilter, adaptEndpointMissingTenantFilter);
	runCheck("endpoint_ssrf_shape", r.endpointSsrfShape, adaptEndpointSsrfShape);
	runCheck("endpoint_mass_assignment", r.endpointMassAssignment, adaptEndpointMassAssignment);

	// === Batch 1: agent-laziness checks ===
	runCheck("agent_thumbprint_prose", r.agentThumbprintProse, checkAgentThumbprintProse);
	runCheck("stub_not_implemented_throw", r.stubNotImplementedThrow, checkStubNotImplementedThrow);
	runCheck("dead_branch_literal", r.deadBranchLiteral, checkDeadBranchLiteral);
	runCheck("file_level_suppression", r.fileLevelSuppression, checkFileLevelSuppression);
	runCheck("untestable_time_in_source", r.untestableTimeInSource, checkUntestableTimeInSource);
	runCheck("double_cast_unknown", r.doubleCastUnknown, checkDoubleCastUnknown);
	runCheck("type_smuggling", r.typeSmuggling, checkTypeSmuggling);
	runCheck("union_widened_with_string", r.unionWidenedWithString, checkUnionWidenedWithString);
	runCheck("nodeenv_branch_in_prod", r.nodeenvBranchInProd, checkNodeEnvBranchInProd);
	runCheck("fetch_without_timeout", r.fetchWithoutTimeout, checkFetchWithoutTimeout);
	runCheck("unbounded_promise_all", r.unboundedPromiseAll, checkUnboundedPromiseAll);
	runCheck("sync_io_on_hot_path", r.syncIoOnHotPath, checkSyncIoOnHotPath);

	runTestAndDemoChecks(ctx);
}

function runTestAndDemoChecks(ctx: FileCheckContext): void {
	const { r } = ctx;
	const runCheck = contentCheckRunner(ctx);
	runCheck("duplicate_test_names", r.duplicateTestNames, checkDuplicateTestNames);
	runCheck("real_io_in_tests", r.realIoInTests, checkRealIoInTests);
	runCheck("test_nondeterminism", r.testNondeterminism, checkTestNondeterminism);
	runCheck("hardcoded_timeout_in_tests", r.hardcodedTimeoutInTests, checkHardcodedTimeoutInTests);
	runCheck("test_missing_sut_import", r.testMissingSutImport, checkTestMissingSutImport);
	runCheck("mocking_the_sut_self", r.mockingTheSutSelf, checkMockingTheSutSelf);
	runCheck("test_subprocess_default_timeout", r.testSubprocessDefaultTimeout, checkTestSubprocessDefaultTimeout);
	runCheck("mock_only_test", r.mockOnlyTest, checkMockOnlyTest);
	runCheck("happy_path_only_test", r.happyPathOnlyTest, checkHappyPathOnlyTest);
	runCheck("introverted_test", r.introvertedTest, checkIntrovertedTest);
	runCheck("test_legitimacy", r.testLegitimacy, checkTestLegitimacy);
	runCheck("procfs_probe_in_test", r.procfsProbeInTest, detectProcfsProbeInTest);

	// === Batch 5: cross-file checks ===
	runCheck("empty_body_handler", r.emptyBodyHandler, checkEmptyBodyHandler);
	runCheck("listener_pairing", r.listenerPairing, checkListenerPairing);
	runCheck("schema_type_drift", r.schemaTypeDrift, checkSchemaTypeDrift);
	runCheck("migration_parity", r.migrationParity, checkMigrationParity);

	// === Batch 8: demo-data checks ===
	runCheck("demo_data_unmarked", r.demoDataUnmarked, checkDemoDataUnmarked);
	runCheck("silent_demo_fallback", r.silentDemoFallback, checkSilentDemoFallback);
	runCheck("demo_runtime_missing_banner", r.demoRuntimeMissingBanner, checkDemoRuntimeMissingBanner);
	runCheck("placeholder_data_in_ui", r.placeholderDataInUi, checkPlaceholderDataInUi);
}
