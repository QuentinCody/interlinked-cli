// CLASS: temporary directories inside a repository can leak into compilation.
// FIRES WHEN: recognized mkdtemp/mkdirSync calls in JS/TS tests have paths not
// recognized as OS-temp-rooted, with repository-root evidence for the fixture.
// DOES NOT FIRE: enclosing function parameters, recognized tmpdir/path roots,
// up to eight same-file binding hops, or a locally shadowed mkdtemp wrapper.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | original | 53/unknown | 17/17 inspected FP | parameter and root resolution |
// | round 1 | 6/6 | not independently measured | excluded other sessions' files |
// KNOWN GAPS: cross-file path builders, indexed roots, and recognized temp-name
// conventions can misclassify paths. No fixture is created by this detector.
// HOW TO EXTEND: improve path provenance in the roots helper with P/N fixtures;
// do not widen name-based exemptions. Census: scripts/scan-test-discrimination.ts.

import { nonNull } from "../../lib/non-null.js";
import { isTestFile } from "./shared-test-classification.js";
import { extractRootIdentifier, isEnclosingParameter } from "./test-isolation-fixture-dir-roots.js";
import {
	getExtension,
	type InlineMatch,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES = 10;

// Tokens that mean "this expression is rooted in the OS temp dir" — checked
// against the call's path-argument text AND, transitively, against the
// same-file declaration of any identifier the argument references. The
// `tmpRoot`/`tempRoot`/`TEMP_ROOT` names are a convention, not the only
// route: `realpathSync(mkdtempSync(` is included by CONTENT so a wrapper
// bound to any name (`tmpRealRoot`, `sandboxRoot`, …) still qualifies once
// resolution reaches its own definition — see `referencesTmpRoot`.
const TMP_ROOTED_RE =
	/\btmpdir\s*\(|\bos\s*\.\s*tmpdir\s*\(|\bTMPDIR\b|\bTEMP_ROOT\b|\btempRoot\b|\btmpRoot\b|\brealpathSync\s*\(\s*mkdtempSync\s*\(/;

// Call heads this detector watches. Captures the verb so the message can
// name it. `fs.promises.mkdtemp` and a bare `mkdtemp`/`mkdtempSync` both
// match via the optional `(?:fs\s*\.\s*promises\s*\.\s*)?` member prefix.
const MKDTEMP_CALL_RE = /\b(?:fs\s*\.\s*promises\s*\.\s*)?(mkdtempSync|mkdtemp)\s*\(/g;
const MKDIRSYNC_CALL_RE = /\bmkdirSync\s*\(/g;

// A same-file `IDENT = ...` binding — either a `const/let/var` declaration OR
// a plain assignment (the common test shape: `let dir: string;` declared once,
// then assigned inside `beforeEach`). Used to resolve a bare identifier passed
// as the mkdtemp/mkdirSync path argument back to its initializer, so
// `mkdtempSync(TMP_ROOT)` or a later `mkdirSync(join(tempDir, "sub"))` can be
// judged by what `tempDir` actually holds. The negative lookahead on `=`
// keeps `===`/`==`/`>=`/`<=`/`!=` from being misread as an assignment.
// Every `IDENT = ...` binding in the file, not just the first — the common
// test shape is `let dir = "";` (a placeholder initializer) declared once,
// then REASSIGNED to the real tmp-rooted value inside `beforeEach`. Trying
// only the first match would resolve to the placeholder and miss the real
// value.
interface Initializer {
	text: string;
	/** Char offset of the whole `ident = …;` match in `stripped` — the
	 *  declaration SITE, used to scope a parameter-alias check (see
	 *  `referencesTmpRoot`) to the function actually enclosing it. */
	offset: number;
}

function findAllInitializers(stripped: string, ident: string): Initializer[] {
	const escaped = ident.replace(/[$]/g, "\\$");
	const assignRe = new RegExp(`\\b${escaped}\\s*=(?![=>])\\s*([^;]+);`, "g");
	return Array.from(stripped.matchAll(assignRe), (m) => ({ text: nonNull(m[1]), offset: nonNull(m.index) }));
}

/** The text of a same-file `function IDENT(...) { ... }` body's FIRST `return`
 *  expression, or null. Handles the `function plansDir(): string { return
 *  join(tmp, …); }` helper shape — a bare `plansDir()` call site needs its
 *  return value traced the same way an identifier's initializer is. */
function findFunctionReturnExpression(stripped: string, ident: string): string | null {
	const escaped = ident.replace(/[$]/g, "\\$");
	const headRe = new RegExp(`\\bfunction\\s+${escaped}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`);
	const head = headRe.exec(stripped);
	if (!head) return null;
	const bodyStart = head.index + head[0].length;
	let depth = 1;
	for (let i = bodyStart; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const body = stripped.slice(bodyStart, i);
				const ret = /\breturn\s+([^;]+);/.exec(body);
				return ret ? nonNull(ret[1]) : null;
			}
		}
	}
	return null;
}

const IDENT_TOKEN_RE = /[A-Za-z_$][\w$]*/g;
// Bounded so a pathological reference chain can't loop forever. Real chains
// run deeper than the original 4-hop budget once a same-file helper wraps
// another same-file helper (`skipDir → dir → newTmp() → d → mkTmp(prefix) →
// tmpdir()` is 5 hops); 8 covers every observed real chain with headroom.
const MAX_RESOLVE_DEPTH = 8;

/** True when some same-file `ident = <expr>;` assignment's ORIGINAL
 *  (comments stripped, strings intact) right-hand side contains a `/tmp/` or
 *  `/private/tmp/` string literal — the one shape the fully-stripped view
 *  (strings blanked to `""`) can never see, e.g.
 *  `const tmp = realpathSync(mkdtempSync("/tmp/x-"));`. */
function identifierRhsHasTmpLiteral(originalNoComments: string, ident: string): boolean {
	const escaped = ident.replace(/[$]/g, "\\$");
	const assignRe = new RegExp(`\\b${escaped}\\s*=(?![=>])\\s*([^;]+);`, "g");
	for (const m of originalNoComments.matchAll(assignRe)) {
		if (TMP_LITERAL_RE.test(nonNull(m[1]))) return true;
	}
	return false;
}

/** One alias hop's initializer text is itself checked against
 *  {@link extractRootIdentifier} + {@link isEnclosingParameter}: a two-hop
 *  `const local = join(param, "x"); mkdirSync(local)` never puts `param`
 *  directly in the judged call's argument text, only in `local`'s OWN
 *  initializer — so the parameter-root rule has to run again at each hop,
 *  scoped to that hop's declaration site (`init.offset`), not just at the
 *  top-level call. */
function initializerRootIsParameter(stripped: string, init: Initializer): boolean {
	const rootIdent = extractRootIdentifier(init.text.trim());
	return rootIdent !== null && isEnclosingParameter(stripped, rootIdent, init.offset);
}

/** Resolve one identifier hop: true when `ident` itself is tmp-rooted, via a
 *  literal in its own RHS, a same-file function it names, or any same-file
 *  `ident = …;` binding (checked both for a parameter-root alias and,
 *  recursively, for a tmp-rooted RHS). Split out of {@link referencesTmpRoot}
 *  to keep that function's branch count under the per-edit ratchet. */
function resolveIdentifierHop(ident: string, views: ScanViews, depth: number, seen: Set<string>): boolean {
	if (identifierRhsHasTmpLiteral(views.originalNoComments, ident)) return true;
	const fnReturn = findFunctionReturnExpression(views.stripped, ident);
	if (fnReturn !== null) return referencesTmpRoot(fnReturn, views, depth + 1, seen);
	for (const init of findAllInitializers(views.stripped, ident)) {
		if (initializerRootIsParameter(views.stripped, init)) return true;
		if (referencesTmpRoot(init.text, views, depth + 1, seen)) return true;
	}
	return false;
}

/** True when `text` is (or transitively references, up to `MAX_RESOLVE_DEPTH`
 *  same-file hops) an expression rooted in the OS temp dir. `seen` guards
 *  against a reference cycle. `views.originalNoComments` backs the
 *  literal-`/tmp/` check, which needs strings intact where `views.stripped`
 *  has blanked them. */
function referencesTmpRoot(text: string, views: ScanViews, depth: number, seen: Set<string>): boolean {
	if (TMP_ROOTED_RE.test(text)) return true;
	if (depth >= MAX_RESOLVE_DEPTH) return false;
	for (const m of text.matchAll(IDENT_TOKEN_RE)) {
		const ident = m[0];
		if (seen.has(ident)) continue;
		const nextSeen = new Set(seen).add(ident);
		if (resolveIdentifierHop(ident, views, depth, nextSeen)) return true;
	}
	return false;
}

/** True when `argText` (the raw path-argument text) is rooted in the OS temp
 *  dir — directly, or transitively via a chain of same-file identifier
 *  declarations (e.g. `dataDir = join(cwd, …)` where `cwd` itself derives
 *  from `mkdtempSync(join(tmpdir(), …))`). */
function isTmpRooted(argText: string, views: ScanViews): boolean {
	return referencesTmpRoot(argText.trim(), views, 0, new Set());
}

/** The two derived views of one file's content every resolver below needs:
 *  `stripped` (comments AND strings blanked — safe for structural regex) and
 *  `originalNoComments` (comments only stripped — strings intact, needed for
 *  the literal-`/tmp/`-in-a-binding check). Bundled to keep call sites under
 *  the data-clump threshold for same-typed params. */
interface ScanViews {
	stripped: string;
	originalNoComments: string;
}

interface ArgScanState {
	depth: number;
	start: number;
}

/** One char of the arg-scan: mutates `state` and returns the slice end index
 *  when the first argument closes (its terminating `,` or the call's final
 *  `)`), else null to keep scanning. */
function processArgScanChar(text: string, i: number, state: ArgScanState): number | null {
	const ch = text[i];
	if (ch === "(" || ch === "[" || ch === "{") {
		if (state.depth === 0 && state.start === -1 && ch === "(") {
			state.start = i + 1;
			state.depth = 1;
			return null;
		}
		state.depth++;
		return null;
	}
	if (ch === ")" || ch === "]" || ch === "}") {
		state.depth--;
		return state.depth === 0 && ch === ")" ? i : null;
	}
	if (ch === "," && state.depth === 1 && state.start !== -1) return i;
	return null;
}

/** Extract the text of the first argument of a call whose `(` sits at
 *  `openParenIdx` in `text`, respecting nested parens/brackets/braces.
 *  Returns null if the call never closes (unbalanced / truncated slice). */
function firstArgText(text: string, openParenIdx: number): string | null {
	const state: ArgScanState = { depth: 0, start: -1 };
	for (let i = openParenIdx; i < text.length; i++) {
		const end = processArgScanChar(text, i, state);
		if (end !== null) return text.slice(state.start, end);
	}
	return null;
}

/** True when the call's full argument list (up to its matching close-paren)
 *  contains a `recursive: true` option — required for a bare mkdirSync call
 *  to be in scope (per the contract: only the `{ recursive: true }` shape). */
function hasRecursiveTrueOption(text: string, openParenIdx: number): boolean {
	let depth = 0;
	for (let i = openParenIdx; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				return /\brecursive\s*:\s*true\b/.test(text.slice(openParenIdx, i));
			}
		}
	}
	return false;
}

interface OffendingCall {
	verb: string;
	pathArg: string;
}

// A quoted string literal (in ORIGINAL, unstripped text) rooted at the shell's
// canonical temp dir — `/tmp` or its macOS-resolved `/private/tmp` form,
// WITH or WITHOUT a trailing slash (`"/tmp"` and `"/tmp/x-"` both qualify —
// the lookahead just needs the next char to continue the path or close the
// literal, so `/tmpfoo` is correctly rejected). Established convention in
// this codebase (see `test-hygiene-isolation.ts::TMP_PATH_RE`, `daemons.test.ts`'s
// deliberate `/tmp/...` — shorter than `os.tmpdir()`'s deep macOS path, needed
// to keep a Unix-socket path under `sun_path`'s ~104-char limit). Reused for
// a literal ANYWHERE on the judged call's own source line (below) and for one
// buried inside a same-file BINDING's right-hand side
// (`identifierRhsHasTmpLiteral` above) — nested in `join(...)` either way.
const TMP_LITERAL_RE = /["'`](?:\/private)?\/tmp(?=["'`/])/;

interface CallFamilySpec {
	/** Global regex matching the call head; if `verbGroup` is set, that
	 *  capture group names the verb, else `fixedVerb` is used for every hit. */
	re: RegExp;
	verbGroup: number | null;
	fixedVerb: string | null;
	/** `mkdirSync` is only in scope with an explicit `{ recursive: true }`. */
	requiresRecursiveTrue: boolean;
}

/** Judge one regex match's call site; returns the offending call info or
 *  null when it's out of scope, tmp-rooted, or its root identifier is a
 *  parameter of the enclosing function (the caller's job to have passed a
 *  tmp-rooted value in — this file can't see the call site). */
function judgeCall(
	spec: CallFamilySpec,
	verb: string,
	views: ScanViews,
	callOffset: number,
	openParenIdx: number,
): OffendingCall | null {
	if (spec.requiresRecursiveTrue && !hasRecursiveTrueOption(views.stripped, openParenIdx)) return null;
	const arg = firstArgText(views.stripped, openParenIdx);
	if (arg === null) return null;
	const trimmedArg = arg.trim();
	const rootIdent = extractRootIdentifier(trimmedArg);
	if (rootIdent !== null && isEnclosingParameter(views.stripped, rootIdent, callOffset)) return null;
	if (isTmpRooted(trimmedArg, views)) return null;
	return { verb, pathArg: trimmedArg.slice(0, 60) };
}

/** True when the char sequence immediately before `verbStart` (skipping
 *  whitespace) is the `function` keyword — i.e. this match is a function
 *  DECLARATION's own head (`function mkdtempSync(prefix) {`), not a call.
 *  The call-family regexes only match a verb name followed by `(`, which a
 *  same-named declaration's own parameter list satisfies too. */
function isFunctionDeclarationHead(stripped: string, verbStart: number): boolean {
	return /\bfunction\s*$/.test(stripped.slice(Math.max(0, verbStart - 20), verbStart));
}

/** True when the char immediately before `verbStart` (skipping whitespace)
 *  is `.` — a member-access call (`fs.mkdtempSync(`,
 *  `require("node:fs").mkdtempSync(`) rather than a bare, unqualified one. */
function isMemberAccessCall(stripped: string, verbStart: number): boolean {
	let i = verbStart - 1;
	while (i >= 0 && /\s/.test(stripped[i] ?? "")) i--;
	return stripped[i] === ".";
}

/** True when the file declares its OWN `function <verb>(` or `const <verb> =`
 *  — shadowing the real fs API. A bare (non-member-access) call to `verb`
 *  then calls the LOCAL wrapper, not fs. */
function isShadowedInFile(stripped: string, verb: string): boolean {
	const escaped = verb.replace(/[$]/g, "\\$");
	return new RegExp(`\\bfunction\\s+${escaped}\\s*\\(|\\bconst\\s+${escaped}\\s*=`).test(stripped);
}

/** True when this regex match should NOT be judged as a real call: either
 *  it's a function-declaration head, or it's a bare call to a verb the file
 *  shadows with its own definition — the wrapper's own internal call is a
 *  separate match, judged on its own line. */
function shouldSkipCallSite(views: ScanViews, verb: string, verbStart: number): boolean {
	if (isFunctionDeclarationHead(views.stripped, verbStart)) return true;
	return isShadowedInFile(views.stripped, verb) && !isMemberAccessCall(views.stripped, verbStart);
}

/** Scan one call-family spec over the stripped content, appending offending
 *  calls (with their absolute char offset) to `out`. */
function scanCallFamily(
	spec: CallFamilySpec,
	views: ScanViews,
	out: Array<{ offset: number; call: OffendingCall }>,
): void {
	spec.re.lastIndex = 0;
	let m: RegExpExecArray | null = spec.re.exec(views.stripped);
	while (m !== null) {
		const verb = spec.fixedVerb ?? nonNull(m[spec.verbGroup === null ? 0 : spec.verbGroup]);
		const openParenIdx = m.index + m[0].length - 1;
		const verbStart = m.index + m[0].lastIndexOf(verb);
		if (!shouldSkipCallSite(views, verb, verbStart)) {
			const judged = judgeCall(spec, verb, views, m.index, openParenIdx);
			if (judged) out.push({ offset: m.index, call: judged });
		}
		m = spec.re.exec(views.stripped);
	}
}

/**
 * Public API — flags test-file calls that create an in-tree temp fixture
 * directory instead of one rooted in the OS temp dir. See file header for
 * the harness-debt row this generalizes from.
 */
export function checkInTreeTempFixture(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const views: ScanViews = { stripped: stripCommentsAndStrings(content), originalNoComments: stripComments(content) };
	const found: Array<{ offset: number; call: OffendingCall }> = [];

	scanCallFamily({ re: MKDTEMP_CALL_RE, verbGroup: 1, fixedVerb: null, requiresRecursiveTrue: false }, views, found);
	scanCallFamily(
		{ re: MKDIRSYNC_CALL_RE, verbGroup: null, fixedVerb: "mkdirSync", requiresRecursiveTrue: true },
		views,
		found,
	);

	found.sort((a, b) => a.offset - b.offset);

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (const { offset, call } of found) {
		if (matches.length >= MAX_MATCHES) break;
		const line = (views.stripped.slice(0, offset).match(/\n/g) ?? []).length + 1;
		// A `/tmp`/`/private/tmp` literal ANYWHERE on the judged call's own
		// source line — nested in `join(...)`, with or without a trailing
		// slash — is tmp-rooted too. The ORIGINAL (unstripped) line is
		// required: the stripped view already blanked any string content.
		if (TMP_LITERAL_RE.test(nonNull(originalLines[line - 1]))) continue;
		matches.push({
			line,
			text: `in_tree_temp_fixture: ${call.verb}(...) path "${call.pathArg}" is not rooted in the OS temp dir — use join(tmpdir(), ...) / os.tmpdir(), not a src/-relative or cwd-relative path. A leaked dir here poisons the whole-project typecheck and coverage report.`,
		});
	}
	return matches;
}
