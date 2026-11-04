// ===========================================
// Test-side mutants — the eight operators
// ===========================================
// CLASS: an edit to a TEST file that a meaningful assertion must notice.
// `collectRawMutants` inspects ONE node and proposes zero or more mutants; the
// walker in test-mutants.ts visits every node, so each site is seen once.
//
// FIRES WHEN: the node is an expect chain / statement / test call / vi.mock the
//   operator below recognizes, inside an it()/test() (vi.mock and
//   vi.setConfig are file-level and need no enclosing test).
// DOES NOT FIRE: `obj.expect(x)` (only the bare identifier roots a chain); an
//   expect outside any test (a module-level helper — its owning test is
//   unknowable); a statement that is an unbraced if/for body (deleting or
//   commenting it out would orphan the body); negated chains for the
//   loosen/perturb operators (they would tighten, or stay vacuously green, so
//   zero kill-set shrink there would read as a false tautology); a timeout
//   held in a variable; a vi.mock of a bare package or `node:` module.
// KNOWN GAPS: no jest.* aliases, no expect.soft/poll, no .each tables.

import type * as TS from "typescript";
import type { TsModule } from "./differential-fuzz-deps.js";
import {
	type ExpectChain,
	hasModifier,
	inStatementList,
	isTestCall,
	parseExpectChain,
	statementChain,
	testTitle,
} from "./test-mutants-chain.js";
import type { RawTestMutant, TestContext } from "./test-mutants-types.js";

/** matcher -> [argument count, replacement call text]; undefined count = one or more. */
const LOOSEN: Readonly<Record<string, readonly [number | undefined, string]>> = {
	toBe: [1, "toBeDefined()"],
	toEqual: [1, "toBeDefined()"],
	toStrictEqual: [1, "toBeDefined()"],
	toHaveLength: [1, "toBeDefined()"],
	toContain: [1, "toBeTruthy()"],
	toMatch: [1, 'toBeTypeOf("string")'],
	toThrow: [undefined, "toThrow()"],
	toThrowError: [undefined, "toThrowError()"],
};

const UNDEFINED_SENSITIVE: ReadonlySet<string> = new Set(["toBe", "toEqual", "toStrictEqual"]);

function negateMutant(sf: TS.SourceFile, chain: ExpectChain): RawTestMutant {
	const existing = chain.modifiers.find((m) => m.name.text === "not");
	if (existing !== undefined) {
		return { kind: "assertion_negate", start: existing.expression.end, end: existing.name.end, replacement: "" };
	}
	const name = chain.matcherAccess.name;
	return { kind: "assertion_negate", start: name.getStart(sf), end: name.end, replacement: `not.${name.text}` };
}

function loosenMutant(ts: TsModule, sf: TS.SourceFile, chain: ExpectChain): RawTestMutant | null {
	const rule = LOOSEN[chain.matcherName];
	if (rule === undefined || hasModifier(chain, "not")) return null;
	const args = chain.matcherCall.arguments;
	const [wanted, replacement] = rule;
	if (wanted === undefined ? args.length < 1 : args.length !== wanted) return null;
	const first = args[0];
	if (UNDEFINED_SENSITIVE.has(chain.matcherName) && first !== undefined && ts.isIdentifier(first) && first.text === "undefined") {
		return null;
	}
	const start = chain.matcherAccess.name.getStart(sf);
	return { kind: "matcher_loosen", start, end: chain.matcherCall.end, replacement };
}

function isExpectNamespaceCall(ts: TsModule, node: TS.CallExpression): boolean {
	const callee = node.expression;
	return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect";
}

function stringPerturbation(raw: string): string {
	return `${raw.slice(0, -1)}x${raw.slice(-1)}`;
}

/** Replacement text for a perturbable literal node, or null. */
function literalPerturbation(ts: TsModule, sf: TS.SourceFile, node: TS.Node): string | null {
	if (ts.isNumericLiteral(node)) {
		const value = Number(node.text.replace(/_/g, ""));
		return Number.isFinite(value) ? String(value + 1) : null;
	}
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return stringPerturbation(node.getText(sf));
	if (node.kind === ts.SyntaxKind.TrueKeyword) return "false";
	if (node.kind === ts.SyntaxKind.FalseKeyword) return "true";
	return null;
}

/** Sub-expressions that still hold expected DATA. Object keys, function bodies
 *  and ordinary calls (`toBe(compute(3))`: 3 is an input) are not descended. */
function dataChildren(ts: TsModule, node: TS.Node): readonly TS.Node[] {
	if (ts.isArrayLiteralExpression(node)) return node.elements;
	if (ts.isObjectLiteralExpression(node)) {
		return node.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? [p.initializer] : []));
	}
	if (ts.isCallExpression(node)) return isExpectNamespaceCall(ts, node) ? node.arguments : [];
	if (ts.isPrefixUnaryExpression(node)) return [node.operand];
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return [node.expression];
	return [];
}

function perturbTargets(ts: TsModule, sf: TS.SourceFile, node: TS.Node, out: RawTestMutant[]): void {
	const replacement = literalPerturbation(ts, sf, node);
	if (replacement !== null) out.push({ kind: "expected_perturb", start: node.getStart(sf), end: node.end, replacement });
	for (const child of dataChildren(ts, node)) perturbTargets(ts, sf, child, out);
}

function widenNumber(sf: TS.SourceFile, node: TS.Expression, ts: TsModule, testName?: string): RawTestMutant | null {
	if (!ts.isNumericLiteral(node)) return null;
	const value = Number(node.text.replace(/_/g, ""));
	if (!Number.isFinite(value) || value <= 0) return null;
	const mutant: RawTestMutant = { kind: "timeout_widen", start: node.getStart(sf), end: node.end, replacement: String(value * 10) };
	return testName === undefined ? mutant : { ...mutant, testName };
}

function widenProperty(ts: TsModule, sf: TS.SourceFile, obj: TS.Expression, prop: string, testName?: string): RawTestMutant[] {
	if (!ts.isObjectLiteralExpression(obj)) return [];
	const out: RawTestMutant[] = [];
	for (const p of obj.properties) {
		if (!ts.isPropertyAssignment(p)) continue;
		const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
		const widened = key === prop ? widenNumber(sf, p.initializer, ts, testName) : null;
		if (widened !== null) out.push(widened);
	}
	return out;
}

function testCallMutants(ts: TsModule, sf: TS.SourceFile, call: TS.CallExpression): RawTestMutant[] {
	const title = testTitle(ts, call);
	const out: RawTestMutant[] = [];
	const third = call.arguments[2];
	const widened = third === undefined ? null : widenNumber(sf, third, ts, title);
	if (widened !== null) out.push(widened);
	for (const arg of call.arguments.slice(1, 3)) out.push(...widenProperty(ts, sf, arg, "timeout", title));
	return out;
}

function setConfigMutants(ts: TsModule, sf: TS.SourceFile, call: TS.CallExpression): RawTestMutant[] {
	const callee = call.expression;
	const isSetConfig =
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === "vi" &&
		callee.name.text === "setConfig";
	const arg = call.arguments[0];
	return isSetConfig && arg !== undefined ? widenProperty(ts, sf, arg, "testTimeout") : [];
}

function chainMutants(ts: TsModule, sf: TS.SourceFile, chain: ExpectChain): RawTestMutant[] {
	const out: RawTestMutant[] = [negateMutant(sf, chain)];
	const loosened = loosenMutant(ts, sf, chain);
	if (loosened !== null) out.push(loosened);
	if (!hasModifier(chain, "not")) {
		for (const arg of chain.matcherCall.arguments) perturbTargets(ts, sf, arg, out);
	}
	return out;
}

function callMutants(ts: TsModule, sf: TS.SourceFile, call: TS.CallExpression, ctx: TestContext): RawTestMutant[] {
	const chain = parseExpectChain(ts, call);
	if (chain !== null) return ctx.testName === null ? [] : chainMutants(ts, sf, chain);
	if (isTestCall(ts, call)) return testCallMutants(ts, sf, call);
	return setConfigMutants(ts, sf, call);
}

function isAssertionCountCall(ts: TsModule, expr: TS.Expression): boolean {
	if (!ts.isCallExpression(expr)) return false;
	const callee = expr.expression;
	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === "expect" &&
		(callee.name.text === "assertions" || callee.name.text === "hasAssertions")
	);
}

/** Relative module specifier of a `vi.mock("./x")` statement, if it is one. */
function relativeMockSpecifier(ts: TsModule, expr: TS.Expression): string | null {
	if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
	const { expression: base, name } = expr.expression;
	const spec = expr.arguments[0];
	if (!ts.isIdentifier(base) || base.text !== "vi" || name.text !== "mock") return null;
	if (spec === undefined || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) return null;
	return spec.text;
}

function statementMutants(ts: TsModule, sf: TS.SourceFile, stmt: TS.ExpressionStatement, ctx: TestContext): RawTestMutant[] {
	if (!inStatementList(ts, stmt)) return [];
	const whole = { start: stmt.getStart(sf), end: stmt.end };
	const inTest = ctx.testName !== null;
	if (inTest && ctx.expectStatementCount >= 2 && statementChain(ts, stmt) !== null) {
		return [{ kind: "assertion_delete", ...whole, replacement: "" }];
	}
	if (inTest && isAssertionCountCall(ts, stmt.expression)) {
		return [{ kind: "expect_assertions_remove", ...whole, replacement: "" }];
	}
	const specifier = relativeMockSpecifier(ts, stmt.expression);
	if (specifier !== null) {
		return [{ kind: "mock_to_real", ...whole, replacement: "/* vi.mock removed */", detail: specifier }];
	}
	return [];
}

function awaitMutants(ts: TsModule, sf: TS.SourceFile, node: TS.AwaitExpression, ctx: TestContext): RawTestMutant[] {
	if (ctx.testName === null) return [];
	let operand: TS.Expression = node.expression;
	while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
	const chain = parseExpectChain(ts, operand);
	if (chain === null || !(hasModifier(chain, "rejects") || hasModifier(chain, "resolves"))) return [];
	return [{ kind: "await_drop", start: node.getStart(sf), end: node.expression.getStart(sf), replacement: "" }];
}

/** Mutants proposed for exactly this node (children are the walker's job). */
export function collectRawMutants(ts: TsModule, sf: TS.SourceFile, node: TS.Node, ctx: TestContext): RawTestMutant[] {
	if (ts.isCallExpression(node)) return callMutants(ts, sf, node, ctx);
	if (ts.isExpressionStatement(node)) return statementMutants(ts, sf, node, ctx);
	if (ts.isAwaitExpression(node)) return awaitMutants(ts, sf, node, ctx);
	return [];
}
