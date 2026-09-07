// "Is this loop's collection proven non-empty?" helpers for
// `test-vacuous-loop.ts`'s `vacuous_loop_assertion` check. Carved out of the
// main module to stay under the per-file line cap. See that module's header
// for the check's full CLASS / FIRES WHEN / DOES NOT FIRE / CALIBRATION
// contract — this file owns exemptions (b), (c), (e), and (f), plus the
// one-hop alias resolution shared by (b).
//
// Two proof scopes: FILE-WIDE (`isProvenNonEmptyInFile` / `isProvenNonEmpty`
// — the expect(...)-based pins, checked anywhere in the same test file) and
// BLOCK-LOCAL (`blockHasWideGuard` / `blockHasLengthThrowGuard` — an
// `if (C.length === 0) throw` guard or an `expect.assertions`/
// `expect.hasAssertions()` call, both scoped to the offending block itself).
// `classifyTarget` resolves a loop's raw collection text to either an
// immediate self-proof (a literal, or `Object.entries/keys/values` over one)
// or a normalized key for the file-wide lookup.

import { findCallSpan } from "./test-hygiene-shared.js";

/** Escape one identifier/property-path segment for embedding in a RegExp. */
function escapeRegExpLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a RegExp source fragment matching `target` with optional whitespace
 *  tolerated around each `.` in a dotted path. */
function targetPattern(target: string): string {
	return target
		.split(".")
		.map(escapeRegExpLiteral)
		.join("\\s*\\.\\s*");
}

const OBJECT_ENTRIES_RE = /^Object\s*\.\s*(?:entries|keys|values)\s*\(\s*(.+)\s*\)$/;

/** True when `t` is a NON-EMPTY bracket literal delimited by `openCh`/
 *  `closeCh` for its ENTIRE length (balanced — the closing bracket that
 *  returns depth to 0 must be the last character). A plain regex can't
 *  express this for a NESTED literal (`[[a, b], [c, d]]`); found via
 *  calibration 2026-09-07 when a nested-array for-of collection failed the
 *  old single-level-bracket regex and fired as a false positive. */
interface BracketPair {
	openCh: string;
	closeCh: string;
}

function isBalancedBracketLiteral(t: string, bracket: BracketPair): boolean {
	if (t[0] !== bracket.openCh || t[t.length - 1] !== bracket.closeCh) return false;
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (c === bracket.openCh) depth++;
		else if (c === bracket.closeCh) {
			depth--;
			if (depth === 0 && i !== t.length - 1) return false; // closed early
		}
	}
	return depth === 0 && /\S/.test(t.slice(1, -1));
}

const ARRAY_BRACKET: BracketPair = { openCh: "[", closeCh: "]" };
const OBJECT_BRACKET: BracketPair = { openCh: "{", closeCh: "}" };

/** True when `t` is a non-empty array literal (`[...]`), nesting included. */
function isInlineArrayLiteral(t: string): boolean {
	return isBalancedBracketLiteral(t, ARRAY_BRACKET);
}

/** True when `t` is a non-empty object literal (`{...}`), nesting included. */
function isInlineObjectLiteral(t: string): boolean {
	return isBalancedBracketLiteral(t, OBJECT_BRACKET);
}
// `<expr> as Foo` / `<expr> as const` — a trailing TypeScript type assertion.
// Found via calibration (2026-09-07): `for (const x of [a, b] as const)`
// otherwise fails the inline-literal test because the whole string no
// longer ENDS with `]`. Stripped before every other classification step so
// a cast never masks a literal or an `Object.entries(...)` call.
const TRAILING_AS_CAST_RE = /\s+as\s+[A-Za-z_$][\w$.<>[\], |]*$/;

/** One loop collection's classification: the normalized key used for pin
 *  lookups, and whether it's ALREADY proven non-empty by its own shape
 *  (a literal, or `Object.entries/keys/values` over one). */
export interface ClassifiedTarget {
	key: string;
	provenSafe: boolean;
}

/** Classify a loop's raw collection expression: an inline non-empty
 *  literal or `Object.entries|keys|values(<literal or bound literal>)`
 *  resolves immediately (after stripping a trailing `as <Type>` cast);
 *  anything else falls through to a normalized (whitespace-collapsed) key
 *  for file-wide pin lookup. */
export function classifyTarget(targetRaw: string, fileLiterals: Map<string, boolean>): ClassifiedTarget {
	const t = targetRaw.replace(/\s+/g, " ").trim().replace(TRAILING_AS_CAST_RE, "");
	if (isInlineArrayLiteral(t)) return { key: t, provenSafe: true };
	const oe = OBJECT_ENTRIES_RE.exec(t);
	if (oe) {
		const inner = (oe[1] ?? "").trim();
		if (isInlineArrayLiteral(inner) || isInlineObjectLiteral(inner)) {
			return { key: t, provenSafe: true };
		}
		if (fileLiterals.get(inner.replace(/\s+/g, ""))) return { key: t, provenSafe: true };
		return { key: inner.replace(/\s+/g, ""), provenSafe: false };
	}
	const collapsed = t.replace(/\s+/g, "");
	return { key: collapsed, provenSafe: fileLiterals.get(collapsed) === true };
}

/** True when a `const`/`let`-bound literal value (array/object/`new
 *  Set(...)`/`new Map(...)`) is non-empty. */
function isNonEmptyLiteralValue(value: string): boolean {
	if (value.startsWith("[") || value.startsWith("{")) {
		return /[^\s[\]{}]/.test(value.slice(1, -1));
	}
	const setMap = /^new\s+(?:Set|Map)\s*\(\s*(\[[^\]]*\])?\s*\)$/.exec(value);
	if (setMap) {
		const arr = setMap[1];
		return arr !== undefined && /[^\s[\]]/.test(arr.slice(1, -1));
	}
	return false;
}

const LITERAL_BINDING_RE =
	/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(\[[^\];]*\]|\{[^};]*\}|new\s+(?:Set|Map)\s*\(\s*(?:\[[^\]]*\])?\s*\))/g;

/** Every file-level `const`/`let` literal collection binding, mapped to
 *  whether it's non-empty (exemption (c)). */
export function fileLiteralCollections(fileMasked: string): Map<string, boolean> {
	const map = new Map<string, boolean>();
	LITERAL_BINDING_RE.lastIndex = 0;
	let m: RegExpExecArray | null = LITERAL_BINDING_RE.exec(fileMasked);
	while (m !== null) {
		map.set(m[1] ?? "", isNonEmptyLiteralValue(m[2] ?? ""));
		m = LITERAL_BINDING_RE.exec(fileMasked);
	}
	return map;
}

const ALIAS_DECL_RE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)/g;

/** One-hop alias map: `const rows = out.filter(...)` records `rows -> out`,
 *  so a pin on either name satisfies exemption (b) for `rows`. */
export function fileAliasBases(fileMasked: string): Map<string, string> {
	const map = new Map<string, string>();
	ALIAS_DECL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = ALIAS_DECL_RE.exec(fileMasked);
	while (m !== null) {
		const name = m[1] ?? "";
		const base = m[2] ?? "";
		if (name !== "" && base !== "" && name !== base) map.set(name, base);
		m = ALIAS_DECL_RE.exec(fileMasked);
	}
	return map;
}

/** Every file-wide non-empty pin shape for one target's literal pattern
 *  (does NOT resolve aliases — see {@link isProvenNonEmpty}). `objSubject`
 *  is the whole-collection subject alternation: the bare target, or the
 *  same target spread into a fresh array (`expect([...C]).toEqual([...])`
 *  proves `C` non-empty exactly like `expect(C).toEqual([...])` would —
 *  found via calibration 2026-09-07, `[...OPF_LABELS]` pinned via a sibling
 *  test that the bare-target patterns alone missed). */
function hasMappedCollectionPin(fileMasked: string, target: string): boolean {
	const opener = new RegExp(`expect\\s*\\(\\s*${targetPattern(target)}\\s*\\.\\s*map\\s*\\(`, "g");
	for (const match of fileMasked.matchAll(opener)) {
		const span = findCallSpan(fileMasked, match.index + match[0].length);
		if (!span) continue;
		const assertion = /^\s*\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*([^;]*)/.exec(fileMasked.slice(span.end + 1));
		if (!assertion) continue;
		const argument = assertion[1] ?? "";
		if (/^\[\s*[^\]\s]/.test(argument)) return true;
		const name = /^([A-Za-z_$][\w$]*)\s*\)/.exec(argument)?.[1];
		if (name && fileLiteralCollections(fileMasked).get(name)) return true;
	}
	return false;
}

function isProvenNonEmptyInFile(fileMasked: string, target: string): boolean {
	const t = targetPattern(target);
	const objSubject = `(?:${t}|\\[\\s*\\.\\.\\.\\s*${t}\\s*\\])`;
	const patterns = [
		new RegExp(`expect\\(\\s*${objSubject}\\s*\\)\\s*\\.\\s*toHaveLength\\(\\s*[1-9]\\d*\\s*\\)`),
		new RegExp(`expect\\(\\s*${t}\\s*\\.\\s*(?:length|size)\\s*\\)\\s*\\.\\s*toBe\\(\\s*[1-9]\\d*\\s*\\)`),
		new RegExp(`expect\\(\\s*${t}\\s*\\.\\s*(?:length|size)\\s*\\)\\s*\\.\\s*toBeGreaterThan\\(\\s*\\d+\\s*\\)`),
		new RegExp(`expect\\(\\s*${t}\\s*\\.\\s*(?:length|size)\\s*\\)\\s*\\.\\s*toBeGreaterThanOrEqual\\(\\s*[1-9]\\d*\\s*\\)`),
		new RegExp(`expect\\(\\s*${objSubject}\\s*\\)\\s*\\.\\s*not\\s*\\.\\s*toHaveLength\\(\\s*0\\s*\\)`),
		new RegExp(`expect\\(\\s*${objSubject}\\s*\\)\\s*\\.\\s*not\\s*\\.\\s*toEqual\\(\\s*\\[\\s*\\]\\s*\\)`),
		new RegExp(`expect\\(\\s*${objSubject}\\s*\\)\\s*\\.\\s*toEqual\\(\\s*\\[\\s*[^\\]\\s][^\\]]*\\]\\s*\\)`),
		new RegExp(`expect\\(\\s*${t}\\s*\\.\\s*length\\s*>\\s*0\\s*\\)\\s*\\.\\s*toBe\\(\\s*true\\s*\\)`),
	];
	return patterns.some((re) => re.test(fileMasked)) || hasMappedCollectionPin(fileMasked, target);
}

/** `target` is proven non-empty either directly, or via its one-hop alias
 *  (exemption (b)). */
export function isProvenNonEmpty(fileMasked: string, target: string, aliasBases: Map<string, string>): boolean {
	if (isProvenNonEmptyInFile(fileMasked, target)) return true;
	const base = aliasBases.get(target);
	return base !== undefined && isProvenNonEmptyInFile(fileMasked, base);
}

/** A block-wide `expect.assertions(n)` / `expect.hasAssertions()` guard —
 *  either exempts the WHOLE block regardless of loop target. */
export function blockHasWideGuard(blockBody: string): boolean {
	return /expect\.(?:assertions\s*\(\s*[1-9]\d*\s*\)|hasAssertions\s*\(\s*\))/.test(blockBody);
}

/** `if (<target>.length === 0) throw` guarding the block against an empty
 *  collection before the loop runs. */
export function blockHasLengthThrowGuard(blockBody: string, target: string): boolean {
	const t = targetPattern(target);
	return new RegExp(`if\\s*\\(\\s*${t}\\s*\\.\\s*length\\s*===\\s*0\\s*\\)\\s*throw`).test(blockBody);
}

/** The loop's own body contains a `throw` or `expect.fail(...)` — signals
 *  the author already reasoned about a non-happy-path shape for this loop
 *  (exemption (e)). */
export function loopBodyHasThrowOrFail(loopBodyText: string): boolean {
	return /\bthrow\b/.test(loopBodyText) || /expect\.fail\s*\(/.test(loopBodyText);
}
