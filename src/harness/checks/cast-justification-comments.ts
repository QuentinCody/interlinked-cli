import type { CommentRange } from "typescript";

/** Comment positions, obtained from parsed nodes or the degraded lexical scan. */
export type CastCommentRange = Pick<CommentRange, "pos" | "end">;

/** Match actual comment text; punctuation or a bare marker supplies no invariant. */
function hasExplanation(text: string): boolean {
    return /\bSAFETY:\s*[\s\S]*[\p{L}\p{N}]/u.test(text);
}

/** Index comments once, retaining the existing two-line contiguous lookback. */
export function safetyCommentLines(content: string, ranges: readonly CastCommentRange[]) {
    const lines = content.split("\n");
    const remainingCode = [...lines];
    const commentLines = new Set<number>();
    const justifiedLines = new Set<number>();
    const starts = [0];
    for (let index = 0; index < lines.length - 1; index++) {
        starts.push((starts[index] ?? 0) + (lines[index]?.length ?? 0) + 1);
    }
    for (const range of ranges) {
        const startLine = lineAt(starts, range.pos);
        const endLine = lineAt(starts, Math.max(range.pos, range.end - 1));
        const body = content.slice(range.pos + 2, range.end).replace(/\*\/$/, "");
        const parts = body.split("\n");
        for (let line = startLine; line <= endLine; line++) {
            const start = Math.max(0, range.pos - (starts[line] ?? 0));
            const end = Math.min(lines[line]?.length ?? 0, range.end - (starts[line] ?? 0));
            const code = remainingCode[line] ?? "";
            remainingCode[line] = code.slice(0, start) + " ".repeat(end - start) + code.slice(end);
            commentLines.add(line);
            const comment = parts.slice(line - startLine).join("\n");
            if (/\bSAFETY:/.test(parts[line - startLine] ?? "") && hasExplanation(comment)) {
                justifiedLines.add(line);
            }
        }
    }
    return (line: number): boolean => {
        if (justifiedLines.has(line)) return true;
        for (let prior = line - 1; prior >= Math.max(0, line - 2); prior--) {
            if (!commentLines.has(prior) || remainingCode[prior]?.trim()) break;
            if (justifiedLines.has(prior)) return true;
        }
        return false;
    };
}

function lineAt(starts: readonly number[], position: number): number {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        if ((starts[mid] ?? 0) <= position) low = mid;
        else high = mid;
    }
    return low;
}
