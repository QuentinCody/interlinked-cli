// Survivor-kill tests for test-hygiene-isolation.ts — sibling to
// test-hygiene-isolation.integration.test.ts. Targets mutants listed in
// scratch/fleet-r2/kill-briefs/src_harness_checks_test-hygiene-isolation.ts.json.
// Each test is designed so its assertion PASSES against the real detector
// and would FAIL under the specific mutant replacement(s) named in its
// comment. Verified empirically against shadow-mutated copies — see
// scratch/probes/isolation-shadow-verify.mts (104/107 rows killed by
// execution; 3 rows are genuine equivalent mutants, proven by fuzzing 800+/
// 500+/20000+ randomized inputs with zero observed divergence — see
// scratch/probes/isolation-equivalence-fuzz.mts and the inline fuzz run
// documented in that probe's sibling notes).
import { describe, expect, it } from "vitest";
import {
	checkHardcodedTimeoutInTests,
	checkRealIoInTests,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "./test-hygiene-isolation.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";
const PY_TEST = "src/lib/test_foo.py";

// ==========================================================================
// checkRealIoInTests
// ==========================================================================
describe("checkRealIoInTests — mutation kill (survivor brief)", () => {
	it("P: reports the exact line number of a network call on a non-first line [bed853c6de3c5321]", () => {
		// Kills: the `i + 1` -> `i - 1` line-number arithmetic mutant for the
		// network-call push. A single-line fixture can't distinguish +1/-1
		// (both give a truthy but different number); this needs the match on
		// line index 1 (source line 2) so +1=2 and -1=0 diverge observably.
		const code = ["const x = 1;", 'fetch("https://api.example.com/x");'].join("\n");
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("P: truncates a long captured URL to 80 chars in the message [a2148c9e80c85b76]", () => {
		// Kills: nonNull(urlMatch[1]).slice(0, 80) -> nonNull(urlMatch[1])
		// (drops the truncation, so the full >80-char URL would appear). A
		// distinctive tail marker (not a homogeneous filler run) is required
		// — a repeated-character filler makes the truncated tail
		// indistinguishable from part of the retained head.
		const longUrl = `https://api.example.com/${"a".repeat(90)}ZEND`;
		const code = `fetch("${longUrl}");`;
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).not.toContain("ZEND");
	});

	it("P: a MEMBER-call write (obj.writeFileSync) is flagged even when the verb name matches a local helper [815a1e5acdb6cbae, 8168ae49d1f15de1, d5a714e029ef123a]", () => {
		// Kills three related mutants on the isMemberCall detection:
		//  - ConditionalExpression `...[fsMatch.index - 1] === "."` -> `false`
		//  - ArithmeticOperator `fsMatch.index - 1` -> `fsMatch.index + 1`
		//  - StringLiteral `"."` -> `""`
		// Each one makes isMemberCall wrongly read as `false` for a REAL
		// member call, so the local-helper name "writeFileSync" would
		// wrongly exempt this member-call write (it should NOT, since the
		// local-helper exemption is for BARE calls to the wrapper, not
		// member calls that happen to share its name).
		const code = [
			"function writeFileSync(name) { return name; }",
			'it("x", () => { obj.writeFileSync("real/path.txt", data); });',
		].join("\n");
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("real/path.txt");
	});

	it("P: the FS-write finding carries the real line and descriptive text, not an empty object [1f6fa238e414c2fc, da811065b56d860b]", () => {
		// Kills: the FS-write ObjectLiteral -> {} mutant and its StringLiteral
		// template -> `` mutant. The existing suite only asserts
		// matches.length for this branch, never .text/.line.
		const matches = checkRealIoInTests(`writeFileSync("real/path.txt", data);`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain('test writes to real filesystem path "real/path.txt"');
	});

	it("P: reports the exact line number of an FS-write not on the first line [6fe17b8f0da4a314]", () => {
		// Kills: the FS-write branch's `i + 1` -> `i - 1` line-number mutant.
		const code = ["const x = 1;", 'writeFileSync("real/path.txt", data);'].join("\n");
		const matches = checkRealIoInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("P: truncates a long FS-write target to 80 chars in the message [7c9ec4995a2d8f76]", () => {
		// Kills: target.slice(0, 80) -> target (drops the truncation).
		const longTarget = `real/${"b".repeat(100)}/file.txt`;
		const matches = checkRealIoInTests(`writeFileSync("${longTarget}", data);`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).not.toContain(longTarget.slice(80));
	});

	it("P: flags axios.get with no whitespace around the dot [f9241ebccc4ba0ae x2]", () => {
		// Kills the NETWORK_CALL_RE variants that remove either the
		// before-dot or after-dot `\s*` down to a mandatory single `\s` —
		// both require whitespace that this zero-space call doesn't have.
		const matches = checkRealIoInTests('axios.get("https://api.example.com/data");', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags axios .get with a space before the dot [f9241ebccc4ba0ae]", () => {
		// Kills the NETWORK_CALL_RE variant swapping the before-dot `\s*` to
		// `\S*` (fails once real whitespace is present).
		const matches = checkRealIoInTests('axios .get("https://api.example.com/data");', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags axios. get with a space after the dot [f9241ebccc4ba0ae]", () => {
		// Kills the NETWORK_CALL_RE variant swapping the after-dot `\s*` to
		// `\S*`.
		const matches = checkRealIoInTests('axios. get("https://api.example.com/data");', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags a bare http.get( call (no trailing s) [f9241ebccc4ba0ae]", () => {
		// Kills the `https?\.` -> `https\.` mutant (makes the "s" mandatory,
		// so plain "http.get(" would stop matching).
		const matches = checkRealIoInTests('http.get("https://api.example.com/data", cb);', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags fetch (...) with a space before the opening paren [f9241ebccc4ba0ae]", () => {
		// Kills the trailing `\s*\(` -> `\S*\(` mutant.
		const matches = checkRealIoInTests('fetch ("https://api.example.com/data");', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags a bare http:// URL literal (no trailing s) [b2338bc89d2524ee]", () => {
		// Kills the `https?` -> `https` mutant on HTTP_LITERAL_URL_RE.
		const matches = checkRealIoInTests('fetch("http://api.example.com/x");', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: captures the FULL URL including its last character [b2338bc89d2524ee]", () => {
		// Kills the closing `["'`]` -> `[^"'`]` mutant: under the mutant, the
		// capture group's own last character gets stolen to serve as the
		// fake "closing quote", so the message would be missing it.
		const matches = checkRealIoInTests('fetch("https://api.example.com/path9");', TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("api.example.com/path9");
	});

	it("P: flags writeFileSync (...) with a space before its opening paren [cb88b680e0fb8dbd, 1d0cac9b4e866fdb]", () => {
		// Kills TWO regexes at once: FS_WRITE_RE's own `\s*\(` -> `\S*\(`
		// after the verb group, AND the separate gate FS_WRITE_CALL_RE's
		// identical `\s*\(` -> `\S*\(` — both fail once real whitespace
		// separates the verb from its call paren.
		const matches = checkRealIoInTests('writeFileSync ("real/path.txt", data);', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags writeFileSync( with a space right after the opening paren [cb88b680e0fb8dbd]", () => {
		// Kills FS_WRITE_RE's `\(\s*["'`]` -> `\(\S*["'`]` mutant.
		const matches = checkRealIoInTests('writeFileSync( "real/path.txt", data);', TEST);
		expect(matches.length).toBe(1);
	});

	it("P: captures the FULL fs-write target including its last character [cb88b680e0fb8dbd]", () => {
		// Kills FS_WRITE_RE's closing `["'`]` -> `[^"'`]` mutant, same
		// stolen-last-character mechanism as the URL regex above.
		const matches = checkRealIoInTests('writeFileSync("real/path9.txt", data);', TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("real/path9.txt");
	});

	it("N: a bare call to a 2-space-defined local helper stays exempt [3000f0a808fd9ae8]", () => {
		// Kills FS_HELPER_DEF_RE's `\s+` -> `\s` mutant (exactly-one, not
		// one-or-more): two spaces after "function" would no longer match
		// the definition, so the helper name would never be registered and
		// this otherwise-exempt bare call would wrongly get flagged.
		const code = [
			"function  writeFileSync(name, bytes) { return name; }",
			'it("x", () => { writeFileSync("real/path.txt", data); });',
		].join("\n");
		expect(checkRealIoInTests(code, TEST)).toEqual([]);
	});

	it("N: a nested tmp/-segment path (not a leading /tmp) stays exempt [1e74d4ec66bc9a26]", () => {
		// Kills TMP_PATH_RE's `[/\\]` -> `[^/\\]` mutant. Deliberately avoids
		// a path that ALSO starts with literal "/tmp" (target.startsWith is
		// an independent, separately-masking exemption clause) so this case
		// isolates TMP_PATH_RE specifically.
		expect(checkRealIoInTests('writeFileSync("src/tmp/output.txt", data);', TEST)).toEqual([]);
	});
});

// ==========================================================================
// identReferencedInAssertions (exercised through checkTestNondeterminism)
// ==========================================================================
describe("checkTestNondeterminism — identReferencedInAssertions escaping", () => {
	it("P: a captured identifier ending in $ is still recognized as referenced in a later assertion [9e7aefb0da51d8c6]", () => {
		// Kills the `"\\$"` -> `""` mutant: without the backslash-escape, the
		// bare "$" dropped from the built RegExp source stops the trailing
		// negative lookahead from tolerating the literal "$" in "stamp$",
		// so the reference would wrongly be reported as NOT found and the
		// capture line would wrongly be exempted as "never asserted".
		const code = [
			'it("a", () => {',
			'  const stamp$ = "t-" + Date.now();',
			"  const result = build();",
			"  expect(result.stamp).toBe(stamp$);",
			"});",
		].join("\n");
		const matches = checkTestNondeterminism(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// TEST_NONDETERMINISM_RE — whitespace-boundary spacing sweep [47525b12edb6162e]
// ==========================================================================
// Every alternative in the big Date/Math/crypto/performance/new-Date
// alternation has 3 (or, for `new Date`, 3 extra) \s*/\s+ boundaries; each
// survivor swaps ONE boundary's quantifier (drop to exactly-one, or flip to
// \S). Zero-space call forms kill the exactly-one variants; single
// deliberately-placed-space forms kill the \S variants. Date.now/Math.random
// already have zero-space MUST-FIRE coverage elsewhere in the suite, so only
// their \S* survivors need new cases here.
describe("checkTestNondeterminism — TEST_NONDETERMINISM_RE spacing sweep", () => {
	it("P: Date .now() with a space before the dot", () => {
		expect(checkTestNondeterminism("use(Date .now());", TEST).length).toBe(1);
	});
	it("P: Date. now() with a space after the dot", () => {
		expect(checkTestNondeterminism("use(Date. now());", TEST).length).toBe(1);
	});
	it("P: Date.now () with a space before the call paren", () => {
		expect(checkTestNondeterminism("use(Date.now ());", TEST).length).toBe(1);
	});
	it("P: Math .random() with a space before the dot", () => {
		expect(checkTestNondeterminism("use(Math .random());", TEST).length).toBe(1);
	});
	it("P: Math. random() with a space after the dot", () => {
		expect(checkTestNondeterminism("use(Math. random());", TEST).length).toBe(1);
	});
	it("P: Math.random () with a space before the call paren", () => {
		expect(checkTestNondeterminism("use(Math.random ());", TEST).length).toBe(1);
	});
	it("P: new Date() — the standard single-space form (no existing coverage at all)", () => {
		expect(checkTestNondeterminism("use(new Date());", TEST).length).toBe(1);
	});
	it("P: new  Date() with two spaces after new", () => {
		expect(checkTestNondeterminism("use(new  Date());", TEST).length).toBe(1);
	});
	it("P: new Date () with a space before the constructor's call paren", () => {
		expect(checkTestNondeterminism("use(new Date ());", TEST).length).toBe(1);
	});
	it("P: new Date( ) with a space inside the empty parens", () => {
		expect(checkTestNondeterminism("use(new Date( ));", TEST).length).toBe(1);
	});
	it("P: crypto.randomUUID() with zero whitespace (no existing coverage at all)", () => {
		expect(checkTestNondeterminism("use(crypto.randomUUID());", TEST).length).toBe(1);
	});
	it("P: crypto .randomUUID() with a space before the dot", () => {
		expect(checkTestNondeterminism("use(crypto .randomUUID());", TEST).length).toBe(1);
	});
	it("P: crypto. randomUUID() with a space after the dot", () => {
		expect(checkTestNondeterminism("use(crypto. randomUUID());", TEST).length).toBe(1);
	});
	it("P: crypto.randomUUID () with a space before the call paren", () => {
		expect(checkTestNondeterminism("use(crypto.randomUUID ());", TEST).length).toBe(1);
	});
	it("P: crypto.randomBytes(16) with zero whitespace (no existing coverage at all)", () => {
		expect(checkTestNondeterminism("use(crypto.randomBytes(16));", TEST).length).toBe(1);
	});
	it("P: crypto .randomBytes(16) with a space before the dot", () => {
		expect(checkTestNondeterminism("use(crypto .randomBytes(16));", TEST).length).toBe(1);
	});
	it("P: crypto. randomBytes(16) with a space after the dot", () => {
		expect(checkTestNondeterminism("use(crypto. randomBytes(16));", TEST).length).toBe(1);
	});
	it("P: crypto.randomBytes (16) with a space before the call paren", () => {
		expect(checkTestNondeterminism("use(crypto.randomBytes (16));", TEST).length).toBe(1);
	});
	it("P: performance.now() with zero whitespace (no existing coverage at all)", () => {
		expect(checkTestNondeterminism("use(performance.now());", TEST).length).toBe(1);
	});
	it("P: performance .now() with a space before the dot", () => {
		expect(checkTestNondeterminism("use(performance .now());", TEST).length).toBe(1);
	});
	it("P: performance. now() with a space after the dot", () => {
		expect(checkTestNondeterminism("use(performance. now());", TEST).length).toBe(1);
	});
	it("P: performance.now () with a space before the call paren", () => {
		expect(checkTestNondeterminism("use(performance.now ());", TEST).length).toBe(1);
	});
});

// ==========================================================================
// checkTestNondeterminism — core logic mutants
// ==========================================================================
describe("checkTestNondeterminism — mutation kill: core logic", () => {
	it("N: a mock-setup call on the SAME line as Date.now() suppresses just that line [75b60bd4ca2aac6a, cc7dc02a3d2f0c0d x2]", () => {
		// Kills the `MOCK_SETUP_LINE_RE.test(strippedLine)` -> `false`
		// conditional mutant, AND (via the zero-space "vi.spyOn(") the two
		// MOCK_SETUP_LINE_RE regex variants that require exactly one \s
		// where zero is present.
		expect(checkTestNondeterminism('vi.spyOn(obj, "method"); const t = Date.now();', TEST)).toEqual([]);
	});

	it("P: reports the exact line number of a lone Date.now() not on the first line [5ca19a995afef24b]", () => {
		const code = ["const x = 1;", "use(Date.now());"].join("\n");
		const matches = checkTestNondeterminism(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("P: the finding carries the real line and descriptive text, not an empty object [ca3017ca69396ae3]", () => {
		// Kills the ObjectLiteral -> {} mutant on checkTestNondeterminism's
		// push (the existing suite only ever asserted .length for this
		// branch, never .text/.line).
		const matches = checkTestNondeterminism(`use(Date.now());`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("without mocking");
	});

	it("P: the nondeterminism finding carries non-empty descriptive text, whitespace fully stripped from the call fragment [b033f8c988b76c47, 899327cf173919aa, 1b9ab8a73c518c8a]", () => {
		// Kills the text-template StringLiteral -> `` mutant, the
		// `.replace(/\s+/g, "")` empty-string -> "Stryker was here!" mutant,
		// AND the `/\s+/g` -> `/\S+/g` mutant: a spaced call normally
		// collapses to a clean "Date.now(" fragment; the \S+/g mutant
		// instead strips every NON-whitespace run, leaving only spaces
		// where "Date.now(" should be, and the "Stryker was here!" mutant
		// injects that literal phrase in place of the whitespace strip —
		// either way this clean-fragment assertion would fail. Matches the
		// full injected phrase, not the bare word "Stryker": the message
		// now also carries the SANDBOX_FRAGILITY_NOTE, whose legitimate
		// text names the Stryker mutation tool by name.
		const matches = checkTestNondeterminism("it(\"a\", () => { const t = Date . now ( ); use(t); });", TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("Date.now(");
	});

	it("P: a nondeterminism call preceded by 85 spaces still shows the trimmed original line [7e6b511de52ff113]", () => {
		// Kills `nonNull(original[i]).trim()` -> `nonNull(original[i])`:
		// without trim, the 85 leading spaces occupy the whole 80-char
		// slice window and the marker would never appear.
		const indent = " ".repeat(85);
		const code = `it("a", () => {\n${indent}const uniqueMarkerXYZ = Date.now(); use(uniqueMarkerXYZ);\n});`;
		const matches = checkTestNondeterminism(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("uniqueMarkerXYZ");
	});

	it("P: truncates the appended original-line snippet to 80 chars after trim [f9b90517fe291c39]", () => {
		// Kills `nonNull(original[i]).trim().slice(0, 80)` ->
		// `nonNull(original[i]).trim()` (drops JUST the truncation while
		// keeping trim — needs a TRIMMED line over 80 chars, not merely a
		// long leading indent, to observe the missing truncation).
		const code = `use(Date.now()); // ${"x".repeat(70)} MARKEREND`;
		const matches = checkTestNondeterminism(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).not.toContain("MARKEREND");
	});

	it("N: an UNRELATED string-concat on the same line must not defeat the nondeterminism-only unique-name exemption [02190c92bfa8903b]", () => {
		// Kills the NONDET_CALL_FRAG StringLiteral -> `` mutant: dropping
		// the fragment loosens UNIQUE_NAME_BUILD_RE to match ANY string
		// concat, so the unrelated `"prefix-" + suffix` on this line would
		// wrongly exempt the (unrelated, unasserted) Date.now() call too.
		const code = 'it("a", () => { const label = "prefix-" + suffix; const t = Date.now(); use(t); });';
		const matches = checkTestNondeterminism(code, TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// LINE_ASSERTS_RE / CAPTURE_ASSIGN_RE / FAKE_CLOCK_FILE_RE spacing sweep
// ==========================================================================
// All four cases below share one shape: a `const stamp = "t-" + Date.now();`
// capture line followed by an assertion line that references `stamp` — the
// capture line MUST be flagged (the nondet value flows into an assertion).
// Each fixture perturbs ONE whitespace boundary that a specific survivor
// mutates, breaking either LINE_ASSERTS_RE's recognition of the assertion
// line or CAPTURE_ASSIGN_RE's recognition of the capture line, which would
// wrongly re-exempt the capture line as "never asserted".
describe("checkTestNondeterminism — LINE_ASSERTS_RE spacing sweep [7a5430ce01dbe3fe]", () => {
	it("P: expect (...) with a space before its call paren is still recognized as an assertion line", () => {
		const code = [
			'it("a", () => {',
			'  const stamp = "t-" + Date.now();',
			"  const result = build();",
			"  expect (result.stamp).toBe(stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});

	it("P: a bare assert(...) call (no .method suffix) is still recognized as an assertion line", () => {
		// Also kills the trailing `\s*\(` -> `\s\(` mutant (this fixture's
		// zero-space-before-paren form).
		const code = [
			'it("a", () => {',
			'  const stamp = "t-" + Date.now();',
			"  const result = build();",
			"  assert(result.stamp === stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});

	it("P: a dotted assert.equal(...) call is still recognized as an assertion line", () => {
		// Kills both the `\.\w+` -> `\.\W+` and `\.\w+` -> `\.\w` mutants:
		// "equal" is multi-char and all-word-chars, so both fail to match
		// the optional method-name suffix.
		const code = [
			'it("a", () => {',
			'  const stamp = "t-" + Date.now();',
			"  const result = build();",
			"  assert.equal(result.stamp, stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});

	it("P: a bare assert (...) call WITH a space before its call paren is still recognized", () => {
		// Kills the trailing `\s*\(` -> `\S*\(` mutant.
		const code = [
			'it("a", () => {',
			'  const stamp = "t-" + Date.now();',
			"  const result = build();",
			"  assert (result.stamp === stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});
});

describe("checkTestNondeterminism — CAPTURE_ASSIGN_RE spacing sweep [43034285cfb7c128]", () => {
	it("N: leading junk before `const` on the SAME line breaks the start-anchored capture (null keeps the exemption)", () => {
		// Kills the `^\s*` -> `\s*` mutant (dropped `^` anchor): without the
		// anchor, capturedIdent would wrongly find "stamp" starting mid-line
		// and (since it IS referenced in the later assert) wrongly un-exempt
		// this line — the real, anchored code can't find "const" here at
		// all (blocked by the "y = 1;" prefix) and so keeps the
		// null-preserves-exemption default.
		const code = [
			'it("a", () => {',
			'  y = 1; const stamp = "t-" + Date.now();',
			"  const result = build();",
			"  expect(result.stamp).toBe(stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("P: two spaces after const still resolves the captured identifier correctly", () => {
		// Kills the `\s+` -> `\s` mutant (exactly-one, not one-or-more).
		const code = [
			'it("a", () => {',
			'  const  stamp = "t-" + Date.now();',
			"  const result = build();",
			"  expect(result.stamp).toBe(stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});

	it("P: zero space around the = sign still resolves the captured identifier correctly", () => {
		// Kills the trailing `\s*=` -> `\s=` mutant.
		const code = [
			'it("a", () => {',
			'  const stamp="t-" + Date.now();',
			"  const result = build();",
			"  expect(result.stamp).toBe(stamp);",
			"});",
		].join("\n");
		expect(checkTestNondeterminism(code, TEST).length).toBe(1);
	});
});

describe("checkTestNondeterminism — FAKE_CLOCK_FILE_RE spacing sweep [020bb534f2a1d873]", () => {
	it("N: vi .useFakeTimers() with a space before the dot still suppresses the whole file", () => {
		const code = ["beforeAll(() => { vi .useFakeTimers(); });", 'it("a", () => { const t = Date.now(); });'].join(
			"\n",
		);
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});

	it("N: vi. useFakeTimers() with a space after the dot still suppresses the whole file", () => {
		const code = ["beforeAll(() => { vi. useFakeTimers(); });", 'it("a", () => { const t = Date.now(); });'].join(
			"\n",
		);
		expect(checkTestNondeterminism(code, TEST)).toEqual([]);
	});
});

describe("checkTestNondeterminism — MOCK_SETUP_LINE_RE spacing sweep [cc7dc02a3d2f0c0d]", () => {
	it("N: vi .spyOn(...) with a space before the dot still suppresses just that line", () => {
		expect(checkTestNondeterminism('vi .spyOn(obj, "x"); const t = Date.now();', TEST)).toEqual([]);
	});

	it("N: vi. spyOn(...) with a space after the dot still suppresses just that line", () => {
		expect(checkTestNondeterminism('vi. spyOn(obj, "x"); const t = Date.now();', TEST)).toEqual([]);
	});
});

// ==========================================================================
// checkHardcodedTimeoutInTests
// ==========================================================================
describe("checkHardcodedTimeoutInTests — mutation kill (survivor brief)", () => {
	it("P: the message includes the real call text, not a single stray character [a60a9204fc4d5f32]", () => {
		// Kills the `"\n"` -> `""` mutant on one of the two `.split("\n")`
		// calls: if `original` becomes content.split("") (per-character),
		// `original[0]` is just the first CHARACTER of the file, not the
		// line — matches.length stays 1 either way (strippedLines is
		// unaffected), but the appended snippet text would collapse to a
		// single stray character instead of the real call.
		const matches = checkHardcodedTimeoutInTests(`await new Promise(r => setTimeout(r, 1234));`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("setTimeout(r, 1234)");
	});

	it("P: the finding carries the real line and descriptive text, not an empty object [45766f28425bf0d2, 58af9deb729a13aa]", () => {
		// Kills the ObjectLiteral -> {} mutant and the text-template
		// StringLiteral -> `` mutant.
		const matches = checkHardcodedTimeoutInTests(`setTimeout(fn, 5000);`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("hardcoded 5000ms wait in test");
	});

	it("P: reports the exact line number of a timeout not on the first line [dabfd96c3c75337a]", () => {
		const code = ["const x = 1;", "setTimeout(fn, 1000);"].join("\n");
		const matches = checkHardcodedTimeoutInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
	});

	it("P: a timeout call preceded by 85 spaces still shows the trimmed original line [d4d70db3d27bf65a]", () => {
		// Kills `nonNull(original[i]).trim()` -> `nonNull(original[i])`.
		const indent = " ".repeat(85);
		const matches = checkHardcodedTimeoutInTests(`${indent}setTimeout(uniqueMarkerABC, 1000);`, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("uniqueMarkerABC");
	});

	it("P: truncates the appended original-line snippet to 80 chars after trim [57c5693f5a385de8]", () => {
		// Kills `nonNull(original[i]).trim().slice(0, 80)` ->
		// `nonNull(original[i]).trim()` (drops JUST the truncation while
		// keeping trim — needs a TRIMMED line over 80 chars, not merely a
		// long leading indent, to observe the missing truncation).
		const code = `setTimeout(fn, 1000); // ${"x".repeat(70)} MARKEREND`;
		const matches = checkHardcodedTimeoutInTests(code, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).not.toContain("MARKEREND");
	});

	it("P: flags setTimeout (...) with a space before its own opening paren [33044f6de4092e29]", () => {
		const matches = checkHardcodedTimeoutInTests("await new Promise(r => setTimeout (r, 1000));", TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags setTimeout(r,1000) with zero space after the comma [33044f6de4092e29]", () => {
		// Kills the `,\s*` -> `,\s` mutant (exactly-one, not zero-or-more).
		const matches = checkHardcodedTimeoutInTests("await new Promise(r => setTimeout(r,1000));", TEST);
		expect(matches.length).toBe(1);
	});

	it("P: flags setTimeout(r, 1000 ) with a space before the closing paren [33044f6de4092e29]", () => {
		// Kills the trailing `\s*\)` -> `\S*\)` mutant.
		const matches = checkHardcodedTimeoutInTests("await new Promise(r => setTimeout(r, 1000 ));", TEST);
		expect(matches.length).toBe(1);
	});
});

// ==========================================================================
// checkTestSubprocessDefaultTimeout / hasExplicitTimeout
// ==========================================================================
describe("checkTestSubprocessDefaultTimeout — mutation kill (survivor brief)", () => {
	it("N: still guards a non-test file EVEN THOUGH it() is present [7656645e3836373c]", () => {
		// Kills `!isStrictTestFile(filePath)` -> `false`. The existing
		// negative test for this file-kind gate has no it()/test() wrapper
		// at all, so it can't observe the guard being skipped — this one
		// deliberately includes a qualifying it() body.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, SRC)).toEqual([]);
	});

	it("N: still guards a non-JS/TS file EVEN THOUGH it() is present [1686fd96fbec7877]", () => {
		// Kills `!JS_TS_EXTS.has(getExtension(filePath))` -> `false`.
		const code = [
			'require("child_process");',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, PY_TEST)).toEqual([]);
	});

	it("N: still guards content with no literal child_process text EVEN THOUGH it() spawns a slow tool [8dc0df0adf8ef87c]", () => {
		// Kills `!/child_process/.test(content)` -> `false`.
		expect(checkTestSubprocessDefaultTimeout('it("typechecks", () => { execSync("npx tsc --noEmit"); });', TEST)).toEqual(
			[],
		);
	});

	it("N: a slow-tool token appearing only in a COMMENT outside the it() body must not leak in [5981dd4325bcc00e]", () => {
		// Kills `content.slice(argsStart, span.end)` -> `content` for
		// bodyOriginal (the SLOW_TOOL_RE check target). The it() body itself
		// spawns via a variable, never mentioning "tsc" literally.
		const code = [
			"// runs tsc under the hood via a helper",
			'import { execSync } from "node:child_process";',
			"const cmd = getCommand();",
			'it("runs a command", () => { execSync(cmd); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("N: a spawn call OUTSIDE the it() body must not leak in as if it were inside [96665678fc87809b]", () => {
		// Kills `stripped.slice(argsStart, span.end)` -> `stripped` for
		// bodyStripped (the CHILD_PROCESS_SPAWN_RE check target). The it()
		// body itself never spawns; only its NAME mentions "tsc".
		const code = [
			'import { execSync } from "node:child_process";',
			'execSync("setup");',
			'it("typechecks via tsc", () => { runHelper(); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("P: an explicit timeout on ONE it() call must not exempt a sibling it() call [caaa8cf11e7b3453]", () => {
		// Kills hasExplicitTimeout's OWN `stripped.slice(argsStart,
		// span.end)` -> `stripped` mutant: with the whole file substituted
		// in, the first call's `{ timeout: 5000 }` would wrongly satisfy
		// the second call's own timeout check too.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("first case", { timeout: 5000 }, () => { doSomethingFast(); });',
			'it("second case", () => { execSync("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("P: flags execSync (...) with a space before its own opening paren [d23047e99dd04992]", () => {
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync ("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("P: recognizes a slow-tool token at the ABSOLUTE start of the args list, with no leading quote [484b50b555fb724b]", () => {
		// Kills SLOW_TOOL_RE's dropped `^` alternative: the leading-boundary
		// class alone (quote/space/slash) can't match "nothing precedes me".
		const code = [
			'import { execSync } from "node:child_process";',
			'const cmd = "irrelevant";',
			"it(tsc , () => { execSync(cmd); });",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("P: recognizes a slow-tool token preceded by a REAL space inside a string, not a quote [484b50b555fb724b]", () => {
		// Kills SLOW_TOOL_RE's `[\"'`\s/]` -> `[\"'`\S/]` mutant: only "npx"
		// (quote-preceded) would otherwise mask the space-preceded "tsc".
		const code = [
			'import { execSync } from "node:child_process";',
			'it("please run tsc for me", () => { execSync(getCmd()); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("P: recognizes a slow-tool token at the ABSOLUTE end of the args list, with nothing after it [484b50b555fb724b]", () => {
		// Kills SLOW_TOOL_RE's dropped `$` trailing alternative.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("x", () => { execSync(cmd); }, tsc);',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("N: { timeout: N } with zero chars between the brace and 'timeout' still counts as explicit [6908fd734726285b]", () => {
		// Kills TIMEOUT_OPTION_RE's `[^{}]*` -> `[^{}]` mutant (exactly-one).
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", {timeout: 60000}, () => { execSync("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("N: { timeout : N } with a space before the colon still counts as explicit [6908fd734726285b]", () => {
		// Kills TIMEOUT_OPTION_RE's `\btimeout\s*:` -> `\btimeout\S*:` mutant.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", { timeout : 60000 }, () => { execSync("npx tsc --noEmit"); });',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("P: a trailing identifier ending in digits (not a bare number) is NOT an explicit timeout [febf127464fc7c0f]", () => {
		// Kills TRAILING_NUMERIC_RE's dropped `^` anchor: unanchored, the
		// embedded "60000" suffix of "foo60000" would wrongly match.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); }, foo60000);',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("P: digits followed by trailing junk are NOT an explicit timeout [febf127464fc7c0f]", () => {
		// Kills TRAILING_NUMERIC_RE's dropped `$` anchor: without it, the
		// leading "60000" prefix of "60000foo" would wrongly match.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); }, 60000foo);',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST).length).toBe(1);
	});

	it("N: a trailing number with ZERO leading whitespace is still an explicit timeout [febf127464fc7c0f x2]", () => {
		// Kills both `^\s*` -> `^\s` (exactly-one leading ws) AND `[0-9]` ->
		// `[^0-9]` (negated first digit): with a real leading space present
		// elsewhere, either mutant is masked by the space itself satisfying
		// the mutated class; zero leading whitespace closes both escapes.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); },60000);',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});

	it("N: a trailing number with a trailing space before the closing paren is still an explicit timeout [febf127464fc7c0f]", () => {
		// Kills the trailing `\s*$` -> `\S*$` mutant.
		const code = [
			'import { execSync } from "node:child_process";',
			'it("typechecks", () => { execSync("npx tsc --noEmit"); }, 60000 );',
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(code, TEST)).toEqual([]);
	});
});
