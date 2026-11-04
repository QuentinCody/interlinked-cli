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
import { toIssues } from "./file-checks-shared.js";

/**
 * Endpoint-security pack, agent-laziness batch, test-hygiene batch, cross-file
 * batch, and demo-data batch. Mirrors the inline blocks from "=== Phase B
 * endpoint-security pack (2026-05) ===" through "=== Batch 8: demo-data
 * checks ===".
 */
export function runEndpointAndLazinessChecks(ctx: FileCheckContext): void {
	const { content, file, relPath, r } = ctx;

	// === Phase B endpoint-security pack (2026-05) ===
	// Five PostToolUse warning detectors run through a registry-call-site
	// shim (`harness/check-registry/endpoint-security-adapters.ts`) so they
	// fit the standard `(content, filePath) => InlineMatch[]` shape while
	// internally loading RouteMap + SecurityConfig + SanitizerRegistry.
	r.endpointAuthMissing.push(
		...toIssues("endpoint_auth_missing", relPath, adaptEndpointAuthMissing, content, file),
	);
	r.endpointIdorShape.push(
		...toIssues("endpoint_idor_shape", relPath, adaptEndpointIdorShape, content, file),
	);
	r.endpointMissingTenantFilter.push(
		...toIssues(
			"endpoint_missing_tenant_filter",
			relPath,
			adaptEndpointMissingTenantFilter, content, file,
		),
	);
	r.endpointSsrfShape.push(
		...toIssues("endpoint_ssrf_shape", relPath, adaptEndpointSsrfShape, content, file),
	);
	r.endpointMassAssignment.push(
		...toIssues(
			"endpoint_mass_assignment",
			relPath,
			adaptEndpointMassAssignment, content, file,
		),
	);

	// === Batch 1: agent-laziness checks ===
	r.agentThumbprintProse.push(
		...toIssues("agent_thumbprint_prose", relPath, checkAgentThumbprintProse, content, file),
	);
	r.stubNotImplementedThrow.push(
		...toIssues(
			"stub_not_implemented_throw",
			relPath,
			checkStubNotImplementedThrow, content, file,
		),
	);
	r.deadBranchLiteral.push(
		...toIssues("dead_branch_literal", relPath, checkDeadBranchLiteral, content, file),
	);
	r.fileLevelSuppression.push(
		...toIssues("file_level_suppression", relPath, checkFileLevelSuppression, content, file),
	);
	r.untestableTimeInSource.push(
		...toIssues(
			"untestable_time_in_source",
			relPath,
			checkUntestableTimeInSource, content, file,
		),
	);
	r.doubleCastUnknown.push(
		...toIssues("double_cast_unknown", relPath, checkDoubleCastUnknown, content, file),
	);
	r.typeSmuggling.push(
		...toIssues("type_smuggling", relPath, checkTypeSmuggling, content, file),
	);
	r.unionWidenedWithString.push(
		...toIssues(
			"union_widened_with_string",
			relPath,
			checkUnionWidenedWithString, content, file,
		),
	);
	r.nodeenvBranchInProd.push(
		...toIssues("nodeenv_branch_in_prod", relPath, checkNodeEnvBranchInProd, content, file),
	);
	r.fetchWithoutTimeout.push(
		...toIssues("fetch_without_timeout", relPath, checkFetchWithoutTimeout, content, file),
	);
	r.unboundedPromiseAll.push(
		...toIssues("unbounded_promise_all", relPath, checkUnboundedPromiseAll, content, file),
	);
	r.syncIoOnHotPath.push(
		...toIssues("sync_io_on_hot_path", relPath, checkSyncIoOnHotPath, content, file),
	);

	// === Batch 2: test-hygiene checks ===
	r.duplicateTestNames.push(
		...toIssues("duplicate_test_names", relPath, checkDuplicateTestNames, content, file),
	);
	r.realIoInTests.push(
		...toIssues("real_io_in_tests", relPath, checkRealIoInTests, content, file),
	);
	r.testNondeterminism.push(
		...toIssues("test_nondeterminism", relPath, checkTestNondeterminism, content, file),
	);
	r.hardcodedTimeoutInTests.push(
		...toIssues(
			"hardcoded_timeout_in_tests",
			relPath,
			checkHardcodedTimeoutInTests, content, file,
		),
	);
	r.testMissingSutImport.push(
		...toIssues(
			"test_missing_sut_import",
			relPath,
			checkTestMissingSutImport, content, file,
		),
	);
	r.mockingTheSutSelf.push(
		...toIssues("mocking_the_sut_self", relPath, checkMockingTheSutSelf, content, file),
	);
	r.testSubprocessDefaultTimeout.push(
		...toIssues(
			"test_subprocess_default_timeout",
			relPath,
			checkTestSubprocessDefaultTimeout, content, file,
		),
	);
	r.mockOnlyTest.push(...toIssues("mock_only_test", relPath, checkMockOnlyTest, content, file));
	r.happyPathOnlyTest.push(
		...toIssues("happy_path_only_test", relPath, checkHappyPathOnlyTest, content, file),
	);
	r.introvertedTest.push(
		...toIssues("introverted_test", relPath, checkIntrovertedTest, content, file),
	);
	r.testLegitimacy.push(
		...toIssues("test_legitimacy", relPath, checkTestLegitimacy, content, file),
	);
	r.procfsProbeInTest.push(
		...toIssues("procfs_probe_in_test", relPath, detectProcfsProbeInTest, content, file),
	);

	// === Batch 5: cross-file checks ===
	r.emptyBodyHandler.push(
		...toIssues("empty_body_handler", relPath, checkEmptyBodyHandler, content, file),
	);
	r.listenerPairing.push(
		...toIssues("listener_pairing", relPath, checkListenerPairing, content, file),
	);
	r.schemaTypeDrift.push(
		...toIssues("schema_type_drift", relPath, checkSchemaTypeDrift, content, file),
	);
	r.migrationParity.push(
		...toIssues("migration_parity", relPath, checkMigrationParity, content, file),
	);

	// === Batch 8: demo-data checks ===
	r.demoDataUnmarked.push(
		...toIssues("demo_data_unmarked", relPath, checkDemoDataUnmarked, content, file),
	);
	r.silentDemoFallback.push(
		...toIssues("silent_demo_fallback", relPath, checkSilentDemoFallback, content, file),
	);
	r.demoRuntimeMissingBanner.push(
		...toIssues(
			"demo_runtime_missing_banner",
			relPath,
			checkDemoRuntimeMissingBanner, content, file,
		),
	);
	r.placeholderDataInUi.push(
		...toIssues("placeholder_data_in_ui", relPath, checkPlaceholderDataInUi, content, file),
	);
}
