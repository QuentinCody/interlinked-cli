// ===========================================
// Shadow protocol v1 — the ONE limits object (memo §12.2)
// ===========================================
// One versioned limits object, used by daemon and broker, applied BEFORE
// allocation and BEFORE hashing. Over any limit → `unavailable (limits)`.
// These are WIRE limits: performance ceilings (the bootstrap benchmark, the
// restore timings) are plan acceptance criteria and deliberately do not live
// here — a measured wall-time belongs to a spike, not to a protocol.

import type { ShadowLimitsV1 } from "./types-binding.js";

export const SHADOW_LIMITS_V1: ShadowLimitsV1 = {
	schema_version: 1,
	total_request_bytes: 67_108_864,
	overlay_bytes: 52_428_800,
	post_image_set_bytes: 52_428_800,
	single_entry_bytes: 10_485_760,
	entries: 100_000,
	path_bytes: 4_096,
	path_component_bytes: 255,
	command_stdin_toolinput_bytes: 1_048_576,
	diagnostics_count: 10_000,
	diagnostics_bytes: 5_242_880,
	stdio_head_bytes: 65_536,
	outcome_record_bytes: 8_388_608,
	git_response_compressed_bytes: 268_435_456,
	git_logical_object_bytes: 1_073_741_824,
	git_temp_bytes: 134_217_728,
	working_tree_bytes: 536_870_912,
	dependency_tree_bytes: 805_306_368,
	backup_archive_bytes: 268_435_456,
	manifest_object_bytes: 33_554_432,
	missing_blobs_page_size: 500,
	upload_blob_bytes: 10_485_760,
	upload_aggregate_bytes: 536_870_912,
	upload_ttl_seconds: 3_600,
	sync_eligible_overlay_bytes: 2_097_152,
	sync_eligible_post_image_bytes: 1_048_576,
	sync_eligible_entries: 200,
	sync_eligible_missing_blobs: 64,
	sync_eligible_pages: 1,
	sync_eligible_http_requests: 80,
};

/** What one request would cost the SYNCHRONOUS lane, in the two currencies
 *  that bound the hook budget: bytes AND operations. */
export interface SyncCost {
	overlay_bytes: number;
	post_image_bytes: number;
	entries: number;
	missing_blobs: number;
	pages: number;
	http_requests: number;
}
export type SyncEligibleCap =
	| "sync_eligible_overlay_bytes"
	| "sync_eligible_post_image_bytes"
	| "sync_eligible_entries"
	| "sync_eligible_missing_blobs"
	| "sync_eligible_pages"
	| "sync_eligible_http_requests";
export type SyncEligibility = { eligible: true } | { eligible: false; exceeded: SyncEligibleCap };

const SYNC_CAPS: readonly (readonly [keyof SyncCost, SyncEligibleCap])[] = [
	["overlay_bytes", "sync_eligible_overlay_bytes"],
	["post_image_bytes", "sync_eligible_post_image_bytes"],
	["entries", "sync_eligible_entries"],
	["missing_blobs", "sync_eligible_missing_blobs"],
	["pages", "sync_eligible_pages"],
	["http_requests", "sync_eligible_http_requests"],
];

/** Sync-lane eligibility. A 2 MiB overlay of tiny files is thousands of PUTs
 *  and immutable copies, so OPERATIONS are capped alongside bytes; above any
 *  cap the core lane declines rather than inventing an aggregate transport
 *  (memo §8.7 — Workstream 04 may add one after Plan 02 measures it). */
export function syncEligibility(cost: SyncCost, limits: ShadowLimitsV1 = SHADOW_LIMITS_V1): SyncEligibility {
	for (const [costKey, capKey] of SYNC_CAPS) {
		if (cost[costKey] > limits[capKey]) return { eligible: false, exceeded: capKey };
	}
	return { eligible: true };
}
