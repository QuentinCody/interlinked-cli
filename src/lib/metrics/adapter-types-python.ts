import type { RepositoryAnalysis } from "./analysis.js";
import { emptyReading, qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult, MetricReading } from "./measurement-types.js";

const PYTHON_LIMITATION = "Python reading: explicit `Any` in annotations over annotated parameters, returns and variables; no Python type checker runs, so unannotated code is not an opportunity.";

function detail(reading: MetricReading, key: string): number { return reading.details?.[key] ?? 0; }

/** Folds the Python reading (explicit `Any` annotations) into the TypeScript `types.unsafe` result. TypeScript-only repositories pass through untouched. */
export function mergePythonTypes(typescript: AdapterResult, analysis: RepositoryAnalysis): AdapterResult {
    const files = analysis.files.filter(file => file.python && file.input.role === "product");
    const base = typescript.metrics.find(metric => metric.id === "types.unsafe");
    if (!files.length || !base) return typescript;
    const slots = files.reduce((sum, file) => sum + (file.python?.row.annotationSlots ?? 0), 0);
    const findings = files.flatMap(file => (file.python?.row.anyLines ?? []).map(line => qualityFinding({ metric: "types.unsafe", file: file.input, line,
        message: "Explicit Any annotation removes type checking at this boundary" })));
    const others = typescript.findings;
    if (base.state !== "not-applicable" && (base.numerator === null || base.denominator === null)) {
        return { metrics: typescript.metrics.map(metric => metric === base ? { ...base, limitations: [...base.limitations, "Python annotations were not combined with this reading."] } : metric), findings: others };
    }
    if (!slots && base.state === "not-applicable") {
        return { metrics: typescript.metrics.map(metric => metric === base ? emptyReading("types.unsafe", "not-applicable", 0, "Python product files carry no type annotations") : metric), findings: others };
    }
    const merged = ratioReading("types.unsafe", (base.numerator ?? 0) + findings.length, (base.denominator ?? 0) + slots);
    merged.details = { explicitAnyTypes: detail(base, "explicitAnyTypes") + findings.length, explicitUnknownTypes: detail(base, "explicitUnknownTypes"), unsafeOperations: detail(base, "unsafeOperations") + findings.length };
    merged.limitations = [...base.state === "not-applicable" ? [] : base.limitations, PYTHON_LIMITATION];
    if (base.state === "inconclusive") merged.state = "inconclusive";
    return { metrics: typescript.metrics.map(metric => metric === base ? merged : metric), findings: [...others, ...findings] };
}
