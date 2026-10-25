import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractionMetrics, locatedLegacy, type Annotation } from "./annotation-metrics.mjs";
import { spanCandidates } from "./extractors.mjs";
import { matchedExtractionMetrics, summarizeMatching } from "./claim-matching.mjs";

export function summarizeExtraction(rows: Array<Record<string, number>>) {
    const counts: Record<string, number> = {};
    for (const row of rows) for (const [key, value] of Object.entries(row)) counts[key] = (counts[key] ?? 0) + value;
    const ratio = (numerator: string, denominator: string) => counts[denominator] ? (counts[numerator] ?? 0) / counts[denominator]! : null;
    return { counts, rates: { completeClaimRecall: ratio("completeRetained", "claims"), coreClaimRecall: ratio("coreRetained", "claims"),
        spanCharacterPrecision: ratio("precisionChars", "candidateChars"), qualifierRecall: ratio("qualifiersRetained", "qualifiers"),
        qualifierAttachmentRecall: ratio("qualifiersAttached", "qualifiers"), qualifierMisattachment: ratio("qualifiersMisattached", "qualifiers"),
        polarityPreservation: ratio("polarityPreserved", "polarityEligible"), scopePreservation: ratio("scopePreserved", "scopeEligible") } };
}

function compareLocalExtractors(annotationDir: string, sourceDir: string) {
    const rows: Array<{ id: string; session: string; extractor: string; matched: ReturnType<typeof matchedExtractionMetrics>;
        counts: Omit<ReturnType<typeof extractionMetrics>, "details">;
        details: ReturnType<typeof extractionMetrics>["details"] }> = [];
    for (const file of readdirSync(sourceDir).filter(f => f.endsWith(".json") && !f.includes("-evidence")).sort()) {
        const source = JSON.parse(readFileSync(resolve(sourceDir, file), "utf8"));
        const annotation: Annotation = JSON.parse(readFileSync(resolve(annotationDir, file), "utf8"));
        if (source.id !== annotation.id || createHash("sha256").update(source.source).digest("hex") !== annotation.sourceSha256) throw new Error("Annotation source changed");
        const extractors = { legacy: locatedLegacy(source.source), spans: spanCandidates(source.source).map(c => ({ text: c.text, spans: [c.span!] })) };
        for (const [extractor, candidates] of Object.entries(extractors)) {
            const { details, ...counts } = extractionMetrics(source.source, annotation, candidates);
            rows.push({ id: source.id, session: source.session, extractor, counts, details, matched: matchedExtractionMetrics(source.source, annotation, candidates) });
        }
    }
    return rows;
}

function main(): void {
    const [annotationDir, sourceDir, output] = process.argv.slice(2);
    if (!annotationDir || !sourceDir || !output) throw new Error("Usage: extraction-comparison.mts ANNOTATIONS SOURCES NEW_OUTPUT");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const rows = compareLocalExtractors(annotationDir, sourceDir);
    const summaries = Object.fromEntries(["legacy", "spans"].map(arm => [arm, summarizeExtraction(rows.filter(r => r.extractor === arm).map(r => r.counts))]));
    const matchingSummaries = Object.fromEntries(["legacy", "spans"].map(arm => [arm, summarizeMatching(rows.filter(r => r.extractor === arm).map(r => r.matched))]));
    save("summary.json", { createdAt: new Date().toISOString(), scoringVersion: 2, primaryMetric: "matchingSummaries", minimumIoU: 0.5,
        matchingSummaries, turns: rows.length / 2, node: process.version, icu: process.versions.icu,
        referenceManifest: JSON.parse(readFileSync(resolve(annotationDir, "manifest.json"), "utf8")), summaries, rows,
        skipped: { llm: "This command evaluates local splitters only; external arms have separate retained artifacts.", clairic: "Use external-extractors.mts; no hosted call is made by this local scoring command." },
        definitions: { completeClaimRecall: "All annotated core and qualifier source characters present together in one candidate.",
            matching: "Maximum total qualifier-inclusive source-character IoU, eligible edges >=0.5, at most one prediction per reference and one reference per prediction. Unmatched units retained. Old summaries measure containment only.",
            spanCharacterPrecision: "Legacy containment metric: non-whitespace/non-Markdown candidate source characters falling inside reference claims or qualifiers, divided by candidate characters. Matching precision uses only the assigned pair.",
            qualifierMisattachment: "Qualifier co-located with another complete claim core while its own core is absent; a source-co-location proxy, not a semantic attachment proof.",
            polarityAndScope: "Preservation among claims with explicit annotated negation or scope/condition/exception spans; no inferred denominator." },
        limitations: ["Model-reference agreement, not human-ground-truth accuracy.", "References and extractor changes used this corpus; this is not a preregistered held-out session estimate.", "Report per-turn rows; pooled claims are clustered by turn and session."] });
    console.log(JSON.stringify({ matchingSummaries, legacyContainment: summaries }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
