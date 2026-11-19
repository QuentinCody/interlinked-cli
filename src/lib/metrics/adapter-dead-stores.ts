import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { scanDeadLiteralStoresTs } from "../../harness/checks/dead-literal-store.js";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult, InventoryFile, QualityFinding } from "./measurement-types.js";

const MESSAGE = "Literal initializer is immediately overwritten before a direct read; review callbacks and exception paths before removal";

/** The definition lives in the `dead_literal_store` check, so the metric and its judgment cannot drift. */
function fileDeadStores(file: InventoryFile): { initializers: number; findings: QualityFinding[] } {
    const parsed = parseTsSource(file.content, file.path);
    if (!parsed) return { initializers: 0, findings: [] };
    const scan = scanDeadLiteralStoresTs(parsed);
    return { initializers: scan.initializers, findings: scan.lines.map(line => qualityFinding({ metric: "redundancy.dead_stores", file, line, message: MESSAGE })) };
}

function pythonDeadStores(file: AnalyzedFile): { initializers: number; findings: QualityFinding[] } {
    const row = file.python?.row;
    return { initializers: row?.initializers ?? 0, findings: (row?.deadStores ?? []).map(line => qualityFinding({ metric: "redundancy.dead_stores", file: file.input,
        line, message: MESSAGE })) };
}

export function measureDeadStores(analysis: RepositoryAnalysis): AdapterResult {
    const results = analysis.files.filter(file => file.input.role === "product").map(file => file.python ? pythonDeadStores(file) : fileDeadStores(file.input));
    const findings = results.flatMap(result => result.findings);
    return { findings, metrics: [ratioReading("redundancy.dead_stores", findings.length, results.reduce((sum, result) => sum + result.initializers, 0))] };
}
