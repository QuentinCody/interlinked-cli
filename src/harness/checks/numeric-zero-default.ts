// CLASS: Numeric zero results replaced through a logical-or default.
// FIRES WHEN: a resolved numeric coercion, stable result alias or supported raw
// parser wrapper reaches the left operand of || with a different possible default.
// DOES NOT FIRE: same-zero defaults, ??, shadowed builtins or normalized outputs.
// CALIBRATION: advisory source facts, with original/fixed search and foreign controls.
// KNOWN GAPS: general dataflow, ambient monkey-patching and opaque numeric wrappers.
// HOW TO EXTEND: resolve additional source relations with independent controls.
import type * as TS from "typescript";
import { createHash } from "node:crypto";
import type { InlineMatch, InlineSourceEvidence } from "../check-registry/types.js";
import { reportNotMeasured } from "./check-root.js";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import { numericProjectView, scanNumericProject } from "./numeric-zero-default-project.js";

export const NUMERIC_ZERO_CHECK = "numeric_zero_default";
export interface NumericModel extends ParsedTsSource {
	scopes: Map<TS.Node, Map<string, TS.Node>>;
	writes: Set<TS.Node>;
	globalWrites: Set<string>;
	sha256: string;
}
export type NumericOrigin = { state: "numeric"; source: string; sourceEvidence: InlineSourceEvidence[] } | { state: "other" } | { state: "unknown"; reason: string };
export type NumericImportResolver = (model: NumericModel, declaration: TS.Node) => NumericOrigin;
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
	const register = (scope: TS.Node, name: TS.BindingName, declaration: TS.Node): void => {
		if (!ts.isIdentifier(name)) {
			for (const element of name.elements) if (ts.isBindingElement(element)) register(scope, element.name, element);
			return;
		}
		const names = model.scopes.get(scope) ?? new Map<string, TS.Node>();
		names.set(name.text, declaration); model.scopes.set(scope, names);
	};
	const visit = (node: TS.Node, scope: TS.Node, functionScope: TS.Node): void => {
		if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name && ts.isIdentifier(node.name)) register(scope, node.name, node);
		const next = ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node) || ts.isClassExpression(node) || ts.isModuleBlock(node) || ts.isFunctionLike(node)
			|| ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ? node : scope;
		const nextFunction = ts.isFunctionLike(node) || ts.isSourceFile(node) || ts.isClassStaticBlockDeclaration(node) ? node : functionScope;
		if (ts.isVariableDeclaration(node)) {
			const blockScoped = !ts.isVariableDeclarationList(node.parent) || (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
			register(blockScoped ? next : nextFunction, node.name, node);
		}
		if (ts.isParameter(node)) register(next, node.name, node);
		if (ts.isFunctionExpression(node) && node.name) register(next, node.name, node);
		if (ts.isClassExpression(node) && node.name) register(next, node.name, node);
		if (ts.isImportClause(node) && !node.isTypeOnly && node.name) register(next, node.name, node);
		if (ts.isNamespaceImport(node) && !node.parent.isTypeOnly) register(next, node.name, node);
		if (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) register(next, node.name, node);
		if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) register(next, node.name, node);
		ts.forEachChild(node, child => visit(child, next, nextFunction));
	};
	visit(model.sf, model.sf, model.sf);
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
			const global = receiver(root);
			if (global) model.globalWrites.add(global);
			if (ts.isIdentifier(root) && root.text === "globalThis" && !numericBinding(model, root) && /\b(?:Number|parseInt|parseFloat)\b/.test(node.getText(model.sf))) {
				for (const name of GLOBAL_PARSERS) if (node.getText(model.sf).includes(name)) model.globalWrites.add(name);
			}
			return;
		}
		ts.forEachChild(node, write);
	};
	const visit = (node: TS.Node): void => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) write(node.left);
		if (ts.isDeleteExpression(node)) write(node.expression);
		if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) write(node.operand);
		if (ts.isCallExpression(node)) for (const argument of node.arguments) {
			const global = receiver(argument);
			if (global) model.globalWrites.add(global);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const global = receiver(node.expression.expression);
			if (global && !["parseInt", "parseFloat", "isNaN", "isFinite", "isInteger", "isSafeInteger"].includes(node.expression.name.text)) model.globalWrites.add(global);
		}
		ts.forEachChild(node, visit);
	};
	visit(model.sf);
}

export function numericModel(content: string, file: string, gap: (reason: string) => void): NumericModel | undefined {
	const parsed = parseTsSource(content, file);
	if (!parsed) { gap("TypeScript parser is unavailable for numeric default analysis"); return undefined; }
	if (hasParseErrors(parsed.sf)) { gap("Source has recovered parse errors; numeric bindings were not resolved"); return undefined; }
	const model: NumericModel = { ...parsed, scopes: new Map(), writes: new Set(), globalWrites: new Set(), sha256: createHash("sha256").update(content).digest("hex") };
	collectBindings(model); collectWrites(model);
	return model;
}

export function unwrapNumeric(model: NumericModel, node: TS.Expression): TS.Expression {
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

export function numericWrapper(model: NumericModel, declaration: TS.Node): NumericOrigin {
	const { ts } = model;
	const fn = ts.isFunctionDeclaration(declaration) ? declaration
		: ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
	if (!fn) return OTHER;
	if (fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || ("asteriskToken" in fn && fn.asteriskToken)) return OTHER;
	if (!fn.body) return fn.type?.kind === ts.SyntaxKind.NumberKeyword ? { state: "unknown", reason: "Numeric return contract has no inspectable parser body" } : OTHER;
	const body = fn.body;
	let relevant = fn.type?.kind === ts.SyntaxKind.NumberKeyword;
	const inspect = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && builtinParser(model, node.expression).state !== "other") relevant = true;
		ts.forEachChild(node, inspect);
	};
	inspect(body);
	if (!relevant) return OTHER;
	if (model.writes.has(declaration) || (ts.isVariableDeclaration(declaration) && (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0))) return { state: "unknown", reason: "Numeric parser wrapper binding is mutable" };
	let value: TS.Expression | undefined;
	if (!ts.isBlock(body)) value = body;
	else if (body.statements.length === 1 && body.statements[0] && ts.isReturnStatement(body.statements[0])) value = body.statements[0].expression;
	if (!value) return { state: "unknown", reason: "Numeric helper has unsupported control flow or effects" };
	value = unwrapNumeric(model, value);
	if (ts.isConditionalExpression(value)) return OTHER;
	if (!ts.isCallExpression(value)) return OTHER;
	const origin = builtinParser(model, value.expression);
	if (origin.state === "other" && fn.type?.kind === ts.SyntaxKind.NumberKeyword) return { state: "unknown", reason: "Numeric return contract uses an opaque parser" };
	if (origin.state !== "numeric") return origin;
	if (fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
		|| value.arguments.some(argument => !ts.isNumericLiteral(argument) && !(ts.isIdentifier(argument) && fn.parameters.some(parameter => numericBinding(model, argument) === parameter)))) {
		return { state: "unknown", reason: "Numeric helper does not directly forward stable parameters to its parser" };
	}
	return origin;
}

function numericOrigin(model: NumericModel, expression: TS.Expression, imported: NumericImportResolver | undefined, seen = new Set<TS.Node>()): NumericOrigin {
	const { ts } = model;
	expression = unwrapNumeric(model, expression);
	if (seen.has(expression)) return { state: "unknown", reason: "Numeric alias cycle is unsupported" };
	seen.add(expression);
	if (ts.isCallExpression(expression)) {
		const direct = builtinParser(model, expression.expression);
		if (direct.state !== "other") return direct;
		if (!ts.isIdentifier(expression.expression)) return OTHER;
		const declaration = numericBinding(model, expression.expression);
		if (!declaration) return OTHER;
		if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) return imported?.(model, declaration) ?? OTHER;
		return numericWrapper(model, declaration);
	}
	if (!ts.isIdentifier(expression)) return OTHER;
	const declaration = numericBinding(model, expression);
	if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return OTHER;
	const origin = numericOrigin(model, declaration.initializer, imported, seen);
	if (origin.state !== "numeric") return origin;
	if (model.writes.has(declaration) || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return { state: "unknown", reason: "Numeric result binding is mutable" };
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

/** Shared registry predicate. Supplied project evidence adds supported helpers;
 * standalone evaluation never starts a repository inventory. */
export function detectNumericZeroDefault(content: string, filePath: string): InlineMatch[] {
	if (!/\.[cm]?[jt]sx?$/.test(filePath) || (!content.includes("||") && !/\b(?:Number|parseInt|parseFloat)\b/.test(content))) return [];
	const view = numericProjectView(content, filePath);
	const gap = (reason: string) => view ? view.gap(filePath, reason) : reportNotMeasured(NUMERIC_ZERO_CHECK, `${filePath}: ${reason}`);
	const cached = view?.models.get(view.target);
	const model = cached?.content === content ? cached.model : numericModel(content, view?.target ?? filePath, gap);
	if (!model) return [];
	return view ? scanNumericProject(view, model) : numericMatches(model, gap);
}
