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

function attachCitationLine(source: CitationSource, line: ReturnType<typeof citationLines>[number], byId: Map<string, SpecSentence[]>, byDoc: Map<string, SpecSentence[]>, add: (target: SpecSentence, citation: SentenceCitation) => void): void {
    const text = line.text.replace(/https?:\/\/[^\s)<>]+/g, value => " ".repeat(value.length));
    for (const match of text.matchAll(ID_TOKEN)) {
        let targets = byId.get(match[0]);
        // Compact IDs recur across plans, sessions and test suites. A unique
        // definition in this subset does not establish a global namespace.
        if (/^(?:REQ|INV|R|B)\d+$/.test(match[0])) {
            const documents = referencedSentenceDocuments(text, source, byDoc);
            targets = targets?.filter(target => documents.has(target.doc));
        }
        if (targets?.length === 1) add(targets[0]!, { file: source.file, line: line.line, kind: line.kind, scope: "sentence", reference: match[0] });
    }
    for (const match of text.matchAll(LOCAL_REF)) {
        const path = match[1]!;
        if (isAbsolute(path)) continue;
        const candidates = [posix.normalize(posix.join(dirname(source.file), path)), posix.normalize(path)];
        const doc = candidates.find(candidate => !candidate.startsWith("../") && byDoc.has(candidate));
        if (!doc) continue;
        let anchor: string | undefined;
        try { anchor = match[2] ? decodeURIComponent(match[2]) : undefined; } catch { continue; }
        if (!anchor && !/\b(?:fixes|plan)\b/i.test(text)) continue;
        for (const row of byDoc.get(doc)!) {
            const direct = anchor && (row.id === anchor || row.sentenceAnchors.includes(anchor));
            if (anchor && !direct && !row.anchors.includes(anchor)) continue;
            add(row, { file: source.file, line: line.line, kind: line.kind,
                scope: direct ? "sentence" : anchor ? "section" : "document", reference: match[0] });
        }
    }
}

function referencedSentenceDocuments(text: string, source: CitationSource, byDoc: Map<string, SpecSentence[]>) {
    const documents = new Set<string>();
    for (const ref of text.matchAll(LOCAL_REF)) {
        for (const path of [posix.normalize(posix.join(dirname(source.file), ref[1]!)), posix.normalize(ref[1]!)]) {
            if (byDoc.has(path)) documents.add(path);
        }
    }
    return documents;
}
