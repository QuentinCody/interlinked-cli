import { createHash } from "node:crypto";
import { extractHeadings } from "./extract-refs.js";
import { maskCodeSpans } from "./extract-refs-masking.js";
import type { HeadingInfo } from "./types.js";

export const SENTENCE_GRAMMAR = "spec-sentences.v1";
export type SentenceClass = "requirement" | "rationale" | "example" | "note";
export interface SentenceCitation {
    file: string;
    line: number;
    kind: "test" | "check_header" | "doc_comment" | "plan_reference";
    scope: "sentence" | "section" | "document";
    reference: string;
}
export interface SpecSentence {
    doc: string;
    id: string;
    definitionIds: string[];
    anchors: string[];
    sentenceAnchors: string[];
    line: number;
    endLine: number;
    sentence: string;
    class: SentenceClass;
    citations: SentenceCitation[];
}
const MODAL = /\b(?:must|shall|should|can|could|may|might|will|would|cannot|needs? to|required to)\b/gi;
const NOUN = /\b(?:agent|artifact|baseline|batch|budget|cache|call|case|check|claim|client|command|config|configuration|context|contract|data|decision|dependency|document|entry|error|event|evidence|field|file|flag|function|graph|hash|hook|id|input|invariant|job|key|label|ledger|lease|limit|link|log|manifest|memory|message|model|module|node|output|packet|path|policy|process|prompt|record|registry|request|requirement|response|result|reviewer|row|rule|run|scope|section|server|session|signal|snapshot|source|state|status|string|table|target|test|timeout|token|tool|type|unit|value|version|warning|worker|code|json|stdout|stderr)s?\b/i;

/** Frozen lexical grammar, not a semantic requirement detector. */
export function classifySpecSentence(sentence: string, code = false): SentenceClass {
    if (code || /\be\.g\./i.test(sentence)) return "example";
    if (/\b(?:because|so that)\b/i.test(sentence)) return "rationale";
    for (const modal of sentence.matchAll(MODAL)) {
        if (NOUN.test(sentence.slice(modal.index + modal[0].length))) return "requirement";
    }
    return "note";
}

/** Preserve offsets while masking punctuation that is not a sentence boundary. */
function maskedPunctuation(text: string): string {
    const blank = (value: string): string => value.replace(/[^\n]/g, " ");
    return maskCodeSpans(text).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>+\s+)/gm, blank)
        .replace(/https?:\/\/[^\s)<>]+/g, blank)
        .replace(/\b(?:e\.g\.|i\.e\.|etc\.|Mr\.|Ms\.|Dr\.)/gi, blank)
        .replace(/(?<=\d)\.(?=\d)/g, " ");
}
export function sentenceSpans(text: string): { text: string; start: number; end: number }[] {
    const spans: { text: string; start: number; end: number }[] = [];
    const masked = maskedPunctuation(text);
    let start = 0;
    const push = (end: number): void => {
        const raw = text.slice(start, end), leading = raw.length - raw.trimStart().length;
        const value = raw.trim();
        if (value && !/^[\s|:—–-]+$/.test(value)) spans.push({ text: value.replace(/\s*\n\s*/g, " "), start: start + leading, end: end - (raw.length - raw.trimEnd().length) });
        start = end;
    };
    for (const match of masked.matchAll(/[.!?]["')\]]*(?=\s|$)/g)) push(match.index + match[0].length);
    push(text.length);
    return spans;
}

function definitionIds(text: string): string[] {
    const clean = text.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?/, "").replace(/^[*`\[\s]+/, "");
    const id = /^((?:[A-Z][A-Z0-9]*-)+\d{1,4}|(?:REQ|INV|R|B)\d{1,3})(?![\w-])/.exec(clean)?.[1];
    return id ? [id] : [];
}

type SentenceLine =
    | { kind: "heading"; heading: HeadingInfo }
    | { kind: "boundary" }
    | { kind: "anchor"; anchor: string }
    | { kind: "text"; line: string; number: number; code: boolean; startsBlock: boolean };

function classifySentenceText(line: string, number: number, code: boolean): SentenceLine {
    if (code) return { kind: "text", line, number, code, startsBlock: false };
    const anchor = /^\s*<a\s+(?:id|name)=["']([\w.-]+)["'][^>]*>\s*(?:<\/a>)?\s*$/.exec(line)?.[1];
    if (anchor) return { kind: "anchor", anchor };
    if (!line.trim() || /^\s*(?:\|?[\s:|-]+\||[-*_]{3,})\s*$/.test(line)) return { kind: "boundary" };
    const startsBlock = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)/.test(line);
    return { kind: "text", line, number, code, startsBlock };
}

function* sentenceLines(text: string): Generator<SentenceLine> {
    const lines = text.split(/\r?\n/), codeLines = new Set<number>();
    const { headings, headingLines } = classifyMarkdownLines(lines, codeLines);
    const headingAt = new Map(headings.map(heading => [heading.line, heading]));
    let comment = false;
    for (const [index, line] of lines.entries()) {
        const number = index + 1, heading = headingAt.get(number);
        if (heading) yield { kind: "heading", heading };
        if (headingLines.has(number)) continue;
        const code = codeLines.has(number);
        if (!code && (comment || /^\s*<!--/.test(line))) {
            comment = !line.includes("-->");
            yield { kind: "boundary" };
            continue;
        }
        yield classifySentenceText(line, number, code);
    }
}

export function parseSpecSentences(doc: string, text: string): SpecSentence[] {
    const rows: SpecSentence[] = [], counts = new Map<string, number>();
    const stack: HeadingInfo[] = [];
    let block: string[] = [], startLine = 0, isCode = false, pendingAnchor: string | undefined;
    const flush = (): void => {
        if (!block.length) return;
        rows.push(...sentenceBlockRows(doc, { lines: block, line: startLine, code: isCode, anchor: pendingAnchor }, stack, counts));
        block = []; pendingAnchor = undefined;
    };
    for (const entry of sentenceLines(text)) {
        if (entry.kind !== "text") {
            flush();
            if (entry.kind === "heading") {
                while (stack.length && stack[stack.length - 1]!.level >= entry.heading.level) stack.pop();
                stack.push(entry.heading);
            } else if (entry.kind === "anchor") {
                pendingAnchor = entry.anchor;
            }
            continue;
        }
        if (block.length && (entry.code !== isCode || entry.startsBlock)) flush();
        if (!block.length) { startLine = entry.number; isCode = entry.code; }
        block.push(entry.line);
    }
    flush();
    return rows;
}

function nextMarkdownFence(fence: string | undefined, delimiter: string, line: string): string | undefined {
    if (!fence) return delimiter;
    const closes = delimiter[0] === fence[0] && delimiter.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line);
    return closes ? undefined : fence;
}

function markMarkdownCode(lines: string[], codeLines: Set<number>) {
    let fence: string | undefined, listIndent: number | undefined;
    let paragraph = false;
    for (const [index, line] of lines.entries()) {
        const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence || delimiter) codeLines.add(index + 1);
        if (delimiter) fence = nextMarkdownFence(fence, delimiter, line);
        const indentation = markdownListIndentation(line, listIndent, codeLines.has(index + 1));
        listIndent = indentation.listIndent;
        // CommonMark indented code cannot interrupt an existing paragraph.
        // An indented continuation of a list item is still prose, not a fence.
        if (!paragraph && indentation.indentedCode) codeLines.add(index + 1);
        paragraph = !!line.trim() && !codeLines.has(index + 1) && !/^ {0,3}#/.test(line);
    }
}

function markdownListIndentation(line: string, listIndent: number | undefined, fenced: boolean) {
    const indent = /^\s*/.exec(line)?.[0].replaceAll("\t", "    ").length ?? 0;
    const list = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (list && !fenced) listIndent = list[0].length;
    else if (line.trim() && listIndent !== undefined && indent < listIndent) listIndent = undefined;
    const indentedCode = !list && Boolean(line.trim()) && indent >= (listIndent ?? 0) + 4;
    return { listIndent, indentedCode };
}

function classifyMarkdownLines(lines: string[], codeLines: Set<number>) {
    markMarkdownCode(lines, codeLines);
    const headings = extractHeadings(lines, codeLines), headingLines = new Set<number>();
    for (const heading of headings) {
        headingLines.add(heading.line);
        if (!/^ {0,3}#/.test(lines[heading.line - 1] ?? "")) {
            for (let i = heading.line; i < lines.length; i++) {
                headingLines.add(i + 1);
                if (/^ {0,3}(?:=+|-+)\s*$/.test(lines[i] ?? "")) break;
            }
        }
    }
    return { headings, headingLines };
}

function sentenceBlockRows(doc: string, block: { lines: string[]; line: number; code: boolean; anchor: string | undefined }, stack: ReturnType<typeof extractHeadings>, counts: Map<string, number>): SpecSentence[] {
    const rows: SpecSentence[] = [];
    const raw = block.lines.join("\n");
    const spans = block.code ? [{ text: raw, start: 0, end: raw.length }] : sentenceSpans(raw);
    for (const [index, span] of spans.entries()) {
        const digest = createHash("sha256").update(`${doc}\0${span.text}`).digest("hex").slice(0, 16);
        const occurrence = counts.get(digest) ?? 0; counts.set(digest, occurrence + 1);
        const anchor = /\{#([\w.-]+)\}\s*$/.exec(span.text)?.[1];
        rows.push({ doc, id: `sentence-${digest}-${occurrence}`, definitionIds: block.code ? [] : definitionIds(span.text),
            anchors: stack.map(heading => heading.slug), sentenceAnchors: block.code ? [] : [anchor, index === 0 ? block.anchor : undefined].filter((v): v is string => !!v),
            line: block.line + raw.slice(0, span.start).split("\n").length - 1,
            endLine: block.line + raw.slice(0, span.end).split("\n").length - 1,
            sentence: span.text, class: classifySpecSentence(span.text, block.code), citations: [] });
    }
    return rows;
}
