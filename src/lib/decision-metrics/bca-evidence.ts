import { measureBca } from "./bca.js";
import { revisionFile, resolveRevision, workingFile } from "./git-evidence.js";
import { digest } from "./store.js";
import type { EvidenceRecord, Json } from "./types.js";

export async function enrichBca(
    root: string,
    records: EvidenceRecord[],
    options: { command: string; version: string; revision?: string; deadline: number },
): Promise<EvidenceRecord[]> {
    const revision = options.revision ? resolveRevision(root, options.revision) : null;
    const results = new Map<string, Awaited<ReturnType<typeof measureBca>>>();
    for (const file of new Set(
        records.filter((row) => row.unit === "function").map((row) => row.file),
    )) {
        const content = revision ? revisionFile(root, revision, file) : workingFile(root, file);
        if (
            records.some(
                (row) => row.file === file && row.provenance.sourceHash !== digest(content),
            )
        )
            throw new Error("source changed before bca enrichment");
        results.set(
            file,
            await measureBca(
                { file, content },
                {
                    command: options.command,
                    expectedVersion: options.version,
                    deadline: options.deadline,
                },
            ),
        );
    }
    return records.map((row) => {
        const result = results.get(row.file);
        const measured = result?.functions.find((fn) => fn.startLine === row.line);
        if (!result || !measured || row.unit !== "function") return row;
        const metrics = row.evidence.metrics;
        const native: Record<string, Json> =
            metrics !== null && typeof metrics === "object" && !Array.isArray(metrics)
                ? metrics
                : {};
        return {
            ...row,
            evidence: {
                ...row.evidence,
                metrics: { ...native, bca: measured.metrics },
                bca: {
                    version: result.version,
                    configuration: result.config,
                    sourceHash: result.sourceHash,
                },
            },
            provenance: {
                ...row.provenance,
                metricsVersion: `${row.provenance.metricsVersion}|bca:${result.version}`,
            },
        };
    });
}
