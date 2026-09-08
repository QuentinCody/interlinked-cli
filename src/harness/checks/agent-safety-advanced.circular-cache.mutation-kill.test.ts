import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCircularImports } from "./agent-safety-advanced.js";

// Fleet R3 round-2 (2026-08-15) — src/harness/checks/agent-safety-advanced.ts
// residue. Round-1's receipt for mutantId 38c2ec25bb64be8d (checkCircularImports
// .readCached, ConditionalExpression `hit !== undefined` -> `false`) claimed
// "equivalent_candidate" via "exhaustive" proof, reasoning the cache is a pure
// perf optimization that never changes output because re-reading the same
// on-disk file yields the same content. That reasoning assumes the file's
// content is stable across the two reads within one check invocation — this
// test builds a diamond-import fixture where a mocked `readFileSync` returns
// DIFFERENT content on the second read of the same path, proving the cache
// check *is* an observable correctness gate, not just a speed lever: without
// it, a stale-but-still-cacheable read gets silently re-fetched and can flip
// the cycle-detection verdict mid-scan.

const state = vi.hoisted(() => ({ dPath: "", n: 0, content1: "", content2: "" }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (...[path, ...args]: Parameters<typeof actual.readFileSync>) => {
			if (typeof path === "string" && path === state.dPath) {
				state.n += 1;
				return state.n === 1 ? state.content1 : state.content2;
			}
			return actual.readFileSync(path, ...args);
		},
	};
});

describe("checkCircularImports — mutant-kill: readCached's memoization is load-bearing, not cosmetic", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-w6-cyc-cache-"));
		const aPath = join(dir, "a.ts");
		const bPath = join(dir, "b.ts");
		const cPath = join(dir, "c.ts");
		const dPath = join(dir, "d.ts");
		writeFileSync(aPath, "// placeholder — entry content is passed directly, not read from disk\n");
		writeFileSync(bPath, "import './d';\n");
		writeFileSync(cPath, "import './d';\n");
		writeFileSync(dPath, "// placeholder — readFileSync for this path is mocked below\n");
		state.dPath = dPath;
		state.n = 0;
		// First read of d (reached via b): no imports out of d, so no cycle.
		state.content1 = "export const d = 1;\n";
		// Second read of d (reached via c, SAME path): imports back to a. If the
		// cache is bypassed (mutant), this second, DIFFERENT content is fetched
		// and a cycle a -> c -> d -> a is discovered that the cached (pristine)
		// run never sees, because it never re-reads d.
		state.content2 = "import './a';\n";
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: bug — kills mutant 38c2ec25bb64be8d
	it("P: a diamond import (b and c both importing d) reads d's content only ONCE, not once per importer", () => {
		const aPath = join(dir, "a.ts");
		const entryContent = "import './b';\nimport './c';\n";
		const out = checkCircularImports(entryContent, aPath, dir);
		// Under pristine caching: d's second read (via c) hits the cache and
		// still sees content1 (no import back to a) — no cycle.
		expect(out.length).toBe(0);
		// Directly pins the load-bearing behavior: exactly one physical read.
		expect(state.n).toBe(1);
	});
});
