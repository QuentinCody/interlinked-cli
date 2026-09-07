import type { MetricDefinition, QualityDimension } from "./measurement-types.js";

const PERCENT_KNOTS = [[0, 0], [1, .1], [5, .4], [20, 1]] as const;
const SIZE_KNOTS = [[0, 0], [500, 0], [750, .4], [1500, 1]] as const;

function metric(id: string, name: string, dimension: QualityDimension, unit: string,
    denominator: string, evidence: MetricDefinition["evidence"],
    knots: MetricDefinition["knots"] = PERCENT_KNOTS): MetricDefinition {
    return { id, name, dimension, unit, denominator, evidence, knots, direction: "lower",
        roles: dimension === "test_integrity" ? ["test"] : ["product"],
        languages: ["javascript", "typescript"],
        limitations: ["A score describes the declared measurement contract, not all possible program behavior."] };
}

export const METRIC_CATALOG: readonly MetricDefinition[] = [
    metric("cyclomatic", "Cyclomatic complexity", "structure", "branches", "exclusive syntax-token exposure", "syntax", [[1, 0], [5, 0], [15, .25], [25, .6], [50, 1]]),
    metric("cognitive", "Cognitive complexity", "structure", "cognitive points", "exclusive syntax-token exposure", "syntax", [[0, 0], [5, 0], [15, .25], [30, .65], [60, 1]]),
    metric("tokens", "Function syntax tokens", "structure", "syntax tokens", "exclusive syntax-token exposure", "syntax", [[0, 0], [150, 0], [300, .2], [500, .5], [1000, 1]]),
    metric("difficulty", "Halstead difficulty", "structure", "difficulty", "exclusive syntax-token exposure; volume floor 200", "syntax", [[0, 0], [20, 0], [40, .25], [80, .65], [160, 1]]),
    metric("file.lines", "File length", "file_size", "physical lines", "product files weighted by syntax tokens", "syntax", SIZE_KNOTS),
    metric("file.top_level", "Top-level executable burden", "file_size", "executable syntax tokens", "product files weighted by syntax tokens", "syntax", [[0, 0], [100, 0], [500, .5], [1000, 1]]),
    metric("coverage.lines", "Uncovered lines", "coverage", "percent", "instrumented executable lines", "coverage", [[0, 0], [5, .2], [20, .5], [100, 1]]),
    metric("coverage.branches", "Uncovered branches", "coverage", "percent", "instrumented branch outcomes", "coverage", [[0, 0], [5, .2], [20, .5], [100, 1]]),
    metric("coverage.functions", "Uncalled functions", "coverage", "percent", "instrumented functions", "coverage", [[0, 0], [5, .2], [20, .5], [100, 1]]),
    metric("coverage.crap", "CRAP", "coverage", "CRAP points", "functions with matching coverage spans", "coverage", [[0, 0], [5, 0], [25, .5], [100, 1]]),
    metric("mutation.survivors", "Surviving mutants", "mutation", "percent", "killed plus surviving mutants", "mutation", [[0, 0], [5, .2], [20, .5], [100, 1]]),
    metric("mutation.uncovered", "Uncovered mutation sites", "mutation", "percent", "killed, surviving and no-coverage mutants", "mutation", [[0, 0], [5, .2], [20, .5], [100, 1]]),
    metric("tests.integrity", "Test integrity findings", "test_integrity", "percent", "parsed test cases with unique findings", "syntax"),
    metric("redundancy.unused", "Unreferenced declarations", "redundancy", "percent", "product declarations", "graph"),
    metric("redundancy.disconnected", "Disconnected modules", "redundancy", "percent", "product modules", "graph"),
    metric("redundancy.clones", "Duplicate implementations", "redundancy", "percent", "exclusively owned function syntax tokens", "syntax"),
    metric("redundancy.dead_stores", "Overwritten initial values", "redundancy", "percent", "local initializers", "syntax"),
    metric("types.unsafe", "Unsafe type operations", "types", "percent", "typed property access, call and assertion sites", "typed"),
    metric("architecture.cycles", "Modules in dependency cycles", "architecture", "percent", "product modules", "graph"),
    metric("architecture.reach", "Dependency propagation", "architecture", "percent", "ordered pairs of distinct product modules", "graph", [[0, 0], [5, 0], [25, .5], [100, 1]]),
    metric("architecture.boundaries", "Declared boundary violations", "architecture", "percent", "resolved product import edges", "graph"),
    metric("correctness.findings", "Correctness and security findings", "correctness", "percent", "executable statements with unique findings", "checks"),
    metric("contracts.findings", "Executable contract findings", "contracts", "percent", "evaluated contract assertions", "checks"),
];
