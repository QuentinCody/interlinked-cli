// Handling that excuses an empty catch clause for the `empty_catch` pre_block
// check (src/harness/taste-checks-checks-2.ts checkEmptyCatch).
//
// CLASS: an empty catch drops a real error with no handling and no rationale.
// The cross-repo falsification of 2026-10-21 read 17 foreign hits (zustand,
// tinybench, ky, date-fns, zod) and all 17 were false positives: the handling
// was in the code AROUND the clause, not in its body. A pre_block check
// refuses the edit, so each excuse below is one shape of that handling:
//   - fallback-guard: the try assigns a variable and the next statement tests it
//   - default-return: the try returns, and the code after the try returns or throws
//   - rejection-silencer: the whole try body attaches `.catch(handler)`
//   - rationale: a comment in the catch body or directly above the try says why
//   - assertion-after-try: in test code, the next statement is an assertion
//   - benchmark-throw-case: in a benchmark file, the try is the whole callback body
// DOES NOT EXCUSE: a short marker comment (`// ignore`, `// ENOENT: already
// gone`), a TODO, an `interlinked-ignore` directive (the suppression system
// owns it), a use of the value with no guard, or an assertion outside test code.
// Every rule reads `scan` (literals and comments blanked, same length as the
// content) for structure and the original content only for comment text.

import { nonNull } from "../lib/non-null.js";
import { isTestSourcePath } from "./checks/shared-test-classification.js";

export interface EmptyCatchSite {
	/** Original file content. */
	content: string;
	/** `content` with strings, templates, regex literals and comments blanked. */
	scan: string;
	filePath: string;
	/** Index of the `{` that opens the try block. */
	tryOpen: number;
	/** Index of the `}` that closes the try block. */
	tryClose: number;
	/** Index just past the `}` that closes the empty catch body. */
	catchEnd: number;
	/** Original text of the catch body, comments kept. */
	body: string;
}

export type EmptyCatchExcuse =
	| "fallback-guard"
	| "default-return"
	| "rejection-silencer"
	| "rationale"
	| "assertion-after-try"
	| "benchmark-throw-case";

/** Index of the matching `open` char for the `close` char at `at`, or -1. */
function matchBackward(text: string, at: number, open: string, close: string): number {
	for (let depth = 0, i = at; i >= 0; i--) {
		if (text[i] === close) depth++;
		else if (text[i] === open && --depth === 0) return i;
	}
	return -1;
}

/** Index of the matching `close` char for the `open` char at `at`, or -1. */
function matchForward(text: string, at: number, open: string, close: string): number {
	for (let depth = 0, i = at; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return i;
	}
	return -1;
}

function skipSpace(text: string, at: number): number {
	let i = at;
	while (i < text.length && /\s/.test(nonNull(text[i]))) i++;
	return i;
}

/** The try block that ends right before the `catch` at `at`, or null. A
 *  class or object-literal METHOD named `catch` (a thenable test double's
 *  `catch(onRejected) {}`) and JSX prose (`<code>catch (e) {}</code>`) have
 *  the clause's token shape but never follow a try block (2026-10-21
 *  adversarial review, round 2). An unbalanced `}` is not proof of a clause. */
export function tryBlockBefore(scan: string, at: number): { open: number; close: number } | null {
	let close = at - 1;
	while (close >= 0 && /\s/.test(nonNull(scan[close]))) close--;
	if (scan[close] !== "}") return null;
	const open = matchBackward(scan, close, "{", "}");
	if (open < 0) return null;
	return /(?<![\w$.])try\s*$/.test(scan.slice(Math.max(0, open - 32), open)) ? { open, close } : null;
}

const CONTROL_HEADER = /(?<![\w$.])(?:if|for|while)\s*$/;

/** True when the block opened at `open` is an if/else/for/while/do body, not
 *  a function, class or object body. */
function isControlBlock(scan: string, open: number): boolean {
	const head = scan.slice(Math.max(0, open - 400), open).trimEnd();
	if (/(?<![\w$.])(?:else|do)$/.test(head)) return true;
	if (!head.endsWith(")")) return false;
	const paren = matchBackward(head, head.length - 1, "(", ")");
	return paren >= 0 && CONTROL_HEADER.test(head.slice(0, paren));
}

const MAX_BLOCK_EXITS = 4;

/** Index of the first statement that runs after the try statement ends
 *  normally, leaving at most MAX_BLOCK_EXITS enclosing control blocks, or -1.
 *  A `finally` block is skipped; an `else` branch or a function end gives -1. */
export function statementAfterTry(scan: string, catchEnd: number): number {
	let i = skipSpace(scan, catchEnd);
	if (/^finally\s*\{/.test(scan.slice(i, i + 40))) {
		const close = matchForward(scan, scan.indexOf("{", i), "{", "}");
		if (close < 0) return -1;
		i = skipSpace(scan, close + 1);
	}
	for (let exits = 0; scan[i] === "}"; exits++) {
		const open = matchBackward(scan, i, "{", "}");
		if (exits >= MAX_BLOCK_EXITS || open < 0 || !isControlBlock(scan, open)) return -1;
		i = skipSpace(scan, i + 1);
		if (/^else\b/.test(scan.slice(i, i + 5))) return -1;
	}
	return i < scan.length ? i : -1;
}

const FAILURE_WORD =
	/\b(?:throw[sn]?|fail(?:s|ed|ure)?|errors?|exceptions?|reject(?:s|ed|ion)?|missing|unavailable|unsupported|absent|invalid|unknown)\b/i;
const REASON_WORD = /\b(?:if|when|because|since|unless|so|whether|only|not|never|cannot)\b|n't\b/i;
const DEFERRAL_WORD = /\b(?:TODO|FIXME|XXX|HACK)\b/;
/** A rationale is a sentence, not a tag: "Use default message if accessing
 *  properties throws" (7 words) explains; "ENOENT: already gone" (3) and
 *  "Ignore the error" (3) do not. */
const MIN_RATIONALE_WORDS = 6;
// Narrow marker vocabulary that excuses on its own. Generic keywords like
// "skip", "ignore", "fallback", "expected" are too common to force the
// author to explain *why* the error is safe to drop; these assert
// deliberation or harmlessness.
const INTENTIONAL_MARKER =
	/\b(?:intentional|best[-\s]?effort|cleanup\s+(?:is|only)|non[-\s]?(?:critical|fatal))\b/i;

/** True when `comment` explains why the error is safe to drop. Lines that are
 *  an `interlinked-ignore` directive are removed first: the suppression
 *  system owns them, and reading one as a rationale would leave it stale. */
export function isRationale(comment: string): boolean {
	const text = comment
		.split("\n")
		.filter((line) => !line.includes("interlinked-ignore"))
		.join("\n");
	if (INTENTIONAL_MARKER.test(text)) return true;
	if (DEFERRAL_WORD.test(text)) return false;
	const words = text.match(/[A-Za-z][\w'-]*/g) ?? [];
	return words.length >= MIN_RATIONALE_WORDS && FAILURE_WORD.test(text) && REASON_WORD.test(text);
}

const COMMENT_LINE = /^(?:\/\/|\/\*|\*)|\*\/$/;
const MAX_COMMENT_LINES = 12;

/** Index of the `try` keyword that opens the block at `tryOpen`. */
function tryKeywordAt(site: EmptyCatchSite): number {
	return site.scan.slice(0, site.tryOpen).trimEnd().length - "try".length;
}

/** The contiguous comment lines directly above the line of the `try` keyword. */
function commentAboveTry(site: EmptyCatchSite): string {
	const lines = site.content.slice(0, tryKeywordAt(site)).split("\n");
	lines.pop();
	const out: string[] = [];
	for (let i = lines.length - 1; i >= 0 && out.length < MAX_COMMENT_LINES; i--) {
		const line = nonNull(lines[i]).trim();
		if (!COMMENT_LINE.test(line)) break;
		out.unshift(line);
	}
	return out.join("\n");
}

const MAX_SILENCER_BODY = 500;
const SILENCER =
	/^[^;]*\.catch\s*\(\s*(?:[\w$.]+|\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|null|void\s+0))\s*\)\s*;?$/;

/** True when the whole try body attaches a rejection handler: the swallowed
 *  synchronous throw comes from a hostile `then`, and the handler is the
 *  handling (tinybench src/async.ts). */
function isRejectionSilencer(tryBody: string): boolean {
	const body = tryBody.trim();
	return body.length <= MAX_SILENCER_BODY && SILENCER.test(body);
}

/** True when the try body returns at its own level (no nested callback that
 *  could own the `return`). */
function returnsFromTry(tryBody: string): boolean {
	return /(?<![\w$.])return\b/.test(tryBody) && !/=>|(?<![\w$.])function\b/.test(tryBody);
}

// A plain or member-path assignment target (`x =`, `payload.value =`) whose
// declaration is outside the try, so the value is visible after it.
const ASSIGNED =
	/(?<![\w$.])(?<!(?:const|let|var)\s+)([A-Za-z_$][\w$.]*)(?<!\.)\s*=(?![=>])/g;

const escapeId = (id: string): string => id.replace(/[$.]/g, "\\$&");

/** The condition of an `if` that starts `next`, else the first statement. */
function guardText(next: string): string {
	if (!/^if\s*\(/.test(next)) return nonNull(next.split(/[;\n]/, 1)[0]);
	const open = next.indexOf("(");
	const close = matchForward(next, open, "(", ")");
	return close < 0 ? "" : next.slice(open, close + 1);
}

/** True when the try assigns a variable and the next statement tests it:
 *  `if (!x)`, or `x ?? fallback` / `x || fallback` (zustand devtools.ts). */
function guardsAssignedValue(tryBody: string, next: string): boolean {
	const ids = [...tryBody.matchAll(ASSIGNED)].map((m) => nonNull(m[1]));
	if (ids.length === 0) return false;
	const isIf = /^if\s*\(/.test(next);
	const guard = guardText(next);
	return ids.some((id) => {
		const name = escapeId(id);
		const pattern = isIf ? `(?<![\\w$.])${name}(?![\\w$])` : `(?<![\\w$.])${name}\\s*(?:\\?\\?|\\|\\|)`;
		return new RegExp(pattern).test(guard);
	});
}

const ASSERTION_START =
	/^(?:await\s+)?(?:expect\s*[(.]|assert\s*[(.]|t\.(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|like|regex|snapshot|throws|notThrows)\s*\()/;

function isTestCodePath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	return isTestSourcePath(norm) || /(?:^|\/)(?:test|spec)\.[cm]?[jt]sx?$/.test(norm);
}

const BENCHMARK_PATH = /(?:^|\/)(?:bench|benches|benchmarks?)\/|\.(?:bench|benchmark)\.[cm]?[jt]sx?$/;
const CALLBACK_OPEN = /(?:=>|(?<![\w$.])function\s*[\w$]*\s*\([^()]*\))\s*\{\s*$/;

/** True when the try statement is the whole body of a callback. */
function isWholeCallbackBody(site: EmptyCatchSite): boolean {
	const tryAt = tryKeywordAt(site);
	const before = site.scan.slice(Math.max(0, tryAt - 200), tryAt);
	return CALLBACK_OPEN.test(before) && site.scan[skipSpace(site.scan, site.catchEnd)] === "}";
}

/** Which handling excuses the empty catch at `site`, or null when none does. */
export function emptyCatchExcuse(site: EmptyCatchSite): EmptyCatchExcuse | null {
	const tryBody = site.scan.slice(site.tryOpen + 1, site.tryClose);
	if (isRejectionSilencer(tryBody)) return "rejection-silencer";
	if (isRationale(site.body) || isRationale(commentAboveTry(site))) return "rationale";
	const at = statementAfterTry(site.scan, site.catchEnd);
	const next = at < 0 ? "" : site.scan.slice(at, at + 400);
	if (/^(?:return|throw)\b/.test(next) && returnsFromTry(tryBody)) return "default-return";
	if (next && guardsAssignedValue(tryBody, next)) return "fallback-guard";
	if (isTestCodePath(site.filePath) && ASSERTION_START.test(next)) return "assertion-after-try";
	if (BENCHMARK_PATH.test(site.filePath) && isWholeCallbackBody(site)) return "benchmark-throw-case";
	return null;
}
