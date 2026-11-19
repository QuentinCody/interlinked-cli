import { describe, expect, it } from "vitest";
import { checkFlagArgument } from "./boolean-argument.js";
import { isPatternDataFile, isTestSourcePath } from "./shared-test-classification.js";

describe("flag_argument: positional ambiguity", () => {
	it("P1: reports a positional flag even in a multiline assigned call", () => {
		expect(checkFlagArgument("const result = createUser(\n name,\n true\n);", "src/users.ts")).toHaveLength(1);
	});
	it("P2: a safe sibling call does not hide an ambiguous call", () => {
		expect(checkFlagArgument("mkdirSync(dir); createUser(name, false);", "src/users.ts")).toHaveLength(1);
	});
	it.each(["createUser(name, { verifyEmail: true });", "createUser(name, { flags: [true, false] });", "const text = 'createUser(name, true)';", "element.setAttribute('hidden', true);"])
		("N1: accepts named options, data and known APIs: %s", code => expect(checkFlagArgument(code, "src/users.ts")).toEqual([]));
	it("N2: retains the test-file exemption", () => expect(checkFlagArgument("check(value, true);", "src/users.test.ts")).toEqual([]));
	it.each(["test.js", "spec.ts", "test.mjs", "spec.cts", "/project/test.js", "C:\\project\\spec.ts", "tests/integration.ts", "test/runner.js"])(
		"N3: excludes genuine test entrypoints and directories from boolean advice: %s", file => {
			expect(checkFlagArgument("t.is(ran, true);", file)).toEqual([]);
		},
	);
	// Public source control from p-limit a8a6fbec4e0e866d6d779b10889bb4f5567e70eb, test.js:84.
	it("N4: accepts p-limit's root AVA observable-value assertion", () => {
		expect(checkFlagArgument("t.is(ran, true);", "/foreign/p-limit/test.js")).toEqual([]);
	});
	it("N5: keeps the shared security-data exemption classifiers unchanged", () => {
		expect(isPatternDataFile("test.js")).toBe(false);
		expect(isTestSourcePath("test.js")).toBe(false);
	});
	it("P3: still advises similarly named ordinary product files", () => {
		expect(checkFlagArgument("createUser(name, true);", "src/test-helper.ts")).toHaveLength(1);
	});
});
