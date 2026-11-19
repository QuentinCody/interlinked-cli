import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadCheckTypescript } from "../../harness/checks/check-typescript.js";
import { isTestFile } from "../../harness/checks/shared.js";
import { checkReadmeCommandDrift, isCurrentCommandDocumentation } from "./readme-command-drift.js";
import { configDefaults, documentedConfigKeys, checkUnreadConfigKeys, type ConfigSource } from "./unread-config-key.js";
import { readBoundedLog, summaryEvidenceFromLogs, checkSummaryFileCoverage, touchedSummaryEvidence } from "./summary-file-coverage.js";
import { VERIFY_ADVISORY_CATALOGUE, type CatalogueInputGap, type CatalogueResult } from "./catalogue-types.js";
import { recordVerifyMeasurement } from "./check-timing.js";

export { VERIFY_ADVISORY_CATALOGUE } from "./catalogue-types.js";

interface SourceScan { sources: ConfigSource[]; gaps: CatalogueInputGap[]; }
const MAX_SOURCE_BYTES = 1_000_000;

function recordReadError(scan: SourceScan, file: string, error: unknown, optional: boolean): void {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "I/O error";
    if (!optional || code !== "ENOENT") scan.gaps.push({ file, reason: `Could not read catalogue input (${code}).` });
}

function readSource(root: string, file: string, scan: SourceScan, optional = false): void {
    try {
        const path = join(root, file);
        const stat = lstatSync(path);
        if (!stat.isFile()) scan.gaps.push({ file, reason: "Catalogue input is not a regular file." });
        else if (stat.size > MAX_SOURCE_BYTES) scan.gaps.push({ file, reason: `Catalogue input exceeds the ${MAX_SOURCE_BYTES}-byte limit.` });
        else scan.sources.push({ file, content: readFileSync(path, "utf8") });
    } catch (error) { recordReadError(scan, file, error, optional); }
}

function textSources(root: string, directory: string, include: (file: string) => boolean): SourceScan {
    const scan: SourceScan = { sources: [], gaps: [] };
    function walk(dir: string): void {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch (error) { recordReadError(scan, relative(root, dir), error, dir === join(root, directory)); return; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith(".") || ["node_modules", "dist", "scratch", "vendor"].includes(entry.name)) continue;
            const file = join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else {
                const path = relative(root, file).replaceAll("\\", "/");
                if (include(path)) readSource(root, path, scan);
            }
        }
    }
    walk(join(root, directory));
    return scan;
}

/** No subprocess, network, model, configuration secret, or Git access. */
export async function runCatalogueAdvisories(root: string, skips: ReadonlySet<string> = new Set()): Promise<Record<string, CatalogueResult>> {
    const output: Record<string, CatalogueResult> = {};
    const docs = textSources(root, "docs", file => /\.md$/i.test(file));
    readSource(root, "README.md", docs, true);
    if (!skips.has("readme_command_drift")) {
        const started = performance.now();
        const { buildProgram } = await import("../../cli-program.js");
        const program = buildProgram("qualification");
        const current = docs.sources.filter(source => isCurrentCommandDocumentation(source.file, source.content));
        const gaps = docs.gaps.filter(input => isCurrentCommandDocumentation(input.file) && isCurrentCommandDocumentation(input.file + "/"));
        output.readme_command_drift = { findings: current.flatMap(source => checkReadmeCommandDrift(source.content, source.file, program)),
            examined: current.length, unavailable: gaps.length, unavailable_inputs: gaps,
            out_of_scope: docs.sources.length - current.length + docs.gaps.length - gaps.length, durationMs: performance.now() - started };
    }
    if (!skips.has("unread_config_key")) output.unread_config_key = unreadConfigurationEvidence(root, docs);
    if (!skips.has("summary_file_coverage")) {
        const started = performance.now();
        const evidence = catalogueSummaryEvidence(root);
        output.summary_file_coverage = { findings: evidence.flatMap(checkSummaryFileCoverage), examined: evidence.length,
            unavailable: evidence.filter(item => !item.complete || !item.message.trim()).length,
            durationMs: performance.now() - started };
    }
    for (const [check, result] of Object.entries(output)) recordVerifyMeasurement(check, result.durationMs);
    return output;
}

function unreadConfigurationEvidence(root: string, docs: SourceScan): CatalogueResult {
    const started = performance.now();
    const sources = textSources(root, "src", file => /\.[cm]?tsx?$/.test(file) && !isTestFile(file)
        && !/(?:^|\/)(?:__fixtures__|fixtures)(?:\/|$)/.test(file) && !file.endsWith(".d.ts"));
    const ts = loadCheckTypescript("unread_config_key", "configuration defaults");
    const declarations = [...docs.sources.flatMap(documentedConfigKeys), ...(ts ? sources.sources.flatMap(source => configDefaults(source, ts)) : [])];
    const result = checkUnreadConfigKeys(declarations, sources.sources, sources.gaps[0]?.file);
    const gaps = [...docs.gaps, ...sources.gaps, ...result.unavailable_inputs];
    if (!ts) gaps.push(...sources.sources.map(({ file }) => ({ file, reason: "TypeScript parser unavailable for configuration defaults." })));
    return { findings: result.findings, unavailable: gaps.length, unavailable_inputs: gaps,
        examined: declarations.length, durationMs: performance.now() - started };
}

function catalogueSummaryEvidence(root: string) {
    const activity = readBoundedLog(join(root, ".interlinked", "activity.jsonl"));
    const touches = readBoundedLog(join(root, ".interlinked", "files-touched.jsonl"));
    const evidence = summaryEvidenceFromLogs(root, activity, touches).map(item => {
        const ledger = touchedSummaryEvidence(root, item.session, item.message, item.at);
        return ledger.complete ? ledger : item;
    });
    return evidence;
}

export function streamCatalogueAdvisories(results: Record<string, CatalogueResult>): void {
    for (const entry of VERIFY_ADVISORY_CATALOGUE) {
        const result = results[entry.id];
        if (!result) continue;
        process.stderr.write(`\n  ${entry.id} (advisory): ${result.findings.length} findings; ${result.unavailable} unavailable\n`);
        for (const finding of result.findings) process.stderr.write(`    ${finding.file}:${finding.line}: ${finding.message}\n`);
    }
}
