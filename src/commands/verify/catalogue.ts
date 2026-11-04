import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadCheckTypescript } from "../../harness/checks/check-typescript.js";
import { isTestFile } from "../../harness/checks/shared.js";
import { checkReadmeCommandDrift, isCurrentCommandDocumentation } from "./readme-command-drift.js";
import { configDefaults, documentedConfigKeys, checkUnreadConfigKeys, type ConfigSource } from "./unread-config-key.js";
import { readBoundedLog, summaryEvidenceFromLogs, checkSummaryFileCoverage, touchedSummaryEvidence } from "./summary-file-coverage.js";
import { VERIFY_ADVISORY_CATALOGUE, type CatalogueResult } from "./catalogue-types.js";
import { recordVerifyMeasurement } from "./check-timing.js";

export { VERIFY_ADVISORY_CATALOGUE } from "./catalogue-types.js";

function textSources(root: string, directory: string, extension: RegExp): ConfigSource[] {
    const result: ConfigSource[] = [];
    function walk(dir: string): void {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith(".") || ["node_modules", "dist", "scratch", "vendor"].includes(entry.name) || entry.isSymbolicLink()) continue;
            const file = join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && extension.test(entry.name) && statSync(file).size <= 1_000_000) {
                result.push({ file: relative(root, file).replaceAll("\\", "/"), content: readFileSync(file, "utf8") });
            }
        }
    }
    walk(join(root, directory));
    return result;
}

/** No subprocess, network, model, configuration secret, or Git access. */
export async function runCatalogueAdvisories(root: string, skips: ReadonlySet<string> = new Set()): Promise<Record<string, CatalogueResult>> {
    const output: Record<string, CatalogueResult> = {};
    const docs = textSources(root, "docs", /\.md$/i);
    const readme = join(root, "README.md");
    if (existsSync(readme) && statSync(readme).size <= 1_000_000) docs.unshift({ file: "README.md", content: readFileSync(readme, "utf8") });
    if (!skips.has("readme_command_drift")) {
        const started = performance.now();
        const { buildProgram } = await import("../../cli-program.js");
        const program = buildProgram("qualification");
        const current = docs.filter(source => isCurrentCommandDocumentation(source.file));
        output.readme_command_drift = { findings: docs.flatMap(source => checkReadmeCommandDrift(source.content, source.file, program)),
            examined: current.length, unavailable: docs.length - current.length, durationMs: performance.now() - started };
    }
    if (!skips.has("unread_config_key")) {
        const started = performance.now();
        const sources = textSources(root, "src", /\.[cm]?tsx?$/).filter(source => !isTestFile(source.file)
            && !/(?:^|\/)(?:__fixtures__|fixtures)(?:\/|$)/.test(source.file) && !source.file.endsWith(".d.ts"));
        const ts = loadCheckTypescript("unread_config_key", "configuration defaults");
        const declarations = [...docs.flatMap(documentedConfigKeys), ...(ts ? sources.flatMap(source => configDefaults(source, ts)) : [])];
        const result = checkUnreadConfigKeys(declarations, sources);
        output.unread_config_key = { ...result, examined: declarations.length, durationMs: performance.now() - started };
    }
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
