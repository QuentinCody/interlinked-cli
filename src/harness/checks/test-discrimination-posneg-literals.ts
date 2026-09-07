// Expected-literal-SET extraction — sibling of test-discrimination-posneg.ts.
//
// The parent detector originally fired whenever a negative/positive sibling
// pair shared ONE literal on the SAME call target — ignoring every other
// assertion in either block. A 49-worker adjudication measured that at ~86%
// false positives (90/105) on this tree: the dominant class was "the
// negative block already asserts a DIFFERENT distinguishing literal
// elsewhere in the same test" (`scratch/test-quality-checks/wave-fp-notes.txt`,
// `duplicate_expected_literal_pos_neg` lines).
//
// This module answers the narrower question the parent detector needs to
// gate on: what is the FULL set of literals a test block asserts, across
// every `expect(...).<matcher>(<args>)` call in its body? The parent then
// fires only when the negative block's set is a SUBSET of the positive
// block's set — if the negative block asserts anything extra, it already
// discriminates and the parent must not fire.
//
// A "literal" here is intentionally broader than the parent's own
// target-match literal (which excludes booleans/null/undefined/empty
// collections as too noisy for a PRIMARY trigger): for SET membership those
// shapes are informative because they widen a block's coverage even when
// they'd be too common to trigger on alone. Every literal key is prefixed by
// its kind (`num:`, `str:`, `bool:`, `null`, `undefined`, `arr:empty`,
// `obj:empty`, `regex:`) so a same-text string and number never collide.
//
// Nesting is capped at exactly ONE level inside an object/array argument to
// `toEqual`/`toMatchObject`/`toContain`/`toHaveBeenCalledWith` — a value that
// is itself an object/array is not flattened further; the field-by-field
// case is `duplicate_expected_literal_pos_neg`'s sibling job, not this one.

import { findCallSpan } from "./test-hygiene-shared.js";

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const REGEX_ARG_RE = /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*$/i;

/** Matchers whose object/array argument gets ONE level of nested-literal
 *  extraction (a field's own literal value, not a further-nested object). */
const NESTED_MATCHERS = new Set(["toEqual", "toMatchObject", "toContain", "toHaveBeenCalledWith"]);

/** A leading `key:` (quoted, bracketed-computed, or bare identifier) on one
 *  object-literal entry, matched against MASKED text (string-key interiors
 *  are blanked but delimiters/length survive, so the shape still matches). */
const KEY_PREFIX_RE = /^\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*:\s*/;

/** A string/number literal only (the restricted shape used for one-level
 *  nested extraction — no bool/null/undefined/regex/empty at that depth). */
function classifyStringOrNumberLiteral(maskedTrim: string, rawTrim: string): string | null {
	if (NUMBER_RE.test(maskedTrim)) return `num:${rawTrim}`;
	if (/^"[\s\S]*"$/.test(maskedTrim) || /^'[\s\S]*'$/.test(maskedTrim)) return `str:${rawTrim}`;
	if (/^`[\s\S]*`$/.test(maskedTrim) && !rawTrim.includes("${")) return `str:${rawTrim}`;
	return null;
}

/** The full top-level literal vocabulary: string/number/boolean/null/
 *  undefined/empty-array/empty-object/regex-source. */
function classifyTopLevelLiteral(maskedTrim: string, rawTrim: string): string | null {
	const stringOrNumber = classifyStringOrNumberLiteral(maskedTrim, rawTrim);
	if (stringOrNumber) return stringOrNumber;
	if (rawTrim === "true" || rawTrim === "false") return `bool:${rawTrim}`;
	if (rawTrim === "null") return "null";
	if (rawTrim === "undefined") return "undefined";
	if (rawTrim === "[]") return "arr:empty";
	if (rawTrim === "{}") return "obj:empty";
	// A regex literal is blanked ENTIRELY by stripAllLiterals (delimiters
	// included), so its masked form is bare whitespace of the same length.
	if (maskedTrim.length === 0 && REGEX_ARG_RE.test(rawTrim)) return `regex:${rawTrim}`;
	return null;
}

/** Split a bracket-delimited span (already positioned just past its own
 *  opening delimiter, via `findCallSpan`'s depth tracking) into its
 *  depth-0 argument/entry spans, reusing the same comma list `findCallSpan`
 *  already computed rather than re-scanning for depth. */
function splitArgSpans(open: number, span: { end: number; topLevelCommas: number[] }): Array<[number, number]> {
	const starts = [open, ...span.topLevelCommas.map((c) => c + 1)];
	const ends = [...span.topLevelCommas, span.end];
	return starts.map((s, i) => [s, ends[i] ?? span.end] as [number, number]);
}

/** Index of the first non-whitespace character of `text`, or -1 when blank. */
function firstNonWsIndex(text: string): number {
	const m = /\S/.exec(text);
	return m ? m.index : -1;
}

/** One level of literal extraction inside a `{...}`/`[...]` argument: every
 *  entry's own (string/number only) value, skipping any entry whose value
 *  is itself a nested object/array. */
function collectNestedLiterals(maskedArg: string, rawArg: string, set: Set<string>): void {
	const openIdx = firstNonWsIndex(maskedArg);
	if (openIdx === -1) return;
	const opener = maskedArg[openIdx];
	const isObject = opener === "{";
	if (!isObject && opener !== "[") return;
	const span = findCallSpan(maskedArg, openIdx + 1);
	if (!span) return;
	for (const [s, e] of splitArgSpans(openIdx + 1, span)) {
		let maskedEntry = maskedArg.slice(s, e);
		let rawEntry = rawArg.slice(s, e);
		if (maskedEntry.trim().length === 0) continue;
		if (isObject) {
			const keyMatch = KEY_PREFIX_RE.exec(maskedEntry);
			if (!keyMatch) continue;
			maskedEntry = maskedEntry.slice(keyMatch[0].length);
			rawEntry = rawEntry.slice(keyMatch[0].length);
		}
		const literal = classifyStringOrNumberLiteral(maskedEntry.trim(), rawEntry.trim());
		if (literal) set.add(literal);
	}
}

/** Every literal argument (plus one level of nested literals for the
 *  matchers `NESTED_MATCHERS` names) of one `expect(...)` call, starting
 *  just past the subject's own closing paren. */
function collectFromExpectCall(bodyMasked: string, bodyOriginal: string, subjectEnd: number, set: Set<string>): void {
	const after = subjectEnd + 1;
	const wsMatch = /^\s*/.exec(bodyMasked.slice(after));
	const pos = after + (wsMatch ? wsMatch[0].length : 0);
	if (bodyMasked.slice(pos, pos + 4) === ".not") return; // negated: not an asserted-equal outcome
	const chainMatch = /^\.(\w+)\s*\(/.exec(bodyMasked.slice(pos));
	if (!chainMatch) return;
	const matcherName = chainMatch[1] ?? "";
	const argOpen = pos + chainMatch[0].length;
	const argSpan = findCallSpan(bodyMasked, argOpen);
	if (!argSpan) return;
	const nestable = NESTED_MATCHERS.has(matcherName);
	for (const [s, e] of splitArgSpans(argOpen, argSpan)) {
		const maskedArg = bodyMasked.slice(s, e);
		const rawArg = bodyOriginal.slice(s, e);
		const literal = classifyTopLevelLiteral(maskedArg.trim(), rawArg.trim());
		if (literal) set.add(literal);
		if (nestable) collectNestedLiterals(maskedArg, rawArg, set);
	}
}

/**
 * The full expected-literal set of one test block's body: every literal
 * argument of every `expect(...).<matcher>(...)` call, plus one level of
 * nested literals inside an object/array argument to `toEqual` /
 * `toMatchObject` / `toContain` / `toHaveBeenCalledWith`. `bodyMasked` MUST
 * be the `stripAllLiterals(...)` output for the same range as `bodyOriginal`
 * (offset-aligned) — see the parent detector's contract.
 */
export function computeExpectedLiteralSet(bodyOriginal: string, bodyMasked: string): Set<string> {
	const set = new Set<string>();
	const re = /\bexpect\s*\(/g;
	let m: RegExpExecArray | null = re.exec(bodyMasked);
	while (m !== null) {
		const subjectStart = m.index + m[0].length;
		const subjSpan = findCallSpan(bodyMasked, subjectStart);
		if (subjSpan) collectFromExpectCall(bodyMasked, bodyOriginal, subjSpan.end, set);
		m = re.exec(bodyMasked);
	}
	return set;
}

/** True when every element of `sub` is present in `sup` (an empty `sub` is
 *  always a subset, even of an empty `sup`). */
export function isLiteralSubset(sub: ReadonlySet<string>, sup: ReadonlySet<string>): boolean {
	for (const literal of sub) {
		if (!sup.has(literal)) return false;
	}
	return true;
}

/** One `expect(...)` assertion's normalized call target plus the DISTINCT
 *  member it asserts — a literal's own text for a literal argument, or one
 *  of `collectTargetMembers`'s sentinel/`<expr:...>` markers for a
 *  literal-less or non-literal one. The shape `buildTargetLiteralSets` needs. */
export interface TargetLiteralPair {
	target: string;
	literal: string;
}

/** Sentinel members for the four zero-argument matchers this rule tracks —
 *  each is proof the target ISN'T a pure single-literal stub, even though
 *  none of them can themselves match a sibling's literal argument. */
const ZERO_ARG_MEMBER: Readonly<Record<string, string>> = {
	toBeNull: "<null>",
	toBeUndefined: "<undefined>",
	toBeFalsy: "<falsy>",
	toBeTruthy: "<truthy>",
};

/** The distinct member one matcher call contributes: a known literal shape's
 *  own key, one of the four zero-arg sentinels, or `<expr:...>` for anything
 *  else (an identifier, `__filename`, an `it.each` variable, a call) — null
 *  only when the call takes no args and isn't one of the tracked zero-arg
 *  matchers (nothing distinguishing to record). */
function memberFor(matcherName: string, maskedArg: string, rawArg: string): string | null {
	if (maskedArg.length === 0) return ZERO_ARG_MEMBER[matcherName] ?? null;
	return classifyTopLevelLiteral(maskedArg, rawArg) ?? `<expr:${rawArg}>`;
}

interface TargetMemberInputs {
	bodyMasked: string;
	bodyOriginal: string;
	subjectStart: number;
	subjectEnd: number;
	normalizeTarget: (maskedSubject: string) => string;
}

/** One `expect(...)` call's (target, member) pair, appended to `out` — or
 *  nothing for a negated (`.not.`) chain, an unmatched chain, or a call with
 *  neither a literal nor a tracked zero-arg shape. */
function collectOneTargetMember(inputs: TargetMemberInputs, out: TargetLiteralPair[]): void {
	const { bodyMasked, bodyOriginal, subjectStart, subjectEnd, normalizeTarget } = inputs;
	const target = normalizeTarget(bodyMasked.slice(subjectStart, subjectEnd));
	if (target === "") return;
	const after = subjectEnd + 1;
	const wsMatch = /^\s*/.exec(bodyMasked.slice(after));
	const pos = after + (wsMatch ? wsMatch[0].length : 0);
	if (bodyMasked.slice(pos, pos + 4) === ".not") return;
	const chainMatch = /^\.(\w+)\s*\(/.exec(bodyMasked.slice(pos));
	if (!chainMatch) return;
	const matcherName = chainMatch[1] ?? "";
	const argOpen = pos + chainMatch[0].length;
	const argSpan = findCallSpan(bodyMasked, argOpen);
	if (!argSpan) return;
	const maskedArg = bodyMasked.slice(argOpen, argSpan.end).trim();
	const rawArg = bodyOriginal.slice(argOpen, argSpan.end).trim();
	const literal = memberFor(matcherName, maskedArg, rawArg);
	if (literal) out.push({ target, literal });
}

/**
 * Every (target, member) pair asserted against `expect(...)` in one test
 * block's body, for FILE-WIDE target-invariance purposes — broader than
 * `computeExpectedLiteralSet`: EVERY matcher counts (not just the primary
 * literal ones), and a literal-less or non-literal argument still yields a
 * DISTINCT member (see `memberFor`) instead of being silently dropped — the
 * blind spot that let `toBeNull()`/`toBe(someVar)` elsewhere in a file hide
 * real target variance from `isTargetInvariantAcrossFile`. `normalizeTarget`
 * is injected (owned by the parent detector) to avoid a module cycle.
 */
export function collectTargetMembers(
	bodyMasked: string,
	bodyOriginal: string,
	normalizeTarget: (maskedSubject: string) => string,
): TargetLiteralPair[] {
	const members: TargetLiteralPair[] = [];
	const re = /\bexpect\s*\(/g;
	let m: RegExpExecArray | null = re.exec(bodyMasked);
	while (m !== null) {
		const subjectStart = m.index + m[0].length;
		const subjSpan = findCallSpan(bodyMasked, subjectStart);
		if (subjSpan) {
			collectOneTargetMember({ bodyMasked, bodyOriginal, subjectStart, subjectEnd: subjSpan.end, normalizeTarget }, members);
		}
		m = re.exec(bodyMasked);
	}
	return members;
}

/**
 * Every distinct literal ever asserted, FILE-WIDE, against each exact
 * (already-coarsened) call target — the generalized form of the old
 * per-FIELD-NAME invariance map: keyed by the full target string so
 * `runGuard(...)`, `result.decision`, and a bare property path are all
 * covered by the same mechanism, not just call-aliased sub-fields.
 */
export function buildTargetLiteralSets(assertions: Iterable<TargetLiteralPair>): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const a of assertions) {
		const set = map.get(a.target);
		if (set) set.add(a.literal);
		else map.set(a.target, new Set([a.literal]));
	}
	return map;
}

/**
 * True when `target` is asserted to exactly ONE distinct literal across the
 * whole file (or not observed at all) — the "pure stub, nothing anywhere
 * discriminates it" case this rule fires on. False when some OTHER
 * assertion anywhere in the file proves the target can take a DIFFERENT
 * value: that other assertion already kills the always-same-outcome
 * mutant, so a matched positive/negative pair sharing this target's literal
 * is a legitimate "must not over-fire" guard test, not a duplicate.
 */
export function isTargetInvariantAcrossFile(target: string, targetLiterals: ReadonlyMap<string, Set<string>>): boolean {
	const literals = targetLiterals.get(target);
	return !literals || literals.size <= 1;
}
