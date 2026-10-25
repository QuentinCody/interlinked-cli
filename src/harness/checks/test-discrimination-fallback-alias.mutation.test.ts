import { describe, expect, it } from "vitest";
import {
	collectAliases,
	plainSubjectTarget,
	resolveSubjectTarget,
} from "./test-discrimination-fallback-alias.js";
import { extractTestBlocks } from "./test-structure.js";
import { stripAllLiterals } from "../strip-helpers.js";

function prep(src: string): { masked: string; blocks: ReturnType<typeof extractTestBlocks> } {
	const m = stripAllLiterals(src);
	return { masked: m, blocks: extractTestBlocks(m.split("\n")) };
}

/** Index of the Nth (0-based) `kind: "test"` block. */
function testIdx(blocks: ReturnType<typeof extractTestBlocks>, nth = 0): number {
	let seen = 0;
	for (let i = 0; i < blocks.length; i++) {
		if (blocks[i]?.kind === "test") {
			if (seen === nth) return i;
			seen++;
		}
	}
	return -1;
}

// Basis for the wrapper rules: module header lines 18-24 (JSON.parse / String /
// Number wrappers fold to what they wrap).
describe("plainSubjectTarget — String/Number wrappers fold to their argument (mutation hardening)", () => {
	it("String(x) keys on x, not on the wrapper name", () => {
		expect(plainSubjectTarget("String(captured.out)")).toBe("captured.out");
	});

	it("Number(x) keys on x, not on the wrapper name", () => {
		expect(plainSubjectTarget("Number(captured.out)")).toBe("captured.out");
	});

	it("a wrapper followed by a property access still folds to the wrapped argument", () => {
		expect(plainSubjectTarget("JSON.parse(captured.stdout).total")).toBe("captured.stdout");
	});

	it("a wrapper-then-property subject whose argument is a call folds to that call's target", () => {
		expect(plainSubjectTarget("JSON.parse(f(x)).total")).toBe("f");
	});
});

// Basis: ARROW_PREFIX_RE doc comment, lines 47-54 ("`expect(() => run(dir))` keys on `run`").
describe("plainSubjectTarget — arrow-function wrappers are stripped (mutation hardening)", () => {
	it("a zero-parameter arrow keys on the callee inside it", () => {
		expect(plainSubjectTarget("() => run(dir)")).toBe("run");
	});

	it("an async arrow keys on the callee inside it", () => {
		expect(plainSubjectTarget("async () => run(dir)")).toBe("run");
	});

	it("a bare-parameter arrow keys on the callee inside it", () => {
		expect(plainSubjectTarget("x => run(x)")).toBe("run");
	});

	it("an arrow with no space after `=>` keys on the callee inside it", () => {
		expect(plainSubjectTarget("()=>run(dir)")).toBe("run");
	});

	it("an arrow with several parameters keys on the callee inside it", () => {
		expect(plainSubjectTarget("(a, b) => run(a, b)")).toBe("run");
	});
});

// Basis: callThenPropertyTarget doc comment, lines 64-71 ("member access only").
describe("plainSubjectTarget — call followed by member access (mutation hardening)", () => {
	it("a call followed by an index access keys on the callee", () => {
		expect(plainSubjectTarget("parse(x)[0]")).toBe("parse");
	});

	it("a call followed by an optional-chain access keys on the callee", () => {
		expect(plainSubjectTarget("parse(x)?.rows")).toBe("parse");
	});
});

// Basis: baseCalleeOf doc comment, lines 104-109 (chain reduces to its base callee).
describe("plainSubjectTarget — chained calls reduce to the base callee (mutation hardening)", () => {
	it("f(x).get(y) keys on f", () => {
		expect(plainSubjectTarget("f(x).get(y)")).toBe("f");
	});

	it("a chained callee that does not start with an identifier never yields an empty sibling key", () => {
		// An empty key would link unrelated subjects (module header lines 18-24:
		// keys must stay specific to what is being called).
		expect(plainSubjectTarget("(a)(b)")).not.toBe("");
	});
});

// Basis: stripTrailingNullishDefault doc comment, lines 130-136 (depth tracked over
// `()[]{}`; only a `??` outside every bracket is cut) and ParsedCall.target doc, lines 39-41.
describe("plainSubjectTarget — top-level nullish default cutting (mutation hardening)", () => {
	it("does not cut a `??` inside square brackets", () => {
		expect(plainSubjectTarget("x[a ?? b].c")).toBe("x[a??b].c");
	});

	it("does not cut a `??` inside curly braces", () => {
		expect(plainSubjectTarget("{a: b ?? c}")).toBe("{a:b??c}");
	});

	it("cuts a top-level `??` that follows a closed square bracket", () => {
		expect(plainSubjectTarget("x[a].c ?? d")).toBe("x[a].c");
	});

	it("does not treat a single optional-chain `?` as a nullish default", () => {
		expect(plainSubjectTarget("result?.moves")).toBe("result?.moves");
	});
});

// Basis: AliasMaps doc, lines 192-193 and module header lines 11-14 ("at file/describe scope").
describe("collectAliases — binding scope (mutation hardening)", () => {
	it("a binding at describe scope (outside every it) is visible to a test inside the describe", () => {
		const { masked: m, blocks } = prep(
			[
				`describe("d", () => {`,
				`  const shared = parse(fixture);`,
				`  it("x", () => { expect(shared.id).toBe(1); });`,
				`});`,
			].join("\n"),
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("shared.id", testIdx(blocks), maps)).toBe("parse");
	});

	it("a binding made inside a test stays private to that test", () => {
		const { masked: m, blocks } = prep(
			[
				`it("a", () => { const rows = parse(input); expect(rows[0]).toBe(1); });`,
				`it("b", () => { expect(rows[0]).toBe(1); });`,
			].join("\n"),
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("rows[0]", testIdx(blocks, 0), maps)).toBe("parse");
		expect(resolveSubjectTarget("rows[0]", testIdx(blocks, 1), maps)).toBe("rows[0]");
	});

	it("a binding inside a suite nested in a test belongs to the enclosing test, not to file scope", () => {
		// Basis: enclosingTestBlockIndex doc, lines 199-201 (walks up through
		// suite ancestors to the nearest enclosing test).
		const { masked: m, blocks } = prep(
			[
				`it("a", () => {`,
				`  describe("inner", () => {`,
				`    const rows = parse(input);`,
				`  });`,
				`});`,
				`it("b", () => { expect(rows[0]).toBe(1); });`,
			].join("\n"),
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("rows[0]", testIdx(blocks, 1), maps)).toBe("rows[0]");
	});
});

// Basis: destructuredNames doc, lines 290-291 ("renames use the LOCAL name; default values are stripped").
describe("collectAliases — destructuring forms (mutation hardening)", () => {
	it("a destructured name with a default value still aliases to the call target", () => {
		const { masked: m, blocks } = prep(
			`it("x", () => { const { a = 1, b } = build(input); expect(a).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("a", 0, maps)).toBe("build");
		expect(resolveSubjectTarget("b", 0, maps)).toBe("build");
	});
});

// Basis: INDEX_DECL_RE comment, lines 336-340 ("the alias target is the base path AS-IS").
describe("collectAliases — index bindings keep the whole base path (mutation hardening)", () => {
	it("an index binding off a dotted base aliases to the full dotted base", () => {
		const { masked: m, blocks } = prep(
			`it("x", () => { const entry = out.rows[0]; expect(entry.id).toBe(1); });`,
		);
		const maps = collectAliases(m, blocks);
		expect(resolveSubjectTarget("entry.id", 0, maps)).toBe("out.rows");
	});
});
