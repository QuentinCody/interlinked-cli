// Independent adversarial review of `placeholder_test` (pre_block).
// Every N-case is idiomatic test code the detector once charged with an
// "Empty test body" because it took the FIRST `{` after the intro line as
// the callback body. Probe: scratch/2026-10-21-adversarial/placeholder_test.probe.mts
import { describe, expect, it } from "vitest";
import { checkPlaceholderTests } from "../../checks/placeholder-tests.js";

describe("placeholder_test — negative (must not fire)", () => {
	it("N1: expression-bodied arrow followed by a sibling that passes {}", () => {
		const code = [
			'it("returns one", () => expect(one()).toBe(1));',
			'it("returns empty object", () => expect(empty()).toEqual({}));',
		].join("\n");
		expect(checkPlaceholderTests(code, "math.test.ts")).toEqual([]);
	});

	it("N2: expression-bodied arrow whose only braces are an empty-object argument", () => {
		const code = 'it("accepts empty config", () => expectValid({}));';
		expect(checkPlaceholderTests(code, "config.test.ts")).toEqual([]);
	});

	it("N3: callback passed by reference, followed by an unrelated empty object literal", () => {
		const code = ['it("runs the shared cases", sharedCases);', "const defaults = {};"].join("\n");
		expect(checkPlaceholderTests(code, "shared.test.ts")).toEqual([]);
	});

	it("N4: expression body that returns a matcher chain containing {}", () => {
		const code = 'it("resolves", () => expect(load()).resolves.toEqual({}));';
		expect(checkPlaceholderTests(code, "async.test.ts")).toEqual([]);
	});

	it("N5: describe body passed by reference, followed by an empty object literal", () => {
		const code = ['describe("shared", sharedSuite);', "const emptyOpts = {};"].join("\n");
		expect(checkPlaceholderTests(code, "suite.test.ts")).toEqual([]);
	});

	it("N6: vitest options object before a real callback body", () => {
		const code =
			'it("cold tsc start", { timeout: 60_000 }, async () => {\n  expect(await run()).toBe(0);\n});';
		expect(checkPlaceholderTests(code, "slow.test.ts")).toEqual([]);
	});

	it("N7: destructured vitest context parameter before a real body", () => {
		const code = 'it("uses context", async ({ expect }) => {\n  expect(1).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "ctx.test.ts")).toEqual([]);
	});

	it("N8: Allman-style brace on the line after the arrow", () => {
		const code = 'it("wraps", () =>\n{\n  expect(1).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "wrap.test.ts")).toEqual([]);
	});

	it("N9: function expression with a destructured parameter and a real body", () => {
		const code = 'it("ctx", function ({ expect }) {\n  expect(1).toBe(1);\n});';
		expect(checkPlaceholderTests(code, "fn.test.ts")).toEqual([]);
	});

	it("N10: a noop arrow passed to a callback wrapper is not the test body", () => {
		const code = [
			'it("restores console", withConsole(() => {}, (spy) => {',
			"  expect(spy).not.toHaveBeenCalled();",
			"}));",
		].join("\n");
		expect(checkPlaceholderTests(code, "wrap.test.ts")).toEqual([]);
	});

	it("N11: a noop default parameter value is not the test body", () => {
		const code = ['it("calls back", (done = () => {}) => {', "  run(done);", "});"].join("\n");
		expect(checkPlaceholderTests(code, "def.test.ts")).toEqual([]);
	});

	it("N12: a noop arrow inside the options object is not the test body", () => {
		const code = [
			'test("retries", { retry: 2, onRetry: () => {} }, async () => {',
			"  expect(await flaky()).toBe(1);",
			"});",
		].join("\n");
		expect(checkPlaceholderTests(code, "opts.test.ts")).toEqual([]);
	});

	it("N13: a deliberately empty test under a __fixtures__ tree is fixture data", () => {
		const code = 'it("empty on purpose", () => {});';
		expect(
			checkPlaceholderTests(code, "src/checks/__fixtures__/placeholder/empty.test.ts"),
		).toEqual([]);
	});
});

describe("placeholder_test — positive (must fire)", () => {
	it("P1: empty arrow body still fires", () => {
		const code = 'it("empty", () => {});';
		const matches = checkPlaceholderTests(code, "p.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("P2: empty body behind a destructured context parameter now fires", () => {
		const code = 'it("empty", async ({ expect }) => {});';
		const matches = checkPlaceholderTests(code, "p2.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("P3: empty body behind a vitest options object now fires", () => {
		const code = 'it("empty", { timeout: 1000 }, () => {});';
		const matches = checkPlaceholderTests(code, "p3.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("P4: empty function-expression body with the brace on the next line fires", () => {
		const code = 'it("empty", function ()\n{\n});';
		const matches = checkPlaceholderTests(code, "p4.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("P5: TODO-only body behind a destructured parameter fires with the marker reason", () => {
		const code = 'it("later", async ({ expect }) => {\n  // TODO: write this\n});';
		const matches = checkPlaceholderTests(code, "p5.test.ts");
		expect(matches.some((m) => m.text.startsWith("Test body contains only TODO/FIXME"))).toBe(
			true,
		);
	});

	it("P6: an empty body after an options object that holds an arrow still fires", () => {
		const code = 'test("empty", { onRetry: () => {} }, () => {});';
		const matches = checkPlaceholderTests(code, "p6.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});

	it("P7: an empty body whose parameter has a noop default still fires", () => {
		const code = 'it("empty", (done = () => {}) => {});';
		const matches = checkPlaceholderTests(code, "p7.test.ts");
		expect(matches.some((m) => m.text.startsWith("Empty test body"))).toBe(true);
	});
});
