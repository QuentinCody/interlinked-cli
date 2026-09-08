// Mutation-kill suite for wave pass1_w44 survivors in builtin-verify-passes.ts.
// Each test isolates one mutant by choosing an InlineMatch/content/filePath
// combination where the mutated behavior changes the final `applyVerifyPasses`
// verdict for the "magic_literal_in_conditional" check id.

import { beforeEach, describe, expect, it } from "vitest";
import type { InlineMatch } from "../checks/shared.js";
import { registerAllBuiltinVerifyPasses } from "./builtin-verify-passes.js";
import { applyVerifyPasses, resetVerifyPassesForTesting } from "./verify-pass.js";

const CHECK_ID = "magic_literal_in_conditional";
// Text that never matches the typeof / case-arm / enum-comparison shapes on
// its own, so tests that only care about the `lineAt`/fixture-path behavior
// aren't accidentally filtered by an unrelated pass.
const SAFE_TEXT = "doSomething(value)";
const SAFE_PATH = "src/example.ts";

function match(line: number, text: string = SAFE_TEXT): InlineMatch {
	return { line, text };
}

beforeEach(() => {
	resetVerifyPassesForTesting();
	registerAllBuiltinVerifyPasses();
});

describe("lineAt boundary handling", () => {
	// test-contract: boundary — lineAt(content, 1) must read the real first
	// line, not the "" out-of-range sentinel (lineNo < 1 branch).
	it("kills lineNo<=1 boundary mutant: line 1 is in-range and read as real text", () => {
		const content = 'if (typeof foo === "string") {\nconsole.log(foo);\n';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		// Line 1 genuinely is a typeof-narrowing line, so it must be dropped.
		expect(kept).toEqual([]);
	});

	// test-contract: boundary — lineAt(content, lines.length) must read the
	// real last line, not the "" out-of-range sentinel (lineNo > lines.length
	// branch).
	it("kills lineNo>=lines.length boundary mutant: last line is in-range", () => {
		const content = 'console.log(1);\nif (typeof bar === "string") {';
		const lastLine = content.split("\n").length; // 2
		const kept = applyVerifyPasses(CHECK_ID, [match(lastLine)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});
});

describe("typeof-narrowing regex", () => {
	// test-contract: public-api — isTypeofNarrowingLine's regex (exercised
	// via applyVerifyPasses) must tolerate 2+ spaces after `typeof`.
	it("kills \\s+ -> \\s mutant: two spaces after typeof still narrow", () => {
		const content = 'if (typeof  foo === "string") {';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — a multi-char identifier ("foo") must still
	// satisfy the typeof-narrowing regex's identifier class.
	it("kills [\\w.]+ -> [\\w.] and typeof-pass checkId corruption mutants: multi-char identifier still narrows", () => {
		const content = 'if (typeof foo === "string") {';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — zero whitespace between identifier and
	// operator must still satisfy the regex (`\s*`, not `\s`).
	it("kills \\s* -> \\s mutant: no space before operator still narrows", () => {
		const content = 'if (typeof foo=== "string") {';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — `==` (double-equals) must still match the
	// optional-third-equals operator group.
	it("kills ===? -> === mutant: double-equals typeof comparison still narrows", () => {
		const content = 'if (typeof foo == "string") {';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — `!=` (single bang-equals) must still match
	// the optional-third-equals negation group.
	it("kills !==? -> !== mutant: single != typeof comparison still narrows", () => {
		const content = 'if (typeof foo != "string") {';
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});
});

describe("case-arm regex", () => {
	// test-contract: public-api — isCaseArmLine must require `case` at the
	// START of the trimmed line, not merely present anywhere in it.
	it("kills ^case\\s+ anchor-removal mutant: a non-case line must not be filtered", () => {
		const content = "notcase foo:\n";
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, SAFE_PATH);
		// "notcase foo:" is not a real case arm — must survive.
		expect(kept).toEqual([match(1)]);
	});
});

describe("isFixturePath", () => {
	// test-contract: public-api — backslashes in a Windows-style path must be
	// normalized to "/" (not stripped) before the fixture-path regex runs.
	it('kills "/" -> "" replacement mutant: backslash path must resolve to a fixture path', () => {
		const content = "console.log(1);";
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, "C:\\fixtures\\module.ts");
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — FIXTURE_PATH_RE's `^` alternative must
	// match a fixture dir at the very start of the path (no leading slash).
	it("kills FIXTURE_PATH_RE ^-alt removal mutant: fixture dir at string start still matches", () => {
		const content = "console.log(1);";
		const kept = applyVerifyPasses(CHECK_ID, [match(1)], content, "fixtures/module.ts");
		expect(kept).toEqual([]);
	});
});

describe("isEnumComparisonMatch", () => {
	const content = "console.log(1);";

	// test-contract: public-api — isEnumComparisonMatch must actually
	// evaluate its regex, not always return a falsy default (BlockStatement
	// mutant guts the function body to `{}`/undefined).
	it("kills BlockStatement->{}, \\s* -> \\S*, and [A-Z0-9_]+ negation mutants: a genuine enum comparison must still be dropped", () => {
		const kept = applyVerifyPasses(CHECK_ID, [match(1, "x === STATUS_OK")], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — `==` (double-equals) must still satisfy
	// the enum-comparison operator group.
	it("kills ===? -> === mutant: double-equals enum comparison must still be dropped", () => {
		const kept = applyVerifyPasses(CHECK_ID, [match(1, "x == STATUS_OK")], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — zero whitespace after the operator must
	// still satisfy the regex (`\s*`, not `\s`).
	it("kills \\s* -> \\s mutant: zero-space enum comparison must still be dropped", () => {
		const kept = applyVerifyPasses(CHECK_ID, [match(1, "x===STATUS_OK")], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});

	// test-contract: public-api — word characters immediately before the dot
	// must still satisfy the (non-negated) `\w+\.` prefix.
	it("kills \\w+\\., [A-Z], and trailing \\w+ negation mutants: dotted Status identifier must still be dropped", () => {
		const kept = applyVerifyPasses(CHECK_ID, [match(1, "x === obj.Status")], content, SAFE_PATH);
		expect(kept).toEqual([]);
	});
});
