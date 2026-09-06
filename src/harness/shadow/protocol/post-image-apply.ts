// ===========================================
// Shadow protocol v1 — LITERAL post-image application (memo §5.1)
// ===========================================
// The materializer applies a post-image set LITERALLY: `W` writes the bytes,
// `D` unlinks, and **a `D` for a path absent in the pre-tree is a projection
// error, not a no-op** (memo §5.1, explicit). This module is that rule as a
// pure in-memory function — no filesystem access at all, so the daemon can
// project + apply + hash a post tree inside a hook without touching disk. The
// sandbox materializer (Plan 02) reuses this decision, it does not re-derive
// it.
//
// A `W` entry carries only a digest and a byte count, so the caller supplies
// the bytes alongside it (`PostImageWithContentV1`, which is exactly what the
// projector emits). The applier RE-DERIVES the digest and the byte count and
// refuses a pair that disagrees — bytes that do not hash to their entry are
// not the bytes the claim was made about.

import { sha256Hex } from "./canonical.js";
import { ancestorConflict, duplicatePath, fileDirectoryConflictDetail } from "./path-rules.js";
import type { BlobDigest, GitMode, PostImageEntryV1 } from "./types-core.js";

/** One file in an in-memory tree. Content is text: v0 admits only the two
 *  regular git modes, and every path that reaches a hash grammar is valid
 *  UTF-8 (memo §5.1). */
export interface ShadowTreeFileV1 {
	readonly mode: GitMode;
	readonly content: string;
}
export type ShadowTreeV1 = ReadonlyMap<string, ShadowTreeFileV1>;

/** A post-image record paired with the bytes a `W` names. `content` is null
 *  for `D` — a deletion has no bytes, and an empty string would create an
 *  empty file (the reason the tagged grammar exists at all). */
export interface PostImageWithContentV1 {
	readonly entry: PostImageEntryV1;
	readonly content: string | null;
}

export type ApplyPostImagesResultV1 =
	| { ok: true; tree: Map<string, ShadowTreeFileV1> }
	| { ok: false; reason: "projection"; detail: string };

/** UTF-8 byte count — the `bytes` field of every entry counts bytes, never
 *  UTF-16 code units. */
export function byteLengthOf(content: string): number {
	return Buffer.byteLength(content, "utf8");
}

/** The blob digest of file content: lowercase hex sha-256 of its UTF-8 bytes. */
export function blobDigestOf(content: string): BlobDigest {
	// SAFETY: BlobDigest is a purpose brand on a hex sha-256 string, and this
	// is the one place file content is turned into that digest.
	return sha256Hex(Buffer.from(content, "utf8")) as BlobDigest;
}

function reject(detail: string): ApplyPostImagesResultV1 {
	return { ok: false, reason: "projection", detail };
}

/** Apply a post-image set to an in-memory tree, literally. Pure: the input
 *  tree is never mutated; a rejection returns no tree at all. */
export function applyPostImages(
	tree: ShadowTreeV1,
	images: readonly PostImageWithContentV1[],
): ApplyPostImagesResultV1 {
	const duplicate = duplicatePath(images, (image) => image.entry.path);
	if (duplicate !== null) {
		return reject(`two post-image records for one path: ${duplicate}`);
	}
	const next = new Map(tree);
	for (const image of images) {
		const detail = applyOne(next, image);
		if (detail !== null) return reject(detail);
	}
	// The RESULT must be a possible tree: no regular file may also be another
	// entry's parent directory. Checked after the whole set, never per record,
	// because the order within a set is not the order a filesystem would see —
	// a set that deletes `a` and writes `a/b.ts` is legal, and only its end
	// state has to be materializable.
	const conflict = ancestorConflict([...next.keys()]);
	if (conflict !== null) return reject(fileDirectoryConflictDetail(conflict));
	return { ok: true, tree: next };
}

/** null on success, else the rejection detail. */
function applyOne(tree: Map<string, ShadowTreeFileV1>, image: PostImageWithContentV1): string | null {
	const { entry } = image;
	if (entry.tag === "D") {
		if (!tree.has(entry.path)) {
			return `D for a path absent in the pre-tree is a projection error, not a no-op: ${entry.path}`;
		}
		tree.delete(entry.path);
		return null;
	}
	const { content } = image;
	if (content === null) return `W for ${entry.path} carries no content — the applier never invents bytes`;
	const mismatch = contentMismatch(entry, content);
	if (mismatch !== null) return mismatch;
	tree.set(entry.path, { mode: entry.mode, content });
	return null;
}

/** null when the supplied bytes are exactly the bytes the entry names. */
function contentMismatch(
	entry: Extract<PostImageEntryV1, { tag: "W" }>,
	content: string,
): string | null {
	const bytes = byteLengthOf(content);
	if (bytes !== entry.bytes) {
		return `W for ${entry.path} declares ${entry.bytes} bytes but the content is ${bytes}`;
	}
	const digest = blobDigestOf(content);
	if (digest !== entry.blob_digest) {
		return `W for ${entry.path} declares digest ${entry.blob_digest} but the content hashes to ${digest}`;
	}
	return null;
}
