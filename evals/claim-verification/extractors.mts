import { splitClaims } from "../../src/harness/jev/claim-evidence.js";

export interface Candidate {
    text: string;
    span: [number, number] | null;
    kind: "sentence" | "table" | "legacy";
}

/** Import the production baseline unchanged; it does not provide offsets. */
export function legacyCandidates(source: string): Candidate[] {
    return splitClaims(source).map(text => ({ text, span: null, kind: "legacy" }));
}

/** Over-inclusive candidates, not a claim classifier. Offsets are UTF-16, end-exclusive. */
export function spanCandidates(source: string): Candidate[] {
    const candidates: Candidate[] = [];
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    let fenced = false;
    const lines = [...source.matchAll(/[^\r\n]+/g)];
    for (const [index, line] of lines.entries()) {
        if (/^\s*(```|~~~)/.test(line[0])) { fenced = !fenced; continue; }
        if (fenced || /^\s*#{1,6}\s/.test(line[0]) || /^\s*\|?[\s:|-]+\|\s*$/.test(line[0])) continue;
        if (line[0].includes("|") && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[index + 1]?.[0] ?? "") && lines[index + 2]?.[0].includes("|")) continue;
        const prefix = /^\s*(?:(?:[-*+] |\d+[.)] |> )\s*)?/.exec(line[0])?.[0].length ?? 0;
        const text = line[0].slice(prefix).trimEnd();
        if (!text) continue;
        const kind = text.includes("|") ? "table" : "sentence";
        const segments = kind === "table" ? [{ segment: text, index: 0 }] : [...segmenter.segment(text)];
        for (const segment of segments) {
            const leading = segment.segment.length - segment.segment.trimStart().length;
            const value = segment.segment.trim();
            if (!value || !/[\p{L}\p{N}]/u.test(value)) continue;
            const start = line.index + prefix + segment.index + leading;
            candidates.push({ text: value, span: [start, start + value.length], kind });
        }
    }
    return candidates;
}

export function normalize(text: string): string {
    return text.normalize("NFC").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
}

export function spanValid(source: string, candidate: Candidate): boolean {
    if (!candidate.span) return false;
    const [start, end] = candidate.span;
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
        && end <= source.length && source.slice(start, end) === candidate.text;
}

/** Text retention is not semantic claim recall; a broad candidate can retain several clauses. */
export function retains(candidates: Candidate[], required: string[]): boolean {
    return required.every(part => candidates.some(candidate => normalize(candidate.text).includes(normalize(part))));
}
