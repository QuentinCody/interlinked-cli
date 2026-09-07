import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFallbackOnlyAssertion } from "./test-discrimination-fallback.js";

// `checkFallbackOnlyAssertion` flags it()/test() blocks whose EVERY assertion
// belongs to the default/no-op-outcome family (toBeNull, toEqual([]),
// not.toThrow(), etc.) — a shape a `return []`-style mutant of the branch
// under test would satisfy identically. Fixtures are passed as `content`
// strings to the SUT below, so every expectation here traces to the SUT.

function run(content: string, path = "widget.test.ts"): ReturnType<typeof checkFallbackOnlyAssertion> {
	return checkFallbackOnlyAssertion(content, path);
}

describe("checkFallbackOnlyAssertion — positive (must fire)", () => {
	it("P1: flags a sole toEqual([]) assertion", () => {
		const found = run(`it("processes the batch", () => { expect(getItems()).toEqual([]); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("fallback_only_assertion:");
	});

	it("P2: flags a sole toBeNull() assertion", () => {
		const found = run(`it("finds none", () => { expect(find(x)).toBeNull(); });`);
		expect(found).toHaveLength(1);
	});

	it("P3: flags a sole not.toHaveBeenCalled() assertion", () => {
		const found = run(`it("processes the callback", () => { expect(cb).not.toHaveBeenCalled(); });`);
		expect(found).toHaveLength(1);
	});

	it("P4: flags a sole resolves.not.toThrow() assertion", () => {
		const found = run(`it("resolves quietly", async () => { await expect(run()).resolves.not.toThrow(); });`);
		expect(found).toHaveLength(1);
	});

	it("P5: flags a sole toBe(false) assertion on a non-predicate target", () => {
		expect(run(`it("computes state", () => { expect(computeFlag()).toBe(false); });`)).toHaveLength(1);
	});

	it("P6: flags a sole toHaveLength(0) assertion", () => {
		expect(run(`it("empty", () => { expect(list()).toHaveLength(0); });`)).toHaveLength(1);
	});

	it("P7: flags a block whose ONLY two assertions are both default-outcome", () => {
		const found = run(
			`it("noop", () => { expect(getItems()).toEqual([]); expect(getCount()).toBe(0); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P8: names the assertion count in the finding", () => {
		const found = run(
			`it("noop", () => { expect(getItems()).toEqual([]); expect(getCount()).toBe(0); });`,
		);
		expect(found[0]?.text).toMatch(/2 assertion/);
	});
});

describe("checkFallbackOnlyAssertion — negative (must not fire)", () => {
	it("N1: does not flag when a non-default assertion is present", () => {
		expect(
			run(`it("adds", () => { expect(add(1, 2)).toBe(3); expect(getItems()).toEqual([]); });`),
		).toEqual([]);
	});

	it("N2: does not flag toBe(3) alone", () => {
		expect(run(`it("adds", () => { expect(add(1, 2)).toBe(3); });`)).toEqual([]);
	});

	it("N3: does not flag toEqual({a: 1})", () => {
		expect(run(`it("shapes", () => { expect(build()).toEqual({ a: 1 }); });`)).toEqual([]);
	});

	it("N4: does not flag toHaveBeenCalledWith(...)", () => {
		expect(run(`it("calls", () => { expect(cb).toHaveBeenCalledWith("x"); });`)).toEqual([]);
	});

	it("N5: does not flag toThrow with a message (not negated)", () => {
		expect(run(`it("throws", () => { expect(() => run()).toThrow("bad input"); });`)).toEqual([]);
	});

	it("N6: does not flag toContain", () => {
		expect(run(`it("contains", () => { expect(list()).toContain("x"); });`)).toEqual([]);
	});

	it("N7: does not flag a block with zero assertions (assertion_free_test's job)", () => {
		expect(run(`it("setup", () => { const x = build(); });`)).toEqual([]);
	});

	it("N8: does not flag a skipped test (it.skip)", () => {
		expect(run(`it.skip("noop", () => { expect(getItems()).toEqual([]); });`)).toEqual([]);
	});

	it("N9: does not flag a todo test (it.todo)", () => {
		expect(run(`it.todo("noop");`)).toEqual([]);
	});

	it("N10: does not flag a test nested inside describe.skip", () => {
		expect(
			run(`describe.skip("suite", () => { it("noop", () => { expect(getItems()).toEqual([]); }); });`),
		).toEqual([]);
	});

	it("N11: does not flag toBe(null) mixed with a non-default toBe(7)", () => {
		expect(
			run(`it("mixed", () => { expect(a()).toBeNull(); expect(b()).toBe(7); });`),
		).toEqual([]);
	});

	it("N12: ignores non-test files", () => {
		expect(run(`it("noop", () => { expect(getItems()).toEqual([]); });`, "src/widget.ts")).toEqual([]);
	});

	it("N13: handles a multi-line expect call without flagging a non-default matcher", () => {
		expect(
			run(
				`it("adds", () => {\n  expect(\n    add(1, 2)\n  ).toBe(3);\n});`,
			),
		).toEqual([]);
	});

	it("N14: does not flag toBe(0) alongside a real string assertion", () => {
		expect(
			run(`it("mixed", () => { expect(count()).toBe(0); expect(name()).toBe("bob"); });`),
		).toEqual([]);
	});
});

describe("checkFallbackOnlyAssertion — additional shape coverage", () => {
	it("flags expect(await x) with toBeUndefined()", () => {
		expect(run(`it("awaits", async () => { expect(await run()).toBeUndefined(); });`)).toHaveLength(1);
	});

	it("flags a chained .not. on toBe(0) as NOT default (must not fire)", () => {
		expect(run(`it("checks", () => { expect(count()).not.toBe(0); });`)).toEqual([]);
	});

	it("flags toStrictEqual({})", () => {
		expect(run(`it("noop", () => { expect(build()).toStrictEqual({}); });`)).toHaveLength(1);
	});

	it("flags toBe(\"\") — empty string literal", () => {
		expect(run(`it("noop", () => { expect(name()).toBe(""); });`)).toHaveLength(1);
	});

	it("does not flag toBe(\"bob\") — non-empty string literal", () => {
		expect(run(`it("noop", () => { expect(name()).toBe("bob"); });`)).toEqual([]);
	});

	it("does not flag test() calls that use a dynamic title", () => {
		expect(run(`const n = "x"; it(n, () => { expect(getItems()).toEqual([]); });`)).toEqual([]);
	});

	it("caps findings per file", () => {
		const many = Array.from(
			{ length: 15 },
			(_, i) => `it("t${i}", () => { expect(getItems()).toEqual([]); });`,
		).join("\n");
		const found = run(many);
		expect(found.length).toBeLessThanOrEqual(10);
	});
});

describe("checkFallbackOnlyAssertion — sibling visibility (file-level)", () => {
	it("does not flag a default-only block when a sibling pins the same target to a literal", () => {
		const content = `
			it("parses a valid record", () => { expect(parse(good)).toEqual({ id: 1 }); });
			it("parses garbage", () => { expect(parse(bad)).toEqual([]); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("flags every block when the target is a fallback everywhere in the file", () => {
		const content = `
			it("parses garbage a", () => { expect(parse(bad1)).toEqual([]); });
			it("parses garbage b", () => { expect(parse(bad2)).toEqual([]); });
		`;
		expect(run(content)).toHaveLength(2);
	});

	it("still flags when the sibling pin is on a DIFFERENT target", () => {
		const content = `
			it("parses names", () => { expect(name()).toBe("bob"); });
			it("parses garbage", () => { expect(parse(bad)).toEqual([]); });
		`;
		expect(run(content)).toHaveLength(1);
	});

	it("does not let a sibling inside a skipped test count as a pin", () => {
		const content = `
			it.skip("parses a valid record", () => { expect(parse(good)).toEqual({ id: 1 }); });
			it("parses garbage", () => { expect(parse(bad)).toEqual([]); });
		`;
		expect(run(content)).toHaveLength(1);
	});

	it("treats toBe(false) as non-default for a boolean-predicate-named target (existsSync)", () => {
		expect(run(`it("checks", () => { expect(existsSync(p)).toBe(false); });`)).toEqual([]);
	});

	it("treats toBeFalsy() as non-default for an is-prefixed predicate target", () => {
		expect(run(`it("checks", () => { expect(isReady()).toBeFalsy(); });`)).toEqual([]);
	});

	it("still flags toBe(false) on a non-predicate-named target", () => {
		expect(run(`it("checks", () => { expect(computeFlag()).toBe(false); });`)).toHaveLength(1);
	});
});

describe("checkFallbackOnlyAssertion — one-hop alias resolution", () => {
	it("N: does not flag when the aliased target is pinned elsewhere via a variable", () => {
		const content = `
			it("parses a valid record", () => { const rows = parse(good); expect(rows[0].id).toBe(1); });
			it("parses garbage", () => { expect(parse(bad)).toEqual([]); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: fires when the aliased target is a fallback everywhere in the file", () => {
		const content = `
			it("parses garbage a", () => { const rows = parse(bad1); expect(rows).toEqual([]); });
			it("parses garbage b", () => { expect(parse(bad2)).toEqual([]); });
		`;
		expect(run(content)).toHaveLength(2);
	});

	it("N: a destructured alias pin exempts a fallback sibling on the same call", () => {
		const content = `
			it("builds a record", () => { const { id } = build(good); expect(id).toBe(1); });
			it("rejects garbage", () => { expect(build(bad)).toEqual({}); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("N: a file-scope alias pin exempts a fallback inside an it() block", () => {
		const content = `
			const shared = parse(fixture);
			it("checks a field", () => { expect(shared.id).toBe(1); });
			it("checks garbage", () => { expect(parse(bad)).toEqual([]); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("N: JSON.parse(captured.stdout) links a fallback to a sibling pin on the same argument", () => {
		const content = `
			it("returns the parsed record", () => {
				const captured = capture();
				const rows = JSON.parse(captured.stdout);
				expect(rows[0].id).toBe(1);
			});
			it("handles a malformed line", () => {
				const captured = capture();
				expect(JSON.parse(captured.stdout)).toEqual([]);
			});
		`;
		expect(run(content)).toEqual([]);
	});
});

describe("checkFallbackOnlyAssertion — extraction-bug fixes (2026-09-06)", () => {
	// Bug 1: `\[\]\b` / `\{\}\b` never matched (no boundary between two
	// non-word chars), and an intervening article ("an"/"a"/"the") broke the
	// verb-adjacency requirement.
	it("N: exempts a title that declares the outcome with a trailing bracket literal", () => {
		expect(run(`it("returns [] when malformed", () => { expect(getItems()).toEqual([]); });`)).toEqual([]);
	});

	it("N: exempts a title with an article between the verb and the outcome", () => {
		expect(run(`it("returns an empty set", () => { expect(getItems()).toEqual([]); });`)).toEqual([]);
	});

	// Bug 2: `expect(value, message)` — the message argument must not
	// pollute the subject used for target resolution.
	it("N: a two-arg expect(value, message) call links to a same-target sibling pin", () => {
		const content = `
			it("accepts good input", () => { expect(check(good)).toBe(1); });
			it("rejects bad input", () => { expect(check(bad), "should reject").toBeNull(); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: a two-arg expect(value, message) fallback still fires with no sibling pin", () => {
		expect(run(`it("checks", () => { expect(getItems(), "should be empty").toEqual([]); });`)).toHaveLength(1);
	});

	// Bug 3: an arrow-wrapper subject (`() => run(dir)`) must resolve like a
	// direct call so it can link to a plain-call sibling pin.
	it("N: an arrow-wrapped subject links to a plain-call sibling pin on the same target", () => {
		const content = `
			it("accepts good input", () => { expect(run(good)).toBe(1); });
			it("rejects bad input", () => { expect(() => run(bad)).not.toThrow(); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: an async-arrow-wrapped fallback still fires with no sibling pin", () => {
		expect(
			run(`it("checks", async () => { expect(async () => run()).not.toThrow(); });`),
		).toHaveLength(1);
	});

	// Bug 4: call-then-property-access (`out.get("x")?.previous_state`) must
	// coarsen to the SAME target as the alias-declared form (`out.get`).
	it("N: a direct call-then-property subject links to an aliased sibling pin on the same call", () => {
		const content = `
			it("accepts good input", () => { const entry = out.get(good); expect(entry?.value).toBe(1); });
			it("rejects bad input", () => { expect(out.get(bad)?.value).toBeUndefined(); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: a call-then-property fallback still fires with no sibling pin", () => {
		expect(run(`it("checks", () => { expect(out.get(x)?.value).toBeUndefined(); });`)).toHaveLength(1);
	});
});

describe("checkFallbackOnlyAssertion — extraction-bug fixes round 2 (2026-09-06)", () => {
	// Gap 1: Array/String/RegExp boolean-predicate methods (some, every,
	// includes, has, startsWith, endsWith, test) must be treated the same as
	// existsSync/isX/canX — a `false` result is a real negative-space
	// guarantee, not a fallback.
	it("N: does not flag toBe(false) on logs.some(...) — a real negative-space guarantee", () => {
		expect(
			run(`it("checks", () => { expect(logs.some((l) => l.includes("x"))).toBe(false); });`),
		).toEqual([]);
	});

	it("P: still flags toBe(false) on a non-predicate-shaped target", () => {
		expect(run(`it("checks", () => { expect(computeReady()).toBe(false); });`)).toHaveLength(1);
	});

	// Gap 2: a chained call (`f(x).get(y)`) must coarsen to the BASE callee
	// `f`, for both the fallback key and the sibling-pin key — the same
	// coarsening bug 4 gave call-then-PROPERTY, extended to call-then-CALL.
	it("N: a chained-call subject coarsens to the base callee for sibling matching", () => {
		const content = `
			it("accepts good input", () => { expect(lastStatuses(dir).get("a")).toBe("running"); });
			it("rejects a bad row", () => { expect(lastStatuses(dir).size).toBe(0); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: a chained-call fallback still fires with no sibling pin on the base callee", () => {
		expect(run(`it("checks", () => { expect(lastStatuses(dir).size).toBe(0); });`)).toHaveLength(1);
	});

	// Gap 3: bracket/index-access alias declarations (`const entry = OBJ[key]`)
	// must register as an alias of the base object, like a call-based alias.
	it("N: a bracket-index alias links to a sibling pinned via the same base object", () => {
		const content = `
			it("accepts a known key", () => { const entry = ENTRIES[good]; expect(entry).toBe(1); });
			it("rejects an unknown key", () => { const entry = ENTRIES[bad]; expect(entry).toBeUndefined(); });
		`;
		expect(run(content)).toEqual([]);
	});

	it("P: a bracket-index alias fallback still fires with no sibling pin", () => {
		expect(
			run(`it("checks", () => { const row = ROWS[0]; expect(row).toBeUndefined(); });`),
		).toHaveLength(1);
	});
});

describe("checkFallbackOnlyAssertion — 'in' operator boolean predicate (2026-09-06)", () => {
	// `expect("key" in obj).toBe(false)` proves the key is genuinely absent —
	// a real negative-space guarantee, the same class as existsSync/isX
	// predicates, not a fallback/no-op outcome.
	it("N1: does not flag toBe(false) on a string-literal `in` check", () => {
		expect(run(`it("checks", () => { expect("missing" in obj).toBe(false); });`)).toEqual([]);
	});

	it("N2: does not flag toBe(false) on a variable-key `in` check", () => {
		expect(run(`it("checks", () => { expect(key in obj).toBe(false); });`)).toEqual([]);
	});

});

describe("checkFallbackOnlyAssertion — 'has*' boolean predicate (2026-09-06)", () => {
	// `hasOutputRedirect(...)`/`hasFollowFlag(...)` are real "this input lacks
	// X" guarantees, same class as `isX`/`canX` — found via a fresh precision
	// sample (file-dump-guard-parse.mutation-kill.test.ts).
	it("N1: does not flag toBe(false) on a hasXxx-named target", () => {
		expect(run(`it("checks", () => { expect(hasOutputRedirect(cmd)).toBe(false); });`)).toEqual([]);
	});

});

describe("checkFallbackOnlyAssertion — resilience-title widening (2026-09-06)", () => {
	// A title that names the test's own resilience contract ("swallows write
	// errors instead of throwing", "resolves (stateless, nothing to clean
	// up)") is a DELIBERATE no-op, same as the existing TITLE_DECLARES_DEFAULT
	// exemption — but only when every assertion is itself a not.toThrow()/
	// resolves shape (a resilience claim backed by an unrelated toBe(0) is
	// NOT covered by this exemption).
	it("N1: exempts a not.toThrow() block whose title says it swallows errors", () => {
		expect(
			run(`it("swallows write errors instead of throwing", () => { expect(() => run()).not.toThrow(); });`),
		).toEqual([]);
	});

	it("N2: exempts a resolves-chain block whose title names a stateless no-op", () => {
		expect(
			run(`it("shutdown() resolves (stateless, nothing to clean up)", async () => { await expect(shutdown()).resolves.toBeUndefined(); });`),
		).toEqual([]);
	});

	it("N3: exempts a title using 'idempotent' over a not.toThrow() block", () => {
		expect(run(`it("retry is idempotent", () => { expect(() => retry()).not.toThrow(); });`)).toEqual([]);
	});

	it("P1: does NOT exempt a resilience-worded title when the assertion isn't toThrow/resolves-shaped", () => {
		expect(run(`it("swallows the error and returns 0", () => { expect(compute()).toBe(0); });`)).toHaveLength(
			1,
		);
	});

	it("P2: an ordinary title with a not.toThrow() block still flags with no resilience wording", () => {
		expect(run(`it("does something", () => { expect(() => run()).not.toThrow(); });`)).toHaveLength(1);
	});
});

describe("checkFallbackOnlyAssertion — cross-file sibling visibility (2026-09-06)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fallback-crossfile-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not flag a default-only block when a SIBLING TEST FILE pins the same target", () => {
		const mainPath = join(dir, "foo.mutation-kill-w1.test.ts");
		writeFileSync(
			join(dir, "foo.test.ts"),
			`it("parses a valid record", () => { expect(parse(good)).toEqual({ id: 1 }); });`,
			"utf-8",
		);
		const content = `it("parses garbage", () => { expect(parse(bad)).toEqual([]); });`;
		writeFileSync(mainPath, content, "utf-8");
		expect(checkFallbackOnlyAssertion(content, mainPath)).toEqual([]);
	});

	it("still flags when NO sibling file pins the target", () => {
		const mainPath = join(dir, "foo.mutation-kill-w1.test.ts");
		writeFileSync(join(dir, "foo.test.ts"), `it("unrelated", () => { expect(name()).toBe("bob"); });`, "utf-8");
		const content = `it("parses garbage", () => { expect(parse(bad)).toEqual([]); });`;
		writeFileSync(mainPath, content, "utf-8");
		expect(checkFallbackOnlyAssertion(content, mainPath)).toHaveLength(1);
	});

	it("finds a pin in a __tests__/ companion file", () => {
		const mainPath = join(dir, "foo.test.ts");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(
			join(dir, "__tests__", "foo.integration.test.ts"),
			`it("real case", () => { expect(parse(good)).toEqual({ id: 1 }); });`,
			"utf-8",
		);
		const content = `it("garbage", () => { expect(parse(bad)).toEqual([]); });`;
		writeFileSync(mainPath, content, "utf-8");
		expect(checkFallbackOnlyAssertion(content, mainPath)).toEqual([]);
	});
});
