// Awaiting Array#forEach never waits for its callbacks. Unknown receivers may
// implement an async API, so only unambiguous arrays defeat that exemption.
import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type TsModule } from "./cyclomatic-ast.js";

const ARRAY_METHODS = new Set(["map", "filter", "slice", "concat", "flat", "flatMap", "toSorted", "toReversed", "toSpliced", "with"]);

/** Collect constants, retaining every other binding as an ambiguity marker. */
function arrayBindings(ts: TsModule, sf: TS.SourceFile): Map<string, TS.Expression | null> {
	const bindings = new Map<string, TS.Expression | null>();
	const record = (name: TS.BindingName, initializer: TS.Expression | null): void => {
		if (!ts.isIdentifier(name)) {
			for (const element of name.elements) if (ts.isBindingElement(element)) record(element.name, null);
			return;
		}
		bindings.set(name.text, bindings.has(name.text) ? null : initializer);
	};
	const collect = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node)) {
			const constant = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
			record(node.name, constant ? node.initializer ?? null : null);
		} else if (ts.isParameter(node)) record(node.name, null);
		else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) record(node.name, null);
		else if (ts.isImportClause(node) && node.name) record(node.name, null);
		else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) record(node.name, null);
		ts.forEachChild(node, collect);
	};
	collect(sf);
	return bindings;
}

/** Call offsets whose forEach receiver is an array literal or an unambiguous const
 * initialized from one. Duplicate bindings stay unknown so this parse-only
 * check cannot confuse a shadowed stream with an array. The caller passes its
 * stripped scan text so offsets share the same string-literal normalization. */
export function arrayForEachOffsets(content: string, filePath: string): Set<number> {
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) return new Set();
	const { ts, sf } = parsed;
	const bindings = arrayBindings(ts, sf);
	const isArray = (expression: TS.Expression, seen: Set<string>): boolean => {
		if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
			return isArray(expression.expression, seen);
		}
		if (ts.isArrayLiteralExpression(expression)) return true;
		if (ts.isIdentifier(expression)) {
			if (seen.has(expression.text)) return false;
			seen.add(expression.text);
			const value = bindings.get(expression.text);
			return value != null && isArray(value, seen);
		}
		if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
			return ARRAY_METHODS.has(expression.expression.name.text) && isArray(expression.expression.expression, seen);
		}
		return false;
	};
	const offsets = new Set<number>();
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "forEach") {
			if (isArray(node.expression.expression, new Set())) {
				offsets.add(node.expression.name.getStart(sf) - 1);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return offsets;
}
