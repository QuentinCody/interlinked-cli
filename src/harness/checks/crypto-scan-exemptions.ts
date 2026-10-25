// Lexical exemptions for the crypto / TLS content scans in
// `agent-safety-crypto.ts` (`ubs_tls_verify_disabled`, `ubs_weak_hash`).
// Both checks are `pre_block`, so each exemption here is a legitimate shape
// the gate used to refuse (2026-10-21 adversarial review, round 2).

import { getExtension } from "./shared.js";

/** The text before a string that opens as the first argument of a logging or
 *  error call: `console.warn(`, `logger.error(`, `throw new Error(`,
 *  `raise RuntimeError(`, `warnings.warn(`, `print(`, or a bare `throw `. */
const MESSAGE_CALL_PREFIX_RE =
	/(?:\b(?:console|logger|logging|log)\.\w+\s*\(|\b(?:warn|warning|print|\w*Error)\s*\(|\bthrow\s+)\s*$/;

/** True when the string literal that starts at `index` on `line` is a message
 *  (its call is a logger / error constructor), not a shell command. */
export function stringOpensMessageCall(line: string, index: number): boolean {
	return MESSAGE_CALL_PREFIX_RE.test(line.slice(0, index));
}

/** A member / method head at line start: modifiers, then `md5(` / `sha1(`. */
const WEAK_HASH_SIG_HEAD_RE =
	/^\s*(?:(?:public|private|protected|static|async|readonly|abstract|override|export|declare)\s+)*(?:md5|sha1)\s*\(/i;
/** What follows the parameter list of a SIGNATURE: an optional return type
 *  then `{` (a body), or a return type then `;` (an overload / `.d.ts` /
 *  abstract member). A bare call ends in `;` with no return type, so
 *  `md5(buf);` is not matched. */
const WEAK_HASH_SIG_TAIL_RE = /^\s*(?:(?::\s*[^;{=]+)?\s*\{|:\s*[^;{=]+;)\s*$/;
/** Bound on how far a multi-line parameter list is followed. */
const SIG_MAX_LINES = 20;

/**
 * True when line `i` starts a method / interface-member SIGNATURE named
 * md5 / sha1 (not a call). The parameter list is paren-balanced across up to
 * {@link SIG_MAX_LINES} lines, so a Prettier multi-line signature and a
 * parameter whose type has its own parens (`cb: (err: Error) => void`) are
 * both recognized. Expects the strings-blanked view.
 */
export function isWeakHashSignatureAt(lines: readonly string[], i: number): boolean {
	const head = WEAK_HASH_SIG_HEAD_RE.exec(lines[i] ?? "");
	if (head === null) return false;
	let depth = 1;
	let col = head[0].length;
	for (let j = i; j < lines.length && j - i <= SIG_MAX_LINES; j++, col = 0) {
		const l = lines[j] ?? "";
		for (let k = col; k < l.length; k++) {
			if (l[k] === "(") depth++;
			else if (l[k] === ")" && --depth === 0) return WEAK_HASH_SIG_TAIL_RE.test(l.slice(k + 1));
		}
	}
	return false;
}

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JSX_EXTS = new Set([".tsx", ".jsx"]);
/** An inline type-literal method member: `{ md5(buf: Uint8Array): string }`.
 *  Opened by `{` or `;` and closed by `;` or `}` after a return type — a JS
 *  call has no `): T` tail, so it cannot have this shape. */
const TS_TYPE_MEMBER_RE = /([{;]\s*)(?:readonly\s+)?(?:md5|sha1)\s*\([^()]*\)\s*:\s*[^;{}=()]+(?=[;}])/gi;
/** JSX text on one line: the run after an opening tag (`<p>`, `<p class="x">`,
 *  `<>`) up to the next `<`, with no `{` expression inside it. */
const JSX_TEXT_RE = /(<[A-Za-z][^<>]*>|<>)[^<>{}]*(?=<)/g;

/**
 * Remove the shapes on a strings-blanked code line that name md5 / sha1
 * without calling them: TS inline type-literal members (TS files) and
 * single-line JSX text (`.tsx` / `.jsx`). A real call elsewhere on the line
 * survives. Multi-line JSX text is a known gap.
 */
export function stripWeakHashNonCalls(code: string, filePath: string): string {
	const ext = getExtension(filePath);
	let out = code;
	if (TS_EXTS.has(ext)) out = out.replace(TS_TYPE_MEMBER_RE, "$1");
	if (JSX_EXTS.has(ext)) out = out.replace(JSX_TEXT_RE, "$1");
	return out;
}
