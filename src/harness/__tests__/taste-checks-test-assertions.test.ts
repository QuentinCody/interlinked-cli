// Direct-import tests for the test-assertion taste family. Co-located with a
// DIRECT import of the implementation (not the taste-checks.js barrel) so the
// per-edit coverage selector attributes coverage to this file without having
// to follow a re-export hop.
import { describe, expect, it } from "vitest";
import { checkAssertionFreeTest, checkMockingTheSUT } from "../taste-checks-test-assertions.js";
import { withForegroundCheckScan } from "../checks/check-scan-policy.js";

const TEST = "/x/widget.test.ts";

describe("checkMockingTheSUT foreground result collection", () => {
	it("P1 retains twenty mock replacements and their tail while ordinary edits keep five", () => {
		const content = Array.from({ length: 20 }, () => 'vi.mock("./widget.js");').join("\n");
		const scan = () => checkMockingTheSUT(content, TEST);
		expect(scan()).toHaveLength(5);
		expect(withForegroundCheckScan(scan).map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		expect(scan()).toHaveLength(5);
	});

	it("N1 retains spies, actual-module forwarding and unrelated-module exceptions", () => {
		const content = Array.from({ length: 20 }, () => 'vi.mock("./widget.js", { spy: true });\njest.mock("./widget.js", () => jest.requireActual("./widget.js"));\nvi.mock("../other/widget.js");').join("\n");
		expect(withForegroundCheckScan(() => checkMockingTheSUT(content, TEST))).toEqual([]);
	});
});

it("does not infer assertion absence from a parameterized callback supplied by reference", () => {
	const content = 'it.each(cases)("validates %s", verifyCase);\nit("ordinary case", () => { compute(); });';
	expect(checkAssertionFreeTest(content, TEST)).toEqual([
		expect.objectContaining({ line: 2 }),
	]);
});

it("attributes an empty inline callback to its own registration after named callbacks", () => {
	const content = [
		'import { verifyCase } from "./cases.js";',
		'it("uses the imported case", verifyCase);',
		'it("uses explicit options", { timeout: 300 }, verifyCase);',
		'it(',
		'  "formatted named callback",',
		'  verifyCase,',
		');',
		'it("performs work without an assertion", () => { compute(); });',
		'it("checks the value", () => { expect(compute()).toBe(4); });',
	].join("\n");
	expect(checkAssertionFreeTest(content, TEST).map(hit => hit.line)).toEqual([8]);
});

describe("checkAssertionFreeTest — smoke-test name exemption", () => {
	// ---- exempt: cases EXPLICITLY named for a not-throwing / smoke check ----
	it("exempts a case named 'renders without crashing'", () => {
		const content = `it("renders without crashing", () => { render(makeApp()); });`;
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("exempts 'does not throw on empty input'", () => {
		const content = `it("does not throw on empty input", () => { parse(""); });`;
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("exempts a 'smoke test' case", () => {
		const content = `it("smoke test: boots", () => { boot(); });`;
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	// ---- still flagged: the exemption is narrow ----
	it("still flags a bare 'renders the count' with no assertion", () => {
		const content = `it("renders the count", () => { render(makeApp()); });`;
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});

	it("still flags an ordinary assertion-free case", () => {
		const content = `it("computes a value", () => { const x = compute(); });`;
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});

	it("does not suppress a real assertion that happens to be smoke-named", () => {
		const content = `it("renders without crashing", () => { expect(render(makeApp())).toBeTruthy(); });`;
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
});

describe("checkAssertionFreeTest — names spanning lines (formatted test headers)", () => {
	// Prettier-style formatting puts the name on the line AFTER `it(`; the
	// exemption must still see it (finding 2026-06: reading only the start line
	// returned "" and the smoke test was flagged anyway).
	it("exempts a smoke name on the line after `it(`", () => {
		const content = ["it(", '\t"renders without crashing",', "\t() => {", "\t\trender(makeApp());", "\t},", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("exempts a multi-line `it.each`-style modifier chain with a next-line smoke name", () => {
		const content = ["it.skip(", '\t"does not throw on empty input",', "\t() => {", '\t\tparse("");', "\t},", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	it("exempts a name two lines below the opener", () => {
		const content = ["it(", "", '\t"smoke test: boots",', "\t() => {", "\t\tboot();", "\t},", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	// ---- still flagged: the multi-line window must not over-exempt ----
	it("still flags a formatted assertion-free test whose name is NOT smoke-like", () => {
		const content = ["it(", '\t"renders the count",', "\t() => {", "\t\trender(makeApp());", "\t},", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});

	it("does not mistake a body string for the name (quote anchored to the call paren)", () => {
		// First arg is a variable, so there IS no name; the body's smoke-like
		// string must not be picked up as one.
		const content = ["it(caseName, () => {", '\tconst label = "without crashing";', "\tuse(label);", "});"].join("\n");
		expect(checkAssertionFreeTest(content, TEST).length).toBe(1);
	});

	it("a formatted test WITH an assertion is never flagged regardless of name position", () => {
		const content = ["it(", '\t"renders the count",', "\t() => {", "\t\texpect(render(makeApp())).toBeTruthy();", "\t},", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
});
