import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clauseEvidence, parseClauses, type ClauseEvidence } from "../harness/check-evidence/clauses.js";
import { FAULT_CORPUS_PATH, parseFaultCorpus, type FaultOutcome } from "../harness/requirement-faults/corpus.js";
import { runFaults, type FaultRunReport } from "../harness/requirement-faults/run.js";
import { mergeOutcomes, readOutcomeStore, writeOutcomeStore } from "../harness/requirement-faults/store.js";
import { isJsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** The last `tests faults run`, read by `tests faults clauses` (evidence, not configuration: never committed). */
export const LATEST_FAULT_RUN = ".interlinked/test-runs/faults/latest.json";

export function renderClauseEvidence(rows: readonly ClauseEvidence[], at: string | null): string {
    const total = rows.reduce((sum, row) => sum + row.total, 0), pinned = rows.reduce((sum, row) => sum + row.pinned, 0);
    const measured = rows.reduce((sum, row) => sum + row.measured, 0);
    const lines = [`detector clauses (${at ? `fault run ${at}` : "no fault run recorded"}): ${pinned} of ${total} pinned, ${measured} measured`];
    for (const row of rows) {
        lines.push(`  ${row.module}: ${row.pinned}/${row.total} pinned, ${row.measured} measured`);
        for (const clause of row.clauses.filter(item => item.fraction !== 1)) {
            const label = `k${clause.k} ${clause.direction === "fires" ? "FIRES WHEN" : "DOES NOT FIRE"} "${clause.text}"`;
            lines.push(`    ${label}: ${clause.fraction === null ? (clause.faults ? "no conclusive fault" : "no recorded fault") : `kill fraction ${clause.fraction.toFixed(2)}`}`);
        }
    }
    return lines.join("\n");
}

function latestRun(root: string): { at: string; faults: FaultOutcome[] } | null {
    const path = join(root, LATEST_FAULT_RUN);
    if (!existsSync(path)) return null;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(path, "utf8")); } catch { return null; } // a torn report is no evidence
    if (!isJsonObject(saved) || typeof saved.at !== "string" || !isJsonObject(saved.report) || !Array.isArray(saved.report.faults)) return null;
    return { at: saved.at, faults: saved.report.faults as FaultOutcome[] }; // SAFETY: written by testsFaultsRunCommand below
}

/** Clause evidence comes from the outcome store (every corpus's newest outcomes); a tree with no store yet falls
 *  back to the last run. `at` is the newest run that recorded a clause fault. */
function clauseFaults(root: string): { at: string | null; faults: FaultOutcome[] } {
    const store = readOutcomeStore(root);
    if (!store) { const run = latestRun(root); return { at: run?.at ?? null, faults: run?.faults ?? [] }; }
    const rows = Object.values(store);
    const at = rows.filter(row => row.outcome.requirement.startsWith("clause:")).map(row => row.at).sort().at(-1) ?? null;
    return { at, faults: rows.map(row => row.outcome) };
}

export async function testsFaultsClausesCommand(options: { cwd?: string; detectors?: string; json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd()), dir = join(root, options.detectors ?? "src/harness/checks");
        const run = clauseFaults(root);
        const rows = readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort().flatMap(name => {
            const clauses = parseClauses(readFileSync(join(dir, name), "utf8"));
            return clauses.length ? [clauseEvidence(name.slice(0, -3), clauses, run.faults)] : [];
        });
        output(mode, { at: run.at, modules: rows }, { normal: () => renderClauseEvidence(rows, run.at) });
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "clause evidence unavailable"); process.exitCode = 2; }
}

export function renderFaultRun(report: FaultRunReport): string {
    if (!report.faults.length) return "requirement faults: no fault selected";
    const count = (status: string) => report.faults.filter(row => row.status === status).length;
    const reqs = report.requirements;
    const full = reqs.filter(row => row.fraction === 1).length, none = reqs.filter(row => row.fraction === 0).length;
    const partial = reqs.filter(row => row.fraction !== null && row.fraction > 0 && row.fraction < 1).length;
    const fraction = new Map(reqs.map(row => [row.requirement, row.fraction]));
    return [
        `requirement faults: ${report.faults.length} run — ${count("killed")} killed, ${count("survived")} survived, ${count("inconclusive")} inconclusive, ${count("invalid")} invalid`,
        `  requirements: ${reqs.length} — ${full} fully pinned (fraction 1), ${partial} partly pinned, ${none} unpinned, ${reqs.filter(row => row.fraction === null).length} without a conclusive fault`,
        ...report.faults.filter(row => row.status === "survived").map(row => `  survived: ${row.fault} (requirement ${row.requirement}, fraction ${(fraction.get(row.requirement) ?? 0).toFixed(2)})`),
        ...report.faults.filter(row => row.status === "inconclusive").map(row => `  inconclusive: ${row.fault} — ${inconclusiveLine(row)}`),
        ...report.faults.filter(row => row.status === "invalid").map(row => `  invalid: ${row.fault} — ${row.reason ?? "not applied"}`),
    ].join("\n");
}

function inconclusiveLine(row: FaultOutcome): string {
    const [first, ...rest] = row.inconclusive;
    if (first === undefined) return "no test reported";
    return `${first}: ${row.inconclusiveReasons?.[first] ?? "no reason recorded"}${rest.length ? ` (+${rest.length} more)` : ""}`;
}

export async function testsFaultsRunCommand(options: { cwd?: string; corpus?: string; ids?: string; timeout?: string; json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd()), path = join(root, options.corpus ?? FAULT_CORPUS_PATH);
        if (!existsSync(path)) { outputError(mode, `no requirement-fault corpus at ${path}`); process.exitCode = 2; return; }
        const ids = options.ids ? new Set(options.ids.split(",").map(id => id.trim()).filter(Boolean)) : null;
        const faults = parseFaultCorpus(readFileSync(path, "utf8")).faults.filter(row => !ids || ids.has(row.id));
        const budgetMs = Number(options.timeout ?? "300000");
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) { outputError(mode, "--timeout must be a positive number of milliseconds"); process.exitCode = 2; return; }
        const report = await runFaults({ root, faults, budgetMs });
        const latest = join(root, LATEST_FAULT_RUN), at = new Date().toISOString(), corpus = options.corpus ?? FAULT_CORPUS_PATH;
        mkdirSync(dirname(latest), { recursive: true });
        writeFileSync(latest, JSON.stringify({ version: 1, at, corpus, report }, null, 1));
        writeOutcomeStore(root, mergeOutcomes(readOutcomeStore(root) ?? {}, corpus, at, report.faults, ids === null));
        output(mode, report, { normal: () => renderFaultRun(report) });
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "requirement faults unavailable"); process.exitCode = 2; }
}
