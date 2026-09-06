// ===========================================
// Shadow protocol v1 — the TAGGED byte grammar (memo §5.1)
// ===========================================
// ONE grammar, TWO algorithm ids: `shadow-postimages-v1`
// (`post_image_set_hash`) and `shadow-overlay-v1` (`overlay_bytes_hash`).
// Both are PARTIAL sets, and a partial set cannot express deletion by
// absence — absence there means "untouched", and empty bytes would create an
// empty file — so every record carries a tag:
//
//   record_i = tag ‖ 0x20 ‖ mode ‖ 0x20 ‖ path_bytes ‖ 0x00 ‖ digest32
//
// `W` = write these bytes (real mode + real digest). `D` = delete this path:
// mode `000000` and a digest of 32 ZERO bytes. A rename is `D` for the
// source (the tombstone) paired with `W` for the destination.
//
// Sort and rejection rules are the tree grammar's: bytewise ascending path
// order, modes `100644`/`100755` only on `W`, canonical paths only. Paths are
// UNIQUE across the whole set — a `W` and a `D` for one path, or two `W`
// records for one path, is a REJECT, because otherwise the record order (and
// therefore the meaning of the set) is ambiguous.
//
// The algorithm id does not enter the bytes: the two ids name the same
// grammar over different sets, and the id travels in the binding.

import { checkCanonicalPath, duplicatePath, sortByPathBytes } from "./path-rules.js";
import {
	checkTreeEntry,
	encodeRecordBytes,
	hashFailure,
	hashRecords,
	modeField,
	rawDigest,
	type ShadowHashFailure,
	type ShadowHashResult,
} from "./tree-hash.js";
import type { OverlayAlgo, OverlayBytesHash, PostImageAlgo, PostImageSetHash } from "./types-core.js";

/** The mode and digest a `D` record carries — a tombstone has neither a real
 *  mode nor real content, and both fields are fixed-width in the grammar. */
export const DELETE_MODE = "000000";
export const DELETE_DIGEST_BYTES = 32;

export type TaggedAlgo = PostImageAlgo | OverlayAlgo;

/** `W` — write these bytes. The `W` branch is named so a call site can build
 *  one and override a field without losing the union's narrowing. */
export interface TaggedWriteEntry {
	readonly tag: "W";
	readonly path: string;
	readonly mode: string;
	readonly blob_digest: string;
	readonly bytes: number;
}
/** `D` — delete this path (the tombstone half of a rename). */
export interface TaggedDeleteEntry {
	readonly tag: "D";
	readonly path: string;
}
export type TaggedEntryInput = TaggedWriteEntry | TaggedDeleteEntry;

function tagField(tag: "W" | "D"): Buffer {
	return Buffer.concat([Buffer.from(tag, "ascii"), Buffer.from([0x20])]);
}

function checkTaggedEntry(entry: TaggedEntryInput, where: string): ShadowHashFailure | null {
	if (entry.tag === "W") return checkTreeEntry(entry, where);
	const pathReason = checkCanonicalPath(entry.path, `${where}.path`);
	return pathReason === null ? null : hashFailure("invalid_tree", pathReason);
}

function encodeTagged(entry: TaggedEntryInput): Buffer {
	const prefix = [tagField(entry.tag)];
	if (entry.tag === "D") {
		return encodeRecordBytes([...prefix, modeField(DELETE_MODE)], entry.path, Buffer.alloc(DELETE_DIGEST_BYTES));
	}
	return encodeRecordBytes([...prefix, modeField(entry.mode)], entry.path, rawDigest(entry.blob_digest));
}

/** The tagged grammar under one of its two algorithm ids. `algo` is the id
 *  the binding will carry; it does not change the bytes. */
export function computeTaggedSetHash<B extends string>(
	algo: TaggedAlgo,
	entries: readonly TaggedEntryInput[],
): ShadowHashResult<B> {
	for (const [index, entry] of entries.entries()) {
		const failure = checkTaggedEntry(entry, `${algo}[${index}]`);
		if (failure !== null) return failure;
	}
	const duplicate = duplicatePath(entries, (entry) => entry.path);
	if (duplicate !== null) return hashFailure("invalid_tree", `duplicate path in ${algo}: "${duplicate}"`);
	return hashRecords(sortByPathBytes(entries, (entry) => entry.path).map(encodeTagged));
}

// Each wrapper's result names the BRAND its binding field wants, so the two
// ids cannot be swapped at a call site without a compile error.
export type PostImageSetHashResult = { readonly ok: true; readonly hash: PostImageSetHash } | ShadowHashFailure;
export type OverlayBytesHashResult = { readonly ok: true; readonly hash: OverlayBytesHash } | ShadowHashFailure;

/** `shadow-postimages-v1` — the exact images the executor must apply. */
export function computePostImageSetHash(entries: readonly TaggedEntryInput[]): PostImageSetHashResult {
	return computeTaggedSetHash<"post-image-set">("shadow-postimages-v1", entries);
}

/** `shadow-overlay-v1` — the full `base_ref → local state` delta. */
export function computeOverlayBytesHash(entries: readonly TaggedEntryInput[]): OverlayBytesHashResult {
	return computeTaggedSetHash<"overlay-bytes">("shadow-overlay-v1", entries);
}
