import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Annotation } from "./annotation-metrics.mjs";
import type { FrozenEvidence } from "./batch-diagnostic.mjs";

export interface ProvenanceReceipt { tool: string; input: string; result_tail: string; error: boolean; provenance: string }
export interface Control {
    id: string; parentId: string; claim: string; origin: string; variant: string;
    evidence: ProvenanceReceipt[]; certified: boolean; expectedSupport: boolean | null; reason: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Provenance is supplied by capture/construction, never inferred from text or the tool-name field. */
export const eligibleEvidence = (evidence: ProvenanceReceipt[]) => evidence.filter(r => r.provenance === "tool_result" || r.provenance === "structured_receipt");

export function historicalControls(parentId: string, claim: string, evidence: ProvenanceReceipt[]): Control[] {
    const make = (variant: string, receipts: ProvenanceReceipt[], certified: boolean, reason: string): Control => ({
        id: hash(`${parentId}:${variant}`).slice(0, 20), parentId, claim, origin: "historical-ablation", variant,
        evidence: receipts, certified, expectedSupport: certified ? false : null, reason });
    return [
        make("removed", [], true, "All supplied evidence removed, including alternatives. Evidence-bounded support cannot be established."),
        make("summary_only", [{ tool: "Assistant", input: "", result_tail: `Agent-written summary: ${claim}`, error: false, provenance: "assistant_summary" }], true,
            "Only the agent's own assertion is supplied. It is not independent execution or repository evidence."),
        make("truncated", evidence.map(r => ({ ...r, input: r.input.slice(0, 300), result_tail: r.result_tail.slice(-400) })), false,
            "The retained tail may still contain decisive evidence; no automatic negative label is valid."),
        make("altered", [], false, "Unconstructed: this arbitrary semantic claim has no certified decisive typed fact; changing text cannot certify contradiction."),
    ];
}

function loadControlReference(row: { file: string; sha256: string }, referenceDir: string, sourceDir: string) {
    const annotationText = readFileSync(resolve(referenceDir, row.file), "utf8");
    if (hash(annotationText) !== row.sha256) throw new Error("Reference annotation changed");
    const annotation: Annotation = JSON.parse(annotationText);
    const source: { source: string } = JSON.parse(readFileSync(resolve(sourceDir, row.file), "utf8"));
    if (hash(source.source) !== annotation.sourceSha256) throw new Error("Source changed");
    const evidenceName = row.file.replace(".json", row.file === "c28e9a81-158.json" ? "-evidence-v2.json" : "-evidence.json");
    const evidence: FrozenEvidence = JSON.parse(readFileSync(resolve(sourceDir, evidenceName), "utf8"));
    return { annotation, source: source.source, evidence };
}

function buildReferenceControls(a: Annotation, source: string, evidence: FrozenEvidence) {
    const controls: Control[] = []; const parents = [];
    for (const c of a.claims) {
        const snapshot = c.labels.curated === "supported" ? "curated" : c.labels.operational === "supported" ? "operational" : null;
        if (!snapshot || !c.evidenceIds[snapshot].length) continue;
        const spans = [...c.spans, ...c.qualifiers.flatMap(q => q.spans)].sort((x, y) => x[0] - y[0]);
        const merged: Array<[number, number]> = [];
        for (const span of spans) {
            const last = merged.at(-1);
            if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
        }
        const claim = merged.map(s => source.slice(...s)).join("\n");
        const receipts: ProvenanceReceipt[] = snapshot === "curated" ? evidence.receipts.filter(r => c.evidenceIds.curated.includes(r.id))
            .map(r => ({ tool: r.tool, input: r.input, error: r.error,
                result_tail: r.result_tail + (r.structuredResult === undefined ? "" : `\n${JSON.stringify(r.structuredResult)}`), provenance: "tool_result" }))
            : evidence.operationalEvidence.map(r => ({ tool: r.name, input: r.input, result_tail: r.result, error: r.is_error, provenance: "tool_result" }));
        parents.push({ id: c.id, source: a.id, snapshot, spans: merged, referenceLabel: "supported", producer: a.annotator });
        controls.push(...historicalControls(c.id, claim, receipts));
    }
    return { controls, parents };
}

function main(): void {
    const [referenceDir, sourceDir, output] = process.argv.slice(2);
    if (!referenceDir || !sourceDir || !output) throw new Error("Usage: controls.mts REFERENCES SOURCES NEW_OUTPUT");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const manifest = JSON.parse(readFileSync(resolve(referenceDir, "manifest.json"), "utf8"));
    const controls: Control[] = []; const parents = [];
    for (const row of manifest.files) {
        const { annotation, source, evidence } = loadControlReference(row, referenceDir, sourceDir);
        const built = buildReferenceControls(annotation, source, evidence);
        parents.push(...built.parents); controls.push(...built.controls);
    }
    save("controls.json", controls); save("parents.json", parents);
    const certified = controls.filter(c => c.certified);
    const blind = certified.map(c => ({ id: c.id, claim: c.claim, evidence: c.evidence }));
    const midpoint = Math.ceil(blind.length / 2);
    save("astra-blind-a.json", blind.slice(0, midpoint)); save("astra-blind-b.json", blind.slice(midpoint));
    save("manifest.json", { createdAt: new Date().toISOString(), parents: parents.length, proposed: controls.length, certified: certified.length,
        controlsSha256: hash(JSON.stringify(controls, null, 2) + "\n"), referenceManifestSha256: hash(readFileSync(resolve(referenceDir, "manifest.json"), "utf8")),
        modelAcceptanceThreshold: 0.05, limitation: "Historical negative controls test evidence boundedness; altered/truncated negatives require separate typed construction." });
    console.log(JSON.stringify({ parents: parents.length, proposed: controls.length, certified: certified.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
