// Syntax-only assertion detection. The ratchet remains a count of lines carrying
// unjustified casts, including when several assertions share the same line.
// Comment presence is advisory evidence, not a proof that an assertion is sound.
import type * as TS from "typescript";
import { safetyCommentLines, type CastCommentRange } from "./cast-justification-comments.js";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import { getExtension, JS_TS_EXTS, type InlineMatch, stripCommentsAndStrings, stripStrings } from "./shared.js";

/** Find one match per assertion-token line lacking a nonempty SAFETY: comment. */
export function findUnjustifiedCasts(content: string, filePath: string): InlineMatch[] {
    if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
    return scanUnjustifiedCasts(content, filePath);
}

/** Count lines, preserving the existing metric unit; pass the path for TSX. */
export function countUnjustifiedCasts(content: string, filePath = "source.ts"): number {
    return scanUnjustifiedCasts(content, filePath).length;
}

function scanUnjustifiedCasts(content: string, filePath: string): InlineMatch[] {
    try {
        const parsed = parseTsSource(content, filePath);
        if (parsed) {
            const matches = scanAssertions(parsed);
            if (!hasParseErrors(parsed.sf)) return matches;
            // Recovery still identifies completed assertions elsewhere in an
            // unfinished edit; retain those alongside the lexical measurement.
            const lines = new Set([...matches, ...scanLexically(content)].map((match) => match.line - 1));
            return lineMatches(content, lines);
        }
    } catch {
        // Preserve the previous lexical measurement if parsing is unavailable.
        return scanLexically(content);
    }
    return scanLexically(content);
}

function scanAssertions({ ts, sf }: ParsedTsSource): InlineMatch[] {
    const assertions: (TS.AsExpression | TS.TypeAssertion)[] = [];
    const comments = new Map<number, CastCommentRange>();
    const visit = (node: TS.Node): void => {
        for (const range of ts.getLeadingCommentRanges(sf.text, node.pos) ?? []) comments.set(range.pos, range);
        for (const range of ts.getTrailingCommentRanges(sf.text, node.end) ?? []) comments.set(range.pos, range);
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) assertions.push(node);
        ts.forEachChild(node, visit);
    };
    visit(sf);
    const justified = safetyCommentLines(sf.text, [...comments.values()]);
    const matches = new Set<number>();
    for (const assertion of assertions) {
        if (ts.isTypeReferenceNode(assertion.type) && assertion.type.typeName.getText(sf) === "const") continue;
        const token = assertion.getChildren(sf).find((child) => child.kind === ts.SyntaxKind.AsKeyword);
        const position = token?.getStart(sf) ?? assertion.getStart(sf);
        const line = sf.getLineAndCharacterOfPosition(position).line;
        if (justified(line) || justified(sf.getLineAndCharacterOfPosition(assertion.getStart(sf)).line)) continue;
        if (justified(ownerLine(assertion, { ts, sf }))) continue;
        matches.add(line);
    }
    return lineMatches(sf.text, matches);
}

function ownerLine(assertion: TS.Node, { ts, sf }: ParsedTsSource): number {
    let node = assertion;
    while (node.parent) {
        if (ts.isStatement(node) || ts.isPropertyDeclaration(node)) break;
        node = node.parent;
    }
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
}

/** Retain the old detection breadth when optional TypeScript is absent or syntax is incomplete. */
function scanLexically(content: string): InlineMatch[] {
    const ranges: CastCommentRange[] = [];
    for (const match of stripStrings(content).matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)) {
        ranges.push({ pos: match.index, end: match.index + match[0].length });
    }
    const justified = safetyCommentLines(content, ranges);
    const matches = new Set<number>();
    const lines = stripCommentsAndStrings(content).split("\n");
    const rawLines = content.split("\n");
    for (let line = 0; line < lines.length; line++) {
        const raw = rawLines[line] ?? "";
        if (/^\s*import\b/.test(raw) || /^\s*export\s*(?:type\s+)?\{/.test(raw)) continue;
        if (/^\s*export\b/.test(raw) && /\bfrom\s*['"]/.test(raw) && !raw.includes("=")) continue;
        if (/\bas\s+(?!const\b)[A-Za-z_$][\w$]*/.test(lines[line] ?? "") && !justified(line)) matches.add(line);
    }
    return lineMatches(content, matches);
}

function lineMatches(content: string, matches: ReadonlySet<number>): InlineMatch[] {
    const lines = content.split("\n");
    return [...matches].sort((a, b) => a - b).map((line) => ({ line: line + 1, text: (lines[line] ?? "").trim().slice(0, 150) }));
}
