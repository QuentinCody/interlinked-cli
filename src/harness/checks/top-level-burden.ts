// Top-level burden: how much WORK runs when a module is imported.
//
// CLASS: import-time cost and testability. The score metric `file.top_level`
// (src/lib/metrics/analysis-syntax.ts `analyzeSyntax`) counts every executable
// statement outside a function, so a literal table or a schema declaration weighs as
// much as a script. A census of the first version of this check (52 rows, two blind
// passes, 2026-11-17) found 2 of 20 findings real; the rest were data tables, schema
// declarations and files that are mostly function declarations. This check is
// therefore STRICTER IN SCOPE than the metric: it counts work, not data. The metric is
// unchanged (it is a score contract); the two numbers differ on purpose.
//
// RULE. For each top-level statement of a TS/JS module, count its written tokens
// (outside function bodies, types and doc comments: `writtenTokens`) when it is WORK:
//   - a loop, `if`, `switch`, `try`, `throw`, labeled statement or block;
//   - an expression statement that is a call, an `await`, an update, or an assignment
//     whose right side is not declarative;
//   - a `const`/`let`/`var` declaration whose initializer is not declarative;
//   - `export default <expression>` whose expression is not declarative;
//   - the static blocks of a class.
// A statement is NOT counted when it is
//   (a) a literal data initializer: an object, array, string, number or template
//       whose parts are literals, identifiers and property chains;
//   (b) a pure declaration: a function, class (except static blocks), interface, type
//       alias, enum, namespace, import, or export-from;
//   (c) a declarative builder chain: a call or `new` whose callee is an identifier or
//       property chain and whose arguments are all declarative (literals, identifiers,
//       object/array literals of those, function and arrow bodies which are deferred,
//       nested builder calls). Examples: zod schemas, createAction / createReducer
//       tables, defineConfig({...}), cva(...). A callee shaped like an effect
//       (console.*, process.*, fs.*, child_process, http(s), net, document, window,
//       storage, *Sync, fetch, listen, exec*, spawn*) is never declarative.
// A bare call statement (`registry.set("a", 1);`) is always work.
//
// FIRES WHEN: the work tokens reach TOP_LEVEL_BURDEN_LIMIT (500, the score's half-burden knot).
//
// DOES NOT FIRE: on tests, declaration files, generated or vendored paths, and any
// language other than TS/JS.
//
// KNOWN GAPS: a declarative-looking call can still do work (a builder whose callee
// registers globally); a call with an identifier callee is trusted unless effect-shaped.
// Python is measured by the score (python-score-script.ts) but needs a Python parser.

import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import { writtenTokens } from "../../lib/metrics/analysis-syntax.js";
import type { InlineMatch } from "./shared.js";

/** The score's half-burden knot for `file.top_level` (catalog-metrics.ts). */
export const TOP_LEVEL_BURDEN_LIMIT = 500;

const JS_TS_RE = /\.[mc]?[jt]sx?$/;
const OUT_OF_SCOPE_RE = /\.d\.[mc]?ts$|\.(?:test|spec)\.[mc]?[jt]sx?$|\/__tests__\/|(?:^|\/)(?:node_modules|vendor|dist|build|__generated__|generated)\/|\.generated\.|\.min\./;
const EFFECT_ROOT_RE = /^(?:console|process|fs|fsp|fsPromises|child_process|childProcess|http|https|net|document|window|localStorage|sessionStorage)(?:\.|$)/;
const EFFECT_NAME_RE = /(?:Sync|^fetch|^listen|^exec|^spawn)\w*$|\.(?:listen|exec\w*|spawn\w*|fetch)$/;

/** True when the expression only declares values: literals, identifiers, literal containers, deferred functions, builder calls. */
function declarative(node: TS.Node, parsed: ParsedTsSource): boolean {
	const { ts } = parsed;
	const leaf = declarativeLeaf(node, parsed);
	if (leaf !== null) return leaf;
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
		|| ts.isTypeAssertionExpression(node) || ts.isSpreadElement(node)) return declarative(node.expression, parsed);
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) return declarativeCall(node, parsed);
	return declarativeParts(node, parsed);
}

/** Literals, identifiers and deferred functions: true; a node kind this does not decide: null. */
function declarativeLeaf(node: TS.Node, parsed: ParsedTsSource): boolean | null {
	const { ts } = parsed;
	const kind = node.kind;
	if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isIdentifier(node) || ts.isRegularExpressionLiteral(node) || ts.isBigIntLiteral(node)) return true;
	if (kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword || kind === ts.SyntaxKind.NullKeyword || kind === ts.SyntaxKind.ThisKeyword) return true;
	return ts.isFunctionLike(node) || ts.isClassExpression(node) ? true : null;
}

/** Containers and operators: declarative when every part is. */
function declarativeParts(node: TS.Node, parsed: ParsedTsSource): boolean {
	const { ts } = parsed;
	const all = (items: readonly TS.Node[]): boolean => items.every(item => declarative(item, parsed));
	if (ts.isTemplateExpression(node)) return all(node.templateSpans.map(span => span.expression));
	if (ts.isPropertyAccessExpression(node)) return declarative(node.expression, parsed);
	if (ts.isElementAccessExpression(node)) return all([node.expression, node.argumentExpression]);
	if (ts.isArrayLiteralExpression(node)) return all(node.elements);
	if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => ts.isPropertyAssignment(property) ? declarative(property.initializer, parsed)
		: ts.isSpreadAssignment(property) ? declarative(property.expression, parsed) : true);
	if (ts.isPrefixUnaryExpression(node)) return node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken && declarative(node.operand, parsed);
	if (ts.isBinaryExpression(node)) return (node.operatorToken.kind < ts.SyntaxKind.FirstAssignment || node.operatorToken.kind > ts.SyntaxKind.LastAssignment) && all([node.left, node.right]);
	if (ts.isConditionalExpression(node)) return all([node.condition, node.whenTrue, node.whenFalse]);
	return ts.isTaggedTemplateExpression(node) && all([node.tag, node.template]);
}

function declarativeCall(node: TS.CallExpression | TS.NewExpression, parsed: ParsedTsSource): boolean {
	const callee = node.expression.getText(parsed.sf).replace(/\s+/g, "");
	if (EFFECT_ROOT_RE.test(callee) || EFFECT_NAME_RE.test(callee)) return false;
	return declarative(node.expression, parsed) && (node.arguments ?? []).every(argument => declarative(argument, parsed));
}

function staticBlockTokens(node: TS.ClassDeclaration, parsed: ParsedTsSource): number {
	const { ts } = parsed;
	return node.members.filter(member => ts.isClassStaticBlockDeclaration(member)).reduce((sum, member) => sum + writtenTokens(member, parsed) + 1, 0);
}

function expressionWork(statement: TS.ExpressionStatement, parsed: ParsedTsSource): number {
	const { ts } = parsed;
	const expression = statement.expression;
	if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
		return declarative(expression.right, parsed) ? 0 : writtenTokens(statement, parsed);
	}
	if (ts.isCallExpression(expression) || ts.isAwaitExpression(expression)) return writtenTokens(statement, parsed);
	return declarative(expression, parsed) ? 0 : writtenTokens(statement, parsed);
}

function statementWork(statement: TS.Statement, parsed: ParsedTsSource): number {
	const { ts } = parsed;
	if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
		|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isEmptyStatement(statement)) return 0;
	if (ts.isClassDeclaration(statement)) return staticBlockTokens(statement, parsed);
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.reduce((sum, declaration) => sum + (declaration.initializer && !declarative(declaration.initializer, parsed) ? writtenTokens(declaration, parsed) : 0), 0);
	}
	if (ts.isExportAssignment(statement)) return declarative(statement.expression, parsed) ? 0 : writtenTokens(statement, parsed);
	if (ts.isExpressionStatement(statement)) return expressionWork(statement, parsed);
	return writtenTokens(statement, parsed);
}

/** Written tokens of import-time work in a TS/JS source; null when the file is out of scope or does not parse. */
export function topLevelWorkTokens(content: string, filePath: string): number | null {
	const path = filePath.replace(/\\/g, "/");
	if (!JS_TS_RE.test(path) || OUT_OF_SCOPE_RE.test(path)) return null;
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) return null;
	return parsed.sf.statements.reduce((sum, statement) => sum + statementWork(statement, parsed), 0);
}

/** Flag a TS/JS file whose import-time work reaches the limit. */
export function findTopLevelBurden(content: string, filePath: string): InlineMatch[] {
	const tokens = topLevelWorkTokens(content, filePath);
	if (tokens === null || tokens < TOP_LEVEL_BURDEN_LIMIT) return [];
	return [{ line: 1, text: `${tokens} tokens of import-time work (limit ${TOP_LEVEL_BURDEN_LIMIT})` }];
}
