// ===========================================
// Shadow protocol v1 — the provenance table (memo §2, §8.0)
// ===========================================
// One contract per LEAF of the execution binding and the freshness binding.
// Independent verification means the party that MEASURES is never the party
// that ASSERTED (content leaves: the daemon asserts, the materializer
// measures) or, for policy leaves, never the party that EXPECTED. Dependency
// OUTPUT is measured on provisioning and compared to the broker's immutable
// cache record on reuse; freshness leaves are daemon-asserted and
// daemon-measured against disk, and never leave the machine.
//
// Two pins, deliberately different in kind:
//  - `satisfies Record<ProvenanceLeaf, LeafContract>` fails the TYPECHECK if
//    a new leaf appears without a contract;
//  - `provenanceLeaves()` walks EXEMPLAR values at runtime, so the same
//    completeness holds for a build where types were erased.

import type {
	ConditionalContract,
	ExecutionBindingLeaf,
	FieldContract,
	FreshnessLeaf,
	LeafContract,
	ProvenanceLeaf,
	ShadowExecutionBinding,
	ShadowFreshnessBinding,
} from "./types-binding.js";
import type { ResolvedDependencyBindingV1 } from "./types-core.js";
import { DEPENDENCY_TREE_ALGO, OVERLAY_ALGO, POST_IMAGE_ALGO, TREE_ALGO } from "./types-core.js";

const POLICY: FieldContract = { expected_by: "broker_policy", measured_by: "materializer", authority: "policy" };
const CONTENT: FieldContract = { asserted_by: "daemon", measured_by: "materializer", authority: "content" };
const IDENTITY: FieldContract = { expected_by: "broker_authority", measured_by: "materializer", authority: "identity" };
const FRESH: FieldContract = { asserted_by: "daemon", measured_by: "daemon", authority: "freshness" };
const CACHE_CORROBORATED: FieldContract = { expected_by: "broker_cache", measured_by: "materializer", authority: "content" };
const MATERIALIZER_FACT: FieldContract = { measured_by: "materializer", authority: "execution_fact" };
/** A daemon claim the BROKER holds the authoritative value for. */
const CLAIMED_IDENTITY: FieldContract = {
	asserted_by: "daemon",
	expected_by: "broker_authority",
	measured_by: "materializer",
	authority: "identity",
};

export const BINDING_PROVENANCE = {
	"mirror.key.repository_id": IDENTITY,
	"mirror.key.session_id": IDENTITY,
	"mirror.key.kind": IDENTITY,
	// The authoritative version→ref mapping is BROKER-held; the daemon's copy
	// is a claim compared against it, so authority is the broker, not the box.
	"mirror.version": CLAIMED_IDENTITY,
	base_ref: CLAIMED_IDENTITY,
	tree_algo: POLICY,
	post_image_algo: POLICY,
	overlay_algo: POLICY,
	overlay_manifest_hash: POLICY,
	overlay_bytes_hash: CONTENT,
	pre_tree_hash: CONTENT,
	post_image_set_hash: CONTENT,
	post_tree_hash: CONTENT,
	"dependencies.mode": CONTENT,
	"dependencies.input_hash": CONTENT,
	"dependencies.source": { by_source: { fresh: MATERIALIZER_FACT, cache: CACHE_CORROBORATED } },
	"dependencies.tree_algo": POLICY,
	"dependencies.tree_hash": { by_source: { fresh: MATERIALIZER_FACT, cache: CACHE_CORROBORATED } },
	"dependencies.cache_record_hash": CACHE_CORROBORATED,
	env_digest: POLICY,
	exec_config_hash: POLICY,
	base_local_head: FRESH,
	local_head: FRESH,
	input_hash: FRESH,
	local_pre_tree_hash: FRESH,
	local_overlay_manifest_hash: FRESH,
	local_post_image_set_hash: FRESH,
} as const satisfies Record<ProvenanceLeaf, LeafContract>;

function isConditional(contract: LeafContract): contract is ConditionalContract {
	return "by_source" in contract;
}

/** Both arms of a conditional contract, or the single unconditional one. */
export function flattenContract(contract: LeafContract): FieldContract[] {
	return isConditional(contract) ? [contract.by_source.fresh, contract.by_source.cache] : [contract];
}

/** The contract that applies to one leaf for one dependency source. */
export function contractsFor(leaf: ProvenanceLeaf, source: "fresh" | "cache"): FieldContract {
	const contract: LeafContract = BINDING_PROVENANCE[leaf];
	return isConditional(contract) ? contract.by_source[source] : contract;
}

// ── runtime leaf census ────────────────────────────────────────────────────
// Exemplars, not a hand-written list: the census is WALKED from values whose
// types are the bindings themselves, so a field added to a binding shows up
// here without anyone remembering to add it.
/** SAFETY: the ONE cast in this module. The census only ever WALKS these
 *  values for their key structure; no exemplar is hashed, compared, or sent.
 *  Typing them as the real bindings is what makes a newly added field appear
 *  in the census automatically — and makes a removed one fail the build. */
function placeholder<T extends string>(): T {
	return "exemplar" as T;
}

function exemplarBinding(dependencies: ResolvedDependencyBindingV1): ShadowExecutionBinding {
	return {
		mirror: {
			key: { repository_id: placeholder(), session_id: placeholder(), kind: "synthetic_full_tree" },
			version: 1,
		},
		base_ref: placeholder(),
		tree_algo: TREE_ALGO,
		post_image_algo: POST_IMAGE_ALGO,
		overlay_algo: OVERLAY_ALGO,
		overlay_manifest_hash: placeholder(),
		overlay_bytes_hash: placeholder(),
		pre_tree_hash: placeholder(),
		post_image_set_hash: placeholder(),
		post_tree_hash: placeholder(),
		dependencies,
		env_digest: placeholder(),
		exec_config_hash: placeholder(),
	};
}

const DEPENDENCY_EXEMPLARS: readonly ResolvedDependencyBindingV1[] = [
	{ mode: "none" },
	{ mode: "npm-v1", source: "fresh", input_hash: placeholder(), tree_algo: DEPENDENCY_TREE_ALGO, tree_hash: placeholder() },
	{
		mode: "npm-v1",
		source: "cache",
		input_hash: placeholder(),
		tree_algo: DEPENDENCY_TREE_ALGO,
		tree_hash: placeholder(),
		cache_record_hash: placeholder(),
	},
];

const EXEMPLAR_FRESHNESS: ShadowFreshnessBinding = {
	base_local_head: placeholder(),
	local_head: placeholder(),
	input_hash: placeholder(),
	local_pre_tree_hash: placeholder(),
	local_overlay_manifest_hash: placeholder(),
	local_post_image_set_hash: placeholder(),
};

function leavesOf(value: unknown, prefix: string, into: Set<string>): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		into.add(prefix);
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		leavesOf(child, prefix === "" ? key : `${prefix}.${key}`, into);
	}
}

/** Every dotted primitive leaf of the EXECUTION binding, across all three
 *  dependency variants — the closed set a `BindingFieldMismatchV1.field` may
 *  name. Derived, so a field added to the binding appears here without
 *  anyone remembering to list it. */
export function bindingLeaves(): ExecutionBindingLeaf[] {
	const leaves = new Set<string>();
	for (const dependencies of DEPENDENCY_EXEMPLARS) {
		leavesOf(exemplarBinding(dependencies), "", leaves);
	}
	// SAFETY: the walk enumerates the keys of a value typed as the binding
	// itself, so every string it produced IS one of the binding's leaf paths.
	return [...leaves] as ExecutionBindingLeaf[];
}

/** Every dotted primitive leaf of the FRESHNESS binding — daemon-local, and
 *  deliberately disjoint from the execution leaves. */
export function freshnessLeaves(): FreshnessLeaf[] {
	const leaves = new Set<string>();
	leavesOf(EXEMPLAR_FRESHNESS, "", leaves);
	// SAFETY: same derivation as bindingLeaves, over the freshness exemplar.
	return [...leaves] as FreshnessLeaf[];
}

/** Both halves — the exact key set `BINDING_PROVENANCE` must cover. */
export function provenanceLeaves(): ProvenanceLeaf[] {
	return [...bindingLeaves(), ...freshnessLeaves()];
}
