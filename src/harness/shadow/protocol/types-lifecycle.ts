// interlinked-tdd: exempt — type-only module (no runtime surface); Plan 05B
// owns the state machine that drives these records.
// ===========================================
// Shadow protocol v1 — mirror lifecycle, deletion receipts, retention
// ===========================================
// public API — reserved for Plan 05B (init / status / disable / delete and
// retention). Declared here so the authoring lane's records cannot grow a
// second, incompatible notion of "this mirror is gone".

import type { MirrorKeyV1, MirrorVersionRef, OpaqueId, Rfc3339 } from "./types-core.js";

export type MirrorState =
	| "active"
	| "disabled"
	| "quarantined"
	| "deletion_requested"
	| "provider_deleted"
	| "restore_window_open"
	| "restore_window_elapsed_provider_absent";

export type RestorationEligibility = "eligible" | "ineligible_fork_network" | "unknown";

export type DeletionReceipt =
	| { schema_version: 1; state: "deletion_requested"; provider_request_id: string; requested_at: Rfc3339 }
	| {
			schema_version: 1;
			state: "provider_deleted" | "restore_window_open";
			provider_request_id: string;
			requested_at: Rfc3339;
			provider_deleted_at: Rfc3339;
			restorable_until: Rfc3339 | null;
			restoration_eligibility: RestorationEligibility;
			reconciliation: "pending" | "confirmed" | "failed";
	  }
	| {
			schema_version: 1;
			state: "restore_window_elapsed_provider_absent";
			provider_request_id: string;
			requested_at: Rfc3339;
			provider_deleted_at: Rfc3339;
			restorable_until: Rfc3339 | null;
			restoration_eligibility: RestorationEligibility;
			reconciled_absent_at: Rfc3339;
	  };

export interface RetentionConsentV1 {
	schema_version: 1;
	repository_id: OpaqueId;
	auto_disable_after_days: number;
	auto_delete_after_further_days: number | null;
	consented_by: OpaqueId;
	consented_at: Rfc3339;
}

export interface MirrorStatusV1 {
	schema_version: 1;
	mirror_key: MirrorKeyV1;
	state: MirrorState;
	current: MirrorVersionRef | null;
	retention: RetentionConsentV1;
}
