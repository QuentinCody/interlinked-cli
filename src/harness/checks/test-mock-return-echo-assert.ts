// interlinked-tdd: exempt
// Assertion classification + fire decision for `checkMockReturnEcho`
// (test-mock-return-echo.ts). Extracted to a sibling module to keep the
// orchestrator under the per-file line cap.

import { nonNull } from "../../lib/non-null.js";
import { findCallSpan } from "./test-hygiene-shared.js";
import { COARSE_LITERALS, displayLiteral, extractLiteralsFromText } from "./test-mock-return-echo-mocks.js";
import type { Block } from "./test-mock-return-echo-types.js";

/** Matchers that assert a RETURN VALUE / STATE, as opposed to a call
 *  interaction. The shape this check targets: every one of these in a block
 *  echoing only mock-supplied literals. */
const VALUE_MATCHERS = new Set([
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toContain",
	"toMatch",
	"toHaveProperty",
	"toMatchObject",
]);

/** Matchers that pin a spy/mock's CALL ARGUMENTS — a real behavioral claim,
 *  never a value echo (exemption b). */
const CALL_PIN_MATCHERS = new Set([
	"toHaveBeenCalledWith",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toBeCalledWith",
	"lastCalledWith",
	"nthCalledWith",
	"toHaveBeenCalledExactlyOnceWith",
]);

const EXPECT_RE = /\bexpect\s*\(/g;
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;

/** `<ident>.<prop>… ===`/`==` a literal — a property compared as a LOOKUP or
 *  discriminator key (`.find((f) => f.tool === "biome")`, a plain filter
 *  condition), not a value the SUT is asserted to have forwarded. */
const FILTER_KEY_EQ_RE =
	/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*===?\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|-?\d+(?:\.\d+)?\b|true|false|null)/g;

/**
 * Every literal used as the right-hand side of a property equality check
 * (`x.prop === "lit"`) inside `[start, end)` — a lookup/filter key, not proof
 * the SUT forwarded that value. Subtracted from a block's mock-supplied
 * literal set before echo comparison, so a test that merely uses a mock's
 * discriminator field to `.find()` a record doesn't read as an echo of that
 * discriminator on an unrelated asserted field.
 */
export function collectFilterKeyLiterals(content: string, masked: string, start: number, end: number): Set<string> {
	const out = new Set<string>();
	FILTER_KEY_EQ_RE.lastIndex = start;
	let m: RegExpExecArray | null = FILTER_KEY_EQ_RE.exec(masked);
	while (m !== null && m.index < end) {
		for (const lit of extractLiteralsFromText(content.slice(m.index, m.index + m[0].length))) out.add(lit);
		m = FILTER_KEY_EQ_RE.exec(masked);
	}
	return out;
}

type ExpectKind = "value" | "call-pin" | "skip" | "unresolved";

interface ExpectInfo {
	kind: ExpectKind;
	literals: Set<string>;
	subjectTransformed: boolean;
	/** True when a `value`-matcher's EXPECTED-side argument mixes a
	 *  non-keyword identifier into an otherwise literal expression (e.g.
	 *  `toBe(fixedNow - 12345)`) — the matched literal only coincides with a
	 *  mock's, it isn't the whole story. Always false for other kinds. */
	argsComputed: boolean;
	/** End index (exclusive) of the whole `expect(...)matcher(...)` call, or
	 *  the `expect(` subject span's end when the matcher couldn't be resolved
	 *  — used to advance the scan past this assertion. */
	consumedEnd: number;
}

/** True when `subjectMasked` (an `expect(...)` argument) contains a call or
 *  an arithmetic operator — a visible transformation of whatever value it
 *  wraps (exemption f), not a bare pass-through reference. */
function isTransformedSubject(subjectMasked: string): boolean {
	const trimmed = subjectMasked.trim();
	if (trimmed.includes("(")) return true;
	return /[+\-*/%]/.test(trimmed.replace(/^-/, ""));
}

const OBJECT_KEY_RE = /[A-Za-z_$][\w$]*\s*:/g;
const LITERAL_KEYWORD_RE = /\b(?:true|false|null|undefined)\b/g;

/** True when `argsMasked` (a value-matcher's expected-side argument, string
 *  contents already blanked) is built ONLY from literal syntax — object/array
 *  structure, numbers, and the literal keywords — with no other identifier
 *  reference contributing to the value. Object/array KEYS are exempted (they
 *  are static, not a computed value); any other bare identifier (a variable,
 *  a function call) means the expression is computed, not a pure literal. */
function isPureLiteralArg(argsMasked: string): boolean {
	const withoutKeys = argsMasked.replace(OBJECT_KEY_RE, ":");
	const withoutKeywords = withoutKeys.replace(LITERAL_KEYWORD_RE, "");
	return !/[A-Za-z_$]/.test(withoutKeywords);
}

/** Classify one `expect(...)` assertion whose subject argument list opens at
 *  `argStart` (just past `expect(`) in a masked block body. Returns null
 *  when the subject's own parens never balance (truncated block). */
function classifyExpect(content: string, masked: string, argStart: number): ExpectInfo | null {
	const subjectSpan = findCallSpan(masked, argStart);
	if (subjectSpan === null) return null;
	const chain = MATCHER_CHAIN_RE.exec(masked.slice(subjectSpan.end + 1));
	if (chain === null) {
		return {
			kind: "unresolved",
			literals: new Set(),
			subjectTransformed: false,
			argsComputed: false,
			consumedEnd: subjectSpan.end + 1,
		};
	}
	const segments = nonNull(chain[1])
		.split(".")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const matcher = segments[segments.length - 1] ?? "";
	const matcherArgsStart = subjectSpan.end + 1 + chain[0].length;
	const matcherSpan = findCallSpan(masked, matcherArgsStart);
	const consumedEnd = matcherSpan === null ? matcherArgsStart : matcherSpan.end + 1;
	if (segments.includes("not") || segments.includes("rejects") || matcher === "toThrow") {
		return { kind: "unresolved", literals: new Set(), subjectTransformed: false, argsComputed: false, consumedEnd };
	}
	const argsText = matcherSpan === null ? "" : content.slice(matcherArgsStart, matcherSpan.end);
	if (CALL_PIN_MATCHERS.has(matcher)) {
		return {
			kind: "call-pin",
			literals: extractLiteralsFromText(argsText),
			subjectTransformed: false,
			argsComputed: false,
			consumedEnd,
		};
	}
	if (VALUE_MATCHERS.has(matcher)) {
		const subjectMasked = masked.slice(argStart, subjectSpan.end);
		const argsMasked = matcherSpan === null ? "" : masked.slice(matcherArgsStart, matcherSpan.end);
		return {
			kind: "value",
			literals: extractLiteralsFromText(argsText),
			subjectTransformed: isTransformedSubject(subjectMasked),
			argsComputed: !isPureLiteralArg(argsMasked),
			consumedEnd,
		};
	}
	return { kind: "unresolved", literals: new Set(), subjectTransformed: false, argsComputed: false, consumedEnd };
}

/** Running tally kept while scanning one `it` block's assertions. */
interface BlockTally {
	sawValue: boolean;
	hasReal: boolean;
	echoAssertions: number;
	totalAssertions: number;
	allCoarse: boolean;
	sampleLiteral: string;
}

function newTally(): BlockTally {
	return { sawValue: false, hasReal: false, echoAssertions: 0, totalAssertions: 0, allCoarse: true, sampleLiteral: "" };
}

/** Fold a `call-pin` assertion into the tally — real evidence when it pins a
 *  literal the mock never supplied (exemption b, second clause). */
function foldCallPin(tally: BlockTally, info: ExpectInfo, mockLiterals: Set<string>): void {
	tally.totalAssertions++;
	for (const lit of info.literals) {
		if (!mockLiterals.has(lit)) {
			tally.hasReal = true;
			return;
		}
	}
}

/** Fold a `value` assertion into the tally per the echo/real/ambiguous rules. */
function foldValue(tally: BlockTally, info: ExpectInfo, mockLiterals: Set<string>): void {
	tally.totalAssertions++;
	tally.sawValue = true;
	if (info.subjectTransformed) {
		tally.hasReal = true; // exemption (f)
		return;
	}
	if (info.argsComputed) {
		tally.hasReal = true; // expected-side computation — not a bare literal echo
		return;
	}
	if (info.literals.size === 0) {
		tally.hasReal = true; // no literal to confirm an echo — ambiguous, conservative
		return;
	}
	for (const lit of info.literals) {
		if (!mockLiterals.has(lit)) {
			tally.hasReal = true; // exemption (a)
			return;
		}
	}
	tally.echoAssertions++;
	for (const lit of info.literals) {
		if (tally.sampleLiteral === "") tally.sampleLiteral = displayLiteral(lit);
		if (!COARSE_LITERALS.has(lit)) tally.allCoarse = false;
	}
}

/** Fold one classified assertion into the running tally. */
function foldAssertion(tally: BlockTally, info: ExpectInfo, mockLiterals: Set<string>): void {
	if (info.kind === "skip") return;
	if (info.kind === "unresolved") {
		tally.totalAssertions++;
		tally.hasReal = true; // unrecognized shape — conservative, suppresses fire
		return;
	}
	if (info.kind === "call-pin") {
		foldCallPin(tally, info, mockLiterals);
		return;
	}
	foldValue(tally, info, mockLiterals);
}

/** Verdict for a confirmed mock-return-echo block. */
export interface EchoVerdict {
	/** Human-readable form of the echoed literal, for the warning message. */
	display: string;
}

/**
 * Scan every `expect(...)` assertion in `itBlock` against `mockLiterals` (the
 * literal values supplied by same-scope mock configurations) and decide
 * whether the block is a mock-return echo. Returns null when it is not.
 */
export function evaluateItBlock(
	content: string,
	masked: string,
	itBlock: Block,
	mockLiterals: Set<string>,
): EchoVerdict | null {
	const tally = newTally();
	EXPECT_RE.lastIndex = itBlock.argsStart;
	let m: RegExpExecArray | null = EXPECT_RE.exec(masked);
	while (m !== null && m.index < itBlock.end) {
		const argStart = m.index + m[0].length;
		const info = classifyExpect(content, masked, argStart);
		if (info === null) {
			tally.hasReal = true;
			break;
		}
		foldAssertion(tally, info, mockLiterals);
		EXPECT_RE.lastIndex = info.consumedEnd;
		m = EXPECT_RE.exec(masked);
	}
	if (!tally.sawValue || tally.hasReal || tally.echoAssertions === 0) return null;
	if (tally.allCoarse && tally.totalAssertions > 1) return null;
	return { display: tally.sampleLiteral };
}
