// Tests for delta-based assertion-density detection: `countAssertions`
// (block/assertion counting incl. named node:assert import credit) and
// `checkAssertionDensity` (the session-delta behavioral check built on it).

import { describe, expect, it } from "vitest";
import {
	checkAssertionDensity,
	countAssertions,
} from "./behavioral-checks-tdd-assertions.js";
import type { AssertionCounts, SessionTrajectory } from "./types.js";

/** Minimal session carrying only `assertion_counts` — the sole field this
 *  check reads/writes. */
function session(seed: Array<[string, AssertionCounts]> = []): SessionTrajectory {
	// SAFETY: checkAssertionDensity reads/writes only `assertion_counts`;
	// a full SessionTrajectory would add ~40 irrelevant fields.
	return {
		assertion_counts: new Map(seed),
	} as unknown as SessionTrajectory;
}

describe("countAssertions", () => {
	it("counts it()/test() blocks and expect()/assert calls", () => {
		const content = `
			it("does a thing", () => {
				expect(1).toBe(1);
			});
			test("does another", () => {
				assert.ok(true);
			});
		`;
		expect(countAssertions(content)).toEqual({ blocks: 2, assertions: 2 });
	});

	it("ignores expect()-like text inside comments and strings", () => {
		const content = `
			// expect(1).toBe(1); this is just a comment
			it("thing", () => {
				const s = "assert.ok(true)";
				expect(2).toBe(2);
			});
		`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 1 });
	});

	it("credits a plain (non-renamed) node:assert named import", () => {
		const content = `
			import { strictEqual } from "node:assert";
			it("thing", () => {
				strictEqual(1, 1);
			});
		`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 1 });
	});

	it("credits a RENAMED node:assert import to its local binding (rename branch)", () => {
		// `strictEqual as eq`: local="eq" is not itself an assert name, so the
		// else-if(local) branch must fire, resolve src="strictEqual" (which IS
		// in NODE_ASSERT_NAMES), and credit the local binding "eq".
		const content = `
			import { strictEqual as eq } from "node:assert";
			it("thing", () => {
				eq(1, 1);
			});
		`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 1 });
	});

	it("counts zero blocks when the content has no it()/test()/specify() calls", () => {
		const content = `
			import { strictEqual } from "node:assert";
			function helper() { return 1; }
		`;
		expect(countAssertions(content)).toEqual({ blocks: 0, assertions: 0 });
	});

	it("skips an empty import segment (trailing comma) without crediting or throwing", () => {
		// "strictEqual, " splits into ["strictEqual", " "] — the second segment
		// trims to "", so neither the direct-name check nor the rename else-if
		// branch fires for it (both require a truthy `local`).
		const content = `
			import { strictEqual, } from "node:assert";
			it("t", () => { strictEqual(1, 1); });
		`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 1 });
	});

	it("credits an import but adds zero when the named call never appears in the body", () => {
		const content = `
			import { strictEqual as eq } from "node:assert";
			it("t", () => { /* eq is imported but never called */ });
		`;
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 0 });
	});

	it("does not credit a rename where neither the source nor local name is a node:assert name", () => {
		const content = `
			import { someHelper as foo } from "node:assert";
			it("thing", () => {
				foo(1, 1);
			});
		`;
		// No assertions credited: "someHelper" isn't in NODE_ASSERT_NAMES, and
		// the local "foo" isn't either — the src&&includes(...) branch is false.
		expect(countAssertions(content)).toEqual({ blocks: 1, assertions: 0 });
	});
});

describe("checkAssertionDensity", () => {
	it("returns null for a non-test file path", () => {
		const s = session();
		const result = checkAssertionDensity(s, "src/lib/foo.ts", "it('x', () => {});");
		expect(result).toBeNull();
	});

	it("returns null when the content carries the exempt directive", () => {
		const s = session();
		const result = checkAssertionDensity(
			s,
			"src/lib/foo.test.ts",
			"// interlinked-tdd: exempt\nit('x', () => {});",
		);
		expect(result).toBeNull();
	});

	it("returns null and silently establishes the baseline on first sight", () => {
		const s = session();
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", "it('x', () => {});");
		expect(result).toBeNull();
		expect(s.assertion_counts.get("src/lib/foo.test.ts")).toEqual({ blocks: 1, assertions: 0 });
	});

	it("returns null when no new blocks were added (dBlocks <= 0)", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 2, assertions: 0 }]]);
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", "it('x', () => {});");
		expect(result).toBeNull();
	});

	it("returns null when new blocks came with new assertions (healthy edit)", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 1 }]]);
		const content = `
			it("a", () => { expect(1).toBe(1); });
			it("b", () => { expect(2).toBe(2); });
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toBeNull();
	});

	// P1 (must fire): a genuinely new it() block with no assertions in it —
	// the "b" block is new (dBlocks=1) and stays empty, so even though the
	// file total is unchanged (dAssertions=0), the empty-block count rose
	// from 0 to 1. Not a redistribution — must still fire.
	it("P1: fires with '0 new assertions' when a genuinely new block has no assertions (dAssertions === 0)", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 1 }]]);
		const content = `
			it("a", () => { expect(1).toBe(1); });
			it("b", () => {});
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toEqual({
			source: "structural",
			name: "assertion_density",
			severity: "warning",
			message:
				"Added 1 test block(s) with 0 new assertions. Each it()/test() block typically needs at least one expect()/assert*() call.",
			file: "src/lib/foo.test.ts",
			determinism: "heuristic",
		});
	});

	// N1 (must NOT fire): one it() split into several, its assertions
	// redistributed across the new blocks with no net change. Every new
	// block still carries an assertion (empty-block count stays 0 → 0), so
	// this must be credited, not reported as "0 new assertions".
	it("N1: returns null when one it() is split into several and assertions move with them (redistribution)", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 2 }]]);
		const content = `
			it("a — part 1", () => { expect(1).toBe(1); });
			it("a — part 2", () => { expect(2).toBe(2); });
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toBeNull();
	});

	// N2: a wider split (1 block → 5) with assertions fully redistributed
	// and no block left empty — same "must not fire" guarantee at a larger
	// fan-out, matching the statusline-snapshot incident this fix targets.
	it("N2: returns null when one it() is split into five focused blocks with no block left empty", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 5 }]]);
		const content = `
			it("renders idle", () => { expect(1).toBe(1); });
			it("renders loading", () => { expect(1).toBe(1); });
			it("renders success", () => { expect(1).toBe(1); });
			it("renders error", () => { expect(1).toBe(1); });
			it("renders empty", () => { expect(1).toBe(1); });
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toBeNull();
	});

	// P2 (must still fire): a split where ONE of the new blocks is left
	// genuinely empty (not just redistributed) — the empty-block count
	// still rises even though the file-level assertion total held steady
	// overall (2 before, 1 assertion carried into "part 1", 1 lost from
	// "part 2"). Proves the redistribution credit doesn't blanket-suppress
	// every dAssertions===0 case — it only credits blocks that keep an
	// assertion.
	it("P2: fires when a split leaves one of the new blocks genuinely empty", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 1 }]]);
		const content = `
			it("a — part 1", () => { expect(1).toBe(1); });
			it("a — part 2", () => {});
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toEqual({
			source: "structural",
			name: "assertion_density",
			severity: "warning",
			message:
				"Added 1 test block(s) with 0 new assertions. Each it()/test() block typically needs at least one expect()/assert*() call.",
			file: "src/lib/foo.test.ts",
			determinism: "heuristic",
		});
	});

	it("fires with singular '1 fewer assertion' when assertions dropped by exactly one", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 2 }]]);
		const content = `
			it("a", () => { expect(1).toBe(1); });
			it("b", () => {});
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toEqual({
			source: "structural",
			name: "assertion_density",
			severity: "warning",
			message:
				"Added 1 test block(s) with 1 fewer assertion. Each it()/test() block typically needs at least one expect()/assert*() call.",
			file: "src/lib/foo.test.ts",
			determinism: "heuristic",
		});
	});

	it("fires with plural '2 fewer assertions' when assertions dropped by more than one", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 2 }]]);
		const content = `
			it("a", () => {});
			it("b", () => {});
		`;
		const result = checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(result).toEqual({
			source: "structural",
			name: "assertion_density",
			severity: "warning",
			message:
				"Added 1 test block(s) with 2 fewer assertions. Each it()/test() block typically needs at least one expect()/assert*() call.",
			file: "src/lib/foo.test.ts",
			determinism: "heuristic",
		});
	});

	it("always refreshes the cached baseline for the next edit's delta", () => {
		const s = session([["src/lib/foo.test.ts", { blocks: 1, assertions: 1 }]]);
		const content = `
			it("a", () => { expect(1).toBe(1); });
			it("b", () => {});
		`;
		checkAssertionDensity(s, "src/lib/foo.test.ts", content);
		expect(s.assertion_counts.get("src/lib/foo.test.ts")).toEqual({ blocks: 2, assertions: 1 });
	});
});
