// Mutation-kill tests for placeholder-constants.ts (pass-1 fleet campaign,
// scratch/fleet-r3/CONTRACT-W6.md LEAN MODE). Every case targets one or more
// specific surviving mutantIds from `mutation survivors --file
// src/harness/checks/placeholder-constants.ts --json` (generation 1639).
// checkPlaceholderRuntimeConstant is the ONLY exported symbol, so every kill
// is a black-box construction: a source string whose parsed result differs
// between pristine and the specific mutant. Long rationale lives in a block
// comment above each case; the single `// test-contract:` line immediately
// above `it(` is the required grounding receipt.

import { describe, expect, it } from "vitest";
import { checkPlaceholderRuntimeConstant } from "./placeholder-constants.js";

function run(src: string, path = "src/config.ts") {
	return checkPlaceholderRuntimeConstant(src, path);
}

// ─── (module) — CONFESSION_RE sub-mutations ───────────────────────────────────
// The regex has one redundant branch: the hardcod(...)for...now branch always
// entails the standalone `for\s+now` alt matching the same trailing text, so
// several Regex survivors there are provably unobservable (see receipts).

describe("checkPlaceholderRuntimeConstant — (module) CONFESSION_RE", () => {
	// test-contract: invariant — the standalone for\s+now alt tolerates multi-space runs, not exactly 1 char
	it("kills c85446c0a3ab679a: standalone for\\s+now requires 1+ ws, not exactly 1", () => {
		const src = "const A = 1; // for  now";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — the until-branch's leading whitespace tolerates multi-space runs, not exactly 1 char
	it("kills e6bff555b80abf6b: until\\s+ requires 1+ ws before the we/the/phase/[A-Z] group", () => {
		const src = "const A = 1; // until  we ship it";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — the bare-uppercase-letter alt requires an actual A-Z char, not any non-uppercase char
	it("kills a7c4256958e88e00: until <UPPER> only fires on an uppercase letter", () => {
		const src = "const A = 1; // review until Q ships";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — "to be replaced" tolerates multi-space between "to" and "be"
	it("kills 56697ad004c42b52: to\\s+be requires 1+ ws between to/be", () => {
		const src = "const A = 1; // to  be replaced";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — "to be replaced" tolerates multi-space between "be" and the replaced/threaded/wired/computed group
	it("kills b53abc3ab28ca093: be\\s+(replaced|...) requires 1+ ws between be/verb", () => {
		const src = "const A = 1; // to be  replaced";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — "nonzero stub/stand" tolerates multi-space between "nonzero" and the stub/stand group
	it("kills 8522011bd3a8b67a: nonzero\\s+(stub|stand) requires 1+ ws", () => {
		const src = "const A = 1; // nonzero  stub";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: boundary — a word char glued between "hardcoded" and "for" must not confess (no ws for the hardcod branch, no word boundary for the standalone for\s+now alt)
	it("kills 542c4ceb71ce2ddb: the hardcod-branch's prefix gap requires real whitespace, not \\S+", () => {
		const src = "const A = 1; // hardcodedXfor now";
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: boundary — a word char glued between "for" and "now" inside the hardcod branch must not confess
	it("kills 5e86bbfa26a6cf1b: the hardcod-branch's for/now gap requires real whitespace, not \\S+", () => {
		const src = "const A = 1; // hardcoded forXnow";
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: security — a confession-shaped substring inside a Rust double-quoted string must never be read as a real comment
	it("kills 3170ac674b286da5: Rust string-quote char must not become an empty set", () => {
		const src = ['let s: &str = "// temporary for now";', "pub const CACHE_SIZE: usize = 64;"].join(
			"\n",
		);
		expect(run(src, "src/config.rs")).toHaveLength(0);
	});
});

// The remaining 4 Regex survivors and 1 StringLiteral survivor in (module)
// are provably equivalent — see receipts.

// ─── analyzeLines ───────────────────────────────────────────────────────────
// Both survivors here (0d8f8975a4a5c779, 93d3df16c406716f) are provably
// equivalent — see receipts.

// ─── blankRange ─────────────────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — blankRange", () => {
	// test-contract: invariant — blankRange must not blank the character AT its exclusive upper bound
	it("kills f2b29a4c89e5c659: blankRange must not blank the char AT its upper bound", () => {
		const src = "/* temporary for now */const LIMIT = 3;";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("LIMIT");
	});

	// test-contract: invariant — blanking must overwrite each char with a space, preserving token separation, not delete it
	it("kills c4063f869b4bf294: blankRange must overwrite with a space, not delete", () => {
		const src = "const/* temporary for now */LIMIT = 3;";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

// ─── consumeBlockComment ────────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — consumeBlockComment", () => {
	// test-contract: boundary — "/*/" is not self-closing; the closer must be searched for strictly after the 2-char opener
	it("kills 5bf4865f17723d54: a fresh block-comment open must search for its closer AFTER the opener, not before it", () => {
		const src = "/*/ confession until we ship */const LIMIT = 3;";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("LIMIT");
	});

	// test-contract: security — code preceding an unterminated block-comment opener on the same line must never leak into the captured comment text
	it("kills f33df2d116dfade9: an unterminated block comment must only capture from its opener onward, not the whole raw line", () => {
		const src = ["const standIn = 5; /*", "*/", "const REAL = 3;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: invariant — the captured same-line block-comment text must extend through its full closing "*/", not truncate early
	it("kills 45b19a0128bc8733: the captured comment slice must include the full closer, not stop 4 chars early", () => {
		const src = "/*this really is just for now*/const LIMIT = 3;";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("LIMIT");
	});

	// test-contract: invariant — scanning must resume exactly after a closed same-line block comment's "*/", not from inside it
	it("kills 11973ab80d783ae2: scanning must resume exactly after the closer, not 4 chars inside it", () => {
		const src = '/*for now"Z*/const LIMIT = 3;';
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("LIMIT");
	});
});

// ─── consumeStringLiteral ───────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — consumeStringLiteral", () => {
	// test-contract: invariant — a properly closed same-line string must expose its trailing comment. Also kills bfd2e4836f8dbc73, 3e70a8729655ff83, 851a7794cc168d1f, 731b760a353a908f, 96bd72381a686f9a, 2948e05cbca142fc: each prevents finding the same real closing quote.
	it("kills 791846e94bc2b612: a terminated string must actually scan for its closer, not always fall through as unterminated", () => {
		const src = ['const s = "abc"; // temporary for now', "const LIMIT = 5;"].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: boundary — the string scan must step forward through the body to resolve the line at all
	it("kills 0801e627262e3082: the string scan must advance forward, not backward", () => {
		const src = ['const s = "ab";', "const LIMIT = 5; // temporary for now"].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — the escape-skip must key off an actual backslash character, not any non-backslash char
	it("kills 05a0f24daf9938a9: only a real backslash should trigger the escape skip", () => {
		const src = ["const s = `a`;", "const LIMIT = 5; // temporary for now"].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: security — an escaped quote inside a string must stay part of the string, not close it early and expose trailing text as code. Also kills 179d80bb00a52a0e and 15d3d0c6fedb76a7 (both disable the escape-skip the same observable way).
	it("kills 8643d73f9d7a175b, 179d80bb00a52a0e, 15d3d0c6fedb76a7: the escape-skip must recognize the real backslash and actually skip 2 chars", () => {
		const src = ['const x = "a\\" //temporary for now', "const LIMIT = 5;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: invariant — the successful-close blank must start right after the opening delimiter, not one char before it (which would blank a required ":" out of a type-annotation-shaped value)
	it("kills a73104b52fc6a861: the interior blank on a found closer must start at start+1, not start-1", () => {
		const src = 'const x:"T"=5; // temporary for now';
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: invariant — the unterminated-string fallback blank must start right after the opening delimiter, not one char before it (which would blank an unrelated code character before the string, wrongly making the whole line transparent)
	it("kills d7f2a592f1289ebe: the unterminated-string fallback blank must start at start+1, not start-1", () => {
		const src = ['// temporary for now', 'X"unterminated with no close', "const LIMIT = 3;"].join(
			"\n",
		);
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: invariant — the closing-quote check must compare the CURRENT char, not always report a match; forcing it true closes the string after just 1 interior char, letting an embedded "=" leak out of the type-annotation catch-all and break the declaration match. Also kills c01372bf244f27f5 (the inverted-equality variant closes at the same too-early position for the same input).
	it("kills 96a71017f34b107a, c01372bf244f27f5: the closing-quote check must require an exact match, not close on any/every char", () => {
		const src = 'const x:"a=b"=5; // temporary for now';
		const found = run(src);
		expect(found).toHaveLength(1);
	});

	// test-contract: invariant — on a found closer, the scan must resume right after it (j+1), not one char before it (which re-triggers the same quote as a fresh opener and swallows the real "=NUM;" tail into a second bogus string)
	it("kills a6bedd0702b37a4e: the resume position after a found closer must be j+1, not j-1", () => {
		const src = 'const x:"T"=5; // temporary for now';
		expect(run(src)).toHaveLength(1);
	});
});

// ─── findCommentStartPython ─────────────────────────────────────────────────
// fba451d4289747d8 (the i<line.length off-by-one) is provably equivalent — see
// receipts: the extra i===line.length iteration reads charAt(line.length)==="",
// and "".includes("") short-circuits PY_QUOTE_CHARS.includes("") to true, but
// the function is already returning -1 regardless — the phantom quote
// assignment is never read again.

describe("checkPlaceholderRuntimeConstant — findCommentStartPython", () => {
	// test-contract: invariant — inside a quote, only a real backslash should trigger the 1-char escape skip. Also kills 6b4d7a1f38c046f1 (inverted equality treats the same non-backslash char as an escape too).
	it("kills 776069334c1bbe1e, 6b4d7a1f38c046f1: only a real backslash skips the next char inside a Python string", () => {
		const src = ["MSG = 'y' # temporary for now", "LIMIT = 3"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — a backslash-escaped quote inside a Python string must not close the string early. Also kills 145fb81619e9aa3c (empty-string-literal variant disables the same escape check).
	it("kills 9fe25c82baee771c, 145fb81619e9aa3c: the escape check must actually recognize a backslash", () => {
		const src = ["MSG = 'a\\'b' # temporary for now", "LIMIT = 3"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — a quote only closes on its matching quote char; forcing an early close directly before a "#" with no separator lets the reopen-then-reclose dance swallow the "#" itself. Also kills 2edbb1676721a18e (inverted equality closes on the same non-quote chars).
	it("kills bacc6c05cf75486a, 2edbb1676721a18e: a Python string only closes on its actual matching quote", () => {
		const src = ["MSG = 'ab'#temporary for now", "LIMIT = 3"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — the matching quote character must be able to close the string; forcing it never-close swallows a trailing "#" comment marker into a permanently open quote
	it("kills e09515caf540227c: a Python string must be able to close, not stay open forever", () => {
		const src = ["MSG = 'ab' # temporary for now", "LIMIT = 3"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

// ─── findPythonDeclarationLines ─────────────────────────────────────────────
// Both survivors (a396eaeb66453e49 — the ArrayDeclaration `out=[]` sentinel,
// same shape as analyzeLines' declLines equivalent above; 67261bec036ea839 —
// the i<=length off-by-one, whose phantom "" line matches no PY_DECL_RE and
// leaves openDelim/out untouched) are provably equivalent — see receipts.

// ─── infoConfesses ───────────────────────────────────────────────────────────
// All 4 survivors (0765d488211b9525, 916eda92d54d83fb, ad8707d37f0eb751,
// c2046a78dd2681d8) are provably equivalent — see receipts. `info` is never
// actually undefined at either call site (the one caller already guards it),
// and CONFESSION_RE.test(null) / .test(undefined) both coerce to the strings
// "null" / "undefined", neither of which contains any confession word — so
// skipping the null-guard changes zero outcomes.

// ─── pythonLineInfo ──────────────────────────────────────────────────────────
// 0bb7327188b8591a ({comment:null,transparent:false} -> {}) is provably
// equivalent — see receipts: reading .comment/.transparent off `{}` yields
// undefined, and undefined behaves identically to null/false at every
// downstream check (CONFESSION_RE.test(undefined) coerces to "undefined",
// which never matches; !undefined === !false === true).

describe("checkPlaceholderRuntimeConstant — pythonLineInfo", () => {
	// test-contract: invariant — a Python line with no "#" at all must report transparent:false, not fall through to a bogus last-character comment. Also kills fd1121f91651dda4 (the -1-becomes-+1 variant takes the same wrong branch whenever idx is genuinely -1).
	it("kills 6fd6373b906c2d9f, fd1121f91651dda4: idx===-1 must route to the no-comment branch, not a mistargeted comment branch", () => {
		const src = ["# temporary for now", "X", "LIMIT = 3"].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});
});

// ─── resumeMultilineString ───────────────────────────────────────────────────
// 154ec0734cce8539 (j<rawLine.length -> j<=rawLine.length) is provably
// equivalent — see receipts: the phantom j===rawLine.length iteration reads
// charAt(length)==="", and delim (always a real carried-over quote char here)
// can never equal "", so the extra iteration changes nothing before falling
// through to the same unterminated-fallback path either way.

// ─── splitLines ──────────────────────────────────────────────────────────────
// c8a979800dfac9cb (i<lines.length -> i<=lines.length) is provably
// equivalent — see receipts: the phantom i===lines.length iteration reads
// lines[length]??"" = "", ""·endsWith("\r") is false, so no assignment and no
// array extension occurs; the returned array is byte-identical either way.

// ─── stringAllowsEscapes ─────────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — stringAllowsEscapes", () => {
	// test-contract: invariant — escapes must stay enabled for a Go double-quoted string (only Go raw/backtick strings disable escapes); forcing delim==="`" collapses the check to "lang!=='go'", wrongly disabling escapes for ordinary Go double-quoted strings too, so an escaped quote closes the string early and leaks trailing text as a real comment
	it("kills 6ddcc0f85088d6f0: escapes must depend on the actual delimiter, not just the language", () => {
		const src = ['x := "a\\" //temporary for now', "const LIMIT = 3"].join("\n");
		expect(run(src, "server/config.go")).toHaveLength(0);
	});
});

// ─── skipRustCharLiteral ─────────────────────────────────────────────────────
// 93f33e9db95d517d (rawLine.length-1 -> rawLine.length+1 in the Math.min upper
// bound) is provably equivalent — see receipts: out-of-bounds charAt() always
// returns "", which never equals "'", so the 1-2 extra positions the widened
// bound allows checking are unreachable no-ops; Math.min already returns
// start+RUST_CHAR_LOOKAHEAD whenever that's the true limiting factor.

describe("checkPlaceholderRuntimeConstant — skipRustCharLiteral", () => {
	// test-contract: invariant — a Rust char literal must correctly find and blank its own closing quote so a "=" inside it doesn't leak past the type-annotation catch-all. Also kills 35552f163efbbb9d, c75e5d14bb839d5e, 9d68b08834d73016, 3e9bb90190ce7ecf, 3433786e48745572, 929a056decccb784 — six different ways to make the closer-search never actually match, all collapsing to "the interior never gets blanked".
	it("kills d5b85f0613dc2b4d (+6 same-shape survivors): the closer-search loop must actually run and find the real closing quote", () => {
		const src = "pub const LIMIT: '=' = 3; // temporary for now";
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
	});

	// test-contract: boundary — the closer-search must include the char exactly at its lookahead boundary, not stop one short. Also kills 7e7eebc746dc0aa5 (forcing an immediate match at the first checked position blanks only 1 of 2 interior chars, leaking the same embedded "=" past the type-group the same way).
	it("kills f99ce6a7cd38f2b0, 7e7eebc746dc0aa5: the closer-search must check j up to and including limit", () => {
		const src = "pub const LIMIT: 'x=' = 3; // temporary for now";
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
	});

	// test-contract: invariant — a recognized Rust char literal must let scanning resume after it so a same-line trailing comment is still read as a real comment. Also kills b01e26aea0bfc77e (reversing the search direction never terminates on this input, which is likewise never confirmed live).
	it("kills 5eb6ffe7e3e8424d (+1 same-shape survivor): a Rust char literal must not halt the rest of the line's scan", () => {
		const src = ["let sep: char = 'x'; // temporary for now", "const LIMIT: usize = 3;"].join("\n");
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: boundary — the closer-search must stay bounded to RUST_CHAR_LOOKAHEAD, not widen to the rest of the line, or an unrelated later apostrophe gets wrongly paired as the closer and swallows real text (including a real trailing comment) in between
	it("kills 453d7c524f9de7c4: the closer-search bound must stay the smaller of the two limits, not the larger", () => {
		const src = [
			"let a = 'x, keep this note // temporary for now, then close 'y';",
			"const LIMIT: usize = 3;",
		].join("\n");
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: invariant — the interior blank on a found closer must start right after the opening quote, not one char before it (which would blank a required ":" out of a type-annotation-shaped value)
	it("kills 3934d85411bd07a9: the interior blank on a found closer must start at start+1, not start-1", () => {
		const src = "pub const LIMIT:'=' = 3; // temporary for now";
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
	});
});

// ─── scanCodeLine ────────────────────────────────────────────────────────────
// Six survivors are provably equivalent — see receipts:
// - f4091ac864f168a5, 0cbb37eb0bf34e11 (comments.length>0 forced true / >=0):
//   both skip only the null-vs-"" distinction on an empty comments array;
//   infoConfesses treats "" the same as null (CONFESSION_RE.test("") is
//   false either way), so the observable result never changes.
// - 3464de00cf48fcf1 (comments=[] -> ["Stryker was here"]): the sentinel text
//   never matches CONFESSION_RE and is harmlessly prefixed via join(" ") —
//   never creates a false confession, never suppresses a true one.
// - ef61db16ed135b7a (join separator " " -> ""): every comments[] entry
//   starts with "/" or ends with "*/", both non-word chars, so \b already
//   forms at the join boundary with or without an explicit space.
// - 39b3173e9af88a10 (lang==="rust" forced true, in lang==="rust"&&ch==="'"):
//   redundant given LANG_QUOTES — for jslike/go, "'" is already intercepted
//   by the LANG_QUOTES branch above this check, so ch==="'" can only reach
//   this line when lang is already "rust".
// - 1c9547b18c5bc5f9 (while-condition state.stringDelim===null forced true):
//   the only path that sets stringDelim also returns i===rawLine.length from
//   consumeStringLiteral, so the loop's own i<rawLine.length already stops
//   it independently of this check.

describe("checkPlaceholderRuntimeConstant — scanCodeLine", () => {
	// test-contract: security — a line-comment's captured text must start at the "//" marker, not the whole raw line; code before it (an identifier containing a confession word) must never leak into the comment
	it("kills 6ff4e6ea49e6e7a3: a line comment must be captured from its \"//\" marker onward, not from the start of the line", () => {
		const src = ["let standIn = 5; // ordinary note", "const REAL = 3;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	// test-contract: security — a Rust char literal's apostrophes must be recognized so a `"` inside one (e.g. `'"'`) is never mistaken for the start of a real Rust string; losing that recognition lets the stray `"` swallow a real trailing comment as fake string interior. Also kills bbb4aa5ba4e13407, 500608fc88bc0e84, 0171ab58708b3fbb, 0f39517143d7c240, d36dd1b77b1599e3 — five different ways to disable the same recognition.
	it("kills 98f512c29e867619 (+5 same-shape survivors): Rust char-literal recognition must actually engage for a genuine apostrophe", () => {
		const src = ['let x = \'"\'; // temporary for now', "const LIMIT: usize = 3;"].join("\n");
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});
