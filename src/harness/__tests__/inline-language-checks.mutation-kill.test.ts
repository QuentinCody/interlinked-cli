// Mutation-kill hardening for src/harness/quality-checks/inline-language-checks.ts.
//
// Targets the surviving mutants recorded in
// scratch/fleet-r2/kill-briefs/src_harness_quality-checks_inline-language-checks.ts.json.
// Every non-equivalent survivor in that brief is empirically confirmed killed
// by literally applying the mutant's textual substitution to a shadow copy of
// the module and re-running these exact assertions against both the real and
// mutant module — see scratch/probes/inline-language-checks-mutation-kill.mts
// (126 cases: 98 kills matching JSON entries + 27 confirmed-equivalent
// (skipped) + 1 bonus sanity case, 0 unexpected). Each `it()` below names the
// site id(s) it kills so the mapping back to the kill-brief stays traceable.
//
// P/N convention: each `it()` title is prefixed with what it proves — "kills
// <site>" describes a positive assertion about real behavior that a specific
// mutant would falsify. Assertions favor EXACT text/length equality over
// substring checks wherever the mutant's damage could otherwise hide behind a
// coincidentally-similar output.
import { describe, expect, it } from "vitest";
import {
	__test__,
	runInlineLanguageChecks,
} from "../quality-checks/inline-language-checks.js";
import type { InlineCheckDef, LanguageProfile } from "../types.js";

const { stripPython, stripCStyle, headerHasGuard, C_INCLUDE_GUARD_SENTINEL } = __test__;

function buildProfile(id: string, inline_checks: InlineCheckDef[]): LanguageProfile {
	return {
		// SAFETY: tests deliberately construct profiles with ids outside the
		// real LanguageId union (including "python"/"c_cpp" cast through a
		// bare string, and an out-of-union id below) to reach
		// stripForLanguage's case-routing and exhaustiveness-default paths.
		id: id as unknown as LanguageProfile["id"],
		display_name: id,
		file_extensions: [],
		project_root_markers: [],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks,
	};
}

function makeDef(overrides: Partial<InlineCheckDef> & { pattern: string }): InlineCheckDef {
	return {
		name: "probe_check",
		description: "d",
		file_types: [".ts"],
		severity: "warning",
		fix_instruction: "n/a",
		...overrides,
	};
}

// ===========================================
// runInlineLanguageChecks
// ===========================================

describe("runInlineLanguageChecks — top-level guards", () => {
	it("kills fc3c8ee9b4da2795: short-circuits on an empty inline_checks array BEFORE touching the language id", () => {
		// buildContext() runs stripForLanguage(content, profile.id); if the
		// length===0 guard were skipped, an unrecognized/undefined language id
		// would hit stripForLanguage's exhaustiveness default (which returns the
		// id itself, not a string, if id isn't a string) and `.split("\n")`
		// would throw. Real code never reaches that path when inline_checks=[].
		// SAFETY: `undefined` is deliberately off-union to make stripForLanguage's
		// exhaustiveness default observable if the length===0 guard is bypassed.
		const profile = buildProfile(undefined as unknown as string, []);
		expect(() => runInlineLanguageChecks("/repo/src/m.foo", "content\n", profile)).not.toThrow();
		expect(runInlineLanguageChecks("/repo/src/m.foo", "content\n", profile)).toEqual([]);
	});

	// site b471e414263ab56a (!ctx -> false) is SKIPPED as equivalent:
	// buildContext() never returns null in the current implementation (always
	// returns a populated object or throws), so `!ctx` is always false already
	// — replacing it with the literal `false` is a no-op. Empirically confirmed
	// via scratch/probes/inline-language-checks-mutation-kill.mts
	// (case "ril-ctx-falsy-equivalent": assertion holds on both real and mutant).
});

// ===========================================
// runOneDef
// ===========================================

describe("runOneDef — early-return array identity (unfiltered length)", () => {
	// These four cases assert on the RAW (unfiltered) results array. A prior
	// test suite only ever filtered by `r.name === "..."`, which is blind to a
	// mutant that replaces `return []` with `return ["Stryker was here"]`: the
	// injected string has no `.name` property, so `.filter(r => r.name === x)`
	// silently drops it and the filtered length stays correct.

	it("kills 384279b9d145ccad: file_types mismatch returns exactly [] (no injected element)", () => {
		const profile = buildProfile("typescript", [makeDef({ pattern: "x", file_types: [".py"] })]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "x\n", profile);
		expect(results).toEqual([]);
	});

	it("kills a9b5aac131b1ebe5: skip_test_files on a test file returns exactly [] (no injected element)", () => {
		const profile = buildProfile("python", [
			makeDef({ pattern: "x", file_types: [".py"], skip_test_files: true }),
		]);
		const results = runInlineLanguageChecks("/repo/tests/m_test.py", "x\n", profile);
		expect(results).toEqual([]);
	});

	it("kills d351718b81c4e47f: c_include_guard with a guard present returns exactly [] (no injected element)", () => {
		const profile = buildProfile("c_cpp", [
			makeDef({ name: "c_include_guard", pattern: C_INCLUDE_GUARD_SENTINEL, file_types: [".h"] }),
		]);
		const results = runInlineLanguageChecks("/repo/src/math.h", "#pragma once\nint add(int a, int b);\n", profile);
		expect(results).toEqual([]);
	});

	it("kills 08a05991993ffa66: a malformed pattern returns exactly [] (no injected element)", () => {
		const profile = buildProfile("typescript", [makeDef({ pattern: "(unterminated" })]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "anything\n", profile);
		expect(results).toEqual([]);
	});
});

describe("runOneDef — c_include_guard missing-guard message (exact text)", () => {
	it("kills d7a0ca3b13fc5c78: the missing-guard message is the real non-empty template, not ''", () => {
		const profile = buildProfile("c_cpp", [
			makeDef({ name: "c_include_guard", pattern: C_INCLUDE_GUARD_SENTINEL, file_types: [".h"] }),
		]);
		const results = runInlineLanguageChecks("/repo/src/math.h", "int add(int a, int b);\n", profile);
		expect(results).toHaveLength(1);
		expect(results[0]?.message).toBe("math.h: missing include guard (#pragma once or #ifndef/#define)");
	});
});

describe("runOneDef — pattern_flags handling", () => {
	it("kills 5e6b981ed2321539: a custom pattern_flags value is HONORED, not silently replaced by the default", () => {
		// def.pattern_flags ?? "gm" -> def.pattern_flags && "gm" discards
		// whatever custom flags string was actually configured (as long as it's
		// truthy) and always substitutes the literal "gm" instead.
		const profile = buildProfile("typescript", [makeDef({ pattern: "hello", pattern_flags: "i" })]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "HELLO world\n", profile);
		expect(results).toHaveLength(1);
	});

	// site a1a0805690aecef6 ("gm" -> "") is SKIPPED as equivalent: the default
	// flags string is only used when pattern_flags is unset, and its "g"/"m"
	// characters never influence a match outcome in this architecture —
	// findLineMatches() strips "g" unconditionally before testing, and "m"
	// (multiline anchors) is inert because every tested string is a single
	// line with no embedded "\n" (guaranteed by `.split("\n")` upstream).
	// Empirically confirmed via the probe (case
	// "rod-patternflags-default-gm-equivalent": holds on both real and
	// mutant for an anchored `^...$` pattern).
});

describe("runOneDef — matched-line lookup and detail formatting (exact text)", () => {
	it("kills baca3b1844746ec6, c92bed04443dfb14, d9882697ad384ec0: detail embeds the exact matched line, not the next line or an empty/blank template", () => {
		// One exact `.toBe` on `detail` simultaneously pins: the lineNum-1
		// (not lineNum+1) raw-line index, the `?? ""` (not `&& ""`) fallback on
		// a truthy raw line, and the detail template itself (not "").
		const profile = buildProfile("typescript", [
			makeDef({ pattern: "MARKER", fix_instruction: "DO_THE_FIX", description: "d" }),
		]);
		const src = "line1\nline2 MARKER here\nline3\nline4\n";
		const results = runInlineLanguageChecks("/repo/src/m.ts", src, profile);
		expect(results).toHaveLength(1);
		expect(results[0]?.detail).toBe("  L2: line2 MARKER here\n  DO_THE_FIX");
	});

	it("kills d356af245bb88661: a non-exempt previous line does not over-suppress a real finding", () => {
		// prevLine && exemptRe.test(prevLine) -> prevLine || exemptRe.test(prevLine)
		// would suppress the finding whenever the PREVIOUS line is merely
		// non-empty, regardless of whether it actually matches the exemption.
		const profile = buildProfile("typescript", [
			makeDef({ pattern: "TARGET_TOKEN", exempt_if_line_matches: "EXEMPT_MARKER" }),
		]);
		const src = "some unrelated previous line\nTARGET_TOKEN here\n";
		const results = runInlineLanguageChecks("/repo/src/m.ts", src, profile);
		expect(results).toHaveLength(1);
	});

	it("kills 239bc98f4ded39ff: the embedded raw line is truncated to exactly 160 characters", () => {
		const profile = buildProfile("typescript", [makeDef({ pattern: "MARKER", fix_instruction: "FIX" })]);
		const longTail = "X".repeat(200);
		const src = `MARKER${longTail}\n`;
		const results = runInlineLanguageChecks("/repo/src/m.ts", src, profile);
		expect(results).toHaveLength(1);
		const detail = results[0]?.detail ?? "";
		const embedded = detail.split("\n")[0]?.slice("  L1: ".length) ?? "";
		expect(embedded).toHaveLength(160);
	});

	it("kills 0b48fed4fe2e0980: the embedded raw line is trimmed of leading/trailing whitespace", () => {
		const profile = buildProfile("typescript", [makeDef({ pattern: "MARKER", fix_instruction: "FIX" })]);
		const src = "line1\n   MARKER-padded   \nline3\n";
		const results = runInlineLanguageChecks("/repo/src/m.ts", src, profile);
		expect(results).toHaveLength(1);
		expect(results[0]?.detail).toBe("  L2: MARKER-padded\n  FIX");
	});
});

// ===========================================
// safeCompile / looksLikeReDoS
// ===========================================

describe("safeCompile / looksLikeReDoS — ReDoS guard", () => {
	it("kills b10291790a894233 and 036ae4a1b2c7fb58: a catastrophic-backtracking pattern is rejected before compiling", () => {
		// One test kills both: forcing safeCompile's `looksLikeReDoS(src)` check
		// to `false`, and emptying looksLikeReDoS's own body (implicit
		// `undefined`, also falsy), have the identical observable effect —
		// the guard never fires and the ReDoS pattern compiles and matches.
		const profile = buildProfile("typescript", [makeDef({ pattern: "(a+)+" })]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "aaaa\n", profile);
		expect(results).toEqual([]);
	});

	// site f582e07eae710be4 (safeCompile's `catch { return null; }` -> `catch
	// {}`) is SKIPPED as equivalent: the resulting `undefined` and the real
	// `null` are both falsy, and every consumer of safeCompile's result only
	// ever tests it with `!re` / `exemptRe &&` — never a strict `=== null`
	// comparison — so no observable difference reaches the public API.
	// Empirically confirmed via the probe (case
	// "sc-catch-block-null-vs-undefined-equivalent").
});

// ===========================================
// findLineMatches
// ===========================================

describe("findLineMatches — g-flag stripping", () => {
	// site 9e831f4a5528dd7e ("g" -> "" in `re.flags.replace("g", "")`) is
	// SKIPPED as equivalent: a FRESH RegExp is constructed on every loop
	// iteration (documented in the source: "Fresh regex per line so
	// `g`-flagged patterns don't carry lastIndex"), so a freshly-built global
	// regex's first `.test()` call behaves identically to a non-global one —
	// `lastIndex` state never carries across iterations either way. Empirically
	// confirmed via the probe (case "flm-g-flag-strip-noop-equivalent": two
	// separate matching lines both still match with the "g" left in flags).
	it("documents findLineMatches matches every line independently regardless of the g flag (equivalence witness)", () => {
		const profile = buildProfile("typescript", [makeDef({ pattern: "^hello$" })]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "hello\nhello\nworld\n", profile);
		expect(results).toHaveLength(2);
	});
});

// ===========================================
// headerHasGuard
// ===========================================

describe("headerHasGuard — #pragma once whitespace tolerance (exact regex boundaries)", () => {
	it("kills 901327ba434dfb33 (leading \\s*->\\S* and mid-gap \\s*->\\S*): an indented, spaced-out pragma is still recognized", () => {
		expect(headerHasGuard("  #  pragma once\nfoo();\n")).toBe(true);
	});

	it("kills 901327ba434dfb33 (\\s+->\\s before 'once'): multiple spaces before 'once' are still recognized", () => {
		expect(headerHasGuard("#pragma    once\nfoo();\n")).toBe(true);
	});
});

describe("headerHasGuard — #ifndef whitespace tolerance (exact regex boundaries)", () => {
	it("kills a017dfcf67e13cbc (leading \\s*->\\S* and mid-gap \\s*->\\S*): an indented, spaced-out ifndef is still recognized", () => {
		expect(headerHasGuard("  #  ifndef FOO_H\n#define FOO_H\n")).toBe(true);
	});

	it("kills a017dfcf67e13cbc (\\s+->\\s before the macro name): multiple spaces before the macro name are still recognized", () => {
		expect(headerHasGuard("#ifndef   FOO_H\n#define FOO_H\n")).toBe(true);
	});

	// site a017dfcf67e13cbc (\w+ -> \w on the macro-name tail) is SKIPPED as
	// equivalent: `.test()` only asks whether a match EXISTS, and both `\w+`
	// (>=1 word char) and `\w` (exactly 1 word char) have the identical
	// minimum requirement of one word character — so for any real ifndef
	// line (which always has >=1 word char in its macro name) both patterns
	// match identically; for a macro name with 0 word chars, both fail
	// identically. Empirically confirmed via the probe (case
	// "hhg-ifndef-macroname-plus-to-bare-equivalent").
});

// ===========================================
// blankEscapeSpan (exercised via stripPython)
// ===========================================

describe("blankEscapeSpan — escaped-newline line-count preservation", () => {
	it("kills 274c8499068a747a, a33ad9b39a8c0474 (both directions), bc746da3761cf286, 7ac5bc2513dceed8: an escaped newline inside a string stays a real newline", () => {
		// A backslash-continued newline inside a Python string must be blanked
		// to `\\\n` (preserving the newline byte), not to "  " or "" — any of
		// the listed mutants collapse the newline-preserving branch, which a
		// bare line-count check catches directly.
		const src = "s = 'a\\\nb'\nprint(1)\n";
		const stripped = stripPython(src);
		expect(stripped.split("\n")).toHaveLength(src.split("\n").length);
	});
});

describe("blankEscapeSpan — non-newline escape blanks to exactly two spaces", () => {
	it("kills a33ad9b39a8c0474 (true direction) and 8b9694eff9aff62d: an escaped non-newline char blanks to '  ', not the newline span or ''", () => {
		const src = 's = "a\\zb"\n';
		const stripped = stripPython(src);
		const expected = 's = "' + " " + "  " + " " + '"' + "\n";
		expect(stripped).toBe(expected);
	});
});

// ===========================================
// stripForLanguage
// ===========================================

describe("stripForLanguage — case-label routing", () => {
	it("kills aaf597eceacce745: python routes through stripPython, not a C-style fallthrough", () => {
		// Removing the python case's `return` would fall through the switch
		// all the way to `return stripCStyle(content)`. A C-style stripper
		// does not recognize `#` as a comment marker, so a MARKER hidden in a
		// `#` comment would leak through and produce a false-positive finding.
		const profile = buildProfile("python", [makeDef({ pattern: "MARKER", file_types: [".py"] })]);
		const src = "# MARKER inside a python comment\nreal_code()\n";
		const results = runInlineLanguageChecks("/repo/src/m.py", src, profile);
		expect(results).toEqual([]);
	});

	// Site-id map for the four case-label StringLiteral mutants below (each
	// language's own case label emptied to ""): opencl=fce52972c22c9b0b,
	// metal=41bdb38f960f9d3c, hlsl=09c5248c6683dea7, wgsl=beb821cc14edd30a.
	// One it.each iteration per language kills exactly that language's site,
	// since only ITS OWN case label going missing routes ITS content to the
	// exhaustiveness fallback — the other three languages' iterations still
	// pass unaffected by any one of these mutants.
	it.each(["opencl", "metal", "hlsl", "wgsl"] as const)(
		"kills the '%s' case-label removal: routes through stripCStyle, not the exhaustiveness fallback",
		(langId) => {
			// If the language's string literal were deleted from its case
			// label, stripForLanguage would fall to the exhaustiveness default,
			// which returns the LANGUAGE ID STRING ITSELF (not the stripped
			// content) — collapsing the whole multi-line file into one bogus
			// "line". A pattern that only matches on line 2 of real content
			// distinguishes this precisely.
			const profile = buildProfile(langId, [makeDef({ pattern: "TARGET_CALL", file_types: [".x"] })]);
			const src = "line_one();\nTARGET_CALL();\n";
			const results = runInlineLanguageChecks("/repo/src/k.x", src, profile);
			expect(results).toHaveLength(1);
			expect(results[0]?.message).toContain(":2 —");
		},
	);
});

// ===========================================
// pyStepLineMode
// ===========================================

describe("pyStepLineMode — comment-interior blanking (exact text)", () => {
	it("kills eef59b587ea26e5d and edb3de7527e530d4: every character inside a # comment blanks to a space, not to nothing", () => {
		const prefix = "x = 1  ";
		const comment = "# trailing comment";
		const src = `${prefix}${comment}\n`;
		const stripped = stripPython(src);
		const expected = `${prefix}${" ".repeat(comment.length)}\n`;
		expect(stripped).toBe(expected);
	});

	// sites deace81c916bdcfd ("code" -> "") and a254906496ed7af7
	// ({kind:"code"} -> {}) are SKIPPED as equivalent: stripPython's mode
	// dispatcher only ever checks `mode.kind === "line"` or `"string"`
	// explicitly; anything else (including an undefined/"" kind) falls to
	// its `else` branch, which is exactly the code-mode processor. So a
	// corrupted "code" transition behaves identically to a correct one.
	// Empirically confirmed via the probe (cases
	// "plm-code-transition-string-equivalent" and
	// "plm-code-transition-object-equivalent").
});

// ===========================================
// pyStepStringMode — branch A (triple-quote close)
// ===========================================

describe("pyStepStringMode — triple-quote closing (exact text + downstream flow)", () => {
	it('kills e1600db1ee57f43b (both directions), c7ef6fcbd398b901, c170edf624b0c284, 7f566a2d45003a3f, 59c3fa27da05bf9f, 137527a3ed29179d, 37b5dc5317813bd9, d4577f1a27d57fff, and cdcf1a8cc992f47d: a """-delimited string closes at the real delimiter and blanks it to exactly 3 spaces', () => {
		// One exact-match assertion on the FULL stripped output pins the
		// closing condition (both AND-operands and the whole conditional,
		// INCLUDING the `next3 === delim` sub-clause alone forced to `true`
		// at 7f566a2d45003a3f — that mutant closes the string on the very
		// first character after the opening delimiter instead of at the
		// real closing delimiter, corrupting everything downstream), the
		// crash-on-fire body mutants (which would throw), and the
		// close-text mutant ("   " -> "") in a single stroke: any wrong
		// closing point, any swallowed/duplicated content, or any missing
		// blank space changes this exact string.
		const src = 'x = """abc"""\nmore_code_here()\n';
		const stripped = stripPython(src);
		const expected = "x = " + '"""' + " ".repeat(3) + " ".repeat(3) + "\n" + "more_code_here()\n";
		expect(stripped).toBe(expected);
	});

	it("kills e1600db1ee57f43b/c7ef6fcbd398b901/c170edf624b0c284/59c3fa27da05bf9f/ec5a3206ca6c1884/c4cf7c09f2d14b70 for the '''-delimited variant too", () => {
		const src = "x = '''abc'''\nmore_code_here()\n";
		const stripped = stripPython(src);
		const expected = "x = " + "'''" + " ".repeat(3) + " ".repeat(3) + "\n" + "more_code_here()\n";
		expect(stripped).toBe(expected);
	});

	// sites 42cdfa22510f7f39 ({kind:"code"} -> {}) and 1f3490d3c28e8dd5
	// ("code" -> "") on branch A's own return, and f56e1fabcd9ae339
	// (`delim.length === 3` -> `true`), are SKIPPED as equivalent: the
	// "code" transitions fall to the same else-branch dispatch as above; the
	// length===3 check is a no-op because `next3` (always a real 3-char
	// slice) can never `===` a 1-char delim regardless of the length check,
	// so forcing that clause to `true` changes nothing for a real
	// (length-1 or length-3) delimiter. Empirically confirmed via the probe
	// (cases "psm-branchA-kind-code-object-equivalent",
	// "psm-branchA-kind-code-string-equivalent",
	// "psm-branchA-lenEq3-true-equivalent").
});

// ===========================================
// pyStepStringMode — branch B (single-char close)
// ===========================================

describe("pyStepStringMode — single/double-quote closing", () => {
	it("kills 0bbc8456bbeecec5, e5d67f5535431ede: a single-quoted string closes, so real code on the next line is preserved verbatim", () => {
		// Disabling branch B (directly, or via the inverted length check)
		// leaves the string open forever — everything after, including real
		// code on a later line, gets silently blanked as string content.
		const src = "x = 'hi'\nunwrap()\n";
		const stripped = stripPython(src);
		expect(stripped).toContain("unwrap()");
	});

	it("kills 602685520c02e7f9 (empty if-body falls through to branch D, string never closes)", () => {
		const src = "x = 'hi'\nunwrap()\n";
		const stripped = stripPython(src);
		expect(stripped).toContain("unwrap()");
	});

	it("kills 04e3267945811e22: the closing return isn't silently swapped for a garbage object that truncates the rest of the file", () => {
		// `{ text: nonNull(ch), consumed: 1, mode: {...} }` -> `{}` returns a
		// TRUTHY object (not undefined), so `step.consumed` becomes
		// `undefined`, `i += undefined` becomes NaN, and the while loop
		// silently stops — everything after the closing quote goes missing.
		const stripped = stripPython("s = 'hi'\nmore_code_here()\n");
		expect(stripped).toContain("more_code_here()");
	});

	// site 263c6c1b4bbd5b9f (`delim.length === 1` -> `true`) is SKIPPED as
	// equivalent: `ch` is always a single character, so `ch === delim` can
	// never be true when `delim` is a 3-char triple-quote delimiter
	// regardless of the length check — the same "structurally inert"
	// reasoning as branch A's analogous mutant. Empirically confirmed via
	// the probe (case "psm-branchB-lenEq1-true-equivalent").
	// sites 70befed8f665f433 / 5a633df9c0ebb9a1 ("code" transitions) are
	// SKIPPED as equivalent for the same else-fallback reason as above.
});

// ===========================================
// pyStepStringMode — branch C (escape sequence)
// ===========================================

describe("pyStepStringMode — escape-sequence detection prevents premature string closure", () => {
	it("kills 0a497956478f9d7f (true direction), 6b59096a025d909f, 7a372e8cfea66039: over-firing escape detection swallows the real closing quote", () => {
		// Forcing the escape branch to fire on ordinary (non-backslash)
		// characters consumes 2 chars at a time, which for an odd-length
		// string body lands the escape detector directly ON the closing
		// quote, treating it as an escape target instead of letting branch B
		// close the string.
		const src = "s = 'abc'\nunwrap()\n";
		const stripped = stripPython(src);
		expect(stripped).toContain("unwrap()");
	});

	it("kills 0a497956478f9d7f (false direction), 46b555b814840b83, 8d9c9174155ed353, 4e207a8409090b69: a real backslash-escaped quote does not prematurely close the string", () => {
		// Under-firing (or fully disabling) escape detection lets the escaped
		// quote be seen on its own by branch B, which incorrectly treats it
		// as the closing quote — leaking the rest of the "string" as literal
		// code.
		const src = 's = "a\\"unwrap()"\nreal_code_after()\n';
		const stripped = stripPython(src);
		expect(stripped).not.toContain("unwrap()");
		expect(stripped).toContain("real_code_after()");
	});

	it("kills e50edcb9d26af9e8: the escape branch's return isn't silently swapped for a garbage object that truncates the rest of the file", () => {
		const stripped = stripPython('s = "a\\zb"\nmore_code_here()\n');
		expect(stripped).toContain("more_code_here()");
	});

	it("kills 8a93fd98a1d391d1, f42d5aa35cffa701: mode stays 'string' (not silently dropped) after an escape sequence", () => {
		// If the post-escape mode's `kind` were corrupted away from "string",
		// the dispatcher would wrongly treat the NEXT character as code —
		// leaking hidden string content as literal text.
		const stripped = stripPython('s = "a\\zunwrap()b"\n');
		expect(stripped).not.toContain("unwrap()");
	});
});

// ===========================================
// pyStepStringMode — branch D (default, stays in string)
// ===========================================

describe("pyStepStringMode — ordinary string characters stay hidden", () => {
	it("kills 67b7e38e6efe603a: the default branch's return isn't silently swapped for a garbage object that truncates the rest of the file", () => {
		const stripped = stripPython('s = "unwrap()"\nmore_code_here()\n');
		expect(stripped).toContain("more_code_here()");
	});

	it("kills 2431783238c662d8, 6003672445e9a160: mode stays 'string' (not silently dropped) for an ordinary in-string character", () => {
		const stripped = stripPython('s = "unwrap()"\n');
		expect(stripped).not.toContain("wrap()");
	});
});

// ===========================================
// pyStepCodeMode
// ===========================================

describe("pyStepCodeMode — triple-quote-open detection", () => {
	it('kills d44d725ebc5825b9, af7beee70c9198be, b94aee1370307184, e6456dc05977af5f, 6d82bcba911b151c: a """ opener is recognized (not corrupted into 3 single-quote pairs)', () => {
		const src = 'x = """a"b"""\n';
		const stripped = stripPython(src);
		// If the opening """ isn't recognized as a triple-quote, it gets
		// reinterpreted as a bare single-quote open, and the lone interior
		// `"` closes that fake string early — leaking the trailing 'b'.
		expect(stripped).not.toContain("b");
	});

	it("kills fa0f7b93000076fb: opening a plain (non-triple) string doesn't silently truncate the rest of the file", () => {
		const stripped = stripPython('s = "z"\nmore_code_here()\n');
		expect(stripped).toContain("more_code_here()");
	});

	// sites a7ae88fb4fc61b19 / 904f25431f1ed78c (default branch's "code"
	// transition) are SKIPPED as equivalent for the same else-fallback
	// reason established above.
});

// ===========================================
// stripPython (own body)
// ===========================================

describe("stripPython — output-array seeding and offset arithmetic", () => {
	it("kills fe3ff9c68b4b7000: empty input strips to an empty string (the output array starts truly empty)", () => {
		expect(stripPython("")).toBe("");
	});

	it("kills 03b27fdf7b6bc180, aa6e6fe12c994a97: next3 is a real 3-char slice, not the whole tail or a forced-empty slice", () => {
		const stripped = stripPython('x = """a"b"""\n');
		expect(stripped).not.toContain("b");
	});

	it("kills a7d2f0f9a4560aa7: the escape lookahead char is content[i+1] (forward), not content[i-1] (backward)", () => {
		const src = "s = 'a\\\nb'\nprint(1)\n";
		const stripped = stripPython(src);
		expect(stripped.split("\n")).toHaveLength(src.split("\n").length);
	});

	it("kills a83956e8c9cc4b8f (both directions), 01014998699a7c3b (both directions): hasNext is exactly i+1<n, not forced or inverted", () => {
		// A trailing, unterminated backslash at the very end of content must
		// NOT be treated as having a next character — otherwise the escape
		// branch reads one character past the end and over-consumes,
		// growing the output by one character.
		const src = "s = 'a\\";
		const stripped = stripPython(src);
		expect(stripped).toHaveLength(src.length);
	});

	it("kills a83956e8c9cc4b8f (false direction), 01014998699a7c3b (>= direction): hasNext isn't forced/inverted to false in the MIDDLE of content either", () => {
		const src = 's = "a\\"unwrap()"\nreal_code_after()\n';
		const stripped = stripPython(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("kills fa07e76af2f8dab5: the i+1 inside the hasNext comparison is forward, not backward (i-1 is always < n)", () => {
		const src = "s = 'a\\";
		const stripped = stripPython(src);
		expect(stripped).toHaveLength(src.length);
	});

	// sites e17d28be7376ed13 ({kind:"code"} -> {}) and f91a8a25f7aae351
	// ("code" -> "") on the INITIAL mode value are SKIPPED as equivalent:
	// even as the starting state, an else-fallback dispatch treats any
	// non-"line"/non-"string" kind identically. Empirically confirmed via
	// the probe (cases "sp-initial-mode-kind-code-object-equivalent" and
	// "sp-initial-mode-kind-code-string-equivalent").
});

// ===========================================
// stepLineMode (C-style // comment interior)
// ===========================================

describe("stepLineMode — comment-interior blanking (exact text)", () => {
	it("kills 6d729abb03634cfd: every character inside a // comment blanks to a space, not to nothing", () => {
		const prefix = "let x = 1;  ";
		const comment = "// trailing comment";
		const src = `${prefix}${comment}\n`;
		const stripped = stripCStyle(src);
		const expected = `${prefix}${" ".repeat(comment.length)}\n`;
		expect(stripped).toBe(expected);
	});

	// sites cb54156abb4dd8df / e7aa7c9f37a3c212 ("code" transition) are
	// SKIPPED as equivalent for the same else-fallback reason.
});

// ===========================================
// stepBlockMode (C-style /* */ block comments)
// ===========================================

describe("stepBlockMode — block-comment closing (exact text)", () => {
	it('kills 9e0733d8dcd62224 (both directions), 3423eaf21a6724f4, 91d2db147928ae33, 98d76c421ab80095: */ only closes at a real "*" immediately followed by "/", blanked to exactly 2 spaces', () => {
		// An internal "/" that isn't part of the real closing sequence must
		// not trigger an early close.
		const src = "/* a/b */\nreal_code();\n";
		const stripped = stripCStyle(src);
		const expected = "  " + " ".repeat(5) + "  " + "\n" + "real_code();\n";
		expect(stripped).toBe(expected);
	});

	it('kills d81ad7008383944d, 17a655c7e89bfc6a, 1032402571874d18, 52b563ad897cd498: an internal "*" that is NOT immediately followed by "/" does not trigger an early close', () => {
		const src = "/* a*b */\nreal_code();\n";
		const stripped = stripCStyle(src);
		const expected = "  " + " ".repeat(5) + "  " + "\n" + "real_code();\n";
		expect(stripped).toBe(expected);
	});

	it("kills b2ffe9ef9fa6e29f: ch===\"*\" alone (ignoring next) is not enough to close — needs a real internal-/ probe too", () => {
		// b2ffe9ef9fa6e29f collapses the close condition to just `next==="/"`
		// (any char immediately before a "/" wrongly closes); the a/b content
		// above exercises exactly that position.
		const src = "/* a/b */\nreal_code();\n";
		const stripped = stripCStyle(src);
		const expected = "  " + " ".repeat(5) + "  " + "\n" + "real_code();\n";
		expect(stripped).toBe(expected);
	});

	// sites deb131bb3bac926f / adbe0fddeb59eab8 ("code" transition) are
	// SKIPPED as equivalent for the same else-fallback reason.
});

// ===========================================
// stepStringMode (C-style string escape)
// ===========================================

describe("stepStringMode — escape handling doesn't silently truncate", () => {
	it("kills 01d87216133b3c31: the escape branch's return isn't silently swapped for a garbage object that truncates the rest of the file", () => {
		const stripped = stripCStyle('let x = "a\\zb";\nreal_code_after();\n');
		expect(stripped).toContain("real_code_after();");
	});

	// sites 6d6d6d8a5e9f143c / 519940cee662606a (close-branch "code"
	// transition) are SKIPPED as equivalent for the same else-fallback
	// reason.
});

// ===========================================
// stepCodeMode (C-style code dispatch)
// ===========================================

describe("stepCodeMode — // and /* opener detection (exact conditions + text)", () => {
	it("kills 5cd47e2475001078 and 048d19ca9f5dbc01: a lone division-like slash is not mistaken for a comment opener", () => {
		const src = "a / b\nreal();\n";
		const stripped = stripCStyle(src);
		expect(stripped).toBe(src);
	});

	it("kills 017c6f1237fa9181: ANY character immediately before a slash is not mistaken for a // opener (ch==='/' check is load-bearing)", () => {
		const src = "x = 5/2;\nreal();\n";
		const stripped = stripCStyle(src);
		expect(stripped).toBe(src);
	});

	it("kills 517dca31236eb4e5: the // opener blanks to exactly two spaces", () => {
		const src = "//c\nreal();\n";
		const stripped = stripCStyle(src);
		const expected = "  " + " " + "\n" + "real();\n";
		expect(stripped).toBe(expected);
	});

	it("kills 809f928fc5e09df7: the /* opener blanks to exactly two spaces", () => {
		const src = "/*c*/\nreal();\n";
		const stripped = stripCStyle(src);
		const expected = "  " + " " + "  " + "\n" + "real();\n";
		expect(stripped).toBe(expected);
	});

	// sites 20ddc7b4da8af5ea / 9cb8e6308329f61d (default branch's "code"
	// transition) are SKIPPED as equivalent for the same else-fallback
	// reason.
});

// ===========================================
// stripCStyle (own body)
// ===========================================

describe("stripCStyle — hasNext boundary arithmetic", () => {
	it("kills 4b77fd181db1ecb6, 721b00c2a683a892, 3f03825e175a020c: hasNext is exactly i+1<n at end-of-content, not forced/off-by-one/backward", () => {
		// A trailing, unterminated backslash at the very end of a C-style
		// string must not be treated as having a next character, mirroring
		// the analogous stripPython invariant.
		const src = 'x = "a\\';
		const stripped = stripCStyle(src);
		expect(stripped).toHaveLength(src.length);
	});

	// sites f3925164e9525daa ({kind:"code"} -> {}) and 3bfc081d6d38b5bb
	// ("code" -> "") on the INITIAL mode value are SKIPPED as equivalent for
	// the same else-fallback reason as stripPython's analogous mutants.
});
