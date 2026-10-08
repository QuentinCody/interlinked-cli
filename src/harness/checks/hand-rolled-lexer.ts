// ===========================================================================
// hand_rolled_lexer — a JS/TS function that lexes source text by hand
// ===========================================================================
// CLASS: a function that walks a string one character at a time and tracks
// lexical state (quote kind, line/block comment) to decide what each character
// means, in a repository where the TypeScript parser is available. Twenty
// review rounds (2026-09 → 10-02) found that every such scanner misreads some
// construct: a `#private` field read as a comment, `"/*"` inside a string
// opening a block comment, a regex literal read as a division. The parser
// already knows; the repo carries parser-backed helpers:
//   - `stripWithTypeScript`        (shared-text-utils-ast.ts)
//   - `maskCommentsAndStrings`     (test-hygiene-masking*.ts)
//   - `parseTsSource`              (cyclomatic-ast.ts)
//
// FIRES WHEN (all inside ONE function's own body, nested functions excluded):
//   - a loop (for / for-of / while / do) AND character access (an index
//     expression, `charAt` / `charCodeAt` / `codePointAt`, or a for-of), AND
//   - lexical-state evidence, either
//       (a) the template backtick plus at least one of `"` `'` appear in short
//           string/regex literals AND a comment opener is tested (a `"//"` /
//           `"/*"` / `"*/"` literal, or `"/"` twice, or `"/"` with `"*"`), or
//       (b) a declared state variable that only a JS lexer needs: inComment /
//           inBlockComment / inLineComment / inTemplate / inRegex /
//           inBacktick, or a quote-only name (inString / inStr / inQuote)
//           corroborated by a comment opener or the backtick.
//
// DOES NOT FIRE: test files; non-JS/TS files; a function that calls a parser
// helper (it is the parser route, with at most a fallback inside); a function
// carrying a `lexer-fallback: <reason>` marker in its body or in the comment
// directly above it (how a deliberate fallback behind a parser route is
// pinned); an install without `typescript` (returns [] — never guesses).
//
// CALIBRATION: measured against the interlinked-cli tree with
// scratch/2026-10-02-h8/census.ts. The first rule (any two quote characters, any
// state variable named in*/is*) fired on a Rust stripper, a shell splitter, a
// YAML inline-list splitter, and every `isComment` predicate: none of those
// lexes JS. Requiring the backtick (a Rust, shell or YAML lexer has no
// template literal), dropping the `is*` and shell `inSingle`/`inDouble` names,
// and requiring corroboration for quote-only names removed them.
//
// KNOWN GAPS: a scanner split into step functions puts the loop in the driver
// and the quote/comment tests in helpers, so no single function shows both
// (stripStringsAcrossLines + stepCode is such a pair); a quote-only skipper
// with no backtick or comment test (a bracket-depth splitter) is not seen; a
// lexer for another language that tracks inBlockComment fires through (b) —
// pin it with `lexer-fallback: <reason>`.
//
// HOW TO EXTEND: add a name to a *_STATE_RE or PARSER_CALLS, and a labelled
// case to hand-rolled-lexer.test.ts in the matching direction.
//
// Check id: hand_rolled_lexer. Phase: post. Advisory, heuristic.

import type * as TS from "typescript";
import { functionName, isFunctionLike, parseTsSource, type TsModule } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";

const MAX_MATCHES = 10;
const MAX_NAME = 40;
const QUOTE_CHARS = "\"'`";
/** A literal this short is a quote/delimiter set, not prose. */
const SHORT_LITERAL_MAX = 6;
const FALLBACK_MARKER_RE = /lexer-fallback:[ \t]*\S/;
/** Cheap gate: the parse only runs when comment-opener or state-name evidence is present. */
const PREFILTER_RE =
	/["'`](?:\/\/|\/\*|\*\/|\/|\*)["'`]|\bin(?:Str|Quote|Comment|BlockComment|LineComment|Template|Regex|Backtick)/;
/** State only a JS lexer needs: comment, template and regex tracking. */
const STRONG_STATE_RE =
	/^in(?:(?:Block|Line|Multi)?Comment|Template(?:String|Literal)?|Regexp?|Backtick)$/i;
/** Quote-only state: a shell, YAML or SQL splitter has it too, so it needs corroboration. */
const WEAK_STATE_RE = /^in(?:Str(?:ing)?|Quote[sd]?)$/i;
const PARSER_CALLS = new Set([
	"parseTsSource",
	"parseTsSourceWith",
	"stripWithTypeScript",
	"maskCommentsAndStrings",
	"maskWithTypeScript",
	"createSourceFile",
	"createScanner",
]);
const CHAR_ACCESS_METHODS = new Set(["charAt", "charCodeAt", "codePointAt"]);

/** What one function's own body shows about hand lexing. */
interface LexFacts {
	loop: boolean;
	charAccess: boolean;
	quotes: Set<string>;
	commentOpener: boolean;
	slashCount: number;
	star: boolean;
	strongState: boolean;
	weakState: boolean;
	parserCall: boolean;
}

function newFacts(): LexFacts {
	return {
		loop: false,
		charAccess: false,
		quotes: new Set(),
		commentOpener: false,
		slashCount: 0,
		star: false,
		strongState: false,
		weakState: false,
		parserCall: false,
	};
}

function recordLiteral(facts: LexFacts, text: string): void {
	if (text === "//" || text === "/*" || text === "*/") facts.commentOpener = true;
	if (text === "/") facts.slashCount++;
	if (text === "*") facts.star = true;
	if (text.length > SHORT_LITERAL_MAX) return;
	for (const ch of text) if (QUOTE_CHARS.includes(ch)) facts.quotes.add(ch);
}

function calleeName(ts: TsModule, callee: TS.Expression): string | null {
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	return null;
}

function recordCall(ts: TsModule, facts: LexFacts, call: TS.CallExpression): void {
	const name = calleeName(ts, call.expression);
	if (name === null) return;
	if (PARSER_CALLS.has(name)) facts.parserCall = true;
	if (CHAR_ACCESS_METHODS.has(name)) facts.charAccess = true;
}

function isLoop(ts: TsModule, node: TS.Node): boolean {
	return (
		ts.isForStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node) ||
		ts.isForOfStatement(node)
	);
}

/** Fold one node (not a nested function) into the facts. */
function recordNode(ts: TsModule, facts: LexFacts, node: TS.Node): void {
	if (isLoop(ts, node)) {
		facts.loop = true;
		if (ts.isForOfStatement(node)) facts.charAccess = true;
		return;
	}
	if (ts.isElementAccessExpression(node)) facts.charAccess = true;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		recordLiteral(facts, node.text);
	}
	if (ts.isRegularExpressionLiteral(node)) {
		recordLiteral(facts, node.text.slice(1, node.text.lastIndexOf("/")));
	}
	if (ts.isCallExpression(node)) recordCall(ts, facts, node);
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		if (STRONG_STATE_RE.test(node.name.text)) facts.strongState = true;
		if (WEAK_STATE_RE.test(node.name.text)) facts.weakState = true;
	}
}

/** Collect facts from `fn`'s own body; a nested function is its own unit. */
function collectFacts(ts: TsModule, fn: TS.Node): LexFacts {
	const facts = newFacts();
	const visit = (node: TS.Node): void => {
		if (isFunctionLike(ts, node)) return;
		recordNode(ts, facts, node);
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(fn, visit);
	return facts;
}

function hasCommentOpener(facts: LexFacts): boolean {
	return facts.commentOpener || facts.slashCount >= 2 || (facts.slashCount >= 1 && facts.star);
}

/** The lexical-state rule: see FIRES WHEN in the header. */
function looksLikeHandLexer(facts: LexFacts): boolean {
	if (facts.parserCall || !facts.loop || !facts.charAccess) return false;
	if (facts.strongState) return true;
	const templates = facts.quotes.has("`");
	if (facts.weakState && (templates || hasCommentOpener(facts))) return true;
	return templates && facts.quotes.size >= 2 && hasCommentOpener(facts);
}

/** The node whose leading comments belong to `fn`: its statement or member when it is a bound arrow. */
function commentOwner(ts: TsModule, fn: TS.Node): TS.Node {
	let owner: TS.Node = fn;
	while (
		owner.parent &&
		(ts.isVariableDeclaration(owner.parent) ||
			ts.isVariableDeclarationList(owner.parent) ||
			ts.isVariableStatement(owner.parent) ||
			ts.isPropertyAssignment(owner.parent) ||
			ts.isPropertyDeclaration(owner.parent))
	) {
		owner = owner.parent;
	}
	return owner;
}

/** True when a `lexer-fallback: <reason>` marker sits in the function or the comment above it. */
function hasFallbackMarker(ts: TsModule, sf: TS.SourceFile, fn: TS.Node): boolean {
	const owner = commentOwner(ts, fn);
	return FALLBACK_MARKER_RE.test(sf.text.slice(owner.getFullStart(), fn.end));
}

const MESSAGE_TAIL =
	"() lexes JS by hand — use stripWithTypeScript, maskCommentsAndStrings or parseTsSource; deliberate fallback: `lexer-fallback: <why>`";

function describeHit(ts: TsModule, sf: TS.SourceFile, fn: TS.Node): InlineMatch {
	const line = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
	// The tail carries the fix, so it is never shortened; only an unusually long name is.
	const name = functionName(ts, fn, sf).slice(0, MAX_NAME);
	return { line, text: `${name}${MESSAGE_TAIL}` };
}

/**
 * Detect functions that lex JS/TS by hand. Returns `[]` for non-JS/TS files,
 * test files, and installs without the optional `typescript` dependency.
 *
 * check id: `hand_rolled_lexer`
 */
export function detectHandRolledLexer(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath)) || isStrictTestFile(filePath)) return [];
	if (!PREFILTER_RE.test(content)) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return [];
	const { ts, sf } = parsed;
	const out: InlineMatch[] = [];
	const visit = (node: TS.Node): void => {
		if (out.length >= MAX_MATCHES) return;
		if (isFunctionLike(ts, node) && node.body !== undefined) {
			if (looksLikeHandLexer(collectFacts(ts, node)) && !hasFallbackMarker(ts, sf, node)) {
				out.push(describeHit(ts, sf, node));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}
