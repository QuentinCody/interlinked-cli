import { describe, expect, it } from "vitest";
import {
	ancestorConflict,
	ancestorConflictAt,
	asCanonicalPath,
	checkCanonicalPath,
	checkGitMode,
	comparePathBytes,
	fileDirectoryConflictDetail,
	MAX_PATH_BYTES,
	MAX_PATH_COMPONENT_BYTES,
	modeRejectionReason,
	sortByPathBytes,
} from "./path-rules.js";

describe("path-rules — positive (must accept)", () => {
	it("P1: accepts ordinary repo-relative POSIX paths, dotfiles and spaces", () => {
		for (const path of ["src/new.ts", "a", ".gitignore", "dir/.hidden/file.json", "with space/and-dash.ts", "scratch/probe.mts"]) {
			expect(checkCanonicalPath(path, "path"), path).toBeNull();
		}
	});

	it("P2: accepts both admitted git modes", () => {
		expect(checkGitMode("100644", "mode")).toBeNull();
		expect(checkGitMode("100755", "mode")).toBeNull();
	});

	it("P3: sorts records bytewise by UTF-8 path bytes, case-sensitively", () => {
		const sorted = sortByPathBytes(
			[{ path: "b" }, { path: "B" }, { path: "a/b" }, { path: "a" }],
			(entry) => entry.path,
		).map((entry) => entry.path);
		// uppercase sorts before lowercase; "a" before "a/b" ("/" = 0x2f < any letter)
		expect(sorted).toEqual(["B", "a", "a/b", "b"]);
	});

	it("P4: compares by UTF-8 bytes, not UTF-16 code units (surrogate vs U+FFFD)", () => {
		// U+FFFD encodes as ef bf bd; U+1F600 as f0 9f 98 80 — so the astral
		// character sorts AFTER, even though its first UTF-16 code unit (D83D)
		// is numerically smaller.
		expect(comparePathBytes("�", "\u{1F600}")).toBeLessThan(0);
	});
});

describe("path-rules — negative (must reject)", () => {
	it("N1: rejects traversal, absolute paths, and empty or dot segments", () => {
		for (const path of ["../escape", "a/../b", "/abs", "a//b", "a/./b", "a/", "", "."]) {
			expect(checkCanonicalPath(path, "path"), path).not.toBeNull();
		}
	});

	it("N2: rejects backslash separators, NUL bytes and lone surrogates", () => {
		expect(checkCanonicalPath("a\\b", "path")).not.toBeNull();
		expect(checkCanonicalPath("a\0b", "path")).not.toBeNull();
		expect(checkCanonicalPath("a\uD800b", "path")).not.toBeNull();
	});

	it("N3: rejects an over-long path and an over-long component", () => {
		expect(checkCanonicalPath("a".repeat(MAX_PATH_BYTES + 1), "path")).toContain("bytes");
		expect(checkCanonicalPath(`dir/${"c".repeat(MAX_PATH_COMPONENT_BYTES + 1)}`, "path")).toContain("component");
	});

	it("N4: rejects symlink and submodule modes with the memo's reasons", () => {
		expect(checkGitMode("120000", "mode")).not.toBeNull();
		expect(modeRejectionReason("120000")).toBe("symlink_escape");
		expect(modeRejectionReason("160000")).toBe("invalid_tree");
		expect(modeRejectionReason("040000")).toBe("invalid_tree");
		expect(modeRejectionReason("100644")).toBeNull();
	});

	it("N5: asCanonicalPath throws rather than minting an invalid brand", () => {
		expect(() => asCanonicalPath("../nope")).toThrow();
		expect(asCanonicalPath("ok/path.ts")).toBe("ok/path.ts");
	});
});

describe("ancestorConflict — negative (must reject: an impossible tree)", () => {
	it("N6: a file that is also another entry's parent directory is reported as that pair", () => {
		expect(ancestorConflict(["a", "a/b.ts"])).toEqual(["a", "a/b.ts"]);
	});

	it("N7: input order does not change the reported pair — the rule sorts bytewise first", () => {
		expect(ancestorConflict(["a/b.ts", "a"])).toEqual(["a", "a/b.ts"]);
	});

	it("N8: a conflict two levels deep is found, and the OUTERMOST file is named", () => {
		expect(ancestorConflict(["src", "src/deep", "src/deep/x.ts"])).toEqual(["src", "src/deep"]);
	});

	it("N9: a conflict separated in sort order by an unrelated path is still found", () => {
		// "a!b" sorts BETWEEN "a" and "a/c" (0x21 < 0x2f), so an adjacent-pair
		// scan would miss this one. The rule walks each path's own ancestors.
		expect(ancestorConflict(["a", "a!b", "a/c"])).toEqual(["a", "a/c"]);
	});
});

describe("ancestorConflict — positive (must accept: a possible tree)", () => {
	it("P5: a prefix WITHOUT the `/` boundary is a sibling, not an ancestor", () => {
		expect(ancestorConflict(["a", "a.ts", "ab/c.ts"])).toBeNull();
	});

	it("P6: ordinary sibling and nested paths carry no conflict, and neither does the empty set", () => {
		expect(ancestorConflict(["src/a.ts", "src/b/c.ts", "src/b/d.ts"])).toBeNull();
		expect(ancestorConflict([])).toBeNull();
	});

	it("P7: a repeated path is not its own ancestor — duplicates are a different rule", () => {
		expect(ancestorConflict(["a/b.ts", "a/b.ts"])).toBeNull();
	});
});

describe("ancestorConflictAt — one path against a known set", () => {
	it("P8: a path with no ancestor and no descendant in the set is clean", () => {
		expect(ancestorConflictAt("src/new.ts", ["src/a.ts", "src/ab.ts"])).toBeNull();
	});

	it("P9: an UNKNOWN ancestor says nothing — the set carries no proof either way", () => {
		expect(ancestorConflictAt("src/a.ts/child.ts", ["other.ts"])).toBeNull();
	});

	it("N10: a known file that is an ancestor of the path is reported", () => {
		expect(ancestorConflictAt("src/a.ts/child.ts", ["src/a.ts"])).toEqual(["src/a.ts", "src/a.ts/child.ts"]);
	});

	it("N11: a known file UNDER the path is reported the other way round, bytewise-first", () => {
		expect(ancestorConflictAt("src/a.ts", ["src/a.ts/z.ts", "src/a.ts/b.ts"])).toEqual(["src/a.ts", "src/a.ts/b.ts"]);
	});

	it("N12: the path itself being in the set is not a conflict — a file may be rewritten", () => {
		expect(ancestorConflictAt("src/a.ts", ["src/a.ts"])).toBeNull();
	});
});

describe("fileDirectoryConflictDetail — one sentence for every surface", () => {
	it("P10: names the ancestor and the descendant in that order", () => {
		expect(fileDirectoryConflictDetail(["a", "a/b.ts"])).toBe("file/directory conflict: a is a file and an ancestor of a/b.ts");
	});
});
