// ===========================================
// Taste Checks — private-member access from tests
// Uncle Bob, "Test Contra-variance" (2017)
// ===========================================
// Moved out of taste-checks-test-assertions.ts (2026-10-21) so the repaired
// detector fits under the per-file line cap; that module re-exports it, so
// importers of "./taste-checks-test-assertions.js" are unchanged.

import { nonNull } from "../lib/non-null.js";
import { stripComments } from "./strip-helpers.js";
import { type InlineMatch, isJsTs, isTestFile, push, stripCommentsAndStrings } from "./taste-checks-shared.js";

// `(x as any).privateThing` in a test reaches past the public API — EXCEPT when
// the accessed surface is itself public API of a different contract: vitest/jest
// mock introspection (`(fetchMock as any).mock.calls[0][0]` — the mock's own
// documented API, not the SUT's internals) or host-global stubbing
// (`(globalThis as any).fetch = vi.fn()` — environment setup, not privacy
// violation). Both were repo-wide FP idioms (2026-07 recon).
const MOCK_API_AFTER =
	/^\s*\.\s*(?:mock|calls|mockClear|mockReset|mockRestore|mockName|getMockName|mockImplementation(?:Once)?|mockReturnValue(?:Once)?|mockResolvedValue(?:Once)?|mockRejectedValue(?:Once)?|mockReturnThis)\b/;

const HOST_GLOBALS = new Set([
	"globalThis",
	"window",
	"global",
	"self",
	"process",
	"console",
	"document",
	"navigator",
]);

// Dunders that are runtime/module-system conventions, not privacy markers.
const RUNTIME_DUNDERS = new Set(["__proto__", "__esModule", "__dirname", "__filename"]);

// `as any` is the universal strictness escape, so it is judged by the SHAPE of
// the access. A private-looking name (`_x`, `privateX`, `internalX`; anchored, so
// `isPrivateMode` is not one) always fires. Another member is exempt only in a
// shape that shows public use (2026-10-21 cross-repo: 11/12 fires were these):
//   a direct method call       `(schema as any).safeParse(x)` (untyped/union value)
//   a typeof feature probe     `typeof (r as any).safeParse === "function"`
//   a mock or literal attach   `(api as any).dispatch = vi.fn()` (interop hook)
//   a mock-matcher read-back   `expect((api as any).dispatch).not.toBeCalled()`
//   an absence probe           `expect((parsed as any).isAdmin).toBeUndefined()`
//   an uncast read elsewhere   `tree.properties` in the same file
// A chained read (`(svc as any).cache.clear()`) or a non-literal write fires.
// `as unknown as T` stays shape-agnostic: naming a type the public surface
// lacks is itself the reach.
const PRIVATE_LOOKING_MEMBER = /^(?:_|private|internal)/i;
const CAST_ANY_MEMBER = /^\s*\.\s*([A-Za-z_$][\w$]*)/;
const TYPEOF_BEFORE = /\btypeof\s*$/;
const DIRECT_CALL_AFTER = /^\s*\(/;
// Strings are already stripped to empty quotes on the scanned line.
const MOCK_OR_LITERAL_WRITE_AFTER =
	/^\s*=(?!=)\s*(?:(?:vi|jest)\s*\.\s*fn\s*\(|(?:true|false|null|undefined)\b|-?\d|""|''|``)/;
const MOCK_READBACK_AFTER =
	/^\s*\)\s*(?:\.\s*not\s*)?\.\s*(?:to(?:Have)?Be(?:en)?(?:Last|Nth)?Called|toHaveReturned|toReturn|lastCalledWith|nthCalledWith)/;
const ABSENCE_PROBE_AFTER =
	/^\s*\)\s*\.\s*(?:toBeUndefined\s*\(\s*\)|(?:toBe|toEqual|toStrictEqual)\s*\(\s*undefined\s*\))/;

// `(?<![\w$)\]])`: a `(` right after a callee is a CALL paren, so in
// `pick(mask as any).shape` the member belongs to the call result (zod 2026-10-21).
const CAST_ANY_ACCESS = /(?<![\w$)\]])\(\s*([A-Za-z_$][\w$]*)\s+as\s+any\s*\)\s*(?=\.)/g;
// The `as unknown as <Type>` form: the type text is unbounded (it may contain
// parens, e.g. `{ flush(): void }`), so the accessor is located separately —
// a `)` followed by `.` or `[` somewhere after the cast keywords.
const CAST_UNKNOWN_START = /\(\s*([A-Za-z_$][\w$]*)\s+as\s+unknown\s+as\s+/g;
const CAST_UNKNOWN_ACCESSOR = /\)(?=\s*[.[])/;
const DUNDER_MEMBER = /\.\s*(_{2,}[A-Za-z_$][\w$]*)\s*[(=.]/g;
// Runs against the ORIGINAL (comment-stripped only) line: the main scan strips
// string CONTENTS, which turned `svc["__private"]` into `svc[""]` and made
// this alternative dead code (2026-07 recon). Strings must stay intact here.
// Group 1 is a preceding `.` (the receiver is then a MEMBER, never a host
// global: `foo.window["__X"]`); group 3 is a following assignment.
const BRACKET_PRIVATE = /(\.\s*)?(?<![\w$])([A-Za-z_$][\w$]*)\s*\[\s*["']_{2,}[^"']*["']\s*\](\s*=(?!=))?/g;
// Receiver of a `.__member` access: a bare identifier (group 2; group 1 is a
// preceding `.`, which makes it a member) or a cast ending before it (group 3).
const DUNDER_RECEIVER =
	/(?:(\.\s*)?(?<![\w$])([A-Za-z_$][\w$]*)|\(\s*([A-Za-z_$][\w$]*)\s+as\s+(?:any|unknown\s+as\s+[^()]+?)\s*\))\s*$/;

/** True when a cast-then-access is mock-API introspection or host-global
 *  stubbing rather than a reach into the SUT's private members.
 *  `tail` starts at the character after the cast's closing paren. */
function isExemptCastAccess(ident: string, tail: string): boolean {
	return HOST_GLOBALS.has(ident) || MOCK_API_AFTER.test(tail);
}

/** Does the file read `receiver.member` WITHOUT a cast? Then the type allows it. */
function hasUncastAccess(stripped: string, receiver: string, member: string): boolean {
	const esc = (s: string): string => s.replace(/\$/g, "\\$");
	return new RegExp(`(?<![\\w$.])${esc(receiver)}\\s*\\??\\.\\s*${esc(member)}(?![\\w$])`).test(stripped);
}

/** `before` ends at the cast's `(`; `after` starts right after the member name. */
function isPublicUseShape(before: string, after: string, uncastAccess: () => boolean): boolean {
	return (
		TYPEOF_BEFORE.test(before) ||
		DIRECT_CALL_AFTER.test(after) ||
		MOCK_OR_LITERAL_WRITE_AFTER.test(after) ||
		MOCK_READBACK_AFTER.test(after) ||
		ABSENCE_PROBE_AFTER.test(after) ||
		uncastAccess()
	);
}

/** Any non-exempt `(x as any).<member>` on this (string-stripped) line? */
function hasCastAnyViolation(line: string, stripped: string): boolean {
	for (const m of line.matchAll(CAST_ANY_ACCESS)) {
		const receiver = nonNull(m[1]);
		const tail = line.slice(m.index + m[0].length);
		if (isExemptCastAccess(receiver, tail)) continue;
		const member = CAST_ANY_MEMBER.exec(tail);
		if (member === null) continue;
		const name = nonNull(member[1]);
		if (PRIVATE_LOOKING_MEMBER.test(name)) return true;
		const after = tail.slice(member[0].length);
		if (!isPublicUseShape(line.slice(0, m.index), after, () => hasUncastAccess(stripped, receiver, name))) {
			return true;
		}
	}
	return false;
}

/** A dunder WRITE on a host global (`window.__REDUX_DEVTOOLS_EXTENSION__ = stub`)
 *  is environment stubbing. A call or chained read through one
 *  (`(globalThis as any).__myLibInternal.reset()`) uses SUT state, and a MEMBER
 *  named like a global (`obj.window.__x`) is not a global at all. */
function dunderReceiverIsHostGlobal(before: string): boolean {
	const r = DUNDER_RECEIVER.exec(before);
	return r !== null && r[1] === undefined && HOST_GLOBALS.has(nonNull(r[2] ?? r[3]));
}

/** Any `ident["__private"]` on this (comment-stripped) line other than a write
 *  to a bare host global? */
function hasBracketPrivateViolation(line: string): boolean {
	for (const m of line.matchAll(BRACKET_PRIVATE)) {
		const hostWrite = m[1] === undefined && m[3] !== undefined && HOST_GLOBALS.has(nonNull(m[2]));
		if (!hostWrite) return true;
	}
	return false;
}

/** Any non-exempt `(x as unknown as T).member` on this line? Casts like
 *  `undefined as unknown as string` are plain type coercions — the result
 *  isn't used to REACH INTO private members, so an accessor after the
 *  closing paren is required. */
function hasCastUnknownViolation(line: string): boolean {
	for (const m of line.matchAll(CAST_UNKNOWN_START)) {
		const after = line.slice(m.index + m[0].length);
		const close = CAST_UNKNOWN_ACCESSOR.exec(after);
		if (!close) continue;
		const tail = after.slice(close.index + 1);
		if (!isExemptCastAccess(nonNull(m[1]), tail)) return true;
	}
	return false;
}

/** Any `.__member(`/`=`/`.` access that isn't a runtime-conventional dunder
 *  and isn't an assignment to a host global? */
function hasDunderViolation(line: string): boolean {
	for (const m of line.matchAll(DUNDER_MEMBER)) {
		if (RUNTIME_DUNDERS.has(nonNull(m[1]))) continue;
		if (m[0].endsWith("=") && dunderReceiverIsHostGlobal(line.slice(0, m.index))) continue;
		return true;
	}
	return false;
}

export function checkPrivateMemberTestAccess(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath) || !isJsTs(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	// Comment-stripped copy with strings INTACT for the bracket-literal branch
	// (both strippers are line-preserving, so indices align).
	const commentFree = stripComments(content);
	const lines = content.split("\n");
	const sLines = stripped.split("\n");
	const cLines = commentFree.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < sLines.length && matches.length < 10; i++) {
		const sLine = nonNull(sLines[i]);
		const fires =
			hasCastAnyViolation(sLine, stripped) ||
			hasCastUnknownViolation(sLine) ||
			hasDunderViolation(sLine) ||
			hasBracketPrivateViolation(nonNull(cLines[i]));
		if (fires) push(matches, i, lines, 10);
	}
	return matches;
}
