import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import { applyPostImages, blobDigestOf, byteLengthOf } from "./post-image-apply.js";
import type {
	ApplyPostImagesResultV1,
	PostImageWithContentV1,
	ShadowTreeFileV1,
} from "./post-image-apply.js";
import { asCanonicalPath } from "./path-rules.js";

function tree(entries: Record<string, ShadowTreeFileV1>): Map<string, ShadowTreeFileV1> {
	return new Map(Object.entries(entries));
}

function write(path: string, content: string, mode: "100644" | "100755" = "100644"): PostImageWithContentV1 {
	return {
		entry: {
			tag: "W",
			path: asCanonicalPath(path),
			mode,
			blob_digest: blobDigestOf(content),
			bytes: byteLengthOf(content),
		},
		content,
	};
}

function unlink(path: string): PostImageWithContentV1 {
	return { entry: { tag: "D", path: asCanonicalPath(path) }, content: null };
}

/** The applied tree, as a plain object — throws when the applier rejected, so
 *  no test body needs a branch. */
function applied(
	before: ReadonlyMap<string, ShadowTreeFileV1>,
	images: readonly PostImageWithContentV1[],
): Record<string, ShadowTreeFileV1> {
	const result = applyPostImages(before, images);
	if (!result.ok) throw new Error(`expected acceptance, got: ${result.detail}`);
	return Object.fromEntries(result.tree);
}

/** The rejection detail — throws when the applier accepted. */
function rejection(
	before: ReadonlyMap<string, ShadowTreeFileV1>,
	images: readonly PostImageWithContentV1[],
): string {
	const result: ApplyPostImagesResultV1 = applyPostImages(before, images);
	if (result.ok) throw new Error("expected a projection rejection, got acceptance");
	expect(result.reason).toBe("projection");
	return result.detail;
}

describe("applyPostImages — positive (must accept)", () => {
	it("P1: a W for a new path writes the bytes at the entry's mode", () => {
		expect(applied(tree({}), [write("src/a.ts", "export const a = 1;\n")])).toEqual({
			"src/a.ts": { mode: "100644", content: "export const a = 1;\n" },
		});
	});

	it("P2: a W over an existing path replaces its bytes and carries the entry's mode", () => {
		const before = tree({ "bin/run.sh": { mode: "100755", content: "old\n" } });
		expect(applied(before, [write("bin/run.sh", "new\n", "100755")])).toEqual({
			"bin/run.sh": { mode: "100755", content: "new\n" },
		});
	});

	it("P3: application is pure — the input tree is never mutated", () => {
		const before = tree({ "bin/run.sh": { mode: "100755", content: "old\n" } });
		applied(before, [write("bin/run.sh", "new\n", "100755")]);
		expect(before.get("bin/run.sh")).toEqual({ mode: "100755", content: "old\n" });
	});

	it("P4: a D for a present path unlinks it", () => {
		expect(applied(tree({ "src/gone.ts": { mode: "100644", content: "x" } }), [unlink("src/gone.ts")])).toEqual({});
	});

	it("P5: a rename applies literally as D(source) + W(destination) carrying the moved bytes", () => {
		const before = tree({ "src/old.ts": { mode: "100755", content: "moved\n" } });
		expect(applied(before, [unlink("src/old.ts"), write("src/new.ts", "moved\n", "100755")])).toEqual({
			"src/new.ts": { mode: "100755", content: "moved\n" },
		});
	});

	it("P6: an empty post-image set leaves the tree unchanged", () => {
		expect(applied(tree({ "a.ts": { mode: "100644", content: "a" } }), [])).toEqual({
			"a.ts": { mode: "100644", content: "a" },
		});
	});
});

describe("applyPostImages — negative (must reject)", () => {
	it("N1: a D for a path ABSENT in the pre-tree is a projection error, not a no-op", () => {
		expect(rejection(tree({}), [unlink("src/never-existed.ts")])).toContain("src/never-existed.ts");
	});

	it("N2: two records for one path are rejected — record order would be ambiguous", () => {
		expect(
			rejection(tree({ "a.ts": { mode: "100644", content: "a" } }), [write("a.ts", "one"), write("a.ts", "two")]),
		).toContain("a.ts");
	});

	it("N3: a W whose content is absent is rejected — the applier never invents bytes", () => {
		expect(rejection(tree({}), [{ entry: write("a.ts", "a").entry, content: null }])).toContain("content");
	});

	it("N4: a W whose content does not match its digest is rejected", () => {
		expect(rejection(tree({}), [{ entry: write("a.ts", "a").entry, content: "b" }])).toContain("digest");
	});

	it("N5: a W whose byte count does not match its content is rejected", () => {
		const entry = { ...write("a.ts", "a").entry, bytes: 99 };
		expect(rejection(tree({}), [{ entry, content: "a" }])).toContain("bytes");
	});

	it("N6: a D for a path deleted earlier in the SAME set is rejected as a duplicate path", () => {
		expect(rejection(tree({ "a.ts": { mode: "100644", content: "a" } }), [unlink("a.ts"), unlink("a.ts")])).toContain(
			"a.ts",
		);
	});

	it("N7: a set that leaves a regular file as another entry's parent directory is rejected", () => {
		expect(rejection(tree({ a: { mode: "100644", content: "x" } }), [write("a/b.ts", "y")])).toBe(
			"file/directory conflict: a is a file and an ancestor of a/b.ts",
		);
	});

	it("N8: the conflict is judged on the END STATE, so a set that writes BOTH is rejected either way round", () => {
		expect(rejection(tree({}), [write("a/b.ts", "y"), write("a", "x")])).toContain("file/directory conflict");
		expect(rejection(tree({}), [write("a", "x"), write("a/b.ts", "y")])).toContain("file/directory conflict");
	});
});

describe("applyPostImages file/directory rule — positive (must accept)", () => {
	it("P9: a set that DELETES the file and then writes under it is applied — only the end state must be possible", () => {
		expect(applied(tree({ a: { mode: "100644", content: "x" } }), [unlink("a"), write("a/b.ts", "y")])).toEqual({
			"a/b.ts": { mode: "100644", content: "y" },
		});
	});

	it("P10: the same set in the OTHER order still applies — a set is not a filesystem's ordering", () => {
		expect(applied(tree({ a: { mode: "100644", content: "x" } }), [write("a/b.ts", "y"), unlink("a")])).toEqual({
			"a/b.ts": { mode: "100644", content: "y" },
		});
	});

	it("P11: a sibling whose name merely starts with another path is not a conflict", () => {
		expect(applied(tree({ a: { mode: "100644", content: "x" } }), [write("a.ts", "y")])).toEqual({
			a: { mode: "100644", content: "x" },
			"a.ts": { mode: "100644", content: "y" },
		});
	});
});

describe("blobDigestOf/byteLengthOf — positive (must accept)", () => {
	it("P7: the digest is the lowercase hex sha-256 of the UTF-8 bytes", () => {
		expect(blobDigestOf("héllo")).toBe(sha256Hex(Buffer.from("héllo", "utf8")));
	});

	it("P8: the byte length counts UTF-8 bytes, not UTF-16 code units", () => {
		expect(byteLengthOf("héllo")).toBe(6);
	});
});
