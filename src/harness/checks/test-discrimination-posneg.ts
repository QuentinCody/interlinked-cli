// CLASS: positive and negative cases assert indistinguishable outcomes.
// FIRES WHEN: sibling cases classified by P/N labels, ancestor labels, then
// title vocabulary assert the same literal on the same normalized target;
// the negative literal set is a subset and the target is invariant file-wide.
// DOES NOT FIRE: another expected value anywhere for that target, a distinct
// negative literal, input echoes, constant fields, or trivial sentinel literals.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits | inspected precision | correction |
// | builder final | 362 | 87% builder estimate | estimate was unreliable |
// | independent wave | 354 | 15 TP / 105 inspected | 90 legitimate guard pairs |
// | round 1 | 1 | 1/1 reviewed TP | full literal sets and file-wide invariance |
// KNOWN GAPS: title direction and textual target identity remain heuristics;
// recall is deliberately narrow. No mutation-survival claim is proven.
// HOW TO EXTEND: change literal-set or direction helpers with labeled P/N
// companions and remeasure on another corpus. Census: scripts/scan-test-discrimination.ts.

import { directionFromTitle } from "../check-evidence/case-parser.js";
import { stripAllLiterals } from "../strip-helpers.js";
import { type InlineMatch, isTestFile } from "./shared.js";
import { buildTargetLiteralSets, collectTargetMembers, computeExpectedLiteralSet, isLiteralSubset, isTargetInvariantAcrossFile } from "./test-discrimination-posneg-literals.js";
import { findCallSpan } from "./test-hygiene-shared.js";
import { extractTestBlocks, type TestBlock } from "./test-structure.js";

const MAX_MATCHES = 10;
const TITLE_WINDOW_LINES = 8;

// Copied from test-hygiene-quality.ts's NEGATIVE_NAME_RE — see file header.
const NEGATIVE_TITLE_RE =
	/\b(?:error|errors|throw|throws|throwing|reject|rejects|rejected|fail|fails|failing|failure|invalid|malformed|missing|absent|empty|not|no|without|negative|guard|guards|block|blocks|blocked|deny|denies|denied|forbidden|unauthorized|refuse|refuses|crash|crashes|abort|aborts|edge|bad|wrong|conflict|unsupported|null|undefined|false|exception|raises?|catch|404|500|nonexistent)\b/i;

// A title's own `N`/`N1`/`N12:` (or `P`/`P1`/`P12:`) prefix — the Check
// Evidence Contract's per-case convention, generalized to an optional digit
// count so a bare "N: …"/"P: …" (used elsewhere in this repo) matches too.
const NEG_PREFIX_RE = /^N\d*[:\s-]/;
const POS_PREFIX_RE = /^P\d*[:\s-]/;

const BLOCK_TITLE_RE =
	/^\s*(?:it|test|specify|describe|suite|context)\s*(?:\.\s*\w+\s*(?:\([^()]*\))?\s*)*\(\s*(["'`])((?:(?!\1)[\s\S])*?)\1/;

// Matchers whose SOLE argument, when a literal, expresses the expected outcome.
const LITERAL_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toThrow", "toMatch"]);

// Numeric-literal shape — checked against the MASKED argument text (identical
// to the raw text for a number; no literal content to blank).
//
// Calibration note: the shape originally also covered boolean/null/undefined/
// `[]`/`{}` (the falsifier corpus's full literal vocabulary), but a repo-wide
// scan (`scratch/test-quality-checks/duplicate_expected_literal_pos_neg-scan.mts`)
// showed those shapes are dominated by coincidental collisions — `toBe(true)`/
// `toBe(false)` and `toEqual([])`/`toStrictEqual({})` are extremely common,
// target-normalization strips call arguments, and two unrelated tests sharing
// a boolean/empty-collection outcome is the normal shape of a test suite, not
// a duplicated-assertion smell. Restricting to number/string/template
// literals (the ones actually informative enough to say "these two tests
// assert the identical DISTINCTIVE outcome") dropped hits from 3386/901 files.
// A second round then excluded TRIVIAL sentinels (see `isTrivialNumber` /
// `isTrivialString`) — 0/1/-1/100 and short/common strings collide across
// unrelated scenarios just as often as the booleans did.
const LITERAL_SIMPLE_RE = /^-?\d+(?:\.\d+)?$/;

// Sentinel values common enough, as a bare outcome, to be uninformative even
// when they DO match target+literal across a negative/positive pair.
const TRIVIAL_NUMBER_VALUES = new Set(["0", "1", "-1", "100"]);
const TRIVIAL_STRING_VALUES = new Set(["", " ", "ok", "local", "none", "unknown", "default"]);

/** A number literal (exact matched text, e.g. `-1`, `42`) too trivial to count. */
function isTrivialNumber(rawNumber: string): boolean {
	return TRIVIAL_NUMBER_VALUES.has(rawNumber) || rawNumber.length < 2;
}

/** A quoted/backtick string literal (WITH delimiters) too trivial to count:
 *  its content is under two characters, or is one of the common sentinels. */
function isTrivialString(rawQuoted: string): boolean {
	const inner = rawQuoted.slice(1, -1);
	return inner.length < 2 || TRIVIAL_STRING_VALUES.has(inner.toLowerCase());
}

interface TestAssertion {
	target: string;
	literal: string;
	/** Index (into the block's body) of the `expect(` call's own start —
	 *  the input-echo check searches only text BEFORE this. */
	exprStart: number;
	/** Does the `expect(...)` SUBJECT contain a call (a `(`)? No call anywhere,
	 *  and no call-derived alias in either sibling's body, is a bare constant
	 *  field — see `isConstantFieldTarget`. */
	subjectHasCall: boolean;
}

type Direction = "positive" | "negative";

interface TestInfo {
	parent: number;
	startLine: number;
	title: string;
	direction: Direction;
	assertions: TestAssertion[];
	bodyOriginal: string;
	bodyMasked: string;
	/** Every literal `expect(...)` argument in the block — see
	 *  test-discrimination-posneg-literals.ts. Used to require the negative
	 *  block's literals be a SUBSET of the matched positive sibling's before
	 *  firing (a block asserting anything extra already discriminates). */
	literalSet: Set<string>;
}

/** Extract any block's (it/test/specify/describe/suite/context) string-
 *  literal title from the ORIGINAL (unmasked) lines — masked lines have
 *  blanked the title text. */
function extractTitle(originalLines: string[], startLine: number): string {
	const window = originalLines.slice(startLine, startLine + TITLE_WINDOW_LINES).join("\n");
	const m = BLOCK_TITLE_RE.exec(window);
	return m ? (m[2] ?? "") : "";
}

/** A title's own `N`/`P` prefix direction, or null when it carries neither. */
function prefixDirection(title: string): Direction | null {
	const t = title.trim();
	if (NEG_PREFIX_RE.test(t)) return "negative";
	if (POS_PREFIX_RE.test(t)) return "positive";
	return null;
}

/** Phrase-based direction: the Check Evidence Contract grammar
 *  (`directionFromTitle`) plus two phrases it doesn't cover ("must reject",
 *  bare "must not", "must hold") that this repo's suites also use. */
function phraseDirection(title: string): Direction | null {
	const structural = directionFromTitle(title);
	if (structural) return structural;
	const t = title.toLowerCase();
	if (/must reject|must not\b/.test(t)) return "negative";
	if (/must hold\b/.test(t)) return "positive";
	return null;
}

/** A title's own formally-labeled direction (prefix wins over phrase — a
 *  prefix is a more specific, per-case signal), or null when unlabeled. */
function titleDirection(title: string): Direction | null {
	return prefixDirection(title) ?? phraseDirection(title);
}

/**
 * Resolve a test block's direction: its own label, else the nearest
 * enclosing describe's label (an untagged it() inside a "negative (must not
 * fire)" describe is negative), else the plain-English vocabulary fallback.
 */
function classifyDirection(
	block: TestBlock,
	allBlocks: TestBlock[],
	title: string,
	originalLines: string[],
): Direction {
	const own = titleDirection(title);
	if (own) return own;
	let idx = block.parent;
	while (idx !== -1) {
		const ancestor = allBlocks[idx];
		if (!ancestor) break;
		const inherited = titleDirection(extractTitle(originalLines, ancestor.startLine));
		if (inherited) return inherited;
		idx = ancestor.parent;
	}
	return NEGATIVE_TITLE_RE.test(title) ? "negative" : "positive";
}

/** Strip a bare `() => <expr>` wrapper (the common `toThrow` shape) so the
 *  wrapped call's own name becomes the target. */
function stripArrowWrapper(s: string): string {
	const m = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(s.trim());
	return m ? (m[1] ?? s) : s;
}

/** Normalize an `expect(...)` subject to a comparable call target: strip
 *  `await`, an arrow-function wrapper, and any argument list — so
 *  `expect(parse(x))` and `expect(parse(y))` (or `expect(() => parse(x))`)
 *  all normalize to `parse`. */
export function normalizeTarget(maskedSubject: string): string {
	let s = maskedSubject.trim().replace(/^await\s+/, "").trim();
	s = stripArrowWrapper(s).trim();
	const parenIdx = s.indexOf("(");
	const base = parenIdx === -1 ? s : s.slice(0, parenIdx);
	return base.replace(/\s+/g, "");
}

/** Shape + triviality decision for an already-trimmed masked/raw argument
 *  pair — a plain literal that ISN'T a trivial sentinel returns the raw
 *  text; anything else (no literal shape, or a trivial one) returns null. */
function literalOrNull(maskedArg: string, rawArg: string): string | null {
	if (LITERAL_SIMPLE_RE.test(maskedArg)) return isTrivialNumber(rawArg) ? null : rawArg;
	if (/^"[\s]*"$/.test(maskedArg) || /^'[\s]*'$/.test(maskedArg)) {
		return isTrivialString(rawArg) ? null : rawArg;
	}
	if (/^`[\s]*`$/.test(maskedArg) && !rawArg.includes("${")) {
		return isTrivialString(rawArg) ? null : rawArg;
	}
	return null;
}

/** Classify a matcher argument as one of the supported literal shapes
 *  (number or string/template, excluding trivial sentinels — see
 *  `isTrivialNumber`/`isTrivialString`), returning the ORIGINAL (unmasked)
 *  text to use as the comparison key, or null when it doesn't qualify. */
function classifyLiteral(maskedArg: string, rawArg: string): string | null {
	return literalOrNull(maskedArg.trim(), rawArg.trim());
}

interface AssertionInputs {
	bodyMasked: string;
	bodyOriginal: string;
	exprStart: number;
	subjectStart: number;
	subjectEnd: number;
}

/** Resolve one `expect(...)` call (subject already spanned) into a target +
 *  literal pair, or null when it isn't a direct, non-negated, literal-
 *  argument call to a tracked matcher. */
function tryExtractAssertion(inputs: AssertionInputs): TestAssertion | null {
	const { bodyMasked, bodyOriginal, exprStart, subjectStart, subjectEnd } = inputs;
	const after = subjectEnd + 1;
	const wsMatch = /^\s*/.exec(bodyMasked.slice(after));
	const pos = after + (wsMatch ? wsMatch[0].length : 0);
	if (bodyMasked.slice(pos, pos + 4) === ".not") return null; // negated chain: different semantics
	const chainMatch = /^\.(\w+)\s*\(/.exec(bodyMasked.slice(pos));
	if (!chainMatch) return null;
	const matcherName = chainMatch[1] ?? "";
	if (!LITERAL_MATCHERS.has(matcherName)) return null;
	const argOpen = pos + chainMatch[0].length;
	const argSpan = findCallSpan(bodyMasked, argOpen);
	if (!argSpan) return null;
	const literal = classifyLiteral(
		bodyMasked.slice(argOpen, argSpan.end),
		bodyOriginal.slice(argOpen, argSpan.end),
	);
	if (literal === null) return null;
	const maskedSubject = bodyMasked.slice(subjectStart, subjectEnd);
	const target = normalizeTarget(maskedSubject);
	if (target === "") return null;
	return { target, literal, exprStart, subjectHasCall: maskedSubject.includes("(") };
}

/** Every `expect(...).matcher(<literal>)` assertion in one test block's body. */
function extractExpectAssertions(bodyOriginal: string, bodyMasked: string): TestAssertion[] {
	const results: TestAssertion[] = [];
	const re = /\bexpect\s*\(/g;
	let m: RegExpExecArray | null = re.exec(bodyMasked);
	while (m !== null) {
		const exprStart = m.index;
		const subjectStart = exprStart + m[0].length;
		const subjSpan = findCallSpan(bodyMasked, subjectStart);
		if (subjSpan) {
			const entry = tryExtractAssertion({
				bodyMasked,
				bodyOriginal,
				exprStart,
				subjectStart,
				subjectEnd: subjSpan.end,
			});
			if (entry) results.push(entry);
		}
		m = re.exec(bodyMasked);
	}
	return results;
}

interface TestInfoInputs {
	block: TestBlock;
	allBlocks: TestBlock[];
	originalLines: string[];
	maskedLines: string[];
}

function buildTestInfo(inputs: TestInfoInputs): TestInfo {
	const { block, allBlocks, originalLines, maskedLines } = inputs;
	const title = extractTitle(originalLines, block.startLine);
	const bodyOriginal = originalLines.slice(block.startLine, block.endLine + 1).join("\n");
	const bodyMasked = maskedLines.slice(block.startLine, block.endLine + 1).join("\n");
	return {
		parent: block.parent,
		startLine: block.startLine,
		title,
		direction: classifyDirection(block, allBlocks, title, originalLines),
		assertions: extractExpectAssertions(bodyOriginal, bodyMasked),
		bodyOriginal,
		bodyMasked,
		literalSet: computeExpectedLiteralSet(bodyOriginal, bodyMasked),
	};
}

function groupByParent(infos: TestInfo[]): Map<number, TestInfo[]> {
	const groups = new Map<number, TestInfo[]>();
	for (const info of infos) {
		const list = groups.get(info.parent);
		if (list) list.push(info);
		else groups.set(info.parent, [info]);
	}
	return groups;
}

function buildMatch(info: TestInfo, assertion: TestAssertion, sibling: TestInfo): InlineMatch {
	const posTitle = sibling.title.slice(0, 40);
	const text =
		`duplicate_expected_literal_pos_neg: negative test shares expected ${assertion.literal} ` +
		`for ${assertion.target} with positive "${posTitle}" at line ${sibling.startLine + 1}`;
	return { line: info.startLine + 1, text: text.slice(0, 150) };
}

/** Strip one layer of quote/backtick delimiters, if present, so a string
 *  literal's CORE text can be compared against a bare (unquoted) echo. */
function literalCore(literalRaw: string): string {
	return literalRaw.replace(/^["'`]|["'`]$/g, "");
}

/**
 * INPUT ECHO: true when `literalRaw`'s core text appears, anywhere in
 * `beforeText`, as a bare call ARGUMENT (quoted or not) — e.g.
 * `capsSetAction("cyclomatic", "15", …)` echoes "15" as a STRING argument
 * even though a later assertion reads it back as the bare NUMBER 15 — OR as
 * a value nested inside an object/array literal ARGUMENT of a call, e.g.
 * `writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80 } })` echoes 80 via
 * `lines: 80`. Treating `key: <lit>` / `[<lit>` / `, <lit>` the same as a
 * flat positional argument: PRECEDED by `(`, `,`, `:`, or `[`, FOLLOWED by
 * `,`, `)`, `]`, or `}` — such a shared literal is echoed, not computed.
 */
function isInputEchoLiteral(beforeText: string, literalRaw: string): boolean {
	const core = literalCore(literalRaw);
	if (core.length === 0) return false;
	const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`[(,:\\[]\\s*["'\`]?${escaped}["'\`]?\\s*[,)\\]}]`);
	return re.test(beforeText);
}

/** The leading identifier of a normalized target (`result` from `result.label`). */
function rootIdentifier(target: string): string {
	const m = /^[A-Za-z_$][\w$]*/.exec(target);
	return m ? m[0] : target;
}

/** True when `rootIdent` is bound, in `bodyMasked`, to a RHS that itself
 *  contains a call — i.e. the identifier is call-DERIVED, not a fixture. */
function hasCallAliasFor(bodyMasked: string, rootIdent: string): boolean {
	const escaped = rootIdent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b[^=;\\n]*=\\s*([^;\\n]*)`);
	const m = re.exec(bodyMasked);
	return m ? (m[1] ?? "").includes("(") : false;
}

/** The trailing bare property name of a normalized target (`label` from
 *  `result.label`, `name` from `rows[0]?.name`), or null when the target
 *  doesn't end in a `.identifier` access at all. */
function fieldNameOf(target: string): string | null {
	const m = /\.([A-Za-z_$][\w$]*)$/.exec(target);
	return m ? m[1] ?? null : null;
}

/** True when `field` is asserted, file-wide, against at most one distinct
 *  literal (`result.action` seen as both "written"/"skipped" elsewhere is
 *  NOT invariant; `result.label` seen only ever as one literal IS). No field
 *  name at all is never invariant. */
function isFieldInvariantAcrossFile(target: string, fieldLiterals: ReadonlyMap<string, Set<string>>): boolean {
	const field = fieldNameOf(target);
	if (field === null) return false;
	const literals = fieldLiterals.get(field);
	return !literals || literals.size <= 1;
}

/**
 * CONSTANT FIELD: true when the target chain has no call anywhere (the
 * `expect(...)` subject never contains a `(`). If its root identifier is
 * ALSO not aliased to a call result in either sibling's body, it's a bare
 * fixture reference — always constant. If the root IS call-aliased
 * (`result.label` where `result = coverageStep(...)`), the field only
 * counts as constant when the file never observes it VARYING (see
 * `isFieldInvariantAcrossFile`) — `result.action` legitimately varies
 * ("written" vs "skipped") and must still count.
 */
function isConstantFieldTarget(
	assertion: TestAssertion,
	info: TestInfo,
	other: TestInfo,
	fieldLiterals: ReadonlyMap<string, Set<string>>,
): boolean {
	if (assertion.subjectHasCall) return false;
	const root = rootIdentifier(assertion.target);
	const aliased = hasCallAliasFor(info.bodyMasked, root) || hasCallAliasFor(other.bodyMasked, root);
	if (!aliased) return true;
	return isFieldInvariantAcrossFile(assertion.target, fieldLiterals);
}

/** Aggregate, across every test block in the file, the set of distinct
 *  literals asserted for each bare trailing FIELD NAME — the file-wide
 *  signal `isFieldInvariantAcrossFile` reads. */
function buildFieldLiteralSets(infos: readonly TestInfo[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const info of infos) {
		for (const a of info.assertions) {
			const field = fieldNameOf(a.target);
			if (field === null) continue;
			const set = map.get(field);
			if (set) set.add(a.literal);
			else map.set(field, new Set([a.literal]));
		}
	}
	return map;
}

/** The sibling group + the file-wide field/target→literals maps the two invariance checks read. */
interface GroupMatchContext {
	group: TestInfo[];
	fieldLiterals: ReadonlyMap<string, Set<string>>;
	targetLiterals: ReadonlyMap<string, Set<string>>;
}

/** Scan `ctx.group` for a POSITIVE sibling (never `info`, never another
 *  NEGATIVE) asserting the same target + literal, skipping a CONSTANT-FIELD
 *  target — or null when none matches. */
function matchAssertionAgainstGroup(
	assertion: TestAssertion,
	info: TestInfo,
	ctx: GroupMatchContext,
): InlineMatch | null {
	for (const other of ctx.group) {
		if (other === info || other.direction !== "positive") continue;
		if (isConstantFieldTarget(assertion, info, other, ctx.fieldLiterals)) continue;
		const hit = other.assertions.some(
			(a) => a.target === assertion.target && a.literal === assertion.literal,
		);
		if (!hit) continue;
		// The single shared literal on the shared target is not enough: if
		// the negative block asserts ANY OTHER literal the positive sibling
		// doesn't, it already discriminates and this pair is not a match.
		if (!isLiteralSubset(info.literalSet, other.literalSet)) continue;
		return buildMatch(info, assertion, other);
	}
	return null;
}

/** First assertion of a NEGATIVE block matched against a POSITIVE sibling in
 *  `ctx.group` — never same-direction; skips an INPUT-ECHOED literal first. */
function findPositiveMatch(info: TestInfo, ctx: GroupMatchContext): InlineMatch | null {
	for (const assertion of info.assertions) {
		const before = info.bodyOriginal.slice(0, assertion.exprStart);
		if (isInputEchoLiteral(before, assertion.literal)) continue;
		// A different literal elsewhere for this target already kills the stub.
		if (!isTargetInvariantAcrossFile(assertion.target, ctx.targetLiterals)) continue;
		const match = matchAssertionAgainstGroup(assertion, info, ctx);
		if (match) return match;
	}
	return null;
}

/**
 * Flags a negative-titled it()/test() block that shares its expected literal
 * (via toBe/toEqual/toStrictEqual/toThrow/toMatch) against the same call
 * target with a non-negative sibling in the same describe scope — a
 * duplicated, non-discriminating assertion (see file header for the
 * falsifier-corpus shape this generalizes).
 */
export function checkDuplicateExpectedLiteralPosNeg(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const originalLines = content.split("\n");
	const maskedLines = stripAllLiterals(content).split("\n");
	const allBlocks = extractTestBlocks(maskedLines);
	const infos = allBlocks
		.filter((b) => b.kind === "test" && !b.unconditionalGate)
		.map((block) => buildTestInfo({ block, allBlocks, originalLines, maskedLines }));
	const groups = groupByParent(infos);
	const fieldLiterals = buildFieldLiteralSets(infos);
	const targetLiterals = buildTargetLiteralSets(infos.flatMap((i) => collectTargetMembers(i.bodyMasked, i.bodyOriginal, normalizeTarget)));
	const matches: InlineMatch[] = [];
	for (const group of groups.values()) {
		for (const info of group) {
			if (info.direction !== "negative") continue;
			const match = findPositiveMatch(info, { group, fieldLiterals, targetLiterals });
			if (match) matches.push(match);
			if (matches.length >= MAX_MATCHES) return matches;
		}
	}
	return matches;
}
