import { dirname, isAbsolute, posix } from "node:path";
import { loadCheckTypescript } from "../checks/check-typescript.js";
import type { SentenceCitation, SpecSentence } from "./sentences.js";

export interface CitationSource { file: string; content: string; }
const ID_TOKEN = /(?<![\w-])(?:sentence-[a-f0-9]{16}-\d+|(?:[A-Z][A-Z0-9]*-)+\d{1,4}|(?:REQ|INV|R|B)\d{1,3})(?![\w-])/g;
const LOCAL_REF = /(?<![\w:/.-])((?:\.{1,2}\/)?(?:[\w.@-]+\/)*[\w.-]+\.md)(?:#([\w.%~-]+))?/g;

function citationLines(source: CitationSource): { line: number; text: string; kind: SentenceCitation["kind"] }[] {
    if (/(?:^|\/)(?:__tests__|tests?|testdata)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(source.file)) {
        return source.content.split(/\r?\n/).map((text, i) => ({ line: i + 1, text, kind: "test" }));
    }
    if (source.file.endsWith(".md")) {
        return markdownCitationLines(source);
    }
    const ts = loadCheckTypescript("spec_sentences", "source-comment citations");
    if (!ts) throw new Error("TypeScript unavailable for source-comment citations");
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.content);
    const starts = [0];
    for (const match of source.content.matchAll(/\n/g)) starts.push(match.index + 1);
    const lineAt = (offset: number): number => {
        let low = 0, high = starts.length;
        while (low + 1 < high) { const mid = (low + high) >>> 1; if (starts[mid]! <= offset) low = mid; else high = mid; }
        return low + 1;
    };
    const rows: ReturnType<typeof citationLines> = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
        const at = lineAt(scanner.getTokenPos());
        for (const [index, text] of scanner.getTokenText().split(/\r?\n/).entries()) {
            const kind = /\bfixes\b/i.test(text) ? "plan_reference" : at <= 40 || /\bcheck[-_ ](?:id|contract|header)\b/i.test(text) ? "check_header" : "doc_comment";
            rows.push({ line: at + index, text, kind });
        }
    }
    return rows;
}

function markdownCitationLines(source: CitationSource) {
    let fence: string | undefined;
    return source.content.split(/\r?\n/).flatMap((text, i) => {
        const delimiter = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
        if (delimiter) { if (!fence) fence = delimiter; else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined; return []; }
        if (fence || !/\b(?:fixes|plan|see|reference|spec)\b/i.test(text)) return [];
        return [{ line: i + 1, text, kind: "plan_reference" as const }];
    });
}

/** Exact lexical links. A section citation is context, never an executable test claim. */
export function attachSentenceCitations(rows: SpecSentence[], sources: Iterable<CitationSource>): { file: string; reason: string }[] {
    const unavailable: { file: string; reason: string }[] = [];
    const byId = new Map<string, SpecSentence[]>(), byDoc = new Map<string, SpecSentence[]>();
    for (const row of rows) {
        for (const id of [row.id, ...row.definitionIds]) byId.set(id, [...byId.get(id) ?? [], row]);
        const docRows = byDoc.get(row.doc) ?? []; docRows.push(row); byDoc.set(row.doc, docRows);
    }
    const seen = new Map<SpecSentence, Set<string>>();
    const add = (target: SpecSentence, citation: SentenceCitation): void => {
        if (target.doc === citation.file) return;
        const keys = seen.get(target) ?? new Set<string>();
        const key = JSON.stringify(citation);
        if (!keys.has(key)) { target.citations.push(citation); keys.add(key); seen.set(target, keys); }
    };
    for (const source of sources) {
        let lines: ReturnType<typeof citationLines>;
        try { lines = citationLines(source); }
        catch (error) { unavailable.push({ file: source.file, reason: error instanceof Error ? error.message : "Citation scanner unavailable" }); continue; }
        for (const line of lines) {
            attachCitationLine(source, line, byId, byDoc, add);
        }
    }
    return unavailable;
}

type CitationLine = ReturnType<typeof citationLines>[number];
type AddCitation = (target: SpecSentence, citation: SentenceCitation) => void;

function attachCitationLine(source: CitationSource, line: CitationLine, byId: Map<string, SpecSentence[]>, byDoc: Map<string, SpecSentence[]>, add: AddCitation): void {
    const text = line.text.replace(/https?:\/\/[^\s)<>]+/g, value => " ".repeat(value.length));
    const links = [...text.matchAll(LOCAL_REF)].map(match => ({
        match, paths: localPaths(source.file, match[1]!).filter(path => byDoc.has(path)),
    }));
    const qualifiedDocs = new Set(links.flatMap(link => link.paths));
    for (const match of text.matchAll(ID_TOKEN)) {
        const id = match[0], definitions = byId.get(id);
        // Compact IDs have document-local meaning even when this subset contains just one definition.
        const targets = /^(?:REQ|INV|R|B)\d+$/.test(id) ? definitions?.filter(row => qualifiedDocs.has(row.doc)) : definitions;
        if (targets?.length === 1) add(targets[0]!, { file: source.file, line: line.line, kind: line.kind, scope: "sentence", reference: id });
    }
    for (const { match, paths } of links) {
        const doc = paths.find(path => !path.startsWith("../"));
        if (!doc || isAbsolute(match[1]!)) continue;
        attachDocumentReference(byDoc.get(doc)!, match, /\b(?:fixes|plan)\b/i.test(text), { file: source.file, line: line.line, kind: line.kind }, add);
    }
}

function localPaths(sourceFile: string, path: string): string[] {
    return [posix.normalize(posix.join(dirname(sourceFile), path)), posix.normalize(path)];
}

function attachDocumentReference(rows: SpecSentence[], link: RegExpMatchArray, wholeDocument: boolean,
    location: Pick<SentenceCitation, "file" | "line" | "kind">, add: AddCitation): void {
    let anchor: string | undefined;
    try { anchor = link[2] ? decodeURIComponent(link[2]) : undefined; } catch { return; }
    if (!anchor && !wholeDocument) return;
    for (const row of rows) {
        const scope = referenceScope(row, anchor);
        if (scope) add(row, { ...location, scope, reference: link[0] });
    }
}

function referenceScope(row: SpecSentence, anchor: string | undefined): SentenceCitation["scope"] | undefined {
    if (!anchor) return "document";
    if (row.id === anchor || row.sentenceAnchors.includes(anchor)) return "sentence";
    if (row.anchors.includes(anchor)) return "section";
    return undefined;
}
