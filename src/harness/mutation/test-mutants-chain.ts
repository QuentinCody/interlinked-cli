// ===========================================
// Test-side mutants — syntax helpers (expect chains, test calls)
// ===========================================
// Syntax only: no type checker. An "expect chain" is `expect(x)` followed by
// zero or more of .not/.resolves/.rejects and then one matcher call. Only the
// bare identifier `expect` roots a chain, so `obj.expect(x).toBe(1)` and
// `expect.assertions(1)` are not chains.

import type * as TS from "typescript";
import type { TsModule } from "./differential-fuzz-deps.js";

const MODIFIER_NAMES: ReadonlySet<string> = new Set(["not", "resolves", "rejects"]);

export interface ExpectChain {
	expectCall: TS.CallExpression;
	/** Modifier accesses, innermost first. */
	modifiers: TS.PropertyAccessExpression[];
	matcherAccess: TS.PropertyAccessExpression;
	matcherCall: TS.CallExpression;
	matcherName: string;
}

export function parseExpectChain(ts: TsModule, node: TS.Node): ExpectChain | null {
	if (!ts.isCallExpression(node)) return null;
	const matcherAccess = node.expression;
	if (!ts.isPropertyAccessExpression(matcherAccess)) return null;
	const modifiers: TS.PropertyAccessExpression[] = [];
	let cur: TS.Expression = matcherAccess.expression;
	while (ts.isPropertyAccessExpression(cur)) {
		modifiers.unshift(cur);
		cur = cur.expression;
	}
	if (!ts.isCallExpression(cur)) return null;
	if (!ts.isIdentifier(cur.expression) || cur.expression.text !== "expect") return null;
	if (!modifiers.every((m) => MODIFIER_NAMES.has(m.name.text))) return null;
	return { expectCall: cur, modifiers, matcherAccess, matcherCall: node, matcherName: matcherAccess.name.text };
}

export function hasModifier(chain: ExpectChain, name: string): boolean {
	return chain.modifiers.some((m) => m.name.text === name);
}

/** Strip parentheses and `await` wrappers. */
export function unwrapExpression(ts: TsModule, expr: TS.Expression): TS.Expression {
	let cur = expr;
	while (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
	return cur;
}

/** The expect chain a statement consists of, if it is exactly one. */
export function statementChain(ts: TsModule, node: TS.Node): ExpectChain | null {
	if (!ts.isExpressionStatement(node)) return null;
	return parseExpectChain(ts, unwrapExpression(ts, node.expression));
}

export function isFunctionLike(ts: TsModule, node: TS.Node): boolean {
	return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** `it(...)`, `test(...)`, `it.only(...)`, `it.each(t)(...)`, `it.skipIf(c)(...)`
 *  with a callback argument. The inner `it.each(table)` call has no callback,
 *  so it is not itself a test. */
export function isTestCall(ts: TsModule, call: TS.CallExpression): boolean {
	if (!call.arguments.some((a) => isFunctionLike(ts, a))) return false;
	let callee: TS.Expression = call.expression;
	while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
	return ts.isIdentifier(callee) && (callee.text === "it" || callee.text === "test");
}

export function testTitle(ts: TsModule, call: TS.CallExpression): string {
	const first = call.arguments[0];
	if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
	return "<dynamic>";
}

/** Count expect statements in a test call, without entering nested tests. */
export function countExpectStatements(ts: TsModule, call: TS.CallExpression): number {
	let count = 0;
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && isTestCall(ts, node)) return;
		if (statementChain(ts, node) !== null) count += 1;
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(call, visit);
	return count;
}

/** True when the statement sits in a statement list, so deleting or
 *  commenting it out cannot orphan an `if (x)` / `for (...)` body. */
export function inStatementList(ts: TsModule, node: TS.Node): boolean {
	const parent = node.parent;
	return ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent);
}
