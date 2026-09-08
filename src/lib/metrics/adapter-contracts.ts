import { isJsonObject } from "../json-types.js";
import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import { exportContractReader } from "./contract-exports.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";
import type { ScoreConfiguration, ScoreContract } from "./score-config.js";

function satisfies(contract: ScoreContract, analysis: RepositoryAnalysis, exported: ReturnType<typeof exportContractReader>): boolean | string {
    const file = analysis.inventory.files.find(item => item.path === contract.path);
    if (!file) return false;
    if (contract.kind === "file") return true;
    if (contract.kind === "export") return exported(contract.path, contract.name);
    const json: unknown = JSON.parse(file.content);
    return isJsonObject(json) && isJsonObject(json.scripts) && typeof json.scripts[contract.name] === "string";
}

export function measureContracts(analysis: RepositoryAnalysis, config: ScoreConfiguration): AdapterResult {
    if (config.issues.length) return { findings: [], metrics: [emptyReading("contracts.findings", "inconclusive", config.contracts.length, config.issues.join("; "))] };
    const findings: QualityFinding[] = [], issues: string[] = [];
    const exported = exportContractReader(analysis.inventory, config.contracts.filter(contract => contract.kind === "export").map(contract => contract.path));
    const anchor = analysis.inventory.files.find(file => file.path === "interlinked.metrics.json");
    let failed = 0;
    for (const contract of config.contracts) {
        let passed: boolean | string = false;
        try { passed = satisfies(contract, analysis, exported); }
        catch { passed = contract.kind === "export" ? `Export analysis unavailable for ${contract.path}` : false; }
        if (typeof passed === "string") { issues.push(passed); continue; }
        if (passed) continue;
        failed++;
        if (anchor) findings.push(qualityFinding({ metric: "contracts.findings", file: anchor, line: 1, evidence: "proven",
            message: `Declared ${contract.kind} contract failed: ${contract.path} ${contract.name}`, related: [contract.path] }));
    }
    const metric = ratioReading("contracts.findings", failed, config.contracts.length - issues.length);
    if (issues.length) { metric.state = "inconclusive"; metric.eligibleEntities = config.contracts.length; metric.limitations.push(...issues); }
    return { findings, metrics: [metric] };
}
