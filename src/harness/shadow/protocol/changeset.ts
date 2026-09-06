// ===========================================
// Shadow protocol v1 — CONTENT IDENTITY (`ShadowChangeSetV1`, memo §8.0)
// ===========================================
// "Content identity is `ShadowChangeSetV1` = {pre_tree_hash,
// post_image_set_hash, touched_paths}, from exact post-images, never from
// tool-operation normalization."
//
// WHY POST-IMAGES AND NOT THE TOOL OPERATION. A normalized tool input is a
// RECIPE, and two recipes that produce the same bytes are the same change
// while one recipe under two flags is not. Identity taken from the operation
// gets both directions wrong:
//   - it drops `replace_all`, so an Edit that rewrites one occurrence and an
//     Edit that rewrites three collapse to one identity — a real content
//     difference erased (the mutation-gate `replace_all` bug, filed
//     separately);
//   - it keeps MultiEdit ENTRY ORDER, so two orderings that leave a file
//     byte-identical read as two different changes — a false difference.
// Post-images have neither failure: they are the exact bytes the edit leaves
// behind, so identity is decided by the end state alone.
//
// The equality table this module implements (memo §8.0, and `changeset.test.ts`
// case by case — Plan 00's exit gate requires it as a test):
//   `replace_all` true vs false, different post-images   → DIFFERENT identity
//   reordered MultiEdit entries, same bytes              → SAME identity (correct)
//   rename vs delete-plus-create, same final state       → SAME identity (correct —
//                                                          these are not collisions:
//                                                          the trees ARE equal)
//   create-then-delete                                   → no touched paths; identity
//                                                          equals the no-op identity
//   a different `pre_tree_hash`, same post-images        → DIFFERENT identity
//
// `pre_tree_hash` is in the identity because the SAME post-images applied to
// two different pre-trees are two different changes: the post-image set is a
// PARTIAL set, so what the repository ends up as depends on what it was.

import { checkSha256Hex } from "./field-checks.js";
import { sortByPathBytes } from "./path-rules.js";
import { computePostImageSetHash } from "./tagged-set.js";
import type { CanonicalPath, PostImageEntryV1, PreTreeHash, ShadowChangeSetV1 } from "./types-core.js";
import type { ShadowUnavailableReason } from "./types-outcome.js";

export interface ComputeChangeSetRequestV1 {
	/** The `shadow-tree-v1` hash of the tree the post-images apply to. */
	readonly pre_tree_hash: PreTreeHash;
	/** The EXACT post-images of this tool call, in any order — the grammar
	 *  sorts them, and rejects a set with a repeated path. */
	readonly postImages: readonly PostImageEntryV1[];
}

/** The rejection shape is `ShadowHashFailure`'s, so the tagged-set grammar's
 *  own failure (an invalid path, a repeated path, a mode v0 refuses) travels
 *  out of here unchanged rather than being re-worded or re-classified. */
export interface ChangeSetRejectionV1 {
	readonly ok: false;
	readonly reason: ShadowUnavailableReason;
	readonly detail: string;
}
export type ChangeSetResultV1 = { readonly ok: true; readonly changeset: ShadowChangeSetV1 } | ChangeSetRejectionV1;

/** The paths the change touched, bytewise ascending — the grammars' one
 *  ordering, so two computations of the same change produce the same array.
 *  A `D` is a touched path exactly as much as a `W` is. */
function touchedPathsOf(postImages: readonly PostImageEntryV1[]): readonly CanonicalPath[] {
	return sortByPathBytes(postImages, (entry) => entry.path).map((entry) => entry.path);
}

/** Content identity of one tool call. Fails only where the post-image set
 *  itself is inadmissible — identity over a set the protocol would refuse to
 *  execute would name a change that cannot happen. */
export function computeChangeSet(request: ComputeChangeSetRequestV1): ChangeSetResultV1 {
	const preReason = checkSha256Hex(request.pre_tree_hash, "pre_tree_hash");
	if (preReason !== null) return { ok: false, reason: "invalid_tree", detail: preReason };
	const setHash = computePostImageSetHash(request.postImages);
	if (!setHash.ok) return setHash;
	return {
		ok: true,
		changeset: {
			schema_version: 1,
			pre_tree_hash: request.pre_tree_hash,
			post_image_set_hash: setHash.hash,
			touched_paths: touchedPathsOf(request.postImages),
		},
	};
}

/** The equality half of the table: two changes are the SAME identity iff all
 *  three fields are byte-identical. `touched_paths` is compared elementwise —
 *  it is already in the grammar's order, so equal sets of paths compare equal
 *  and a different set never can. */
export function sameContentIdentity(a: ShadowChangeSetV1, b: ShadowChangeSetV1): boolean {
	if (a.pre_tree_hash !== b.pre_tree_hash) return false;
	if (a.post_image_set_hash !== b.post_image_set_hash) return false;
	if (a.touched_paths.length !== b.touched_paths.length) return false;
	return a.touched_paths.every((path, index) => path === b.touched_paths[index]);
}
