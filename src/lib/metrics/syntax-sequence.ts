import type * as TS from "typescript";
import type { ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";

/** Parser-resolved leaves share lexical boundaries with the syntax-token gate. */
export function syntaxSequence(node: TS.Node, parsed: ParsedTsSource): string[] {
    if (node.kind === parsed.ts.SyntaxKind.JSDocComment) return [];
    const children = node.getChildren(parsed.sf);
    if (children.length) return children.flatMap(child => syntaxSequence(child, parsed));
    if (node.kind > parsed.ts.SyntaxKind.LastToken || node.getWidth(parsed.sf) === 0) return [];
    return [node.getText(parsed.sf)];
}
