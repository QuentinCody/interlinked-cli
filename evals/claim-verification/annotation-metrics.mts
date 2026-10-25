import { createHash } from "node:crypto";
import { legacyCandidates } from "./extractors.mjs";

export type Span = [number, number];
export type SupportLabel = "supported" | "contradicted" | "unsupported" | "not_assessable";
export interface AnnotatedClaim {
    id: string; spans: Span[]; kind: string; polarity: string; scope: string; interpretation: string;
    qualifiers: Array<{ spans: Span[]; relation: string }>;
    labels: { operational: SupportLabel; curated: SupportLabel };
    evidenceIds: { operational: string[]; curated: string[] };
    rationale: { operational: string; curated: string }; confidence: string;
}
export interface Annotation {
    id: string; sourceSha256: string; annotator: string; schemaVersion: number; annotationComplete: boolean;
    claims: AnnotatedClaim[]; nonClaims: Array<{ spans: Span[]; reason: string }>; unresolved: unknown[];
}
export interface LocatedCandidate { text: string; spans: Span[] }
const LABELS = new Set(["supported", "contradicted", "unsupported", "not_assessable"]);

export function validateAnnotation(annotation: Annotation, source: string, receiptIds: Set<string>, operationalCount: number, operationalIds = new Set<string>()): void {
    if (createHash("sha256").update(source).digest("hex") !== annotation.sourceSha256) throw new Error("Annotation source hash mismatch");
    if (!annotation.annotationComplete || annotation.schemaVersion !== 1 || !annotation.annotator) throw new Error("Incomplete annotation");
    const validateSpans = (spans: Span[]) => {
        if (!Array.isArray(spans) || !spans.length || spans.some(([s, e]) => !Number.isInteger(s) || !Number.isInteger(e)
            || s < 0 || e <= s || e > source.length)) throw new Error("Invalid annotation span");
    };
    const ids = new Set<string>();
    for (const claim of annotation.claims) {
        if (!claim.id || ids.has(claim.id)) throw new Error("Duplicate claim ID");
        ids.add(claim.id); validateSpans(claim.spans);
        for (const qualifier of claim.qualifiers) validateSpans(qualifier.spans);
        for (const snapshot of ["operational", "curated"] as const) {
            if (!LABELS.has(claim.labels[snapshot])) throw new Error("Unknown support label");
            for (const id of claim.evidenceIds[snapshot]) {
                const position = /^operational:(\d+)$/.exec(id);
                const positionIndex = position ? Number(position[1]) : Number.NaN;
                const validPosition = snapshot === "operational" && Number.isSafeInteger(positionIndex) && positionIndex < operationalCount;
                const known = snapshot === "operational" ? operationalIds.has(id) : receiptIds.has(id);
                if (!validPosition && !known) throw new Error(`Unknown receipt in ${snapshot}: ${id}`);
            }
            if (claim.labels[snapshot] === "supported" && !claim.evidenceIds[snapshot].length) throw new Error("Supported claim needs receipt identity");
        }
    }
    for (const row of annotation.nonClaims) validateSpans(row.spans);
}

/** Replay only the baseline's text transforms, carrying source character provenance. */
export function locatedLegacy(source: string): LocatedCandidate[] {
    let chars = source.split("").map((char, index) => ({ char, index }));
    const replace = (pattern: RegExp, replacement: string) => {
        const text = chars.map(c => c.char).join("");
        const next: typeof chars = []; let cursor = 0;
        for (const match of text.matchAll(pattern)) {
            next.push(...chars.slice(cursor, match.index));
            if (replacement) next.push({ char: replacement, index: -1 });
            cursor = match.index + match[0].length;
        }
        next.push(...chars.slice(cursor)); chars = next;
    };
    replace(/```[\s\S]*?```/g, " "); replace(/\|[^\n]*\|/g, " ");
    replace(/[*_`#>]/g, ""); replace(/\s+/g, " ");
    const cleaned = chars.map(c => c.char).join("");
    const candidates: LocatedCandidate[] = []; let cursor = 0;
    for (const raw of cleaned.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
        const start = cleaned.indexOf(raw, cursor); cursor = start + raw.length;
        const text = raw.trim();
        if (text.split(" ").length < 6 || text.endsWith("?")) continue;
        const offset = start + raw.length - raw.trimStart().length;
        const spans: Span[] = [];
        for (const char of chars.slice(offset, offset + text.length)) {
            if (char.index < 0) continue;
            const last = spans.at(-1);
            if (last && last[1] === char.index) last[1]++;
            else spans.push([char.index, char.index + 1]);
        }
        candidates.push({ text, spans });
        if (candidates.length === 12) break;
    }
    if (JSON.stringify(candidates.map(c => c.text)) !== JSON.stringify(legacyCandidates(source).map(c => c.text))) throw new Error("Baseline provenance diverged");
    return candidates;
}

function positions(source: string, spans: Span[]): Set<number> {
    const result = new Set<number>();
    for (const [start, end] of spans) for (let i = start; i < end; i++) {
        if (!/[\s*_`#>|]/.test(source[i]!)) result.add(i);
    }
    return result;
}
const contains = (outer: Set<number>, inner: Set<number>) => inner.size > 0 && [...inner].every(i => outer.has(i));

interface RetentionTotals {
    coreRetained: number; completeRetained: number;
    qualifiers: number; qualifiersRetained: number; qualifiersAttached: number; qualifiersMisattached: number;
    polarityEligible: number; polarityPreserved: number; scopeEligible: number; scopePreserved: number;
}

function retainClaim(source: string, claim: AnnotatedClaim, index: number, cores: Set<number>[], candidateSets: Set<number>[], totals: RetentionTotals) {
    const core = cores[index]!;
    const matched = candidateSets.filter(c => contains(c, core));
    if (matched.length) totals.coreRetained++;
    const whole = positions(source, [...claim.spans, ...claim.qualifiers.flatMap(q => q.spans)]);
    const complete = matched.some(c => contains(c, whole));
    if (complete) totals.completeRetained++;
    for (const q of claim.qualifiers) {
        const needed = positions(source, q.spans); totals.qualifiers++;
        if (candidateSets.some(c => contains(c, needed))) totals.qualifiersRetained++;
        if (matched.some(c => contains(c, needed))) totals.qualifiersAttached++;
        if (candidateSets.some(c => contains(c, needed) && !contains(c, core)
            && cores.some((other, j) => j !== index && contains(c, other)))) totals.qualifiersMisattached++;
    }
    const preservation = (relations: Set<string>) => {
        const qualifiers = claim.qualifiers.filter(q => relations.has(q.relation));
        return { eligible: qualifiers.length > 0, preserved: matched.some(c => qualifiers.every(q => contains(c, positions(source, q.spans)))) };
    };
    const polarity = preservation(new Set(["negation"]));
    const scope = preservation(new Set(["scope", "condition", "exception"]));
    if (polarity.eligible) { totals.polarityEligible++; if (polarity.preserved) totals.polarityPreserved++; }
    if (scope.eligible) { totals.scopeEligible++; if (scope.preserved) totals.scopePreserved++; }
    return { id: claim.id, coreRetained: matched.length > 0, completeRetained: complete, polarity, scope };
}

/** Source-character overlap and co-location against model references; not semantic correctness. */
export function extractionMetrics(source: string, annotation: Annotation, candidates: LocatedCandidate[]) {
    const candidateSets = candidates.map(c => positions(source, c.spans));
    const cores = annotation.claims.map(c => positions(source, c.spans));
    const allReference = positions(source, annotation.claims.flatMap(c => [...c.spans, ...c.qualifiers.flatMap(q => q.spans)]));
    const totals = { claims: annotation.claims.length, candidates: candidates.length, coreRetained: 0, completeRetained: 0,
        qualifiers: 0, qualifiersRetained: 0, qualifiersAttached: 0, qualifiersMisattached: 0,
        polarityEligible: 0, polarityPreserved: 0, scopeEligible: 0, scopePreserved: 0, precisionChars: 0, candidateChars: 0 };
    for (const candidate of candidateSets) {
        totals.candidateChars += candidate.size;
        totals.precisionChars += [...candidate].filter(i => allReference.has(i)).length;
    }
    const details = annotation.claims.map((claim, index) => retainClaim(source, claim, index, cores, candidateSets, totals));
    return { ...totals, details };
}
