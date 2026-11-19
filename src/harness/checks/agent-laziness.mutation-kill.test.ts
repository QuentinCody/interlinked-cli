// Survivor-kill tests for src/harness/checks/agent-laziness.ts, sourced from
// scratch/fleet-r2/kill-briefs/src_harness_checks_agent-laziness.ts.json.
//
// Each `it()` targets one or more specific surviving mutants (recorded in the
// comment above it by mutator kind / the exact source fragment that
// survived). Many module-level phrase regexes only differ from their mutant
// by whitespace quantifier boundaries (`\s+` vs `\s` vs `\S+`) or an optional
// group's `?` — the shared technique used throughout:
//   - doubling internal whitespace at a `\s+` site kills BOTH the "exactly
//     one" (`\s`) and the "one-or-more non-whitespace" (`\S+`) replacements,
//     since neither can match two literal space characters while the
//     original `\s+` tolerates any amount.
//   - dropping an optional fragment (e.g. testing "hardcode" instead of
//     "hardcoded") kills a mutant that strips the fragment's trailing `?`
//     and makes it mandatory.
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkAgentThumbprintProse,
	checkDeadBranchLiteral,
	checkFileLevelSuppression,
	checkStubNotImplementedThrow,
	checkUntestableTimeInSource,
} from "./agent-laziness.js";

const TS = "src/lib/foo.ts";

describe("checkAgentThumbprintProse — cross-line corroboration wiring", () => {
	// Kills: lineOrNeighborsHaveIncompletenessSignal's `j === idx` -> `true`.
	// If every scanned line (not just the hit line) had stripWeakPhrases
	// applied, a neighbor's raw "placeholder value" (also a WEAK phrase,
	// AND one of the INCOMPLETENESS_SIGNAL_RE word-arm alternatives via
	// bare "placeholder") would be blanked before the incompleteness-signal
	// test, so it could no longer corroborate a DIFFERENT weak phrase on
	// the hit line. ("for now" doesn't work for this: standing alone it is
	// ALSO the STRONG standalone phrase, so it self-fires regardless of
	// corroboration and can't distinguish the mutant. "placeholder value"
	// is WEAK only — verified NOT to match any STRONG form.)
	it("P: a neighbor line's raw 'placeholder value' still corroborates a weak phrase on the hit line", () => {
		const code = ["// in practice this needs a second look", "// placeholder value"].join("\n");
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — MAX_MATCHES cap (8)", () => {
	// Kills: `matches.length >= MAX_MATCHES` -> `false` (cap removed) and
	// -> `matches.length > MAX_MATCHES` (off-by-one, allows a 9th).
	it("P: caps thumbprint findings at exactly 8 even with 10 candidate hits", () => {
		const code = Array.from(
			{ length: 10 },
			(_, i) => `// in a real implementation, call number ${i}`,
		).join("\n");
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBe(8);
	});
});

describe("checkAgentThumbprintProse — finding text construction", () => {
	// Kills: `content.split("\n")` -> `content.split("")` for the `original`
	// array (message text sourced per-character instead of per-line);
	// the message template emptied to ``; `.trim().slice(0, 130)` losing
	// `.slice`; and losing `.trim()`.
	it("P: finding text is the exact trimmed original line with the fixed prefix, not a per-character fragment", () => {
		const code = ["const a = 1;", "    // in a real implementation this calls the API", ""].join(
			"\n",
		);
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toBe(
			"agent-thumbprint phrase in comment: // in a real implementation this calls the API",
		);
	});

	// Kills: `.slice(0, 130)` removed while `.trim()` stays — the earlier
	// exact-match test can't distinguish this because its line is under 130
	// chars post-trim, so truncation never engages either way.
	it("P: truncates an overlong thumbprint line to 130 chars in the finding text", () => {
		const filler = "x".repeat(200);
		const code = `// in a real implementation ${filler}`;
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBe(1);
		const text = nonNull(matches[0]).text;
		expect(text.length).toBeLessThanOrEqual("agent-thumbprint phrase in comment: ".length + 130);
	});
});

describe("checkAgentThumbprintProse — SKIPPED_DOC_EXTS", () => {
	// Kills: each of ".mdx"/".txt"/".json"/".yaml"/".yml"/".toml" -> "" in the
	// skip-extension Set literal.
	it("N: skips every known non-code doc extension (.mdx/.txt/.json/.yaml/.yml/.toml)", () => {
		const code = `// in a real implementation this would call the API`;
		for (const ext of [".mdx", ".txt", ".json", ".yaml", ".yml", ".toml"]) {
			expect(checkAgentThumbprintProse(code, `docs/notes${ext}`)).toEqual([]);
		}
	});
});

describe("checkAgentThumbprintProse — STRONG_THUMBPRINT_PHRASES boundary cases", () => {
	// Site: /\bin\s+(?:a\s+)?real\s+(?:implementation|...)\b/i
	it("P: 'in real implementation' fires without the optional 'a'", () => {
		expect(
			checkAgentThumbprintProse(`// in real implementation this would call the API`, TS).length,
		).toBeGreaterThan(0);
	});
	it("P: 'in a real implementation' still fires with doubled internal whitespace throughout", () => {
		expect(
			checkAgentThumbprintProse(`// in  a  real  implementation this would call the API`, TS)
				.length,
		).toBeGreaterThan(0);
	});

	// Site: confession-verb ... for now (hardcoded?|stub(?:bed)?|mock(?:ed)?|
	// faked?|skip(?:ped)?|disabled?|left|good\s+enough|works?)
	it("P: each optional-suffix confession verb still fires in its SHORT form", () => {
		const shortForms = [
			"hardcode",
			"stub",
			"mock",
			"fake",
			"skip",
			"disable",
			"work",
		];
		for (const verb of shortForms) {
			const code = `// ${verb} this for now`;
			expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
		}
	});
	it("P: confession-verb phrase tolerates doubled whitespace after the verb and inside 'for now'", () => {
		expect(
			checkAgentThumbprintProse(`// hardcoded  blah blah blah for  now`, TS).length,
		).toBeGreaterThan(0);
		expect(checkAgentThumbprintProse(`// good  enough for now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /^for\s+now\s*[.!…]*$/i (standalone confession)
	it("N: 'for now' preceded by other words is not the standalone STRONG phrase (leading ^ enforced)", () => {
		expect(checkAgentThumbprintProse(`// well, for now`, TS)).toEqual([]);
	});
	it("P: standalone 'for  now' fires as STRONG with doubled internal whitespace", () => {
		expect(checkAgentThumbprintProse(`// for  now`, TS).length).toBeGreaterThan(0);
	});
	it("P: standalone 'for now .' (space before trailing punctuation) still fires as STRONG", () => {
		expect(checkAgentThumbprintProse(`// for now .`, TS).length).toBeGreaterThan(0);
	});
	it("P: standalone 'for now!' (confession punctuation) still fires as STRONG", () => {
		expect(checkAgentThumbprintProse(`// for now!`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\breal\s+(?:code|implementation|...)\s+would\b/i
	it("P: 'real ... would' tolerates doubled whitespace on both sides", () => {
		expect(
			checkAgentThumbprintProse(`// real  implementation  would need this`, TS).length,
		).toBeGreaterThan(0);
	});

	// Site: /\b(?:proper|actual)\s+implementation\b/i
	it("P: 'proper implementation' tolerates doubled whitespace", () => {
		expect(checkAgentThumbprintProse(`// proper  implementation needed`, TS).length).toBeGreaterThan(
			0,
		);
	});

	// Site: /\b(?:this\s+is\s+(?:a|just\s+a)\s+|just\s+a\s+|temporary\s+|simple\s+)placeholder\b/i
	it("P: each 'placeholder' confession branch tolerates doubled whitespace", () => {
		expect(checkAgentThumbprintProse(`// this  is  a  placeholder`, TS).length).toBeGreaterThan(0);
		expect(
			checkAgentThumbprintProse(`// this  is  just  a  placeholder`, TS).length,
		).toBeGreaterThan(0);
		expect(checkAgentThumbprintProse(`// just  a  placeholder`, TS).length).toBeGreaterThan(0);
		expect(checkAgentThumbprintProse(`// temporary  placeholder`, TS).length).toBeGreaterThan(0);
		expect(checkAgentThumbprintProse(`// simple  placeholder`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bplaceholder\s+(?:implementation|for\s+now|until)\b/i
	it("P: 'placeholder for now' tolerates doubled whitespace on both the outer and inner gap", () => {
		expect(checkAgentThumbprintProse(`// placeholder  for  now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bplaceholder\s+(?:implementation|for\s+now|until)\b/i — the
	// OUTER \s+ before the alternation group. The "implementation"/"until"
	// branches carry no "for now" text, so — unlike the sibling case above —
	// there is no WEAK-phrase "for now" corroboration fallback available to
	// mask a broken outer \s+; bare "placeholder" alone is not a WEAK phrase,
	// so this must be caught by the STRONG regex itself.
	// test-contract: public-api — checkAgentThumbprintProse must recognize
	// "placeholder implementation" as a STRONG thumbprint even with doubled
	// whitespace between "placeholder" and "implementation"/"until", since no
	// other phrase or corroboration path covers this shape.
	it("P: 'placeholder implementation'/'placeholder until' tolerate doubled whitespace on the OUTER gap (no 'for now' fallback exists)", () => {
		expect(checkAgentThumbprintProse(`// placeholder  implementation`, TS).length).toBeGreaterThan(
			0,
		);
		expect(checkAgentThumbprintProse(`// placeholder  until we wire it up`, TS).length).toBeGreaterThan(
			0,
		);
	});

	// Site: /\bsimplified\s+(?:version|for\s+now)\b/i
	it("P: 'simplified for now' tolerates doubled whitespace on both the outer and inner gap", () => {
		expect(checkAgentThumbprintProse(`// simplified  for  now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bTODO\s*:?\s*(?:actually\s+|properly\s+)?(?:implement|wire\s*up|hook\s*up|connect)\b/i
	it("P: 'TODO ... implement' fires across whitespace and optional-qualifier variations", () => {
		const cases = [
			"// TODO: implement this",
			"// TODO : implement this",
			"// TODO:  implement this",
			"// TODO: actually  implement this",
			"// TODO: properly  implement this",
			"// TODO: wire  up the client",
			"// TODO: hook  up the client",
		];
		for (const code of cases) {
			expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
		}
	});

	// Site: /\b(?:should|will|would)\s+(?:eventually|actually)\s+(?:be|use|call|fetch|connect)\b/i
	it("P: 'should eventually be' tolerates doubled whitespace on both gaps", () => {
		expect(checkAgentThumbprintProse(`// should  eventually  be replaced`, TS).length).toBeGreaterThan(
			0,
		);
	});

	// Site: /\bhardcod(?:ed?|ing)\s+for\s+now\b/i
	it("P: 'hardcode for now' (bare, no trailing d) still fires", () => {
		expect(checkAgentThumbprintProse(`// hardcode for now`, TS).length).toBeGreaterThan(0);
	});
	it("P: 'hardcoded for now' tolerates doubled whitespace on both gaps", () => {
		expect(checkAgentThumbprintProse(`// hardcoded  for  now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bmock(?:ed)?\s+for\s+now\b/i
	it("P: 'mock for now' (bare, no trailing ed) still fires", () => {
		expect(checkAgentThumbprintProse(`// mock for now`, TS).length).toBeGreaterThan(0);
	});
	it("P: 'mocked for now' tolerates doubled whitespace on both gaps", () => {
		expect(checkAgentThumbprintProse(`// mocked  for  now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bstub\s+for\s+now\b/i
	it("P: 'stub for now' tolerates doubled whitespace on both gaps", () => {
		expect(checkAgentThumbprintProse(`// stub  for  now`, TS).length).toBeGreaterThan(0);
	});

	// Site: /\b(?:we\s+would|we'd)\s+(?:normally|actually|usually)\b/i
	it("P: 'we would normally' tolerates doubled whitespace on both gaps", () => {
		expect(checkAgentThumbprintProse(`// we  would  normally do this differently`, TS).length).toBeGreaterThan(
			0,
		);
	});

	// Site: /\bin\s+(?:the\s+)?(?:real|final|actual|production)\s+(?:version|app|code)\b/i
	it("P: 'in the real version' fires without the optional 'the'", () => {
		expect(checkAgentThumbprintProse(`// in real version this differs`, TS).length).toBeGreaterThan(
			0,
		);
	});
	it("P: 'in the real version' tolerates doubled whitespace throughout", () => {
		expect(
			checkAgentThumbprintProse(`// in  the  real  version this differs`, TS).length,
		).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — WEAK_THUMBPRINT_PHRASES boundary cases (corroborated)", () => {
	// Site: /\bin\s+production\b(?!\s*(?:builds?|mode|environment\s+only))/i
	it("N: 'in production mode/builds/environment only' are excluded by the negative lookahead", () => {
		expect(checkAgentThumbprintProse(`// in production mode — TODO: revisit`, TS)).toEqual([]);
		expect(checkAgentThumbprintProse(`// in production builds — TODO: revisit`, TS)).toEqual([]);
		expect(
			checkAgentThumbprintProse(`// in production environment only — TODO: revisit`, TS),
		).toEqual([]);
	});
	it("N: 'in production build' (singular) is also excluded by the negative lookahead", () => {
		expect(checkAgentThumbprintProse(`// in production build — TODO: revisit`, TS)).toEqual([]);
	});
	it("N: 'in production  mode' (doubled ws before the excluded word) is still excluded", () => {
		expect(checkAgentThumbprintProse(`// in production  mode — TODO: revisit`, TS)).toEqual([]);
	});
	it("N: 'in production environment  only' (doubled ws) is still excluded by the negative lookahead", () => {
		expect(
			checkAgentThumbprintProse(`// in production environment  only — TODO: revisit`, TS),
		).toEqual([]);
	});
	it("P: 'in  production' WEAK phrase (doubled leading whitespace) still fires when corroborated", () => {
		const code = ["// in  production this needs fixing", "// TODO: revisit"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bin\s+practice\b/i
	it("P: 'in  practice' (doubled ws) still fires when corroborated", () => {
		const code = ["// in  practice this is fine", "// TODO: revisit"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bplaceholder\s+value\b/i
	it("P: 'placeholder  value' (doubled ws) still fires when corroborated", () => {
		const code = ["// placeholder  value here", "// TODO: revisit"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});

	// Site: /\bfor\s+now\b/i (the WEAK copy, distinct AST node from the STRONG standalone regex)
	it("P: WEAK 'for  now' (doubled ws) still fires when corroborated by a neighbor TODO", () => {
		const code = ["// for  now, this is fine", "// TODO: revisit"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — INCOMPLETENESS_SIGNAL_RE corroboration boundary cases", () => {
	const HIT_LINE = "// in practice this needs a second look";
	// Site: the big word-arm | return-arm alternation. Each case below
	// doubles/drops exactly one \s+/optional fragment inside it while still
	// being a valid corroborator for the (uncorroborated on its own) hit
	// line above.
	const mustCorroborate: Array<[string, string]> = [
		["not-implemented without 'yet' (optional group absent)", "// not implemented"],
		["not-yet-implemented, doubled ws after 'not'", "// not  yet implemented"],
		["not-yet-implemented, doubled ws inside 'yet'", "// not yet  implemented"],
		["coming soon, doubled ws", "// coming  soon"],
		["signal-copy 'for now', doubled ws", "// for  now"],
		["bare 'stub' without 'bed' (optional suffix absent)", "// stub"],
		["throw new Error, doubled ws before 'new'", '// throw  new Error("x")'],
		["throw new Error, doubled ws before 'Error'", '// throw new  Error("x")'],
		["return null, doubled ws after 'return'", "return  null;"],
		["return [] with no whitespace inside brackets", "return [];"],
		["return {} with no whitespace inside braces", "return {};"],
		["return null with NO trailing semicolon (optional ';' absent)", "return null"],
	];
	for (const [label, corroborator] of mustCorroborate) {
		it(`P: ${label}`, () => {
			const code = [HIT_LINE, corroborator].join("\n");
			expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
		});
	}
});

describe("checkAgentThumbprintProse — COMMENT_BODY_RE boundary cases", () => {
	// Site: /(?:\/\/+|\/\*+|\s\*+(?!\/)|#+|--+|<!--+)\s*(.*?)(?:\*+\/|-->)?\s*$/
	// The `\s\*+(?!\/)` arm (jsdoc continuation ` * body`) is the only marker
	// with an internal lookahead/repeat that's independently observable
	// through the public API; the other marker-count/`\s`/`\*` mutants are
	// exercised indirectly by every existing `//`/`#` fixture already firing.
	it("P: a jsdoc continuation line (' * body') is scanned as a comment body", () => {
		const code = ["/**", " * in a real implementation this calls the API", " */"].join("\n");
		const matches = checkAgentThumbprintProse(code, TS);
		expect(matches.length).toBeGreaterThan(0);
	});
	it("N: a line-comment marker directly followed by '/' another slash is not swallowed by the jsdoc arm", () => {
		// `\s\*+(?!\/)` must NOT match "* /" (a `*` immediately before `/`) —
		// guards against misreading the END of a block comment as a body
		// marker. Exercised via a closing `*/` on its own line.
		expect(checkAgentThumbprintProse(["/**", " * for now", " */"].join("\n"), TS).length).toBeGreaterThan(
			0,
		);
	});
});

describe("checkStubNotImplementedThrow — extension gate", () => {
	// Kills: `!JS_TS_EXTS.has(getExtension(filePath))` -> `false`.
	it("N: does not scan non-JS/TS/Python/Rust files even if the content looks like a JS stub throw", () => {
		expect(checkStubNotImplementedThrow(`throw new Error("not implemented");`, "src/lib.go")).toEqual(
			[],
		);
	});
});

describe("checkStubNotImplementedThrow — message-loop MAX_MATCHES cap (5)", () => {
	// Kills: `matches.length < MAX_MATCHES` -> `true` (cap removed) and
	// -> `matches.length <= MAX_MATCHES` (off-by-one, allows a 6th).
	it("P: caps stub-message findings at exactly 5 even with 7 candidate throws", () => {
		const code = Array.from(
			{ length: 7 },
			(_, i) => `function f${i}() { throw new Error("TODO"); }`,
		).join("\n");
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(5);
	});
});

describe("checkStubNotImplementedThrow — message trimming and truncation", () => {
	// Kills: `nonNull(match[1]).trim()` -> `nonNull(match[1])` (no trim before
	// the anchored ^...$ phrase-equality test).
	it("P: trims the thrown message before matching stub phrases (whitespace inside the string literal)", () => {
		const code = `function foo() { throw new Error("  not implemented  "); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("not implemented");
	});

	// Kills: `message.slice(0, 60)` -> `message` (no truncation). Since
	// NOT_IMPLEMENTED_PHRASES is ^...$ anchored, only excess INTERNAL
	// whitespace (which \s+ tolerates unboundedly) can push a matching
	// message past 60 chars.
	it("P: truncates a pathologically long-but-matching stub message to 60 chars in the finding text", () => {
		const longMessage = `not${" ".repeat(70)}yet${" ".repeat(10)}implemented`;
		const code = `function foo() { throw new Error("${longMessage}"); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text.includes(longMessage)).toBe(false);
	});
});

describe("checkStubNotImplementedThrow — line-number computation for the message loop", () => {
	// Kills: `scan.slice(0, offset).match(/\n/g) || []` -> `true`/`false`
	// (both make `.length` read `undefined.length`, i.e. NaN).
	it("P: computes the correct line number for a stub throw found deep in the file", () => {
		const code = [
			"function a() {}",
			"function b() {}",
			'function c() { throw new Error("TODO"); }',
		].join("\n");
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(3);
	});

	// Kills: `scan.slice(0, offset)` -> `scan` (counts newlines in the WHOLE
	// file instead of before the match), the `[]` fallback -> `["Stryker was
	// here"]` (only reachable when the match is on line 1, forcing `.match`
	// to return null), and `lineIdx + 1` -> `lineIdx - 1`.
	it("P: line number reflects newlines BEFORE the match, not the whole file (match on line 1)", () => {
		const code = [
			'function a() { throw new Error("TODO"); }',
			"function b() {}",
			"function c() {}",
		].join("\n");
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(1);
	});
});

describe("checkStubNotImplementedThrow — empty-throw loop", () => {
	// Kills: second-loop `matches.length >= MAX_MATCHES` -> `false` (cap
	// removed) and -> `matches.length > MAX_MATCHES` (off-by-one).
	it("P: caps empty `throw new Error()` findings at exactly 5 even with 7 candidates", () => {
		const code = Array.from({ length: 7 }, () => `function f() { throw new Error(); }`).join(
			"\n",
		);
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(5);
	});

	// Kills: `i + 1` -> `i - 1` for the empty-throw line number.
	it("P: empty-throw finding reports the correct 1-indexed line number", () => {
		const code = ["function a() {}", "function b() { throw new Error(); }"].join("\n");
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
	});
});

describe("checkStubNotImplementedThrow — NOT_IMPLEMENTED_MESSAGE_RE / EMPTY_THROW_RE class-name shape", () => {
	// A custom Error subclass name ("TypeError", "CustomError", …) is only
	// matched by `(?:[A-Z][\w$]*\s*)?` through greedy-then-backtrack
	// consumption of the class name so the literal "Error" can still match
	// afterward. Any of the several character-class inversions
	// ([A-Z]->[^A-Z], [\w$]*->[\w$], [\w$]*->[^\w$]*, [\w$]*->[\W$]*) breaks
	// that backtrack and makes the WHOLE regex fail to match at the single
	// `throw new` anchor point in these fixtures.
	it("P: recognizes a custom Error subclass constructor in the stub-message scan", () => {
		const code = `function f() { throw new TypeError("not implemented"); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.length).toBe(1);
	});
	it("P: recognizes a custom Error subclass constructor with no message (empty-throw arm)", () => {
		const code = `function f() { throw new CustomError(); }`;
		const matches = checkStubNotImplementedThrow(code, TS);
		expect(matches.some((m) => m.text.includes("no message"))).toBe(true);
	});

	// Whitespace-boundary mutants across both regexes' `\s+`/`\s*` sites.
	it("P: both throw-Error regexes tolerate whitespace variety around the class name and parens", () => {
		const messageCases = [
			'throw  new Error("TODO");',
			'throw new  Error("TODO");',
			'throw new Custom  Error ("TODO");',
		];
		for (const stmt of messageCases) {
			const code = `function f() { ${stmt} }`;
			expect(checkStubNotImplementedThrow(code, TS).length).toBe(1);
		}
		const emptyCases = [
			"throw  new Error();",
			"throw new  Error();",
			"throw new Custom  Error (  );",
		];
		for (const stmt of emptyCases) {
			const code = `function f() { ${stmt} }`;
			const matches = checkStubNotImplementedThrow(code, TS);
			expect(matches.some((m) => m.text.includes("no message"))).toBe(true);
		}
	});
});

describe("checkStubNotImplementedThrow — NOT_IMPLEMENTED_PHRASES anchoring", () => {
	// Kills: leading `^` removed (phrase would match as a SUFFIX).
	it("N: a stub-phrase message must be EXACTLY the phrase, not merely end with it", () => {
		const code = `function f() { throw new Error("well not implemented"); }`;
		expect(checkStubNotImplementedThrow(code, TS)).toEqual([]);
	});
	// Kills: trailing `$` removed (phrase would match as a PREFIX).
	it("N: a stub-phrase message must be EXACTLY the phrase, not merely start with it", () => {
		const code = `function f() { throw new Error("not implemented, sort of"); }`;
		expect(checkStubNotImplementedThrow(code, TS)).toEqual([]);
	});
	// Kills every \s+ -> \s / \S+ pair across the alternation's multi-word
	// phrases (doubling tolerates the original \s+, breaks both mutant
	// flavors at whichever single occurrence was mutated).
	it("P: stub-phrase matching tolerates doubled internal whitespace across every multi-word alternative", () => {
		const phrases = [
			"not  implemented",
			"not yet  implemented",
			"method  not  implemented",
			"to  be  implemented",
			"coming  soon",
			"work  in  progress",
			"not  ready",
		];
		for (const phrase of phrases) {
			const code = `function f() { throw new Error("${phrase}"); }`;
			expect(checkStubNotImplementedThrow(code, TS).length).toBe(1);
		}
	});
});

describe("checkStubNotImplementedThrow — Python raise NotImplementedError", () => {
	// Kills: leading `^` removed in PY_RAISE_NI_RE.
	it("N: 'raise NotImplementedError' preceded by other code on the same line is not flagged (line-anchored)", () => {
		const code = "def f(self):\n    do_something(); raise NotImplementedError\n";
		expect(checkStubNotImplementedThrow(code, "src/x.py")).toEqual([]);
	});
	// Kills: `raise\s+NotImplementedError` -> `raise\sNotImplementedError`.
	it("P: 'raise NotImplementedError' still flags with doubled whitespace after 'raise'", () => {
		const code = "def f(self):\n    raise  NotImplementedError\n";
		const matches = checkStubNotImplementedThrow(code, "src/x.py");
		expect(matches.length).toBe(1);
	});

	// Kills: `lines.slice(Math.max(0, i - 3), i)` -> `lines` (whole-file
	// lookback) and `Math.max(0, i - 3)` -> `Math.min(0, i - 3)` (also
	// widens the lookback to the whole file for i >= 3) — an @abstractmethod
	// decorator anywhere in the file would wrongly exempt a distant,
	// unrelated raise.
	it("P: an @abstractmethod decorator elsewhere in the file does NOT exempt a distant, unrelated raise", () => {
		const code = [
			"class Base:",
			"    @abstractmethod",
			"    def a(self):",
			"        raise NotImplementedError",
			"",
			"    def helper1(self):",
			"        return 1",
			"",
			"    def helper2(self):",
			"        return 2",
			"",
			"    def b(self):",
			"        raise NotImplementedError",
		].join("\n");
		const matches = checkStubNotImplementedThrow(code, "src/base.py");
		expect(matches.map((m) => m.line)).toEqual([13]);
	});

	// Kills: the lookback `.join("\n")` -> `.join("")` — with newlines
	// removed, two adjacent lines' text can concatenate into a false
	// "@abstractmethod" match that the real (newline-separated) lookback
	// text never forms.
	it("P: lookback lines are newline-joined, not concatenated (adjacent-line concat must not fake @abstractmethod)", () => {
		const code = ["x = 1", "@abc", ".abstractmethod!", "def method(self):", "    raise NotImplementedError"].join(
			"\n",
		);
		const matches = checkStubNotImplementedThrow(code, "src/x.py");
		expect(matches.map((m) => m.line)).toEqual([5]);
	});

	// Kills: the pushed message StringLiteral -> "".
	it("P: python stub message names the missing @abstractmethod contract", () => {
		const code = "def handler(self, event):\n    raise NotImplementedError\n";
		const matches = checkStubNotImplementedThrow(code, "src/app.py");
		expect(nonNull(matches[0]).text).toContain("outside an @abstractmethod");
	});

	// Kills: `out.length < 5` -> `true` (cap removed) and
	// -> `out.length <= 5` (off-by-one).
	it("P: caps python stub findings at exactly 5 even with 7 candidates", () => {
		const code = Array.from({ length: 7 }, (_, i) => `def f${i}():\n    raise NotImplementedError`).join(
			"\n",
		);
		const matches = checkStubNotImplementedThrow(code, "src/many.py");
		expect(matches.length).toBe(5);
	});
});

describe("checkStubNotImplementedThrow — Rust unimplemented!()/panic!()", () => {
	// Kills: `out.length < 5` -> `true` and -> `out.length <= 5`.
	it("P: caps rust stub findings at exactly 5 even with 7 candidates", () => {
		const code = Array.from({ length: 7 }, () => "fn a() { unimplemented!() }").join("\n");
		const matches = checkStubNotImplementedThrow(code, "src/many.rs");
		expect(matches.length).toBe(5);
	});

	// Kills: the pushed message StringLiteral -> "".
	it("P: rust stub message names finishing the implementation", () => {
		const code = "fn a() { unimplemented!() }";
		const matches = checkStubNotImplementedThrow(code, "src/lib.rs");
		expect(nonNull(matches[0]).text).toContain("finish the implementation");
	});

	// Kills: `unimplemented!\s*\(` -> `\S*\(`, `panic!\s*\(` -> `\S*\(`, and
	// `panic!\s*\(\s*"` -> `\S*"` — all `\s*` (zero-or-more) sites need
	// actual whitespace present to distinguish from `\S*`.
	it("P: rust stub macros still flag with whitespace before the paren / before the opening quote", () => {
		const code = [
			"fn a() { unimplemented! () }",
			'fn b() { panic! ("not implemented") }',
			'fn c() { panic!( "not implemented") }',
		].join("\n");
		const matches = checkStubNotImplementedThrow(code, "src/lib.rs");
		expect(matches.length).toBe(3);
	});
});

describe("checkDeadBranchLiteral — extension gate", () => {
	// Kills: `!JS_TS_EXTS.has(getExtension(filePath))` -> `false`.
	it("N: does not scan non-JS/TS files", () => {
		expect(checkDeadBranchLiteral(`if (true) { x = 1; }`, "src/main.go")).toEqual([]);
	});
});

describe("checkDeadBranchLiteral — MAX_MATCHES cap (5)", () => {
	// Kills: `matches.length >= MAX_MATCHES` -> `false` and
	// -> `matches.length > MAX_MATCHES`.
	it("P: caps dead-branch findings at exactly 5 even with 7 candidates", () => {
		const code = Array.from({ length: 7 }, () => "if (true) { x = 1; }").join("\n");
		const matches = checkDeadBranchLiteral(code, TS);
		expect(matches.length).toBe(5);
	});
});

describe("checkDeadBranchLiteral — finding text and line number", () => {
	// Kills: `content.split("\n")` -> `split("")` for `originalLines`; the
	// whole pushed object -> `{}`; `i + 1` -> `i - 1`; the message template
	// -> ``; `.trim().slice(0, 130)` losing `.slice`; losing `.trim()`.
	it("P: finding text is the exact trimmed original line with a fixed prefix and the correct line number", () => {
		const code = ["const a = 1;", "  if (true) { doStuff(); }  "].join("\n");
		const matches = checkDeadBranchLiteral(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toBe("dead branch literal: if (true) { doStuff(); }");
	});

	// Kills: `.slice(0, 130)` removed while `.trim()` stays.
	it("P: truncates an overlong dead-branch line to 130 chars in the finding text", () => {
		const filler = "x".repeat(200);
		const code = `if (true) { /* ${filler} */ }`;
		const matches = checkDeadBranchLiteral(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text.length).toBeLessThanOrEqual("dead branch literal: ".length + 130);
	});
});

describe("checkDeadBranchLiteral — DEAD_BRANCH_RE boundary cases", () => {
	// Kills: `(?:else\s+)?` -> `(?:else\s)?` / `(?:else\S+)?` (doubling),
	// `if\s*\(` -> `if\s\(` (zero-space "if(true)" must still match), and
	// the interior `\s*` -> `\S*` sites (need actual whitespace present).
	it("P: dead-branch literal fires with zero spacing, doubled 'else' spacing, and interior padding", () => {
		expect(checkDeadBranchLiteral("if(true) { x = 1; }", TS).length).toBe(1);
		expect(checkDeadBranchLiteral("if (cond) {} else  if(true) {}", TS).length).toBe(1);
		expect(checkDeadBranchLiteral("if( true ) { x = 1; }", TS).length).toBe(1);
	});
});

describe("checkFileLevelSuppression — test-file gate", () => {
	// Kills: `isTestFile(filePath)` -> `false`.
	it("N: does not fire in test files even with a suppression directive", () => {
		const directive = `// @ts-${"nocheck"}`;
		expect(checkFileLevelSuppression(directive, "src/lib/foo.test.ts")).toEqual([]);
	});
});

describe("checkFileLevelSuppression — MAX_MATCHES cap (3)", () => {
	// Kills: `matches.length >= MAX_MATCHES` -> `false` and
	// -> `matches.length > MAX_MATCHES`.
	it("P: caps suppression findings at exactly 3 even with 5 candidates", () => {
		const directive = `// @ts-${"nocheck"}`;
		const code = Array.from({ length: 5 }, () => directive).join("\n");
		const matches = checkFileLevelSuppression(code, TS);
		expect(matches.length).toBe(3);
	});
});

describe("checkFileLevelSuppression — finding line/text", () => {
	it("reports a directive in code that also contains an example directive in a string", () => {
		const directive = `/* eslint-${"disable"} */`;
		const code = [`const documentation = ${JSON.stringify(directive)};`, directive].join("\n");
		expect(checkFileLevelSuppression(code, TS).map((match) => match.line)).toEqual([2]);
	});

	// Kills: the whole pushed object -> `{}`; `i + 1` -> `i - 1`; the
	// message template -> ``.
	it("P: suppression finding reports the correct line and descriptive text", () => {
		const directive = `// @ts-${"nocheck"}`;
		const code = ["const a = 1;", directive].join("\n");
		const matches = checkFileLevelSuppression(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toContain("file-wide TypeScript disable");
	});

	// Kills: each label template -> `` across all 5 directive kinds.
	it("P: suppression finding text names which directive fired for every directive kind", () => {
		expect(
			nonNull(checkFileLevelSuppression(`// @ts-${"nocheck"}`, TS)[0]).text,
		).toContain("file-wide TypeScript disable");
		expect(
			nonNull(checkFileLevelSuppression(`/* @ts-${"nocheck"} */`, TS)[0]).text,
		).toContain("file-wide TypeScript disable");
		expect(
			nonNull(checkFileLevelSuppression(`/* eslint-${"disable"} */`, TS)[0]).text,
		).toContain("file-wide ESLint disable");
		expect(
			nonNull(checkFileLevelSuppression(`/* tslint:${"disable"} */`, TS)[0]).text,
		).toContain("file-wide TSLint disable");
		expect(
			nonNull(checkFileLevelSuppression(`// biome-ignore-${"all"}`, TS)[0]).text,
		).toContain("file-wide Biome disable");
	});

	// Kills: the pylint label StringLiteral -> "".
	it("P: pylint suppression finding text names the pylint directive", () => {
		const matches = checkFileLevelSuppression("# pylint: disable=all", "src/x.py");
		expect(nonNull(matches[0]).text).toContain("file-wide pylint disable");
	});
});

describe("checkFileLevelSuppression — token-construction StringLiteral mutants", () => {
	// Kills: "nocheck" -> "" inside TS_NOCHECK_TOKEN, which would loosen the
	// detection regex to bare "@ts-" (its trailing \b is nearly vacuous
	// right after a non-word "-").
	it("N: does not mistake @ts-check for the @ts-nocheck suppression directive", () => {
		const code = `// @ts-check\nfunction foo() {}`;
		expect(checkFileLevelSuppression(code, TS)).toEqual([]);
	});
	// Kills: the whole TSLINT_DISABLE_TOKEN template -> `` (would match ANY
	// near-empty block comment).
	it("N: an empty/whitespace-only block comment is not mistaken for a tslint:disable directive", () => {
		const code = `/*   */\nfunction foo() {}`;
		expect(checkFileLevelSuppression(code, TS)).toEqual([]);
	});
	// Kills: "disable" -> "" inside ESLINT_DISABLE_TOKEN / TSLINT_DISABLE_TOKEN.
	it("N: a bare '/* eslint- */' comment (no 'disable') is not mistaken for eslint-disable", () => {
		expect(checkFileLevelSuppression(`/* eslint- */\nfunction foo() {}`, TS)).toEqual([]);
	});
	it("N: a bare '/* tslint: */' comment (no 'disable') is not mistaken for tslint:disable", () => {
		expect(checkFileLevelSuppression(`/* tslint: */\nfunction foo() {}`, TS)).toEqual([]);
	});
	// Kills: "all" -> "" inside BIOME_IGNORE_ALL_TOKEN.
	it("N: 'biome-ignore-next-line' is not mistaken for the file-wide biome-ignore-all directive", () => {
		// Built at runtime (like the source file's own token tricks) so this
		// line-level-directive fixture doesn't itself trip the suppression scanner.
		const directive = `// biome-ignore-${"next-line"} lint/x: reason`;
		const code = `${directive}\nfunction foo() {}`;
		expect(checkFileLevelSuppression(code, TS)).toEqual([]);
	});
});

describe("checkFileLevelSuppression — pylint regex boundary cases", () => {
	// Kills: leading `^` removed in the pylint entry regex.
	it("N: '# pylint: disable=all' preceded by code on the same line is not flagged (start-of-line anchor)", () => {
		const code = "x = 1  # pylint: disable=all\ndef foo(): pass";
		expect(checkFileLevelSuppression(code, "src/x.py")).toEqual([]);
	});
	// Kills every \s -> \S / \s single-vs-star boundary in the pylint regex.
	it("P: '# pylint: disable=all' still flags with extra whitespace throughout", () => {
		const code = "  #  pylint:  disable=all\ndef foo(): pass";
		expect(checkFileLevelSuppression(code, "src/x.py").length).toBe(1);
	});
});

describe("checkFileLevelSuppression — GENERATED_PATH_RE boundary cases", () => {
	// Kills: trailing `$` removed after the `.gen.<ext>` alternation.
	it("N: a '.gen.ts' substring not at the END of the path is not treated as generated (trailing $ enforced)", () => {
		const directive = `// @ts-${"nocheck"}`;
		const code = `${directive}\nfunction foo() {}`;
		expect(checkFileLevelSuppression(code, "src/foo.gen.ts.bak").length).toBe(1);
	});
	// Kills: "jsx?" -> "jsx" (mandatory x).
	it("N: '.gen.js' (bare, no trailing x) is still recognized as a generated-file extension", () => {
		const directive = `// @ts-${"nocheck"}`;
		const code = `${directive}\nfunction foo() {}`;
		expect(checkFileLevelSuppression(code, "src/foo.gen.js")).toEqual([]);
	});
});

describe("checkUntestableTimeInSource — file-path gates", () => {
	// Kills: `isCliFile(filePath)` -> `false`.
	it("N: does not fire in CLI command files", () => {
		expect(checkUntestableTimeInSource(`const t = Date.now();`, "src/commands/run.ts")).toEqual(
			[],
		);
	});
	// Kills: `!JS_TS_EXTS.has(getExtension(filePath))` -> `false`.
	it("N: does not scan non-JS/TS files", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "src/lib.go")).toEqual([]);
	});
	// Kills: the `"/"` replacement string -> `""` in the Windows-path
	// normalization before TIME_INJECTION_FILE_RE runs.
	it("P: normalizes Windows-style path separators before the injection-file check", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "src\\lib\\clock.ts")).toEqual([]);
	});
	// Kills: `filePath.includes("/scripts/") || filePath.includes("/bench/")`
	// -> `false`, and the `||` -> `&&` (both operands would need to be true
	// simultaneously, which no single path can satisfy).
	it("N: does not fire in scripts/ files", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "src/scripts/seed.ts")).toEqual([]);
	});
});

describe("checkUntestableTimeInSource — MAX_MATCHES cap (5)", () => {
	// Kills: `matches.length >= MAX_MATCHES` -> `false` and
	// -> `matches.length > MAX_MATCHES`.
	it("P: caps untestable-time findings at exactly 5 even with 7 candidates", () => {
		const code = Array.from({ length: 7 }, (_, i) => `const t${i} = Date.now();`).join("\n");
		const matches = checkUntestableTimeInSource(code, TS);
		expect(matches.length).toBe(5);
	});
});

describe("checkUntestableTimeInSource — finding text and callName normalization", () => {
	// Kills: `content.split("\n")` -> `split("")` for `originalLines`; the
	// message template -> ``; `.trim().slice(0, 110)` losing `.slice`;
	// losing `.trim()`.
	it("P: finding text is the exact trimmed original line, with the correct line number", () => {
		const code = ["const a = 1;", "  const t = Date.now();  "].join("\n");
		const matches = checkUntestableTimeInSource(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toBe(
			"untestable nondeterminism (Date.now(): const t = Date.now();",
		);
	});

	// Kills: `.slice(0, 110)` removed while `.trim()` stays.
	it("P: truncates an overlong untestable-time line to 110 chars in the finding text", () => {
		const filler = "x".repeat(200);
		const code = `const t = Date.now(); // ${filler}`;
		const matches = checkUntestableTimeInSource(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text.length).toBeLessThanOrEqual(
			"untestable nondeterminism (Date.now(): ".length + 110,
		);
	});

	// Kills: `/\s+/g` -> `/\S+/g` (strips non-whitespace instead, mangling
	// the call name down to just the spaces). NOTE: the sibling `/\s+/g` ->
	// `/\s/g` (single-char) replacement is a genuinely EQUIVALENT mutant
	// here — both flavors remove ALL whitespace when the replacement is
	// `""` (a run-match and a same-count sequence of single-char matches
	// delete the identical characters), confirmed directly:
	// `"Date  .  now  (".replace(/\s+/g,"")` === `.replace(/\s/g,"")` ===
	// `"Date.now("`. Not claimed as a kill; see notes.
	it("P: callName strips ALL internal whitespace, including doubled spacing", () => {
		const code = "const t = Date  .  now  ();";
		const matches = checkUntestableTimeInSource(code, TS);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("(Date.now():");
	});

	// Kills: the `""` StringLiteral default (unrelated call-name path) ->
	// `"Stryker was here!"` — the literal default only matters when
	// `callName` is genuinely empty, which cannot happen from a real match,
	// so this is exercised as a no-op sanity check that plain code doesn't
	// somehow carry that literal through.
	it("N: does not fire on plain code with no untestable-time call", () => {
		expect(checkUntestableTimeInSource(`const x = 1 + 2;`, TS)).toEqual([]);
	});
});

describe("checkUntestableTimeInSource — elapsed-duration exemption is unaffected by these mutants", () => {
	// Regression guard alongside the boundary work above: elapsedAnchors
	// size-guard mutants (`size > 0` -> `true` / `>= 0`) are SKIPPED as
	// equivalent (see notes) because `isElapsedTimeLine` returns `false` on
	// an empty anchor set regardless of the guard, so this exemption's
	// observable behavior is identical either way. Keep the existing
	// positive/negative pair passing as documentation of that fact.
	it("N: still exempts a genuine start/delta pair", () => {
		const code = ["const start = Date.now();", "doWork();", "const elapsedMs = Date.now() - start;"].join(
			"\n",
		);
		expect(checkUntestableTimeInSource(code, TS)).toEqual([]);
	});
});

describe("checkUntestableTimeInSource — UNTESTABLE_TIME_RE whitespace boundary cases", () => {
	// Kills every `\s*` -> `\S*` site (32 survivors) across all 7 call
	// shapes: each `\s*` needs ACTUAL whitespace present to distinguish it
	// from `\S*` (both trivially match zero characters, so a canonical
	// call() with no spacing can't tell them apart).
	it("P: every call shape still fires with whitespace around every dot/paren", () => {
		const cases = [
			"Date  .  now  ()",
			"new   Date  (  )",
			"Math  .  random  ()",
			"crypto  .  randomUUID  ()",
			"crypto  .  randomBytes  ()",
			"performance  .  now  ()",
			// NOTE: no whitespace between "." and "bigint" — the source pattern
			// is the fixed literal `(?:\.bigint)?` with no \s* inside the group;
			// whitespace is only tolerated before it (after "hrtime").
			"process  .  hrtime  .bigint  ()",
			"process  .  hrtime  ()",
		];
		for (const call of cases) {
			const code = `const x = ${call};`;
			expect(checkUntestableTimeInSource(code, TS).length).toBe(1);
		}
	});
});

describe("checkUntestableTimeInSource — TIME_INJECTION_FILE_RE boundary cases", () => {
	// Kills: `(?:^|\/)` -> `(?:\/)` (drops the start-of-string alternative).
	it("N: a bare top-level 'clock.ts' (no directory prefix) is still recognized as the injection-point file", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "clock.ts")).toEqual([]);
	});
	// Kills: "id-?gen" -> "id-gen" (mandatory hyphen).
	it("N: 'idgen.ts' (no hyphen) is still recognized as an id-generator injection-point file", () => {
		expect(checkUntestableTimeInSource(`crypto.randomUUID();`, "src/idgen.ts")).toEqual([]);
	});
});

// ============================================================================
// WAVE 4 (W6 residue, 2026-08-12) — 21 kills classified via
// scratch/fleet-r3/src_harness_checks_agent-laziness.ts-shadow-verify.mts,
// shadow-verified against the real exported functions (not raw regex
// reasoning — several of the obvious-looking fixtures below were revised
// after the shadow run showed them landing via a DIFFERENT redundant
// detection path than intended). A further 26 residue survivors were
// confirmed genuinely equivalent (subsumed by a sibling regex, or masked by
// the WEAK-phrase self-corroboration path) via
// scratch/fleet-r3/src_harness_checks_agent-laziness.ts-fuzz-equivalence.mts
// (320 diverse inputs per mutant, zero divergence) — not added as tests.
// ============================================================================

describe("checkAgentThumbprintProse — INCOMPLETENESS_SIGNAL_RE additional boundary cases", () => {
	// Kills: the word-arm's `for\s+now` -> `for\S+now` / `for\snow`.
	// NOT a bare "for  now" corroborator line: that independently self-fires
	// via the UNRELATED anchored standalone phrase `^for\s+now\s*[.!…]*$`
	// regardless of this mutation. "well for  now then" carries no other
	// trigger word and is not anchor-shaped, so it can only corroborate via
	// INCOMPLETENESS_SIGNAL_RE's own for\s+now alternative.
	it("P: 'well for  now then' (doubled ws, non-anchor-shaped) still corroborates a weak phrase", () => {
		const code = ["// in practice this needs a second look", "// well for  now then"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
	// Kills: the return-arm's `\{\s*\}` -> `\{\S*\}` (interior space inside braces).
	it("P: 'return { };' (interior space inside braces) still corroborates a weak phrase", () => {
		const code = ["// in practice this needs a second look", "return { };"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
	// Kills: the return-arm's `\[\s*\]` -> `\[\S*\]` (interior space inside brackets).
	it("P: 'return [ ];' (interior space inside brackets) still corroborates a weak phrase", () => {
		const code = ["// in practice this needs a second look", "return [ ];"].join("\n");
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — hardcod(?:ed?|ing) 'ing' form isolates the standalone regex", () => {
	// The item-2 confession-verb regex's `hardcoded?` alternative redundantly
	// covers bare "hardcode"/"hardcoded", but NOT "hardcoding" — so the
	// standalone `/\bhardcod(?:ed?|ing)\s+for\s+now\b/i` regex's OWN spacing
	// mutants are only independently observable via the "-ing" form.
	// Kills: `for\s+now` -> `for\S+now` / `for\snow`.
	it("P: 'hardcoding for  now' (doubled inner-gap ws, -ing form) still fires", () => {
		expect(checkAgentThumbprintProse("// hardcoding for  now", TS).length).toBeGreaterThan(0);
	});
	// Kills: `\s+for` -> `\sfor` / `\S+for`.
	it("P: 'hardcoding  for now' (doubled outer-gap ws, -ing form) still fires", () => {
		expect(checkAgentThumbprintProse("// hardcoding  for now", TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — 'in (the)? real/final/actual/production version/app/code'", () => {
	// Kills: `(?:the\s+)?` -> `(?:the\s+)` (mandatory "the"). "code" is not in
	// item 1's noun list (implementation/production/app/.../version/scenario),
	// so unlike "version"/"app" it never redundantly falls through to item 1
	// — isolating item G's own optional "the" cleanly.
	it("P: 'in real code' (no 'the') still fires — not redundantly covered by item 1's noun list", () => {
		expect(checkAgentThumbprintProse("// in real code", TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — COMMENT_BODY_RE marker-count boundary cases", () => {
	// Technique: an EXTRA repeated marker character (a 3rd slash/star/hyphen,
	// or a missing mandatory post-marker separator) leaks into the LAZILY
	// captured comment body under each mutant, breaking the fully-ANCHORED
	// standalone phrase `^for\s+now\s*[.!…]*$` — while the WEAK "for now"
	// copy can't rescue it: corroboration blanks the hit line's own weak
	// phrases before testing for a signal (self-corroboration is
	// deliberately blocked), and there is no neighbor line in these
	// single-line fixtures.
	// Kills: `\/\*+` -> `\/\*`.
	it("P: '/** for now' (extra leading '*') still fires — leftover doesn't leak into a false non-match", () => {
		expect(checkAgentThumbprintProse("/** for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: `--+` -> `--`.
	it("P: '--- for now' (extra leading '-') still fires", () => {
		expect(checkAgentThumbprintProse("--- for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: `#+` -> `#`.
	it("P: '## for now' (extra leading '#') still fires", () => {
		expect(checkAgentThumbprintProse("## for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: `\/\/+` -> `\/\/`.
	it("P: '/// for now' (extra leading '/') still fires", () => {
		expect(checkAgentThumbprintProse("/// for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: the jsdoc-continuation arm's `\s\*+` -> `\s\*`.
	it("P: ' ** for now' (extra leading '*', jsdoc-continuation marker) still fires", () => {
		expect(checkAgentThumbprintProse(" ** for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: `<!--+` -> `<!--`.
	it("P: '<!--- for now' (extra leading '-') still fires", () => {
		expect(checkAgentThumbprintProse("<!--- for now", TS).length).toBeGreaterThan(0);
	});
	// Kills: the closing-marker `\*+\/` -> `\*\/` — this time an extra '*'
	// leaks in as TRAILING garbage (appended to the body, not prepended),
	// which breaks the anchored phrase's trailing `\s*[.!…]*$` (asterisk is
	// not in the allowed trailing punctuation class).
	it("P: '/* for now **/' (extra closing '*') still fires — trailing leftover doesn't leak into a false non-match", () => {
		expect(checkAgentThumbprintProse("/* for now **/", TS).length).toBeGreaterThan(0);
	});
	// Kills: the post-marker separator `\s*` -> `\s` (mandatory). A marker
	// with NO following space fails to match COMMENT_BODY_RE at all under
	// the mutant (mandatory-one whitespace unsatisfied), skipping the line
	// entirely instead of extracting "for now".
	it("P: '//for now' (no space after the marker) still fires", () => {
		expect(checkAgentThumbprintProse("//for now", TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — TODO ... implement colon optionality", () => {
	// Kills: `:?` -> `:` (mandatory colon).
	it("P: 'TODO implement this' (no colon) still fires", () => {
		expect(checkAgentThumbprintProse("// TODO implement this", TS).length).toBeGreaterThan(0);
	});
});

describe("checkAgentThumbprintProse — confession-verb regex filler-cap boundary", () => {
	// Kills: `\s+.{0,20}for` -> `\s.{0,20}for`. A 25-space run after the verb
	// exceeds the {0,20} filler cap once the mutant's single mandatory `\s`
	// consumes only ONE of the 25 spaces, leaving 24 for `.{0,20}` to absorb
	// (max 20 < 24 — impossible). Uses "faked" (not hardcode/mock/stub):
	// those three have standalone regexes elsewhere with an UNLIMITED `\s+`
	// that would redundantly absorb all 25 spaces regardless of this
	// mutation (verified directly) — "faked" has no such standalone
	// fallback and is not an INCOMPLETENESS_SIGNAL_RE word either.
	it("P: a 25-space run after 'faked' still fires (unlimited \\s+ tolerance)", () => {
		const code = `// faked${" ".repeat(25)}for now`;
		expect(checkAgentThumbprintProse(code, TS).length).toBeGreaterThan(0);
	});
});

describe("checkUntestableTimeInSource — /scripts// /bench// exclusion boundary", () => {
	// Kills: `filePath.includes("/scripts/") || filePath.includes("/bench/")`
	// -> `false` (exclusion disabled entirely) AND -> `&&` (requires BOTH
	// substrings present, not either). "build-thing.ts" deliberately avoids
	// TIME_INJECTION_FILE_RE's own trigger words (clock/time/random/rng/
	// seed/uuid/id-?gen/timestamp/nonce/crypto) so THAT earlier, unrelated
	// exclusion can't mask this one — an existing fixture using "seed.ts"
	// was accidentally shadowed by TIME_INJECTION_FILE_RE's "seed" trigger.
	it("N: a /scripts/ path with no /bench/ still skips (OR, not AND; exclusion not disabled)", () => {
		expect(checkUntestableTimeInSource(`Date.now();`, "src/scripts/build-thing.ts")).toEqual([]);
	});
});
