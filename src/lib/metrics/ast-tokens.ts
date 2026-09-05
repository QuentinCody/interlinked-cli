import type * as TS from "typescript";
import { functionName, isImplementationFunction, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";

export interface AstImplementation {
    name: string;
    line: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
    tokens: number;
    exposure: number;
}
export interface DocumentationSpan { startOffset: number; endOffset: number; }
export interface AstTokenCounts { astTokens: number; functions: AstImplementation[]; documentation: DocumentationSpan[]; }
interface TokenContext { parsed: ParsedTsSource; functions: AstImplementation[]; documentation: DocumentationSpan[]; }

function implementation(node: TS.Node, parsed: ParsedTsSource): AstImplementation {
    const startOffset = node.getStart(parsed.sf);
    const endOffset = node.getEnd();
    return {
        name: functionName(parsed.ts, node, parsed.sf),
        line: parsed.sf.getLineAndCharacterOfPosition(startOffset).line + 1,
        endLine: parsed.sf.getLineAndCharacterOfPosition(endOffset).line + 1,
        startOffset, endOffset, tokens: 0, exposure: 0,
    };
}

function visitAst(node: TS.Node, enclosing: AstImplementation | undefined, context: TokenContext): number {
    const { parsed, functions } = context;
    if (node.kind === parsed.ts.SyntaxKind.JSDocComment) {
        context.documentation.push({ startOffset: node.getStart(parsed.sf), endOffset: node.getEnd() });
        return 0;
    }
    const current = isImplementationFunction(parsed.ts, node) ? implementation(node, parsed) : undefined;
    if (current) functions.push(current);
    const owner = current ?? enclosing;
    const children = node.getChildren(parsed.sf);
    if (children.length === 0) {
        if (node.kind > parsed.ts.SyntaxKind.LastToken || node.getWidth(parsed.sf) === 0) return 0;
        if (owner) owner.exposure += 1;
        return 1;
    }
    let total = 0;
    for (const child of children) total += visitAst(child, owner, context);
    if (current) current.tokens = total;
    return total;
}

/** Parser-resolved tokens correctly delimit regexes, JSX and interpolated templates. */
export function countAstImplementations(parsed: ParsedTsSource): AstTokenCounts {
    const context: TokenContext = { parsed, functions: [], documentation: [] };
    return { astTokens: visitAst(parsed.sf, undefined, context), functions: context.functions, documentation: context.documentation };
}
