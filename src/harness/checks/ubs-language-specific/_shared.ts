// Shared internal helpers for the UBS language-specific detector modules.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Not part of the public API — only the sibling check modules import this.

import { nonNull } from "../../../lib/non-null.js";
import { lineHasNoqaSuppression } from "../shared.js";

// ===========================================
// Extension predicates
// ===========================================

export const PY_EXTS = [".py", ".pyi"] as const;
export const JS_TS_EXT_LIST = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
] as const;

export function isPyFile(ext: string): boolean {
	return PY_EXTS.some((candidate) => candidate === ext);
}

export function isJsTsFile(ext: string): boolean {
	return JS_TS_EXT_LIST.some((candidate) => candidate === ext);
}

/** Per-detector finding cap shared across the UBS backlog detectors. */
export const MATCH_LIMIT = 10;

// ===========================================
// Comment/string stripping (preserving string contents)
// ===========================================

type QuoteChar = "'" | "\"" | "`";

/**
 * Strip one already-open block comment forward from index `i` in `line`,
 * looking for its closing `* /` sequence. Returns the still-in-block state
 * and how many extra characters were consumed (0 or 1, for the closer).
 */
function consumeBlockCommentChar(
	ch: string | undefined,
	next: string | undefined,
): { closed: boolean; extraAdvance: number } {
	if (ch === "*" && next === "/") return { closed: true, extraAdvance: 1 };
	return { closed: false, extraAdvance: 0 };
}

/**
 * Advance the in-string-literal state machine by one character. `stripped`
 * always keeps the character (string contents are preserved verbatim);
 * only `quote`/`escaped` change.
 */
function consumeQuotedChar(
	ch: string,
	quote: QuoteChar,
	escaped: boolean,
): { quote: QuoteChar | null; escaped: boolean } {
	if (escaped) return { quote, escaped: false };
	if (ch === "\\") return { quote, escaped: true };
	if (ch === quote) return { quote: null, escaped: false };
	return { quote, escaped };
}

/** What to do with one character that is outside a block comment and a string literal. */
type PlainCharAction =
	| { kind: "quoteStart"; quote: QuoteChar }
	| { kind: "blockStart" }
	| { kind: "lineCommentBreak" }
	| { kind: "append" };

/**
 * Classify a character that is neither inside a block comment nor inside a
 * string literal: does it open a string, open a block comment, start a line
 * comment (ending the line), or just get appended verbatim?
 */
function classifyPlainChar(ch: string, next: string | undefined): PlainCharAction {
	if (ch === "'" || ch === "\"" || ch === "`") return { kind: "quoteStart", quote: ch };
	if (ch === "/" && next === "*") return { kind: "blockStart" };
	if (ch === "/" && next === "/") return { kind: "lineCommentBreak" };
	if (ch === "#") return { kind: "lineCommentBreak" };
	return { kind: "append" };
}

/**
 * Strip comments from a single line, given whether the line starts already
 * inside a multi-line block comment. String-literal state (`quote`) never
 * carries across lines — only `inBlock` does.
 */
function stripLineComments(line: string, inBlock: boolean): { stripped: string; inBlock: boolean } {
	let stripped = "";
	let quote: QuoteChar | null = null;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const next = line[i + 1];
		if (inBlock) {
			const closer = consumeBlockCommentChar(ch, next);
			inBlock = !closer.closed;
			i += closer.extraAdvance;
			continue;
		}
		if (quote) {
			stripped += ch;
			({ quote, escaped } = consumeQuotedChar(nonNull(ch), quote, escaped));
			continue;
		}
		const action = classifyPlainChar(nonNull(ch), next);
		if (action.kind === "quoteStart") {
			quote = action.quote;
			stripped += ch;
			continue;
		}
		if (action.kind === "blockStart") {
			inBlock = true;
			i++;
			continue;
		}
		if (action.kind === "lineCommentBreak") break;
		stripped += ch;
	}
	return { stripped, inBlock };
}

/**
 * Strip `//` line comments, `#` line comments, and block comments while
 * leaving the contents of string literals intact. Distinct from
 * `stripCommentsAndStrings` in `../shared.js`, which also blanks strings.
 */
export function stripCommentsPreservingStrings(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		const result = stripLineComments(line, inBlock);
		out.push(result.stripped);
		inBlock = result.inBlock;
	}
	return out.join("\n");
}

// ===========================================
// noqa suppression range scan (Python checks)
// ===========================================

/**
 * Operand shapes whose `__eq__` is DESIGNED to be overloaded — an ORM column
 * expression, where `col == None` emits `IS NULL` and `is None` cannot be
 * overloaded, so the comparison is the intended idiom (2026-10-21 adversarial
 * review of `ubs_py_none_equality`): `Model.column` (Capitalized root, dotted
 * — SQLAlchemy / SQLModel / peewee declarative models), the same model reached
 * through its module (`models.User.column`, `m.Order.column`: any Capitalized
 * non-final segment), `cls.column` (the model inside a classmethod) and
 * `table.c.column` / `table.columns.column` (SQLAlchemy Core). Instance
 * attributes (`self.cache`, `record.parent`) and bare names are NOT exempt.
 */
export function isOrmColumnOperand(operand: string): boolean {
	const segments = operand.split(".");
	if (segments.length < 2) return false;
	if (nonNull(segments[0]) === "cls") return true;
	return segments
		.slice(0, -1)
		.some((segment, idx) => /^[A-Z]/.test(segment) || (idx > 0 && (segment === "c" || segment === "columns")));
}

/**
 * Scan a 1-based line range of the original (unstripped) content for a
 * Bandit/flake8-style `# noqa[: <code>]` suppression that maps to the given
 * check id. Used by Python-language checks where the suppression often
 * appears on the opening line of a multi-line call but the match anchors on
 * a deeper keyword (`shell=True`, etc.).
 *
 * Both `startLine` and `endLine` are 1-based and inclusive. Returns true if
 * ANY line in that range carries a suppressing noqa for the given check.
 */
export function isNoqaSuppressedInRange(
	originalLines: string[],
	startLine: number,
	endLine: number,
	checkId: string,
): boolean {
	const lo = Math.max(1, Math.min(startLine, endLine));
	const hi = Math.min(originalLines.length, Math.max(startLine, endLine));
	for (let i = lo - 1; i < hi; i++) {
		if (lineHasPythonSuppression(nonNull(originalLines[i]), checkId)) return true;
	}
	return false;
}

// Case-insensitive `# noqa[: CODES]` — flake8 and ruff both match the
// directive with IGNORECASE, so `# NOQA: S602` is the same acknowledgment.
const NOQA_CI_RE = /#\s*noqa(?![\w])(?::\s*([A-Za-z]\d+(?:\s*,\s*[A-Za-z]\d+)*))?/i;
// Bandit's NATIVE directive: `# nosec`, `# nosec B602`, `# nosec: B602, B603`.
// Bandit test ids are `B###`; ruff's flake8-bandit port spells the same test
// `S###`, which is the namespace `lineHasNoqaSuppression` maps.
const NOSEC_RE = /#\s*nosec(?![\w])(?:\s*:?\s*([^\n]*))?/i;

/**
 * Does `line` carry a Python suppression that covers `checkId`? Accepts the
 * flake8/ruff `# noqa` grammar in any case AND Bandit's own `# nosec`
 * grammar (2026-10-21 adversarial review of `ubs_subprocess_shell_true` /
 * `ubs_shelve_open`: a Bandit-clean file is suppressed with `# nosec B602`,
 * not `# noqa: S602`, and both are the author's explicit, reasoned
 * acknowledgment). A bare `# nosec` suppresses everything, as a bare
 * `# noqa` does; `# nosec B602` is translated to `# noqa: S602` and
 * resolved through the one Bandit→check-id map. A `# nosec` whose trailing
 * text names no `B###` id (a prose reason) is treated as bare.
 */
export function lineHasPythonSuppression(line: string, checkId: string): boolean {
	const noqa = NOQA_CI_RE.exec(line);
	if (noqa) {
		const normalized = noqa[1] ? `# noqa: ${noqa[1].toUpperCase()}` : "# noqa";
		if (lineHasNoqaSuppression(normalized, checkId)) return true;
	}
	const nosec = NOSEC_RE.exec(line);
	if (!nosec) return false;
	const codes = (nosec[1] ?? "")
		.split(/[\s,]+/)
		.filter((token) => /^B\d+$/i.test(token))
		.map((token) => `S${token.slice(1)}`);
	if (codes.length === 0) return true;
	return lineHasNoqaSuppression(`# noqa: ${codes.join(", ")}`, checkId);
}

/**
 * Blank Python triple-quoted string literals (`"""…"""` / `'''…'''`), which
 * may span lines. The generic stripper only blanks SINGLE-LINE docstrings,
 * so a multi-line docstring or `textwrap.dedent('''…''')` code sample that
 * mentions `shelve.open(p)` or `subprocess.run(cmd, shell=True)` read as
 * code (2026-10-21 adversarial review). Every character of the literal,
 * delimiters included, becomes a space; newlines are kept so line numbers
 * stay stable. Line comments and ordinary one-line strings are tracked so a
 * `'''` inside them never opens a literal. Run this BEFORE
 * `stripCommentsAndStrings` on Python content.
 */
export function blankPythonTripleQuotedStrings(content: string): string {
	let out = "";
	const state: PyLexState = { triple: null, quote: null, inComment: false };
	for (let i = 0; i < content.length; ) {
		const step = state.triple ? stepInsideTriple(content, i, state) : stepOutsideTriple(content, i, state);
		out += step.emit;
		i += step.advance;
	}
	return out;
}

type TripleDelimiter = '"""' | "'''";
interface PyLexState {
	triple: TripleDelimiter | null;
	/** Open one-line string delimiter; cleared at every newline. */
	quote: string | null;
	/** Inside a `#` line comment; cleared at every newline. */
	inComment: boolean;
}
interface LexStep {
	emit: string;
	advance: number;
}

/** Escape pair `\x` (not `\` + newline) starting at `i`, or null. */
function escapePairAt(content: string, i: number): string | null {
	const next = content[i + 1];
	if (content[i] !== "\\" || next === undefined || next === "\n") return null;
	return `\\${next}`;
}

function tripleOpenerAt(content: string, i: number): TripleDelimiter | null {
	if (content.startsWith('"""', i)) return '"""';
	if (content.startsWith("'''", i)) return "'''";
	return null;
}

/** Inside a triple-quoted literal: blank everything but newlines until its closer. */
function stepInsideTriple(content: string, i: number, state: PyLexState): LexStep {
	const triple = nonNull(state.triple);
	if (content[i] === "\n") return { emit: "\n", advance: 1 };
	if (content.startsWith(triple, i)) {
		state.triple = null;
		return { emit: "   ", advance: 3 };
	}
	if (escapePairAt(content, i) !== null) return { emit: "  ", advance: 2 };
	return { emit: " ", advance: 1 };
}

/** Outside a triple-quoted literal: keep the text, track comment / one-line string state. */
function stepOutsideTriple(content: string, i: number, state: PyLexState): LexStep {
	const ch = nonNull(content[i]);
	if (ch === "\n") {
		state.quote = null;
		state.inComment = false;
		return { emit: "\n", advance: 1 };
	}
	if (state.inComment) return { emit: ch, advance: 1 };
	if (state.quote) {
		const pair = escapePairAt(content, i);
		if (pair !== null) return { emit: pair, advance: 2 };
		if (ch === state.quote) state.quote = null;
		return { emit: ch, advance: 1 };
	}
	if (ch === "#") state.inComment = true;
	const opener = tripleOpenerAt(content, i);
	if (opener !== null) {
		state.triple = opener;
		return { emit: "   ", advance: 3 };
	}
	if (ch === '"' || ch === "'") state.quote = ch;
	return { emit: ch, advance: 1 };
}
