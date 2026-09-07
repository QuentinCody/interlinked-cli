import { describe, expect, it } from "vitest";
import { checkDuplicateTestBody } from "./test-duplicate-body.js";

function run(content: string, path = "widget.test.ts"): ReturnType<typeof checkDuplicateTestBody> {
	return checkDuplicateTestBody(content, path);
}

describe("checkDuplicateTestBody — positive (must fire)", () => {
	it("P1: two it() blocks, different titles, identical bodies (the canonical case)", () => {
		const found = run(
			`it("accepts multiple spaces between import and a default binding", () => {
				const r = parse("import   foo from 'x'");
				expect(r.ok).toBe(true);
				expect(r.name).toBe("foo");
			});
			it("accepts multiple spaces between a default binding and from", () => {
				const r = parse("import   foo from 'x'");
				expect(r.ok).toBe(true);
				expect(r.name).toBe("foo");
			});`,
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("duplicate_test_body");
		expect(found[0]?.text).toContain(
			'"accepts multiple spaces between import and a default binding"',
		);
	});

	it("P2: identical bare delegation to a helper with the SAME arguments", () => {
		const found = run(
			`it("handles the widget case", () => { runCase(fixtures.widget); expect(result).toBe(true); });
			it("handles it correctly", () => { runCase(fixtures.widget); expect(result).toBe(true); });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P3: reports the finding on the SECOND block's line, naming the first title + line", () => {
		const content = `it("first title", () => {
				expect(compute(1)).toBe(2);
				expect(compute(2)).toBe(3);
			});

			it("second title", () => {
				expect(compute(1)).toBe(2);
				expect(compute(2)).toBe(3);
			});`;
		const found = run(content);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(6);
		expect(found[0]?.text).toContain("line 1");
	});

	it("P4: pure redundancy — three blocks, two duplicate of the first, one distinct — reports two findings", () => {
		const content = `it("a", () => { expect(f(1)).toBe(2); expect(f(3)).toBe(4); });
			it("b", () => { expect(f(1)).toBe(2); expect(f(3)).toBe(4); });
			it("c", () => { expect(f(1)).toBe(2); expect(f(3)).toBe(4); });
			it("d", () => { expect(f(9)).toBe(10); expect(f(11)).toBe(12); });`;
		const found = run(content);
		expect(found).toHaveLength(2);
	});
});

describe("checkDuplicateTestBody — negative (must not fire)", () => {
	it("N1: bodies differ in a single literal — parametrized siblings, not duplicates", () => {
		const found = run(
			`it("adds one", () => { expect(add(1, 1)).toBe(2); });
			it("adds two", () => { expect(add(1, 2)).toBe(3); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N2: bodies differ by identifier only", () => {
		const found = run(
			`it("uses fixture a", () => { expect(f(fixtureA)).toBe(true); });
			it("uses fixture b", () => { expect(f(fixtureB)).toBe(true); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N3: identical bare delegation but DIFFERENT arguments — not a duplicate", () => {
		const found = run(
			`it("handles widget", () => { runCase(fixtures.widget); expect(result).toBe(true); });
			it("handles gadget", () => { runCase(fixtures.gadget); expect(result).toBe(true); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N4: it.each rows — the table carries the difference", () => {
		const found = run(
			`it.each([1, 2, 3])("handles %i", (n) => { expect(f(n)).toBe(n * 2); });
			it.each([4, 5, 6])("handles %i too", (n) => { expect(f(n)).toBe(n * 2); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N5: test.each is also exempt", () => {
		const found = run(
			`test.each([1])("case a", (n) => { expect(f(n)).toBe(n); });
			test.each([2])("case b", (n) => { expect(f(n)).toBe(n); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N6: identical bodies, but under describes with DIFFERENT beforeEach setups", () => {
		const found = run(
			`describe("suite A", () => {
				beforeEach(() => { setup(1); });
				it("checks value", () => { expect(getValue()).toBe(1); });
			});
			describe("suite B", () => {
				beforeEach(() => { setup(2); });
				it("checks the other value", () => { expect(getValue()).toBe(1); });
			});`,
		);
		expect(found).toHaveLength(0);
	});

	it("N7: identical bodies, SAME beforeEach text in both enclosing describes — legitimately fires", () => {
		const found = run(
			`describe("suite A", () => {
				beforeEach(() => { setup(1); });
				it("checks value", () => { expect(getValue()).toBe(1); });
			});
			describe("suite B", () => {
				beforeEach(() => { setup(1); });
				it("checks the same value again", () => { expect(getValue()).toBe(1); });
			});`,
		);
		expect(found).toHaveLength(1);
	});

	it("N8: body shorter than 30 normalized characters — too small to be meaningful", () => {
		const found = run(
			`it("a", () => { expect(1); });
			it("b", () => { expect(1); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N9: it.skip / it.todo blocks are exempt", () => {
		const found = run(
			`it.skip("skipped case", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });
			it.todo("todo case");
			it("real case", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N10: no expect() in the body — not an assertion-bearing duplicate", () => {
		const found = run(
			`it("logs a", () => { console.log("hello world this is long enough"); });
			it("logs b", () => { console.log("hello world this is long enough"); });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N13: bodies differ only by WHERE a double space sits inside a string literal argument", () => {
		const found = run(
			`it("accepts multiple spaces between import and a default binding name", () => {
				const bindings = [];
				extractBindings("import  Foo from './x'", bindings);
				expect(bindings).toEqual(["Foo"]);
			});
			it("accepts multiple spaces between a default binding name and from", () => {
				const bindings = [];
				extractBindings("import Foo  from './x'", bindings);
				expect(bindings).toEqual(["Foo"]);
			});`,
		);
		expect(found).toHaveLength(0);
	});

	it("N14: identical bodies under describes whose preamble differs by a plain const fixture (no beforeEach)", () => {
		const found = run(
			`describe("per sink class", () => {
				const registry = makeRegistry({ identity: { patterns: [{ name: "parse", kind: "call", pattern: "\\\\.parse\\\\(" }] } });
				it("flags Schema.parse(input) as sanitized for identity", () => {
					expect(isSanitized(registry, "identity", "Cmd.parse(req.body.cmd)")).toBe(true);
				});
			});
			describe("identity defaults — parity with prior tainted-sink VALIDATOR_PATTERNS", () => {
				const registry = makeRegistry({ identity: { patterns: [{ name: "parse", kind: "call", pattern: "\\\\.parse\\\\(" }, { name: "instanceof", kind: "regex", pattern: "\\\\binstanceof\\\\b" }] } });
				it("matches Cmd.parse(req.body.cmd) — zod / valibot / arktype", () => {
					expect(isSanitized(registry, "identity", "Cmd.parse(req.body.cmd)")).toBe(true);
				});
			});`,
		);
		expect(found).toHaveLength(0);
	});

	it("N11: not a test file — never fires regardless of content", () => {
		const found = run(
			`it("a", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });
			it("b", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });`,
			"src/widget.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N12: same title, identical body — that is duplicate_test_names' job, not this check's", () => {
		const found = run(
			`it("same title", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });
			it("same title", () => { expect(compute(1)).toBe(2); expect(compute(2)).toBe(3); });`,
		);
		expect(found).toHaveLength(0);
	});
});
