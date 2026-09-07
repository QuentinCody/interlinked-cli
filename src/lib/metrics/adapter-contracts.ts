import { isJsonObject } from "../json-types.js";
import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";
import type { ScoreConfiguration, ScoreContract } from "./score-config.js";

function satisfies(contract: ScoreContract, analysis: RepositoryAnalysis): boolean {
    const file = analysis.inventory.files.find(item => item.path === contract.path);
    if (!file) return false;
    if (contract.kind === "file") return true;
    if (contract.kind === "export") return !!analysis.files.find(item => item.input.path === contract.path)?.syntax.declarations.some(item => item.exported && item.name === contract.name);
    const json: unknown = JSON.parse(file.content);
    return isJsonObject(json) && isJsonObject(json.scripts) && typeof json.scripts[contract.name] === "string";
}

export function measureContracts(analysis: RepositoryAnalysis, config: ScoreConfiguration): AdapterResult {
    if (config.issues.length) return { findings: [], metrics: [emptyReading("contracts.findings", "inconclusive", config.contracts.length, config.issues.join("; "))] };
    const findings: QualityFinding[] = [];
    const anchor = analysis.inventory.files.find(file => file.path === "interlinked.metrics.json");
    let failed = 0;
    for (const contract of config.contracts) {
        let passed = false;
        try { passed = satisfies(contract, analysis); } catch { passed = false; /* Malformed contract input fails its assertion. */ }
        if (passed) continue;
        failed++;
        if (anchor) findings.push(qualityFinding({ metric: "contracts.findings", file: anchor, line: 1, evidence: "proven",
            message: `Declared ${contract.kind} contract failed: ${contract.path} ${contract.name}`, related: [contract.path] }));
    }
    return { findings, metrics: [ratioReading("contracts.findings", failed, config.contracts.length)] };
}
