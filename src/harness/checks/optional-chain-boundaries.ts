import type * as TS from "typescript";
import { parseTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";

/** A grouping node ends an optional chain; a call's argument parentheses do not. */
export function scanBrokenOptionalGrouping(content: string, filePath: string): InlineMatch[] {
	if (!content.includes("?.")) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return []; // No syntax evidence: never use the ambiguous regex as a block.
	const { ts, sf } = parsed;
	const lines = new Set<number>();
	const visit = (node: TS.Node): void => {
		if (lines.size >= 10) return;
		if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isParenthesizedExpression(node.expression)) {
			let inner = node.expression.expression;
			while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
			if (ts.isPropertyAccessChain(inner) || ts.isElementAccessChain(inner) || ts.isCallChain(inner)) {
				lines.add(sf.getLineAndCharacterOfPosition(node.expression.getStart(sf)).line);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const originalLines = content.split("\n");
	return [...lines].sort((a, b) => a - b).map((line) => ({ line: line + 1, text: (originalLines[line] ?? "").trim().slice(0, 150) }));
}
