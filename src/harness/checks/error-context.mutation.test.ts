import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	detectCatchRewrapLosesCause,
	detectJsonStringifyError,
	detectResourceHandleLeak,
} from "./error-context.js";

const FILE = "src/lib/service.ts";

/** Join source lines (avoids escaping noise for backticks and backslashes). */
const src = (...lines: string[]): string => lines.join("\n");

// Mutation-hardening tests. Each title states the intended behavior; the
// module header (error-context.ts L1-L25) and the per-detector doc comments
// define the detectors' contracts.

describe("detectJsonStringifyError — identifier and literal handling", () => {
	it("fires when the catch binding name starts with $ (regex metacharacter in an identifier)", () => {
		const content = src("try {", "  run();", "} catch ($err) {", "  log(JSON.stringify($err));", "}");
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(4);
	});

	it("ignores code-looking text inside a single-quoted string literal", () => {
		// module header: "string bodies masquerading as code" must be blanked (L56-57)
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  log('JSON.stringify(err)');",
			"}",
		);
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("keeps the catch body intact when a string literal holds an escaped closing brace", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			'  const s = "\\}";',
			"  log(JSON.stringify(err));",
			"}",
		);
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(5);
	});

	it("ignores code-looking text inside the TEXT portion of a template literal", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  log(`example: JSON.stringify(err)`);",
			"}",
		);
		expect(detectJsonStringifyError(content, FILE)).toEqual([]);
	});

	it("reports the true line number after a multi-line template literal", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  const msg = `first",
			"second",
			"third`;",
			"  log(JSON.stringify(err));",
			"}",
		);
		const findings = detectJsonStringifyError(content, FILE);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).line).toBe(7);
	});
});

describe("detectCatchRewrapLosesCause — interpolation and operand order", () => {
	it("fires when the binding follows an object literal inside a template interpolation", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  throw new Error(`failed ${ pick({ k: 1 }) + err }`);",
			"}",
		);
		expect(detectCatchRewrapLosesCause(content, FILE).length).toBe(1);
	});

	it("fires when the binding follows a nested template literal containing a brace", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  throw new Error(`failed ${ `}` + err }`);",
			"}",
		);
		expect(detectCatchRewrapLosesCause(content, FILE).length).toBe(1);
	});

	it("fires when the binding is the LEFT operand of a string concatenation", () => {
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			'  throw new Error(err + " while saving");',
			"}",
		);
		expect(detectCatchRewrapLosesCause(content, FILE).length).toBe(1);
	});

	it("still fires when an unrelated normalization ternary precedes the constructor", () => {
		// only the ternary directly feeding `new Error(...)` is exempt (doc comment L293-299)
		const content = src(
			"try {",
			"  run();",
			"} catch (err) {",
			"  const e2 = err instanceof Error ? err : null;",
			'  throw new Error("failed: " + err);',
			"}",
		);
		expect(detectCatchRewrapLosesCause(content, FILE).length).toBe(1);
	});
});

describe("detectResourceHandleLeak — release and handoff forms", () => {
	it("treats .destroy() as a release of a write stream (header lists close/end/destroy)", () => {
		const content = src(
			'import fs from "node:fs";',
			"function f(p: string) {",
			"  const out = fs.createWriteStream(p);",
			"  out.destroy();",
			"}",
		);
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});

	it("treats yielding the handle as an ownership handoff (comment L397)", () => {
		const content = src(
			'import fs from "node:fs";',
			"function* open(p: string) {",
			"  const fd = fs.openSync(p, 'r');",
			"  yield fd;",
			"}",
		);
		expect(detectResourceHandleLeak(content, FILE)).toEqual([]);
	});
});
