import { describe, expect, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import { computeDependencyTreeHash, computePostTreeHash, computePreTreeHash, type TreeEntryInput } from "./tree-hash.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function digestOf(content: string): string {
	return sha256Hex(Buffer.from(content, "utf8"));
}

function entry(path: string, content: string, mode = "100644"): TreeEntryInput {
	const blob = Buffer.from(content, "utf8");
	return { path, mode, blob_digest: sha256Hex(blob), bytes: blob.length };
}

/** The grammar, re-implemented from the memo's prose in the TEST, so the
 *  expectation pins BYTES and not the implementation's own arithmetic. */
function record(mode: string, path: string, digestHex: string): Buffer {
	return Buffer.concat([
		Buffer.from(mode, "ascii"),
		Buffer.from([0x20]),
		Buffer.from(path, "utf8"),
		Buffer.from([0x00]),
		Buffer.from(digestHex, "hex"),
	]);
}

function expectedHash(records: readonly Buffer[]): string {
	return sha256Hex(Buffer.concat([...records]));
}

function hashOf(entries: readonly TreeEntryInput[]): string {
	const result = computePreTreeHash(entries);
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
	return result.hash;
}

describe("shadow-tree-v1 — positive (must accept)", () => {
	it("P1: fixed known vector — one entry, mode ‖ 0x20 ‖ path ‖ 0x00 ‖ digest32", () => {
		const one = entry("src/a.ts", "hello");
		expect(hashOf([one])).toBe(expectedHash([record("100644", "src/a.ts", digestOf("hello"))]));
	});

	it("P2: fixed known vector — three entries concatenated with NO separator", () => {
		const entries = [entry("b.ts", "bee"), entry("a.ts", "ay"), entry("c.ts", "cee", "100755")];
		expect(hashOf(entries)).toBe(
			expectedHash([
				record("100644", "a.ts", digestOf("ay")),
				record("100644", "b.ts", digestOf("bee")),
				record("100755", "c.ts", digestOf("cee")),
			]),
		);
	});

	it("P3: order independence — the input array order does not change the hash", () => {
		const entries = [entry("a.ts", "1"), entry("m/n.ts", "2"), entry("z.ts", "3")];
		const shuffled = [entries[2], entries[0], entries[1]].filter((e): e is TreeEntryInput => e !== undefined);
		expect(hashOf(shuffled)).toBe(hashOf(entries));
	});

	it("P4: ordering is BYTEWISE and case-sensitive — uppercase sorts before lowercase", () => {
		const upper = entry("Z.ts", "u");
		const lower = entry("a.ts", "l");
		expect(hashOf([lower, upper])).toBe(
			expectedHash([record("100644", "Z.ts", digestOf("u")), record("100644", "a.ts", digestOf("l"))]),
		);
	});

	it("P5: a multi-byte UTF-8 path orders by its UTF-8 bytes, not code units", () => {
		// "é" is 0xC3 0xA9, so it sorts AFTER "z" (0x7A) bytewise.
		const accented = entry("é.ts", "e");
		const zed = entry("z.ts", "z");
		expect(hashOf([accented, zed])).toBe(
			expectedHash([record("100644", "z.ts", digestOf("z")), record("100644", "é.ts", digestOf("e"))]),
		);
	});

	it("P6: an empty entry set hashes the empty byte string", () => {
		expect(hashOf([])).toBe(EMPTY_SHA256);
	});

	it("P7: mode is part of the record — 100755 differs from 100644", () => {
		expect(hashOf([entry("a.ts", "x", "100755")])).not.toBe(hashOf([entry("a.ts", "x", "100644")]));
	});

	it("P8: post-tree and pre-tree use the SAME grammar (one algorithm, two brands)", () => {
		const entries = [entry("a.ts", "x"), entry("b.ts", "y")];
		const post = computePostTreeHash(entries);
		expect(post.ok && post.hash).toBe(hashOf(entries));
	});

	it("P9: shadow-dependency-tree-v1 reuses the tree grammar over the dependency subtree", () => {
		const entries = [entry("node_modules/x/index.js", "m"), entry("node_modules/.package-lock.json", "l")];
		const dependency = computeDependencyTreeHash(entries);
		expect(dependency.ok && dependency.hash).toBe(
			expectedHash([
				record("100644", "node_modules/.package-lock.json", digestOf("l")),
				record("100644", "node_modules/x/index.js", digestOf("m")),
			]),
		);
	});
});

describe("shadow-tree-v1 — negative (must reject)", () => {
	it("N1: a symlink mode is unavailable(symlink_escape)", () => {
		const result = computePreTreeHash([{ ...entry("link", "t"), mode: "120000" }]);
		expect(result).toMatchObject({ ok: false, reason: "symlink_escape" });
	});

	it("N2: a submodule mode is unavailable(invalid_tree)", () => {
		const result = computePreTreeHash([{ ...entry("sub", "t"), mode: "160000" }]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N3: a directory mode is unavailable(invalid_tree)", () => {
		const result = computePreTreeHash([{ ...entry("dir", "t"), mode: "40000" }]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N4: a traversal path is rejected", () => {
		const result = computePreTreeHash([entry("../escape.ts", "t")]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N5: an absolute path is rejected", () => {
		const result = computePreTreeHash([entry("/etc/passwd", "t")]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N6: a duplicate path is rejected — record order would be ambiguous", () => {
		const result = computePreTreeHash([entry("a.ts", "one"), entry("a.ts", "two")]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
		expect(result.ok ? "" : result.detail).toContain("a.ts");
	});

	it("N7: an uppercase-hex digest is rejected (the grammar is lowercase hex)", () => {
		const bad: TreeEntryInput = { ...entry("a.ts", "x"), blob_digest: digestOf("x").toUpperCase() };
		expect(computePreTreeHash([bad])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N8: a short digest is rejected", () => {
		const bad: TreeEntryInput = { ...entry("a.ts", "x"), blob_digest: "abc123" };
		expect(computePreTreeHash([bad])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N9: an empty path segment is rejected", () => {
		expect(computePreTreeHash([entry("a//b.ts", "t")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N10: a backslash path is rejected (POSIX separators only)", () => {
		expect(computePreTreeHash([entry("src\\a.ts", "t")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N11: rejection never throws — it returns the discriminated failure", () => {
		expect(() => computePreTreeHash([entry("../x", "t")])).not.toThrow();
	});

	it("N12: a regular file that is ALSO another entry's parent directory is rejected as invalid_tree", () => {
		const result = computePreTreeHash([entry("a", "x"), entry("a/b.ts", "y")]);
		expect(result).toMatchObject({ ok: false, reason: "invalid_tree" });
		expect(result.ok ? "" : result.detail).toBe("file/directory conflict: a is a file and an ancestor of a/b.ts");
	});

	it("N13: the conflict is found whatever order the entries arrive in", () => {
		expect(computePreTreeHash([entry("a/b.ts", "y"), entry("a", "x")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});

	it("N14: a post tree and a dependency tree are refused by the same rule — one grammar, three wrappers", () => {
		expect(computePostTreeHash([entry("a", "x"), entry("a/b.ts", "y")])).toMatchObject({ ok: false, reason: "invalid_tree" });
		expect(computeDependencyTreeHash([entry("a", "x"), entry("a/b.ts", "y")])).toMatchObject({ ok: false, reason: "invalid_tree" });
	});
});

describe("shadow-tree-v1 file/directory rule — positive (must accept)", () => {
	it("P12: a string prefix WITHOUT the `/` boundary is a sibling and still hashes", () => {
		expect(hashOf([entry("a", "x"), entry("a.ts", "y"), entry("ab/c.ts", "z")])).toMatch(/^[0-9a-f]{64}$/);
	});

	it("P13: ordinary nested paths under a shared directory are untouched by the rule", () => {
		expect(hashOf([entry("src/b/c.ts", "x"), entry("src/b/d.ts", "y")])).toMatch(/^[0-9a-f]{64}$/);
	});
});
