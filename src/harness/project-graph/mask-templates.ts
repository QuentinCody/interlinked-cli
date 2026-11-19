// ===========================================
// Project Graph — Template-Literal Masking
// ===========================================
// Removes the literal text of template literals so the import parser never
// reads `require("./x")` inside a string that a test or codemod writes out as
// source code. (Do not run it after maskComments: a backtick in
// a comment would open a false template). It masks comments in the same pass,
// because a `//` inside template text is text, not a comment. Newlines stay, so
// line structure is unchanged. A `${...}` expression is real code and stays; its literal text
// siblings go. An unterminated template makes the whole text unchanged: a
// guess about where code resumes would hide real imports.

import { endOfLineComment, maskComments, skipBlockComment, skipString } from "./mask-comments.js";

/** Kept text of one scanned unit, and the index just after it. */
interface Piece {
	add: string;
	next: number;
}

/** One unit inside a template: an escape, a `${...}` expression, or one character. Null when an expression never closes. */
function templatePiece(text: string, i: number): Piece | null {
	const ch = text[i];
	if (ch === "\\") return { add: text[i + 1] === "\n" ? "\n" : "", next: i + 2 };
	if (ch === "$" && text[i + 1] === "{") {
		const end = codeEnd(text, i + 2);
		if (end === null) return null;
		return { add: `\${${end.out}}`, next: end.close + 1 };
	}
	return { add: ch === "\n" ? "\n" : "", next: i + 1 };
}

/** Scan the template literal whose opening backtick is at `start`. Null when it never closes. */
function scanTemplate(text: string, start: number): Piece | null {
	let out = "`";
	let i = start + 1;
	while (i < text.length) {
		if (text[i] === "`") return { add: `${out}\``, next: i + 1 };
		const piece = templatePiece(text, i);
		if (piece === null) return null;
		out += piece.add;
		i = piece.next;
	}
	return null;
}

/** One unit of code: a quoted string, a comment, a whole template, or one character. Null when a template never closes. */
function codePiece(text: string, i: number): Piece | null {
	const ch = text[i];
	if (ch === "'" || ch === '"') {
		const end = skipString(text, i);
		return { add: text.slice(i, end), next: end };
	}
	if (ch === "/" && text[i + 1] === "/") return { add: "", next: endOfLineComment(text, i) };
	if (ch === "/" && text[i + 1] === "*") {
		const block = skipBlockComment(text, i);
		return { add: block.newlines, next: block.next };
	}
	if (ch === "`") return scanTemplate(text, i);
	return { add: ch ?? "", next: i + 1 };
}

/** Scan a `${` expression from `start`: its masked code and the index of the `}` that closes it. */
function codeEnd(text: string, start: number): { out: string; close: number } | null {
	let out = "";
	let depth = 0;
	let i = start;
	while (i < text.length) {
		if (text[i] === "}" && depth === 0) return { out, close: i };
		if (text[i] === "{") depth++;
		if (text[i] === "}") depth--;
		const piece = codePiece(text, i);
		if (piece === null) return null;
		out += piece.add;
		i = piece.next;
	}
	return null;
}

/**
 * Return `text` with comment text and template-literal text removed (see the
 * file header). One pass does both: a `//` inside template text is text, and a
 * backtick inside a comment opens nothing.
 */
export function maskCommentsAndTemplates(text: string): string {
	if (!text.includes("`")) return maskComments(text);
	let out = "";
	let i = 0;
	while (i < text.length) {
		const piece = codePiece(text, i);
		if (piece === null) return maskComments(text);
		out += piece.add;
		i = piece.next;
	}
	return out;
}
