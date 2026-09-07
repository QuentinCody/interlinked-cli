// CLASS: disabled assertions leave an intended test claim unexecuted.
// FIRES WHEN: a real line/block comment inside an active test starts a line
// with expect(...).matcher(...) (optionally await or return). Reports comment line.
// DOES NOT FIRE: prose mentioning expect, strings/templates/regex fixtures,
// comments outside tests, incomplete expect calls, or skipped/conditional suites.
// CALIBRATION (2026-09-07; no independent precision measurement):
// | pass | hits/files | corpus and correction |
// | prototype | 6/4 | earlier regex scope; all hits were detector strings (FPs) |
// | AST | 0/0 | 2145 tracked tests; actual comment ranges only |
// No-hit precision is unmeasured; positive/negative companions cover the grammar.
// KNOWN GAPS: aliased expect/assert, multiline matcher chains, and nested commented
// blocks are not recognized. A documented example inside a test may still warn.
// HOW TO EXTEND: widen the anchored comment-line grammar with P/N fixtures;
// retain AST comment ranges so code-as-string examples never become findings.
import type * as TS from "typescript";
import type { ParsedTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";
import { parseTestQuality, qualityBlocks } from "./test-quality-ast.js";

const ASSERTION_LINE = /^\s*(?:\/\/|\/\*|\*)?\s*(?:(?:await|return)\s+)?expect\s*\(.+\)\s*\.(?:(?:not|resolves|rejects)\s*\.)?\s*\w+\s*\(/;

function commentRanges({ ts, sf }: ParsedTsSource, content: string): Map<number, number> {
    const comments = new Map<number, number>();
    const visit = (node: TS.Node): void => {
        const ranges = [...(ts.getLeadingCommentRanges(content, node.pos) ?? []), ...(ts.getTrailingCommentRanges(content, node.end) ?? [])];
        for (const range of ranges) comments.set(range.pos, range.end);
        // Include punctuation tokens: an otherwise empty callback's comments
        // are leading trivia on its closing brace, which forEachChild omits.
        for (const child of node.getChildren(sf)) visit(child);
    };
    visit(sf);
    return comments;
}

/** Report actual commented assertion lines inside active test callbacks. */
export function checkCommentedOutAssertion(content: string, filePath: string): InlineMatch[] {
    const parsed = parseTestQuality(content, filePath);
    if (!parsed) return [];
    const { sf } = parsed;
    const tests = qualityBlocks(parsed).filter((block) => block.kind === "test");
    const comments = commentRanges(parsed, content);
    const findings = new Map<number, InlineMatch>();
    for (const [start, end] of comments) {
        if (!tests.some((block) => start > block.body.getStart(sf) && end < block.body.end)) continue;
        const firstLine = sf.getLineAndCharacterOfPosition(start).line + 1;
        content.slice(start, end).split(/\r?\n/).forEach((line, index) => {
            if (!ASSERTION_LINE.test(line)) return;
            const lineNumber = firstLine + index;
            findings.set(lineNumber, { line: lineNumber, text: "commented_out_assertion: this assertion is commented out and cannot fail. Restore the intended check, or remove the obsolete assertion and explain the current contract." });
        });
    }
    return [...findings.values()].sort((a, b) => a.line - b.line).slice(0, 10);
}
