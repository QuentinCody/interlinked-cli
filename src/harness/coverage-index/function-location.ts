import type * as TS from "typescript";
import { record, sourceSpan } from "../../lib/metrics/evidence-json.js";
import { coverageFunctionSpan } from "../../lib/metrics/coverage-span.js";
import { parseTsSource, type ParsedTsSource } from "../checks/cyclomatic-ast.js";
import { hasExactSyntax } from "../function-tokens/ast-tokens.js";

function bodyOf(node: TS.Node, ts: typeof TS): TS.ConciseBody | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) return node.body;
    return undefined;
}
function recoverEnd(parsed: ParsedTsSource, raw: unknown): { line: number; character: number } {
    const fn = record(raw, "function"), decl = sourceSpan(fn.decl), location = coverageFunctionSpan(fn.loc), candidates: TS.ConciseBody[] = [];
    const point = parsed.sf.getPositionOfLineAndCharacter(decl.line - 1, decl.column);
    function visit(node: TS.Node): void {
        const body = bodyOf(node, parsed.ts);
        if (body && node.getStart(parsed.sf) <= point && node.getEnd() >= point && parsed.sf.getLineAndCharacterOfPosition(body.getEnd()).line + 1 === location.endLine) candidates.push(body);
        parsed.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    const body = candidates.sort((a, b) => a.getWidth(parsed.sf) - b.getWidth(parsed.sf))[0];
    if (!body) throw new Error("Cannot resolve open-ended coverage function against current parser span");
    return parsed.sf.getLineAndCharacterOfPosition(body.getEnd());
}
export function functionLocationKey(raw: unknown, content: string, path: string): string {
    const location = coverageFunctionSpan(record(raw, "function").loc);
    if (location.endColumn === Number.MAX_SAFE_INTEGER) {
        const parsed = parseTsSource(content, path);
        if (!parsed || !hasExactSyntax(parsed)) throw new Error("Cannot resolve incomplete function column without exact syntax");
        location.endColumn = recoverEnd(parsed, raw).character;
    }
    return JSON.stringify([location.line, location.column, location.endLine, location.endColumn]);
}
