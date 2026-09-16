import type * as TS from "typescript";
import { isImplementationFunction, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";

interface TokenLines { start: number; end: number; firstLine: number; lastLine: number; }
export interface SourceLines {
    tokens: TokenLines[];
    sloc: Set<number>;
    functions: Map<number, Set<number>>;
}

function addLines(lines: Set<number>, first: number, last: number): void {
    for (let line = first; line <= last; line++) lines.add(line);
}

function recordToken(node: TS.Node, owner: Set<number> | undefined, parsed: ParsedTsSource, result: SourceLines): void {
    if (node.kind > parsed.ts.SyntaxKind.LastToken || node.getWidth(parsed.sf) === 0) return;
    const start = node.getStart(parsed.sf), end = node.getEnd();
    const firstLine = parsed.sf.getLineAndCharacterOfPosition(start).line + 1;
    const lastLine = parsed.sf.getLineAndCharacterOfPosition(end - 1).line + 1;
    result.tokens.push({ start, end, firstLine, lastLine });
    addLines(result.sloc, firstLine, lastLine);
    if (owner) addLines(owner, firstLine, lastLine);
}

/** Parser-resolved token lines. A token belongs to its innermost implementation. */
export function collectSourceLines(parsed: ParsedTsSource, starts: number[]): SourceLines {
    const result: SourceLines = { tokens: [], sloc: new Set(), functions: new Map(starts.map(start => [start, new Set<number>()])) };
    function visit(node: TS.Node, enclosing?: Set<number>): void {
        if (node.kind === parsed.ts.SyntaxKind.JSDocComment) return;
        const owner = isImplementationFunction(parsed.ts, node) ? result.functions.get(node.getStart(parsed.sf)) : enclosing;
        const children = node.getChildren(parsed.sf);
        if (!children.length) recordToken(node, owner, parsed, result);
        else for (const child of children) visit(child, owner);
    }
    visit(parsed.sf);
    return result;
}

/** Intersect a half-open UTF-16 span with actual token lines; comments never expand coverage. */
export function linesInSpan(source: SourceLines, start: number, end: number): number[] {
    let low = 0, high = source.tokens.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (source.tokens[middle]!.start < start) low = middle + 1;
        else high = middle;
    }
    const lines = new Set<number>();
    for (let i = low; i < source.tokens.length; i++) {
        const token = source.tokens[i]!;
        if (token.start >= end) break;
        if (token.end <= end) addLines(lines, token.firstLine, token.lastLine);
    }
    return [...lines].sort((a, b) => a - b);
}

export function lineUnionCounts(pattern: Iterable<number>, clone: Iterable<number>): { pattern: number; clone: number; overlap: number; union: number } {
    const patterns = new Set(pattern), clones = new Set(clone);
    const overlap = [...patterns].filter(line => clones.has(line)).length;
    return { pattern: patterns.size, clone: clones.size, overlap, union: patterns.size + clones.size - overlap };
}
