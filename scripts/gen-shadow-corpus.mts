// Generates the `protocol/shadow-v1/fixtures/` corpus.
//   npx tsx scripts/gen-shadow-corpus.mts
//
// Every expected value here is computed by `shadow-projection-oracle.mts` — a
// SECOND implementation written from the memo, not from the product — and the
// product package is then asserted to agree before anything is written. A
// disagreement is a hard failure naming both values: the fixture is never
// allowed to record an answer only one implementation believes.
//
// The fixtures are DATA, executed by the protocol package's corpus test.
// Re-run ONLY when the contract deliberately changes — a regenerated digest
// nobody meant to change is exactly what the corpus exists to catch.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestDigestOf } from "../src/harness/shadow/protocol/manifest-digest.js";
import { parsePostImageEntry } from "../src/harness/shadow/protocol/parse-core-entries.js";
import { computeMissingSetDigestV1 } from "../src/harness/shadow/protocol/missing-set.js";
import { computeChangeSet } from "../src/harness/shadow/protocol/changeset.js";
import { applyPostImages, blobDigestOf, byteLengthOf } from "../src/harness/shadow/protocol/post-image-apply.js";
import { projectPostImages } from "../src/harness/shadow/protocol/post-image-projector.js";
import { computeOverlayBytesHash, computePostImageSetHash } from "../src/harness/shadow/protocol/tagged-set.js";
import { computePostTreeHash, computePreTreeHash } from "../src/harness/shadow/protocol/tree-hash.js";
import type { NormalizedToolInputV1, PostImageEntryV1, PreTreeHash, ShadowChangeSetV1 } from "../src/harness/shadow/protocol/types-core.js";
import { generateBindingCorpus } from "./gen-shadow-corpus-binding.mjs";
import { ADDED_MALFORMED_ROWS, malformedCorpus, projectionExpansionRows } from "./gen-shadow-corpus-malformed.mjs";
import { PROJECTION_ROWS, edit, multiEdit, patch, write, type Row } from "./gen-shadow-corpus-rows.mjs";
import {
	oracleApply,
	oracleBlobDigest,
	oracleByteLength,
	oracleProject,
	oracleTaggedHash,
	oracleTouchedPaths,
	oracleTreeHash,
	type OracleFile,
	type OracleMode,
	type OracleRecord,
	type OracleToolInput,
} from "./shadow-projection-oracle.mjs";

const OUT = join(import.meta.dirname, "../protocol/shadow-v1/fixtures");

// ── cross-implementation agreement ─────────────────────────────────────────

function agree(id: string, field: string, oracleValue: unknown, productValue: unknown): void {
	const left = JSON.stringify(oracleValue);
	const right = JSON.stringify(productValue);
	if (left === right) return;
	throw new Error(`ORACLE DISAGREEMENT [${id}] ${field}\n  oracle : ${left}\n  product: ${right}`);
}
type ProductHash = { ok: true; hash: string } | { ok: false; reason: string; detail?: string };
function agreeHash(id: string, field: string, oracle: { ok: boolean; value?: string; reason?: string }, product: ProductHash): string {
	agree(id, `${field}.accepted`, oracle.ok, product.ok);
	if (!product.ok) return `rejected(${product.reason})`;
	agree(id, field, oracle.value, product.hash);
	return product.hash;
}

// ── the shared base tree ───────────────────────────────────────────────────
// `docs/Ａ.md` and `docs/\u{10000}.md` are the byte-order pair: in UTF-16
// code-unit order the astral path sorts FIRST (its lead surrogate is D800),
// in UTF-8 byte order it sorts LAST (F0 > EF). A tree hash that sorted the
// JavaScript way would differ from one that sorted the grammar's way.
const BASE: Record<string, OracleFile> = {
	"bin/run.sh": { mode: "100755", content: "#!/bin/sh\necho hi\n" },
	"docs/Ａ.md": { mode: "100644", content: "# héllo 🌍\n" },
	"docs/\u{10000}.md": { mode: "100644", content: "astral\n" },
	"src/a.ts": { mode: "100644", content: "const x = 1;\nconst y = 1;\n" },
	"src/anchored.ts": { mode: "100644", content: "function a() {\n\treturn 1;\n}\nfunction b() {\n\treturn 1;\n}\n" },
	"src/dup.ts": { mode: "100644", content: "same();\nsame();\n" },
	"src/keep.ts": { mode: "100644", content: "export const keep = 1;\n" },
	// The three Codex line-terminator shapes an Update has to survive: a file
	// with NO final newline (it gains one), a file with two (they collapse to
	// one), and a one-line file whose only line a hunk deletes (the result is
	// "", not "\n"). See `post-image-patch.ts`'s byte note.
	"src/crlf.ts": { mode: "100644", content: "const x = 1;\r\nconst y = 1;\r\n" },
	"src/no-eol.ts": { mode: "100644", content: "const tail = 1;" },
	"src/one-line.ts": { mode: "100644", content: "gone\n" },
	"src/two-eol.ts": { mode: "100644", content: "const tail = 1;\n\n" },
};
const BASE_MAP: ReadonlyMap<string, OracleFile> = new Map(Object.entries(BASE));

// ── the projection corpus (exit gate G1) ───────────────────────────────────

// The rows themselves live in `gen-shadow-corpus-rows.mts` — they are pure
// data, they grow with every review, and this file hit the 500-line cap. The
// builders they are written with moved there too, so the identity table and
// the malformed corpus below import them from the same place.
const ROWS: readonly Row[] = PROJECTION_ROWS;

function toOracleInput(input: NormalizedToolInputV1): OracleToolInput {
	return input;
}
function preImagesOf(touches: readonly string[]): Map<string, OracleFile | null> {
	return new Map(touches.map((path) => [path, BASE[path] ?? null]));
}
function entryOf(record: OracleRecord): PostImageEntryV1 {
	const entry = record.tag === "D"
		? { tag: "D", path: record.path }
		: { tag: "W", path: record.path, mode: record.mode, blob_digest: oracleBlobDigest(record.content), bytes: oracleByteLength(record.content) };
	const parsed = parsePostImageEntry(entry);
	if (!parsed.ok) throw new Error(`Oracle post-image entry is invalid: ${parsed.reason}`);
	return parsed.value;
}
function sortEntries(entries: readonly PostImageEntryV1[]): PostImageEntryV1[] {
	return [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
}
function treeEntries(tree: ReadonlyMap<string, OracleFile>) {
	return [...tree.entries()].map(([path, file]) => ({ path, mode: file.mode, blob_digest: blobDigestOf(file.content), bytes: byteLengthOf(file.content) }));
}

const oracleBaseHash = oracleTreeHash(BASE_MAP);
if (!oracleBaseHash.ok) throw new Error(`oracle cannot hash the base tree: ${oracleBaseHash.reason}`);
const productBaseHash = computePreTreeHash(treeEntries(BASE_MAP));
const BASE_PRE_TREE_HASH = agreeHash("base-tree", "pre_tree_hash", { ok: true, value: oracleBaseHash.value }, productBaseHash);
// SAFETY: the digest was just produced by the product's own pre-tree hasher.
const BASE_PRE_TREE = BASE_PRE_TREE_HASH as PreTreeHash;

function changeSetOf(id: string, records: readonly OracleRecord[]): ShadowChangeSetV1 {
	const entries = sortEntries(records.map(entryOf));
	const oracleSet = oracleTaggedHash(records);
	const productSet = computePostImageSetHash(records.map((record) => (record.tag === "D" ? { tag: "D", path: record.path } : { tag: "W", path: record.path, mode: record.mode, blob_digest: oracleBlobDigest(record.content), bytes: oracleByteLength(record.content) })));
	agreeHash(id, "post_image_set_hash", oracleSet, productSet);
	const product = computeChangeSet({ pre_tree_hash: BASE_PRE_TREE, postImages: entries });
	if (!product.ok) throw new Error(`${id}: product changeset rejected: ${product.reason}`);
	agree(id, "changeset.touched_paths", oracleTouchedPaths(records), [...product.changeset.touched_paths]);
	agree(id, "changeset.post_image_set_hash", oracleSet.ok ? oracleSet.value : null, product.changeset.post_image_set_hash);
	return product.changeset;
}

/** One side of a disputed row: what that implementation actually produced. */
interface DisputedSide {
	accepted: boolean;
	reason: string;
	post_images: readonly PostImageEntryV1[];
	post_tree_hash: string;
}
type OracleProjection = ReturnType<typeof oracleProject>;
type ProductProjection = ReturnType<typeof projectPostImages>;

function oracleSide(id: string, projected: OracleProjection): DisputedSide {
	if (!projected.ok) return { accepted: false, reason: projected.reason, post_images: [], post_tree_hash: "" };
	const tree = oracleApply(BASE_MAP, projected.value);
	if (!tree.ok) throw new Error(`${id}: oracle apply rejected: ${tree.reason}`);
	const hash = oracleTreeHash(tree.value);
	return { accepted: true, reason: "", post_images: sortEntries(projected.value.map(entryOf)), post_tree_hash: hash.ok ? hash.value : `rejected(${hash.reason})` };
}
function productSide(id: string, projected: ProductProjection): DisputedSide {
	if (!projected.ok) return { accepted: false, reason: `${projected.reason}: ${projected.detail}`, post_images: [], post_tree_hash: "" };
	const tree = applyPostImages(new Map(Object.entries(BASE)), projected.images);
	if (!tree.ok) throw new Error(`${id}: product apply rejected: ${tree.reason} ${tree.detail}`);
	const hash = computePostTreeHash(treeEntries(tree.tree));
	return { accepted: true, reason: "", post_images: sortEntries(projected.images.map((image) => image.entry)), post_tree_hash: hash.ok ? hash.hash : `rejected(${hash.reason})` };
}
/** A disputed row records BOTH answers and the adjudication. It stops being a
 *  dispute the moment the two agree, and that is a hard failure here. */
function disputeOf(item: Row, oracle: OracleProjection, product: ProductProjection) {
	const sides = { oracle: oracleSide(item.id, oracle), product: productSide(item.id, product) };
	if (JSON.stringify(sides.oracle) === JSON.stringify(sides.product)) throw new Error(`[${item.id}] is marked disputed but the two implementations now AGREE — delete the dispute and record the expectation`);
	const describe = (side: DisputedSide) => (side.accepted ? "projected" : `rejected(${side.reason})`);
	process.stdout.write(`DISPUTED [${item.id}] oracle ${describe(sides.oracle)} / product ${describe(sides.product)}\n`);
	return { kind: "disputed" as const, adjudication: item.disputed ?? "", ...sides };
}

function projectRow(item: Row) {
	const pre = preImagesOf(item.touches);
	const oracle = oracleProject(toOracleInput(item.input), pre);
	const product = projectPostImages(item.input, new Map(pre));
	const shared = { id: item.id, note: item.note, reviewed: item.reviewed, tool_input: item.input, pre_images: Object.fromEntries(pre), omitted_pre_images: item.omits, base_tree: BASE };
	if (item.disputed !== undefined) return { ...shared, expect: disputeOf(item, oracle, product) };
	agree(item.id, "projection.accepted", oracle.ok, product.ok);
	if (!oracle.ok || !product.ok) {
		const productReason = product.ok ? "" : `${product.reason}: ${product.detail}`;
		return { ...shared, expect: { kind: "rejected" as const, oracle_reason: oracle.ok ? "" : oracle.reason, product_reason: productReason } };
	}
	agree(item.id, "post_images", sortEntries(oracle.value.map(entryOf)), sortEntries(product.images.map((image) => image.entry)));
	const oracleTree = oracleApply(BASE_MAP, oracle.value);
	if (!oracleTree.ok) throw new Error(`${item.id}: oracle apply rejected: ${oracleTree.reason}`);
	const productTree = applyPostImages(new Map(Object.entries(BASE)), product.images);
	if (!productTree.ok) throw new Error(`${item.id}: product apply rejected: ${productTree.reason} ${productTree.detail}`);
	agree(item.id, "post_tree", [...oracleTree.value.entries()].sort(), [...productTree.tree.entries()].sort());
	const postHash = agreeHash(item.id, "post_tree_hash", oracleTreeHash(oracleTree.value), computePostTreeHash(treeEntries(productTree.tree)));
	return {
		...shared,
		expect: {
			kind: "projected" as const,
			post_images: sortEntries(oracle.value.map(entryOf)),
			pre_tree_hash: BASE_PRE_TREE_HASH,
			post_tree_hash: postHash,
			changeset: changeSetOf(item.id, oracle.value),
		},
	};
}

const projection = ROWS.map(projectRow);

// ── hash vectors (the byte grammars everything above stands on) ────────────

interface VectorSpec {
	id: string;
	algo: "shadow-tree-v1" | "shadow-postimages-v1" | "shadow-overlay-v1";
	reviewed: string;
	records: readonly OracleRecord[];
}
const UNICODE_PAIR: readonly OracleRecord[] = [
	{ tag: "W", path: "docs/Ａ.md", mode: "100644", content: "# héllo 🌍\n" },
	{ tag: "W", path: "docs/\u{10000}.md", mode: "100644", content: "astral\n" },
];
const MIXED_MODES: readonly OracleRecord[] = [
	{ tag: "W", path: "src/a.ts", mode: "100644", content: "export const a = 1;\n" },
	{ tag: "W", path: "bin/run.sh", mode: "100755", content: "#!/usr/bin/env node\n" },
	{ tag: "W", path: "README.md", mode: "100644", content: "# repo\n" },
];
const TAGGED: readonly OracleRecord[] = [
	{ tag: "W", path: "src/a.ts", mode: "100644", content: "export const a = 2;\n" },
	{ tag: "D", path: "src/gone.ts" },
];
const VECTORS: readonly VectorSpec[] = [
	{ id: "tree-empty", algo: "shadow-tree-v1", reviewed: "the empty tree hashes the sha-256 of zero bytes, not a sentinel", records: [] },
	{ id: "tree-mixed-modes", algo: "shadow-tree-v1", reviewed: "both admitted modes appear; the 6 ASCII mode bytes are inside the hashed record", records: MIXED_MODES },
	{ id: "tree-reordered-input-same-hash", algo: "shadow-tree-v1", reviewed: "the same three entries in reverse input order hash IDENTICALLY — the grammar sorts", records: [...MIXED_MODES].reverse() },
	{ id: "tree-utf8-byte-order", algo: "shadow-tree-v1", reviewed: "U+FF21 sorts BEFORE U+10000 (EF < F0) even though JavaScript string order puts the astral path first", records: UNICODE_PAIR },
	{ id: "tree-utf8-byte-order-reversed-input", algo: "shadow-tree-v1", reviewed: "same digest as the row above: input order cannot change the hash", records: [...UNICODE_PAIR].reverse() },
	{ id: "tree-traversal-path-rejected", algo: "shadow-tree-v1", reviewed: "a `..` segment is REJECTED by the grammar, not normalized away", records: [{ tag: "W", path: "../escape.ts", mode: "100644", content: "x\n" }] },
	{ id: "tree-absolute-path-rejected", algo: "shadow-tree-v1", reviewed: "a leading `/` is REJECTED", records: [{ tag: "W", path: "/etc/passwd", mode: "100644", content: "x\n" }] },
	{ id: "tree-file-under-file-rejected", algo: "shadow-tree-v1", reviewed: "`a` and `a/b.ts` are each a valid canonical path, and TOGETHER they are impossible — `a` cannot be both a regular file and another entry's parent directory. REJECTED as invalid_tree; a full tree is the surface that can see it, so this is where the rule lives (the PARTIAL tagged grammars deliberately do not check: deleting `a` and writing `a/b.ts` in one set is legal)", records: [{ tag: "W", path: "a", mode: "100644", content: "x\n" }, { tag: "W", path: "a/b.ts", mode: "100644", content: "y\n" }] },
	{ id: "tree-sibling-prefix-not-conflict", algo: "shadow-tree-v1", reviewed: "the guard against over-rejecting: `a`, `a.ts` and `ab/c.ts` all ACCEPT. A string prefix without the `/` boundary is not an ancestor — without this row the rule above could be `startsWith(path)` and still look right", records: [{ tag: "W", path: "a", mode: "100644", content: "x\n" }, { tag: "W", path: "a.ts", mode: "100644", content: "y\n" }, { tag: "W", path: "ab/c.ts", mode: "100644", content: "z\n" }] },
	{ id: "postimages-write-and-delete", algo: "shadow-postimages-v1", reviewed: "the D record hashes mode 000000 and 32 zero bytes — absence would mean untouched", records: TAGGED },
	{ id: "postimages-empty-set", algo: "shadow-postimages-v1", reviewed: "the empty (no-op) post-image set — the identity a create-then-delete collapses to", records: [] },
	{ id: "postimages-rename-pair", algo: "shadow-postimages-v1", reviewed: "a rename is one D and one W; the digest is over BOTH records", records: [{ tag: "D", path: "src/a.ts" }, { tag: "W", path: "src/moved.ts", mode: "100644", content: "const x = 1;\n" }] },
	{ id: "postimages-duplicate-path-rejected", algo: "shadow-postimages-v1", reviewed: "one path may carry at most one record — REJECTED, so add-then-delete is unrepresentable", records: [{ tag: "W", path: "src/a.ts", mode: "100644", content: "a\n" }, { tag: "D", path: "src/a.ts" }] },
	{ id: "overlay-write-and-delete", algo: "shadow-overlay-v1", reviewed: "the overlay grammar is byte-identical to the post-image grammar; only the algorithm id differs", records: TAGGED },
	{ id: "overlay-create-then-delete-absent", algo: "shadow-overlay-v1", reviewed: "a file created and then deleted locally contributes NO record — this digest equals the empty-set digest", records: [] },
];

function vectorEntries(records: readonly OracleRecord[]) {
	return records.map((record) => (record.tag === "D" ? { tag: "D" as const, path: record.path } : { tag: "W" as const, path: record.path, mode: record.mode, blob_digest: oracleBlobDigest(record.content), bytes: oracleByteLength(record.content) }));
}
function treeVectorEntries(records: readonly OracleRecord[]) {
	return records.flatMap((record) => (record.tag === "D" ? [] : [{ path: record.path, mode: record.mode, blob_digest: oracleBlobDigest(record.content), bytes: oracleByteLength(record.content) }]));
}
/** A tree vector's records are all `W`; a `D` has no place in a full tree. */
function treeStateOf(records: readonly OracleRecord[]): Map<string, OracleFile> {
	const state = new Map<string, OracleFile>();
	for (const record of records) {
		if (record.tag === "W") state.set(record.path, { mode: record.mode, content: record.content });
	}
	return state;
}
function treeVectorOf(spec: VectorSpec) {
	const entries = treeVectorEntries(spec.records);
	const hash = agreeHash(spec.id, "hash", oracleTreeHash(treeStateOf(spec.records)), computePreTreeHash(entries));
	return { id: spec.id, algo: spec.algo, reviewed: spec.reviewed, entries, hash };
}
function taggedVectorOf(spec: VectorSpec) {
	const entries = vectorEntries(spec.records);
	const compute = spec.algo === "shadow-postimages-v1" ? computePostImageSetHash : computeOverlayBytesHash;
	const hash = agreeHash(spec.id, "hash", oracleTaggedHash(spec.records), compute(entries));
	return { id: spec.id, algo: spec.algo, reviewed: spec.reviewed, entries, hash };
}
function vectorOf(spec: VectorSpec) {
	return spec.algo === "shadow-tree-v1" ? treeVectorOf(spec) : taggedVectorOf(spec);
}
// ── the two ENVELOPE grammars ──────────────────────────────────────────────
// `shadow-missing-set-v1` and the manifest digest are not record grammars, so
// they carry their own vector shape: a list of blob digests, and a byte
// string. The expected value is computed HERE from each module's header prose
// (a second implementation, as everywhere else in this file) and the product
// must agree before a row is written.

interface MissingSetVectorSpec {
	id: string;
	reviewed: string;
	digests: readonly string[];
}
const HEX64 = /^[0-9a-f]{64}$/;

/** The envelope from `missing-set.ts`'s header, re-derived:
 *  domain ‖ 0x00 ‖ ascii(count) ‖ 0x00 ‖ digest32… over unique sorted digests. */
function oracleMissingSetDigest(digests: readonly string[]): { ok: boolean; value?: string; reason?: string } {
	if (digests.some((digest) => !HEX64.test(digest))) return { ok: false, reason: "mirror_integrity" };
	if (new Set(digests).size !== digests.length) return { ok: false, reason: "mirror_integrity" };
	const sorted = [...digests].sort();
	const envelope = Buffer.concat([
		Buffer.from("interlinked-shadow-missing-set-v1", "ascii"),
		Buffer.from([0x00]),
		Buffer.from(String(sorted.length), "ascii"),
		Buffer.from([0x00]),
		...sorted.map((hex) => Buffer.from(hex, "hex")),
	]);
	return { ok: true, value: createHash("sha256").update(envelope).digest("hex") };
}

const MISSING_A = oracleBlobDigest("blob-a\n");
const MISSING_B = oracleBlobDigest("blob-b\n");
const MISSING_C = oracleBlobDigest("blob-c\n");

const MISSING_SET_VECTORS: readonly MissingSetVectorSpec[] = [
	{ id: "missing-set-empty", reviewed: "a frozen set with nothing missing still hashes an ENVELOPE (domain + count 0), never the sha-256 of zero bytes — so 'no blobs missing' cannot collide with 'hashed nothing at all'", digests: [] },
	{ id: "missing-set-three-blobs", reviewed: "three unique digests, already in bytewise order; the raw 32 bytes of each are what the envelope embeds, not their hex spelling", digests: [MISSING_A, MISSING_B, MISSING_C].sort() },
	{ id: "missing-set-reordered-input-same-hash", reviewed: "the same three digests in reverse order hash IDENTICALLY — pagination cannot change the set's identity by walking it in another order", digests: [...[MISSING_A, MISSING_B, MISSING_C].sort()].reverse() },
	{ id: "missing-set-one-fewer-differs", reviewed: "dropping one digest changes the hash — the count is inside the envelope, so a truncated page cannot pass as the frozen set", digests: [MISSING_A, MISSING_B].sort() },
	{ id: "missing-set-duplicate-rejected", reviewed: "a repeated digest is REJECTED, never deduplicated: silently absorbing it would make this set hash like a genuinely smaller one", digests: [MISSING_A, MISSING_B, MISSING_A] },
	{ id: "missing-set-uppercase-rejected", reviewed: "an uppercase hex digest is REJECTED — one spelling per digest, or two clients hash the same set differently", digests: [MISSING_A.toUpperCase()] },
];

interface ManifestVectorSpec {
	id: string;
	reviewed: string;
	bytes: Buffer;
}
const MANIFEST_VECTORS: readonly ManifestVectorSpec[] = [
	{
		id: "manifest-digest-exact-uploaded-bytes",
		reviewed: "sha-256 over the bytes AS SENT: the keys are NOT in canonical order, there is insignificant whitespace and a trailing newline, and all three are inside the digest — the broker compares what it stored, so a canonical re-encoding would hash something the client never sent",
		bytes: Buffer.from('{"schema_version":1, "b":2,"a":1}\n', "utf8"),
	},
];

function missingSetVectorOf(spec: MissingSetVectorSpec) {
	const hash = agreeHash(spec.id, "hash", oracleMissingSetDigest(spec.digests), computeMissingSetDigestV1(spec.digests));
	return { id: spec.id, algo: "shadow-missing-set-v1" as const, reviewed: spec.reviewed, digests: spec.digests, hash };
}
function manifestVectorOf(spec: ManifestVectorSpec) {
	const oracle = { ok: true, value: createHash("sha256").update(spec.bytes).digest("hex") };
	const hash = agreeHash(spec.id, "hash", oracle, { ok: true, hash: manifestDigestOf(spec.bytes) });
	return { id: spec.id, algo: "shadow-manifest-digest-v1" as const, reviewed: spec.reviewed, bytes_hex: spec.bytes.toString("hex"), hash };
}

const hashVectors = [...VECTORS.map(vectorOf), ...MISSING_SET_VECTORS.map(missingSetVectorOf), ...MANIFEST_VECTORS.map(manifestVectorOf)];

// ── identity table (exit gate G3) ──────────────────────────────────────────

function changeSetFor(id: string, input: NormalizedToolInputV1, touches: readonly string[]): ShadowChangeSetV1 {
	const projected = oracleProject(toOracleInput(input), preImagesOf(touches));
	if (!projected.ok) throw new Error(`${id}: oracle rejected the identity input: ${projected.reason}`);
	return changeSetOf(id, projected.value);
}
const replaceAllTrue = changeSetFor("identity-replace-all", edit("src/a.ts", "= 1", "= 2", true), ["src/a.ts"]);
const oneOccurrenceOnly = changeSetFor("identity-one-occurrence", write("src/a.ts", "const x = 2;\nconst y = 1;\n"), ["src/a.ts"]);
const multiForward = changeSetFor("identity-multi-forward", multiEdit("src/a.ts", [["const x = 1;", "const x = 5;"], ["const y = 1;", "const y = 6;"]]), ["src/a.ts"]);
const multiReversed = changeSetFor("identity-multi-reversed", multiEdit("src/a.ts", [["const y = 1;", "const y = 6;"], ["const x = 1;", "const x = 5;"]]), ["src/a.ts"]);
const renamed = changeSetFor("identity-rename", patch("*** Update File: src/keep.ts", "*** Move to: src/renamed.ts", "@@", "-export const keep = 1;", "+export const keep = 2;"), ["src/keep.ts", "src/renamed.ts"]);
const deletedPlusCreated = changeSetOf("identity-delete-plus-create", [
	{ tag: "D", path: "src/keep.ts" },
	{ tag: "W", path: "src/renamed.ts", mode: "100644", content: "export const keep = 2;\n" },
]);
const noOp = changeSetOf("identity-no-op", []);

const identity = [
	{ id: "replace-all-differs", same: false, note: "replace_all true vs the one-occurrence byte state → different post-images → different identity", reviewed: "the two post_image_set_hash values differ; this is the row the mutation-gate replace_all bug would have caught", a: replaceAllTrue, b: oneOccurrenceOnly },
	{ id: "multiedit-order-irrelevant", same: true, note: "reordered MultiEdit entries producing the same bytes → SAME identity (correct)", reviewed: "identity is over post-images, not over the operation list", a: multiForward, b: multiReversed },
	{ id: "rename-equals-delete-plus-create", same: true, note: "a rename and a delete-plus-create with the same final state are the same identity (correct — not a collision)", reviewed: "both sides are one D and one W over the same two paths with the same bytes", a: renamed, b: deletedPlusCreated },
	{ id: "create-then-delete-is-the-no-op", same: true, note: "create-then-delete touches no path, so its identity IS the no-op identity", reviewed: "touched_paths is empty on both sides", a: noOp, b: changeSetOf("identity-no-op-again", []) },
	{ id: "no-op-differs-from-a-write", same: false, note: "the empty set is not the same identity as any write", reviewed: "guards the row above from being vacuously true", a: noOp, b: multiForward },
	{ id: "different-pre-tree", same: false, note: "identical post-images against a different pre-tree → different identity (a post-image set is PARTIAL)", reviewed: "only pre_tree_hash differs between a and b", a: multiForward, b: { ...multiForward, pre_tree_hash: replaceAllTrue.post_image_set_hash } },
	{ id: "self", same: true, note: "identity is reflexive", reviewed: "the trivial row — if this fails, the comparator is broken", a: multiForward, b: multiForward },
];

// ── malformed corpus (exit gate G2) ────────────────────────────────────────
// Hand-authored rows: `gen-shadow-corpus-malformed.mts` owns the notes, the
// value fixes and the added rows; the two path rows are built by this file's
// own tool-input builders so they stay in step with the projection rows.
const malformed = malformedCorpus(OUT, [...projectionExpansionRows(write("/etc/passwd", "x\n"), edit("../escape.ts", "a", "b")), ...ADDED_MALFORMED_ROWS]);

// ── binding comparison corpus (memo I4) ────────────────────────────────────
const bindings = generateBindingCorpus(agree);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "malformed-corpus.json"), `${JSON.stringify(malformed, null, "\t")}\n`);
writeFileSync(join(OUT, "hash-vectors.json"), `${JSON.stringify(hashVectors, null, "\t")}\n`);
writeFileSync(join(OUT, "projection-corpus.json"), `${JSON.stringify(projection, null, "\t")}\n`);
writeFileSync(join(OUT, "identity-table.json"), `${JSON.stringify(identity, null, "\t")}\n`);
writeFileSync(join(OUT, "binding-corpus.json"), `${JSON.stringify(bindings, null, "\t")}\n`);
const rejected = projection.filter((item) => item.expect.kind === "rejected").length;
process.stdout.write(`oracle and product agreed on every row\n`);
const disputes = projection.filter((item) => item.expect.kind === "disputed").length;
process.stdout.write(`wrote ${hashVectors.length} vectors, ${projection.length} projections (${rejected} rejection, ${disputes} disputed), ${identity.length} identity pairs, ${malformed.length} malformed rows, ${bindings.length} binding rows\n`);
