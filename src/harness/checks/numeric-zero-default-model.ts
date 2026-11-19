import type * as TS from "typescript";
import { createHash } from "node:crypto";
import type { InlineMatch, InlineSourceEvidence } from "../check-registry/types.js";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";

export const NUMERIC_ZERO_CHECK = "numeric_zero_default";
export interface NumericModel extends ParsedTsSource {
	scopes: Map<TS.Node, Map<string, TS.Node>>;
	writes: Set<TS.Node>;
	globalWrites: Set<string>;
	sha256: string;
}
export type NumericOrigin = { state: "numeric"; source: string; sourceEvidence: InlineSourceEvidence[] } | { state: "other" } | { state: "unknown"; reason: string };
type NumericImportResolver = (model: NumericModel, declaration: TS.Node) => NumericOrigin;
const OTHER: NumericOrigin = { state: "other" };
const GLOBAL_PARSERS = new Set(["Number", "parseInt", "parseFloat"]);

export function numericBinding(model: NumericModel, name: TS.Identifier): TS.Node | undefined {
	let current: TS.Node | undefined = name;
	while (current) {
		const found = model.scopes.get(current)?.get(name.text);
		if (found) return found;
		current = current.parent;
	}
	return undefined;
}

function collectBindings(model: NumericModel): void {
	const { ts } = model;
	const lexicalScopes = new Set<TS.SyntaxKind>([ts.SyntaxKind.SourceFile, ts.SyntaxKind.Block, ts.SyntaxKind.CaseBlock,
		ts.SyntaxKind.ClassExpression, ts.SyntaxKind.ModuleBlock, ts.SyntaxKind.CatchClause,
		ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement]);
	const register = (scope: TS.Node, name: TS.BindingName, declaration: TS.Node): void => {
		if (!ts.isIdentifier(name)) {
			for (const element of name.elements) if (ts.isBindingElement(element)) register(scope, element.name, element);
			return;
		}
		const names = model.scopes.get(scope) ?? new Map<string, TS.Node>();
		names.set(name.text, declaration);
		model.scopes.set(scope, names);
	};
	const visit = (node: TS.Node, scope: TS.Node, functionScope: TS.Node): void => {
		const next = lexicalScopes.has(node.kind) || ts.isFunctionLike(node) ? node : scope;
		const nextFunction = ts.isFunctionLike(node) || ts.isSourceFile(node) || ts.isClassStaticBlockDeclaration(node) ? node : functionScope;
		const binding = declarationBinding(model, node);
		if (binding) {
			const scopes = { outer: scope, local: next, function: nextFunction };
			register(scopes[binding.scope], binding.name, node);
		}
		ts.forEachChild(node, child => visit(child, next, nextFunction));
	};
	visit(model.sf, model.sf, model.sf);
}

/** A declaration's name belongs to its enclosing scope; a named expression and
 * parameters belong to the new scope. Type-only imports have no runtime name. */
function declarationBinding(model: NumericModel, node: TS.Node): { name: TS.BindingName; scope: "outer" | "local" | "function" } | undefined {
	const { ts } = model;
	if (ts.isVariableDeclaration(node)) {
		const blockScoped = !ts.isVariableDeclarationList(node.parent) || (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
		return { name: node.name, scope: blockScoped ? "local" : "function" };
	}
	if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
		return node.name?.kind === ts.SyntaxKind.Identifier ? { name: node.name, scope: "outer" } : undefined;
	}
	if (ts.isParameter(node)) return { name: node.name, scope: "local" };
	if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) return node.name && { name: node.name, scope: "local" };
	const name = runtimeImportName(model, node);
	return name && { name, scope: "local" };
}

function runtimeImportName({ ts }: NumericModel, node: TS.Node): TS.Identifier | undefined {
	if (ts.isImportClause(node) || ts.isImportEqualsDeclaration(node)) return node.isTypeOnly ? undefined : node.name;
	if (ts.isNamespaceImport(node)) return node.parent.isTypeOnly ? undefined : node.name;
	if (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) return node.name;
	return undefined;
}

function collectWrites(model: NumericModel): void {
	const { ts } = model;
	const receiver = (node: TS.Expression, seen = new Set<TS.Node>()): string | undefined => {
		node = unwrapNumeric(model, node);
		if (!ts.isIdentifier(node)) return undefined;
		const declaration = numericBinding(model, node);
		if (!declaration) return GLOBAL_PARSERS.has(node.text) ? node.text : undefined;
		if (seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
		seen.add(declaration);
		return receiver(declaration.initializer, seen);
	};
	const markReceiver = (expression: TS.Expression): void => {
		const global = receiver(expression);
		if (global) model.globalWrites.add(global);
	};
	const write = (node: TS.Node): void => {
		if (ts.isIdentifier(node)) {
			const declaration = numericBinding(model, node);
			if (declaration) model.writes.add(declaration);
			else if (GLOBAL_PARSERS.has(node.text)) model.globalWrites.add(node.text);
			return;
		}
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			let root = node.expression;
			while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
			markReceiver(root);
			recordGlobalPropertyWrite(model, node, root);
			return;
		}
		ts.forEachChild(node, write);
	};
	const visit = (node: TS.Node): void => {
		const target = assignmentTarget(model, node);
		if (target) write(target);
		if (ts.isCallExpression(node)) {
			for (const argument of node.arguments) markReceiver(argument);
			const method = node.expression;
			if (ts.isPropertyAccessExpression(method) && !PURE_NUMBER_METHODS.has(method.name.text)) markReceiver(method.expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(model.sf);
}

const PURE_NUMBER_METHODS = new Set(["parseInt", "parseFloat", "isNaN", "isFinite", "isInteger", "isSafeInteger"]);

function assignmentTarget({ ts }: NumericModel, node: TS.Node): TS.Expression | undefined {
	if (ts.isDeleteExpression(node)) return node.expression;
	if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return node.left;
	if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return node.operand;
	return undefined;
}

function recordGlobalPropertyWrite(model: NumericModel, node: TS.Node, root: TS.Expression): void {
	if (!model.ts.isIdentifier(root) || root.text !== "globalThis" || numericBinding(model, root)) return;
	const text = node.getText(model.sf);
	if (!/\b(?:Number|parseInt|parseFloat)\b/.test(text)) return;
	for (const name of GLOBAL_PARSERS) if (text.includes(name)) model.globalWrites.add(name);
}

export function numericModel(content: string, file: string, gap: (reason: string) => void): NumericModel | undefined {
	const parsed = parseTsSource(content, file);
	if (!parsed) { gap("TypeScript parser is unavailable for numeric default analysis"); return undefined; }
	if (hasParseErrors(parsed.sf)) { gap("Source has recovered parse errors; numeric bindings were not resolved"); return undefined; }
	const model: NumericModel = { ...parsed, scopes: new Map(), writes: new Set(), globalWrites: new Set(), sha256: createHash("sha256").update(content).digest("hex") };
	collectBindings(model); collectWrites(model);
	return model;
}

function unwrapNumeric(model: NumericModel, node: TS.Expression): TS.Expression {
	while (model.ts.isParenthesizedExpression(node) || model.ts.isAsExpression(node) || model.ts.isTypeAssertionExpression(node) || model.ts.isSatisfiesExpression(node)) node = node.expression;
	return node;
}

function builtinParser(model: NumericModel, expression: TS.Expression): NumericOrigin {
	const { ts } = model;
	let name: string | undefined;
	if (ts.isIdentifier(expression) && GLOBAL_PARSERS.has(expression.text) && !numericBinding(model, expression)) name = expression.text;
	if (ts.isPropertyAccessExpression(expression) && ["parseInt", "parseFloat"].includes(expression.name.text)
		&& ts.isIdentifier(expression.expression) && expression.expression.text === "Number" && !numericBinding(model, expression.expression)) name = "Number";
	if (!name) return OTHER;
	return model.globalWrites.has(name) ? { state: "unknown", reason: `Numeric parser ${name} has a source mutation` }
		: { state: "numeric", source: expression.getText(model.sf), sourceEvidence: [{ file: model.sf.fileName, sha256: model.sha256,
			line: model.sf.getLineAndCharacterOfPosition(expression.getStart()).line + 1, role: "producer" }] };
}

type WrapperFunction = TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression;

function synchronousWrapper({ ts }: NumericModel, declaration: TS.Node): WrapperFunction | undefined {
	const value = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
	if (!value || !(ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration))) return undefined;
	if (!ts.isFunctionDeclaration(value) && !ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined;
	if (value.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || ("asteriskToken" in value && value.asteriskToken)) return undefined;
	return value;
}

function mutableBinding({ ts, writes }: NumericModel, declaration: TS.Node): boolean {
	if (writes.has(declaration)) return true;
	if (!ts.isVariableDeclaration(declaration)) return false;
	return !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0;
}

function containsParserCall(model: NumericModel, body: TS.Node): boolean {
	const inspect = (node: TS.Node): true | undefined => {
		if (model.ts.isCallExpression(node) && builtinParser(model, node.expression).state !== "other") return true;
		return model.ts.forEachChild(node, inspect);
	};
	return inspect(body) === true;
}

function returnedExpression({ ts }: NumericModel, body: TS.ConciseBody): TS.Expression | undefined {
	if (!ts.isBlock(body)) return body;
	const [statement, extra] = body.statements;
	return statement && !extra && ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function wrapperParserOrigin(model: NumericModel, fn: WrapperFunction, call: TS.CallExpression): NumericOrigin {
	const { ts } = model;
	const origin = builtinParser(model, call.expression);
	if (origin.state === "other" && fn.type?.kind === ts.SyntaxKind.NumberKeyword) return { state: "unknown", reason: "Numeric return contract uses an opaque parser" };
	if (origin.state !== "numeric") return origin;
	const stable = fn.parameters.every(parameter => ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken);
	const forwarded = call.arguments.every(argument => ts.isNumericLiteral(argument)
		|| (ts.isIdentifier(argument) && fn.parameters.some(parameter => numericBinding(model, argument) === parameter)));
	return stable && forwarded ? origin : { state: "unknown", reason: "Numeric helper does not directly forward stable parameters to its parser" };
}

export function numericWrapper(model: NumericModel, declaration: TS.Node): NumericOrigin {
	const { ts } = model;
	const fn = synchronousWrapper(model, declaration);
	if (!fn) return OTHER;
	const declaredNumber = fn.type?.kind === ts.SyntaxKind.NumberKeyword;
	if (!fn.body) return declaredNumber ? { state: "unknown", reason: "Numeric return contract has no inspectable parser body" } : OTHER;
	if (!declaredNumber && !containsParserCall(model, fn.body)) return OTHER;
	if (mutableBinding(model, declaration)) return { state: "unknown", reason: "Numeric parser wrapper binding is mutable" };
	const returned = returnedExpression(model, fn.body);
	if (!returned) return { state: "unknown", reason: "Numeric helper has unsupported control flow or effects" };
	const value = unwrapNumeric(model, returned);
	return ts.isCallExpression(value) ? wrapperParserOrigin(model, fn, value) : OTHER;
}

function callOrigin(model: NumericModel, callee: TS.Expression, imported?: NumericImportResolver): NumericOrigin {
	const direct = builtinParser(model, callee);
	if (direct.state !== "other") return direct;
	if (!model.ts.isIdentifier(callee)) return OTHER;
	const declaration = numericBinding(model, callee);
	if (!declaration) return OTHER;
	if (model.ts.isImportSpecifier(declaration) || model.ts.isImportClause(declaration)) return imported?.(model, declaration) ?? OTHER;
	return numericWrapper(model, declaration);
}

function numericOrigin(model: NumericModel, expression: TS.Expression, imported: NumericImportResolver | undefined, seen = new Set<TS.Node>()): NumericOrigin {
	const { ts } = model;
	expression = unwrapNumeric(model, expression);
	if (seen.has(expression)) return { state: "unknown", reason: "Numeric alias cycle is unsupported" };
	seen.add(expression);
	if (ts.isCallExpression(expression)) return callOrigin(model, expression.expression, imported);
	if (!ts.isIdentifier(expression)) return OTHER;
	const declaration = numericBinding(model, expression);
	if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return OTHER;
	const origin = numericOrigin(model, declaration.initializer, imported, seen);
	if (origin.state !== "numeric") return origin;
	if (mutableBinding(model, declaration)) return { state: "unknown", reason: "Numeric result binding is mutable" };
	return origin;
}

function zeroDefault(model: NumericModel, expression: TS.Expression, seen = new Set<TS.Node>()): boolean {
	const { ts } = model;
	expression = unwrapNumeric(model, expression);
	if (ts.isNumericLiteral(expression)) return Number(expression.text) === 0;
	if (ts.isPrefixUnaryExpression(expression) && (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)) return zeroDefault(model, expression.operand, seen);
	if (!ts.isIdentifier(expression)) return false;
	const declaration = numericBinding(model, expression);
	if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer || model.writes.has(declaration)) return false;
	if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
	seen.add(declaration);
	return zeroDefault(model, declaration.initializer, seen);
}

export function numericMatches(model: NumericModel, gap: (reason: string) => void, imported?: NumericImportResolver): InlineMatch[] {
	const { ts, sf } = model, matches: InlineMatch[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken && !zeroDefault(model, node.right)) {
			const origin = numericOrigin(model, node.left, imported);
			if (origin.state === "unknown") gap(`Line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${origin.reason}`);
			if (origin.state === "numeric") matches.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
				startOffset: node.getStart(), endOffset: node.getEnd(), endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
				sourceEvidence: [...origin.sourceEvidence, { file: sf.fileName, sha256: model.sha256, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, role: "consumer" }],
				text: `If ${origin.source} returns numeric zero, || selects ${node.right.getText(sf).slice(0, 100)}; review the intended zero/default contract.` });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return matches;
}
