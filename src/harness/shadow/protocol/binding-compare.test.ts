import { describe, expect, it } from "vitest";
import {
	asNonEmptyMismatches,
	type BrokerAuthorityViewV1,
	checkLocalFreshness,
	compareBindings,
	dependencyCacheRecordHash,
	FRESHNESS_FIELDS,
	type MeasuredExecutionViewV1,
} from "./binding-compare.js";
import type {
	ExpectedExecutionPolicyV1,
	ShadowExecutionClaimV1,
	ShadowFreshnessBinding,
} from "./types-binding.js";
import type { DependencyTreeCacheRecordV1, ResolvedDependencyBindingV1 } from "./types-core.js";
import { DEPENDENCY_TREE_ALGO, OVERLAY_ALGO, POST_IMAGE_ALGO, TREE_ALGO } from "./types-core.js";
import type { BindingFieldMismatchV1 } from "./types-outcome.js";

function brand<T extends string>(value: string): T {
	// SAFETY: test fixtures only — a brand is a nominal label on a string, and
	// these values never leave the test file.
	return value as T;
}

/** The BROKER's own view of the mirror — the identity authority. */
const AUTHORITY: BrokerAuthorityViewV1 = {
	mirror_key: { repository_id: brand("repo-1"), session_id: brand("sess-1"), kind: "synthetic_full_tree" },
	version: 7,
	base_ref: brand("a".repeat(40)),
};

const CLAIM: ShadowExecutionClaimV1 = {
	mirror: { key: { repository_id: brand("repo-1"), session_id: brand("sess-1"), kind: "synthetic_full_tree" }, version: 7 },
	base_ref: brand("a".repeat(40)),
	tree_algo: TREE_ALGO,
	post_image_algo: POST_IMAGE_ALGO,
	overlay_algo: OVERLAY_ALGO,
	overlay_manifest_hash: brand("omh"),
	overlay_bytes_hash: brand("obh"),
	pre_tree_hash: brand("pre"),
	post_image_set_hash: brand("pis"),
	post_tree_hash: brand("post"),
	dependencies: { mode: "npm-v1", input_hash: brand("dep-in") },
};

const POLICY: ExpectedExecutionPolicyV1 = {
	tree_algo: TREE_ALGO,
	post_image_algo: POST_IMAGE_ALGO,
	overlay_algo: OVERLAY_ALGO,
	overlay_manifest_hash: brand("omh"),
	env_digest: brand("env"),
	exec_config_hash: brand("cfg"),
	broker_scanner_policy_digest: brand("scan"),
	deadline_at: brand("2026-09-03T00:00:00Z"),
};

const MEASURED: MeasuredExecutionViewV1 = {
	mirror: { key: { repository_id: brand("repo-1"), session_id: brand("sess-1"), kind: "synthetic_full_tree" }, version: 7 },
	base_ref: brand("a".repeat(40)),
	tree_algo: TREE_ALGO,
	post_image_algo: POST_IMAGE_ALGO,
	overlay_algo: OVERLAY_ALGO,
	overlay_manifest_hash: brand("omh"),
	overlay_bytes_hash: brand("obh"),
	pre_tree_hash: brand("pre"),
	post_image_set_hash: brand("pis"),
	post_tree_hash: brand("post"),
	dependencies: { mode: "npm-v1", source: "fresh", input_hash: brand("dep-in"), tree_algo: DEPENDENCY_TREE_ALGO, tree_hash: brand("dep-tree") },
	env_digest: brand("env"),
	exec_config_hash: brand("cfg"),
};

/** The broker's IMMUTABLE record for the cached dependency tree. */
const CACHE_RECORD: DependencyTreeCacheRecordV1 = {
	schema_version: 1,
	input_hash: brand("dep-in"),
	image_manifest_digest: "sha256:image",
	npm_version: "10.9.0",
	registry_policy_digest: brand("reg"),
	broker_scanner_policy_digest: brand("scan"),
	tree_algo: DEPENDENCY_TREE_ALGO,
	tree_hash: brand("dep-tree"),
	backup_handle: brand("handle-1"),
	expires_at: brand("2026-10-01T00:00:00Z"),
	created_at: brand("2026-09-01T00:00:00Z"),
};

/** A SECOND immutable record — the one the broker did NOT select. */
const RECORD_B: DependencyTreeCacheRecordV1 = { ...CACHE_RECORD, tree_hash: brand("tree-b"), backup_handle: brand("handle-2") };

/** Broker policy that selected `record` — the ONLY thing that makes a cache
 *  hit expected. */
function cachePolicy(record: DependencyTreeCacheRecordV1 = CACHE_RECORD): Partial<ExpectedExecutionPolicyV1> {
	return { dependency_cache_record_hash: dependencyCacheRecordHash(record) };
}

/** A measurement that restored `record`'s tree and names its hash. */
function cacheHitOf(
	record: DependencyTreeCacheRecordV1,
	overrides: Partial<Extract<ResolvedDependencyBindingV1, { source: "cache" }>> = {},
): MeasuredExecutionViewV1 {
	return {
		...MEASURED,
		dependencies: {
			mode: "npm-v1",
			source: "cache",
			input_hash: record.input_hash,
			tree_algo: record.tree_algo,
			tree_hash: record.tree_hash,
			cache_record_hash: dependencyCacheRecordHash(record),
			...overrides,
		},
	};
}

function cacheHit(overrides: Partial<Extract<ResolvedDependencyBindingV1, { source: "cache" }>> = {}): MeasuredExecutionViewV1 {
	return cacheHitOf(CACHE_RECORD, overrides);
}

function compare(overrides: {
	authority?: Partial<BrokerAuthorityViewV1>;
	claim?: Partial<ShadowExecutionClaimV1>;
	policy?: Partial<ExpectedExecutionPolicyV1>;
	measured?: MeasuredExecutionViewV1;
	cache_record?: DependencyTreeCacheRecordV1;
}): BindingFieldMismatchV1[] {
	return compareBindings({
		authority: { ...AUTHORITY, ...overrides.authority },
		claim: { ...CLAIM, ...overrides.claim },
		policy: { ...POLICY, ...overrides.policy },
		measured: overrides.measured ?? MEASURED,
		...(overrides.cache_record === undefined ? {} : { cache_record: overrides.cache_record }),
	});
}

function fieldsOf(mismatches: readonly BindingFieldMismatchV1[]): string[] {
	return mismatches.map((m) => m.field);
}

function only(mismatches: readonly BindingFieldMismatchV1[]): BindingFieldMismatchV1 {
	expect(fieldsOf(mismatches)).toHaveLength(1);
	const [head] = mismatches;
	if (head === undefined) throw new Error("expected exactly one mismatch");
	return head;
}

describe("compareBindings — positive (must accept)", () => {
	it("P1: a fully agreeing fresh-install set yields no mismatches", () => {
		expect(compare({})).toEqual([]);
	});

	it("P2: policy A / record A / measurement A — a cache hit the BROKER selected and the record corroborates — yields no mismatches", () => {
		expect(compare({ policy: cachePolicy(), measured: cacheHit(), cache_record: CACHE_RECORD })).toEqual([]);
	});

	it("P5: source 'fresh' with NO cache hash in policy is a materializer fact and yields no mismatches", () => {
		expect(POLICY.dependency_cache_record_hash).toBeUndefined();
		expect(compare({ measured: { ...MEASURED, dependencies: { ...MEASURED.dependencies, source: "fresh" } } })).toEqual([]);
	});


	it("P3: mode 'none' on both sides is legal and yields no mismatches", () => {
		expect(
			compare({
				claim: { dependencies: { mode: "none" } },
				measured: { ...MEASURED, dependencies: { mode: "none" } },
			}),
		).toEqual([]);
	});

	it("P4: a fresh install expects nothing of dependencies.tree_hash", () => {
		expect(fieldsOf(compare({ measured: { ...MEASURED, dependencies: { ...MEASURED.dependencies, tree_hash: brand("other") } } }))).toEqual([]);
	});
});

describe("compareBindings — negative (must reject)", () => {
	it("N1: a daemon-asserted content leaf differing yields claim_vs_measurement", () => {
		const mismatch = only(compare({ measured: { ...MEASURED, pre_tree_hash: brand("other") } }));
		expect(mismatch.field).toBe("pre_tree_hash");
		expect(mismatch.comparison).toBe("claim_vs_measurement");
		expect(mismatch.expected).toBe(JSON.stringify("pre"));
		expect(mismatch.measured).toBe(JSON.stringify("other"));
	});

	it("N2: a policy leaf differing yields policy_vs_measurement", () => {
		const mismatch = only(compare({ measured: { ...MEASURED, env_digest: brand("other-env") } }));
		expect(mismatch.field).toBe("env_digest");
		expect(mismatch.comparison).toBe("policy_vs_measurement");
	});

	it("N3: a base_ref the broker did not resolve yields authority_vs_measurement", () => {
		const mismatch = only(compare({ measured: { ...MEASURED, base_ref: brand("b".repeat(40)) }, claim: { base_ref: brand("b".repeat(40)) } }));
		expect(mismatch.field).toBe("base_ref");
		expect(mismatch.comparison).toBe("authority_vs_measurement");
		expect(mismatch.expected).toBe(JSON.stringify("a".repeat(40)));
	});

	it("N4: a mirror version the broker did not issue yields authority_vs_measurement", () => {
		const mismatch = only(compare({ measured: { ...MEASURED, mirror: { ...MEASURED.mirror, version: 8 } }, claim: { mirror: { key: CLAIM.mirror.key, version: 8 } } }));
		expect(mismatch.field).toBe("mirror.version");
		expect(mismatch.comparison).toBe("authority_vs_measurement");
		expect(mismatch.expected).toBe("7");
		expect(mismatch.measured).toBe("8");
	});

	it("N5: a LYING DAEMON — claim version 9 against authority 7 — cannot be silent", () => {
		const mismatches = compare({ claim: { mirror: { key: CLAIM.mirror.key, version: 9 } } });
		const mismatch = only(mismatches);
		expect(mismatch.field).toBe("mirror.version");
		expect(mismatch.comparison).toBe("claim_vs_measurement");
		expect(mismatch.expected).toBe("9");
		expect(mismatch.measured).toBe("7");
	});

	it("N6: a lying daemon the materializer FOLLOWED still mismatches against authority", () => {
		const mismatches = compare({
			claim: { mirror: { key: CLAIM.mirror.key, version: 9 } },
			measured: { ...MEASURED, mirror: { ...MEASURED.mirror, version: 9 } },
		});
		expect(only(mismatches)).toMatchObject({ field: "mirror.version", comparison: "authority_vs_measurement", expected: "7", measured: "9" });
	});

	it("N7: CROSS-SESSION SUBSTITUTION — claim and measurement name another session's key", () => {
		const otherKey = { ...CLAIM.mirror.key, session_id: brand<typeof CLAIM.mirror.key.session_id>("sess-victim") };
		const mismatches = compare({
			claim: { mirror: { key: otherKey, version: 7 } },
			measured: { ...MEASURED, mirror: { key: otherKey, version: 7 } },
		});
		expect(only(mismatches)).toMatchObject({
			field: "mirror.key.session_id",
			comparison: "authority_vs_measurement",
			expected: JSON.stringify("sess-1"),
			measured: JSON.stringify("sess-victim"),
		});
	});

	it("N8: a repository substitution is caught the same way", () => {
		const otherKey = { ...CLAIM.mirror.key, repository_id: brand<typeof CLAIM.mirror.key.repository_id>("repo-victim") };
		const mismatches = compare({ claim: { mirror: { key: otherKey, version: 7 } }, measured: { ...MEASURED, mirror: { key: otherKey, version: 7 } } });
		expect(only(mismatches)).toMatchObject({ field: "mirror.key.repository_id", comparison: "authority_vs_measurement" });
	});

	it("N9: policy A / record A / measured tree differs — the immutable record refuses the substituted tree", () => {
		const mismatch = only(compare({ policy: cachePolicy(), measured: cacheHit({ tree_hash: brand("substituted-tree") }), cache_record: CACHE_RECORD }));
		expect(mismatch.field).toBe("dependencies.tree_hash");
		expect(mismatch.comparison).toBe("cache_vs_measurement");
		expect(mismatch.expected).toBe(JSON.stringify("dep-tree"));
		expect(mismatch.measured).toBe(JSON.stringify("substituted-tree"));
	});

	it("N10: policy A with NO record supplied is a mismatch on cache_record_hash, never silence", () => {
		const mismatch = only(compare({ policy: cachePolicy(), measured: cacheHit() }));
		expect(mismatch).toEqual({
			field: "dependencies.cache_record_hash",
			comparison: "cache_vs_measurement",
			expected: JSON.stringify(dependencyCacheRecordHash(CACHE_RECORD)),
			measured: "null",
		});
	});

	it("N11: a cache record whose input_hash differs from the measurement mismatches", () => {
		const mismatches = compare({ policy: cachePolicy(), measured: cacheHit({ input_hash: brand("other-in") }), cache_record: CACHE_RECORD });
		const byField = new Map(mismatches.map((m) => [m.field, m]));
		expect(byField.get("dependencies.input_hash")?.comparison).toBeDefined();
		expect(fieldsOf(mismatches)).toContain("dependencies.input_hash");
	});

	it("N12: a measured cache_record_hash that is not the POLICY hash mismatches", () => {
		const mismatch = only(compare({ policy: cachePolicy(), measured: cacheHit({ cache_record_hash: brand("stale-rec") }), cache_record: CACHE_RECORD }));
		expect(mismatch.field).toBe("dependencies.cache_record_hash");
		expect(mismatch.comparison).toBe("cache_vs_measurement");
		expect(mismatch.expected).toBe(JSON.stringify(dependencyCacheRecordHash(CACHE_RECORD)));
	});

	it("N17: RECORD SUBSTITUTION — policy A / record B / measurement B is a mismatch, and B is never compared against", () => {
		const mismatches = compare({ policy: cachePolicy(CACHE_RECORD), measured: cacheHitOf(RECORD_B), cache_record: RECORD_B });
		expect(only(mismatches)).toEqual({
			field: "dependencies.cache_record_hash",
			comparison: "cache_vs_measurement",
			expected: JSON.stringify(dependencyCacheRecordHash(CACHE_RECORD)),
			measured: JSON.stringify(dependencyCacheRecordHash(RECORD_B)),
		});
	});

	it("N18: a substituted record cannot be laundered by a measurement that agrees with POLICY on the hash alone", () => {
		const measured = cacheHitOf(RECORD_B, { cache_record_hash: dependencyCacheRecordHash(CACHE_RECORD) });
		const mismatches = compare({ policy: cachePolicy(CACHE_RECORD), measured, cache_record: RECORD_B });
		expect(only(mismatches)).toMatchObject({ field: "dependencies.cache_record_hash", measured: JSON.stringify(dependencyCacheRecordHash(RECORD_B)) });
	});

	it("N19: NO cache hash in policy + a record supplied — nothing expected a cache hit, so the record is unexplained", () => {
		expect(only(compare({ cache_record: CACHE_RECORD }))).toEqual({
			field: "dependencies.cache_record_hash",
			comparison: "cache_vs_measurement",
			expected: "null",
			measured: JSON.stringify(dependencyCacheRecordHash(CACHE_RECORD)),
		});
	});

	it("N20: NO cache hash in policy + a cache-sourced measurement — the hit is unexplained AND the tree uncorroborated", () => {
		const mismatches = compare({ measured: cacheHit() });
		const byField = new Map(mismatches.map((m) => [m.field, m]));
		expect(byField.get("dependencies.source")).toEqual({
			field: "dependencies.source",
			comparison: "policy_vs_measurement",
			expected: JSON.stringify("fresh"),
			measured: JSON.stringify("cache"),
		});
		expect(byField.get("dependencies.tree_hash")).toMatchObject({ comparison: "cache_vs_measurement", expected: "null", measured: JSON.stringify("dep-tree") });
		expect(fieldsOf(mismatches).sort()).toEqual(["dependencies.source", "dependencies.tree_hash"]);
	});

	it("N21: NO cache hash in policy + record supplied + cache-sourced measurement agreeing with it — still refused", () => {
		const fields = fieldsOf(compare({ measured: cacheHit(), cache_record: CACHE_RECORD })).sort();
		expect(fields).toEqual(["dependencies.cache_record_hash", "dependencies.source", "dependencies.tree_hash"]);
	});

	it("N13: a leaf the measurement never reached carries not_reached and no measured field", () => {
		const withoutPostTree: MeasuredExecutionViewV1 = { ...MEASURED };
		delete withoutPostTree.post_tree_hash;
		const mismatch = only(compare({ measured: withoutPostTree }));
		expect(mismatch.field).toBe("post_tree_hash");
		expect(mismatch).not.toHaveProperty("measured");
		expect(mismatch).toMatchObject({ unavailable_reason: "not_reached", expected: JSON.stringify("post") });
	});

	it("N14: a resolved mode 'none' marks the dependency leaves not_provisioned without spurious mismatches", () => {
		const mismatches = compare({ measured: { ...MEASURED, dependencies: { mode: "none" } } });
		const byField = new Map(mismatches.map((m) => [m.field, m]));
		expect(byField.get("dependencies.mode")).toMatchObject({ comparison: "claim_vs_measurement", measured: JSON.stringify("none") });
		expect(byField.get("dependencies.input_hash")).toMatchObject({ unavailable_reason: "not_provisioned" });
		expect(byField.get("dependencies.tree_algo")).toMatchObject({ unavailable_reason: "not_provisioned" });
		expect(fieldsOf(mismatches).sort()).toEqual(["dependencies.input_hash", "dependencies.mode", "dependencies.tree_algo"]);
	});

	it("N15: policy A / record A against a FRESH install disagrees on source and is not_applicable for the record hash", () => {
		const mismatches = compare({ policy: cachePolicy(), cache_record: CACHE_RECORD });
		const byField = new Map(mismatches.map((m) => [m.field, m]));
		expect(byField.get("dependencies.source")).toMatchObject({ comparison: "cache_vs_measurement", measured: JSON.stringify("fresh") });
		expect(byField.get("dependencies.cache_record_hash")).toMatchObject({ comparison: "cache_vs_measurement", unavailable_reason: "not_applicable" });
	});

	it("N16: every comparison kind is produced by the suite at least once", () => {
		const kinds = new Set<string>();
		for (const mismatch of [
			...compare({ measured: { ...MEASURED, pre_tree_hash: brand("x") } }),
			...compare({ measured: { ...MEASURED, env_digest: brand("x") } }),
			...compare({ measured: { ...MEASURED, base_ref: brand("x") }, claim: { base_ref: brand("x") } }),
			...compare({ claim: { mirror: { key: CLAIM.mirror.key, version: 9 } } }),
			...compare({ policy: cachePolicy(), measured: cacheHit({ tree_hash: brand("x") }), cache_record: CACHE_RECORD }),
		]) {
			kinds.add(mismatch.comparison);
		}
		expect([...kinds].sort()).toEqual(["authority_vs_measurement", "cache_vs_measurement", "claim_vs_measurement", "policy_vs_measurement"]);
	});
});

describe("dependencyCacheRecordHash — positive (must accept)", () => {
	it("P1: the same record hashes to the same value regardless of key order", () => {
		const reordered: DependencyTreeCacheRecordV1 = { ...CACHE_RECORD };
		expect(dependencyCacheRecordHash(reordered)).toBe(dependencyCacheRecordHash(CACHE_RECORD));
	});
});

describe("dependencyCacheRecordHash — negative (must reject)", () => {
	it("N1: a changed tree_hash changes the record hash", () => {
		expect(dependencyCacheRecordHash({ ...CACHE_RECORD, tree_hash: brand("other") })).not.toBe(dependencyCacheRecordHash(CACHE_RECORD));
	});
});

describe("asNonEmptyMismatches — positive (must accept)", () => {
	it("P1: a one-element list becomes a NonEmpty tuple with the same members", () => {
		const mismatches = compare({ measured: { ...MEASURED, pre_tree_hash: brand("x") } });
		expect(asNonEmptyMismatches(mismatches)).toEqual(mismatches);
	});
});

describe("asNonEmptyMismatches — negative (must reject)", () => {
	it("N1: an empty list yields null rather than an unsound tuple", () => {
		expect(asNonEmptyMismatches([])).toBeNull();
	});
});

// ── freshness ──────────────────────────────────────────────────────────────
const FRESH_CLAIM: ShadowFreshnessBinding = {
	base_local_head: brand("c".repeat(40)),
	local_head: brand("d".repeat(40)),
	input_hash: brand("in"),
	local_pre_tree_hash: brand("pre"),
	local_overlay_manifest_hash: brand("omh"),
	local_post_image_set_hash: brand("pis"),
};
const CHECKED_AT = "2026-09-03T12:00:00Z";

describe("checkLocalFreshness — positive (must accept)", () => {
	it("P1: an identical claim and disk measurement match", () => {
		const check = checkLocalFreshness(FRESH_CLAIM, { ...FRESH_CLAIM }, brand(CHECKED_AT));
		expect(check).toEqual({
			schema_version: 1,
			claimed: FRESH_CLAIM,
			measured_from_disk: { ...FRESH_CLAIM },
			matches: true,
			checked_at: CHECKED_AT,
		});
	});

	it("P2: the caller's checked_at is echoed and no clock is read inside the module", () => {
		expect(checkLocalFreshness(FRESH_CLAIM, FRESH_CLAIM, brand("2001-01-01T00:00:00Z")).checked_at).toBe("2001-01-01T00:00:00Z");
	});

	it("P3: all six freshness fields are covered exhaustively", () => {
		expect([...FRESHNESS_FIELDS].sort()).toEqual([
			"base_local_head",
			"input_hash",
			"local_head",
			"local_overlay_manifest_hash",
			"local_post_image_set_hash",
			"local_pre_tree_hash",
		]);
	});
});

describe("checkLocalFreshness — negative (must reject)", () => {
	for (const field of FRESHNESS_FIELDS) {
		it(`N1: a difference in ${field} flips matches to false`, () => {
			const measured: ShadowFreshnessBinding = { ...FRESH_CLAIM, [field]: brand("moved") };
			expect(checkLocalFreshness(FRESH_CLAIM, measured, brand(CHECKED_AT)).matches).toBe(false);
		});
	}

	it("N2: a dirty tracked file — HEAD equal, pre-tree content hash different — rejects", () => {
		const measured: ShadowFreshnessBinding = { ...FRESH_CLAIM, local_pre_tree_hash: brand("pre-dirty") };
		const check = checkLocalFreshness(FRESH_CLAIM, measured, brand(CHECKED_AT));
		expect(check.measured_from_disk.local_head).toBe(check.claimed.local_head);
		expect(check.matches).toBe(false);
	});

	it("N3: an imported untracked file — HEAD equal, overlay manifest hash different — rejects", () => {
		const measured: ShadowFreshnessBinding = { ...FRESH_CLAIM, local_overlay_manifest_hash: brand("omh-plus-new-file") };
		const check = checkLocalFreshness(FRESH_CLAIM, measured, brand(CHECKED_AT));
		expect(check.measured_from_disk.local_head).toBe(check.claimed.local_head);
		expect(check.matches).toBe(false);
	});
});
