// Companion for checkDuplicateThrowMessageAssertion — see the sibling
// implementation file for the detector contract and shape rationale.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDuplicateThrowMessageAssertion } from "./test-discrimination-throw.js";

let tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

/**
 * Write a SUT file + a companion test file into a fresh tmp dir and run the
 * detector against the test file. `sutName` defaults to `sut` so the test
 * path is `<dir>/sut.test.ts` and the SUT path is `<dir>/sut.ts` — the
 * "beside it" resolution rule.
 */
function run(sutContent: string | null, testContent: string, sutName = "sut"): ReturnType<typeof checkDuplicateThrowMessageAssertion> {
	const dir = mkdtempSync(join(tmpdir(), "throw-dup-check-"));
	tmpDirs.push(dir);
	if (sutContent !== null) {
		writeFileSync(join(dir, `${sutName}.ts`), sutContent, "utf-8");
	}
	const testPath = join(dir, `${sutName}.test.ts`);
	writeFileSync(testPath, testContent, "utf-8");
	return checkDuplicateThrowMessageAssertion(testContent, testPath);
}

// Both throw sites live inside the SAME function — this is the shape the
// detector must catch: `a(-1)` can reach either guard, so deleting one
// leaves the other free to throw the same matching message.
const SAME_FUNCTION_TWO_SITES = `
export function a(x: number) {
	if (x < 0) throw new Error("invalid input");
	if (x > 1000) throw new RangeError("invalid input");
	return x;
}
`;

// Two throw sites with the SAME message, but in DIFFERENT, unreachable-from-
// each-other functions. A test calling only `a` never reaches `b`'s guard,
// so this must NOT fire (see N8) — calibration against the real corpus
// found this cross-function coincidence is the dominant false-positive shape.
const DIFFERENT_FUNCTIONS_SAME_MSG = `
export function a(x: number) {
	if (x < 0) throw new Error("invalid input");
}
export function b(x: number) {
	if (x > 100) throw new RangeError("invalid input");
}
`;

describe("checkDuplicateThrowMessageAssertion — positive (must fire)", () => {
	it("P1: fires when two throw sites in the SAME function share the exact string message asserted via toThrow", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toContain("duplicate_throw_message_assertion");
	});

	it("P2: fires when a regex assertion matches two throw sites in the same function", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow(/invalid input/); });\n`);
		expect(found.length).toBe(1);
	});

	it("P3: fires through rejects.toThrow", () => {
		const sut = `
export async function c(x: number) {
	if (x < 0) throw new Error("bad value");
	if (x > 100) throw new TypeError("bad value");
	return x;
}
`;
		const found = run(sut, `import { c } from "./sut";\nit("rejects", async () => { await expect(c(-1)).rejects.toThrow("bad value"); });\n`);
		expect(found.length).toBe(1);
	});

	it("P4: fires through the toThrowError alias", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrowError("invalid input"); });\n`);
		expect(found.length).toBe(1);
	});

	it("P5: fires when the assertion wraps the literal in new Error(...)", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow(new Error("invalid input")); });\n`);
		expect(found.length).toBe(1);
	});

	it("P6: fires for template-literal throw sites sharing the same literal prefix, in the same function", () => {
		const sut = `
export function d(id: string | null) {
	if (id === null) throw new Error(\`missing id: \${id}\`);
	if (id.length === 0) throw new Error(\`missing id: \${id}\`);
}
`;
		const found = run(sut, `import { d } from "./sut";\nit("throws", () => { expect(() => d("")).toThrow("missing id: "); });\n`);
		expect(found.length).toBe(1);
	});

	it("P7: fires when the matching throw site is one hop away, in a same-file helper the callee calls", () => {
		const sut = `
function validate(x: number): void {
	if (x < 0) throw new Error("invalid input");
}
export function a(x: number) {
	validate(x);
	if (x > 1000) throw new RangeError("invalid input");
	return x;
}
`;
		const found = run(sut, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`);
		expect(found.length).toBe(1);
	});
});

describe("checkDuplicateThrowMessageAssertion — negative (must not fire)", () => {
	it("N1: does not fire when only one throw site matches the asserted message", () => {
		const sut = `
export function a(x: number) {
	if (x < 0) throw new Error("invalid input");
}
export function b(x: number) {
	if (x > 100) throw new Error("out of range");
}
`;
		const found = run(sut, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N2: does not fire on a bare toThrow() with no argument", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow(); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N3: does not fire when the SUT file is absent", () => {
		const found = run(null, `import { a } from "./missing";\nit("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N4: does not fire when the asserted message matches no throw site", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow("totally unrelated text"); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N5: does not fire on a non-test file path", () => {
		const found = checkDuplicateThrowMessageAssertion(
			`it("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`,
			"/repo/src/not-a-test.ts",
		);
		expect(found).toHaveLength(0);
	});

	it("N6: does not fire when the assertion is inside a comment", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\n// expect(() => a(-1)).toThrow("invalid input");\nit("noop", () => { expect(1).toBe(1); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N7: does not fire on toThrow(new RegExp(...)) — a dynamic pattern, not a wrapped error message", () => {
		const sut = `
export function f(n: number) {
	if (n < 0) throw new Error(\`refusing \${n} things\`);
	if (n > 100) throw new Error(\`refusing to retain \${n} things\`);
}
`;
		const found = run(sut, `import { f } from "./sut";\nit("throws", () => { expect(() => f(-1)).toThrow(new RegExp(\`refusing \${-1} things\`)); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N8: does not fire when the two matching throw sites live in different, unreachable-from-each-other functions", () => {
		const found = run(DIFFERENT_FUNCTIONS_SAME_MSG, `import { a } from "./sut";\nit("throws", () => { expect(() => a(-1)).toThrow("invalid input"); });\n`);
		expect(found).toHaveLength(0);
	});

	it("N9: does not fire when the assertion's callee cannot be resolved to a body in the SUT file", () => {
		const found = run(SAME_FUNCTION_TWO_SITES, `import { a } from "./sut";\nit("throws", () => { expect(() => JSON.parse("x")).toThrow("invalid input"); });\n`);
		expect(found).toHaveLength(0);
	});
});
