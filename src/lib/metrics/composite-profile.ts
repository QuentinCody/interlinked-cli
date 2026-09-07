import type { QualityDimension } from "./measurement-types.js";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { hashBytes } from "./inventory.js";

export interface CompositeGroup { id: string; dimension: QualityDimension; weight: number; method: "mean" | "maximum"; metrics: Readonly<Record<string, number>>; rationale: string; }
export const COMPOSITE_GROUPS: readonly CompositeGroup[] = [
    { id: "structure", dimension: "structure", weight: 20, method: "mean", metrics: { cyclomatic: .25, cognitive: .25, tokens: 5 / 18, difficulty: 2 / 9 }, rationale: "Related function metrics share one fixed 20-point budget; each already blends mean and tail burden." },
    { id: "file_size", dimension: "file_size", weight: 10, method: "mean", metrics: { "file.lines": .5, "file.top_level": .5 }, rationale: "File length and code outside functions share a bounded budget." },
    { id: "coverage", dimension: "coverage", weight: 15, method: "mean", metrics: { "coverage.lines": .3, "coverage.branches": .5, "coverage.functions": .2 }, rationale: "Branch outcomes receive the largest share; missing instrumentation is an evidence gap." },
    { id: "mutation", dimension: "mutation", weight: 15, method: "mean", metrics: { "mutation.survivors": 1 }, rationale: "Only killed and surviving mutants establish assertion discrimination; timeouts are not kills." },
    { id: "test_integrity", dimension: "test_integrity", weight: 10, method: "mean", metrics: { "tests.integrity": 1 }, rationale: "Multiple findings on one test count as one affected opportunity." },
    { id: "unreferenced", dimension: "redundancy", weight: 5, method: "maximum", metrics: { "redundancy.unused": 1, "redundancy.disconnected": 1 }, rationale: "Unreferenced declarations and disconnected modules overlap; use their maximum, not their sum." },
    { id: "clones", dimension: "redundancy", weight: 3, method: "mean", metrics: { "redundancy.clones": 1 }, rationale: "Charge only repeated exclusive exposure after retaining one representative." },
    { id: "dead_stores", dimension: "redundancy", weight: 2, method: "mean", metrics: { "redundancy.dead_stores": 1 }, rationale: "Overwritten initializer candidates have a separate, small budget." },
    { id: "types", dimension: "types", weight: 5, method: "mean", metrics: { "types.unsafe": 1 }, rationale: "Unsafe operations are scored; declaring unknown is not a defect." },
    { id: "graph", dimension: "architecture", weight: 5, method: "maximum", metrics: { "architecture.cycles": 1, "architecture.reach": 1 }, rationale: "Cycles and propagation share graph edges; use their maximum to limit overlap." },
    { id: "boundaries", dimension: "architecture", weight: 2, method: "mean", metrics: { "architecture.boundaries": 1 }, rationale: "Evaluate only declared import boundaries." },
    { id: "correctness", dimension: "correctness", weight: 5, method: "mean", metrics: { "correctness.findings": 1 }, rationale: "Reviewed correctness/security detectors share one affected-statement denominator." },
    { id: "contracts", dimension: "contracts", weight: 3, method: "mean", metrics: { "contracts.findings": 1 }, rationale: "Only declared executable contracts supply opportunities; prose is not silently treated as passing." },
];

export const COMPOSITE_PROFILE = {
    id: "interlinked-slop-v1", version: 1, direction: "lower-is-better", groups: COMPOSITE_GROUPS,
    diagnosticOnly: { "coverage.crap": "Derived from complexity and coverage, already scored", "mutation.uncovered": "Overlaps uncovered execution; cannot stand in for assertion discrimination" },
    syntaxTokenGate: { limit: 500, grandfathering: "hold-or-shrink", independentOfScore: true },
    calibration: "experimental-policy; deterministic measurements do not establish universal architecture quality",
    hash: hashBytes(JSON.stringify([COMPOSITE_GROUPS, METRIC_CATALOG])),
} as const;
