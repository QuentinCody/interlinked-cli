import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkMockOnlyTest, classifyBlockExpects } from "./test-hygiene-quality-mock-only.js";

const TEST = "src/lib/foo.test.ts";

describe("checkMockOnlyTest — expect() shapes without a resolvable matcher chain", () => {
	it("does not fire when the only expect() has no matcher chain at all (bare expect)", () => {
		// Exercises the `chain === null` branch in classifyBlockExpects: an
		// `expect(x)` immediately followed by something other than
		// `.matcher(...)` classifies as a non-call assertion, so the block is
		// conservatively NOT flagged mock-only.
		const code = `it("checks something oddly", () => {
			const x = compute();
			expect(x);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("still flags the block mock-only when a bare expect() sits alongside a real call-interaction assertion", () => {
		// The bare `expect(x)` classifies as a non-call assertion (isCallInteraction:
		// false), so `everyCall` (every assertion is a call interaction) is false —
		// the mixed block must NOT fire, proving the bare expect is genuinely
		// counted rather than silently ignored.
		const code = `it("mixes a bare expect with a call assertion", () => {
			expect(value);
			expect(client.fetch).toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkMockOnlyTest — anonymous single-argument test blocks", () => {
	it("flags a mock-only test() call with no name argument (single-arg form)", () => {
		// `test(() => {...})` has exactly one top-level argument, so
		// `span.topLevelCommas[0]` is undefined and `readCaseName` finds no
		// quoted string literal in its slice — exercises the `?? span.end`
		// fallback and the false side of the nameMatch ternary together.
		const code = `test(() => {
			run();
			expect(log).toHaveBeenCalledOnce();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toBe(
			"test asserts only mock interactions (toHaveBeenCalled / toHaveReturned) — it checks that a collaborator was called, not that the code produced a correct value, output, or state, so it passes even when the behavior is wrong. Assert a return value, rendered output, or observable state. A bare not.toHaveBeenCalled() is fine; a positive call-only assertion is not.",
		);
	});
});

describe("checkMockOnlyTest — malformed / unclosed it()/test() calls", () => {
	it("does not fire and does not throw when a trailing it() call is never closed", () => {
		// The unclosed call has no matching close bracket anywhere in the
		// remaining text, so findCallSpan returns null at the TOP level (not the
		// nested classifyBlockExpects level) — the main loop must skip it via
		// `continue` rather than throwing or looping forever.
		const code = `it("this block never closes", () => {
			expect(client.fetch).toHaveBeenCalled();
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkMockOnlyTest — assert-helper import/require recognition", () => {
	it("does NOT grant exemption for a destructured import from a non-assert module", () => {
		// Exercises the false side of `NODE_ASSERT_MODULE_RE.test(...)` for the
		// import branch: a same-named helper imported from an unrelated module
		// must not be treated as a node:assert helper, so the block still fires.
		const code = `
		import { ok } from "some-other-module";

		it("uses a same-named helper from the wrong module", () => {
			ok(true);
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does NOT grant exemption for a destructured require from a non-assert module", () => {
		// Same false-side branch for the require variant.
		const code = `
		const { ok } = require("some-other-module");

		it("uses a same-named helper from the wrong module via require", () => {
			ok(true);
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("skips an empty specifier from a trailing comma in the import list", () => {
		// `{ ok, }` splits into ["ok", ""] — the empty second segment exercises
		// `part.length === 0 → continue`, and `ok` still resolves normally so
		// the exemption still applies for the properly-named helper.
		const code = `
		import { ok, } from "node:assert";

		it("returns the parsed result", () => {
			const out = run();
			expect(client.fetch).toHaveBeenCalledWith("/users");
			ok(out.status === 200);
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("skips a specifier that is not a valid identifier", () => {
		// "123abc" fails both the esm and cjs specifier regexes, so `parsed` is
		// null and the specifier is skipped without adding anything to helpers —
		// the block still fires because no real assert helper was recognized.
		const code = `
		import { 123abc } from "node:assert";

		it("has a malformed specifier", () => {
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does not add a specifier that is not a recognized node:assert helper", () => {
		// "notAHelper" is a syntactically valid specifier from "node:assert" but
		// is absent from NODE_ASSERT_HELPERS — exercises the false side of the
		// `NODE_ASSERT_HELPERS.has(imported)` check, so it is never added to the
		// helpers set and the block still fires as mock-only.
		const code = `
		import { notAHelper } from "node:assert";

		it("imports an unrecognized name from node:assert", () => {
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("does not treat an imported helper as used when the body never calls it", () => {
		// `ok` is a real, recognized node:assert helper (added to the helpers
		// set), but the test body never calls it — exercises the false side of
		// hasImportedAssertHelperCall's per-helper regex test, falling through
		// the loop to `return false`, so the block still fires as mock-only.
		const code = `
		import { ok } from "node:assert";

		it("imports ok but never calls it", () => {
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkMockOnlyTest — file extension gate", () => {
	it("does not fire on a strict-test-directory file with a non-JS/TS extension", () => {
		// Directory-based isStrictTestFile match ("/__tests__/") is extension-
		// agnostic, so a `.py` file inside `__tests__/` reaches the JS_TS_EXTS
		// check and is rejected there — the true side of `!JS_TS_EXTS.has(...)`.
		const code = `it("would be mock-only in JS", () => { expect(x).toHaveBeenCalled(); });`;
		expect(checkMockOnlyTest(code, "src/__tests__/foo.py")).toEqual([]);
	});
});

describe("classifyBlockExpects — an expect(...) call whose own parens never close", () => {
	it("reports a non-call classification when the call span cannot balance", () => {
		// This is reachable only by calling classifyBlockExpects directly, not
		// through checkMockOnlyTest: the outer it()/test() call and the inner
		// expect() call share the same undifferentiated bracket-depth counter
		// (findCallSpan counts `(`/`{`/`[` and `)`/`}`/`]` alike, with no type
		// matching), so whenever the OUTER it() span successfully balances back
		// to zero, every inner open it contains must ALSO have balanced by
		// that point — an unclosed expect() can only exist in a `body` slice
		// that was never itself produced by a successful outer call span.
		// A mutant that dropped the `break` (continuing to scan past a null
		// span) or replaced NON_CALL_EXPECT with a call-interaction classifier
		// here would change this return value.
		const out = classifyBlockExpects("expect(mockFn");
		expect(out).toEqual([{ isCallInteraction: false, negated: false }]);
	});
});
