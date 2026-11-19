// ===========================================
// Project Graph — Destructured Export Names
// ===========================================
// `export const { a, b: c, ...rest } = source;` and `export const [x, y] = pair;`
// export every binding of the pattern. The single-name regex in parser-exports.ts
// cannot see them, so a named import of one looked like a missing export.

import type { ExportedSymbol } from "../types.js";

const START_RE = /^export\s+(?:const|let|var)\s*[{[]/;
const DECLARATION_RE = /^export\s+(?:const|let|var)\s*/;

interface Cursor {
	s: string;
	i: number;
}

/** True when `trimmed` opens `export const|let|var` followed by `{` or `[`. */
export function startsDestructuredExport(trimmed: string): boolean {
	return START_RE.test(trimmed);
}

/**
 * Bracket depth of the leading binding pattern in `text` (`{`/`[` open, `}`/`]`
 * close, strings skipped). Returns 0 as soon as the pattern closes, so the
 * right-hand side never counts. A positive result means the pattern continues
 * on a later line.
 */
export function bracketDepth(text: string): number {
	let depth = 0;
	const scan: Scan = { i: 0, quote: undefined };
	for (; scan.i < text.length; scan.i++) {
		if (consumeString(text, scan)) continue;
		const ch = text[scan.i];
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth <= 0) return 0;
		}
	}
	return depth;
}

interface Scan {
	i: number;
	quote: string | undefined;
}

/** Track string-literal state for the character at `scan.i`; true when a string owns it. */
function consumeString(s: string, scan: Scan): boolean {
	const ch = s[scan.i] as string;
	if (scan.quote !== undefined) {
		if (ch === "\\") scan.i++;
		else if (ch === scan.quote) scan.quote = undefined;
		return true;
	}
	if (ch === "'" || ch === '"' || ch === "`") {
		scan.quote = ch;
		return true;
	}
	return false;
}

function skipWs(c: Cursor): void {
	while (c.i < c.s.length && /\s/.test(c.s[c.i] as string)) c.i++;
}

function readIdent(c: Cursor): string {
	const m = /^[\w$]+/.exec(c.s.slice(c.i));
	if (!m) return "";
	c.i += m[0].length;
	return m[0];
}

/** Skip a default-value expression up to the next top-level `,` or closing bracket. */
function skipDefault(c: Cursor): void {
	let depth = 0;
	const scan: Scan = { i: c.i, quote: undefined };
	for (; scan.i < c.s.length; scan.i++) {
		if (consumeString(c.s, scan)) continue;
		const ch = c.s[scan.i] as string;
		if ("{[(".includes(ch)) depth++;
		else if ("}])".includes(ch) && depth-- === 0) break;
		else if (ch === "," && depth === 0) break;
	}
	c.i = scan.i;
}

function skipOptionalDefault(c: Cursor): void {
	skipWs(c);
	if (c.s[c.i] !== "=") return;
	c.i++;
	skipDefault(c);
}

function parseTarget(c: Cursor, out: string[]): void {
	skipWs(c);
	const ch = c.s[c.i];
	if (ch === "{") {
		c.i++;
		parseElements(c, out, "}");
	} else if (ch === "[") {
		c.i++;
		parseElements(c, out, "]");
	} else {
		const id = readIdent(c);
		if (id) out.push(id);
	}
}

/** One object-pattern property: `key`, or `key: <target>`. */
function parseProperty(c: Cursor, out: string[]): void {
	const key = readIdent(c);
	skipWs(c);
	if (c.s[c.i] === ":") {
		c.i++;
		parseTarget(c, out);
	} else if (key) {
		out.push(key);
	}
}

/** Read the elements of an object or array pattern up to its `close` bracket. */
function parseElements(c: Cursor, out: string[], close: "}" | "]"): void {
	while (c.i < c.s.length) {
		skipWs(c);
		const ch = c.s[c.i];
		if (ch === undefined) return;
		const start = c.i;
		if (ch === close) {
			c.i++;
			return;
		}
		if (ch === ",") {
			c.i++;
			continue;
		}
		if (c.s.startsWith("...", c.i)) {
			c.i += 3;
			parseTarget(c, out);
		} else if (close === "}") {
			parseProperty(c, out);
		} else {
			parseTarget(c, out);
		}
		skipOptionalDefault(c);
		if (c.i === start) c.i++; // no progress on an unknown character
	}
}

/** The export records of a destructured declaration (one per bound name). */
export function destructuredExports(statement: string, line: number): ExportedSymbol[] {
	const keyword = /^export\s+([\w$]+)/.exec(statement)?.[1];
	const kind = keyword === "const" || keyword === "let" ? keyword : "var";
	return destructuredExportNames(statement).map((name) => ({ name, kind, isTypeOnly: false, line }));
}

/**
 * Match `export const { a } = x`, `export const [a] = y` and `export const enum E`
 * on one trimmed line, or return `null`. The `const enum` form is matched here so
 * the plain `export const <name>` matcher never reads the keyword `enum` as a name.
 */
export function matchDestructuredOrConstEnumExport(
	trimmed: string,
	line: number,
): ExportedSymbol[] | null {
	if (startsDestructuredExport(trimmed)) return destructuredExports(trimmed, line);
	const constEnum = /^export\s+const\s+enum\s+([\w$]+)/.exec(trimmed);
	if (constEnum?.[1] === undefined) return null;
	return [{ name: constEnum[1], kind: "enum", isTypeOnly: false, line }];
}

/**
 * Binding names exported by a destructured declaration statement, or `[]` when
 * the statement is not a destructuring pattern.
 */
export function destructuredExportNames(statement: string): string[] {
	const head = DECLARATION_RE.exec(statement);
	if (!head) return [];
	const c: Cursor = { s: statement, i: head[0].length };
	if (c.s[c.i] !== "{" && c.s[c.i] !== "[") return [];
	const out: string[] = [];
	parseTarget(c, out);
	return out;
}
