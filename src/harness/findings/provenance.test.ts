import { describe, expect, it } from "vitest";
import {
	computeCompleteness,
	computeDedupKey,
	computeProvenanceId,
	hashRawBlob,
	normalizeFindingPath,
} from "./provenance.js";

describe("normalizeFindingPath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizeFindingPath("src\\harness\\foo.ts")).toBe("src/harness/foo.ts");
	});
	it("strips a leading ./", () => {
		expect(normalizeFindingPath("./src/foo.ts")).toBe("src/foo.ts");
	});
	it("is idempotent on already-normalized paths", () => {
		expect(normalizeFindingPath("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("computeCompleteness", () => {
	it("anchored_sha when file + line + commit are present", () => {
		expect(computeCompleteness({ file: "a.ts", lines: [1, 2], commit_sha: "deadbeef" })).toBe(
			"anchored_sha",
		);
	});
	it("anchored_line when file + line but no commit", () => {
		expect(computeCompleteness({ file: "a.ts", line: 5 })).toBe("anchored_line");
	});
	it("anchored_file when only a path is present", () => {
		expect(computeCompleteness({ file: "a.ts" })).toBe("anchored_file");
	});
	it("treats line 0 (unknown) as no line", () => {
		expect(computeCompleteness({ file: "a.ts", line: 0 })).toBe("anchored_file");
	});
	it("unanchored when there is no locator at all", () => {
		expect(computeCompleteness({})).toBe("unanchored");
	});
});

describe("computeDedupKey", () => {
	it("site tier when file + line are present", () => {
		const { tier, key } = computeDedupKey({ repo: "r", file: "a.ts", line: 42 });
		expect(tier).toBe("site");
		expect(key).not.toBe("");
	});
	it("file tier when file present but no line", () => {
		const { tier, key } = computeDedupKey({ repo: "r", file: "a.ts" });
		expect(tier).toBe("file");
		expect(key).not.toBe("");
	});
	it("class tier (empty key, never auto-merges) when no locator", () => {
		const { tier, key } = computeDedupKey({ repo: "r" });
		expect(tier).toBe("class");
		expect(key).toBe("");
	});
	it("is per-repo: different repos with same path/line yield different keys", () => {
		const a = computeDedupKey({ repo: "r1", file: "a.ts", line: 42 });
		const b = computeDedupKey({ repo: "r2", file: "a.ts", line: 42 });
		expect(a.key).not.toBe(b.key);
	});
	it("does not depend on commit sha: same file/line is the same key (multi-provenance kept)", () => {
		// The signature has no commit input by design — two reviewers at different
		// commits flag the SAME site, which must collapse to one dedup_key.
		const a = computeDedupKey({ repo: "r", file: "a.ts", line: 42 });
		const b = computeDedupKey({ repo: "r", file: "a.ts", line: 42 });
		expect(a.key).toBe(b.key);
	});
	it("different lines produce different keys", () => {
		const a = computeDedupKey({ repo: "r", file: "a.ts", line: 42 });
		const b = computeDedupKey({ repo: "r", file: "a.ts", line: 43 });
		expect(a.key).not.toBe(b.key);
	});
});

describe("computeProvenanceId", () => {
	it("is deterministic for the same sighting (idempotent re-harvest)", () => {
		const input: Parameters<typeof computeProvenanceId>[0] = {
			source_runner: "github-inline",
			repo: "o/r",
			pr: 7,
			commit_sha: "abc123",
			file: "a.ts",
			lines: [10, 12],
		};
		expect(computeProvenanceId(input)).toBe(computeProvenanceId(input));
	});
	it("differs when the source runner differs", () => {
		const base = { source_runner: "github-inline", repo: "o/r", file: "a.ts" };
		expect(computeProvenanceId(base)).not.toBe(
			computeProvenanceId({ ...base, source_runner: "code-review-plugin" }),
		);
	});
	it("uses raw_sha256 for prose sightings with no locator", () => {
		const a = computeProvenanceId({ source_runner: "paste", raw_sha256: "hash-a" });
		const b = computeProvenanceId({ source_runner: "paste", raw_sha256: "hash-b" });
		expect(a).not.toBe(b);
	});
});

describe("hashRawBlob", () => {
	it("is deterministic", () => {
		expect(hashRawBlob("hello")).toBe(hashRawBlob("hello"));
	});
	it("differs for different content", () => {
		expect(hashRawBlob("hello")).not.toBe(hashRawBlob("world"));
	});
	it("returns a 16-char hex string", () => {
		expect(hashRawBlob("hello")).toMatch(/^[0-9a-f]{16}$/);
	});
});
