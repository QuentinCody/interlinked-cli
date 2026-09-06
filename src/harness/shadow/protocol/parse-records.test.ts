// Malformed corpus, part 5 — configuration, environment, local freshness and
// mirror-lifecycle records (memo §8.1 exit gate: "rejects the complete
// malformed corpus"). A parser proves SHAPE ONLY: it never checks that a
// digest equals the bytes it claims, that a consent is still in force, or
// that a deletion actually happened at the provider. An accepted record here
// is a well-formed record, not a trusted one.

import { describe, expect, it } from "vitest";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import type { ShadowParseOutcome } from "./parse-core-entries.js";
import {
	parseDeletionReceipt,
	parseLocalFreshnessCheck,
	parseMirrorStatus,
	parseRetentionConsent,
	parseScannerPolicy,
	parseShadowEnv,
	parseShadowExecConfig,
} from "./parse-records.js";

const HEX = "a".repeat(64);
const SHA = "b".repeat(40);
const STAMP = "2026-09-04T12:00:00Z";

function reasonOf(outcome: { ok: true } | { ok: false; reason: string }): string {
	return outcome.ok ? "<accepted>" : outcome.reason;
}

function accepted<T>(outcome: ShadowParseOutcome<T>): T {
	if (!outcome.ok) throw new Error(`expected acceptance, got rejection: ${outcome.reason}`);
	return outcome.value;
}

function execConfig(): Record<string, unknown> {
	return {
		schema_version: 1,
		profile_id: "shadow-typecheck-v1",
		typecheck_strict: true,
		introduced_only: true,
		max_diagnostics: 500,
	};
}

function scannerPolicy(): Record<string, unknown> {
	return {
		schema_version: 1,
		scanner: "interlinked-shadow-scanner",
		binary_sha256: HEX,
		invocation_hash: HEX,
		ruleset_bytes_sha256: HEX,
		repo_config_effect: "ignored",
		on_error: "unavailable",
	};
}

function shadowEnv(): Record<string, unknown> {
	return {
		schema: "shadow-env-v1",
		image_manifest_digest: "sha256:deadbeef",
		verifier_sha256: HEX,
		argv: ["tsc", "--noEmit"],
		cwd: "/workspace",
		env_allowlist: ["PATH", "HOME"],
		provisioner_version: "1.4.0",
		registry_policy: { host: "registry.example", replace_registry_host: "always" },
		egress_policy_hash: HEX,
		broker_scanner_policy_digest: HEX,
		exec_config_hash: HEX,
		resource_limits: { ...SHADOW_LIMITS_V1 },
	};
}

function freshnessBinding(): Record<string, unknown> {
	return {
		base_local_head: SHA,
		local_head: SHA,
		input_hash: HEX,
		local_pre_tree_hash: HEX,
		local_overlay_manifest_hash: HEX,
		local_post_image_set_hash: HEX,
	};
}

function localFreshnessCheck(): Record<string, unknown> {
	return {
		schema_version: 1,
		claimed: freshnessBinding(),
		measured_from_disk: freshnessBinding(),
		matches: true,
		checked_at: STAMP,
	};
}

function retentionConsent(): Record<string, unknown> {
	return {
		schema_version: 1,
		repository_id: "repo-1",
		auto_disable_after_days: 30,
		auto_delete_after_further_days: 60,
		consented_by: "user-1",
		consented_at: STAMP,
	};
}

function mirrorStatus(): Record<string, unknown> {
	return {
		schema_version: 1,
		mirror_key: { repository_id: "repo-1", session_id: "sess-1", kind: "synthetic_full_tree" },
		state: "active",
		current: { key: { repository_id: "repo-1", session_id: "sess-1", kind: "synthetic_full_tree" }, version: 7 },
		retention: retentionConsent(),
	};
}

function deletionRequested(): Record<string, unknown> {
	return { schema_version: 1, state: "deletion_requested", provider_request_id: "prov-1", requested_at: STAMP };
}

function providerDeleted(): Record<string, unknown> {
	return {
		schema_version: 1,
		state: "provider_deleted",
		provider_request_id: "prov-1",
		requested_at: STAMP,
		provider_deleted_at: STAMP,
		restorable_until: STAMP,
		restoration_eligibility: "eligible",
		reconciliation: "pending",
	};
}

function windowElapsed(): Record<string, unknown> {
	return {
		schema_version: 1,
		state: "restore_window_elapsed_provider_absent",
		provider_request_id: "prov-1",
		requested_at: STAMP,
		provider_deleted_at: STAMP,
		restorable_until: null,
		restoration_eligibility: "unknown",
		reconciled_absent_at: STAMP,
	};
}

describe("parse-records — positive (must accept)", () => {
	it("P1: accepts an exec config and returns a frozen own-data copy", () => {
		const raw = execConfig();
		const value = accepted(parseShadowExecConfig(raw));
		expect(value.max_diagnostics).toBe(500);
		expect(Object.isFrozen(value)).toBe(true);
		raw.max_diagnostics = 9;
		expect(value.max_diagnostics).toBe(500);
	});

	it("P2: accepts a scanner policy carrying three distinct digests", () => {
		const value = accepted(parseScannerPolicy(scannerPolicy()));
		expect(value.scanner).toBe("interlinked-shadow-scanner");
		expect(value.on_error).toBe("unavailable");
	});

	it("P3: accepts a shadow env whose resource_limits equal the ONE limits object", () => {
		const value = accepted(parseShadowEnv(shadowEnv()));
		expect(value.argv).toEqual(["tsc", "--noEmit"]);
		expect(value.resource_limits.entries).toBe(SHADOW_LIMITS_V1.entries);
	});

	it("P4: accepts a local freshness check in both the matching and diverged states", () => {
		expect(parseLocalFreshnessCheck(localFreshnessCheck()).ok).toBe(true);
		expect(parseLocalFreshnessCheck({ ...localFreshnessCheck(), matches: false }).ok).toBe(true);
	});

	it("P5: accepts a retention consent with and without a delete stage", () => {
		expect(parseRetentionConsent(retentionConsent()).ok).toBe(true);
		expect(parseRetentionConsent({ ...retentionConsent(), auto_delete_after_further_days: null }).ok).toBe(true);
	});

	it("P6: accepts a mirror status with a current version and with none", () => {
		const value = accepted(parseMirrorStatus(mirrorStatus()));
		expect(value.state).toBe("active");
		expect(parseMirrorStatus({ ...mirrorStatus(), state: "quarantined", current: null }).ok).toBe(true);
	});

	it("P7: accepts all three deletion-receipt shapes", () => {
		expect(parseDeletionReceipt(deletionRequested()).ok).toBe(true);
		expect(parseDeletionReceipt(providerDeleted()).ok).toBe(true);
		expect(parseDeletionReceipt({ ...providerDeleted(), state: "restore_window_open" }).ok).toBe(true);
		expect(parseDeletionReceipt(windowElapsed()).ok).toBe(true);
	});
});

describe("parse-records — negative (must reject)", () => {
	it("N1: rejects a non-object and a non-cloneable wire value", () => {
		expect(parseShadowExecConfig(null).ok).toBe(false);
		expect(parseScannerPolicy([1]).ok).toBe(false);
		expect(parseShadowEnv("env").ok).toBe(false);
		expect(parseMirrorStatus({ fn: () => 1 }).ok).toBe(false);
	});

	it("N2: rejects an unknown field at the TOP level", () => {
		expect(reasonOf(parseShadowExecConfig({ ...execConfig(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseScannerPolicy({ ...scannerPolicy(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseShadowEnv({ ...shadowEnv(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseRetentionConsent({ ...retentionConsent(), extra: 1 }))).toContain("unknown field");
		expect(reasonOf(parseDeletionReceipt({ ...deletionRequested(), extra: 1 }))).toContain("unknown field");
	});

	it("N3: rejects an unknown field at a NESTED level", () => {
		const env = shadowEnv();
		env.registry_policy = { host: "registry.example", replace_registry_host: "always", extra: 1 };
		expect(reasonOf(parseShadowEnv(env))).toContain("unknown field");

		const withLimitExtra = shadowEnv();
		withLimitExtra.resource_limits = { ...SHADOW_LIMITS_V1, extra: 1 };
		expect(reasonOf(parseShadowEnv(withLimitExtra))).toContain("unknown field");

		const check = localFreshnessCheck();
		check.claimed = { ...freshnessBinding(), extra: 1 };
		expect(reasonOf(parseLocalFreshnessCheck(check))).toContain("unknown field");

		const status = mirrorStatus();
		status.mirror_key = { repository_id: "r", session_id: "s", kind: "synthetic_full_tree", extra: 1 };
		expect(reasonOf(parseMirrorStatus(status))).toContain("unknown field");
	});

	it("N4: rejects an unknown schema version", () => {
		expect(parseShadowExecConfig({ ...execConfig(), schema_version: 2 }).ok).toBe(false);
		expect(parseScannerPolicy({ ...scannerPolicy(), schema_version: 2 }).ok).toBe(false);
		expect(parseRetentionConsent({ ...retentionConsent(), schema_version: 0 }).ok).toBe(false);
		expect(parseShadowEnv({ ...shadowEnv(), schema: "shadow-env-v2" }).ok).toBe(false);
	});

	it("N4b: rejects a wrong literal discriminator or unknown union tag", () => {
		expect(parseShadowExecConfig({ ...execConfig(), profile_id: "shadow-typecheck-v2" }).ok).toBe(false);
		expect(parseShadowExecConfig({ ...execConfig(), introduced_only: false }).ok).toBe(false);
		expect(parseScannerPolicy({ ...scannerPolicy(), repo_config_effect: "honored" }).ok).toBe(false);
		expect(reasonOf(parseDeletionReceipt({ ...deletionRequested(), state: "deleted" }))).toContain("state");
		expect(parseMirrorStatus({ ...mirrorStatus(), state: "melted" }).ok).toBe(false);
	});

	it("N5: rejects a field belonging to a DIFFERENT variant of the same union", () => {
		// `reconciliation` lives on provider_deleted / restore_window_open only.
		expect(reasonOf(parseDeletionReceipt({ ...windowElapsed(), reconciliation: "pending" }))).toContain(
			"unknown field",
		);
		// `reconciled_absent_at` lives on the elapsed shape only.
		expect(reasonOf(parseDeletionReceipt({ ...providerDeleted(), reconciled_absent_at: STAMP }))).toContain(
			"unknown field",
		);
		// deletion_requested carries the request and nothing measured yet.
		expect(reasonOf(parseDeletionReceipt({ ...deletionRequested(), provider_deleted_at: STAMP }))).toContain(
			"unknown field",
		);
	});

	it("N6: rejects an out-of-range or non-integer number", () => {
		expect(parseShadowExecConfig({ ...execConfig(), max_diagnostics: -1 }).ok).toBe(false);
		expect(parseShadowExecConfig({ ...execConfig(), max_diagnostics: 1.5 }).ok).toBe(false);
		expect(
			parseShadowExecConfig({ ...execConfig(), max_diagnostics: SHADOW_LIMITS_V1.diagnostics_count + 1 }).ok,
		).toBe(false);
		expect(parseRetentionConsent({ ...retentionConsent(), auto_disable_after_days: -1 }).ok).toBe(false);
		expect(parseRetentionConsent({ ...retentionConsent(), auto_disable_after_days: 1_000_000 }).ok).toBe(false);
		expect(parseMirrorStatus({ ...mirrorStatus(), current: { key: mirrorStatus().mirror_key, version: -1 } }).ok).toBe(
			false,
		);
	});

	it("N7: rejects an empty-string brand — no empty-string sentinel is ever valid", () => {
		expect(parseShadowEnv({ ...shadowEnv(), image_manifest_digest: "" }).ok).toBe(false);
		expect(parseShadowEnv({ ...shadowEnv(), provisioner_version: "" }).ok).toBe(false);
		expect(parseShadowEnv({ ...shadowEnv(), cwd: "" }).ok).toBe(false);
		expect(parseShadowEnv({ ...shadowEnv(), argv: [""] }).ok).toBe(false);
		expect(parseRetentionConsent({ ...retentionConsent(), repository_id: "" }).ok).toBe(false);
		expect(parseDeletionReceipt({ ...deletionRequested(), provider_request_id: "" }).ok).toBe(false);
	});

	it("N8: rejects a bad digest", () => {
		expect(reasonOf(parseScannerPolicy({ ...scannerPolicy(), binary_sha256: "A".repeat(64) }))).toContain("sha-256");
		expect(parseScannerPolicy({ ...scannerPolicy(), invocation_hash: HEX.slice(1) }).ok).toBe(false);
		expect(parseShadowEnv({ ...shadowEnv(), egress_policy_hash: 1 }).ok).toBe(false);
		expect(parseLocalFreshnessCheck({ ...localFreshnessCheck(), claimed: { ...freshnessBinding(), input_hash: "x" } }).ok).toBe(
			false,
		);
	});

	it("N9: rejects a bad timestamp, including an impossible instant", () => {
		expect(reasonOf(parseRetentionConsent({ ...retentionConsent(), consented_at: "yesterday" }))).toContain("RFC3339");
		expect(parseRetentionConsent({ ...retentionConsent(), consented_at: "2026-02-30T00:00:00Z" }).ok).toBe(false);
		expect(parseLocalFreshnessCheck({ ...localFreshnessCheck(), checked_at: "2026-01-01T24:00:00Z" }).ok).toBe(false);
		expect(parseDeletionReceipt({ ...providerDeleted(), restorable_until: "2026-13-01T00:00:00Z" }).ok).toBe(false);
	});

	it("N10: rejects a null where a value is required and a missing required field", () => {
		expect(parseShadowExecConfig({ ...execConfig(), typecheck_strict: null }).ok).toBe(false);
		expect(parseMirrorStatus({ ...mirrorStatus(), retention: null }).ok).toBe(false);
		const { matches: _dropped, ...withoutMatches } = localFreshnessCheck();
		expect(parseLocalFreshnessCheck(withoutMatches).ok).toBe(false);
	});

	it("N11: rejects a resource_limits block that disagrees with the ONE limits object", () => {
		const env = shadowEnv();
		env.resource_limits = { ...SHADOW_LIMITS_V1, entries: SHADOW_LIMITS_V1.entries + 1 };
		expect(parseShadowEnv(env).ok).toBe(false);
	});
});
