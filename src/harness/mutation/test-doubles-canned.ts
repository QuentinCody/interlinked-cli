// Test doubles — the "canned answer" heuristic.
//
// Step 8a of scratch/CAMPAIGN-mutation-rl.md. A stand-in whose body only
// returns literals (or `vi.fn()` / `vi.fn(() => literal)` chains) answers the
// same way whatever the real module does, so the real module can drift without
// the test noticing. This file decides, from the AST alone, whether an
// expression or function body is of that shape.
//
// HEURISTIC, not proof: the result is named `factoryReturnsCanned` upstream and
// is a ranking signal for step 8b, never a verdict. It errs toward `false`:
// any identifier reference, spread, computed value or call it does not know
// makes the answer `false`, because a stand-in that reads live state may track
// the real module. In particular `{ ...(await vi.importActual(x)), f: vi.fn() }`
// is a PARTIAL mock (the rest stays real) and is therefore NOT canned.

import type * as TS from "typescript";

type Ts = typeof TS;

/** Chain methods that supply a replacement answer on a `vi.fn()` / `vi.spyOn()` result. */
export const IMPLEMENTATION_METHODS: ReadonlySet<string> = new Set([
	"mockImplementation",
	"mockImplementationOnce",
	"mockReturnValue",
	"mockReturnValueOnce",
	"mockResolvedValue",
	"mockResolvedValueOnce",
	"mockRejectedValue",
	"mockRejectedValueOnce",
]);

/** Receivers whose `.fn` / `.mock` / `.spyOn` … calls create a double. */
export const MOCK_NAMESPACES: ReadonlySet<string> = new Set(["vi", "jest"]);

function unwrap(ts: Ts, node: TS.Node): TS.Node {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function isLiteralLeaf(ts: Ts, node: TS.Node): boolean {
	if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
	if (ts.isRegularExpressionLiteral(node)) return true;
	if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
	if (node.kind === ts.SyntaxKind.NullKeyword) return true;
	return ts.isIdentifier(node) && node.text === "undefined";
}

function isCannedProperty(ts: Ts, prop: TS.ObjectLiteralElementLike): boolean {
	if (ts.isPropertyAssignment(prop)) return isCannedExpression(ts, prop.initializer);
	if (ts.isMethodDeclaration(prop)) return prop.body !== undefined && isCannedBlock(ts, prop.body);
	return false;
}

/** A block is canned when it is empty, or declares canned consts and then returns canned. */
function isCannedBlock(ts: Ts, block: TS.Block): boolean {
	const statements = block.statements;
	if (statements.length === 0) return true;
	const last = statements[statements.length - 1];
	if (last === undefined || !ts.isReturnStatement(last)) return false;
	if (last.expression !== undefined && !isCannedExpression(ts, last.expression)) return false;
	for (const stmt of statements.slice(0, -1)) {
		if (!ts.isVariableStatement(stmt)) return false;
		const declared = stmt.declarationList.declarations;
		if (!declared.every((decl) => decl.initializer !== undefined && isCannedExpression(ts, decl.initializer))) {
			return false;
		}
	}
	return true;
}

/** Body of an arrow / function expression: a canned expression or a canned block. */
export function isCannedFunctionBody(ts: Ts, body: TS.ConciseBody): boolean {
	return ts.isBlock(body) ? isCannedBlock(ts, body) : isCannedExpression(ts, body);
}

function calleeText(ts: Ts, call: TS.CallExpression): string | null {
	const callee = call.expression;
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		return `${callee.expression.text}.${callee.name.text}`;
	}
	return null;
}

const CANNED_FACTORY_CALLEES: ReadonlySet<string> = new Set(["vi.fn", "jest.fn", "Promise.resolve", "Promise.reject"]);

function isCannedCall(ts: Ts, call: TS.CallExpression): boolean {
	const argsCanned = call.arguments.every((arg) => isCannedExpression(ts, arg));
	const text = calleeText(ts, call);
	if (text !== null && CANNED_FACTORY_CALLEES.has(text)) return argsCanned;
	const callee = call.expression;
	if (ts.isPropertyAccessExpression(callee) && IMPLEMENTATION_METHODS.has(callee.name.text)) {
		return argsCanned && isCannedExpression(ts, callee.expression);
	}
	return false;
}

/** True when `node` can only evaluate to a value fixed at write time (see the file header). */
export function isCannedExpression(ts: Ts, node: TS.Node | undefined): boolean {
	if (node === undefined) return false;
	const n = unwrap(ts, node);
	if (isLiteralLeaf(ts, n)) return true;
	if (ts.isPrefixUnaryExpression(n)) return isCannedExpression(ts, n.operand);
	if (ts.isArrayLiteralExpression(n)) return n.elements.every((el) => isCannedExpression(ts, el));
	if (ts.isObjectLiteralExpression(n)) return n.properties.every((p) => isCannedProperty(ts, p));
	if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return isCannedFunctionBody(ts, n.body);
	if (ts.isCallExpression(n)) return isCannedCall(ts, n);
	return false;
}
