import { getOutputMode, output, outputError } from "../lib/output.js";
import { measureCorpus } from "../lib/metrics/corpus.js";
import type { MetricsAnalysisOptions } from "./metrics-analysis.js";

export interface MetricsCorpusOptions extends MetricsAnalysisOptions { out: string; }
export async function metricsCorpusCommand(manifest: string, options: MetricsCorpusOptions): Promise<void> {
    try {
        const result = await measureCorpus({ manifest, out: options.out, progress: (name, index, total) => process.stderr.write(`[${index}/${total}] ${name}\n`) });
        output(getOutputMode(options), result, { normal: () => result.repositories.map(row => `${row.name}: ${row.observedScore ?? "unavailable"}/100 observed; ${row.evidenceCompleteness ?? 0}% evidence; ${row.status}`).join("\n"),
            short: () => `${result.repositories.length} repositories; uniform profile=${result.uniformProfile}; no model calls` });
        if (result.repositories.some(row => row.status === "failed")) process.exitCode = 1;
    } catch (error) { outputError(getOutputMode(options), error instanceof Error ? error.message : "Corpus measurement failed"); }
}
