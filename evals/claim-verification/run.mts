import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { claimQuestions } from "../../src/harness/jev/claim-evidence.js";
import { JevClient } from "../../src/harness/jev/client.js";
import { legacyCandidates, spanCandidates, retains, spanValid } from "./extractors.mjs";
import { fixtures } from "./fixtures.mjs";

const arguments_ = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const index = arguments_.indexOf(name);
    return index < 0 ? fallback : arguments_[index + 1] ?? fallback;
};
const output = resolve(option("--out", `scratch/2026-10-19-claim-verification/run-${Date.now()}`));
const dataset = resolve(option("--dataset", "scratch/2026-09-16-jev-checks/a1-dataset.jsonl"));
const model = option("--model", "jev-1.13.0");
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
save("implementation-snapshot.json", { node: process.version, icu: process.versions.icu,
    snapshots: ["evals/claim-verification/extractors.mts", "evals/claim-verification/fixtures.mts", "evals/claim-verification/run.mts", "src/harness/jev/claim-evidence.ts", "src/harness/jev/client.ts"].map(path => {
        const text = readFileSync(path, "utf8");
        return { path, sha256: createHash("sha256").update(text).digest("hex"), source: text };
    }) });
const source = readFileSync(dataset, "utf8");
interface SavedTurn { id: string; session: string; final_text: string; claims: string[]; tools: Array<{ input: string; result: string }> }
const turns: SavedTurn[] = source.trim().split("\n").map(line => {
    const row = JSON.parse(line);
    if (typeof row.id !== "string" || typeof row.session !== "string" || typeof row.final_text !== "string"
        || !Array.isArray(row.claims) || !Array.isArray(row.tools)
        || row.tools.some((tool: SavedTurn["tools"][number]) => typeof tool?.input !== "string" || typeof tool?.result !== "string")) throw new Error("Invalid saved turn");
    return row;
});
const extractors = { legacy: legacyCandidates, spans: spanCandidates };
const historical = turns.map(turn => {
    const candidates = spanCandidates(turn.final_text);
    return { id: turn.id, session: turn.session, sourceChars: turn.final_text.length,
        oldLabeledCandidates: turn.claims.length, legacyCandidates: legacyCandidates(turn.final_text).length,
        spanCandidates: candidates.length, validSpans: candidates.filter(candidate => spanValid(turn.final_text, candidate)).length,
        retainedToolEntries: turn.tools.length,
        resultTailsAt400Characters: turn.tools.filter(tool => tool.result.length === 400).length,
        inputHeadsAt300Characters: turn.tools.filter(tool => tool.input.length === 300).length };
});
save("historical-inventory.json", historical);
save("fixture-candidates.json", fixtures.map(fixture => ({ ...fixture, candidates: Object.fromEntries(Object.entries(extractors).map(([name, extract]) => [name, extract(fixture.source)])) })));
const synthetic = Object.entries(extractors).map(([name, extract]) => {
    const details = fixtures.map(fixture => {
        const candidates = extract(fixture.source);
        return { id: fixture.id, candidates: candidates.length, exactSpans: candidates.filter(candidate => spanValid(fixture.source, candidate)).length,
            targets: fixture.claims.map(claim => ({ id: claim.id, retained: retains(candidates, claim.parts) })) };
    });
    return { extractor: name, targetCount: details.reduce((sum, row) => sum + row.targets.length, 0),
        retainedTargets: details.reduce((sum, row) => sum + row.targets.filter(target => target.retained).length, 0), details };
});
const live: unknown[] = [];
let client: JevClient | undefined;
if (arguments_.includes("--jev")) {
    if (!process.env.TYPESAFE_API_KEY) live.push({ status: "skipped", reason: "TYPESAFE_API_KEY missing" });
    else {
        client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, config: { model, timeout_ms: 20_000, max_spend_usd: 0.10 } });
        for (const fixture of fixtures) {
            for (const [extractor, extract] of Object.entries(extractors)) {
                const claims = extract(fixture.source).map(candidate => candidate.text);
                if (!claims.length) { live.push({ id: fixture.id, extractor, status: "no_candidates" }); continue; }
                const state = { evidence: fixture.evidence, claims };
                const questions = claimQuestions(claims.length);
                const started = performance.now();
                const result = await client.askDetailed(state, questions);
                live.push({ id: fixture.id, extractor, state, questions, result, latencyMs: performance.now() - started });
                console.log(JSON.stringify({ fixture: fixture.id, extractor, status: result.ok ? "completed" : result.error }));
                if (!result.ok && (result.error === "http_401" || result.error === "http_403" || result.error === "http_404")) break;
            }
            if (client.spend().failures >= 3) break;
        }
    }
}
save("jev-results.json", live);
const summary = {
    createdAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dataset, datasetSha256: createHash("sha256").update(source).digest("hex"),
    historical: { turns: turns.length, sessions: new Set(turns.map(turn => turn.session)).size,
        oldLabeledCandidates: historical.reduce((sum, row) => sum + row.oldLabeledCandidates, 0),
        legacyCandidates: historical.reduce((sum, row) => sum + row.legacyCandidates, 0),
        spanCandidates: historical.reduce((sum, row) => sum + row.spanCandidates, 0),
        exactSpans: historical.reduce((sum, row) => sum + row.validSpans, 0),
        retainedToolEntries: historical.reduce((sum, row) => sum + row.retainedToolEntries, 0),
        turnsAt25ToolLimit: historical.filter(row => row.retainedToolEntries === 25).length,
        resultTailsAt400Characters: historical.reduce((sum, row) => sum + row.resultTailsAt400Characters, 0),
        inputHeadsAt300Characters: historical.reduce((sum, row) => sum + row.inputHeadsAt300Characters, 0) },
    synthetic, jev: client?.spend() ?? { status: "not_run" }, modelRequested: model,
    limitations: ["Synthetic development fixtures measure specified-text retention, not population claim recall or precision.",
        "Historical messages have no complete claim annotations; candidate counts are not quality scores.",
        "Boundary-length tool records indicate possible truncation, not measured missing bytes.",
        "Live calls contain only authored synthetic fixtures; saved transcript text stays local."],
};
save("summary.json", summary);
console.log(JSON.stringify({ output, historical: summary.historical, synthetic: synthetic.map(({ extractor, targetCount, retainedTargets }) => ({ extractor, targetCount, retainedTargets })), jev: summary.jev }, null, 2));
