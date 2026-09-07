import { measureArchitecture } from "./adapter-architecture.js";
import { measureContentChecks } from "./adapter-checks.js";
import { measureExactClones } from "./adapter-clones.js";
import { measureContracts } from "./adapter-contracts.js";
import { measureDeadStores } from "./adapter-dead-stores.js";
import { measureReachability } from "./adapter-reachability.js";
import { measureStructureDimensions } from "./adapter-structure.js";
import { measureTypeSoundness } from "./adapter-types.js";
import { analyzeRepository, type RepositoryAnalysis } from "./analysis.js";
import { collectRepositoryInventory } from "./inventory.js";
import { readScoreConfiguration, type ScoreConfiguration } from "./score-config.js";
import { buildScoringGraph } from "./scoring-graph.js";
import type { ScoringGraph } from "./graph-types.js";
import type { AdapterResult } from "./measurement-types.js";

export interface StaticMeasurements extends AdapterResult { analysis: RepositoryAnalysis; graph: ScoringGraph; config: ScoreConfiguration; }

export function collectStaticMeasurements(root: string): StaticMeasurements {
    const inventory = collectRepositoryInventory(root);
    const analysis = analyzeRepository(inventory);
    const config = readScoreConfiguration(inventory);
    const graph = buildScoringGraph(analysis);
    for (const entry of config.entries) {
        if (analysis.files.some(file => file.input.path === entry)) graph.entries.push(entry);
        else config.issues.push(`Entry unavailable: ${entry}`);
    }
    const results = [measureStructureDimensions(analysis), measureContentChecks(analysis, "test_integrity"), measureContentChecks(analysis, "correctness"), measureExactClones(analysis),
        measureDeadStores(analysis), measureReachability(analysis, graph), measureTypeSoundness(inventory),
        measureArchitecture(analysis, graph, config.boundaries), measureContracts(analysis, config)];
    return { analysis, graph, config, metrics: results.flatMap(result => result.metrics), findings: results.flatMap(result => result.findings) };
}
