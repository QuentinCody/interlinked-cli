// Survivor-kill tests for src/harness/package-install-parser.ts, sourced from
// scratch/fleet-r3/kill-briefs/src_harness_package-install-parser.ts.raw.json
// (97 surviving mutants as of generation 743).
//
// Only 3 functions in this module are exported (parseInstallCommands,
// splitShellSegments, stripRedirections) — every other survivor symbol
// (tokenize, stripWrappers, stripWrappers.consumeEnvVar, parseCdSegment,
// composeCwd, parseOneSegment, parseExtendedEcosystem, basenameNoExt, the
// module-scope PURE/COMPOUND redirection regexes) is private and is
// exercised here only indirectly through parseInstallCommands's call graph.
// Each `it()`'s comment names the specific mutantId(s) (from the shadow-verify
// run in scratch/fleet-r3/) it empirically kills.
import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { parseInstallCommands, splitShellSegments, stripRedirections } from "./package-install-parser.js";

describe("splitShellSegments — escaped quotes must not close the string early", () => {
	// Kills: fbab0f55d1a78b5c (s[i-1]!=="\\" -> true), 9b6feb73416e61de
	// (i-1 -> i+1), eaf0357e5db61065 ("\\" -> "") — all three collapse the
	// escape-recognition check so ANY quote-char match closes the string,
	// even one immediately preceded by a backslash. A `;` placed just past
	// the escaped quote proves the string stayed open (no premature split).
	it("P: an escaped single-quote inside a single-quoted segment does not close it", () => {
		expect(splitShellSegments("a 'x\\'y;z' b")).toEqual(["a 'x\\'y;z' b"]);
	});

	it("P: an escaped double-quote inside a double-quoted segment does not close it", () => {
		expect(splitShellSegments('a "x\\"y;z" b')).toEqual(['a "x\\"y;z" b']);
	});
});

describe("splitShellSegments — double-quote must be recognized as an opener", () => {
	// Kills: 4744fe9d5efcd849 (ch === '"' -> false), 451c8b5363c85895
	// ('"' -> ""). If double-quote detection is disabled, the embedded `;`
	// inside "a;b" is no longer protected and splits the segment in two.
	it("P: a double-quoted segment protects an embedded ; from splitting", () => {
		expect(splitShellSegments('echo "a;b" && echo c')).toEqual(['echo "a;b"', "echo c"]);
	});
});

describe("splitShellSegments — && / || lookahead must not misfire on a lone operator", () => {
	// Kills: ad6811c36daad3f1 (s[i+1]==="&" -> true), 8cd0233012c768ca
	// (=== -> !==). Forcing/inverting the lookahead makes a LONE `&` (not
	// part of `&&`) wrongly enter the double-operator branch, which also
	// skips (eats) the character immediately after it.
	it("P: a lone & does not eat the character right after it", () => {
		expect(splitShellSegments("a &Xc")).toEqual(["a", "Xc"]);
	});

	// Kills: ec8f07751b980b37 (s[i+1]==="|" -> true), 2b4e8d81a11fce18
	// (=== -> !==), e7dce7ed6129646a (&& -> || for the pipe-double check —
	// with OR, a lone `|` alone satisfies the condition too).
	it("P: a lone | does not eat the character right after it", () => {
		expect(splitShellSegments("a |Xc")).toEqual(["a", "Xc"]);
	});
});

describe("splitShellSegments — && / || skip-consumption must consume exactly the operator pair", () => {
	// Kills: 2fde4c6f96457c93 (the && branch's `i + 1` -> `i - 1`). With the
	// wrong index, the lookahead re-reads a stale position and the skip
	// either fires wrongly or the char after a genuine `&&` gets dropped.
	it("P: a && pair glued to the next word does not drop that word's first char", () => {
		expect(splitShellSegments("a &&Xb")).toEqual(["a", "Xb"]);
	});

	// Kills: e5639656393b9a16 (the || branch's `i + 1` -> `i - 1`), same
	// class of bug as above but on the pipe-doubling branch.
	it("P: a || pair glued to the next word does not drop that word's first char", () => {
		expect(splitShellSegments("a ||Xb")).toEqual(["a", "Xb"]);
	});
});

describe("splitShellSegments — standalone | must be recognized on its own", () => {
	// Kills: a31b94cedb43ce5b (ch==="|" -> true — vacuous once it's already
	// the standalone branch, but paired with fa8b28 below it must still
	// distinguish a real match) and fa8b28fc8ea274e0 (=== -> !==, which
	// would make a lone | at any OTHER position wrongly split, or this
	// exact position wrongly NOT split).
	it("P: a lone | with surrounding spaces splits into two clean segments", () => {
		expect(splitShellSegments("a | b")).toEqual(["a", "b"]);
	});
});

describe("splitShellSegments — trailing buffer is only flushed when non-empty", () => {
	// NOTE: 093569eaac99de34 (the final `if (buf) out.push(buf)` -> `if
	// (true) ...`) is NOT killed by these — precisely re-verified in
	// isolation (scratch/fleet-r3/precise-occurrence-check.mts) and found
	// equivalent: `.filter(p => p.length > 0)` on the return drops the
	// spurious empty push either way, so forcing the flush unconditional
	// is unobservable through this function's return value. These two
	// cases stay as documentation of the intended (correct) behavior.
	it("P: a trailing separator with nothing after it yields no trailing segment", () => {
		expect(splitShellSegments("a;")).toEqual(["a"]);
	});

	it("P: baseline multi-operator split still produces exactly the 6 real tokens", () => {
		expect(splitShellSegments("a; b && c || d | e & f")).toEqual(["a", "b", "c", "d", "e", "f"]);
	});
});

describe("stripRedirections — PURE_REDIR_RE / COMPOUND_REDIR_RE anchor and quantifier boundaries", () => {
	// Kills: 5e9bb963d2d57489 (PURE drops its leading ^ anchor). Without the
	// anchor, "foo>" (an operator with junk BEFORE it) would wrongly match
	// PURE as a suffix, causing it to also eat the following token.
	it("P: an operator with text before it is not a pure redirection (keeps both tokens)", () => {
		expect(stripRedirections(["cmd", "foo>", "next", "keep"])).toEqual(["cmd", "foo>", "next", "keep"]);
	});

	// Kills: 2b28946e2f2a4ab5 (PURE drops its trailing $ anchor). Without
	// it, ">file" (a COMPOUND, embedded-filename form) would ALSO match
	// PURE first, and PURE's branch wrongly consumes the NEXT array
	// element too (i++), unlike COMPOUND which only drops itself.
	it("P: an embedded-filename compound operator drops only itself, not the next token", () => {
		expect(stripRedirections(["cmd", ">file", "keep"])).toEqual(["cmd", "keep"]);
	});

	// Kills: e2418ad0145245c7 (PURE's `\d+` -> `\d`, single digit only).
	// A two-digit FD ("10>") would stop matching PURE and fall through
	// unstripped.
	it("P: a multi-digit FD pure operator still consumes the following token", () => {
		expect(stripRedirections(["cmd", "10>", "out.log"])).toEqual(["cmd"]);
	});

	// Kills: c7381cbd20bcf194 (`<<?<?` -> `<<<?`, requires >=2 `<` chars)
	// and e5e570f2b2fd2d03 (`<<?<?` -> `<<?<`, requires a MANDATORY final
	// `<`). Either change makes a bare single `<` stop matching PURE.
	it("P: a bare single < is still a pure input-redirection operator", () => {
		expect(stripRedirections(["cmd", "<", "input.txt"])).toEqual(["cmd"]);
	});

	// Kills: 6e2c8ac3eebfb9ae (COMPOUND drops its trailing $ anchor). A
	// token containing a literal space (only reachable by calling this
	// exported function directly with a hand-built token array, as here)
	// would match a PREFIX of COMPOUND without the anchor, instead of
	// correctly failing to match the whole token.
	it("P: a token with an embedded space is not a compound match (anchored to the end)", () => {
		expect(stripRedirections(["cmd", ">out extra", "keep"])).toEqual(["cmd", ">out extra", "keep"]);
	});

	// Kills: 43f70cb371bc867a (COMPOUND's `\d+` -> `\d`, single digit
	// only). A two-digit FD compound ("10>out.log") would stop matching.
	it("P: a multi-digit FD compound operator drops only itself", () => {
		expect(stripRedirections(["cmd", "10>out.log", "keep"])).toEqual(["cmd", "keep"]);
	});
});

describe("parseInstallCommands — cd target quoting round-trips through tokenize", () => {
	// Kills a large cluster of tokenize's quote-close mutants (the whole
	// `if (q) {...}` block emptied, its inner conditional forced true/false,
	// the && flipped to ||, ch===q forced true or inverted, and the
	// escape-recognition arithmetic/string-literal mutants on `seg[i-1]`) —
	// a double-quoted cd target containing an internal SPACE only survives
	// as one token if tokenize's quote handling stays fully intact end to
	// end. Matches 20+ distinct occurrences in the shadow-verify run.
	it("P: a double-quoted cd target with an internal space stays one token", () => {
		const cmds = parseInstallCommands('cd "my dir" && npm ci');
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).effectiveCwd).toBe("my dir");
	});

	it("P: a single-quoted cd target with an internal space stays one token", () => {
		const cmds = parseInstallCommands("cd 'my dir' && npm ci");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).effectiveCwd).toBe("my dir");
	});

	// Kills tokenize's escape-recognition mutants specifically (seg[i-1]
	// !== "\\" forced true, i-1 -> i+1, "\\" -> ""): an escaped double-quote
	// INSIDE a double-quoted target must not close the string early, and
	// the backslash+quote must survive literally in the token.
	it("P: an escaped double-quote inside a cd target does not close the string early", () => {
		const cmds = parseInstallCommands('cd "my\\"dir" && npm ci');
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).effectiveCwd).toBe('my\\"dir');
	});

	it("P: a plain double-quoted target with no escaping is unwrapped correctly", () => {
		const cmds = parseInstallCommands('cd "abc def" && npm ci');
		expect(nonNull(cmds[0]).effectiveCwd).toBe("abc def");
	});

	it("P: a plain single-quoted target with no escaping is unwrapped correctly", () => {
		const cmds = parseInstallCommands("cd 'abc def' && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("abc def");
	});
});

describe("parseInstallCommands — tokenize whitespace-collapse must not invent empty tokens", () => {
	// Kills: 141e04a8d6d640f1 — the IN-LOOP `if (buf) { out.push(buf); buf
	// = ""; }` -> `if (true) ...`. A doubled internal space pushes a
	// spurious empty token between "npm" and "install", which parseNpmLike
	// then misreads as the verb, so `action` never resolves to "add".
	//
	// Its dup-pair sibling be8729375a937727 is the OTHER textual `if
	// (buf)` in tokenize (the POST-LOOP final flush) — precisely
	// re-verified in isolation and found equivalent: whatever ecosystem
	// parser consumes tokenize's output already ignores a lone trailing
	// empty-string token, so forcing that specific flush unconditional has
	// no observable effect. Confirmed via
	// scratch/fleet-r3/precise-occurrence-check.mts (0/821 fuzz divergence
	// at that exact occurrence, vs 2/821 at the in-loop one below).
	it("P: a doubled internal space does not produce a phantom empty token", () => {
		const cmds = parseInstallCommands("npm  install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).action).toBe("add");
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	it("N: a doubled trailing space does not produce a phantom trailing token", () => {
		const cmds = parseInstallCommands("npm install foo  ");
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "foo" }]);
	});
});

describe("parseInstallCommands — composeCwd reset-vs-join boundary", () => {
	// Kills: 630fca49fafec4ca (the absolute/tilde OR forced false),
	// ff0cbcf51e4e2176 (OR -> AND, impossible for one string to satisfy
	// both startsWith checks at once), 03fc0161e835bd55
	// (startsWith("/") -> endsWith("/")). A second, ABSOLUTE cd hop must
	// RESET the cwd, not join it onto the first (relative) hop.
	it("P: an absolute cd mid-compose resets instead of joining with the prior hop", () => {
		const cmds = parseInstallCommands("cd rel1 && cd /abs2 && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("/abs2");
	});

	// Kills: 88c891fa3d3629a9 (startsWith("~") -> endsWith("~")). A
	// tilde-prefixed second hop must also reset, not join.
	it("P: a tilde-prefixed cd mid-compose resets instead of joining with the prior hop", () => {
		const cmds = parseInstallCommands("cd rel1 && cd ~abs2 && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("~abs2");
	});

	it("N: two ordinary relative cd hops DO join with a slash", () => {
		const cmds = parseInstallCommands("cd rel1 && cd rel2 && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("rel1/rel2");
	});
});

describe("parseInstallCommands — parseCdSegment flag-skip and no-target guards", () => {
	// Kills: 698c3f8724be0a6a (startsWith("-") -> endsWith("-")), 9c3b0541cb4651f1
	// (the whole while condition forced false), a84a535a7d5c7cde /
	// 7fb377e03c2bf976 / 41a51d5ecb172f12 (the `i < stripped.length` bound
	// forced true / <= / >=, which either throws on an out-of-bounds
	// nonNull() or wrongly returns a flag token as the cd target), and
	// 536ede22699c38a5 (`!target` forced false, which would hand `undefined`
	// to composeCwd and throw). A cd line whose only tokens after "cd" are
	// flags (no real target) must be dropped entirely — the "-x"/"-y"
	// tokens must never leak through as bogus cd targets.
	it("P: a cd line with only flag-shaped tokens after it is dropped, does not throw", () => {
		const cmds = parseInstallCommands("cd -x -y && npm ci");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
		expect("effectiveCwd" in nonNull(cmds[0])).toBe(false);
	});

	it("P: a double-dash flag is skipped and the real target after it is used", () => {
		const cmds = parseInstallCommands("cd -- foo && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("foo");
	});

	it("P: a single-letter flag is skipped and the real target after it is used", () => {
		const cmds = parseInstallCommands("cd -L foo && npm ci");
		expect(nonNull(cmds[0]).effectiveCwd).toBe("foo");
	});

	it("N: a cd line of only a double-dash flag (no target at all) is dropped", () => {
		const cmds = parseInstallCommands("cd -- && npm ci");
		expect("effectiveCwd" in nonNull(cmds[0])).toBe(false);
	});
});

describe("parseInstallCommands — effectiveCwd is never set as an explicit-undefined key", () => {
	// Kills: 46c359c48e4f3d80 (`if (cwdShift) parsed.effectiveCwd =
	// cwdShift;` -> `if (true) ...`). With no preceding cd, cwdShift is
	// undefined; forcing the assignment sets `effectiveCwd: undefined`
	// explicitly rather than leaving the key absent. JSON.stringify hides
	// this (it drops undefined-valued properties either way), so the
	// assertion checks key PRESENCE directly via the `in` operator.
	it("P: a plain install with no cd prefix carries no effectiveCwd key at all", () => {
		const cmds = parseInstallCommands("npm install foo");
		expect("effectiveCwd" in nonNull(cmds[0])).toBe(false);
	});

	it("N: an install with a preceding cd DOES carry the effectiveCwd key", () => {
		const cmds = parseInstallCommands("cd rel1 && npm install foo");
		expect("effectiveCwd" in nonNull(cmds[0])).toBe(true);
	});
});

describe("parseInstallCommands — stripWrappers strips exactly the recognized wrapper words", () => {
	// Kills: 28bc81a1024181ee / a6fef339769c8240 (exec), 3d77cd25054ab5f8 /
	// 7f1aa331f767a646 (nohup), 4fcbe94f85d8f841 / 61163c27acdd0273
	// (command), 8b57463c9b09677c / 316aa6cb1ed7c284 (time). Each pair
	// disables recognition of one wrapper word; if it's not stripped, the
	// wrapper word itself becomes the "bin" and matches no ecosystem.
	it.each([
		["exec", "exec npm install foo"],
		["nohup", "nohup npm install foo"],
		["command", "command npm install foo"],
		["time", "time npm install foo"],
	])("P: the %s wrapper is stripped, npm install still parses", (_label, cmd) => {
		const cmds = parseInstallCommands(cmd);
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
		expect(nonNull(cmds[0]).packages).toEqual([{ kind: "registry", name: "foo" }]);
	});

	// Kills: 4b18e88ac21a7cbc (`tokens.length === 0` -> `false`, the SECOND
	// empty-tokens guard in parseOneSegment, reached after stripWrappers
	// consumes every token). Without it, `basenameNoExt(nonNull(tokens[0]))`
	// on an empty array throws instead of the segment cleanly yielding
	// nothing.
	it("P: a line of only wrapper words with no binary after it yields nothing, does not throw", () => {
		expect(parseInstallCommands("sudo exec")).toEqual([]);
	});
});

describe("parseInstallCommands — env-assignment regex boundary (anchor, char class)", () => {
	// Kills: 59fc0a1060e07aa5 / 290592ebf9f4ae49 (drop the ^ anchor from
	// `/^[A-Za-z_]\w*=/` at BOTH textual occurrences — the env-loop's
	// nested regex and the standalone bare-prefix regex). Without the
	// anchor, a digit-led key like "1FOO=bar" wrongly matches (the pattern
	// can match starting mid-string, at the "FOO=bar" suffix).
	it("P: a digit-led key is never a bare assignment (anchor required)", () => {
		expect(parseInstallCommands("1FOO=bar npm install foo")).toEqual([]);
	});

	it("P: a digit-led key is never an assignment, even under an env prefix", () => {
		expect(parseInstallCommands("env 1FOO=bar npm install foo")).toEqual([]);
	});

	// Kills: 320b88f74e354d68 (`[A-Za-z_]` -> `[^A-Za-z_]`, negated class).
	// A single-digit key ("9=bar") would then match: the negated class
	// accepts the digit, and `\w*` can match zero characters.
	it("P: a non-letter-led single-char key is never an assignment under env", () => {
		expect(parseInstallCommands("env 9=bar npm install foo")).toEqual([]);
	});

	it("P: an ordinary 3-letter key is a valid bare assignment with no env prefix", () => {
		const cmds = parseInstallCommands("FOO=bar npm install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
	});

	it("N: a digit-led first token that matches no verb or env form yields nothing", () => {
		expect(parseInstallCommands("123FOO=bar npm install foo")).toEqual([]);
	});

	it("N: env with a genuine assignment consumes it, then parses the binary normally", () => {
		const cmds = parseInstallCommands("env FOO=bar npm install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
	});
});

describe("parseInstallCommands — basenameNoExt strips slash and extension boundaries", () => {
	// Kills: 33cc5e6cac364ce7 (`slash >= 0` -> `slash > 0`) and
	// 0dff77feb12f3773 (`slash >= 0` -> `slash < 0`). Both break the
	// boundary case where the LAST slash is at index 0 (a leading-slash
	// bin) — only `>= 0` correctly strips it.
	it("P: a leading-slash bin still resolves after the slash is stripped", () => {
		const cmds = parseInstallCommands("/npm install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
	});

	// Kills: 9f18e0ca65d9438b (`slash >= 0` -> `false`, never strips a
	// directory prefix at all).
	it("P: a path-qualified bin has its directory prefix stripped", () => {
		const cmds = parseInstallCommands("./bin/npm install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
	});

	// Kills: 6f0264975726b035 (`dot > 0` -> `false`, never strips an
	// extension) and 13aa25ec6412fb23 (the "." string literal -> "",
	// which makes `lastIndexOf("")` return the string's own length,
	// producing a no-op slice that keeps the extension attached).
	it("P: a Windows-style .exe suffix is stripped from the bin", () => {
		const cmds = parseInstallCommands("npm.exe install foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).manager).toBe("npm");
	});

	it("N: a leading-dot dotfile name is not treated as having a stripped extension", () => {
		expect(parseInstallCommands(".npmrc install foo")).toEqual([]);
	});
});

describe("parseInstallCommands — bundler alias and extended-ecosystem routing", () => {
	// Kills: 12885882deec4325 (`bin === "bundler"` -> `false`) and
	// 8883f607cad1e6f6 (the "bundler" string literal -> "").
	it("P: bundler is a recognized alias for bundle", () => {
		const cmds = parseInstallCommands("bundler add foo");
		expect(cmds).toHaveLength(1);
		expect(nonNull(cmds[0]).ecosystem).toBe("rubygems");
	});

	// Kills: e12f9873cc661e13 (`bin === "mvn"` -> `true`, always routes to
	// parseMaven regardless of the actual bin). parseMaven itself requires
	// a "dependency:get" token in its args, so an unrecognized bin followed
	// by that exact shape is the fixture that actually distinguishes it
	// (a bin with unrelated args still returns null from parseMaven too).
	it("P: an unrecognized bin is never force-routed into the maven parser", () => {
		expect(parseInstallCommands("widget dependency:get -Dartifact=a:b:1.0.0")).toEqual([]);
	});

	it("N: mvn itself still routes to the maven ecosystem", () => {
		const cmds = parseInstallCommands("mvn dependency:get -Dartifact=a:b:1.0.0");
		expect(nonNull(cmds[0]).ecosystem).toBe("maven");
	});
});

describe("parseInstallCommands — rawCommand runtime type guard", () => {
	// Kills: 6b97d7c053dba27c (the whole `!rawCommand || typeof ... !==
	// "string"` guard forced false) and ad7ca0de76d4166e (|| -> &&, which
	// only short-circuits when BOTH are true). A null rawCommand (reachable
	// from an untyped caller, e.g. tool-call JSON) must not reach
	// `splitShellSegments(null)`, which would throw on `.length`.
	it("P: a null rawCommand yields nothing and does not throw", () => {
		expect(parseInstallCommands(null)).toEqual([]);
	});

	it("P: a numeric rawCommand yields nothing and does not throw", () => {
		expect(parseInstallCommands(42)).toEqual([]);
	});

	it("N: an ordinary empty string still yields nothing via the same guard", () => {
		expect(parseInstallCommands("")).toEqual([]);
	});
});

describe("tokenize — the post-loop final flush must stay conditional on a non-empty buf", () => {
	// Kills: be8729375a937727 (tokenize's second `if (buf)` — the post-loop
	// final flush, not the in-loop whitespace flush — mutated `buf` -> `true`).
	// Round-1 marked this suspected_equivalent by analogy with splitShellSegments's
	// matching final-flush mutant (093569eaac99de34), which IS equivalent there
	// because splitShellSegments's return statement runs every segment through
	// `.filter((p) => p.length > 0)`. tokenize has NO such filter on its `out`
	// array, so an unconditional final push injects a genuine trailing "" token.
	// Reached via: a segment ending in an unterminated open quote (`"`) leaves
	// tokenize's buf empty at loop-end (the quote-open branch does not append
	// to buf), so the forced-true mutant appends a spurious "" token that
	// survives stripRedirections unfiltered and reaches scanNpmFlags as a
	// phantom empty positional — flipping the parsed action from "sync" (bare
	// `npm install`, positionals empty) to "add" with a bogus {kind:"registry",
	// name:""} package.
	// test-contract: invariant — tokenize only emits tokens for text actually
	// present in the input; a segment ending on an unterminated open quote
	// must not manufacture a trailing empty positional.
	it("P: an unterminated trailing quote does not manufacture a phantom empty token", () => {
		expect(parseInstallCommands('npm install "')).toEqual([
			{
				ecosystem: "npm",
				manager: "npm",
				action: "sync",
				packages: [],
				fromLockfile: false,
				fromManifest: true,
				notes: [],
			},
		]);
	});

	// test-contract: boundary — same defect class via an unterminated
	// single-quote instead of a double-quote, confirming both quote-open
	// branches share the no-append-to-buf behavior the mutant would corrupt.
	it("P: an unterminated trailing single-quote also yields no phantom token", () => {
		expect(parseInstallCommands("npm install '")).toEqual([
			{
				ecosystem: "npm",
				manager: "npm",
				action: "sync",
				packages: [],
				fromLockfile: false,
				fromManifest: true,
				notes: [],
			},
		]);
	});
});
