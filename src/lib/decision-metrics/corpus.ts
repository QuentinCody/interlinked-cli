import { join, posix } from "node:path";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { extractChangedEvidence } from "./evidence.js";
import { gitText, resolveRevision, revisionFile } from "./git-evidence.js";
import { retrieve, type HistoryDocument } from "./retrieval.js";
import { embedInputs } from "./runtime.js";
import { digest } from "./store.js";
import type { DecisionConfig, EvidenceRecord, Json } from "./types.js";

export interface DecisionCorpusSnapshot {
    version: 1;
    revision: string;
    records: EvidenceRecord[];
    discoveredFiles: number;
    scannedFiles: number;
    unavailableFiles: string[];
}

function dependencies(content: string, file: string, files: Set<string>): string[] {
    const parsed = parseTsSource(content, file);
    if (!parsed) return [];
    const imports = parsed.sf.statements
        .filter(parsed.ts.isImportDeclaration)
        .map((statement) =>
            parsed.ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : "",
        );
    const result: string[] = [];
    for (const specifier of imports.filter((value) => value.startsWith("."))) {
        const path = posix.normalize(posix.join(posix.dirname(file), specifier));
        const base = path.replace(/\.[cm]?js$/, "");
        const candidate = [
            path,
            `${base}.ts`,
            `${base}.tsx`,
            `${base}.js`,
            `${path}/index.ts`,
        ].find((value) => files.has(value));
        if (candidate) result.push(candidate);
    }
    return result;
}

export function snapshotRepository(
    root: string,
    options: { revision?: string; maxFiles?: number } = {},
): DecisionCorpusSnapshot {
    const revision = resolveRevision(root, options.revision ?? "HEAD");
    const all = gitText(root, ["ls-tree", "-r", "--name-only", "-z", revision])
        .split("\0")
        .filter((file) => /\.[cm]?[jt]sx?$|\.py$/.test(file));
    const files = all.filter(
        (file) => !/(?:^|\/)(?:vendor|dist|node_modules|scratch)\//.test(file),
    );
    const maxFiles = options.maxFiles ?? 2000;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000)
        throw new Error("snapshot file budget must be 1..10000");
    const timestamp = gitText(root, ["show", "-s", "--format=%cI", revision]).trim();
    const records: EvidenceRecord[] = [];
    const unavailableFiles: string[] = [];
    for (const file of files.slice(0, maxFiles)) {
        try {
            const content = revisionFile(root, revision, file);
            const units = extractChangedEvidence({
                file,
                before: "",
                after: content,
                diff: "",
                repository: root,
                revision,
                timestamp,
                message: "",
                allFunctions: true,
            });
            const edges = dependencies(content, file, new Set(files));
            for (const unit of units) unit.evidence.dependencies = edges;
            records.push(...units);
        } catch {
            unavailableFiles.push(file);
        }
    }
    return {
        version: 1,
        revision,
        records,
        discoveredFiles: files.length,
        scannedFiles: Math.min(maxFiles, files.length),
        unavailableFiles: [...unavailableFiles, ...files.slice(maxFiles)],
    };
}

function candidateSources(change: EvidenceRecord, consumer: EvidenceRecord): string[] {
    const sources: string[] = [];
    const dependencies = consumer.evidence.dependencies;
    if (Array.isArray(dependencies) && dependencies.includes(change.file)) sources.push("import");
    const symbol = change.evidence.signature;
    const symbols = change.evidence.symbols;
    if (
        typeof symbol === "string" &&
        symbol &&
        String(consumer.evidence.body ?? "").includes(symbol)
    )
        sources.push("lexical-symbol");
    if (
        Array.isArray(symbols) &&
        symbols.some(
            (name) =>
                typeof name === "string" && String(consumer.evidence.body ?? "").includes(name),
        )
    )
        sources.push("declaration-symbol");
    const cochange = change.evidence.coChangedFiles;
    if (Array.isArray(cochange) && cochange.includes(consumer.file))
        sources.push("historical-cochange");
    const retrieved = change.evidence.candidateIds;
    if (Array.isArray(retrieved) && retrieved.includes(consumer.id)) sources.push("retrieval");
    return sources;
}

export function candidateConsumers(
    changes: EvidenceRecord[],
    consumers: EvidenceRecord[],
): EvidenceRecord[] {
    if (changes.length * consumers.length > 50000)
        throw new Error("candidate population exceeds 50000 pairs; partition explicitly");
    return changes.flatMap((change) =>
        consumers
            .filter(
                (consumer) =>
                    consumer.id !== change.id && consumer.id !== change.evidence.originalUnit,
            )
            .map((consumer) => {
                const sources = candidateSources(change, consumer);
                const evidence: Record<string, Json> = {
                    change: change.evidence,
                    consumer: consumer.evidence,
                    candidateSources: sources,
                    verification: consumer.evidence.verification ?? [],
                };
                if (Date.parse(consumer.timestamp) > Date.parse(change.timestamp))
                    return {
                        ...change,
                        id: `${change.id}×${consumer.id}`,
                        unit: "pair" as const,
                        evidence,
                        eligible: false,
                        reason: "future consumer snapshot excluded",
                    };
                return {
                    ...change,
                    id: `${change.id}×${consumer.id}`,
                    unit: "pair" as const,
                    evidence,
                    eligible: sources.length > 0,
                    ...(sources.length
                        ? {}
                        : { reason: "consumer not retrieved by configured candidate sources" }),
                };
            }),
    );
}

export function historyDocuments(records: EvidenceRecord[]): HistoryDocument[] {
    return records.map((record) => {
        if (typeof record.evidence.fixCommit !== "string" || !record.evidence.fixCommit)
            throw new Error("historical neighbor requires fixCommit provenance");
        return {
            id: record.id,
            text: String(record.evidence.body ?? record.evidence.hunk ?? ""),
            timestamp: record.timestamp,
            fixCommit: record.evidence.fixCommit,
            sourceHash: digest(String(record.evidence.body ?? record.evidence.hunk ?? "")),
            file: record.file,
            labelSource: String(record.evidence.labelSource ?? "unadjudicated"),
        };
    });
}

export async function augmentWithHistory(
    records: EvidenceRecord[],
    corpus: EvidenceRecord[],
    config: DecisionConfig,
    method: "lexical" | "embedding" | "hybrid",
    root?: string,
): Promise<{ records: EvidenceRecord[]; modelIdentity: string | null }> {
    const docs = historyDocuments(corpus);
    let vectors: number[][] = [],
        modelIdentity: string | null = null;
    const texts = records.map((record) =>
        String(record.evidence.body ?? record.evidence.hunk ?? ""),
    );
    if (method !== "lexical") {
        const result = await embedInputs(
            config,
            [
                ...docs.map((doc) => ({
                    text: doc.text,
                    title: doc.file ?? "none",
                    role: "document" as const,
                })),
                ...texts.map((text) => ({ text, role: "query" as const })),
            ],
            Date.now() + config.deadlineMs,
            root ? join(root, ".interlinked", "decision-metrics", "embeddings") : undefined,
        );
        vectors = result.vectors.slice(docs.length);
        modelIdentity = result.identity;
        for (const [i, doc] of docs.entries()) doc.vector = result.vectors[i]!;
    }
    return {
        modelIdentity,
        records: records.map((record, i) => {
            const query = {
                text: texts[i]!,
                timestamp: record.timestamp,
                sourceHash: digest(texts[i]!),
                ...(vectors[i] ? { vector: vectors[i] } : {}),
            };
            const result = retrieve(query, docs, { method, top: 3 });
            const neighbours = result.results.map((row) => ({
                id: row.document.id,
                text: row.document.text,
                fixCommit: row.document.fixCommit,
                timestamp: row.document.timestamp,
                score: row.score,
                labelSource: row.document.labelSource ?? "unadjudicated",
            }));
            return {
                ...record,
                evidence: {
                    ...record.evidence,
                    neighbours,
                    retrieval: {
                        method,
                        eligible: result.eligible,
                        selected: neighbours.length,
                        modelIdentity,
                        coverageMeaning: result.coverageMeaning,
                    },
                },
            };
        }),
    };
}
