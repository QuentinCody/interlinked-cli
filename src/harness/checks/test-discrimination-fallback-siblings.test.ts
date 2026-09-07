import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findSiblingTestFiles,
	siblingNonDefaultTargets,
} from "./test-discrimination-fallback-siblings.js";

// `findSiblingTestFiles` / `siblingNonDefaultTargets` extend the file-level
// sibling-visibility rule in `test-discrimination-fallback.ts` ACROSS test
// files: `foo.test.ts` and `foo.mutation-kill-w12.test.ts` (or a `__tests__/`
// companion) share one SUT, so a non-default pin in one must exempt a
// fallback-only block in the other. All fixtures live under a scratch
// mkdtemp dir — never touches the real tree.

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fallback-siblings-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf-8");
	return full;
}

describe("findSiblingTestFiles — positive (must resolve)", () => {
	it("P1: finds a same-directory mutation-kill companion by shared SUT stem", () => {
		const main = write("foo.test.ts", "");
		write("foo.mutation-kill-w12.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toContain(join(dir, "foo.mutation-kill-w12.test.ts"));
	});

	it("P2: finds a companion inside a child __tests__/ directory", () => {
		const main = write("foo.test.ts", "");
		write("__tests__/foo.integration.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toContain(join(dir, "__tests__", "foo.integration.test.ts"));
	});

	it("P3: from inside __tests__/, finds a companion in the parent directory", () => {
		const main = write("__tests__/foo.test.ts", "");
		write("foo.integration.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toContain(join(dir, "foo.integration.test.ts"));
	});

	it("P5: strips a BARE `.mutation-kill` suffix with no trailing `-id` (found via a real FP: file-dump-guard-parse.mutation-kill.test.ts)", () => {
		const main = write("file-dump-guard-parse.mutation-kill.test.ts", "");
		write("file-dump-guard-parse.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toContain(join(dir, "file-dump-guard-parse.test.ts"));
	});

	it("P4: strips chained suffixes (.mutation-kill-*, .luna*, .integration) to match a bare stem", () => {
		const main = write("swift.mutation-kill-w43.test.ts", "");
		write("swift.integration.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toContain(join(dir, "swift.integration.test.ts"));
	});
});

describe("findSiblingTestFiles — negative (must not resolve)", () => {
	it("N1: does not include the file itself", () => {
		const main = write("foo.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).not.toContain(main);
	});

	it("N2: does not match a different SUT stem", () => {
		const main = write("foo.test.ts", "");
		write("bar.test.ts", "");
		const found = findSiblingTestFiles(main);
		expect(found).toHaveLength(0);
	});

	it("N3: returns [] for a nonexistent directory without throwing", () => {
		const main = join(dir, "gone", "foo.test.ts");
		expect(() => findSiblingTestFiles(main)).not.toThrow();
		expect(findSiblingTestFiles(main)).toEqual([]);
	});

	it("N4: caps at 12 sibling files", () => {
		const main = write("foo.test.ts", "");
		for (let i = 0; i < 20; i++) write(`foo.mutation-kill-w${i}.test.ts`, "");
		const found = findSiblingTestFiles(main);
		expect(found.length).toBeLessThanOrEqual(12);
	});
});

describe("siblingNonDefaultTargets", () => {
	it("unions targets computed from every sibling's content via the injected callback", () => {
		write("foo.test.ts", "");
		write("foo.mutation-kill-w1.test.ts", "content-a");
		write("foo.mutation-kill-w2.test.ts", "content-b");
		const main = join(dir, "foo.test.ts");
		const seen: string[] = [];
		const targets = siblingNonDefaultTargets(main, (content) => {
			seen.push(content);
			return new Set([content]);
		});
		expect(targets).toEqual(new Set(["content-a", "content-b"]));
		expect(seen.sort()).toEqual(["content-a", "content-b"]);
	});

	it("skips an unreadable sibling without throwing (e.g. removed between list and read)", () => {
		const main = write("foo.test.ts", "");
		const ghost = join(dir, "foo.mutation-kill-ghost.test.ts");
		writeFileSync(ghost, "x", "utf-8");
		rmSync(ghost);
		// Re-create a real sibling so the union isn't trivially empty either way.
		write("foo.mutation-kill-real.test.ts", "y");
		expect(() => siblingNonDefaultTargets(main, () => new Set(["y"]))).not.toThrow();
	});

	it("returns an empty set when there are no siblings", () => {
		const main = write("foo.test.ts", "");
		expect(siblingNonDefaultTargets(main, () => new Set(["anything"]))).toEqual(new Set());
	});
});
