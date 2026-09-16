// Survivor-kill tests for test-hygiene-quality-mock-only.ts — sibling to
// test-hygiene-quality-mock-only.test.ts. Targets mutants listed in
// scratch/fleet-r2/kill-briefs/src_harness_checks_test-hygiene-quality-mock-only.ts.json.
// Each test is designed so its assertion PASSES against the real detector
// and would FAIL under the specific mutant replacement(s) named in its
// comment. Verified empirically against shadow-mutated copies — see
// scratch/probes/mock-only-shadow-verify.mts.
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkMockOnlyTest } from "./test-hygiene-quality-mock-only.js";

const TEST = "src/lib/foo.test.ts";

// ==========================================================================
// classifyBlockExpects — zero-count exemption, negation, chain offsets
// ==========================================================================
describe("checkMockOnlyTest — zero-count matcher exemption vs literal-zero argument", () => {
	it("N: does not flag a sole toHaveBeenCalledTimes(0) — a real behavioral guarantee (zero calls)", () => {
		// Kills: matcherHasZeroInteractionCount BlockStatement->{} (48ba619),
		// its ConditionalExpression !has->true (89d0166/true), and the
		// classifyBlockExpects arithmetic mutants on matcherArgsStart
		// (4a8f1dad, 006ca550) — any of these makes the "0" argument check
		// fail to recognize the zero-count exemption, so the block would be
		// wrongly flagged.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(0);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: a sole toHaveBeenCalledWith(0) pins the argument 0 and is NOT mock-only (2026-09-16)", () => {
		// Pre-2026-09-16 this was a P: case guarding matcherHasZeroInteractionCount
		// against treating a zero ARGUMENT as a zero COUNT. That guard is still
		// exercised by the `toHaveBeenCalledWith()` case below: with an empty
		// argument list the matcher is a bare call check, and the zero-count
		// exemption must NOT apply to it either.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledWith(0);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("P: flags a sole toHaveBeenCalledWith() — empty arguments pin nothing, and it is not a zero-count matcher", () => {
		// Kills: matcherHasZeroInteractionCount BooleanLiteral (da0bd1e),
		// its ConditionalExpression !has->false (89d0166/false), and the
		// chain-search-offset arithmetic mutant (634c4e) — each would
		// wrongly grant a zero-count exemption to a non-count matcher.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledWith();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// matcherHasZeroInteractionCount — regex anchors/classes on the zero-count
// argument pattern (survivors from a residue pass, 2026-08-12). The prior
// zero-count tests above only ever pass a bare "0" or "3"/"9", which cannot
// distinguish an anchor/class removed from the surrounding padding.
// ==========================================================================
describe("checkMockOnlyTest — zero-count argument regex anchors/classes", () => {
	it("P: a multi-digit count ending in 0 is not a zero-count exemption", () => {
		// Kills: leading `^` anchor removed (mutantId 1417a23a5ef3e9d8) —
		// without it, the pattern can match "0" as a SUFFIX of "10" instead
		// of requiring the whole argument to start with it. Also kills the
		// leading class \s* -> \S* mutant (mutantId dabfc5f2b30a1d32): "10"
		// has no leading whitespace, so switching the leading class's
		// polarity has no bearing on this specific input, but the ^-anchor
		// failure alone already forces a match here under BOTH mutants.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(10);
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: trailing garbage after a zero is not a zero-count exemption", () => {
		// Kills: trailing `$` anchor removed (mutantId af81dd2b2c18461e) —
		// without it, the pattern accepts "0" as a PREFIX and ignores
		// trailing garbage. Also kills the trailing class \s* -> \S* mutant
		// (mutantId 8f0b3ffef12d242d): with no `$` to force full consumption
		// and a non-whitespace tail present, both mutants wrongly match.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(0garbage);
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("N: '0 as const' with standard single spacing on both sides of 'as' is a zero-count exemption", () => {
		// Kills two independent mutants that flip a `\s+` to `\S+` on
		// OPPOSITE sides of the literal "as": the mutant before "as"
		// (mutantId 1ac991daae654def) and the mutant after "as" (mutantId
		// e7fdaf7e52406a88). A single real space on both sides breaks BOTH
		// simultaneously, since each requires NON-whitespace at a position
		// that is actually a space.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(0 as const);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: '0  as const' (two spaces before 'as') is still a zero-count exemption", () => {
		// Kills: the `\s+` before "as" narrowed to exactly one whitespace
		// (`\s`, mutantId d95daea829bff4ea) — two real spaces satisfy the
		// real one-or-more quantifier but not the mutant's exactly-one form.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(0  as const);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: '0 as  const' (two spaces after 'as') is still a zero-count exemption", () => {
		// Kills: the `\s+` after "as" narrowed to exactly one whitespace
		// (`\s`, mutantId 57ca00edc1f0299e) — two real spaces satisfy the
		// real one-or-more quantifier but not the mutant's exactly-one form.
		const code = `it("case", () => {
			expect(fn).toHaveBeenCalledTimes(0 as  const);
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkMockOnlyTest — .not guard exemption", () => {
	it("N: does not flag a sole .not.toHaveBeenCalled() guard assertion", () => {
		// Kills: classifyBlockExpects ConditionalExpression on the not||zero
		// disjunction -> false (d6c9859), its LogicalOperator ||->&& (29a77e2),
		// and the StringLiteral "not"->"" (dcee135).
		const code = `it("case", () => {
			expect(fn).not.toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: does not flag a .not.toHaveBeenCalled() guard split across lines with whitespace around each dot", () => {
		// Kills: classifyBlockExpects.(anonymous) MethodExpression s.trim()->s
		// (208f861) — without trim, the split segments retain surrounding
		// whitespace/newlines so "not" no longer exact-matches, corrupting
		// the negation detection.
		const code = `it("case", () => {
			expect(fn)
				.not
				.toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkMockOnlyTest — multi-segment matcher chain recognition (MATCHER_CHAIN_RE)", () => {
	it("P: recognizes a 2-segment chain (.resolves.toHaveBeenCalled) as a positive call assertion", () => {
		// Kills: (module) Regex mutant removing the `+` repetition quantifier
		// (97b0dad -> exactly one `.ident` segment) — a 2-segment chain would
		// then fail to match at all.
		const code = `it("case", () => {
			expect(fn).resolves.toHaveBeenCalled();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: recognizes a chain with leading whitespace/newlines before each dot", () => {
		// Kills: (module) Regex mutant negating the before-dot class to \S*
		// (97b0dad) — real whitespace before a dot would then break the match.
		const code = `it("case", () => {
			expect(fn)
				.resolves
				.toHaveBeenCalled();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: recognizes a chain with whitespace after each dot and before the final call paren", () => {
		// Kills: (module) Regex mutants negating the after-dot-before-ident
		// class to \S* and the trailing before-paren class to \S* (97b0dad).
		const code = `it("case", () => {
			expect(fn). resolves. toHaveBeenCalled ();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// readCaseName
// ==========================================================================
describe("checkMockOnlyTest — case-name extraction (readCaseName)", () => {
	it("N: does not let an earlier comment's quoted text leak into the case name", () => {
		// Kills: readCaseName MethodExpression content.slice(...)->content
		// (cdd1f19) — without the slice, the regex searches the WHOLE file
		// content and finds the comment's quoted text first.
		const code = `// see "some other name" for details
test(() => {
	run();
	expect(log).toHaveBeenCalledOnce();
});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toBe(
			"test asserts only that mocks were called (toHaveBeenCalled / toHaveBeenCalledTimes / an empty …With()) — never WHAT they were called with, nor a return value, output, or state, so it passes even when the behavior is wrong. Pin the arguments (toHaveBeenCalledWith(...)) or assert an observable. A bare not.toHaveBeenCalled() is fine.",
		);
	});

	it("P: captures the full quoted text including its first and last characters", () => {
		// Kills all 4 readCaseName Regex mutants at site 909c1eef: negating
		// the opening-quote class, dropping the {0,80} quantifier to exactly
		// one char, negating the capture-group class, and negating the
		// closing-quote class — each corrupts or empties the captured name.
		//
		// Uses a single-arg (nameless) call whose CALLBACK contains the
		// quoted text, rather than the call's own name argument: readCaseName
		// slices `content` (unstripped) using offsets computed against
		// `stripped` (where quoted text is collapsed to a bare `""`), so for
		// a direct `it("name", ...)` argument the slice always undershoots
		// to exactly 2 characters and can never round-trip a real name —
		// confirmed empirically. With enough trailing content after the
		// quoted text to absorb that undershoot, the slice still contains it
		// intact, giving the regex something real to match.
		const code = `test(() => {
			run("hello world");
			expect(log).toHaveBeenCalledOnce();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain('test "hello world" asserts');
	});

	it("N: does not let a later unrelated string in the file leak into an anonymous case's name", () => {
		// Kills: checkMockOnlyTest LogicalOperator span.topLevelCommas[0] ??
		// span.end -> && (7663d2c) — for a single-arg (no-comma) call,
		// `undefined && span.end` yields `undefined`, and
		// `content.slice(argsStart, undefined)` slices to the END OF THE
		// WHOLE FILE instead of just this call, picking up a later string.
		const code = `test(() => {
	run();
	expect(log).toHaveBeenCalledOnce();
});

const irrelevant = "leaked name";
`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toBe(
			"test asserts only that mocks were called (toHaveBeenCalled / toHaveBeenCalledTimes / an empty …With()) — never WHAT they were called with, nor a return value, output, or state, so it passes even when the behavior is wrong. Pin the arguments (toHaveBeenCalledWith(...)) or assert an observable. A bare not.toHaveBeenCalled() is fine.",
		);
	});
});

// ==========================================================================
// escapeRegexLiteral (via hasImportedAssertHelperCall)
// ==========================================================================
describe("checkMockOnlyTest — helper-call regex escaping (escapeRegexLiteral)", () => {
	it("N: does not corrupt a plain-letter alias into a regex metaclass when escaping it", () => {
		// Kills: escapeRegexLiteral Regex mutant negating the special-char
		// class (e2977d8) — a plain letter like "d" would then get escaped
		// into "\d" (digit class), so a literal call to d(...) would no
		// longer be found by the constructed regex.
		const code = `
		import { ok as d } from "node:assert";

		it("case", () => {
			d(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: escapes a regex-special character in an alias instead of dropping it", () => {
		// Kills: escapeRegexLiteral StringLiteral "\\$&"->"" (9f01133) —
		// dropping instead of escaping the special char corrupts the
		// constructed regex so a call to d$(...) is no longer matched.
		const code = `
		import { ok as d$ } from "node:assert";

		it("case", () => {
			d$(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

// ==========================================================================
// collectImportedAssertHelpers — IMPORT regex family
// ==========================================================================
describe("checkMockOnlyTest — ESM import specifier parsing (collectImportedAssertHelpers)", () => {
	it("N: recognizes ok with extra whitespace after the import keyword", () => {
		// Kills: IMPORT regex quantifier removed after "import" (8b00029).
		const code = `
		import  { ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: recognizes ok alongside a default import, with no space before and extra space after the comma", () => {
		// Kills: IMPORT regex mutants on the optional default-import group —
		// negated first-char class, quantifier removed on rest chars,
		// negated rest-char class (both variants), before-comma exact-one
		// whitespace, and after-comma exact-one whitespace (8b00029, 6 of 11
		// sub-mutants at this site).
		const code = `
		import Foo,  { ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("P: does not recognize a helper when a malformed default-import segment (before the comma) breaks the whole import match", () => {
		// Kills: IMPORT regex before-comma class negated to \S* (8b00029) —
		// under the real regex this input fails to parse at all (correct);
		// the mutant greedily swallows the stray "!" and still matches.
		const code = `
		import Foo!, { ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: does not recognize a helper when a malformed segment right after the comma breaks the whole import match", () => {
		// Kills: IMPORT regex after-comma class negated to \S* (8b00029).
		const code = `
		import Foo,!{ ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("N: recognizes ok with extra whitespace before the from keyword", () => {
		// Kills: IMPORT regex exact-one whitespace before "from" (8b00029).
		const code = `
		import { ok }  from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: recognizes ok with extra whitespace after the from keyword", () => {
		// Kills: IMPORT regex exact-one whitespace after "from" (8b00029).
		const code = `
		import { ok } from  "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

// ==========================================================================
// collectImportedAssertHelpers — REQUIRE regex family
// ==========================================================================
describe("checkMockOnlyTest — CJS require specifier parsing (collectImportedAssertHelpers)", () => {
	it("N: recognizes ok imported via a standard require destructure", () => {
		// Kills: require-loop ConditionalExpression m!==null->false
		// (2c8369e) and NODE_ASSERT_MODULE_RE.test(...)->false (263f3b6)
		// scoped to the require branch, plus the require-regex capture-group
		// mutants (exactly-one-char braces content / quote class negated /
		// exactly-one-char module name / module-name class negated to quote
		// chars — 5 of 17 sub-mutants at site e2441dd).
		const code = `
		const { ok } = require("node:assert");

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: recognizes ok imported via require with extra whitespace at every gap", () => {
		// Kills the remaining 12 of 17 require-regex sub-mutants at site
		// e2441dd: exact-one-whitespace AND non-whitespace variants at each
		// of the 6 `\s*` gaps (before/after brace, before/after "=",
		// before/after "(", before the closing ")").
		const code = `
		const  { ok }  =  require  (  "node:assert"  );

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: recognizes a colon-aliased helper imported via require (cjs alias syntax)", () => {
		// Kills: addAssertSpecifiers mode==="esm" mutants (ebb0b6a/true,
		// ae4d7bba) — forcing the ESM ("as") regex onto a colon-aliased CJS
		// specifier makes it fail to parse.
		const code = `
		const { ok: myAlias } = require("node:assert");

		it("case", () => {
			myAlias(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

// ==========================================================================
// collectImportedAssertHelpers — REQUIRE (cjs) regex anchors/classes
// ==========================================================================
// The prior REQUIRE-family tests above only ever use a 2-char helper name
// ("ok"), which cannot distinguish several regex-shape mutants on the mode
// === "cjs" branch (survivors from a residue pass, 2026-08-12) — each needs
// a helper name whose length, leading, or trailing shape differs from "ok".
describe("checkMockOnlyTest — CJS require regex anchors/classes (mode==='cjs' branch)", () => {
	it("N: recognizes a require()'d helper name longer than 2 characters", () => {
		// Kills: mode==="cjs" regex Regex mutant dropping the `*` quantifier
		// on the first identifier char-class (group1 [\w$]* -> [\w$],
		// mutantId 5d46625d797db273) — that mutant only matches EXACTLY
		// 2-character identifiers (with or without a colon-alias suffix), so
		// every existing require() fixture using "ok" (2 chars) passes under
		// it by accident. "equal" (5 chars) fails to match at all under the
		// mutant, so the helper is never recognized and the block still fires.
		const code = `
		const { equal } = require("node:assert");

		it("case", () => {
			equal(1, 1);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("P: does not resolve a helper name found mid-specifier when a require() specifier is invalid at its start", () => {
		// Kills: mode==="cjs" regex Regex mutant with the leading `^` anchor
		// removed (mutantId f969eae9d77bc92a) — "1equal" is not a valid
		// identifier (starts with a digit) and the real regex must reject it
		// entirely; the unanchored mutant instead finds "equal" as a valid
		// substring match starting at index 1, wrongly recognizing it as the
		// real node:assert helper and exempting the block.
		const code = `
		const { 1equal } = require("node:assert");

		it("case", () => {
			equal(1, 1);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: does not resolve a helper name from a require() specifier with trailing garbage after it", () => {
		// Kills: mode==="cjs" regex Regex mutant with the trailing `$`
		// anchor removed (mutantId 0914ef2170e672b8) — "ok garbage" must
		// fail to parse entirely under the real regex; the mutant matches
		// just the "ok" prefix and wrongly exempts the block.
		const code = `
		const { ok garbage } = require("node:assert");

		it("case", () => {
			ok(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("N: recognizes a colon-aliased require() helper with zero spaces after the colon", () => {
		// Kills: mode==="cjs" regex Regex mutant requiring exactly one
		// whitespace after the colon instead of zero-or-more (\s* -> \s,
		// mutantId 8600feeb878ca4d5) — "ok:myAlias" (no space) matches the
		// real regex fine but fails entirely under the mutant, since the
		// character right after the colon is "m", not whitespace.
		const code = `
		const { ok:myAlias } = require("node:assert");

		it("case", () => {
			myAlias(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

// ==========================================================================
// addAssertSpecifiers — "type " prefix stripping
// ==========================================================================
describe("checkMockOnlyTest — TS type-only import specifier ('type ' prefix)", () => {
	it("N: strips a standard type-only import prefix (single space)", () => {
		// Kills: addAssertSpecifiers Regex mutant requiring NON-whitespace
		// after "type" (0d622dd -> \S+) — the standard single-space form
		// then fails to strip at all.
		const code = `
		import { type ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: strips a type-only import prefix that has extra internal whitespace", () => {
		// Kills: addAssertSpecifiers Regex mutant requiring exactly one
		// whitespace after "type" (0d622dd -> \s, no `+`) — a second space
		// is left attached to the identifier, breaking the parse.
		const code = `
		import { type  ok } from "node:assert";

		it("case", () => {
			ok(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("P: does not let an unanchored type-prefix match manufacture a helper name from unrelated text", () => {
		// Kills: addAssertSpecifiers Regex mutant with the leading `^`
		// anchor removed (0d622dd) — "etype qual" does not start with
		// "type", but the unanchored mutant strips the embedded "type "
		// substring anyway, accidentally producing the real helper name
		// "equal" from "e" + "qual". Also kills the StringLiteral mutant
		// replacing the empty replacement string with "Stryker was here!"
		// (5784dae), which corrupts the standard single-space case above.
		const code = `
		import { etype qual } from "node:assert";

		it("case", () => {
			equal(1, 1);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// addAssertSpecifiers — identifier / "as"-alias regex
// ==========================================================================
describe("checkMockOnlyTest — ESM specifier identifier parsing (addAssertSpecifiers)", () => {
	it("P: does not resolve a helper name found mid-string when the specifier is invalid at its start", () => {
		// Kills: identifier-regex Regex mutant with the leading `^` anchor
		// removed (8e5698e) — "1ok" is not a valid identifier (starts with a
		// digit) and should be skipped entirely; the unanchored mutant finds
		// "ok" as a substring match instead.
		const code = `
		import { 1ok } from "node:assert";

		it("case", () => {
			ok(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: does not resolve a helper name from a specifier with trailing garbage after it", () => {
		// Kills: identifier-regex Regex mutant with the trailing `$` anchor
		// removed (8e5698e) — "ok garbage" should fail to parse entirely;
		// the mutant matches just the "ok" prefix and ignores the rest.
		const code = `
		import { ok garbage } from "node:assert";

		it("case", () => {
			ok(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("N: recognizes an as-aliased esm helper and exempts a call to its local alias name", () => {
		// Kills: identifier-regex Regex mutants requiring non-whitespace
		// around "as" (both sides, 8e5698e), alias first-char negated,
		// alias rest-quantifier removed, and alias rest-class negated
		// (8e5698e) — 5 of 10 sub-mutants at this site. Also kills
		// addAssertSpecifiers mode==="esm"->false (ebb0b6a), mode!=="esm"
		// (ae4d7bba), and both "esm"->"" StringLiteral mutants (65a642b,
		// c064d33) — forcing the CJS (colon) regex onto this "as"-aliased
		// specifier makes it fail to parse.
		const code = `
		import { ok as myAlias } from "node:assert";

		it("case", () => {
			myAlias(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: recognizes an as-aliased esm helper with extra whitespace around the as keyword", () => {
		// Kills: identifier-regex Regex mutants requiring exactly one
		// whitespace before/after "as" (8e5698e) — a second space is left
		// unconsumed, breaking the parse.
		const code = `
		import { ok  as  myAlias2 } from "node:assert";

		it("case", () => {
			myAlias2(x);
			expect(fn).toHaveBeenCalled();
		});
		`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

// ==========================================================================
// NODE_ASSERT_MODULE_RE — exact-match anchors
// ==========================================================================
describe("checkMockOnlyTest — node:assert module-name matching is exact, not substring (NODE_ASSERT_MODULE_RE)", () => {
	it("P: does not treat a module merely ENDING in \"assert\" as node:assert", () => {
		// Kills: (module) Regex mutant with the leading `^` anchor removed
		// (e0bb639) — "my-assert" ends with "assert" and would incorrectly
		// match without the start anchor.
		const code = `
		import { ok } from "my-assert";

		it("case", () => {
			ok(true);
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});

	it("P: does not treat a module merely STARTING with \"assert\" as node:assert", () => {
		// Kills: (module) Regex mutant with the trailing `$` anchor removed
		// (e0bb639) — "assert-extra" starts with "assert" and would
		// incorrectly match without the end anchor.
		const code = `
		import { ok } from "assert-extra";

		it("case", () => {
			ok(true);
			expect(client.fetch).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// NODE_ASSERT_HELPERS membership
// ==========================================================================
describe("checkMockOnlyTest — an unrecognized node:assert import never exempts, even when called", () => {
	it("P: a call to an unrecognized node:assert import does not exempt the block", () => {
		// Kills: addAssertSpecifiers ConditionalExpression
		// NODE_ASSERT_HELPERS.has(imported)->true (80053dc) — the existing
		// suite's "unrecognized name" test never CALLS the unrecognized
		// name, so it can't observe this mutant; this one does.
		const code = `
		import { notAHelper } from "node:assert";

		it("case", () => {
			notAHelper(true);
			expect(fn).toHaveBeenCalled();
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

const REMAINING_NODE_ASSERT_HELPERS = [
	"deepEqual",
	"deepStrictEqual",
	"doesNotReject",
	"doesNotMatch",
	"equal",
	"doesNotThrow",
	"ifError",
	"fail",
	"match",
	"notDeepEqual",
	"notDeepStrictEqual",
	"notEqual",
	"notStrictEqual",
	"rejects",
	"strictEqual",
	"throws",
];

describe.each(REMAINING_NODE_ASSERT_HELPERS)(
	"checkMockOnlyTest — node:assert helper %s grants exemption when called (StringLiteral survivors)",
	(helperName) => {
		it(`N: a call to ${helperName}(...) alongside a mock-only assertion is exempt`, () => {
			// Kills the (module) StringLiteral mutant that empties this exact
			// NODE_ASSERT_HELPERS entry. "equal" additionally kills the
			// identifier-regex quantifier-removed mutant (8e5698e) since its
			// length (5) exceeds the mutant's fixed 2-char cap.
			const code = `
			import { ${helperName} } from "node:assert";

			it("case", () => {
				${helperName}(1, 1);
				expect(fn).toHaveBeenCalled();
			});
			`;
			expect(checkMockOnlyTest(code, TEST)).toEqual([]);
		});
	},
);

// ==========================================================================
// CALL_INTERACTION_MATCHERS membership (module-level StringLiteral survivors)
// ==========================================================================
const PLAIN_CALL_INTERACTION_MATCHERS = [
	"toHaveBeenCalledBefore",
	"toHaveBeenCalledAfter",
	"toBeCalled",
	"toHaveReturned",
	"toHaveReturnedWith",
	"toHaveLastReturnedWith",
	"toHaveNthReturnedWith",
	"toReturn",
	"toReturnWith",
	"lastReturnedWith",
	"nthReturnedWith",
	"toHaveResolved",
	"toHaveResolvedWith",
	"toHaveLastResolvedWith",
	"toHaveNthResolvedWith",
];

describe.each(PLAIN_CALL_INTERACTION_MATCHERS)(
	"checkMockOnlyTest — %s is recognized as a call-interaction matcher",
	(matcherName) => {
		it(`P: a sole ${matcherName}(...) assertion is flagged as mock-only`, () => {
			const code = `it("case", () => {
				expect(fn).${matcherName}(9);
			});`;
			const matches = checkMockOnlyTest(code, TEST);
			expect(matches.length).toBe(1);
		});
	},
);

// ==========================================================================
// ARGUMENT_PINNING_MATCHERS membership (2026-09-16): a CALL matcher whose
// non-empty arguments pin what the collaborator received is a value assertion
// (independent adjudication read 20/20 sampled toHaveBeenCalledWith hits as
// false positives). The EMPTY-argument form is still a bare call check.
// Nth variants need an argument beyond the index.
// ==========================================================================
const ARGUMENT_PINNING_CALL_MATCHERS: [string, string][] = [
	["toHaveBeenCalledWith", "9"],
	["toHaveBeenLastCalledWith", "9"],
	["toHaveBeenNthCalledWith", "1, 9"],
	["toHaveBeenCalledExactlyOnceWith", "9"],
	["toBeCalledWith", "9"],
	["lastCalledWith", "9"],
	["nthCalledWith", "1, 9"],
];

describe.each(ARGUMENT_PINNING_CALL_MATCHERS)(
	"checkMockOnlyTest — %s pins arguments",
	(matcherName, pinningArgs) => {
		it(`N: a sole ${matcherName}(${pinningArgs}) is NOT mock-only — the arguments are the contract`, () => {
			const code = `it("case", () => {
				expect(fn).${matcherName}(${pinningArgs});
			});`;
			expect(checkMockOnlyTest(code, TEST)).toEqual([]);
		});

		it(`P: a sole ${matcherName}() with an EMPTY argument list is still flagged`, () => {
			const code = `it("case", () => {
				expect(fn).${matcherName}();
			});`;
			expect(checkMockOnlyTest(code, TEST).length).toBe(1);
		});
	},
);

describe("checkMockOnlyTest — Nth pinning needs more than the index", () => {
	it("P: toHaveBeenNthCalledWith(1) alone is flagged; the index pins nothing", () => {
		const code = `it("case", () => {
			expect(fn).toHaveBeenNthCalledWith(1);
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});
	it("P: nthCalledWith(2) alone is flagged", () => {
		const code = `it("case", () => {
			expect(fn).nthCalledWith(2);
		});`;
		expect(checkMockOnlyTest(code, TEST).length).toBe(1);
	});
});

const TIMES_MATCHER_NAMES = [
	"toHaveBeenCalledTimes",
	"toBeCalledTimes",
	"toHaveReturnedTimes",
	"toReturnTimes",
	"toHaveResolvedTimes",
];

describe.each(TIMES_MATCHER_NAMES)(
	"checkMockOnlyTest — %s: recognized as call-interaction AND as zero-count exempt (two array memberships)",
	(matcherName) => {
		it(`P: a sole non-zero ${matcherName}(...) is flagged as mock-only`, () => {
			// Kills the CALL_INTERACTION_MATCHERS occurrence of this name.
			const code = `it("case", () => {
				expect(fn).${matcherName}(3);
			});`;
			const matches = checkMockOnlyTest(code, TEST);
			expect(matches.length).toBe(1);
		});

		it(`N: a sole ${matcherName}(0) is exempt (zero-count is a real guarantee)`, () => {
			// Kills the ZERO_INTERACTION_COUNT_MATCHERS occurrence of this
			// name, and the whole-array ArrayDeclaration mutant emptying
			// ZERO_INTERACTION_COUNT_MATCHERS (fa494b8).
			const code = `it("case", () => {
				expect(fn).${matcherName}(0);
			});`;
			expect(checkMockOnlyTest(code, TEST)).toEqual([]);
		});
	},
);

// ==========================================================================
// checkMockOnlyTest — file gate, match cap, body scoping, line numbers
// ==========================================================================
describe("checkMockOnlyTest — file-extension/directory gate", () => {
	it("N: never fires on a file outside test-file conventions, even with mock-only-shaped content", () => {
		// Kills: checkMockOnlyTest ConditionalExpression
		// !isStrictTestFile(filePath)->false (de0d7e2).
		const code = `it("x", () => { expect(fn).toHaveBeenCalled(); });`;
		expect(checkMockOnlyTest(code, "src/lib/foo.ts")).toEqual([]);
	});
});

describe("checkMockOnlyTest — MAX_MATCHES cap", () => {
	it("P: caps findings at exactly 12 mock-only blocks in a single file", () => {
		// Kills: checkMockOnlyTest ConditionalExpression
		// matches.length<MAX_MATCHES->true (6b2c0b4, would remove the cap
		// entirely, giving 15) and EqualityOperator <-><= (5fb57f7, would
		// allow one extra match, giving 13).
		const blocks = Array.from(
			{ length: 15 },
			(_, i) => `it("case${i}", () => { expect(fn${i}).toHaveBeenCalled(); });`,
		).join("\n");
		const matches = checkMockOnlyTest(blocks, TEST);
		expect(matches.length).toBe(12);
	});
});

describe("checkMockOnlyTest — each block's body is scoped to its own arguments", () => {
	it("N: a later block's real assertion does not leak into an earlier mock-only block's classification", () => {
		// Kills: checkMockOnlyTest MethodExpression
		// stripped.slice(argsStart, span.end)->stripped (7ee307d) — using
		// the whole file as "body" for every iteration would make each
		// block see every other block's assertions too.
		const code = `
		it("first case", () => {
			expect(fn).toHaveBeenCalled();
		});

		it("second case", () => {
			expect(result).toBe(5);
		});
		`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkMockOnlyTest — hasOtherAssertions: generic assert()/should exemptions", () => {
	it("N: a generic assert(...) call (no import needed) exempts the block", () => {
		// Kills: checkMockOnlyTest ConditionalExpression collapsing the
		// assert-word||should disjunction to false (e987c23), its
		// LogicalOperator ||->&& (8d935cc), and the assert-word Regex
		// mutants requiring exactly-one-whitespace and negating the
		// [(.] class (b1281cc, 2 of 3 sub-mutants — 0 actual spaces here).
		const code = `it("case", () => {
			assert(x === 1);
			expect(fn).toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: a generic assert (...) call with a space before the paren exempts the block", () => {
		// Kills: assert-word Regex mutant negated to \S* before [(.]
		// (b1281cc) — real whitespace there breaks the \S* variant.
		const code = `it("case", () => {
			assert (x === 1);
			expect(fn).toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: a chai-style x.should.equal(...) call exempts the block", () => {
		// Kills: .should Regex mutant requiring exactly-one-whitespace after
		// the dot (d2199a6 — 0 actual spaces here).
		const code = `it("case", () => {
			x.should.equal(1);
			expect(fn).toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});

	it("N: a chai-style x. should.equal(...) call with a space after the dot exempts the block", () => {
		// Kills: .should Regex mutant negated to \S* after the dot
		// (d2199a6) — real whitespace there breaks the \S* variant.
		const code = `it("case", () => {
			x. should.equal(1);
			expect(fn).toHaveBeenCalled();
		});`;
		expect(checkMockOnlyTest(code, TEST)).toEqual([]);
	});
});

describe("checkMockOnlyTest — anyPositiveCall requires only ONE positive call, not ALL of them", () => {
	it("P: flags the block when one of several call assertions is positive, even if another is negated", () => {
		// Kills: checkMockOnlyTest MethodExpression .some->.every
		// (e4e7a51) — with a mixed positive+negated pair, .some() (real)
		// is true while .every() (mutant) is false.
		const code = `it("case", () => {
			expect(a).toHaveBeenCalled();
			expect(b).not.toHaveBeenCalled();
		});`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
	});
});

describe("checkMockOnlyTest — reported line numbers", () => {
	it("P: reports the correct 1-based line number for a case declared past the first line, with trailing content", () => {
		// Kills: checkMockOnlyTest ConditionalExpression on the newline-count
		// fallback ->true/->false (b360efc, both give NaN via boolean.length),
		// the ArrayDeclaration fallback ["Stryker was here"] (682114f, would
		// add 1 to a genuinely-zero newline count elsewhere), the
		// MethodExpression scanning the whole stripped text instead of the
		// prefix before the match (94d2266, would count trailing newlines
		// too), and the ArithmeticOperator lineIdx+1->lineIdx-1 (66de83d).
		const code = `// header comment
// another comment
it("third line case", () => {
	expect(fn).toHaveBeenCalled();
});

// trailing comment
// more trailing content
`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(3);
	});

	it("P: reports line 1 for a case declared on the very first line (zero newlines before it)", () => {
		// Kills: (module) ArrayDeclaration []->["Stryker was here"]
		// (682114f) specifically for the zero-newlines case, and reconfirms
		// the ArithmeticOperator lineIdx+1->lineIdx-1 (66de83d) at the
		// boundary value lineIdx=0.
		const code = `it("first line case", () => { expect(fn).toHaveBeenCalled(); });`;
		const matches = checkMockOnlyTest(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(1);
	});
});
