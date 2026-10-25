// ===========================================
// Exemption-marker branch budget — when a generated-file header may exempt a file
// ===========================================
// Two header families take a file out of the hand-written-code domain
// (`large-file-policy.ts::isHandwrittenCodeFile`, and through it every
// per-function cap, the line cap, the census and coverage targeting; and
// `tested-file-policy.ts::isTestableSourceFile`, the every-file-tested gate):
//   - `@codegen-data` (this repository's codegen-DATA carriers), and
//   - every generator header `checks/shared.ts::isGeneratedFile` honours
//     (`@generated`, "Code generated … DO NOT EDIT.", "auto-generated", …).
//
// THE HEADER ALONE EXEMPTS NOTHING (red-team 2026-10-21, "exemption-marker
// laundering"). The gated agent writes the file, so a header added in the same
// Write/Edit reached the caps gates through the projected after-content and
// switched them off for a hand-written CC-72 function. A header is honoured
// only when the content IS data: its EXECUTABLE code carries at most
// `CODEGEN_DATA_BRANCH_BUDGET` branch tokens.
//
// JS/TS: THE COUNT COMES FROM THE PARSER, never from a lexer of our own (round
// 3). Two rounds of a hand-written lexer each lost to the language grammar:
// CR-only and U+2028 line endings, `o.in / 2`, a regex after `)` or `}`, and
// JSX text each hid the whole body from the count while the cyclomatic
// analyzer still saw 34 `if` arms. The budget now walks the SAME TypeScript
// AST the cyclomatic gate walks (`checks/cyclomatic-ast.ts::parseTsSource`,
// shared memo) and counts its decision points (`isDecisionPoint`), plus
// `switch`, logical assignments and labeled jumps (cognitive increments). The
// budget and the analyzer cannot disagree about what is code.
//
// Fail closed: when `typescript` is not resolvable, when the file does not
// parse (any syntax diagnostic) or when the walk throws, the branch count is
// NOT MEASURED and the header is DENIED (the file is judged as code), with a
// warning that names the cause. Python keeps its small lexer (comments,
// strings), ends a line at `\n`, `\r\n` or `\r`, and still counts a file with
// an interpolating string (f/t prefix) raw. A language without a lexer here is
// counted raw. Over-counting only denies the header.

import type * as TS from "typescript";
import {
	hasParseErrors,
	isDecisionPoint,
	type ParsedTsSource,
	parseTsSource,
	type TsModule,
} from "./checks/cyclomatic-ast.js";
import { isGeneratedFile } from "./checks/shared.js";

export const CODEGEN_DATA_MARKER = "@codegen-data";

/**
 * Branch tokens an exempt (data) file may still carry in executable code — a
 * default like `modePreset ?? QUALITY_MODE` in the one function that emits the
 * artifact (hooks-template.ts). With at most 2, no function in an honoured
 * file can exceed cyclomatic 3 or cognitive 4 under any sane cap (shipped
 * 25 / 30, this repo 16 / 15). Measured 2026-10-21 over every carrier here.
 */
export const CODEGEN_DATA_BRANCH_BUDGET = 2;

/** Raw fallback (unlexed languages, and the diagnostic count of an unmeasured
 *  JS/TS file): keywords, `&&` / `||` / `??` and a ternary `?`. */
const BRANCH_TOKEN_RE =
	/\b(?:if|elif|for|while|do|switch|case|catch|except)\b|&&|\|\||\?\?|\?(?![.:?])/g;

/** Python adds the constructs radon counts: boolean operators, `with`,
 *  `assert`, `lambda`, `match`. */
const PY_BRANCH_TOKEN_RE =
	/\b(?:if|elif|for|while|except|and|or|with|assert|lambda|match|case)\b/g;

/** Every line terminator JS recognises (Python's are a subset). Header scans
 *  and reported line numbers split on all of them. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LINE_TERMINATOR_RE = new RegExp(`\\r\\n|[\\n\\r${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);
const LINE_TERMINATOR_CHARS = new Set(["\n", "\r", LINE_SEPARATOR, PARAGRAPH_SEPARATOR]);

const JS_FAMILY_RE = /\.[cm]?[jt]sx?$/i;
const PYTHON_RE = /\.pyi?$/i;

/** The path a content-only call parses under (the API predates the path). */
const DEFAULT_JS_PATH = "codegen-data.ts";

type Language = "js" | "python" | "raw";

/** No path ⇒ JS (the content-only API predates the path argument). */
function languageOf(filePath: string | undefined): Language {
	if (filePath === undefined || JS_FAMILY_RE.test(filePath)) return "js";
	return PYTHON_RE.test(filePath) ? "python" : "raw";
}

function lineOf(src: string, offset: number): number {
	return src.slice(0, offset).split(LINE_TERMINATOR_RE).length;
}

/** Offset-preserving: a character not marked `keep` becomes a space; line
 *  terminators always stay. */
function renderKept(src: string, keep: Uint8Array): string {
	const out = src.split("");
	for (let i = 0; i < out.length; i++) {
		const ch = out[i] ?? "";
		if (keep[i] !== 1 && !LINE_TERMINATOR_CHARS.has(ch)) out[i] = " ";
	}
	return out.join("");
}

// ---------- JS / TS: the TypeScript parser ----------

type Parser = (content: string, filePath: string) => ParsedTsSource | null;

let parser: Parser = parseTsSource;

/** Bounded once-per-cause latch so a repeated unmeasurable file warns once. */
const NOT_MEASURED_WARN_MAX = 32;
const notMeasuredWarned = new Set<string>();

/** Test-only: replace the parser (a `null` result means `typescript` is
 *  unavailable); no argument restores the real one. Resets the warn latch. */
export function __setTsParserForTesting(fake?: Parser): void {
	parser = fake ?? parseTsSource;
	notMeasuredWarned.clear();
}

type JsParse = { ok: true; ts: TsModule; sf: TS.SourceFile } | { ok: false; reason: string };

function parseJs(content: string, filePath: string | undefined): JsParse {
	const path = filePath ?? DEFAULT_JS_PATH;
	let parsed: ParsedTsSource | null;
	try {
		parsed = parser(content, path);
	} catch (err) {
		return { ok: false, reason: `the TypeScript parser threw (${String(err)})` };
	}
	if (parsed === null) return { ok: false, reason: "`typescript` is not resolvable" };
	if (hasParseErrors(parsed.sf)) return { ok: false, reason: "the file does not parse (syntax diagnostics)" };
	return { ok: true, ts: parsed.ts, sf: parsed.sf };
}

interface BranchToken {
	pos: number;
	token: string;
}

const KEYWORD_RE = /[a-z]+/y;

function keywordAt(sf: TS.SourceFile, pos: number): string {
	KEYWORD_RE.lastIndex = pos;
	return KEYWORD_RE.exec(sf.text)?.[0] ?? "?";
}

function isLogicalAssignment(ts: TsModule, op: TS.SyntaxKind): boolean {
	return (
		op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
		op === ts.SyntaxKind.BarBarEqualsToken ||
		op === ts.SyntaxKind.QuestionQuestionEqualsToken
	);
}

/** Statements the budget counts beyond the cyclomatic decision set: the
 *  cognitive increments `switch` and a labeled `break` / `continue`. */
function isExtraBranchStatement(ts: TsModule, node: TS.Node): boolean {
	if (ts.isSwitchStatement(node)) return true;
	return (ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label !== undefined;
}

/** The branch token `node` contributes, located at its operator or keyword. */
function branchTokenOf(ts: TsModule, node: TS.Node, sf: TS.SourceFile): BranchToken | null {
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken;
		if (!isDecisionPoint(ts, node) && !isLogicalAssignment(ts, op.kind)) return null;
		return { pos: op.getStart(sf), token: ts.tokenToString(op.kind) ?? op.getText(sf) };
	}
	if (ts.isConditionalExpression(node)) return { pos: node.questionToken.getStart(sf), token: "?" };
	if (!isDecisionPoint(ts, node) && !isExtraBranchStatement(ts, node)) return null;
	const pos = node.getStart(sf);
	return { pos, token: keywordAt(sf, pos) };
}

interface BranchCount {
	count: number;
	first: { line: number; token: string } | null;
}

function countAstBranches(ts: TsModule, sf: TS.SourceFile): BranchCount {
	// Boxed: the walk mutates it from a `forEachChild` callback, which TS's
	// control-flow narrowing cannot see across.
	const state: { count: number; earliest: BranchToken | null } = { count: 0, earliest: null };
	const visit = (node: TS.Node): void => {
		const found = branchTokenOf(ts, node, sf);
		if (found !== null) {
			state.count++;
			if (state.earliest === null || found.pos < state.earliest.pos) state.earliest = found;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const first = state.earliest;
	return {
		count: state.count,
		first: first === null ? null : { line: lineOf(sf.text, first.pos), token: first.token },
	};
}

/** Token kinds whose text is data, not code. */
function isDataToken(ts: TsModule, kind: TS.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.StringLiteral ||
		kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
		kind === ts.SyntaxKind.TemplateHead ||
		kind === ts.SyntaxKind.TemplateMiddle ||
		kind === ts.SyntaxKind.TemplateTail ||
		kind === ts.SyntaxKind.RegularExpressionLiteral ||
		kind === ts.SyntaxKind.JsxText ||
		kind === ts.SyntaxKind.JsxTextAllWhiteSpaces
	);
}

function isJsDocKind(ts: TsModule, kind: TS.SyntaxKind): boolean {
	return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

/** Mark every CODE token's text as kept; trivia (comments, whitespace) and
 *  data tokens stay blank. */
function markCodeTokens(ts: TsModule, sf: TS.SourceFile, node: TS.Node, keep: Uint8Array): void {
	if (isJsDocKind(ts, node.kind)) return;
	const children = node.getChildren(sf);
	if (children.length > 0) {
		for (const child of children) markCodeTokens(ts, sf, child, keep);
		return;
	}
	if (!isDataToken(ts, node.kind)) keep.fill(1, node.getStart(sf), node.getEnd());
}

/** The parser's view; content it cannot measure stays fully visible. */
function jsView(content: string, filePath: string | undefined): string {
	const parsed = parseJs(content, filePath);
	if (!parsed.ok) return content;
	try {
		const keep = new Uint8Array(content.length);
		markCodeTokens(parsed.ts, parsed.sf, parsed.sf, keep);
		return renderKept(content, keep);
	} catch {
		return content;
	}
}

// ---------- Python lexer ----------

/** An f-string / t-string prefix right before a quote. Its replacement fields
 *  are executable and PEP 701 lets them nest any quote, so such a file is
 *  counted raw rather than lexed. Over-detection only denies. */
const PY_INTERPOLATING_STRING_RE = /(?<![\w])(?:[rRbBuU]?[fFtT]|[fFtT][rRbBuU])["']/;

/** Python ends a physical line at `\n`, `\r\n` or a lone `\r`. */
function isPythonLineEnd(c: string): boolean {
	return c === "\n" || c === "\r";
}

function pythonLineEnd(src: string, from: number): number {
	for (let j = from; j < src.length; j++) {
		if (isPythonLineEnd(src.charAt(j))) return j;
	}
	return src.length;
}

function findPythonStringEnd(src: string, from: number, closer: string): number | null {
	const triple = closer.length === 3;
	for (let j = from; j < src.length; j++) {
		const c = src.charAt(j);
		if (c === "\\") {
			j++;
			continue;
		}
		if (!triple && isPythonLineEnd(c)) return null;
		if (src.startsWith(closer, j)) return j;
	}
	return null;
}

/** Keeps code: everything except comments and string interiors. */
function stepPython(src: string, i: number, keep: Uint8Array): number {
	const ch = src.charAt(i);
	if (ch === "#") return pythonLineEnd(src, i);
	if (ch !== '"' && ch !== "'") {
		keep[i] = 1;
		return i + 1;
	}
	const closer = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
	const start = i + closer.length;
	const end = findPythonStringEnd(src, start, closer);
	if (end === null) {
		keep.fill(1, i, start); // unterminated: the rest is lexed as code
		return start;
	}
	return end + closer.length;
}

function pythonView(src: string): string {
	if (PY_INTERPOLATING_STRING_RE.test(src)) return src;
	const keep = new Uint8Array(src.length);
	let i = 0;
	while (i < src.length) i = stepPython(src, i, keep);
	return renderKept(src, keep);
}

// ---------- measurement ----------

type Measurement =
	| { measured: true; branches: BranchCount }
	| { measured: false; reason: string; rawCount: number };

function countRegex(code: string, re: RegExp): BranchCount {
	let count = 0;
	let first: BranchCount["first"] = null;
	for (const m of code.matchAll(re)) {
		count++;
		first ??= { line: lineOf(code, m.index), token: m[0] };
	}
	return { count, first };
}

function measureJs(content: string, filePath: string | undefined): Measurement {
	const parsed = parseJs(content, filePath);
	const rawCount = (): number => countRegex(content, BRANCH_TOKEN_RE).count;
	if (!parsed.ok) return { measured: false, reason: parsed.reason, rawCount: rawCount() };
	try {
		return { measured: true, branches: countAstBranches(parsed.ts, parsed.sf) };
	} catch (err) {
		return { measured: false, reason: `the AST walk failed (${String(err)})`, rawCount: rawCount() };
	}
}

function measure(content: string, filePath: string | undefined): Measurement {
	const language = languageOf(filePath);
	if (language === "js") return measureJs(content, filePath);
	if (language === "python") return { measured: true, branches: countRegex(pythonView(content), PY_BRANCH_TOKEN_RE) };
	return { measured: true, branches: countRegex(content, BRANCH_TOKEN_RE) };
}

// ---------- not-measured warning ----------

export const CODEGEN_MARKER_NOT_MEASURED = "[interlinked:codegen-marker] NOT MEASURED";

function notMeasuredText(marker: string, filePath: string | undefined, reason: string): string {
	return (
		`${marker} refused: ${CODEGEN_MARKER_NOT_MEASURED} for ${filePath ?? "(content)"}: ${reason}, so ` +
		"the branch budget could not be counted from the parser. The header is DENIED (fail closed) and " +
		"the file is judged by the per-function caps like any other file."
	);
}

/** One stderr line per distinct (cause, file), bounded per process. */
function warnNotMeasured(text: string, key: string): void {
	if (notMeasuredWarned.has(key) || notMeasuredWarned.size >= NOT_MEASURED_WARN_MAX) return;
	notMeasuredWarned.add(key);
	process.stderr.write(`${text}\n`);
}

// ---------- public surface ----------

/**
 * Offset-preserving view of `content` with only EXECUTABLE code left:
 * comments, string / regex literals, template TEXT and JSX text blanked to
 * spaces, `${...}` and JSX `{...}` expression code kept. JS/TS comes from the
 * TypeScript parser, and content it cannot measure is returned raw. No path ⇒
 * JS/TS; a language without a lexer ⇒ the raw content.
 */
export function executableCodeView(content: string, filePath?: string): string {
	const language = languageOf(filePath);
	if (language === "js") return jsView(content, filePath);
	if (language === "python") return pythonView(content);
	return content;
}

/** Branch tokens in the executable code of `content`. A JS/TS file the parser
 *  cannot measure reports its RAW token count (its header is denied anyway). */
export function branchTokenCount(content: string, filePath?: string): number {
	const m = measure(content, filePath);
	return m.measured ? m.branches.count : m.rawCount;
}

/** The denial text for `marker` when `content` exceeds the data budget or
 *  cannot be measured. */
function budgetDenial(content: string, filePath: string | undefined, marker: string): string | null {
	const m = measure(content, filePath);
	if (!m.measured) {
		const text = notMeasuredText(marker, filePath, m.reason);
		warnNotMeasured(text, `${m.reason}|${filePath ?? ""}`);
		return text;
	}
	const { count, first } = m.branches;
	if (count <= CODEGEN_DATA_BRANCH_BUDGET || first === null) return null;
	return (
		`${marker} refused: ${count} branch token(s) in executable code ` +
		`(first \`${first.token}\` at line ${first.line}) exceed the data-module budget of ` +
		`${CODEGEN_DATA_BRANCH_BUDGET}. A generated or codegen-DATA module carries no control flow; ` +
		"code with branches is judged by the per-function caps like any other file."
	);
}

/** Bounded header scan: the first 20 lines, split on EVERY line terminator, so
 *  a CR-only or U+2028 file has a header and not one 20-line-long line. */
export function hasCodegenDataMarker(content: string): boolean {
	return content.split(LINE_TERMINATOR_RE, 20).join("\n").includes(CODEGEN_DATA_MARKER);
}

/** Why a `@codegen-data` header is NOT honoured for `content`; `null` when it
 *  is, or when there is no marker. The reported line is the original line. */
export function codegenDataMarkerDenial(content: string, filePath?: string): string | null {
	if (!hasCodegenDataMarker(content)) return null;
	return budgetDenial(content, filePath, CODEGEN_DATA_MARKER);
}

/** Why a generator header (`isGeneratedFile`) is NOT honoured; `null` when it
 *  is, or when there is no such header. */
export function generatorMarkerDenial(content: string, filePath?: string): string | null {
	if (!isGeneratedFile(content)) return null;
	return budgetDenial(content, filePath, "generated-file header");
}

/** True when `content` carries `@codegen-data` AND is data by shape. */
export function isCodegenDataModule(content: string, filePath?: string): boolean {
	return hasCodegenDataMarker(content) && codegenDataMarkerDenial(content, filePath) === null;
}

/** True when `content` carries a generator header AND is data by shape. */
export function isHonoredGeneratedFile(content: string, filePath?: string): boolean {
	return isGeneratedFile(content) && generatorMarkerDenial(content, filePath) === null;
}
