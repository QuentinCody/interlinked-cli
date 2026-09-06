import { describe, expect, it } from "vitest";
import { computeChangeSet, sameContentIdentity } from "./changeset.js";
import { asCanonicalPath } from "./path-rules.js";
import { projectPostImages } from "./post-image-projector.js";
import type { PreImageInputV1 } from "./post-image-projector.js";
import { computePostImageSetHash } from "./tagged-set.js";
import { computePreTreeHash } from "./tree-hash.js";
import type {
	BlobDigest,
	CanonicalPath,
	GitMode,
	MultiEditEntryV1,
	NormalizedToolInputV1,
	PostImageEntryV1,
	PostImageSetHash,
	PreTreeHash,
	ShadowChangeSetV1,
} from "./types-core.js";

// ── fixtures ───────────────────────────────────────────────────────────────
/** Two DIFFERENT valid pre-tree hashes, minted by the real grammar. */
function preTreeHash(entries: readonly { path: string; mode: string; blob_digest: string; bytes: number }[]): PreTreeHash {
	const result = computePreTreeHash(entries);
	if (!result.ok) throw new Error(`fixture pre-tree hash failed: ${result.detail}`);
	return result.hash;
}

function blobDigest(hex: string): BlobDigest {
	// SAFETY: a test fixture digest — the shape the grammar accepts (64 lowercase hex), never a real file's content.
	return hex as BlobDigest;
}

const DIGEST_A = blobDigest("a".repeat(64));
const DIGEST_B = blobDigest("b".repeat(64));
const PRE_EMPTY = preTreeHash([]);
const PRE_ONE = preTreeHash([{ path: "src/a.ts", mode: "100644", blob_digest: DIGEST_A, bytes: 3 }]);

function writeEntry(path: string, digest: BlobDigest = DIGEST_A, bytes = 3): PostImageEntryV1 {
	return { tag: "W", path: asCanonicalPath(path), mode: "100644", blob_digest: digest, bytes };
}
function deleteEntry(path: string): PostImageEntryV1 {
	return { tag: "D", path: asCanonicalPath(path) };
}

/** The tagged grammar's own hash of the same entries — the value the
 *  changeset's `post_image_set_hash` must equal. */
function setHashOf(entries: readonly PostImageEntryV1[]): PostImageSetHash {
	const result = computePostImageSetHash(entries);
	if (!result.ok) throw new Error(`fixture set hash failed: ${result.detail}`);
	return result.hash;
}

/** The changeset, or a throw — no test body needs a branch. */
function changesetOf(pre: PreTreeHash, postImages: readonly PostImageEntryV1[]): ShadowChangeSetV1 {
	const result = computeChangeSet({ pre_tree_hash: pre, postImages });
	if (!result.ok) throw new Error(`expected a changeset, got: ${result.reason} — ${result.detail}`);
	return result.changeset;
}

function rejectionOf(pre: PreTreeHash, postImages: readonly PostImageEntryV1[]): { reason: string; detail: string } {
	const result = computeChangeSet({ pre_tree_hash: pre, postImages });
	if (result.ok) throw new Error("expected a rejection, got a changeset");
	return { reason: result.reason, detail: result.detail };
}

// ── end-to-end drivers: real tool inputs through the strict projector ───────
function editInput(path: string, edit: MultiEditEntryV1): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "Edit",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		old_string: edit.old_string,
		new_string: edit.new_string,
		replace_all: edit.replace_all,
	};
}
function writeInput(path: string, content: string): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "Write",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		content,
	};
}
function multiEditInput(path: string, edits: readonly MultiEditEntryV1[]): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "claude-code",
		tool: "MultiEdit",
		semantics_version: 1,
		file_path: asCanonicalPath(path),
		edits,
	};
}
function patchInput(patch: string): NormalizedToolInputV1 {
	return {
		schema: "shadow-tool-input-v1",
		client: "codex",
		tool: "apply_patch",
		semantics_version: 1,
		patch,
		raw_source_field: "command",
	};
}

/** Project a real tool input against a real pre-image, then take its content
 *  identity — the table below is exercised end to end, never on hand-built
 *  entries alone. */
function identityOf(
	input: NormalizedToolInputV1,
	preImages: Record<string, PreImageInputV1>,
	pre: PreTreeHash = PRE_ONE,
): ShadowChangeSetV1 {
	const projection = projectPostImages(input, new Map(Object.entries(preImages)));
	if (!projection.ok) throw new Error(`fixture projection failed: ${projection.reason} — ${projection.detail}`);
	return changesetOf(
		pre,
		projection.images.map((image) => image.entry),
	);
}

const RENAME_PATCH = [
	"*** Begin Patch",
	"*** Update File: src/old.ts",
	"*** Move to: src/new.ts",
	"@@",
	"-const a = 1;",
	"+const a = 2;",
	"*** End Patch",
].join("\n");
const DELETE_PLUS_CREATE_PATCH = [
	"*** Begin Patch",
	"*** Delete File: src/old.ts",
	"*** Add File: src/new.ts",
	"+const a = 2;",
	"*** End Patch",
].join("\n");
const CREATE_THEN_DELETE_PATCH = [
	"*** Begin Patch",
	"*** Add File: tmp/scratch.txt",
	"+temporary",
	"*** Delete File: tmp/scratch.txt",
	"*** End Patch",
].join("\n");

// ── computeChangeSet ───────────────────────────────────────────────────────
describe("computeChangeSet — positive (must accept)", () => {
	it("P1: an empty post-image set yields no touched paths and the empty-set hash", () => {
		const changeset = changesetOf(PRE_EMPTY, []);
		expect(changeset.schema_version).toBe(1);
		expect(changeset.touched_paths).toEqual([]);
		expect(changeset.pre_tree_hash).toBe(PRE_EMPTY);
		expect(changeset.post_image_set_hash).toBe(setHashOf([]));
	});

	it("P2: post_image_set_hash is exactly the tagged-set grammar's hash of the same entries", () => {
		const entries = [writeEntry("src/a.ts"), deleteEntry("src/gone.ts")];
		expect(changesetOf(PRE_ONE, entries).post_image_set_hash).toBe(setHashOf(entries));
	});

	it("P3: touched_paths carries every path in the set — W and D alike — sorted bytewise", () => {
		const changeset = changesetOf(PRE_ONE, [writeEntry("src/z.ts"), deleteEntry("src/a.ts"), writeEntry("Z.ts")]);
		expect(changeset.touched_paths).toEqual(["Z.ts", "src/a.ts", "src/z.ts"]);
	});

	it("P4: entry order does not change the changeset — the grammar sorts", () => {
		const forward = changesetOf(PRE_ONE, [writeEntry("a.ts"), writeEntry("b.ts", DIGEST_B)]);
		const reversed = changesetOf(PRE_ONE, [writeEntry("b.ts", DIGEST_B), writeEntry("a.ts")]);
		expect(sameContentIdentity(forward, reversed)).toBe(true);
	});
});

describe("computeChangeSet — negative (must reject)", () => {
	it("N1: two records for one path is a reject — the set's meaning would be ambiguous", () => {
		expect(rejectionOf(PRE_ONE, [writeEntry("src/a.ts"), deleteEntry("src/a.ts")])).toEqual({
			reason: "invalid_tree",
			detail: expect.stringContaining("duplicate path"),
		});
	});

	it("N2: a non-canonical path is a reject", () => {
		// SAFETY: the CanonicalPath brand is forged so the grammar's path rule — the rule under test — runs at runtime.
		const escaping = "../escape.ts" as CanonicalPath;
		expect(rejectionOf(PRE_ONE, [{ tag: "D", path: escaping }]).reason).toBe("invalid_tree");
	});

	it("N3: a pre_tree_hash that is not a lowercase hex sha-256 is a reject", () => {
		// SAFETY: the brand is deliberately forged here to prove the runtime
		// check exists — a caller that skips the tree grammar cannot mint an
		// identity against a hash the protocol never produced.
		const forged = "not-a-digest" as PreTreeHash;
		expect(rejectionOf(forged, [writeEntry("src/a.ts")])).toEqual({
			reason: "invalid_tree",
			detail: expect.stringContaining("pre_tree_hash"),
		});
	});

	it("N4: a mode v0 refuses is a reject carrying the mode's own reason", () => {
		// SAFETY: the GitMode brand is forged so the grammar's mode rule — the rule under test — is reached at runtime.
		const symlinkMode = "120000" as GitMode;
		const symlink: PostImageEntryV1 = {
			tag: "W",
			path: asCanonicalPath("src/link.ts"),
			mode: symlinkMode,
			blob_digest: DIGEST_A,
			bytes: 3,
		};
		expect(rejectionOf(PRE_ONE, [symlink]).reason).toBe("symlink_escape");
	});
});

// ── the memo's content-identity equality table (§8.0) ───────────────────────
describe("content identity equality table — positive (must accept: SAME identity)", () => {
	it("P5: reordered MultiEdit entries producing the same bytes are the SAME identity", () => {
		const forward = identityOf(
			multiEditInput("src/a.ts", [
				{ old_string: "alpha", new_string: "ALPHA", replace_all: false },
				{ old_string: "beta", new_string: "BETA", replace_all: false },
			]),
			{ "src/a.ts": "alpha beta\n" },
		);
		const reordered = identityOf(
			multiEditInput("src/a.ts", [
				{ old_string: "beta", new_string: "BETA", replace_all: false },
				{ old_string: "alpha", new_string: "ALPHA", replace_all: false },
			]),
			{ "src/a.ts": "alpha beta\n" },
		);
		expect(sameContentIdentity(forward, reordered)).toBe(true);
	});

	it("P6: rename and delete-plus-create with an identical final state are the SAME identity", () => {
		// Only an explicit null proves absence (review 2026-09-04): the move
		// destination must be in the map, as "looked, not there".
		const preImages = { "src/old.ts": "const a = 1;", "src/new.ts": null };
		const renamed = identityOf(patchInput(RENAME_PATCH), preImages);
		const rebuilt = identityOf(patchInput(DELETE_PLUS_CREATE_PATCH), preImages);
		expect(renamed.touched_paths).toEqual(["src/new.ts", "src/old.ts"]);
		expect(sameContentIdentity(renamed, rebuilt)).toBe(true);
	});

	it("P7: create-then-delete touches no path and equals the no-op identity", () => {
		const transient = identityOf(patchInput(CREATE_THEN_DELETE_PATCH), { "tmp/scratch.txt": null }, PRE_EMPTY);
		expect(transient.touched_paths).toEqual([]);
		expect(sameContentIdentity(transient, changesetOf(PRE_EMPTY, []))).toBe(true);
	});

	it("P8: two separately built changesets over the same three fields are the same identity", () => {
		const entries = [writeEntry("src/a.ts"), deleteEntry("src/b.ts")];
		expect(sameContentIdentity(changesetOf(PRE_ONE, entries), changesetOf(PRE_ONE, [...entries]))).toBe(true);
	});
});

describe("content identity equality table — negative (must reject: DIFFERENT identity)", () => {
	it("N5: replace_all true vs false, producing different post-images, are DIFFERENT identities", () => {
		const preImages = { "src/a.ts": "x-x-x" };
		const all = identityOf(editInput("src/a.ts", { old_string: "x", new_string: "y", replace_all: true }), preImages);
		// The one-occurrence result of the SAME edit with replace_all false.
		// The strict projector refuses to guess it from an ambiguous Edit (see
		// the assertion below), so the bytes arrive as a real Write input —
		// the point of the case is that the two byte states are two identities.
		const once = identityOf(writeInput("src/a.ts", "y-x-x"), preImages);
		expect(once.touched_paths).toEqual(all.touched_paths);
		expect(sameContentIdentity(once, all)).toBe(false);

		const ambiguous = projectPostImages(
			editInput("src/a.ts", { old_string: "x", new_string: "y", replace_all: false }),
			new Map(Object.entries(preImages)),
		);
		expect(ambiguous.ok).toBe(false);
	});

	it("N6: identical post-images against a different pre_tree_hash are DIFFERENT identities", () => {
		const entries = [writeEntry("src/a.ts")];
		expect(sameContentIdentity(changesetOf(PRE_ONE, entries), changesetOf(PRE_EMPTY, entries))).toBe(false);
	});

	it("N7: the same paths carrying different bytes are DIFFERENT identities", () => {
		const before = changesetOf(PRE_ONE, [writeEntry("src/a.ts", DIGEST_A)]);
		const after = changesetOf(PRE_ONE, [writeEntry("src/a.ts", DIGEST_B)]);
		expect(before.touched_paths).toEqual(after.touched_paths);
		expect(sameContentIdentity(before, after)).toBe(false);
	});

	it("N8: an extra touched path is a DIFFERENT identity", () => {
		const one = changesetOf(PRE_ONE, [writeEntry("src/a.ts")]);
		const two = changesetOf(PRE_ONE, [writeEntry("src/a.ts"), deleteEntry("src/b.ts")]);
		expect(sameContentIdentity(one, two)).toBe(false);
	});

	it("N9: a W and a D over the same single path are DIFFERENT identities", () => {
		const written = changesetOf(PRE_ONE, [writeEntry("src/a.ts")]);
		const deleted = changesetOf(PRE_ONE, [deleteEntry("src/a.ts")]);
		expect(deleted.touched_paths).toEqual(written.touched_paths);
		expect(sameContentIdentity(written, deleted)).toBe(false);
	});
});
