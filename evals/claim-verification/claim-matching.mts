import type { AnnotatedClaim, Annotation, LocatedCandidate, Span } from "./annotation-metrics.mjs";

interface Match { reference: number; candidate: number; weight: number }

interface AssignmentState { u: number[]; v: number[]; p: number[]; way: number[] }

function augmentAssignment(weights: number[][], minimum: number, row: number, { u, v, p, way }: AssignmentState): void {
    const m = p.length - 1;
    p[0] = row; let column = 0;
    const best = Array<number>(m + 1).fill(Infinity), used = Array<boolean>(m + 1).fill(false);
    do {
        used[column] = true; const active = p[column]!; let delta = Infinity, next = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
            const weight = weights[active - 1]![j - 1] ?? 0;
            const cost = -(weight >= minimum ? weight : 0) - u[active]! - v[j]!;
            if (cost < best[j]!) { best[j] = cost; way[j] = column; }
            if (best[j]! < delta) { delta = best[j]!; next = j; }
        }
        for (let j = 0; j <= m; j++) {
            if (used[j]) { u[p[j]!] = u[p[j]!]! + delta; v[j] = v[j]! - delta; }
            else best[j] = best[j]! - delta;
        }
        column = next;
    } while (p[column] !== 0);
    do { const previous = way[column]!; p[column] = p[previous]!; column = previous; } while (column !== 0);
}

/** Rectangular Hungarian assignment with a zero-weight unmatched option per reference. */
export function maximumWeightMatching(weights: number[][], minimum = 0.5): Match[] {
    const n = weights.length, columns = weights[0]?.length ?? 0, m = columns + n;
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error("Invalid overlap threshold");
    if (weights.some(row => row.length !== columns)) throw new Error("Weights must be rectangular");
    if (weights.some(row => row.some(w => !Number.isFinite(w) || w < 0 || w > 1))) throw new Error("Invalid overlap weight");
    if (!n || !columns) return [];
    const u = Array<number>(n + 1).fill(0), v = Array<number>(m + 1).fill(0);
    const p = Array<number>(m + 1).fill(0), way = Array<number>(m + 1).fill(0);
    for (let row = 1; row <= n; row++) augmentAssignment(weights, minimum, row, { u, v, p, way });
    const result: Match[] = [];
    for (let j = 1; j <= columns; j++) {
        const reference = p[j]! - 1;
        const weight = reference >= 0 ? weights[reference]![j - 1]! : 0;
        if (weight > 0 && weight >= minimum) result.push({ reference, candidate: j - 1, weight });
    }
    return result.sort((a, b) => a.reference - b.reference);
}

function positions(source: string, spans: Span[]): Set<number> {
    const result = new Set<number>();
    for (const [start, end] of spans) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) throw new Error("Invalid source span");
        for (let i = start; i < end; i++) if (!/[\s*_`#>|]/.test(source[i]!)) result.add(i);
    }
    return result;
}
const overlap = (a: Set<number>, b: Set<number>) => [...a].filter(i => b.has(i)).length;
const contains = (a: Set<number>, b: Set<number>) => b.size > 0 && overlap(a, b) === b.size;

interface QualifierTotals {
    qualifiers: number; qualifiersAttached: number;
    polarityEligible: number; polarityPreserved: number; scopeEligible: number; scopePreserved: number;
}

function countMatchedQualifiers(source: string, claim: AnnotatedClaim, candidate: Set<number>, core: boolean, totals: QualifierTotals): void {
    for (const q of claim.qualifiers) { totals.qualifiers++; if (core && contains(candidate, positions(source, q.spans))) totals.qualifiersAttached++; }
    for (const [name, relations] of [["polarity", ["negation"]], ["scope", ["scope", "condition", "exception"]]] as const) {
        const qualifiers = claim.qualifiers.filter(q => relations.some(r => r === q.relation));
        if (!qualifiers.length) continue;
        totals[`${name}Eligible`]++;
        if (core && qualifiers.every(q => contains(candidate, positions(source, q.spans)))) totals[`${name}Preserved`]++;
    }
}

/** One-to-one, qualifier-inclusive source matching; neither semantic equivalence nor support accuracy. */
export function matchedExtractionMetrics(source: string, annotation: Annotation, candidates: LocatedCandidate[], minimum = 0.5) {
    const predicted = candidates.map(c => positions(source, c.spans));
    const cores = annotation.claims.map(c => positions(source, c.spans));
    const whole = annotation.claims.map(c => positions(source, [...c.spans, ...c.qualifiers.flatMap(q => q.spans)]));
    const weights = whole.map(a => predicted.map(b => { const intersection = overlap(a, b); return intersection / (a.size + b.size - intersection || 1); }));
    const matches = maximumWeightMatching(weights, minimum);
    const totals = { claims: whole.length, candidates: predicted.length, matchedClaims: matches.length,
        unmatchedReferences: whole.length - matches.length, unmatchedCandidates: predicted.length - matches.length,
        coreRetained: 0, completeRetained: 0, qualifiers: 0, qualifiersAttached: 0,
        polarityEligible: 0, polarityPreserved: 0, scopeEligible: 0, scopePreserved: 0,
        pairPrecisionChars: 0, candidateChars: predicted.reduce((sum, s) => sum + s.size, 0) };
    const details = annotation.claims.map((claim, index) => {
        const match = matches.find(m => m.reference === index), candidate = match ? predicted[match.candidate]! : new Set<number>();
        const core = contains(candidate, cores[index]!), complete = contains(candidate, whole[index]!);
        if (core) totals.coreRetained++; if (complete) totals.completeRetained++;
        if (match) totals.pairPrecisionChars += overlap(candidate, whole[index]!);
        countMatchedQualifiers(source, claim, candidate, core, totals);
        return { id: claim.id, candidate: match?.candidate ?? null, iou: match?.weight ?? null, coreRetained: core, completeRetained: complete };
    });
    return { ...totals, details };
}

export function summarizeMatching(rows: ReturnType<typeof matchedExtractionMetrics>[]) {
    const counts: Record<string, number> = {};
    for (const { details: _details, ...row } of rows) for (const [key, value] of Object.entries(row)) counts[key] = (counts[key] ?? 0) + value;
    const ratio = (n: string, d: string) => counts[d] ? (counts[n] ?? 0) / counts[d]! : null;
    return { counts, rates: { matchedClaimRecall: ratio("matchedClaims", "claims"), matchedClaimPrecision: ratio("matchedClaims", "candidates"),
        completeClaimRecall: ratio("completeRetained", "claims"), completeClaimPrecision: ratio("completeRetained", "candidates"),
        pairedCharacterPrecision: ratio("pairPrecisionChars", "candidateChars"), qualifierAttachmentRecall: ratio("qualifiersAttached", "qualifiers"),
        polarityPreservation: ratio("polarityPreserved", "polarityEligible"), scopePreservation: ratio("scopePreserved", "scopeEligible") } };
}
