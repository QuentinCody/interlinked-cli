// The I4 binding-comparison corpus (`binding-corpus.json`), one half of
// `gen-shadow-corpus.mts`. Every row is a three-view comparison — broker
// authority, daemon claim, broker policy, materializer measurement, and the
// broker's immutable cache record when one is supplied — with the EXACT
// mismatch list it must produce.
//
// The expectations were adjudicated in the second review of Plan 00 against
// the memo's cache rules (I4; §2 "POLICY DRIVES THE CACHE MODE"): a cache hit
// is expected iff POLICY names a `dependency_cache_record_hash`; the supplied
// record must hash to that value before any measurement is read against it;
// a record supplied when policy selected none, a missing record, and a
// cache-sourced measurement nobody expected are each a mismatch, never
// silence and never "use the supplied one instead". The record hashes come
// from the oracle's canonical profile (memo I5), and the generator asserts
// the product produces the same list before a row is written.

import { compareBindings, dependencyCacheRecordHash } from "../src/harness/shadow/protocol/binding-compare.js";
import type { BindingComparisonInputV1, MeasuredExecutionViewV1 } from "../src/harness/shadow/protocol/binding-compare.js";
import type { ExpectedExecutionPolicyV1, ShadowExecutionClaimV1 } from "../src/harness/shadow/protocol/types-binding.js";
import type { DependencyTreeCacheRecordV1, ResolvedDependencyBindingV1 } from "../src/harness/shadow/protocol/types-core.js";
import type { BindingFieldMismatchV1 } from "../src/harness/shadow/protocol/types-outcome.js";
import { oracleCanonicalDigest, oracleCanonicalValue } from "./shadow-projection-oracle.mjs";

type Agree = (id: string, field: string, oracleValue: unknown, productValue: unknown) => void;

// ── fixture values: parser-valid brands, so the rows are also schema-valid ──
const HEX = (digit: string): string => digit.repeat(64);
const SHA = (digit: string): string => digit.repeat(40);
// SAFETY: every brand below is an opaque label on a string the strict parsers would mint; the corpus is data on disk, and the product's own parsers re-mint it there.
const brand = <T>(value: unknown): T => value as T;

const MIRROR_KEY = { repository_id: brand<never>("repo-1"), session_id: brand<never>("sess-1"), kind: "synthetic_full_tree" as const };
const MIRROR = { key: MIRROR_KEY, version: 7 };
const AUTHORITY = { mirror_key: MIRROR_KEY, version: 7, base_ref: brand<never>(SHA("c")) };

function cacheRecord(treeDigit: string, handle: string): DependencyTreeCacheRecordV1 {
	return {
		schema_version: 1,
		input_hash: brand(HEX("1")),
		image_manifest_digest: "sha256:image",
		npm_version: "10.9.0",
		registry_policy_digest: brand(HEX("2")),
		broker_scanner_policy_digest: brand(HEX("3")),
		tree_algo: "shadow-dependency-tree-v1",
		tree_hash: brand(HEX(treeDigit)),
		backup_handle: brand(handle),
		expires_at: brand("2026-10-01T00:00:00Z"),
		created_at: brand("2026-09-01T00:00:00Z"),
	};
}
/** The record POLICY selects in the "A-policy" rows. */
const RECORD_A = cacheRecord("a", "handle-a");
/** A second immutable record — the one policy did NOT select. */
const RECORD_B = cacheRecord("b", "handle-b");
const OTHER_TREE = HEX("e");

const CLAIM: ShadowExecutionClaimV1 = {
	mirror: MIRROR,
	base_ref: brand(SHA("c")),
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: brand(HEX("4")),
	overlay_bytes_hash: brand(HEX("5")),
	pre_tree_hash: brand(HEX("6")),
	post_image_set_hash: brand(HEX("7")),
	post_tree_hash: brand(HEX("8")),
	dependencies: { mode: "npm-v1", input_hash: brand(HEX("1")) },
};
const POLICY: ExpectedExecutionPolicyV1 = {
	tree_algo: "shadow-tree-v1",
	post_image_algo: "shadow-postimages-v1",
	overlay_algo: "shadow-overlay-v1",
	overlay_manifest_hash: brand(HEX("4")),
	env_digest: brand(HEX("9")),
	exec_config_hash: brand(HEX("d")),
	broker_scanner_policy_digest: brand(HEX("3")),
	deadline_at: brand("2026-09-05T00:00:00Z"),
};

type CacheDeps = Extract<ResolvedDependencyBindingV1, { source: "cache" }>;
function measuredWith(dependencies: ResolvedDependencyBindingV1): MeasuredExecutionViewV1 {
	return { ...CLAIM, env_digest: brand(HEX("9")), exec_config_hash: brand(HEX("d")), dependencies };
}
/** A measurement that restored `record`'s tree and names its hash. */
function cacheHit(record: DependencyTreeCacheRecordV1, overrides: Partial<CacheDeps> = {}): MeasuredExecutionViewV1 {
	const hash = brand<CacheDeps["cache_record_hash"]>(oracleCanonicalDigest(record));
	return measuredWith({ mode: "npm-v1", source: "cache", input_hash: record.input_hash, tree_algo: record.tree_algo, tree_hash: record.tree_hash, cache_record_hash: hash, ...overrides });
}
function freshInstall(treeHash: string = RECORD_A.tree_hash): MeasuredExecutionViewV1 {
	return measuredWith({ mode: "npm-v1", source: "fresh", input_hash: brand(HEX("1")), tree_algo: "shadow-dependency-tree-v1", tree_hash: brand(treeHash) });
}
function policyFor(record: DependencyTreeCacheRecordV1 | null): ExpectedExecutionPolicyV1 {
	return record === null ? POLICY : { ...POLICY, dependency_cache_record_hash: brand(oracleCanonicalDigest(record)) };
}

// ── the expected records, in the memo's vocabulary ─────────────────────────
type Mismatch = BindingFieldMismatchV1;
const cj = (value: unknown) => brand<Mismatch["expected"]>(oracleCanonicalValue(value));
const H = (record: DependencyTreeCacheRecordV1) => oracleCanonicalDigest(record);

function recordHashMismatch(expected: string | null, measured: string | null): Mismatch {
	return { field: "dependencies.cache_record_hash", comparison: "cache_vs_measurement", expected: cj(expected), measured: cj(measured) };
}
function treeHashMismatch(expected: string | null, measured: string): Mismatch {
	return { field: "dependencies.tree_hash", comparison: "cache_vs_measurement", expected: cj(expected), measured: cj(measured) };
}
/** Nothing in policy expected a hit: the source is unexplained, the tree uncorroborated. */
function unexpectedHit(measuredTree: string): Mismatch[] {
	return [
		{ field: "dependencies.source", comparison: "policy_vs_measurement", expected: cj("fresh"), measured: cj("cache") },
		treeHashMismatch(null, measuredTree),
	];
}

interface BindingRow {
	id: string;
	note: string;
	reviewed: string;
	input: BindingComparisonInputV1;
	mismatches: readonly Mismatch[];
}
function bindingInput(policy: ExpectedExecutionPolicyV1, measured: MeasuredExecutionViewV1, record: DependencyTreeCacheRecordV1 | null): BindingComparisonInputV1 {
	const base = { authority: AUTHORITY, claim: CLAIM, policy, measured };
	return record === null ? base : { ...base, cache_record: record };
}
function bindingRow(id: string, note: string, reviewed: string, input: BindingComparisonInputV1, mismatches: readonly Mismatch[]): BindingRow {
	return { id, note, reviewed, input, mismatches };
}

const ROWS: readonly BindingRow[] = [
	bindingRow("cache-policy-a-record-b-measured-b", "policy selected A, the caller supplied B, the measurement restored B", "EXACTLY ONE record, on cache_record_hash with expected H(A) and measured H(B) — no tree_hash record, because B is never the record anything is compared against", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_B), RECORD_B), [recordHashMismatch(H(RECORD_A), H(RECORD_B))]),
	bindingRow("cache-policy-a-record-b-measured-claims-a", "policy selected A, the caller supplied B, the measurement CLAIMS hash A but restored B's tree", "still one record on cache_record_hash whose measured side is H(B) — the SUPPLIED record's hash, not the measurement's claim; the supplied record is refuted before the measurement is read", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_B, { cache_record_hash: brand(H(RECORD_A)) }), RECORD_B), [recordHashMismatch(H(RECORD_A), H(RECORD_B))]),
	bindingRow("cache-policy-a-no-record-measured-a", "policy selected A but no record was supplied; the measurement restored A", "one record on cache_record_hash with expected H(A) and measured `null` — the broker has nothing to corroborate against, whatever the measurement says", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_A), null), [recordHashMismatch(H(RECORD_A), null)]),
	bindingRow("cache-no-policy-record-a-fresh", "policy selected NO record, yet a record was supplied; the install ran fresh", "one record on cache_record_hash with expected `null` and measured H(A) — supplying a record never makes the broker expect a hit", bindingInput(policyFor(null), freshInstall(), RECORD_A), [recordHashMismatch(null, H(RECORD_A))]),
	bindingRow("cache-no-policy-no-record-cache-sourced", "policy selected no record, none was supplied, and the measurement says it restored from cache", "EXACTLY TWO: dependencies.source (policy_vs_measurement, fresh vs cache) and dependencies.tree_hash (cache_vs_measurement, expected null) — an unexplained hit with an uncorroborated tree", bindingInput(policyFor(null), cacheHit(RECORD_A), null), unexpectedHit(RECORD_A.tree_hash)),
	bindingRow("cache-no-policy-record-a-cache-sourced-agreeing", "policy selected no record; a record was supplied and the cache-sourced measurement agrees with it", "THREE fields — cache_record_hash (null vs H(A)), source, tree_hash: agreement with a record policy never chose is not corroboration", bindingInput(policyFor(null), cacheHit(RECORD_A), RECORD_A), [recordHashMismatch(null, H(RECORD_A)), ...unexpectedHit(RECORD_A.tree_hash)]),
	bindingRow("cache-policy-a-record-a-measured-a", "policy selected A, A was supplied, the measurement restored A", "the empty list — the precondition for running the verifier and for signing anything", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_A), RECORD_A), []),
	bindingRow("cache-policy-a-record-a-tree-differs", "policy and record agree on A; the restored tree is not A's", "one record on dependencies.tree_hash (cache_vs_measurement) with expected A.tree_hash — the immutable record is what corroborates the restored tree", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_A, { tree_hash: brand(OTHER_TREE) }), RECORD_A), [treeHashMismatch(RECORD_A.tree_hash, OTHER_TREE)]),
	bindingRow("cache-policy-a-record-a-stale-record-hash", "policy and record agree on A; the measurement names a stale cache_record_hash", "one record on cache_record_hash with expected H(A) — the POLICY hash, comparison cache_vs_measurement", bindingInput(policyFor(RECORD_A), cacheHit(RECORD_A, { cache_record_hash: brand(H(RECORD_B)) }), RECORD_A), [recordHashMismatch(H(RECORD_A), H(RECORD_B))]),
	bindingRow("cache-policy-a-record-a-fresh-measurement", "policy and record agree on A; the install ran FRESH instead of restoring", "dependencies.source (cache_vs_measurement, cache vs fresh) plus cache_record_hash with unavailable_reason not_applicable and NO measured field — a fresh install has no record hash to report", bindingInput(policyFor(RECORD_A), freshInstall(), RECORD_A), [
		{ field: "dependencies.source", comparison: "cache_vs_measurement", expected: cj("cache"), measured: cj("fresh") },
		{ field: "dependencies.cache_record_hash", comparison: "cache_vs_measurement", expected: cj(H(RECORD_A)), unavailable_reason: "not_applicable" },
	]),
	bindingRow("fresh-no-policy-no-record", "no policy hash, no record, a fresh install", "the empty list — a fresh tree is a materializer fact nobody held an expectation for, so silence is correct", bindingInput(policyFor(null), freshInstall(), null), []),
	bindingRow("mode-none-both-sides", "dependencies mode `none` on the claim and the measurement, no policy hash", "the empty list — nothing was requested, nothing was provisioned, nothing is compared", { authority: AUTHORITY, claim: { ...CLAIM, dependencies: { mode: "none" } }, policy: policyFor(null), measured: measuredWith({ mode: "none" }) }, []),
];

function sortedByField(mismatches: readonly Mismatch[]): Mismatch[] {
	return [...mismatches].sort((left, right) => `${left.field}|${left.comparison}`.localeCompare(`${right.field}|${right.comparison}`));
}

/** Every row's mismatch list, asserted equal (as a set) between the
 *  adjudicated expectation and the product. A disagreement is a hard failure
 *  naming both lists — the fixture never records one side's answer alone. */
export function generateBindingCorpus(agree: Agree) {
	agree("binding-record-hash", "H(canonical(record))", oracleCanonicalDigest(RECORD_A), dependencyCacheRecordHash(RECORD_A));
	return ROWS.map((row) => {
		agree(row.id, "mismatches", sortedByField(row.mismatches), sortedByField(compareBindings(row.input)));
		return { id: row.id, note: row.note, reviewed: row.reviewed, input: row.input, expect: { mismatches: row.mismatches } };
	});
}
