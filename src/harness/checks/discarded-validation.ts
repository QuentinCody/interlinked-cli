import type * as TS from "typescript";
import { parseTsSource } from "./cyclomatic-ast.js";
import { reportNotMeasured } from "./check-root.js";

/** Remove ignored predicate/Result calls from lexical validation evidence, preserving source offsets.
 * Naming still supplies candidate semantics; this does not prove arbitrary custom parser contracts. */
export function maskDiscardedValidators(content: string, filePath: string, checkId = "unvalidated_json_boundary"): string {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) {
		reportNotMeasured(checkId, "discarded-validation AST evidence unavailable; lexical scan only");
		return content;
	}
	const { ts, sf } = parsed, spans: Array<[number, number]> = [];
	const visit = (node: TS.Node): void => {
		if (ts.isExpressionStatement(node)) {
			let expression = node.expression;
			while (ts.isAwaitExpression(expression) || ts.isVoidExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
			if (ts.isCallExpression(expression) && /^(?:is[A-Z]\w*|Array\.isArray|[\w.]+\.safeParse)$/.test(expression.expression.getText(sf))) spans.push([node.getStart(sf), node.end]);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	let result = content;
	for (const [start, end] of spans.reverse()) result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, " ") + result.slice(end);
	return result;
}
