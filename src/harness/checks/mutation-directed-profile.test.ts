import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyRemovedAssertions,
	detectRemovedAssertions,
	evaluateMutationDirectedSignals,
	isMutationDirectedFile,
	type MutationDirectedProfileArgs,
	REMOVED_ASSERTION_CHECK_ID,
} from "./mutation-directed-profile.js";
import { TRUNCATION_SUMMARY_PREFIX } from "./test-legitimacy.js";

const MUTATION_PATH = "src/lib/widget.mutation-kill.test.ts";
const ORDINARY_PATH = "src/lib/widget.test.ts";
const CONTRACT = "// test-contract: invariant — result must be truthy after processing";

function args(overrides: Partial<MutationDirectedProfileArgs> & { content: string }): MutationDirectedProfileArgs {
	return { filePath: MUTATION_PATH, baselineContent: null, ...overrides };
}

describe("isMutationDirectedFile", () => {
	it("P1: matches .mutation-kill., .mutation-hardening., .survivor., .survivors.", () => {
		expect(isMutationDirectedFile("a/b.mutation-kill.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.mutation-hardening.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.survivor.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.survivors.test.ts")).toBe(true);
	});

	it("N1: does not match an ordinary test file", () => {
		expect(isMutationDirectedFile(ORDINARY_PATH)).toBe(false);
	});
});

describe("evaluateMutationDirectedSignals — GATE 1 severity remap (reuses shipped detectors)", () => {
	it("N1: non-mutation-directed file yields no outcomes at all", () => {
		const found = evaluateMutationDirectedSignals(
			args({ filePath: ORDINARY_PATH, content: 'it("x", () => expect(1).toBeTruthy());' }),
		);
		expect(found).toEqual([]);
	});

	it("P1: a mutation-directed case with no contract marker is INTRODUCED (null baseline = strict)", () => {
		const [legitimacy] = evaluateMutationDirectedSignals(
			args({ content: 'it("covers the survivor", () => expect(render()).toEqual("Empty"));' }),
		);
		expect(legitimacy?.checkId).toBe("test_legitimacy");
		expect(legitimacy?.introduced.length).toBeGreaterThan(0);
	});

	it("N2: a receipt-missing case already on disk (identical baseline) is pre-existing, not introduced", () => {
		const content = 'it("covers the survivor", () => expect(render()).toEqual("Empty"));';
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content, baselineContent: content }));
		expect(legitimacy?.introduced).toEqual([]);
		expect(legitimacy?.preexisting.length).toBeGreaterThan(0);
	});

	it("P2: test_missing_sut_import is escalated as its own introduced outcome", () => {
		const outcomes = evaluateMutationDirectedSignals(
			args({
				filePath: "src/lib/widget.mutation-kill.test.ts",
				content: `${CONTRACT}\nit("does a thing", () => expect(1).toEqual(1));`,
			}),
		);
		const sut = outcomes.find((o) => o.checkId === "test_missing_sut_import");
		expect(sut?.introduced.length).toBeGreaterThan(0);
	});

	it("P3: a toBeTruthy() that is the SOLE assertion in its test block escalates", () => {
		const content = [CONTRACT, 'it("case", () => {', "  expect(result).toBeTruthy();", "});"].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.some((m) => m.text.includes("toBeTruthy"))).toBe(true);
	});

	it("N3: a toBeTruthy() alongside a real assertion in the same block does NOT escalate", () => {
		const content = [
			CONTRACT,
			'it("case", () => {',
			"  expect(result.ok).toBeTruthy();",
			"  expect(result.value).toEqual(42);",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.some((m) => m.text.includes("toBeTruthy"))).toBe(false);
	});

	it("N4: an inline-ignored receipt-missing line is dropped, not introduced", () => {
		const content = [
			"// interlinked-ignore: test_legitimacy — deliberately undocumented smoke case",
			'it("smoke", () => expect(render()).toEqual("ok"));',
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced).toEqual([]);
	});
});

describe("detectRemovedAssertions — GATE 2 (new detection: assertion-removal delta)", () => {
	it("N1: non-mutation-directed file — a removed assertion is not flagged", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const found = detectRemovedAssertions(
			args({ filePath: ORDINARY_PATH, content: proposed, baselineContent: baseline }),
		);
		expect(found).toEqual([]);
	});

	it("N2: null baseline (new file) — nothing to have removed", () => {
		const found = detectRemovedAssertions(
			args({ content: 'it("x", () => expect(a).toBe(1));', baselineContent: null }),
		);
		expect(found).toEqual([]);
	});

	it("N3: pure addition — every baseline line survives, one new line added", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toEqual([]);
	});

	it("N4: reordering two identical blocks — multiset match, nothing removed", () => {
		const baseline = [
			'it("first", () => expect(a).toBe(1));',
			'it("second", () => expect(b).toBe(2));',
		].join("\n");
		const proposed = [
			'it("second", () => expect(b).toBe(2));',
			'it("first", () => expect(a).toBe(1));',
		].join("\n");
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toEqual([]);
	});

	it("P1: an entire test case (declaration + assertion) deleted", () => {
		const baseline = [
			'it("kept", () => expect(a).toBe(1));',
			'it("deleted", () => expect(b).toBe(2));',
		].join("\n");
		const proposed = 'it("kept", () => expect(a).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		const lines = found.map((m) => m.text);
		expect(lines.some((t) => t.includes('"deleted"'))).toBe(true);
		expect(lines.some((t) => t.includes("expect(b)"))).toBe(true);
	});

	it("P2: the test survives but one of two assertion lines inside it is removed", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("expect(b)");
	});

	it("P3: multiset — two identical assertion lines in baseline, one survives, one reports removed", () => {
		const baseline = [
			'it("a", () => expect(shared()).toBe(1));',
			'it("b", () => expect(shared()).toBe(1));',
		].join("\n");
		const proposed = 'it("a", () => expect(shared()).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		// One `it(...)` case line removed AND one of the two identical
		// `expect(shared()).toBe(1)` copies removed — the surplus copy, not
		// both (multiset semantics, mirroring splitIntroduced's own contract).
		const expectHits = found.filter((m) => m.text.includes("expect(shared())"));
		expect(expectHits).toHaveLength(1);
	});

	it("file-level suppression drops GATE 2 entirely for the file", () => {
		// projectRoot omitted ⇒ fileSuppressionsFor returns an empty set, so this
		// case only proves the REMOVED_ASSERTION_CHECK_ID constant is what a real
		// verify-suppressions.json entry would need to name; the loader itself is
		// exercised by pre-block-gate.test.ts / suppressions.test.ts.
		expect(REMOVED_ASSERTION_CHECK_ID).toBe("mutation_directed_assertion_removal");
	});
});

describe("mutation-hardening additions (wave 41)", () => {
	// test-contract: invariant — path normalization must replace backslashes with
	// forward slashes, not delete them; deleting them can splice two segments
	// into a false dotted-token match the regex would otherwise reject.
	it("isMutationDirectedFile: a backslash inside the dotted token must NOT be deleted", () => {
		expect(isMutationDirectedFile("a.mutation\\-kill.test.ts")).toBe(false);
	});

	// test-contract: invariant — a receipt-missing finding (not a broad-truthiness
	// one) must be counted exactly once in `introduced`; the truthy-filter stage
	// must not leak it in as a duplicate second entry.
	it("GATE 1: a lone receipt-missing case (no toBeTruthy) yields exactly one introduced finding", () => {
		const content = 'it("case", () => { expect(x).toEqual(1); });';
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.length).toBe(1);
	});

	// test-contract: invariant — a sole toBeTruthy() nested inside describe > it
	// must still escalate; block lookup must find the innermost (it) block, not
	// treat the match as unowned.
	it("GATE 1: a sole toBeTruthy() nested in describe > it still escalates", () => {
		const content = [
			'describe("suite", () => {',
			CONTRACT,
			'  it("case", () => {',
			"    expect(result).toBeTruthy();",
			"  });",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.length).toBe(1);
	});

	// test-contract: invariant — a broad-truthiness match with NO enclosing test
	// block must be safely skipped, never crash the detector.
	it("GATE 1: a truthiness assertion outside any it()/describe() does not throw", () => {
		const content = "expect(x).toBeTruthy();";
		expect(() => evaluateMutationDirectedSignals(args({ content }))).not.toThrow();
	});

	// test-contract: boundary — a truthiness assertion sitting directly inside a
	// describe() (never inside an it()) must NOT escalate; its enclosing block is
	// a suite, not a test.
	it("GATE 1: a truthiness assertion inside describe() but no it() does not escalate", () => {
		const content = ['describe("suite", () => {', "  expect(x).toBeTruthy();", "});"].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced).toEqual([]);
	});

	// test-contract: invariant — the sole-assertion count must be scoped to the
	// truthy match's OWN enclosing block, not the whole file; a second, unrelated
	// it() block's expect() calls must not count against the first block's total.
	it("GATE 1: sole-assertion scoping is per-block, not whole-file", () => {
		const content = [
			CONTRACT,
			'it("first", () => {',
			"  expect(result).toBeTruthy();",
			"});",
			CONTRACT,
			'it("second", () => {',
			"  expect(other).toEqual(1);",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.length).toBe(1);
	});

	// test-contract: boundary — the block-span join must use "\n" so `\bexpect`'s
	// word boundary is preserved across masked-line joins; joining without a
	// separator can merge a preceding token into "expect" and hide a real second
	// assertion, wrongly reading a non-sole toBeTruthy() as sole.
	it("GATE 1: a second same-block expect() hidden only by a joined-newline is still counted", () => {
		const content = [
			CONTRACT,
			'it("case", () => {',
			"  expect(result).toBeTruthy();",
			"x",
			"expect(other).toEqual(1);",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced).toEqual([]);
	});

	// test-contract: boundary — the trailing truncation-count summary line must
	// never itself be treated as a truthiness finding, even when it happens to
	// reuse a line whose real content matches BROAD_TRUTHINESS.
	it("GATE 1: the truncation summary line is never counted as a truthiness finding", () => {
		const filler = Array.from({ length: 19 }, (_, i) => `it("t${i}", () => expect(v${i}).toEqual(${i}));`);
		const case20 = 'it("t20", () => expect(y).toBeTruthy());';
		const case21 = 'it("t21", () => expect(z).toEqual(2));';
		const content = [...filler, case20, case21].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.some((m) => m.text.startsWith(TRUNCATION_SUMMARY_PREFIX))).toBe(false);
	});

	// test-contract: public-api — an inline-ignored sole toBeTruthy() must be
	// dropped from `introduced`, exactly like the already-covered receipt-missing
	// suppression case.
	it("GATE 1: an inline-ignored sole toBeTruthy() is suppressed out of introduced", () => {
		const content = [
			CONTRACT,
			'it("case", () => {',
			"// interlinked-ignore: test_legitimacy — deliberately allowed truthiness smoke check",
			"  expect(result).toBeTruthy();",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced).toEqual([]);
	});

	// test-contract: public-api — an inline-ignored missing-SUT-import finding
	// must be dropped from the test_missing_sut_import outcome's `introduced`.
	it("GATE 1: an inline-ignored missing-SUT-import finding is suppressed", () => {
		const content = [
			"// interlinked-ignore: test_missing_sut_import — deliberately mismatched SUT for smoke test",
			'it("does a thing", () => expect(1).toEqual(1));',
		].join("\n");
		const outcomes = evaluateMutationDirectedSignals(args({ content }));
		const sut = outcomes.find((o) => o.checkId === "test_missing_sut_import");
		expect(sut?.introduced).toEqual([]);
	});

	// test-contract: public-api — the test_legitimacy outcome must carry the
	// registry's real fix_instruction text, not an empty string.
	it("GATE 1: test_legitimacy outcome carries a non-empty instruction", () => {
		const content = 'it("covers the survivor", () => expect(render()).toEqual("Empty"));';
		const outcomes = evaluateMutationDirectedSignals(args({ content }));
		const legitimacy = outcomes.find((o) => o.checkId === "test_legitimacy");
		expect(legitimacy?.instruction.length).toBeGreaterThan(0);
	});

	// test-contract: public-api — the test_missing_sut_import outcome must carry
	// the registry's real fix_instruction text, not an empty string.
	it("GATE 1: test_missing_sut_import outcome carries a non-empty instruction", () => {
		const content = `${CONTRACT}\nit("does a thing", () => expect(1).toEqual(1));`;
		const outcomes = evaluateMutationDirectedSignals(args({ content }));
		const sut = outcomes.find((o) => o.checkId === "test_missing_sut_import");
		expect(sut?.instruction.length).toBeGreaterThan(0);
	});

	// test-contract: invariant — neither GATE 1 outcome is ever deferrable; a
	// mutation-directed severity remap is never a coordinated-refactor transient.
	it("GATE 1: both outcomes report deferrable: false", () => {
		const content = 'it("covers the survivor", () => expect(render()).toEqual("Empty"));';
		const outcomes = evaluateMutationDirectedSignals(args({ content }));
		expect(outcomes.find((o) => o.checkId === "test_legitimacy")?.deferrable).toBe(false);
		expect(outcomes.find((o) => o.checkId === "test_missing_sut_import")?.deferrable).toBe(false);
	});

	// test-contract: boundary — assertionAndCaseLines must return [] for a file
	// that is neither a strict test file nor a JS/TS file, even when it IS
	// mutation-directed (the outer isMutationDirectedFile gate alone is not
	// sufficient to admit scanning).
	it("GATE 2: a mutation-directed but non-test non-JS/TS file is never scanned", () => {
		const baseline = 'it("case", () => expect(a).toBe(1));';
		const proposed = "";
		const found = detectRemovedAssertions(
			args({ filePath: "docs/notes.mutation-kill.md", content: proposed, baselineContent: baseline }),
		);
		expect(found).toEqual([]);
	});

	// test-contract: boundary — the guard is `!isStrictTestFile || !hasJsTsExt`
	// (OR): a strict test file (by directory convention) with a non-JS/TS
	// extension must STILL be skipped — only one side needs to be true.
	it("GATE 2: a mutation-directed file in a tests/ dir with a non-JS/TS extension is still skipped", () => {
		const baseline = 'it("case", () => expect(a).toBe(1));';
		const proposed = "";
		const found = detectRemovedAssertions(
			args({ filePath: "proj/tests/notes.mutation-kill.md", content: proposed, baselineContent: baseline }),
		);
		expect(found).toEqual([]);
	});

	// test-contract: invariant — a plain non-assertion, non-case-declaration line
	// (e.g. a helper const) must never be tracked by assertionAndCaseLines;
	// removing it must not surface as a GATE 2 finding.
	it("GATE 2: removing a benign non-assertion line is not flagged", () => {
		const baseline = 'it("x", () => expect(a).toBe(1));\nconst helper = 1;';
		const proposed = 'it("x", () => expect(a).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toEqual([]);
	});

	// test-contract: invariant — a reported removed match's `.line` must be the
	// 1-based line number of the DELETED line itself (i + 1), not an off-by-one
	// in the other direction.
	it("GATE 2: a removed match reports the correct 1-based line number", () => {
		const baseline = [
			'it("kept", () => expect(a).toBe(1));',
			'it("deleted", () => expect(b).toBe(2));',
		].join("\n");
		const proposed = 'it("kept", () => expect(a).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	// test-contract: boundary — a removed match's `.text` must be capped at 150
	// characters, mirroring every other detector's listing cap.
	it("GATE 2: a removed match's text is capped at 150 characters", () => {
		const longName = "x".repeat(200);
		const baseline = `it("${longName}", () => expect(a).toBe(1));`;
		const proposed = "";
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBe(150);
	});

	// test-contract: invariant — a removed match's `.text` must be the TRIMMED
	// line, with no leading/trailing whitespace from the original source line.
	it("GATE 2: a removed match's text is trimmed of surrounding whitespace", () => {
		const baseline = '  it("case", () => expect(a).toBe(1));  ';
		const proposed = "";
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe('it("case", () => expect(a).toBe(1));');
	});

	// test-contract: security — a file-level verify-suppressions.json entry for
	// REMOVED_ASSERTION_CHECK_ID must suppress GATE 2 entirely for that file,
	// read from a real on-disk suppression file (no inline-comment fallback
	// exists for a deleted line).
	it("GATE 2: a real on-disk file-level suppression drops the finding entirely", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdp-w41-"));
		try {
			mkdirSync(join(dir, ".interlinked"), { recursive: true });
			writeFileSync(
				join(dir, ".interlinked", "verify-suppressions.json"),
				JSON.stringify({
					"widget.mutation-kill.test.ts": { [REMOVED_ASSERTION_CHECK_ID]: { reason: "silenced for test" } },
				}),
			);
			const baseline = [
				'it("kept", () => expect(a).toBe(1));',
				'it("deleted", () => expect(b).toBe(2));',
			].join("\n");
			const proposed = 'it("kept", () => expect(a).toBe(1));';
			const found = detectRemovedAssertions({
				filePath: "widget.mutation-kill.test.ts",
				content: proposed,
				baselineContent: baseline,
				projectRoot: dir,
			});
			expect(found).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — EXPECT_CALL must permit WHITESPACE (not just
	// zero characters) between `expect` and its opening paren, matching real
	// formatted call sites like `expect (x)`.
	it("GATE 2: an expect() call with a space before its paren is still tracked", () => {
		const baseline = "expect (a).toBe(1);";
		const proposed = "";
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
	});
});

const SIBLING_PATH = "src/lib/other.mutation-kill.test.ts";
const TWO_ASSERTIONS = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
const ONE_ASSERTION = 'it("x", () => {\n  expect(a).toBe(1);\n});';

describe("classifyRemovedAssertions — GATE 2 move awareness — positive (must fire)", () => {
	// test-contract: invariant — a removal with no equivalent addition anywhere
	// in the edit is still a removal (the pre-move behavior, unchanged).
	it("P1: a plain removal with nothing added stays removed", () => {
		const out = classifyRemovedAssertions(args({ content: ONE_ASSERTION, baselineContent: TWO_ASSERTIONS }));
		expect(out.removed.map((m) => m.text)).toEqual(["expect(b).toBe(2);"]);
		expect(out.moved).toEqual([]);
	});

	// test-contract: boundary — an addition with the same matcher but a
	// different expected value does not pay for the removal.
	it("P2: an added assertion with a different expected value is not a move", () => {
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(3);\n});';
		const out = classifyRemovedAssertions(args({ content: proposed, baselineContent: TWO_ASSERTIONS }));
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toEqual([]);
	});

	// test-contract: boundary — a sibling whose "addition" was already on its
	// own disk baseline adds nothing, so it cannot pay for the removal.
	it("P3: a sibling line that pre-exists on the sibling's baseline is not an addition", () => {
		const siblingContent = 'it("y", () => {\n  expect(c).toBe(2);\n});';
		const out = classifyRemovedAssertions(
			args({
				content: ONE_ASSERTION,
				baselineContent: TWO_ASSERTIONS,
				siblings: [{ filePath: SIBLING_PATH, content: siblingContent, baselineContent: siblingContent }],
			}),
		);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toEqual([]);
	});

	// test-contract: boundary — a sibling outside the mutation-directed class
	// (plain x.test.ts) cannot pay: the kill evidence left the graded file
	// class even though the assertion text survives in the ChangeSet.
	it("P4: an equivalent addition in a NON-mutation-directed sibling does not pay for the removal", () => {
		const out = classifyRemovedAssertions(
			args({
				content: ONE_ASSERTION,
				baselineContent: TWO_ASSERTIONS,
				siblings: [{ filePath: ORDINARY_PATH, content: 'it("y", () => {\n  expect(b).toBe(2);\n});', baselineContent: null }],
			}),
		);
		expect(out.removed.map((m) => m.text)).toEqual(["expect(b).toBe(2);"]);
		expect(out.moved).toEqual([]);
	});

	// test-contract: boundary — the subject is part of the equivalence key: a
	// renamed subject with the same low-entropy expected value is a rewrite.
	it("P5: a same-file re-add with a RENAMED subject is not a move", () => {
		const proposed = `${ONE_ASSERTION}\nit("y", () => {\n  expect(out.b).toBe(2);\n});`;
		const out = classifyRemovedAssertions(args({ content: proposed, baselineContent: TWO_ASSERTIONS }));
		expect(out.removed.map((m) => m.text)).toEqual(["expect(b).toBe(2);"]);
		expect(out.moved).toEqual([]);
	});
});

describe("classifyRemovedAssertions — GATE 2 move awareness — negative (must not fire)", () => {
	// test-contract: public-api — the assertion moved to another test block in
	// the same file (same subject, different spacing) is a move, not a removal.
	it("N1: same-file move into another test block with the same subject", () => {
		const proposed = `${ONE_ASSERTION}\nit("y", () => {\n  expect( b ).toBe( 2 );\n});`;
		const out = classifyRemovedAssertions(args({ content: proposed, baselineContent: TWO_ASSERTIONS }));
		expect(out.removed).toEqual([]);
		expect(out.moved.map((m) => m.text)).toEqual(["expect(b).toBe(2);"]);
		expect(detectRemovedAssertions(args({ content: proposed, baselineContent: TWO_ASSERTIONS }))).toEqual([]);
	});

	// test-contract: public-api — the assertion moved into a sibling file of
	// the same ChangeSet is a move; the sibling's own baseline is diffed so
	// only its ADDED lines count.
	it("N2: cross-file move into a sibling of the same ChangeSet", () => {
		const siblingBaseline = 'it("y", () => {\n  expect(c).toBe(3);\n});';
		const siblingContent = 'it("y", () => {\n  expect(c).toBe(3);\n  expect( b ).toBe( 2 );\n});';
		const out = classifyRemovedAssertions(
			args({
				content: ONE_ASSERTION,
				baselineContent: TWO_ASSERTIONS,
				siblings: [{ filePath: SIBLING_PATH, content: siblingContent, baselineContent: siblingBaseline }],
			}),
		);
		expect(out.removed).toEqual([]);
		expect(out.moved).toHaveLength(1);
	});

	// test-contract: public-api — a whole test case (declaration + assertion)
	// moved verbatim to a NEW sibling file (null baseline ⇒ every line added).
	it("N3: a whole case moved verbatim into a new sibling file", () => {
		const baseline = 'it("kept", () => expect(a).toBe(1));\nit("moved", () => expect(b).toBe(2));';
		const proposed = 'it("kept", () => expect(a).toBe(1));';
		const sibling = { filePath: SIBLING_PATH, content: 'it("moved", () => expect(b).toBe(2));', baselineContent: null };
		const out = classifyRemovedAssertions(args({ content: proposed, baselineContent: baseline, siblings: [sibling] }));
		expect(out.removed).toEqual([]);
		expect(out.moved).toHaveLength(1);
	});
});
