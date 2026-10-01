import type * as TS from "typescript";
import { record } from "../../lib/metrics/evidence-json.js";
import { coverageFunctionSpan } from "../../lib/metrics/coverage-span.js";
import { parseTsSource, type ParsedTsSource } from "../checks/cyclomatic-ast.js";
import { hasExactSyntax } from "../function-tokens/ast-tokens.js";

function bodyOf(node: TS.Node, ts: typeof TS): TS.ConciseBody | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) return node.body;
    return undefined;
}
/** The narrowest function body that contains `point` and ends on `endLine`, or null. */
function bodyAt(parsed: ParsedTsSource, point: number, endLine: number): TS.ConciseBody | null {
    const candidates: TS.ConciseBody[] = [];
    function visit(node: TS.Node): void {
        const body = bodyOf(node, parsed.ts);
        if (body && node.getStart(parsed.sf) <= point && node.getEnd() >= point && parsed.sf.getLineAndCharacterOfPosition(body.getEnd()).line + 1 === endLine) candidates.push(body);
        parsed.ts.forEachChild(node, visit);
    }
    visit(parsed.sf);
    return candidates.sort((a, b) => a.getWidth(parsed.sf) - b.getWidth(parsed.sf))[0] ?? null;
}
/**
 * Resolves an open-ended function end against the parser. The anchor is `loc.start` — istanbul's `loc` for a
 * function is its BODY, so that point always lies inside the function node — with `decl.start` as the fallback:
 * for an anonymous function the converter's `decl` is a one-character window at the generated start, and after
 * source mapping it can land on the enclosing call (`.some((name) => …` mapped `decl` onto `some`), outside
 * the arrow; anchoring there left 524 of this repository's 1994 files unresolvable (2026-09-29).
 */
function recoverEnd(parsed: ParsedTsSource, raw: unknown): { line: number; character: number } {
    const fn = record(raw, "function"), decl = coverageFunctionSpan(fn.decl), location = coverageFunctionSpan(fn.loc);
    const anchors = [location, decl].map(span => parsed.sf.getPositionOfLineAndCharacter(span.line - 1, span.column));
    for (const point of anchors) {
        const body = bodyAt(parsed, point, location.endLine);
        if (body) return parsed.sf.getLineAndCharacterOfPosition(body.getEnd());
    }
    throw new Error("Cannot resolve open-ended coverage function against current parser span");
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
