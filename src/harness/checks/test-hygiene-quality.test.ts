import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkDuplicateTestNames,
	checkHappyPathOnlyTest,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkDuplicateTestNames", () => {
	it("flags two it() blocks with identical names", () => {
		const code = `
it("returns 404 when missing", () => { expect(a).toBe(1); });
it("returns 404 when missing", () => { expect(b).toBe(2); });
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("returns 404 when missing");
	});

	it("flags duplicate test() and specify() too", () => {
		const code = `
test("foo", () => {});
specify("foo", () => {});
`;
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("does not fire on unique names", () => {
		const code = `it("foo", () => {}); it("bar", () => {});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not fire on non-test files", () => {
		expect(checkDuplicateTestNames(`it("a"); it("a");`, SRC)).toEqual([]);
	});

	// Refinement (2026-05): parent-describe-aware deduplication.
	// Sibling describes can reuse a test name because the reporter shows the
	// full path (`describe > it`). Only flag when two `it()`s sit inside the
	// SAME enclosing describe body.
	it("does NOT fire on sibling describes that reuse the same it() name", () => {
		const code = `
describe("checkA", () => {
  it("does NOT fire for test files", () => {});
});
describe("checkB", () => {
  it("does NOT fire for test files", () => {});
});
describe("checkC", () => {
  it("does NOT fire for test files", () => {});
});
`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("STILL fires when two it()s share a name inside the SAME describe", () => {
		const code = `
describe("checkA", () => {
  it("works", () => {});
  it("works", () => {});
});
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("same describe scope");
	});

	it("does not fire on a non-JS/TS strict test file (Python-convention name)", () => {
		expect(checkDuplicateTestNames('it("dup"); it("dup");', "src/lib/foo_test.py")).toEqual([]);
	});

	it("ignores it()/test() blocks with an empty string name", () => {
		const code = 'it("", () => {});\nit("", () => {});';
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("caps findings at MAX_MATCHES (10) even with 11 duplicate declarations", () => {
		const code = Array.from({ length: 11 }, () => 'it("dup", () => {});').join("\n");
		expect(checkDuplicateTestNames(code, TEST).length).toBe(10);
	});

	it("skips a trailing describe() whose callback body never opens a brace", () => {
		// scanForOpenBraceSkippingStrings must bail (no `{` found before EOF)
		// rather than reading into the two real it()s that precede it — the
		// dedup for those two still runs at file-root scope.
		const code = [
			'it("dup", () => {});',
			'it("dup", () => {});',
			'describe("trailing no body", () => doThing());',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("skips escaped quotes inside a describe()'s own name when finding its body", () => {
		const code =
			'describe("has \\"escaped\\" quotes", () => {\n  it("dup", () => {});\n  it("dup", () => {});\n});';
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("skips escaped quotes inside a describe() body when matching its closing brace", () => {
		const code = [
			'describe("d", () => {',
			'  const s = "has \\"escaped\\" quotes";',
			'  it("dup", () => {});',
			'  it("dup", () => {});',
			'});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("still dedups at file-root scope when a describe() body never balances its braces", () => {
		const code = 'describe("d", () => {\n  it("dup", () => {});\n  it("dup", () => {});\n';
		expect(checkDuplicateTestNames(code, TEST).length).toBe(1);
	});

	it("STILL fires when a nested describe duplicates a name from its own scope", () => {
		// The inner describe has two `it("inner")` — that's a real dup
		// inside the inner scope. The outer "inner" name is in a different
		// scope and shouldn't entangle the count.
		const code = `
describe("outer", () => {
  it("inner", () => {});
  describe("nested", () => {
    it("inner", () => {});
    it("inner", () => {});
  });
});
`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkDuplicateTestNames — comment / string / data-file FP regression", () => {
	it("does not read it() examples inside a line comment as declarations", () => {
		const code = `describe("d", () => {\n\t// docs: it("x") then again it("x")\n\tit("real", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read it() examples inside a block comment as declarations", () => {
		const code = `describe("d", () => {\n\t/* it("y"); it("y"); */\n\tit("real", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read it() inside a string-literal fixture as a declaration", () => {
		// The behavioral-checks.test.ts case: writeFileSync(f, "it('x')") test data.
		const code = [
			`describe("d", () => {`,
			`\twriteFileSync(a, "it('x', () => {});");`,
			`\twriteFileSync(b, "it('x', () => {});");`,
			`\tit("real", () => {});`,
			`});`,
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read a member call like re.test('foo.ts') as a test declaration", () => {
		// The skip-paths.test.ts FP: `expect(re.test("foo.ts"))` repeated inside
		// one describe matched `\btest(` — `\b` matches after a dot.
		const code = [
			`describe("globToRegex", () => {`,
			`\tit("star matches", () => {`,
			`\t\tconst re = globToRegex("*.ts");`,
			`\t\texpect(re.test("foo.ts")).toBe(true);`,
			`\t});`,
			`\tit("globstar matches", () => {`,
			`\t\tconst re = globToRegex("**/foo.ts");`,
			`\t\texpect(re.test("foo.ts")).toBe(true);`,
			`\t});`,
			`});`,
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read obj.it('x') member calls as it() declarations", () => {
		const code = `describe("d", () => {\n\tharness.it("x");\n\tharness.it("x");\n\tit("real", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still flags a genuine duplicate in real code (no over-suppression)", () => {
		const code = `describe("d", () => {\n\tit("dup", () => {});\n\tit("dup", () => {});\n});`;
		expect(checkDuplicateTestNames(code, TEST)).toHaveLength(1);
	});

	it("does not run on a content-scan-exempt source path (strict gate, not broad)", () => {
		// An absolute path under the package's own /harness/checks/ tree is
		// isTestFile-true (content-scan exemption) but isStrictTestFile-false, so a
		// test-hygiene check must skip it — the duplicate_test_names FP on
		// verification-stop-checks.ts.
		const code = `it("dup", () => {});\nit("dup", () => {});`;
		expect(checkDuplicateTestNames(code, resolve("src/harness/checks/some-detector.ts"))).toEqual(
			[],
		);
	});
});

// 2026-09-03: split the verdict — a same-title collision only reads as a
// "duplicate" (delete one) when the two case bodies are also equivalent.
// A same-title collision with a DIFFERENT body is a naming bug (rename one
// title), not a duplicate. Cross-describe title reuse where each describe
// scopes a different subject was already a non-finding (2026-09-02
// adjudication) — pinned again here alongside the two new outcomes so all
// three verdicts for "same title" sit next to each other.
describe("checkDuplicateTestNames — body-equivalence verdict — positive (must fire)", () => {
	it("P1: identical title AND equivalent body reports a genuine duplicate", () => {
		const code = `describe("A", () => {\n\tit("dup", () => { expect(f(1)).toBe(2); });\n\tit("dup", () => { expect(f(1)).toBe(2); });\n});`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("with an equivalent body");
		expect(nonNull(matches[0]).text).toContain("Rename one or merge the cases.");
	});

	it("P2: bodies that differ only by whitespace/comments still count as equivalent (still a duplicate)", () => {
		const code = [
			`describe("A", () => {`,
			`\tit("dup", () => {`,
			`\t\t// a comment`,
			`\t\texpect(f(1)).toBe(2);`,
			`\t});`,
			`\tit("dup", () => { expect(f(1)).toBe(2); });`,
			`});`,
		].join("\n");
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("with an equivalent body");
	});
});

describe("checkDuplicateTestNames — body-equivalence verdict — negative (must not fire as 'duplicate')", () => {
	it("N1: identical title, materially different body → a rename message, not a duplicate finding", () => {
		const code = `describe("A", () => {\n\tit("dup", () => { expect(f(1)).toBe(2); });\n\tit("dup", () => { expect(g(9)).toBe(-1); });\n});`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toHaveLength(1);
		const text = nonNull(matches[0]).text;
		expect(text).not.toContain("duplicate test name");
		expect(text).not.toContain("with an equivalent body");
		expect(text).toContain("naming collision, not a duplicate");
		expect(text).toContain("Rename one of the two titles");
	});

	it("N2: same title in two different describe blocks scoping different subjects is not a finding at all", () => {
		const code = [
			`describe("widget A", () => {`,
			`\tit("renders", () => { expect(f(1)).toBe(2); });`,
			`});`,
			`describe("widget B", () => {`,
			`\tit("renders", () => { expect(g(9)).toBe(-1); });`,
			`});`,
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});
});

describe("checkTestMissingSutImport", () => {
	it("flags a foo.test.ts that does not import ./foo", () => {
		const code = `
import { something } from "./bar.js";
it("does a thing", () => {});
`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does not fire when the SUT is imported", () => {
		const code = `
import { foo } from "./foo.js";
it("works", () => { expect(foo()).toBe(1); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via ../", () => {
		const code = `import { foo } from "../foo.js";`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT is imported via require()", () => {
		const code = `const { foo } = require("./foo");`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire on index.test.ts (barrel file)", () => {
		expect(checkTestMissingSutImport(`it("a")`, "src/lib/index.test.ts")).toEqual([]);
	});

	it("does not fire in __fixtures__ paths", () => {
		expect(
			checkTestMissingSutImport(`it("a")`, "src/__fixtures__/foo.test.ts"),
		).toEqual([]);
	});

	// Tier 2 fallback (added 2026-05): the canonical multi-SUT grouping
	// pattern — a __tests__/-housed test file that imports its real SUT
	// from a parent directory under a different name.
	it("does not fire when the test imports a parent-directory source (multi-SUT grouping)", () => {
		const code = `import { foo, bar } from "../behavioral-checks.js";`;
		// File path mimics the real one from the FP report: tdd-cycle.test.ts
		// lives in __tests__/ and groups behavioral-checks-related TDD tests.
		const filePath = "src/harness/__tests__/tdd-cycle.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("STILL fires on a same-directory sibling import (misnamed test)", () => {
		// The original "performative test" bug class — a foo.test.ts that
		// imports something else from the same directory is still flagged.
		const code = `import { bar } from "./bar.js";`;
		expect(checkTestMissingSutImport(code, TEST)).not.toEqual([]);
	});

	it("STILL fires with THREE same-directory sibling imports but no companion", () => {
		// Regression: the multi-module carve-out (exemption c) must count only
		// cross-directory (`../`) imports. A foo.test.ts importing 3 same-dir
		// siblings but not ./foo is still the misnamed-test shape — counting
		// `./` toward the >=3 threshold re-admitted this bug class (false
		// negative). Same-directory-only imports must NOT grant the exemption.
		const code = `
import { bar } from "./bar.js";
import { baz } from "./baz.js";
import { qux } from "./qux.js";
it("does a thing", () => {});
`;
		expect(checkTestMissingSutImport(code, TEST)).not.toEqual([]);
	});

	it("STILL fires on a test that only imports __mocks__ / fixtures via parent dir", () => {
		const code = `import { mockFs } from "../__mocks__/fs.js";`;
		const filePath = "src/harness/__tests__/foo.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});

	it("does not fire on a non-JS/TS strict test file (Python-convention name)", () => {
		expect(checkTestMissingSutImport(`it("a")`, "src/lib/foo_test.py")).toEqual([]);
	});

	it("does not fire for a regression-suite-named file with no companion module", () => {
		const code = `it("works", () => {});`;
		const filePath = "src/commands/__tests__/cli-bugs.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("does not fire when the SUT is exercised as a subprocess (codemod-script shape)", () => {
		const code = [
			'const { execSync } = require("child_process");',
			'it("runs the migration", () => {',
			'  execSync("node scripts/migrate.mjs");',
			"});",
		].join("\n");
		const filePath = "src/scripts/__tests__/migrate.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("does not fire when 3+ distinct parent-dir modules are imported via dynamic import()", () => {
		// hasAnyProjectSourceImport only recognizes `from`/`require` imports, so
		// dynamic `import("../x.js")` calls reach the multi-module carve-out in
		// isExemptFromSutPairing rather than short-circuiting earlier.
		const code = [
			'const a = await import("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const c = await import("../mod-c.js");',
			'it("does things", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/multi.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});
});

// Followup #24: the sutBase stripped only `.test.ts` / `.spec.ts`, so every
// `*.mutation-kill.test.ts` resolved to the phantom SUT `<base>.mutation-kill`
// and the check false-fired on suites that DO import their SUT. The suffix
// grammar is now shared with MUTATION_DIRECTED_PATH (checks/test-legitimacy.ts).
describe("checkTestMissingSutImport — mutation-directed suffix chain — negative (must not fire)", () => {
	it("N1: a .mutation-kill.test.ts companion importing ./<base>.js passes", () => {
		const code = `import { foo } from "./foo.js";\nit("kills M1", () => { expect(foo()).toBe(1); });`;
		expect(checkTestMissingSutImport(code, "src/harness/checks/foo.mutation-kill.test.ts")).toEqual([]);
	});

	it("N2: the same holds for .mutation-hardening. and .survivors. suffixes", () => {
		const code = `import { foo } from "./foo.js";`;
		expect(checkTestMissingSutImport(code, "src/harness/foo.mutation-hardening.test.ts")).toEqual([]);
		expect(checkTestMissingSutImport(code, "src/harness/foo.survivors.test.ts")).toEqual([]);
		expect(checkTestMissingSutImport(code, "src/harness/foo.survivor.test.ts")).toEqual([]);
	});

	it("N3: index.mutation-kill.test.ts is still exempt as a barrel", () => {
		expect(checkTestMissingSutImport(`it("a")`, "src/lib/index.mutation-kill.test.ts")).toEqual([]);
	});
});

describe("checkTestMissingSutImport — mutation-directed suffix chain — positive (must fire)", () => {
	it("P1: a .mutation-kill.test.ts importing NOTHING still fires, naming the stripped SUT", () => {
		const matches = checkTestMissingSutImport(
			`it("kills M1", () => { expect(1).toBe(1); });`,
			"src/harness/checks/foo.mutation-kill.test.ts",
		);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("`./foo`");
	});

	it("P2: a .mutation-kill.test.ts importing only an unrelated sibling still fires", () => {
		const code = `import { bar } from "./bar.js";\nit("kills M2", () => {});`;
		expect(checkTestMissingSutImport(code, "src/harness/checks/foo.mutation-kill.test.ts")).not.toEqual([]);
	});
});

describe("checkMockingTheSutSelf", () => {
	it("flags vi.mock(\"./foo\") inside foo.test.ts", () => {
		const code = `vi.mock("./foo");`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("flags jest.mock(\"./foo\")", () => {
		expect(checkMockingTheSutSelf(`jest.mock("./foo.js");`, TEST).length).toBe(1);
	});

	it("does not fire when mocking a different module", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./bar");`, TEST)).toEqual([]);
	});

	it("does not fire in production source", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./foo");`, SRC)).toEqual([]);
	});

	it("does not fire on a non-JS/TS strict test file (Python-convention name)", () => {
		expect(checkMockingTheSutSelf('vi.mock("./foo_test");', "src/lib/foo_test.py")).toEqual([]);
	});
});

describe("checkMockOnlyTest", () => {
	// --- positive: must fire ---
	it("flags a block whose only assertion is toHaveBeenCalledWith", () => {
		const code = `it("calls the API", async () => {
			await run();
			expect(client.fetch).toHaveBeenCalledWith("/users", { page: 1 });
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("mock interactions");
	});

	it("flags a block with multiple positive call assertions and no value check", () => {
		const code = `it("invokes the logger twice", () => {
			act();
			expect(log).toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(2);
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});

	it("flags a block mixing a negated and a positive call assertion", () => {
		const code = `it("logs but does not retry", () => {
			act();
			expect(retry).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledOnce();
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});

	// --- negative: must NOT fire ---
	it("does not fire when the block also asserts a value", () => {
		const code = `it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			expect(out).toEqual({ ok: true });
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a named node:assert import asserts a value", () => {
		const code = `
		import { strictEqual, deepStrictEqual as sameShape } from "node:assert";

		it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			strictEqual(out.status, 200);
			sameShape(out.body, { ok: true });
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a destructured node:assert require asserts a value", () => {
		const code = `
		const { ok, deepStrictEqual: sameShape } = require("node:assert/strict");

		it("returns the parsed result", async () => {
			const out = await run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			ok(out.status === 200);
			sameShape(out.body, { ok: true });
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a pure not.toHaveBeenCalled() guard test", () => {
		const code = `it("does nothing when unauthenticated", async () => {
			await run({ authed: false });
			expect(client.fetch).not.toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a zero call-count guard test", () => {
		const code = `it("does not call the API when unauthenticated", async () => {
			await run({ authed: false });
			expect(client.fetch).toHaveBeenCalledTimes(0);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a block with only value assertions", () => {
		const code = `it("sums two values", () => { expect(add(1, 2)).toBe(3); });`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on an assertion-free block", () => {
		const code = `it("just executes", () => { doThing(); });`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire in non-test source", () => {
		expect(checkMockOnlyTest(`expect(log).toHaveBeenCalled();`, SRC)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest", () => {
	// --- positive: must fire ---
	it("flags a 3-case file that only ever asserts success", () => {
		const code = `
		it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });
		it("adds a larger pair", () => { expect(add(10, 5)).toBe(15); });
		it("concatenates", () => { expect(join("a", "b")).toBe("ab"); });
		`;
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("never asserts a failure path");
	});

	it("flags a happy-only file using toEqual / toContain", () => {
		const code = `
		it("builds the list", () => { expect(build()).toEqual([1, 2]); });
		it("includes the head", () => { expect(build()).toContain(1); });
		it("has a length", () => { expect(build()).toHaveLength(2); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST).length).toBe(1);
	});

	// --- negative: must NOT fire ---
	it("does not fire when a case uses .not", () => {
		const code = `
		it("sums alpha", () => { expect(x()).toBe(1); });
		it("sums beta", () => { expect(y()).toBe(2); });
		it("sums gamma", () => { expect(z()).not.toBe(9); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a case asserts a thrown error", () => {
		const code = `
		it("sums delta", () => { expect(x()).toBe(1); });
		it("sums epsilon", () => { expect(y()).toBe(2); });
		it("sums zeta", () => { expect(() => parse("")).toThrow(); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a test is named for a failure path", () => {
		const code = `
		it("returns the value", () => { expect(get()).toBe(1); });
		it("returns a second value", () => { expect(get2()).toBe(2); });
		it("handles invalid input", () => { expect(get3()).toBe(3); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire on a file with fewer than 3 cases", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not count todo cases toward the happy-path threshold", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		test.todo("adds the failure path");
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("ignores skipped failure-path names when deciding whether to warn", () => {
		const code = `
		it("sums theta", () => { expect(x()).toBe(1); });
		it("sums iota", () => { expect(y()).toBe(2); });
		it("sums kappa", () => { expect(z()).toBe(3); });
		it.skip("rejects invalid input", () => { expect(() => parse("")).toThrow(); });
		`;
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("never asserts a failure path");
	});

	it("does not count test-looking fixture strings or comments as real cases", () => {
		const code = [
			'it("sums theta", () => { expect(x()).toBe(1); });',
			"const fixture = `",
			'it("fixture alpha", () => { expect(alpha()).toBe(1); });',
			'it("fixture beta", () => { expect(beta()).toBe(2); });',
			'it("fixture gamma", () => { expect(gamma()).toBe(3); });',
			"`;",
			'// it("commented fixture", () => { expect(delta()).toBe(4); });',
			'it("sums iota", () => { expect(y()).toBe(2); });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire when a promise rejection is asserted", () => {
		const code = `
		it("sums kappa", () => { expect(x()).toBe(1); });
		it("sums omega", () => { expect(y()).toBe(2); });
		it("sums sigma", async () => { await expect(run()).rejects.toThrow(); });
		`;
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("does not fire in non-test source", () => {
		const code = `
		it("sums tau", () => { expect(x()).toBe(1); });
		it("sums phi", () => { expect(y()).toBe(2); });
		it("sums chi", () => { expect(z()).toBe(3); });
		`;
		expect(checkHappyPathOnlyTest(code, SRC)).toEqual([]);
	});

	it("does not fire on a non-JS/TS strict test file (Python-convention name)", () => {
		const code = `
		it("adds a", () => { expect(add(1, 2)).toBe(3); });
		it("adds b", () => { expect(add(2, 3)).toBe(5); });
		it("adds c", () => { expect(add(3, 4)).toBe(7); });
		`;
		expect(checkHappyPathOnlyTest(code, "src/lib/foo_test.py")).toEqual([]);
	});

	it("still counts cases and the describe name when the cases are wrapped in a describe()", () => {
		const code = `
		describe("adds", () => {
			it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });
			it("adds a larger pair", () => { expect(add(10, 5)).toBe(15); });
			it("concatenates", () => { expect(join("a", "b")).toBe("ab"); });
		});
		`;
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("never asserts a failure path");
	});
});

// ==========================================================================
// Mutation-hardening additions — exact-value assertions and boundary
// fixtures added to kill surviving mutants in the underlying regex/scan
// helpers. Each block below documents which internal quantifier/boundary it
// targets.
// ==========================================================================

describe("checkDuplicateTestNames — regex quantifier robustness (TEST_BLOCK_INTRO_RE)", () => {
	it("still recognizes it( with whitespace before the opening paren", () => {
		// TEST_BLOCK_INTRO_RE's `\s*` before `\(` must tolerate `it (`, not just `it(`.
		const code = 'it ("dup", () => {});\nit("dup", () => {});';
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toEqual([
			{
				line: 2,
				text: 'duplicate test name "dup" — first declared on line 1 in the same describe scope, with an equivalent body. Rename one or merge the cases.',
			},
		]);
	});
});

describe("checkDuplicateTestNames — regex quantifier robustness (DESCRIBE_INTRO_RE)", () => {
	it("still recognizes describe( with whitespace before the opening paren for scoping", () => {
		// If `describe (` (spaced) isn't recognized, findDescribeRanges finds no
		// range for either block and both "dup" it()s collapse to file-root scope,
		// producing a false duplicate.
		const code = [
			'describe ("A", () => {',
			'  it("dup", () => {});',
			"});",
			'describe ("B", () => {',
			'  it("dup", () => {});',
			"});",
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});
});

describe("checkDuplicateTestNames — codeOnlyMask string-literal masking", () => {
	it("does not read an it() call embedded in a single-quoted fixture string as a declaration", () => {
		// codeOnlyMask's single-quote regex must blank the WHOLE quoted string
		// (not just a 1-char interior) so the fake it("dup") inside it never
		// reaches TEST_BLOCK_INTRO_RE as "real code".
		const code = 'const s = \'it("dup", () => {});\';\nit("dup", () => {});';
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not read an it() call embedded in a template-literal fixture string as a declaration", () => {
		const code = "const s = `it(\"dup\", () => {});`;\nit(\"dup\", () => {});";
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});
});

describe("checkDuplicateTestNames — brace/quote scanning robustness", () => {
	it("still isolates a describe's scope when its own name has an odd number of escaped quotes followed by a literal brace", () => {
		// scanForOpenBraceSkippingStrings must treat `\"` as ONE escaped char
		// (skip both), not re-enter/exit quote mode on the escaped quote alone.
		// An ODD escape count breaks the string-tracking parity if the
		// backslash-skip is disabled, causing the stray `{` inside the name to
		// be misread as the callback's opening brace.
		const code = [
			'describe("a \\"esc {fake}", () => {',
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still finds the correct closing brace when the describe body contains a string with an escaped quote and a literal brace", () => {
		// findMatchingCloseBraceSkippingStrings mirrors the same escape logic
		// for the CLOSING side — a broken backslash-skip inflates brace depth
		// on the stray `{` inside the string, moving the computed body end.
		const code = [
			'describe("d", () => {',
			'  const s = "value \\" then { a fake brace";',
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still isolates scope via a single-quoted describe name containing a literal brace", () => {
		const code = [
			"describe('a { fake brace', () => {",
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still finds the correct closing brace when the describe BODY contains a template literal with a literal brace", () => {
		const code = [
			'describe("d", () => {',
			"  const s = `has a } inside`;",
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still finds the correct closing brace when the describe BODY contains a single-quoted string with a literal brace", () => {
		const code = [
			'describe("d", () => {',
			"  const s = 'has a } inside';",
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("still isolates scope via a template-literal describe name containing a literal brace", () => {
		const code = [
			"describe(`a { fake brace`, () => {",
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
		].join("\n");
		expect(checkDuplicateTestNames(code, TEST)).toEqual([]);
	});

	it("does not treat an it() call physically AFTER a describe's closing brace as still inside that describe", () => {
		// innermostDescribeAt's `offset < r.bodyEnd` check must actually bound
		// the range — if forced true, an it() after the closing brace still
		// resolves to the enclosing describe's scope, colliding with the it()
		// genuinely inside it.
		const code = [
			'describe("A", () => {',
			'  it("dup", () => {});',
			"});",
			'it("dup", () => {});',
			'it("dup", () => {});',
		].join("\n");
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toEqual([
			{
				line: 5,
				text: 'duplicate test name "dup" — first declared on line 4 in the same describe scope, with an equivalent body. Rename one or merge the cases.',
			},
		]);
	});
});

describe("checkDuplicateTestNames — exact match-array assertions (line/text arithmetic)", () => {
	it("trims the reported name and computes 1-based line numbers from the FIRST occurrence (offset 0, no leading newline)", () => {
		const code = 'it("  dup  ", () => {});\nit("  dup  ", () => {});';
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toEqual([
			{
				line: 2,
				text: 'duplicate test name "dup" — first declared on line 1 in the same describe scope, with an equivalent body. Rename one or merge the cases.',
			},
		]);
	});

	it("computes lineIdx from newlines BEFORE the match offset, not the whole file", () => {
		// A trailing line after both duplicates means "whole content newline
		// count" and "newlines up to this match" diverge — this distinguishes
		// content.slice(0, offset) from bare content.
		const code = 'it("dup", () => {});\nit("dup", () => {});\n// trailing';
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toEqual([
			{
				line: 2,
				text: 'duplicate test name "dup" — first declared on line 1 in the same describe scope, with an equivalent body. Rename one or merge the cases.',
			},
		]);
	});

	it("truncates a duplicate name longer than 80 chars in the reported text", () => {
		const longName = "x".repeat(85);
		const code = `it("${longName}", () => {});\nit("${longName}", () => {});`;
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches).toEqual([
			{
				line: 2,
				text: `duplicate test name "${longName.slice(0, 80)}" — first declared on line 1 in the same describe scope, with an equivalent body. Rename one or merge the cases.`,
			},
		]);
	});

	it("caps findings at MAX_MATCHES (10) even with far more than 11 duplicate declarations", () => {
		// 15 occurrences => 14 natural duplicate pairs, strictly more than the
		// cap, so this actually exercises the break (11 was a coincidental tie).
		const code = Array.from({ length: 15 }, () => 'it("dup", () => {});').join("\n");
		expect(checkDuplicateTestNames(code, TEST).length).toBe(10);
	});
});

describe("checkTestMissingSutImport — exact guard/regex assertions", () => {
	it("flags with the exact expected line/text shape (guards against object-literal or string mutation)", () => {
		const code = 'import { something } from "./bar.js";\nit("does a thing", () => {});';
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches).toEqual([
			{
				line: 1,
				text: "test file does not import its SUT (`./foo` not found, and the file imports no other project source). The test is not testing what its name claims.",
			},
		]);
	});

	it("does not fire when the SUT is imported with NO trailing extension (regex must not require one)", () => {
		const code = 'import { foo } from "./foo";';
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire when the SUT import uses .tsx", () => {
		const code = 'import { foo } from "./foo.tsx";';
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("normalizes a Windows-style backslash path to forward slashes (not strips backslashes outright)", () => {
		// If backslashes are stripped instead of replaced with "/", the whole
		// path collapses into one fileName token and the SUT basename comes
		// out wrong, breaking the companion-import match below.
		const code = 'import { foo } from "./foo.js";';
		const filePath = "src\\lib\\foo.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still fires for a SUT basename that only differs by a path-prefix segment sharing the same tail", () => {
		// escaped SUT basename must be used LITERALLY (not read as a wildcard) —
		// a totally unrelated file sharing no substring with "foo" must still flag.
		const code = 'import { z } from "./zzz.js";';
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkMockingTheSutSelf — exact match-array and boundary assertions", () => {
	it("flags with the exact expected line/text shape", () => {
		const code = 'vi.mock("./foo");';
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches).toEqual([
			{
				line: 1,
				text: "test mocks the system under test (`./foo`). The test is no longer verifying its target — fix the SUT or test something else.",
			},
		]);
	});

	it("computes the reported line from newlines before the match, not the whole file", () => {
		const code = '// header\n// still header\nvi.mock("./foo");\n// trailing';
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches).toEqual([
			{
				line: 3,
				text: "test mocks the system under test (`./foo`). The test is no longer verifying its target — fix the SUT or test something else.",
			},
		]);
	});

	it("caps findings at MAX_MATCHES (3) even with 5 mocks of the SUT", () => {
		const code = Array.from({ length: 5 }, () => 'vi.mock("./foo");').join("\n");
		expect(checkMockingTheSutSelf(code, TEST).length).toBe(3);
	});

	it("normalizes a Windows-style backslash path to forward slashes (not strips backslashes outright)", () => {
		const code = 'vi.mock("./foo");';
		const filePath = "src\\lib\\foo.test.ts";
		const matches = checkMockingTheSutSelf(code, filePath);
		expect(matches).toEqual([
			{
				line: 1,
				text: "test mocks the system under test (`./foo`). The test is no longer verifying its target — fix the SUT or test something else.",
			},
		]);
	});

	it("does not fire on a mock target reached via a same-directory relative prefix that isn't an EXACT basename match", () => {
		// mockTargetIsSut must compare the FULL basename-minus-extension, not a
		// substring — "./foobar" must not be flagged as mocking "./foo".
		expect(checkMockingTheSutSelf(`vi.mock("./foobar");`, TEST)).toEqual([]);
	});

	it("does not fire on a mock target using a stripped ./  prefix that is a sub-directory sibling", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./sub/foo");`, TEST)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest — NEGATIVE_ASSERTION_RE quantifier/boundary robustness", () => {
	function threeCasesWithExtra(extraLine: string): string {
		return [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			extraLine,
		].join("\n");
	}

	it("recognizes `.not.` with surrounding whitespace (not just no-space `.not.`)", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(z()) . not .toBe(9); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toThrow with whitespace before the call paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(() => f()).toThrow  (); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes .rejects with whitespace after the dot", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", async () => { await expect(p()) . rejects.toThrow(); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes a multi-char toReject* matcher with whitespace before the call paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", async () => { await expect(p()).toRejectWithError  (); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toBeNull with whitespace before the call paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(f()).toBeNull  (); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toStrictEqual(...) with whitespace before its call paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(f()).toStrictEqual  (undefined); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toEqual( null ) with whitespace after the paren and before the close paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(f()).toEqual(  null  ); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toBeInstanceOf with whitespace after itself and after its call paren", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(f()).toBeInstanceOf  (  TypeError); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes a multi-word instanceof Error check with a single mandatory space", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { expect(f() instanceof CustomFetchError).toBe(true); });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes catch with whitespace before a bare brace (no-binding catch form)", () => {
		const code = threeCasesWithExtra(
			'it("sums gamma", () => { try { f(); } catch  { g(); } });',
		);
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest — NEGATIVE_NAME_RE singular 'raise' form", () => {
	it("recognizes the singular 'raise' (not just 'raises')", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("things that raise", () => { expect(z()).toBe(3); });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest — DESCRIBE_NAME_RE robustness", () => {
	it("still collects a plain describe() name (no .skip/.only modifier) toward the failure-name check", () => {
		const code = [
			'describe("handles errors", () => {',
			'  it("case alpha", () => { expect(x()).toBe(1); });',
			'  it("case beta", () => { expect(y()).toBe(2); });',
			'  it("case gamma", () => { expect(z()).toBe(3); });',
			"});",
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("still collects a describe() name with whitespace before its opening paren", () => {
		const code = [
			'describe ("handles errors", () => {',
			'  it("case alpha", () => { expect(x()).toBe(1); });',
			'  it("case beta", () => { expect(y()).toBe(2); });',
			'  it("case gamma", () => { expect(z()).toBe(3); });',
			"});",
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("still collects a describe() name with whitespace after its opening paren", () => {
		const code = [
			'describe( "handles errors", () => {',
			'  it("case alpha", () => { expect(x()).toBe(1); });',
			'  it("case beta", () => { expect(y()).toBe(2); });',
			'  it("case gamma", () => { expect(z()).toBe(3); });',
			"});",
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("still collects a single-quoted describe() name toward the failure-name check", () => {
		const code = [
			"describe('handles errors', () => {",
			'  it("case alpha", () => { expect(x()).toBe(1); });',
			'  it("case beta", () => { expect(y()).toBe(2); });',
			'  it("case gamma", () => { expect(z()).toBe(3); });',
			"});",
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest — blankNonExecutingTestCalls span computation", () => {
	it("does not count a skipped it() whose argument list spans multiple lines", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it.skip(',
			'  "rejects invalid input",',
			'  () => { expect(() => parse("")).toThrow(); }',
			');',
			'it("sums gamma", () => { expect(z()).toBe(3); });',
		].join("\n");
		// Only 3 REAL cases (alpha, beta, gamma) — none of them negative, and
		// the skipped block must not contribute a negative signal either.
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("this test file has 3 cases");
	});

	it("correctly bounds the blanked span of a skipped call so a REAL case immediately after it is still counted and its own negative assertion is not swallowed", () => {
		// findCallSpan must be called with the index just INSIDE the skip
		// call's opening paren (not one before it, and not one past the true
		// close) — an off-by-one here either leaks the skip block's own
		// toThrow() as a live negative signal, or eats into the next real
		// case's declaration.
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it.skip("rejects invalid input", () => { expect(() => parse("")).toThrow(); });',
			'it("sums gamma", () => { expect(z()).toBe(3); });',
		].join("\n");
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("this test file has 3 cases");
	});

	it("does not throw when a skipped call's argument list never balances before end of file", () => {
		// findCallSpan legitimately returns null for an unbalanced/truncated
		// call — the fallback branch (m.index + m[0].length) must be used in
		// that case, not `span.end`, which would throw on a null span.
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", () => { expect(z()).toBe(3); });',
			'it.skip("rejects invalid input", (',
		].join("\n");
		let matches: ReturnType<typeof checkHappyPathOnlyTest> = [];
		expect(() => {
			matches = checkHappyPathOnlyTest(code, TEST);
		}).not.toThrow();
		expect(matches.length).toBe(1);
	});

	it("does not miscount when a skipped call has no parenthesized argument list at all", () => {
		// openParen === -1 path (findCallSpan never invoked): must still blank
		// through to end of the matched intro rather than leaving trailing
		// content unblanked or throwing.
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", () => { expect(z()).toBe(3); });',
			"describe.skip",
		].join("\n");
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("hasAnyProjectSourceImport — regex quantifier/anchor robustness", () => {
	it("recognizes require(...) with NO whitespace between the keyword and the paren (the common form)", () => {
		expect(hasAnyProjectSourceImport('const x = require("../real-module.js");')).toBe(true);
	});

	it("recognizes require( ...) with whitespace after the opening paren", () => {
		expect(hasAnyProjectSourceImport('const x = require( "../real-module.js");')).toBe(true);
	});

	it("recognizes require (...) with whitespace before the opening paren", () => {
		expect(hasAnyProjectSourceImport('const x = require ("../real-module.js");')).toBe(true);
	});

	it("does not treat a `.json` substring in the middle of a path as an asset import (extension must anchor at the end)", () => {
		expect(hasAnyProjectSourceImport('import x from "../schema.json.ts";')).toBe(true);
	});

	it("still excludes a genuine trailing .json asset import", () => {
		expect(hasAnyProjectSourceImport('import x from "../schema.json";')).toBe(false);
	});

	it("returns false for a file with no parent-directory imports at all", () => {
		expect(hasAnyProjectSourceImport('import x from "./sibling.js";')).toBe(false);
	});
});

describe("checkTestMissingSutImport — multi-module carve-out regex robustness (countDistinctProjectImports)", () => {
	it("counts a dynamic import() with whitespace before its call paren toward the multi-module exemption", () => {
		const code = [
			'const a = await import ("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const c = await import("../mod-c.js");',
			'it("does things", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/multi-space.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("counts a dynamic import() with whitespace after its call paren toward the multi-module exemption", () => {
		const code = [
			'const a = await import( "../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const c = await import("../mod-c.js");',
			'it("does things", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/multi-space2.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("does NOT grant the multi-module exemption for exactly 2 distinct dynamic imports (boundary below MIN)", () => {
		const code = [
			'const a = await import("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/two-only.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});

	it("does not double-count the SAME dynamic-import spec repeated 3 times (distinct-set, not raw count)", () => {
		const code = [
			'const a = await import("../mod-a.js");',
			'const a2 = await import("../mod-a.js");',
			'const a3 = await import("../mod-a.js");',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/dup-only.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});

	it("excludes a dynamic import() of a .test. spec from the distinct-module count", () => {
		const code = [
			'const a = await import("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const t = await import("../mod-c.test.js");',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/excludes-test-spec.test.ts";
		// Only 2 real distinct modules (a, b) — the .test. spec must not count
		// toward the >= 3 exemption threshold.
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});

	it("excludes a dynamic import() of a trailing .json asset from the distinct-module count", () => {
		const code = [
			'const a = await import("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const j = await import("../config.json");',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/excludes-json.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});
});

describe("checkTestMissingSutImport — regression-suite name-anchor robustness", () => {
	it("does not exempt a file whose basename merely CONTAINS 'bugs' mid-word (anchored, not substring)", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/debugsomething.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});

	it("still exempts the plural 'bugs' form", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/cli-bugs.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still exempts the singular 'regression' form (optional trailing s)", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/api-regression.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});
});

describe("checkTestMissingSutImport — sutBase regex anchor/quantifier robustness", () => {
	it("does not let an earlier .spec./.js-shaped substring in the filename win over the trailing .test.ts suffix", () => {
		// sutBase's regex must be $-anchored so it strips the TRAILING
		// .test./.spec. occurrence, not the leftmost one in a filename that
		// happens to contain the pattern twice.
		const code = 'import { x } from "./a.test.js";';
		const filePath = "src/lib/a.test.js.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still computes a sutBase for a plain .test.js file (jsx? group must accept bare js)", () => {
		const code = 'import { something } from "./bar.js";';
		const filePath = "src/lib/foo.test.js";
		const matches = checkTestMissingSutImport(code, filePath);
		expect(matches.length).toBe(1);
	});

	it("does not flag a naming-convention-mismatched file inside a __tests__ dir with no SUT-shaped basename", () => {
		// sutBase===fileName (no .test./.spec. suffix present) must bail out
		// via the empty-sutBase guard rather than building a bogus import
		// pattern from the literal filename.
		const code = 'it("does something", () => {});';
		const filePath = "src/harness/__tests__/helper.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("escapes regex-special characters in the sutBase rather than stripping them", () => {
		// If the escaper strips instead of escapes, the dot in "my.util"
		// disappears from the generated pattern and the real import fails
		// to match it.
		const code = 'import { x } from "./my.util.js";';
		const filePath = "src/lib/my.util.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});
});

describe("checkMockingTheSutSelf — sutBase regex anchor/quantifier robustness", () => {
	it("does not let an earlier .spec./.js-shaped substring in the filename win over the trailing .test.ts suffix", () => {
		const code = 'vi.mock("./foo.spec.ts.js");';
		const filePath = "src/lib/foo.spec.ts.test.ts";
		const matches = checkMockingTheSutSelf(code, filePath);
		expect(matches.length).toBe(1);
	});

	it("still computes a sutBase for a plain .test.js file (jsx? group must accept bare js)", () => {
		const code = 'vi.mock("./foo");';
		const filePath = "src/lib/foo.test.js";
		const matches = checkMockingTheSutSelf(code, filePath);
		expect(matches.length).toBe(1);
	});

	it("does not flag a naming-convention-mismatched file inside a __tests__ dir with no SUT-shaped basename", () => {
		const code = 'vi.mock("./helper.ts.js");';
		const filePath = "src/harness/__tests__/helper.ts";
		expect(checkMockingTheSutSelf(code, filePath)).toEqual([]);
	});
});

describe("checkMockingTheSutSelf — SUT_MOCK_RE whitespace robustness", () => {
	it("recognizes vi .mock(...) with whitespace between the object and the dot", () => {
		expect(checkMockingTheSutSelf('vi .mock("./foo");', TEST).length).toBe(1);
	});

	it("recognizes vi. mock(...) with whitespace between the dot and mock", () => {
		expect(checkMockingTheSutSelf('vi. mock("./foo");', TEST).length).toBe(1);
	});

	it("recognizes vi.mock (...) with whitespace before the call paren", () => {
		expect(checkMockingTheSutSelf('vi.mock ("./foo");', TEST).length).toBe(1);
	});
});

describe("checkMockingTheSutSelf — mockTargetIsSut boundary robustness", () => {
	it("does not treat an INTERIOR ./ occurrence as the leading same-directory marker", () => {
		// `^\./` must anchor at the start — a target with a NON-leading "./"
		// substring must not have that occurrence stripped instead of failing
		// the same-directory check outright.
		const filePath = "src/lib/xy.test.ts";
		expect(checkMockingTheSutSelf('vi.mock("x./y");', filePath)).toEqual([]);
	});

	it("does not strip a NON-trailing extension-shaped substring from the mock target", () => {
		// The extension-strip regex must be $-anchored — otherwise a target
		// like "./foo.js.ts" has its FIRST extension-shaped substring
		// stripped instead of the real trailing one, and a genuine SUT mock
		// stops matching.
		const code = 'vi.mock("./foo.js.ts");';
		const filePath = "src/lib/foo.js.test.ts";
		const matches = checkMockingTheSutSelf(code, filePath);
		expect(matches.length).toBe(1);
	});
});

describe("checkHappyPathOnlyTest — REGRESSION_SUITE_NAME_RE-adjacent sutBase exemption regex robustness", () => {
	it("still exempts a sutBase that is EXACTLY 'bugs' with nothing around it (anchor, not literal separator)", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/bugs.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still exempts the singular 'bug' form (optional trailing s)", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/bug.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still exempts a sutBase where 'bugs' is followed by a separator and more text (not just end-of-string)", () => {
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/bugs-report.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("still exempts the mandatory 'regression' stem followed by a separator with no trailing 's' to backtrack onto", () => {
		// "regressions?" and "bugs?" both have an OPTIONAL trailing letter the
		// engine can backtrack off of when the following char is itself a
		// letter — this fixture's separator sits directly after the
		// MANDATORY stem with no such letter available, closing that escape.
		const code = 'it("works", () => {});';
		const filePath = "src/commands/__tests__/regression-x.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});
});

describe("checkTestMissingSutImport — subprocess-string-only exemption must require an ACTUAL subprocess call", () => {
	it("does not grant the subprocess exemption merely because the script path appears in an unrelated string", () => {
		const code = [
			'const path = "scripts/foo.mjs"; // not actually invoked',
			'import { bar } from "./bar.js";',
			'it("does a thing", () => {});',
		].join("\n");
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkTestMissingSutImport — countDistinctProjectImports paren-optionality and asset-anchor robustness", () => {
	it("counts a plain side-effect `import \"../x\"` (no call paren) toward the multi-module exemption", () => {
		const code = [
			'import "../mod-a.js";',
			'import "../mod-b.js";',
			'import "../mod-c.js";',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/import-noparen.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("does not treat a NON-trailing .json substring as an asset import in the distinct-module count", () => {
		const code = [
			'const a = await import("../mod-a.js");',
			'const b = await import("../mod-b.js");',
			'const c = await import("../schema.json.ts");',
			'it("does a thing", () => {});',
		].join("\n");
		const filePath = "src/harness/__tests__/asset-anchor.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});
});

describe("checkHappyPathOnlyTest — firstCaseLine tracking exactness", () => {
	it("reports the FIRST case's line, not the last, when multiple cases precede the finding", () => {
		const code = [
			"// header comment",
			'it("adds one", () => { expect(x()).toBe(1); });',
			'it("adds two", () => { expect(y()).toBe(2); });',
			'it("adds three", () => { expect(z()).toBe(3); });',
		].join("\n");
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
	});

	it("reports line 1 when the first case sits at the very start of the file (no leading newline)", () => {
		const code = [
			'it("adds one", () => { expect(x()).toBe(1); });',
			'it("adds two", () => { expect(y()).toBe(2); });',
			'it("adds three", () => { expect(z()).toBe(3); });',
		].join("\n");
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(1);
	});
});

describe("checkHappyPathOnlyTest — describe-name masking must not read a COMMENTED-OUT describe() as real", () => {
	it("does not clear the finding based on a describe() name that only appears inside a comment", () => {
		const code = [
			'// describe("handles errors", () => {});',
			'it("adds one", () => { expect(x()).toBe(1); });',
			'it("adds two", () => { expect(y()).toBe(2); });',
			'it("adds three", () => { expect(z()).toBe(3); });',
		].join("\n");
		const matches = checkHappyPathOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkHappyPathOnlyTest — NEGATIVE_ASSERTION_RE additional isolated boundary cases", () => {
	it("recognizes a bare .rejects with ZERO whitespace and no accompanying toThrow", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", async () => { await expect(p()).rejects; });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes .rejects with whitespace after the dot and no accompanying toThrow", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", async () => { await expect(p()) .  rejects; });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes toBeInstanceOf(Error) with ZERO whitespace (no backtrack-around room)", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", () => { expect(f()).toBeInstanceOf(TypeError); });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes instanceof with TWO spaces (distinguishes \\s+ from a single mandatory \\s)", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", () => { expect(f() instanceof  CustomFetchError).toBe(true); });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});

	it("recognizes catch{ with ZERO whitespace (no backtrack-around room for the inverted class)", () => {
		const code = [
			'it("sums alpha", () => { expect(x()).toBe(1); });',
			'it("sums beta", () => { expect(y()).toBe(2); });',
			'it("sums gamma", () => { try { f(); } catch{ g(); } });',
		].join("\n");
		expect(checkHappyPathOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkDuplicateTestNames — scanForOpenBraceSkippingStrings 'not found' sentinel", () => {
	it("still dedups two file-root it()s as ONE scope when a TRAILING describe's callback body never opens a brace", () => {
		// scanForOpenBraceSkippingStrings must return a sentinel that reads as
		// "not found" to its caller (open < 0). If the sentinel value were ever
		// a small POSITIVE number instead, its caller's `open < 0` guard would
		// stop skipping and would call findMatchingCloseBraceSkippingStrings
		// from that bogus low position — which, scanning forward from near the
		// START of the file, would walk into the FIRST real it() call's own
		// `{}` body and return ITS closing brace as a phantom describe body
		// end. That phantom range [sentinel, thatBrace] would swallow the
		// FIRST it("dup")'s offset (its own `{` sits past the sentinel) while
		// leaving the SECOND it("dup") at file-root scope — splitting one
		// genuine duplicate into two "different scope" entries and silently
		// dropping the finding. A one-line leading comment is required: it
		// pushes the first it()'s offset to sit just past a sentinel of "1",
		// which a bare offset of 0 would not.
		const code = [
			"// leading comment",
			'it("dup", () => {});',
			'it("dup", () => {});',
			'describe("no body", () => doThing());',
		].join("\n");
		const matches = checkDuplicateTestNames(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain('duplicate test name "dup"');
	});
});

describe("checkTestMissingSutImport — subprocess-exemption regex robustness", () => {
	it("recognizes a subprocess call with whitespace before its call paren", () => {
		const code = [
			'const { execSync } = require("child_process");',
			'it("runs the migration", () => {',
			'  execSync  ("node scripts/migrate2.mjs");',
			"});",
		].join("\n");
		const filePath = "src/scripts/__tests__/migrate2.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).toEqual([]);
	});

	it("does not exempt a file that spawns subprocesses but never names the SUT's own script file", () => {
		const code = [
			'const { execSync } = require("child_process");',
			'it("runs something unrelated", () => {',
			'  execSync("node scripts/unrelated.mjs");',
			"});",
		].join("\n");
		const filePath = "src/scripts/__tests__/migrate3.test.ts";
		expect(checkTestMissingSutImport(code, filePath)).not.toEqual([]);
	});
});
