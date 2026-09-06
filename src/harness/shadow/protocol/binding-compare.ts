// ===========================================
// Shadow protocol v1 — comparing the three held views (memo I4)
// ===========================================
// "Measured before signed": nothing is signed until the MATERIALIZER's
// `ShadowExecutionBinding` matches the DAEMON's `ShadowExecutionClaimV1` and
// BROKER POLICY's `ExpectedExecutionPolicyV1` on every leaf the provenance
// map assigns them. This module is that comparison, and only that: it walks
// the leaves `provenance.ts` declares (never a hand-written list), reads the
// expected value from the party the contract names, and reports typed
// `BindingFieldMismatchV1` records.
//
// Four rules that keep the result honest:
//  - IDENTITY IS BROKER-HELD. `mirror.key.*`, `mirror.version` and `base_ref`
//    are compared AUTHORITY vs MEASUREMENT — never claim vs measurement,
//    which would let a daemon that lies about its own mirror agree with
//    itself. The claim is additionally compared whenever it disagrees with
//    authority, so a lying daemon always produces a record, never silence.
//  - POLICY DRIVES THE CACHE MODE, EXCLUSIVELY. A cache hit is expected iff
//    `policy.dependency_cache_record_hash` is present — the BROKER chose the
//    record. The supplied `cache_record` must hash to that value BEFORE any
//    measurement is compared against it; a missing record, a record whose
//    hash differs from policy, a record supplied when policy selected none,
//    or a cache-sourced measurement nobody expected are each a mismatch,
//    never silence and never "use the supplied one instead" (a caller who
//    picks the record it is compared against has picked the answer).
//  - A leaf with NOTHING expected of it produces NOTHING. `dependencies.
//    tree_hash` under `source: "fresh"` is a MATERIALIZER_FACT — nobody held
//    an expected value before the install ran, so silence is correct and an
//    invented expectation would be a false mismatch.
//  - A leaf the measurement never reached carries an `unavailable_reason`
//    and NO `measured` field; no empty-string sentinel is ever a valid brand.
//
// FRESHNESS IS NOT PART OF THIS COMPARISON. Freshness leaves are
// daemon-asserted and daemon-measured against local disk immediately before
// a verdict is APPLIED (`checkLocalFreshness`), and never leave the machine.

import { canonicalDigest, canonicalValue } from "./canonical.js";
import { contractsFor } from "./provenance.js";
import type {
	ExecutionBindingLeaf,
	ExpectedExecutionPolicyV1,
	FieldContract,
	LocalFreshnessCheckV1,
	ShadowExecutionBinding,
	ShadowExecutionClaimV1,
	ShadowFreshnessBinding,
} from "./types-binding.js";
import type {
	DependencyCacheRecordHash,
	DependencyTreeCacheRecordV1,
	GitSha,
	MirrorKeyV1,
	Rfc3339,
} from "./types-core.js";
import { DEPENDENCY_TREE_ALGO } from "./types-core.js";
import type { BindingFieldMismatchV1, MismatchComparison, NonEmpty } from "./types-outcome.js";

/** The measurement as the daemon HOLDS it: a run that stopped early carries
 *  only the leaves it reached, so every field is optional. A complete
 *  `ShadowExecutionBinding` is assignable to this view. */
export type PartialMeasurement<T> = T extends string | number | boolean | null | undefined
	? T
	: { [K in keyof T]?: PartialMeasurement<T[K]> };
export type MeasuredExecutionViewV1 = PartialMeasurement<ShadowExecutionBinding>;

/** What the BROKER holds about the mirror this request names, read from the
 *  broker's own records after the caller was authenticated — NEVER derived
 *  from the daemon's claim. Identity is the one thing the box under test may
 *  not be its own witness for. */
export interface BrokerAuthorityViewV1 {
	mirror_key: MirrorKeyV1;
	version: number;
	base_ref: GitSha;
}

/** The four views the comparison needs. `cache_record` is REQUIRED whenever
 *  policy carries `dependency_cache_record_hash` and must hash to it; it is
 *  a mismatch when supplied without one. */
export interface BindingComparisonInputV1 {
	authority: BrokerAuthorityViewV1;
	claim: ShadowExecutionClaimV1;
	policy: ExpectedExecutionPolicyV1;
	measured: MeasuredExecutionViewV1;
	cache_record?: DependencyTreeCacheRecordV1;
}

interface ComparisonContext {
	authority: BrokerAuthorityViewV1;
	claim: ShadowExecutionClaimV1;
	policy: ExpectedExecutionPolicyV1;
	cacheRecord?: DependencyTreeCacheRecordV1;
}

type ExpectedResolver = (ctx: ComparisonContext) => unknown;

/** `cache_record_hash` = H(canonical(record)) under the ONE canonical profile
 *  (memo I5); the record carries its own `schema_version`, so no framing. */
export function dependencyCacheRecordHash(record: DependencyTreeCacheRecordV1): DependencyCacheRecordHash {
	return canonicalDigest<"dependency-cache-record">(record);
}

/** Which party's value stands as `expected` for each leaf. `undefined` means
 *  nothing is expected of this leaf in this set. Total over the execution
 *  binding by `satisfies`, so a new leaf without a resolver fails typecheck. */
const EXPECTED_VALUES = {
	// Identity: the BROKER's record, never the daemon's copy of it.
	"mirror.key.repository_id": ({ authority }) => authority.mirror_key.repository_id,
	"mirror.key.session_id": ({ authority }) => authority.mirror_key.session_id,
	"mirror.key.kind": ({ authority }) => authority.mirror_key.kind,
	"mirror.version": ({ authority }) => authority.version,
	base_ref: ({ authority }) => authority.base_ref,
	tree_algo: ({ policy }) => policy.tree_algo,
	post_image_algo: ({ policy }) => policy.post_image_algo,
	overlay_algo: ({ policy }) => policy.overlay_algo,
	overlay_manifest_hash: ({ policy }) => policy.overlay_manifest_hash,
	overlay_bytes_hash: ({ claim }) => claim.overlay_bytes_hash,
	pre_tree_hash: ({ claim }) => claim.pre_tree_hash,
	post_image_set_hash: ({ claim }) => claim.post_image_set_hash,
	post_tree_hash: ({ claim }) => claim.post_tree_hash,
	env_digest: ({ policy }) => policy.env_digest,
	exec_config_hash: ({ policy }) => policy.exec_config_hash,
	"dependencies.mode": ({ claim }) => claim.dependencies.mode,
	"dependencies.input_hash": ({ claim }) => (claim.dependencies.mode === "npm-v1" ? claim.dependencies.input_hash : undefined),
	// Policy constant, but only once dependencies are actually requested.
	"dependencies.tree_algo": ({ claim }) => (claim.dependencies.mode === "npm-v1" ? DEPENDENCY_TREE_ALGO : undefined),
	// A cache-record hash in POLICY is the broker's expectation of a cache hit;
	// a supplied record never is.
	"dependencies.source": (ctx) => (brokerExpectsCache(ctx) ? "cache" : undefined),
	// Owned by the cache arm (`cacheArmMismatches`): the policy hash stands as
	// expected only once the supplied record has proven to be the one selected.
	"dependencies.cache_record_hash": () => undefined,
	// Measured on provisioning. On reuse the broker's IMMUTABLE record is what
	// corroborates it — the cache arm owns that too.
	"dependencies.tree_hash": () => undefined,
} as const satisfies Record<ExecutionBindingLeaf, ExpectedResolver>;

/** The claim's own copy of each identity leaf — compared against authority,
 *  never used AS the expectation. */
const CLAIMED_IDENTITY_VALUES = {
	"mirror.key.repository_id": (c) => c.mirror.key.repository_id,
	"mirror.key.session_id": (c) => c.mirror.key.session_id,
	"mirror.key.kind": (c) => c.mirror.key.kind,
	"mirror.version": (c) => c.mirror.version,
	base_ref: (c) => c.base_ref,
} as const satisfies Partial<Record<ExecutionBindingLeaf, (claim: ShadowExecutionClaimV1) => unknown>>;
type ClaimedIdentityLeaf = keyof typeof CLAIMED_IDENTITY_VALUES;

/** The leaves the broker's immutable cache record corroborates on a hit. */
const CACHE_RECORD_VALUES = {
	"dependencies.input_hash": (r) => r.input_hash,
	"dependencies.tree_algo": (r) => r.tree_algo,
	"dependencies.tree_hash": (r) => r.tree_hash,
} as const satisfies Partial<Record<ExecutionBindingLeaf, (record: DependencyTreeCacheRecordV1) => unknown>>;
type CacheRecordLeaf = keyof typeof CACHE_RECORD_VALUES;

/** POLICY ONLY. Supplying a record must never make the broker "expect" a hit. */
function brokerExpectsCache(ctx: ComparisonContext): boolean {
	return ctx.policy.dependency_cache_record_hash !== undefined;
}

function isExecutionLeaf(leaf: string): leaf is ExecutionBindingLeaf {
	return Object.hasOwn(EXPECTED_VALUES, leaf);
}

/** Which comparison a contract implies, or null when the leaf is a pure
 *  materializer fact with no counterparty to disagree with. */
function comparisonFor(contract: FieldContract): MismatchComparison | null {
	if (contract.expected_by === "broker_policy") return "policy_vs_measurement";
	if (contract.expected_by === "broker_authority") return "authority_vs_measurement";
	if (contract.expected_by === "broker_cache") return "cache_vs_measurement";
	return contract.asserted_by === "daemon" ? "claim_vs_measurement" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a dotted path, or `undefined` when any segment is absent. */
function valueAt(root: unknown, path: string): unknown {
	let cursor: unknown = root;
	for (const segment of path.split(".")) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

function measuredSource(measured: MeasuredExecutionViewV1): "fresh" | "cache" | undefined {
	const source = valueAt(measured, "dependencies.source");
	return source === "fresh" || source === "cache" ? source : undefined;
}

/** Whose contract arm applies: the broker's cache expectation when it holds
 *  one, otherwise what the materializer reported. */
function resolveSource(ctx: ComparisonContext, measured: MeasuredExecutionViewV1): "fresh" | "cache" {
	if (brokerExpectsCache(ctx)) return "cache";
	return measuredSource(measured) ?? "fresh";
}

type UnavailableReason = "not_reached" | "not_provisioned" | "not_applicable";

function unavailableReason(leaf: ExecutionBindingLeaf, measured: MeasuredExecutionViewV1): UnavailableReason {
	if (!leaf.startsWith("dependencies.")) return "not_reached";
	const mode = valueAt(measured, "dependencies.mode");
	if (mode === undefined) return "not_reached";
	if (mode === "none") return "not_provisioned";
	// The only leaf that exists in one npm variant and not the other.
	if (leaf === "dependencies.cache_record_hash" && measuredSource(measured) !== "cache") return "not_applicable";
	return "not_reached";
}

interface LeafComparison {
	leaf: ExecutionBindingLeaf;
	comparison: MismatchComparison;
	expected: unknown;
	measured: MeasuredExecutionViewV1;
}

function mismatchFor({ leaf, comparison, expected, measured }: LeafComparison): BindingFieldMismatchV1 | null {
	const actual = valueAt(measured, leaf);
	if (actual === undefined) {
		return { field: leaf, comparison, expected: canonicalValue(expected), unavailable_reason: unavailableReason(leaf, measured) };
	}
	const expectedJson = canonicalValue(expected);
	const measuredJson = canonicalValue(actual);
	if (expectedJson === measuredJson) return null;
	return { field: leaf, comparison, expected: expectedJson, measured: measuredJson };
}

/** Every leaf of the EXECUTION binding, in provenance-declared order. */
function executionLeaves(): ExecutionBindingLeaf[] {
	return Object.keys(EXPECTED_VALUES).filter(isExecutionLeaf);
}

/** The declared pass: every leaf the provenance map assigns an expectation. */
function declaredLeafMismatches(ctx: ComparisonContext, measured: MeasuredExecutionViewV1, source: "fresh" | "cache"): BindingFieldMismatchV1[] {
	const mismatches: BindingFieldMismatchV1[] = [];
	for (const leaf of executionLeaves()) {
		const expected = EXPECTED_VALUES[leaf](ctx);
		if (expected === undefined) continue;
		const comparison = comparisonFor(contractsFor(leaf, source));
		if (comparison === null) continue;
		const mismatch = mismatchFor({ leaf, comparison, expected, measured });
		if (mismatch !== null) mismatches.push(mismatch);
	}
	return mismatches;
}

function claimedIdentityLeaves(): ClaimedIdentityLeaf[] {
	return Object.keys(CLAIMED_IDENTITY_VALUES).filter((key): key is ClaimedIdentityLeaf =>
		Object.hasOwn(CLAIMED_IDENTITY_VALUES, key),
	);
}

/**
 * A DAEMON THAT LIES ABOUT ITS OWN MIRROR CANNOT BE SILENT. The declared pass
 * already compares authority against the measurement; this pass adds the
 * daemon's claim wherever it disagrees with authority. The two together are
 * exhaustive: the measurement equals at most one of two differing values, so
 * at least one arm reports a mismatch (and a measurement that reached neither
 * leaf reports an `unavailable_reason` from both).
 */
function claimAuthorityDisagreements(ctx: ComparisonContext, measured: MeasuredExecutionViewV1): BindingFieldMismatchV1[] {
	const mismatches: BindingFieldMismatchV1[] = [];
	for (const leaf of claimedIdentityLeaves()) {
		const claimed = CLAIMED_IDENTITY_VALUES[leaf](ctx.claim);
		if (canonicalValue(claimed) === canonicalValue(EXPECTED_VALUES[leaf](ctx))) continue;
		const mismatch = mismatchFor({ leaf, comparison: "claim_vs_measurement", expected: claimed, measured });
		if (mismatch !== null) mismatches.push(mismatch);
	}
	return mismatches;
}

function cacheRecordLeaves(): CacheRecordLeaf[] {
	return Object.keys(CACHE_RECORD_VALUES).filter((key): key is CacheRecordLeaf => Object.hasOwn(CACHE_RECORD_VALUES, key));
}

/** A cache hit the broker cannot corroborate. Expected is `null` — the broker
 *  supplied NO record — which is exactly the point: nothing stands behind the
 *  measured tree, so the set is refused. */
function unverifiableCacheHit(measured: MeasuredExecutionViewV1): BindingFieldMismatchV1 {
	const treeHash = valueAt(measured, "dependencies.tree_hash");
	const field = "dependencies.tree_hash" as const;
	if (treeHash === undefined) {
		return { field, comparison: "cache_vs_measurement", expected: canonicalValue(null), unavailable_reason: "not_reached" };
	}
	return { field, comparison: "cache_vs_measurement", expected: canonicalValue(null), measured: canonicalValue(treeHash) };
}

/** Nothing in policy expected a cache hit, so a cache-sourced measurement is
 *  UNEXPLAINED (the broker expected a fresh install) and its tree
 *  uncorroborated. Silence on a fresh measurement is correct. */
function unexpectedCacheHit(measured: MeasuredExecutionViewV1): BindingFieldMismatchV1[] {
	if (measuredSource(measured) !== "cache") return [];
	return [
		{ field: "dependencies.source", comparison: "policy_vs_measurement", expected: canonicalValue("fresh"), measured: canonicalValue("cache") },
		unverifiableCacheHit(measured),
	];
}

/** The broker's selection, proven or refuted BEFORE any measurement is read. */
type CacheSelection =
	| { kind: "none" }
	| { kind: "selected"; record: DependencyTreeCacheRecordV1; policyHash: DependencyCacheRecordHash }
	| { kind: "mismatch"; mismatch: BindingFieldMismatchV1 };

/** POLICY chose the record; the caller only carries it. A supplied record
 *  stands only when its hash IS the policy hash — otherwise the two sides
 *  disagree on `cache_record_hash` (`null` on the side that has nothing). */
function selectCacheRecord(ctx: ComparisonContext): CacheSelection {
	const policyHash = ctx.policy.dependency_cache_record_hash;
	const record = ctx.cacheRecord;
	if (policyHash === undefined && record === undefined) return { kind: "none" };
	const suppliedHash = record === undefined ? null : dependencyCacheRecordHash(record);
	if (policyHash !== undefined && record !== undefined && suppliedHash === policyHash) {
		return { kind: "selected", record, policyHash };
	}
	const expected = canonicalValue(policyHash ?? null);
	return { kind: "mismatch", mismatch: { field: "dependencies.cache_record_hash", comparison: "cache_vs_measurement", expected, measured: canonicalValue(suppliedHash) } };
}

/** Corroboration against the record POLICY selected: the measured
 *  `cache_record_hash` must be the policy hash, and the restored tree must
 *  be the one the immutable record describes. */
function corroboratedCacheLeaves(selection: Extract<CacheSelection, { kind: "selected" }>, measured: MeasuredExecutionViewV1): BindingFieldMismatchV1[] {
	const mismatches: BindingFieldMismatchV1[] = [];
	const hashMismatch = mismatchFor({ leaf: "dependencies.cache_record_hash", comparison: "cache_vs_measurement", expected: selection.policyHash, measured });
	if (hashMismatch !== null) mismatches.push(hashMismatch);
	for (const leaf of cacheRecordLeaves()) {
		const mismatch = mismatchFor({ leaf, comparison: "cache_vs_measurement", expected: CACHE_RECORD_VALUES[leaf](selection.record), measured });
		if (mismatch !== null) mismatches.push(mismatch);
	}
	return mismatches;
}

/** The cache arm. Policy drives the mode exclusively: a selected record is
 *  proven first and compared second; anything else is a mismatch record. */
function cacheArmMismatches(ctx: ComparisonContext, measured: MeasuredExecutionViewV1): BindingFieldMismatchV1[] {
	const selection = selectCacheRecord(ctx);
	if (selection.kind === "selected") return corroboratedCacheLeaves(selection, measured);
	const unexpected = brokerExpectsCache(ctx) ? [] : unexpectedCacheHit(measured);
	return selection.kind === "mismatch" ? [selection.mismatch, ...unexpected] : unexpected;
}

/**
 * Compare the four held views leaf by leaf (memo I4). An empty array means
 * every leaf the provenance map assigns agreed — the precondition for running
 * the verifier and for signing anything. It is NEVER empty for a cache hit the
 * broker's POLICY-selected immutable record does not corroborate, nor when the
 * supplied record is not the one policy selected.
 */
export function compareBindings(input: BindingComparisonInputV1): BindingFieldMismatchV1[] {
	const ctx: ComparisonContext = {
		authority: input.authority,
		claim: input.claim,
		policy: input.policy,
		// Spread, not `cacheRecord: input.cache_record` — under
		// exactOptionalPropertyTypes an explicit `undefined` is not "absent".
		...(input.cache_record === undefined ? {} : { cacheRecord: input.cache_record }),
	};
	const measured = input.measured;
	const source = resolveSource(ctx, measured);
	return [
		...declaredLeafMismatches(ctx, measured, source),
		...claimAuthorityDisagreements(ctx, measured),
		...cacheArmMismatches(ctx, measured),
	];
}

/** `BindingMismatchOutcome` requires a NON-EMPTY list by TYPE. This is the
 *  only safe way in: null when there was nothing to report. */
export function asNonEmptyMismatches(mismatches: readonly BindingFieldMismatchV1[]): NonEmpty<BindingFieldMismatchV1> | null {
	const [head, ...tail] = mismatches;
	if (head === undefined) return null;
	return [head, ...tail];
}

// ── freshness — daemon-local, never signed (memo I4) ───────────────────────
/** Exhaustive by `satisfies`: a seventh freshness field fails the typecheck
 *  here rather than being silently skipped by the check. */
const FRESHNESS_FIELD_SET = {
	base_local_head: true,
	local_head: true,
	input_hash: true,
	local_pre_tree_hash: true,
	local_overlay_manifest_hash: true,
	local_post_image_set_hash: true,
} as const satisfies Record<keyof ShadowFreshnessBinding, true>;

export const FRESHNESS_FIELDS: readonly (keyof ShadowFreshnessBinding)[] = Object.keys(FRESHNESS_FIELD_SET).filter(
	(key): key is keyof ShadowFreshnessBinding => Object.hasOwn(FRESHNESS_FIELD_SET, key),
);

/**
 * Compare the claimed freshness binding against what the daemon just read
 * from disk. HEAD alone is insufficient — a dirty tracked file or an
 * imported untracked file moves the CONTENT hashes without moving HEAD — so
 * all six fields are compared. `checkedAt` is supplied by the caller: this
 * module reads no clock, which keeps the record reproducible in a replay.
 */
export function checkLocalFreshness(
	claimed: ShadowFreshnessBinding,
	measuredFromDisk: ShadowFreshnessBinding,
	checkedAt: Rfc3339,
): LocalFreshnessCheckV1 {
	const matches = FRESHNESS_FIELDS.every((field) => claimed[field] === measuredFromDisk[field]);
	return { schema_version: 1, claimed, measured_from_disk: measuredFromDisk, matches, checked_at: checkedAt };
}
