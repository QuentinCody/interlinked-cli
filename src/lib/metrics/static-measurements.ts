import { measureArchitecture } from "./adapter-architecture.js";
import { withForegroundCheckScan } from "../../harness/checks/check-scan-policy.js";
import { measureContentChecks } from "./adapter-checks.js";
import { measureExactClones } from "./adapter-clones.js";
import { measureContracts } from "./adapter-contracts.js";
import { measureDeadStores } from "./adapter-dead-stores.js";
import { measureReachability } from "./adapter-reachability.js";
import { measureStructureDimensions } from "./adapter-structure.js";
import { measureTypeSoundness } from "./adapter-types.js";
import { mergePythonTypes } from "./adapter-types-python.js";
import { analyzeRepository, type RepositoryAnalysis } from "./analysis.js";
import { collectRepositoryInventory } from "./inventory.js";
import { readScoreConfiguration, type ScoreConfiguration } from "./score-config.js";
import { buildScoringGraph } from "./scoring-graph.js";
import type { ScoringGraph } from "./graph-types.js";
import { refineInventory } from "./inventory-refine.js";
import type { AdapterResult, RepositoryInventory } from "./measurement-types.js";

export interface StaticMeasurements extends AdapterResult {
    /** The shared census (path-only roles): the identity that saved coverage and mutation evidence matches. */
    census: RepositoryInventory;
    /** `analysis.inventory` is the refined view that the metrics measure (roles v5). */
    analysis: RepositoryAnalysis; graph: ScoringGraph; config: ScoreConfiguration;
}

export function collectStaticMeasurements(root: string): StaticMeasurements {
    const census = collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" });
    const inventory = refineInventory(census);
    const analysis = analyzeRepository(inventory);
    const config = readScoreConfiguration(inventory);
    const graph = buildScoringGraph(analysis);
    for (const entry of config.entries) {
        if (analysis.files.some(file => file.input.path === entry)) graph.entries.push(entry);
        else config.issues.push(`Entry unavailable: ${entry}`);
    }
    const results = [measureStructureDimensions(analysis),
        ...withForegroundCheckScan(() => [measureContentChecks(analysis, "test_integrity"), measureContentChecks(analysis, "correctness")]), measureExactClones(analysis),
        measureDeadStores(analysis), measureReachability(analysis, graph), mergePythonTypes(measureTypeSoundness(inventory), analysis),
        measureArchitecture(analysis, graph, config.boundaries), measureContracts(analysis, config)];
    return { census, analysis, graph, config, metrics: results.flatMap(result => result.metrics), findings: results.flatMap(result => result.findings) };
}
