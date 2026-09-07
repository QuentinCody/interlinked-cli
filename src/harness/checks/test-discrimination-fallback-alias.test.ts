import { describe, expect, it } from "vitest";
import {
	collectAliases,
	plainSubjectTarget,
	resolveSubjectTarget,
} from "./test-discrimination-fallback-alias.js";
import { extractTestBlocks } from "./test-structure.js";
import { stripAllLiterals } from "../strip-helpers.js";

function masked(src: string): { masked: string; blocks: ReturnType<typeof extractTestBlocks> } {
	const m = stripAllLiterals(src);
	return { masked: m, blocks: extractTestBlocks(m.split("\n")) };
}

describe("plainSubjectTarget — positive (must resolve)", () => {
	it("resolves a plain call subject to its callee", () => {
		expect(plainSubjectTarget("parse(x)")).toBe("parse");
	});

	it("resolves an awaited call subject to its callee", () => {
		expect(plainSubjectTarget("await run()")).toBe("run");
	});

	it("resolves a property-path subject to itself (no trailing call)", () => {
		expect(plainSubjectTarget("result.moves")).toBe("result.moves");
	});

	it("unwraps JSON.parse(x) to x's own target when x is not a call", () => {
		expect(plainSubjectTarget("JSON.parse(captured.stdout)")).toBe("captured.stdout");
	});

	it("unwraps JSON.parse(f(x)) to f's target", () => {
		expect(plainSubjectTarget("JSON.parse(f(x))")).toBe("f");
	});
});

describe("plainSubjectTarget — negative (must not unwrap)", () => {
	it("leaves an ordinary call target alone", () => {
		expect(plainSubjectTarget("existsSync(p)")).toBe("existsSync");
	});

	it("does not unwrap a call with no arguments", () => {
		expect(plainSubjectTarget("JSON.parse()")).toBe("JSON.parse");
	});
});

describe("collectAliases + resolveSubjectTarget", () => {
	it("resolves a simple const binding's property access to the call target", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const rows = parse(input); expect(rows[0].id).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("rows[0].id", 0, maps)).toBe("parse");
	});

	it("resolves a destructured binding to the shared call target", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const { a, b } = build(input); expect(a).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("a", 0, maps)).toBe("build");
		expect(resolveSubjectTarget("b", 0, maps)).toBe("build");
	});

	it("resolves a renamed destructured binding by its LOCAL name", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const { total: sum } = build(input); expect(sum).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("sum", 0, maps)).toBe("build");
	});

	it("makes a file-scope (outside any it()) binding visible to every block", () => {
		const { masked: m, blocks } = masked(
			`const shared = parse(fixture);\nit("x", () => { expect(shared.id).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("shared.id", 0, maps)).toBe("parse");
	});

	it("prefers a block-local alias over a same-named file-scope one", () => {
		const { masked: m, blocks } = masked(
			`const rows = outer(fixture);\nit("x", () => { const rows = inner(input); expect(rows[0]).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("rows[0]", 0, maps)).toBe("inner");
	});

	it("falls back to the plain target when the head identifier is not aliased", () => {
		const { masked: m, blocks } = masked(`it("x", () => { expect(count()).toBe(1); });`);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("count()", 0, maps)).toBe("count");
	});
});

describe("plainSubjectTarget — non-null assertion after a call (2026-09-06)", () => {
	// A `!` non-null assertion right after a call's closing paren broke
	// callThenPropertyTarget's tail regex (it required `.`/`?.`/`[` right
	// after the call), so `parseDeadCodeJson(x)!.total` fell through to the
	// whole-string literal instead of resolving to `parseDeadCodeJson` —
	// found via a real false-positive (supermodel-analyses.test.ts).
	it("P: resolves a call-then-bang-then-property subject to the call target", () => {
		expect(plainSubjectTarget("parseDeadCodeJson(x)!.totalDeclarations")).toBe("parseDeadCodeJson");
	});

	it("N: a plain call-then-property subject (no bang) still resolves the same way", () => {
		expect(plainSubjectTarget("parseDeadCodeJson(x).totalDeclarations")).toBe("parseDeadCodeJson");
	});
});

describe("plainSubjectTarget — nullish-default and array-spread normalization (2026-09-06)", () => {
	// `EXPR ?? <default>` and `[...(EXPR)]` wrappers around an otherwise
	// plain call-then-property subject must resolve to the SAME target as a
	// bare `EXPR`, so a real-value pin and its `?? fallback`/spread-shaped
	// sibling link up. Found via harness-lifecycle-helpers.test.ts /
	// harness-daemon-control.test.ts false positives.
	it("P: strips a top-level `?? <default>` before resolving the call target", () => {
		expect(plainSubjectTarget("firstSweep(seen).dryRun ?? false")).toBe("firstSweep");
	});

	it("N: a bare call-then-property subject (no `??`) resolves the same way", () => {
		expect(plainSubjectTarget("firstSweep(seen).dryRun")).toBe("firstSweep");
	});

	it("P: unwraps an array-spread-of-optional-chain wrapper to the inner call target", () => {
		expect(plainSubjectTarget("[...(firstSweep(seen).protectPids ?? [])]")).toBe("firstSweep");
	});

	it("N: does not strip a `??` that sits inside a nested paren/bracket (not top-level)", () => {
		// The nullish default itself is inside the call's own arguments, so
		// nothing should be cut — the call target is still `build`.
		expect(plainSubjectTarget("build(x ?? y).total")).toBe("build");
	});
});

describe("collectAliases — dynamic import()/require() destructuring is not an alias (2026-09-06)", () => {
	// `const { runGoBuild } = await import("./go.js")` is a MODULE BINDING,
	// not a computed value — the destructured name IS the SUT function
	// itself. Recording it as an alias to "import" made every later
	// `runGoBuild(...)` call resolve to the bogus target "import" instead of
	// "runGoBuild", which silently broke sibling-pin matching across the
	// whole file (found via go.integration.test.ts, write.test.ts, and
	// others — every file using this common dynamic-import-after-vi.mock
	// pattern).
	it("N: a name destructured from await import(...) resolves to ITSELF at a call site, not \"import\"", () => {
		const { masked: m, blocks } = masked(
			`const { runGoBuild } = await import("./go.js");\nit("x", () => { expect(runGoBuild(a)).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("runGoBuild(a)", 0, maps)).toBe("runGoBuild");
	});

	it("N: a name destructured from require(...) resolves to ITSELF, not \"require\"", () => {
		const { masked: m, blocks } = masked(
			`const { runGoBuild } = require("./go.js");\nit("x", () => { expect(runGoBuild(a)).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("runGoBuild(a)", 0, maps)).toBe("runGoBuild");
	});

	it("P: an ordinary destructured SUT call binding still aliases to its call target", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const { a } = build(input); expect(a).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("a", 0, maps)).toBe("build");
	});
});

describe("collectAliases — chained alias-of-an-alias binding (2026-09-06)", () => {
	// `const out = readTddCycles(x); const entry = out.get(k);` must alias
	// `entry` to "readTddCycles" (chasing through `out`'s own alias), not the
	// literal "out.get" — otherwise `entry?.field` never links to a sibling
	// pin on a direct `out.get(k)` occurrence, which resolves to
	// "readTddCycles" via the SAME head-identifier alias check. Found via
	// session-snapshot-codec.test.ts.
	it("N: a two-hop chained binding resolves to the ROOT alias's call target", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const out = readTddCycles(input); const entry = out.get(k); expect(entry?.field).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("entry?.field", 0, maps)).toBe("readTddCycles");
	});

	it("P: a chained-alias fallback still fires with no sibling pin on the chased target", () => {
		const { masked: m, blocks } = masked(
			`it("x", () => { const out = readTddCycles(input); const entry = out.get(k); expect(entry?.field).toBeUndefined(); });`,
		);
		const maps = collectAliases(m, blocks);
		// Same target as the N case above — this only proves the CHASE landed
		// on "readTddCycles", not on the unrelated literal "out.get".
		expect(resolveSubjectTarget("entry?.field", 0, maps)).toBe("readTddCycles");
	});
});
