import { codeSpanIntervals } from "./extract-refs-masking.js";

// Explicit example/evidence fields describe input to a checker, not assertions
// about the containing project. This is content-based and applies in any repo.
const EXAMPLE_FIELD = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?(?:evidence|examples?|counterexamples?|(?:breaking |sample |test )?inputs?|(?:expected |actual )?outputs?|reproduction|repro)(?::(?:\*\*|__)?|(?:\*\*|__):)(?:[ \t]|$)/i;
const QUOTE_CLOSERS = new Map([["\"", "\""], ["“", "”"], ["‘", "’"]]);

/** Paired prose quotations, in source columns. One scan; unmatched openers
 * stay literal. Backslash-escaped delimiters cannot open or close a quote. */
export function factQuoteIntervals(line: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let start = -1;
    let closer: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const char = line.charAt(i);
        if (char === "\\") { i++; continue; }
        if (closer === undefined) {
            closer = QUOTE_CLOSERS.get(char);
            start = i;
        } else if (char === closer) {
            spans.push([start, i + 1]);
            closer = undefined;
        }
    }
    return spans;
}

/** Blank labeled examples and their indented continuations; preserve line numbers. */
export function maskExampleFields(lines: string[]): string[] {
    let indent: number | null = null;
    return lines.map((line) => {
        const leading = line.length - line.trimStart().length;
        if (EXAMPLE_FIELD.test(line)) {
            indent = leading;
            return " ".repeat(line.length);
        }
        if (indent !== null && (!line.trim() || leading > indent)) return " ".repeat(line.length);
        indent = null;
        return line;
    });
}

/** Whole code examples cannot assert counts or define IDs. Single formatted
 * tokens remain visible, so `B1`, `six` bets and endpoint-formatted ranges work. */
export function maskQuotedFactText(line: string): string {
    const chars = line.split("");
    for (const [start, end, contentStart, contentEnd] of codeSpanIntervals(line)) {
        const content = line.slice(contentStart, contentEnd);
        if (/^[\p{L}\p{N}_-]+$/u.test(content)) continue;
        chars.fill(" ", start, end);
    }
    const text = chars.join("");
    // Double/curly quoted phrases are mentions. Apostrophes in ordinary words
    // are intentionally untouched. Negated and otherwise ambiguous prose is
    // still heuristic; it never qualifies for the Stop nudge.
    for (const [start, end] of factQuoteIntervals(text)) chars.fill(" ", start, end);
    return chars.join("");
}
