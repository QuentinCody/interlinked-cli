// ===========================================
// Shadow protocol v1 — `shadow-tree-v1` byte grammar (memo §5.1)
// ===========================================
// "Same surface" is prose; cross-platform equality needs a byte grammar:
//
//   tree_hash  = hex(sha256(record_1 ‖ record_2 ‖ … ‖ record_n))  (lowercase,
//                records concatenated with NO separator)
//   record_i   = mode ‖ 0x20 ‖ path_bytes ‖ 0x00 ‖ content_digest
//
// `mode` is the 6-ASCII-byte git mode, `path_bytes` is the repo-relative
// POSIX path as raw UTF-8 (a path can carry no NUL, so 0x00 terminates it
// unambiguously), and `content_digest` is the RAW 32-byte sha-256 of the
// entry content — fixed width, so the grammar needs no framing.
//
// Records are sorted by `path_bytes` ascending, BYTEWISE: no Unicode
// normalization and case-sensitive, so a case-insensitive local filesystem
// that collapses two entries mismatches, correctly.
//
// The hash is over the FULL materialized entry set — a deletion relative to
// `base_ref` is ABSENCE. The partial sets (`shadow-postimages-v1`,
// `shadow-overlay-v1`) cannot express deletion that way and use the tagged
// grammar in `tagged-set.ts`.
//
// `shadow-dependency-tree-v1` (memo §5.1, I5) is named as an algorithm id
// with no separate grammar of its own, so it REUSES this grammar over the
// dependency subtree, with paths relative to the dependency root. The id is
// distinct so the two hashes can never be confused in a binding.
//
// Rejections are RETURNED, never thrown: this protocol must be able to say
// `shadow: unavailable` for input it refuses. Symlinks (`120000`) are
// `symlink_escape`; every other refusal is `invalid_tree`.

import { sha256Hex } from "./canonical.js";
import { checkSha256Hex } from "./field-checks.js";
import {
	ancestorConflict,
	checkCanonicalPath,
	duplicatePath,
	fileDirectoryConflictDetail,
	modeRejectionReason,
	sortByPathBytes,
} from "./path-rules.js";
import type { DependencyTreeHash, Digest, PostTreeHash, PreTreeHash } from "./types-core.js";
import type { ShadowUnavailableReason } from "./types-outcome.js";

const SPACE = 0x20;
const NUL = 0x00;

/** One materialized entry. `blob_digest` is the LOWERCASE hex sha-256 of the
 *  content; the grammar embeds its raw 32 bytes. `ManifestEntryV1` (branded)
 *  is assignable to this shape. */
export interface TreeEntryInput {
	readonly path: string;
	readonly mode: string;
	readonly blob_digest: string;
	readonly bytes: number;
}

export interface ShadowHashFailure {
	readonly ok: false;
	readonly reason: ShadowUnavailableReason;
	readonly detail: string;
}
export type ShadowHashResult<B extends string> = { readonly ok: true; readonly hash: Digest<B> } | ShadowHashFailure;

export function hashFailure(reason: ShadowUnavailableReason, detail: string): ShadowHashFailure {
	return { ok: false, reason, detail };
}

/** The failure this entry earns, or null when it may enter a record. Shared
 *  with the tagged grammar's `W` records — one admission rule, not two. */
export function checkTreeEntry(entry: TreeEntryInput, where: string): ShadowHashFailure | null {
	const pathReason = checkCanonicalPath(entry.path, `${where}.path`);
	if (pathReason !== null) return hashFailure("invalid_tree", pathReason);
	const modeReason = modeRejectionReason(entry.mode);
	if (modeReason !== null) return hashFailure(modeReason, `${where}.mode "${entry.mode}" is not admitted`);
	const digestReason = checkSha256Hex(entry.blob_digest, `${where}.blob_digest`);
	if (digestReason !== null) return hashFailure("invalid_tree", digestReason);
	return null;
}

/** `mode ‖ 0x20 ‖ path_bytes ‖ 0x00 ‖ digest32` — the ONE record encoder. */
export function encodeRecordBytes(prefix: readonly Buffer[], path: string, digest32: Buffer): Buffer {
	return Buffer.concat([...prefix, Buffer.from(path, "utf8"), Buffer.from([NUL]), digest32]);
}

export function modeField(mode: string): Buffer {
	return Buffer.concat([Buffer.from(mode, "ascii"), Buffer.from([SPACE])]);
}

export function rawDigest(hex: string): Buffer {
	return Buffer.from(hex, "hex");
}

/** hex(sha256(record_1 ‖ … ‖ record_n)) — the shared tail of every grammar
 *  here. An empty set hashes the empty byte string, by construction. */
export function hashRecords<B extends string>(records: readonly Buffer[]): ShadowHashResult<B> {
	// SAFETY: this function IS the mint site for the byte-grammar digests;
	// the caller's type argument names which of them it is computing.
	return { ok: true, hash: sha256Hex(Buffer.concat([...records])) as Digest<B> };
}

/** `shadow-tree-v1` over a FULL materialized entry set. */
export function computeTreeHash<B extends string>(entries: readonly TreeEntryInput[]): ShadowHashResult<B> {
	for (const [index, entry] of entries.entries()) {
		const failure = checkTreeEntry(entry, `entry[${index}]`);
		if (failure !== null) return failure;
	}
	const duplicate = duplicatePath(entries, (entry) => entry.path);
	if (duplicate !== null) return hashFailure("invalid_tree", `duplicate path in tree: "${duplicate}"`);
	// A FULL materialized tree cannot hold a regular file that is also another
	// entry's parent directory. Each path is individually canonical, so only
	// the set can show it — and this grammar is the last surface before a
	// binding claims the tree exists. The PARTIAL grammars (`tagged-set.ts`)
	// deliberately do NOT check: a set that deletes `a` and writes `a/b.ts`
	// is a legal transition, and only the tree it produces must be possible.
	const conflict = ancestorConflict(entries.map((entry) => entry.path));
	if (conflict !== null) return hashFailure("invalid_tree", fileDirectoryConflictDetail(conflict));
	const sorted = sortByPathBytes(entries, (entry) => entry.path);
	return hashRecords(sorted.map((entry) => encodeRecordBytes([modeField(entry.mode)], entry.path, rawDigest(entry.blob_digest))));
}

// Each wrapper's result names the BRAND its binding field wants, so a
// mis-wired call site fails to compile rather than carrying the wrong hash.
export type PreTreeHashResult = { readonly ok: true; readonly hash: PreTreeHash } | ShadowHashFailure;
export type PostTreeHashResult = { readonly ok: true; readonly hash: PostTreeHash } | ShadowHashFailure;
export type DependencyTreeHashResult = { readonly ok: true; readonly hash: DependencyTreeHash } | ShadowHashFailure;

/** The materialized tree the executor is expected to have BEFORE the edit. */
export function computePreTreeHash(entries: readonly TreeEntryInput[]): PreTreeHashResult {
	return computeTreeHash<"pre-tree">(entries);
}

/** The materialized tree the executor actually ran on, AFTER the post-images. */
export function computePostTreeHash(entries: readonly TreeEntryInput[]): PostTreeHashResult {
	return computeTreeHash<"post-tree">(entries);
}

/** `shadow-dependency-tree-v1` — the same grammar over the dependency
 *  subtree, paths relative to the dependency root (see the header note). */
export function computeDependencyTreeHash(entries: readonly TreeEntryInput[]): DependencyTreeHashResult {
	return computeTreeHash<"dependency-tree">(entries);
}
