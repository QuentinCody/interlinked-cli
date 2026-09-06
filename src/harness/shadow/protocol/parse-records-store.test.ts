// Malformed corpus, part 6 — persisted store records: the dependency-tree
// cache row and the agent-writable local mirror binding (memo §8.1 exit gate).
// A parser proves SHAPE ONLY: no digest is recomputed, no backup handle
// resolved. An accepted record here is a well-formed record, not a trusted one
// — and `.interlinked/shadow-mirror.json` is agent-writable (memo §12.2), so
// its record is untrusted by construction.
//
// The four BROKER-INTERNAL rows this suite used to cover — the two backup
// records, the mirror upload row and the input bundle — moved to
// `interlinked-cloud` with their parsers in the 2026-09-04 public/private
// split; their cases moved with them.

import { describe, expect, it } from "vitest";
import type { ShadowParseOutcome } from "./parse-core-entries.js";
import { parseDependencyTreeCacheRecord, parseMirrorBinding } from "./parse-records-store.js";

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

function mirrorKey(): Record<string, unknown> {
	return { repository_id: "repo-1", session_id: "sess-1", kind: "synthetic_full_tree" };
}

function dependencyCacheRecord(): Record<string, unknown> {
	return {
		schema_version: 1,
		input_hash: HEX,
		image_manifest_digest: "sha256:cafe",
		npm_version: "10.8.1",
		registry_policy_digest: HEX,
		broker_scanner_policy_digest: HEX,
		tree_algo: "shadow-dependency-tree-v1",
		tree_hash: HEX,
		backup_handle: "backup-1",
		expires_at: STAMP,
		created_at: STAMP,
	};
}

function mirrorBinding(): Record<string, unknown> {
	return {
		schema_version: 1,
		mirror_key: mirrorKey(),
		last_known: { key: mirrorKey(), version: 3, base_ref: SHA, base_local_head: SHA },
	};
}

describe("parse-records-store — positive (must accept)", () => {
	it("P1: accepts a dependency cache record and returns a frozen own-data copy", () => {
		const raw = dependencyCacheRecord();
		const value = accepted(parseDependencyTreeCacheRecord(raw));
		expect(value.npm_version).toBe("10.8.1");
		expect(Object.isFrozen(value)).toBe(true);
		raw.npm_version = "0.0.0";
		expect(value.npm_version).toBe("10.8.1");
	});

	it("P2: accepts the agent-writable local mirror binding", () => {
		const value = accepted(parseMirrorBinding(mirrorBinding()));
		expect(value.last_known.base_ref).toBe(SHA);
		expect(value.mirror_key.kind).toBe("synthetic_full_tree");
	});
});

describe("parse-records-store — negative (must reject)", () => {
	it("N1: rejects a non-object and a non-cloneable wire value", () => {
		expect(parseDependencyTreeCacheRecord(null).ok).toBe(false);
		expect(parseMirrorBinding("binding").ok).toBe(false);
		expect(parseDependencyTreeCacheRecord({ fn: () => 1 }).ok).toBe(false);
	});

	it("N2: rejects an unknown field at the TOP level", () => {
		expect(reasonOf(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), extra: 1 }))).toContain(
			"unknown field",
		);
		expect(reasonOf(parseMirrorBinding({ ...mirrorBinding(), extra: 1 }))).toContain("unknown field");
	});

	it("N3: rejects an unknown field at a NESTED level", () => {
		const binding = mirrorBinding();
		binding.last_known = { key: mirrorKey(), version: 3, base_ref: SHA, base_local_head: SHA, extra: 1 };
		expect(reasonOf(parseMirrorBinding(binding))).toContain("unknown field");

		const nestedKey = mirrorBinding();
		nestedKey.mirror_key = { ...mirrorKey(), extra: 1 };
		expect(reasonOf(parseMirrorBinding(nestedKey))).toContain("unknown field");
	});

	it("N4: rejects an unknown schema version", () => {
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), schema_version: 2 }).ok).toBe(false);
		expect(parseMirrorBinding({ ...mirrorBinding(), schema_version: "1" }).ok).toBe(false);
	});

	it("N4b: rejects a wrong literal discriminator", () => {
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), tree_algo: "shadow-tree-v1" }).ok).toBe(false);
		expect(parseMirrorBinding({ ...mirrorBinding(), mirror_key: { ...mirrorKey(), kind: "partial_tree" } }).ok).toBe(
			false,
		);
	});

	it("N6: rejects an out-of-range or non-integer number", () => {
		const negativeVersion = mirrorBinding();
		negativeVersion.last_known = { key: mirrorKey(), version: -1, base_ref: SHA, base_local_head: SHA };
		expect(reasonOf(parseMirrorBinding(negativeVersion))).toContain("non-negative integer");
		const fractionalVersion = mirrorBinding();
		fractionalVersion.last_known = { key: mirrorKey(), version: 2.5, base_ref: SHA, base_local_head: SHA };
		expect(parseMirrorBinding(fractionalVersion).ok).toBe(false);
	});

	it("N7: rejects an empty-string brand — no empty-string sentinel is ever valid", () => {
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), npm_version: "" }).ok).toBe(false);
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), image_manifest_digest: "" }).ok).toBe(false);
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), backup_handle: "" }).ok).toBe(false);
		expect(parseMirrorBinding({ ...mirrorBinding(), mirror_key: { ...mirrorKey(), session_id: "" } }).ok).toBe(false);
	});

	it("N8: rejects a bad digest and a bad commit sha", () => {
		expect(reasonOf(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), tree_hash: "A".repeat(64) }))).toContain(
			"sha-256",
		);
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), input_hash: HEX.slice(1) }).ok).toBe(false);
		const binding = mirrorBinding();
		binding.last_known = { key: mirrorKey(), version: 3, base_ref: HEX, base_local_head: SHA };
		expect(reasonOf(parseMirrorBinding(binding))).toContain("40-hex");
	});

	it("N9: rejects a bad timestamp, including an impossible instant", () => {
		expect(reasonOf(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), expires_at: "soon" }))).toContain(
			"RFC3339",
		);
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), created_at: "2026-02-30T00:00:00Z" }).ok).toBe(
			false,
		);
		expect(parseDependencyTreeCacheRecord({ ...dependencyCacheRecord(), expires_at: "2026-01-01T00:60:00Z" }).ok).toBe(
			false,
		);
	});

	it("N13: rejects a missing required field", () => {
		const { backup_handle: _dropped, ...withoutHandle } = dependencyCacheRecord();
		expect(parseDependencyTreeCacheRecord(withoutHandle).ok).toBe(false);
		const { last_known: _also, ...withoutLastKnown } = mirrorBinding();
		expect(parseMirrorBinding(withoutLastKnown).ok).toBe(false);
	});
});
