import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1, syncEligibility } from "./limits.js";

const withinCaps = {
	overlay_bytes: 1024,
	post_image_bytes: 512,
	entries: 4,
	missing_blobs: 2,
	pages: 1,
	http_requests: 10,
};

describe("limits — positive (must hold)", () => {
	it("P1: the wire limits are the memo's pinned numbers, in ONE object", () => {
		expect(SHADOW_LIMITS_V1.schema_version).toBe(1);
		expect(SHADOW_LIMITS_V1.total_request_bytes).toBe(64 * 1024 * 1024);
		expect(SHADOW_LIMITS_V1.overlay_bytes).toBe(50 * 1024 * 1024);
		expect(SHADOW_LIMITS_V1.entries).toBe(100_000);
		expect(SHADOW_LIMITS_V1.path_bytes).toBe(4096);
		expect(SHADOW_LIMITS_V1.path_component_bytes).toBe(255);
	});

	it("P2: a small request is sync-eligible", () => {
		expect(syncEligibility(withinCaps)).toEqual({ eligible: true });
	});

	it("P3: every sync cap is at its boundary — eligible AT the cap", () => {
		expect(
			syncEligibility({
				overlay_bytes: SHADOW_LIMITS_V1.sync_eligible_overlay_bytes,
				post_image_bytes: SHADOW_LIMITS_V1.sync_eligible_post_image_bytes,
				entries: SHADOW_LIMITS_V1.sync_eligible_entries,
				missing_blobs: SHADOW_LIMITS_V1.sync_eligible_missing_blobs,
				pages: SHADOW_LIMITS_V1.sync_eligible_pages,
				http_requests: SHADOW_LIMITS_V1.sync_eligible_http_requests,
			}),
		).toEqual({ eligible: true });
	});
});

describe("limits — negative (must decline)", () => {
	it("N1: one byte over any BYTE cap declines, naming the cap", () => {
		expect(syncEligibility({ ...withinCaps, overlay_bytes: SHADOW_LIMITS_V1.sync_eligible_overlay_bytes + 1 })).toEqual({
			eligible: false,
			exceeded: "sync_eligible_overlay_bytes",
		});
		expect(
			syncEligibility({ ...withinCaps, post_image_bytes: SHADOW_LIMITS_V1.sync_eligible_post_image_bytes + 1 }),
		).toEqual({ eligible: false, exceeded: "sync_eligible_post_image_bytes" });
	});

	it("N2: one OPERATION over any operation cap declines — bytes alone do not bound the hook budget", () => {
		expect(syncEligibility({ ...withinCaps, entries: SHADOW_LIMITS_V1.sync_eligible_entries + 1 })).toEqual({
			eligible: false,
			exceeded: "sync_eligible_entries",
		});
		expect(syncEligibility({ ...withinCaps, missing_blobs: SHADOW_LIMITS_V1.sync_eligible_missing_blobs + 1 })).toEqual({
			eligible: false,
			exceeded: "sync_eligible_missing_blobs",
		});
		expect(syncEligibility({ ...withinCaps, pages: SHADOW_LIMITS_V1.sync_eligible_pages + 1 })).toEqual({
			eligible: false,
			exceeded: "sync_eligible_pages",
		});
		expect(syncEligibility({ ...withinCaps, http_requests: SHADOW_LIMITS_V1.sync_eligible_http_requests + 1 })).toEqual({
			eligible: false,
			exceeded: "sync_eligible_http_requests",
		});
	});
});
