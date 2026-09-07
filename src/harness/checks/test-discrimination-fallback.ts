// CLASS: a test observes only default/empty/no-op outcomes for unpinned targets.
// FIRES WHEN: every assertion in an active test is a default matcher and no
// non-default assertion pins any normalized target in the file or a same-SUT
// sibling test file (bounded filename-based lookup, one-hop aliases).
// DOES NOT FIRE: a non-default sibling pin, recognized boolean predicate,
// explicit default-outcome title, resilience/no-throw contract, or skipped block.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | block-local | 4481/1160 | 37.5% builder sample | legitimate negative halves |
// | round 1 | 124/86 | not independently measured | sibling/alias/title rules |
// KNOWN GAPS: local wrapper-function aliases, cross-file identity by filename,
// and helper assertions. A fallback may be the actual public contract.
// HOW TO EXTEND: update matcher/target classification and paired positive and
// negative fixtures; preserve sibling visibility. Census: scripts/scan-test-discrimination.ts.

import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";
import { type AliasMaps, collectAliases, resolveSubjectTarget } from "./test-discrimination-fallback-alias.js";
import { siblingNonDefaultTargets } from "./test-discrimination-fallback-siblings.js";
import { findCallSpan } from "./test-hygiene-shared.js";
import { extractTestBlocks, type TestBlock } from "./test-structure.js";
import { stripAllLiterals } from "../strip-helpers.js";

const MAX_MATCHES = 10;

// `expect(` call openings (the assertion subject).
const EXPECT_OPEN_RE = /\bexpect\s*\(/g;
// The `.mod.mod.matcher(` chain that follows an `expect(...)` close paren —
// same shape as test-hygiene-quality-mock-only.ts's MATCHER_CHAIN_RE.
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;

// Non-negated matchers whose CALL ITSELF (no argument, or a checked default
// argument) is the default/empty/no-op outcome.
const ZERO_ARG_DEFAULT = new Set(["toBeNull", "toBeUndefined", "toBeFalsy"]);
// Negated matchers ("not.<matcher>()") whose no-argument form asserts a
// no-op/absence outcome — a guard/effect never firing.
const NEGATED_DEFAULT = new Set(["toThrow", "toHaveBeenCalled"]);
// `toBe(<literal>)` arguments that are themselves the default/falsy value.
const DEFAULT_TOBE_LITERAL_RE = /^(?:0|false|""|''|null|undefined)$/;
const EMPTY_ARRAY_OR_OBJECT_RE = /^(?:\[\s*\]|\{\s*\})$/;

// A target whose NAME reads as a boolean predicate ("does X hold?") rather
// than a computed value — `existsSync`, `has`, `includes`, `isReady`,
// `canRetry`, `.ok`, `.enabled`, … For these, `false` IS the interesting
// outcome (a predicate that answers "no" is doing its job), not a no-op
// fallback — so `toBe(false)` / `toBeFalsy()` on one of these targets is
// treated as NON-default even with no sibling pin. Added in the same
// tightening round as file-level sibling visibility: sampled precision
// showed `fileExists(...).toBe(false)`-shaped "verify a deletion happened"
// assertions were the second-largest false-positive class, and no sibling
// test would ever pin a boolean predicate to `true` for the SAME input, so
// sibling visibility alone can't clear them. `some`/`every`/`includes`/
// `has`/`startsWith`/`endsWith`/`test` (Array/String/RegExp predicates,
// found 2026-09-06 misclassifying `logs.some((l) => …).toBe(false)`-shaped
// negative-space guarantees as fallbacks) round out the built-in JS/TS
// boolean-returning predicate surface alongside the naming conventions.
// `has[A-Z]\w*` (not just the bare `has`) added the same day: found via a
// fresh precision sample — `hasOutputRedirect(...)`.toBe(false)`/
// `hasFollowFlag(...).toBe(false)` are real "this input has no output
// redirect / no follow flag" guarantees, pinned true elsewhere in a SIBLING
// test file (file-dump-guard-parse.test.ts), same shape as `isX`/`canX`.
const BOOLEAN_PREDICATE_LAST_SEGMENT_RE =
	/^(?:existsSync|has|includes|ok|enabled|some|every|startsWith|endsWith|test|is[A-Z]\w*|can[A-Z]\w*|should[A-Z]\w*|has[A-Z]\w*)$/;

// `expect("key" in obj)` / `expect(key in obj)` — the `in` OPERATOR, not a
// predicate-named function call. Its `false` result is the same kind of
// real negative-space guarantee as a boolean-predicate call ("this key is
// genuinely absent"), so it must be treated as non-default the same way,
// even though there's no callee name to check against
// BOOLEAN_PREDICATE_LAST_SEGMENT_RE. Matched on the MASKED subject text
// (string-literal interiors blanked, delimiters intact) before any
// call/property resolution runs.
const IN_OPERATOR_SUBJECT_RE = /^.+\bin\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** True when an `expect(...)` subject is an `in` operator expression
 *  (`"x" in obj` / `key in obj`). */
function isInOperatorSubject(subjectText: string): boolean {
	return IN_OPERATOR_SUBJECT_RE.test(subjectText.trim());
}

/** True when a normalized target's final `.segment` reads as a boolean
 *  predicate by name. */
function isBooleanPredicateTarget(target: string): boolean {
	const segments = target.split(".");
	const last = segments[segments.length - 1] ?? "";
	return BOOLEAN_PREDICATE_LAST_SEGMENT_RE.test(last);
}

// A test title that ITSELF declares a boundary/negative-case contract — the
// author documented "this input has no effect / nothing to report / this
// path is a deliberate no-op" as the point of the test, not an accident.
// Calibration (scratch/test-quality-checks/fallback_only_assertion-scan.mts,
// 2026-09-06): the literal matcher-family shape alone fired 8604 times across
// 1599/2112 test files — almost every suite's ordinary boundary-case tests
// ("returns empty array when X", "skips Y", "does not confuse Z"). Exempting
// a title that already NAMES the default/no-op outcome keeps the check
// pointed at the accidental case.
// The outcome group ends in `(?=\s|$|[.,;)])` rather than `\b`: `]`/`}` are
// non-word characters, so `\b` immediately after `\[\]`/`\{\}` can never
// match (no word-boundary exists between two non-word characters) — found
// 2026-09-06 when a title literally reading "returns [] when …" still fired.
// An optional article ("an"/"a"/"the") is allowed between the verb and the
// outcome word so "returns an empty set" / "returns a null" match too.
const TITLE_DECLARES_DEFAULT_RE =
	/\b(?:returns?|yields?|resolves?|produces?|leaves?|stays?|remains?|emits?|calls?|constructs?|throws?)\s+(?:an?\s+|the\s+)?(?:no|null|undefined|empty|nothing|false|\[\]|\{\}|zero|unchanged)(?=\s|$|[.,;)])|\b(?:skips?|ignores?|excludes?|omits?|never)\b|\bdoes\s*n[o']t\b|\bwhen\s+(?:no|empty|missing|absent|none)\b|\bwith(?:out)?\s+no\b|\bnot\s+found\b/i;

/** The it()/test() call's string-literal title, read from the ORIGINAL
 *  (unmasked) source line — masked text would blank the title's own content,
 *  which is exactly what this needs to read. `""` when the line doesn't
 *  parse as an ordinary single-line call opening (dynamic title, `.each`
 *  table on a following line, etc.) — callers treat that as "no exemption". */
const TITLE_LINE_RE = /^\s*(?:it|test|specify)(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\([^()]*\))?)*\s*\(\s*["'`]([^"'`]*)["'`]/;
function blockTitle(content: string, startLine: number): string {
	const line = content.split("\n")[startLine] ?? "";
	return TITLE_LINE_RE.exec(line)?.[1] ?? "";
}

// A NARROWER title-declares-default class: the title names the test's own
// RESILIENCE contract ("swallows write errors instead of throwing",
// "shutdown() resolves (stateless, nothing to clean up)") rather than a
// plain boundary case. Applied ONLY when every assertion in the block is
// itself a `not.toThrow()` / `.resolves.<matcher>()` shape (see
// {@link isResilienceOnlyBlock}) — a resilience-worded title backing an
// unrelated `toBe(0)` assertion is NOT this class.
const RESILIENCE_TITLE_RE =
	/\bswallow|\btolerat|\bresilien|\bno-?op\b|\bnothing\s+to\s+(?:clean|do)\b|\bstateless\b|\bidempotent\b|\bdoes\s*n[o']t\s+throw\b|\bwithout\s+throwing\b/i;

/** True when every assertion in the block is a `not.toThrow()` (any target)
 *  or a `.resolves.<matcher>()` chain — the two shapes a resilience-worded
 *  title actually backs. */
function isResilienceOnlyBlock(assertions: Assertion[]): boolean {
	return assertions.every((a) => (a.matcher === "toThrow" && a.hasResolves === false) || a.hasResolves);
}

/** Does one classified `expect(...).<chain>(...)` call assert a default/
 *  no-op/empty outcome? `argsText` is the matcher's own argument text
 *  (masked — string interiors blanked, delimiters intact); `negated` is
 *  whether `not` appears anywhere in the modifier chain; `target` is the
 *  assertion's normalized subject. */
function isDefaultOutcomeAssertion(
	matcher: string,
	negated: boolean,
	argsText: string,
	target: string,
	isInOperator: boolean,
): boolean {
	if (negated) return NEGATED_DEFAULT.has(matcher) && argsText === "";
	const isFalseCheck = matcher === "toBeFalsy" || (matcher === "toBe" && argsText === "false");
	// A predicate's (or an `in` operator's) "no" is a real outcome, not a
	// no-op fallback.
	if (isFalseCheck && (isBooleanPredicateTarget(target) || isInOperator)) return false;
	if (ZERO_ARG_DEFAULT.has(matcher)) return argsText === "";
	if (matcher === "toBe") return DEFAULT_TOBE_LITERAL_RE.test(argsText);
	if (matcher === "toEqual" || matcher === "toStrictEqual") return EMPTY_ARRAY_OR_OBJECT_RE.test(argsText);
	if (matcher === "toHaveLength") return argsText === "0";
	return false;
}

/** One `expect(...)` assertion's classification. `matcher`/`hasResolves` are
 *  carried alongside `isDefault` for the resilience-title exemption, which
 *  needs to know the assertion SHAPE (not just its default-ness) to decide
 *  whether a "swallows errors"-style title applies. */
interface Assertion {
	target: string;
	isDefault: boolean;
	matcher: string;
	hasResolves: boolean;
}

/** Classify one `expect(...)` call given its subject text and the index just
 *  past its closing paren. `null` means the matcher chain couldn't be
 *  resolved (unbalanced parens / no chain) — callers must NOT treat that as
 *  default-outcome. `blockIdx`/`aliases` resolve the subject through any
 *  recorded one-hop alias binding before falling back to its plain target. */
function classifyExpectCall(
	body: string,
	subjectText: string,
	afterExpectParen: number,
	blockIdx: number,
	aliases: AliasMaps,
): Assertion | null {
	const rest = body.slice(afterExpectParen);
	const chainMatch = MATCHER_CHAIN_RE.exec(rest);
	if (!chainMatch) return null;
	const chainText = chainMatch[1] ?? "";
	const segments = chainText
		.split(".")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const matcher = segments[segments.length - 1] ?? "";
	const negated = segments.includes("not");
	const hasResolves = segments.includes("resolves");
	const matcherArgsStart = afterExpectParen + chainMatch[0].length;
	const matcherSpan = findCallSpan(body, matcherArgsStart);
	const argsText = matcherSpan ? body.slice(matcherArgsStart, matcherSpan.end).trim() : "";
	const target = resolveSubjectTarget(subjectText, blockIdx, aliases);
	const isDefault = isDefaultOutcomeAssertion(
		matcher,
		negated,
		argsText,
		target,
		isInOperatorSubject(subjectText),
	);
	return { target, isDefault, matcher, hasResolves };
}

/** Advance past one `expect(...)` call (its subject span) plus, when
 *  resolvable, its matcher call — so the next scan starts after the whole
 *  assertion rather than re-matching inside it. */
function nextScanIndex(body: string, subjectEnd: number, afterExpectParen: number): number {
	const rest = body.slice(afterExpectParen);
	const chainMatch = MATCHER_CHAIN_RE.exec(rest);
	if (!chainMatch) return subjectEnd + 1;
	const matcherArgsStart = afterExpectParen + chainMatch[0].length;
	const matcherSpan = findCallSpan(body, matcherArgsStart);
	return matcherSpan ? matcherSpan.end + 1 : matcherArgsStart;
}

/**
 * Classify every `expect(...)` assertion in a masked block body. An
 * assertion whose matcher chain can't be resolved is reported as
 * non-default (target `""`) — a caller that requires ALL-default stays
 * conservative on the unresolved shape rather than flagging it.
 */
function classifyBlockAssertions(body: string, blockIdx: number, aliases: AliasMaps): Assertion[] {
	const results: Assertion[] = [];
	EXPECT_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_OPEN_RE.exec(body);
	while (m !== null) {
		const subjectStart = m.index + m[0].length;
		const span = findCallSpan(body, subjectStart);
		if (span === null) break; // unbalanced — nothing further is resolvable
		// vitest/jest's `expect(value, message)` two-arg form: the message
		// argument must never pollute the subject — cut at the first top-level
		// comma so `expect(check(p), p)`'s target resolves from `check(p)`
		// alone, matching a plain `expect(check(p))` call site.
		const subjectEnd = span.topLevelCommas[0] ?? span.end;
		const subjectText = body.slice(subjectStart, subjectEnd);
		const classified = classifyExpectCall(body, subjectText, span.end + 1, blockIdx, aliases);
		results.push(classified ?? { target: "", isDefault: false, matcher: "", hasResolves: false });
		EXPECT_OPEN_RE.lastIndex = nextScanIndex(body, span.end, span.end + 1);
		m = EXPECT_OPEN_RE.exec(body);
	}
	return results;
}

/** True when `block` or any enclosing `describe`/`suite` in its parent
 *  chain carries an unconditional skip/todo/fails gate. */
function isGatedOut(blocks: TestBlock[], blockIdx: number): boolean {
	let idx: number = blockIdx;
	while (idx !== -1) {
		const b = blocks[idx];
		if (!b) return false;
		if (b.unconditionalGate) return true;
		idx = b.parent;
	}
	return false;
}

/** Read the original (unmasked) source line at a 0-based line index, trimmed. */
function originalLineAt(content: string, lineIdx: number): string {
	return (content.split("\n")[lineIdx] ?? "").trim();
}

/** Classify every non-gated `it`/`test` block's assertions once, keyed by
 *  block index — the shared pass both the sibling-target set and the final
 *  scan loop read from, so no block is re-parsed. */
function classifyAllBlocks(mLines: string[], blocks: TestBlock[], aliases: AliasMaps): Map<number, Assertion[]> {
	const byBlock = new Map<number, Assertion[]>();
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (!block || block.kind !== "test" || isGatedOut(blocks, i)) continue;
		const body = mLines.slice(block.startLine, block.endLine + 1).join("\n");
		byBlock.set(i, classifyBlockAssertions(body, i, aliases));
	}
	return byBlock;
}

/** Every target pinned to a NON-default value by some assertion anywhere in
 *  the file — the sibling-visibility set. A default-only block whose target
 *  appears here is the legitimate negative half of a discriminated pair. */
function nonDefaultTargetsFrom(byBlock: Map<number, Assertion[]>): Set<string> {
	const targets = new Set<string>();
	for (const assertions of byBlock.values()) {
		for (const a of assertions) if (!a.isDefault && a.target !== "") targets.add(a.target);
	}
	return targets;
}

/** Build the finding for one qualifying block, or null when it doesn't
 *  qualify: no assertions, a non-default assertion present, a target that a
 *  sibling `it()` elsewhere in the file pins to a non-default value, or a
 *  title that already declares the default outcome as its deliberate
 *  contract. */
function matchForBlock(
	content: string,
	block: TestBlock,
	assertions: Assertion[],
	nonDefaultTargets: Set<string>,
): InlineMatch | null {
	if (assertions.length === 0) return null; // assertion-free is a different check
	if (!assertions.every((a) => a.isDefault)) return null;
	if (assertions.some((a) => nonDefaultTargets.has(a.target))) return null; // sibling discriminates
	const title = blockTitle(content, block.startLine);
	if (TITLE_DECLARES_DEFAULT_RE.test(title)) return null;
	if (RESILIENCE_TITLE_RE.test(title) && isResilienceOnlyBlock(assertions)) return null;

	const count = assertions.length;
	const line = originalLineAt(content, block.startLine);
	const text = `fallback_only_assertion: ${count} assertion${count === 1 ? "" : "s"}, all default-outcome and never pinned elsewhere in the file (a return [] mutant would pass identically) — ${line}`;
	return { line: block.startLine + 1, text: text.slice(0, 150) };
}

/**
 * Flag it()/test() blocks whose every assertion is a default/no-op/empty
 * outcome check AND whose asserted target is never pinned to a non-default
 * value by any other test in the same file — a shape indistinguishable from
 * a `return []` mutant of the branch it exercises, with no sibling test to
 * kill that mutant. Returns [] when the file is not a test file, is not
 * JS/TS, or holds no such block.
 */
function nonDefaultTargetsForMaskedContent(masked: string): Set<string> {
	const mLines = masked.split("\n");
	const blocks = extractTestBlocks(mLines);
	const aliases = collectAliases(masked, blocks);
	return nonDefaultTargetsFrom(classifyAllBlocks(mLines, blocks, aliases));
}

/** Every target a NON-default assertion pins ANYWHERE in `content` — used
 *  both for the file's own sibling-visibility set and (via the siblings
 *  module's injected callback) to compute the same set for each cross-file
 *  sibling test file. Public so `checkFallbackOnlyAssertion` and the
 *  cross-file lookup share one classification pipeline. */
export function computeNonDefaultTargetsForContent(content: string): Set<string> {
	return nonDefaultTargetsForMaskedContent(stripAllLiterals(content));
}

/** Report default-only test cases after considering same-file and same-SUT sibling evidence. */
export function checkFallbackOnlyAssertion(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = stripAllLiterals(content);
	const mLines = masked.split("\n");
	const blocks = extractTestBlocks(mLines);
	const aliases = collectAliases(masked, blocks);
	const byBlock = classifyAllBlocks(mLines, blocks, aliases);
	const nonDefaultTargets = nonDefaultTargetsFrom(byBlock);
	// Cross-file sibling visibility (18% of the false-negative-turned-fired
	// census hits): a fallback-only block whose non-default outcome is
	// pinned in a SIBLING TEST FILE (`foo.mutation-kill-w12.test.ts` vs
	// `foo.test.ts`) is the same legitimate discriminated-pair shape as the
	// same-file rule above, just split across files. Defensive: a heuristic
	// advisory check must never throw over a filesystem hiccup.
	try {
		for (const target of siblingNonDefaultTargets(filePath, computeNonDefaultTargetsForContent)) {
			nonDefaultTargets.add(target);
		}
	} catch (e) {
		void e; // never let sibling lookup turn a heuristic check fatal
	}
	const matches: InlineMatch[] = [];

	for (let i = 0; i < blocks.length && matches.length < MAX_MATCHES; i++) {
		const block = blocks[i];
		const assertions = byBlock.get(i);
		if (!block || !assertions) continue;
		const found = matchForBlock(content, block, assertions, nonDefaultTargets);
		if (found) matches.push(found);
	}

	return matches;
}
