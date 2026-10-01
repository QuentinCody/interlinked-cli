// ===========================================
// Missing effect cleanup — the parsed route
// ===========================================
// Seventeen review rounds (2026-09-30 → 10-01) each found one more valid
// cleanup-return shape the line scanner in `missing-effect-cleanup.ts`
// misread: ASI, `else`, switch labels, object members named `return`, typed
// and generic arrows, parenthesized arrows, function-type constraints. The
// TypeScript parser already used by the cyclomatic gate knows where an effect
// callback's body ends and what a return statement's expression is, so when
// `typescript` is resolvable the check decides from the AST; the scanner stays
// the fallback for an install without the optional dependency.

import type * as TS from "typescript";
import { parseTsSource, type TsModule } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";

const SUBSCRIPTION_CALLEES = new Set(["addEventListener", "setInterval", "setTimeout", "subscribe"]);
const MESSAGE = "[useEffect with subscription but no cleanup — potential memory leak]";

function calleeName(ts: TsModule, callee: TS.Expression): string | null {
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	return null;
}

function isUseEffectCall(ts: TsModule, node: TS.Node): node is TS.CallExpression {
	return ts.isCallExpression(node) && calleeName(ts, node.expression) === "useEffect";
}

/** `addEventListener(…)`, `setInterval(…)`, `setTimeout(…)`, `subscribe(…)` anywhere in the body, or a `.on(…)` member call. */
function hasSubscription(ts: TsModule, body: TS.Node): boolean {
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (ts.isCallExpression(node)) {
			const name = calleeName(ts, node.expression);
			if (name !== null && (SUBSCRIPTION_CALLEES.has(name) || (name === "on" && ts.isPropertyAccessExpression(node.expression)))) {
				found = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

/** The expression under its parens and type-only wrappers (`as`, `satisfies`, `!`). */
function unwrapped(ts: TsModule, expression: TS.Expression): TS.Expression {
	let value = expression;
	while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
	return value;
}

/** JSX, a string / template / number literal, an object or array literal: a render or a plain value, never a disposer. */
function isRenderOrLiteral(ts: TsModule, value: TS.Expression): boolean {
	if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)) return true;
	if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value) || ts.isNumericLiteral(value)) return true;
	return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value);
}

/** `null`, `undefined`, `true`, `false`, or a `void …` expression (always `undefined`): nothing to dispose. */
function isNothingValue(ts: TsModule, value: TS.Expression): boolean {
	if (value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return true;
	if (ts.isVoidExpression(value)) return true;
	return ts.isIdentifier(value) && value.text === "undefined";
}

/**
 * Setup calls whose RESULT is not a disposer: `addEventListener` returns undefined, `setInterval` / `setTimeout`
 * return a timer id. Returning one directly (`useEffect(() => window.setInterval(tick, 1000), [])`) disposes
 * nothing. `subscribe` is NOT here: its result is the disposer by convention (Redux, RxJS, stores).
 */
const NON_DISPOSER_SETUP_CALLS = new Set(["addEventListener", "setInterval", "setTimeout"]);

function isNonDisposerSetupCall(ts: TsModule, value: TS.Expression): boolean {
	if (!ts.isCallExpression(value)) return false;
	const name = calleeName(ts, value.expression);
	return name !== null && NON_DISPOSER_SETUP_CALLS.has(name);
}

/** The returned VALUE after parens and type wrappers is a cleanup unless it is a render, a literal, nothing, or a setup call's non-disposer result. */
function isCleanupValue(ts: TsModule, expression: TS.Expression): boolean {
	const value = unwrapped(ts, expression);
	return !isRenderOrLiteral(ts, value) && !isNothingValue(ts, value) && !isNonDisposerSetupCall(ts, value);
}

/** A return statement of the callback ITSELF (never one inside a nested function) whose value is a cleanup. */
function returnsCleanup(ts: TsModule, callback: TS.ArrowFunction | TS.FunctionExpression): boolean {
	if (!ts.isBlock(callback.body)) return isCleanupValue(ts, callback.body);
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found || ts.isFunctionLike(node)) return;
		if (ts.isReturnStatement(node)) {
			if (node.expression && isCleanupValue(ts, node.expression)) found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(callback.body);
	return found;
}

function leaks(ts: TsModule, call: TS.CallExpression): boolean {
	const argument = call.arguments[0];
	// The callback under its parens and type-only wrappers: `useEffect((() => {…}), [])`, `(… as EffectCallback)`.
	const callback = argument === undefined ? undefined : unwrapped(ts, argument);
	if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
	return hasSubscription(ts, callback.body) && !returnsCleanup(ts, callback);
}

/**
 * Every `useEffect(callback, …)` whose callback body subscribes and returns no cleanup, reported at the call's
 * line with that line's text. Returns null when `typescript` is absent (the caller falls back to the scanner).
 */
export function effectCleanupFindingsAst(content: string, filePath: string): InlineMatch[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const { ts, sf } = parsed;
	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const visit = (node: TS.Node): void => {
		if (isUseEffectCall(ts, node) && leaks(ts, node)) {
			const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
			matches.push({ line: line + 1, text: `${MESSAGE} ${(lines[line] ?? "").trim().slice(0, 100)}` });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return matches;
}
