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
	// A JSDoc `@type` / `@satisfies` on a group is plain JS's only cast syntax; the
	// checker honors it only in JS files, where it ends the chain like `as` / `!`.
	const isJsDocCast = (group: TS.ParenthesizedExpression): boolean =>
		(group.flags & ts.NodeFlags.JavaScriptFile) !== 0 &&
		(ts.getJSDocTypeTag(group) !== undefined || ts.getJSDocSatisfiesTag(group) !== undefined);
	const visit = (node: TS.Node): void => {
		if (lines.size >= 10) return;
		if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isParenthesizedExpression(node.expression)) {
			let group: TS.ParenthesizedExpression = node.expression;
			let cast = isJsDocCast(group);
			while (ts.isParenthesizedExpression(group.expression)) {
				group = group.expression;
				cast ||= isJsDocCast(group);
			}
			const inner = group.expression;
			if (!cast && (ts.isPropertyAccessChain(inner) || ts.isElementAccessChain(inner) || ts.isCallChain(inner))) {
				lines.add(sf.getLineAndCharacterOfPosition(node.expression.getStart(sf)).line);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const originalLines = content.split("\n");
	return [...lines].sort((a, b) => a - b).map((line) => ({ line: line + 1, text: (originalLines[line] ?? "").trim().slice(0, 150) }));
}
