import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_CATALOG } from "../data/catalog.js";
import { indexData, type DataIndexProgress } from "../data/indexer.js";
import { openDataIndex, type DataIndexDatabase } from "../data/index-schema.js";
import { dataRow, dataString } from "../data/index-source.js";
import { readDataLines } from "../data/stream.js";
import { corpusPath, evidenceHash, readCorpus, verifyCorpus } from "./corpus.js";
import { createPrivateDirectory, writeCorpusManifest } from "./snapshot.js";
import { compareEvidence, EvidenceResults, queryTerms, validateEvidenceQuery } from "./query.js";
import { emptyCoverage, type EvidenceCorpus, type EvidenceAnswer, type EvidenceQuery, type EvidenceRecord } from "./types.js";
import { directoryBytes } from "./sqlite.js";

function openLegacySource(output: string, name: string): number {
    const relativePath = DATA_CATALOG.find((source) => source.name === name)?.path ?? name;
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("invalid legacy source path");
    const target = join(output, ".interlinked", relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    return openSync(target, "wx", 0o600);
}

/** Executes the existing production importer/schema in an isolated project, not a lookalike. */
export async function buildLegacyIndex(corpusRoot: string, output: string): Promise<{ indexing: DataIndexProgress; bytes: number; sourceBytes: number }> {
    await verifyCorpus(corpusRoot);
    createPrivateDirectory(output);
    const corpus = readCorpus(corpusRoot);
    mkdirSync(join(output, ".interlinked"), { mode: 0o700 });
    const handles = new Map<string, number>();
    let sourceBytes = 0;
    try {
        for (const file of corpus.files) {
            let fd = handles.get(file.source);
            if (fd === undefined) { fd = openLegacySource(output, file.source); handles.set(file.source, fd); }
            for await (const line of readDataLines(corpusPath(corpusRoot, file.path))) {
                if (line.text === undefined) throw new Error("legacy snapshot contains an oversized line");
                const raw = `${line.text}${line.complete ? "\n" : ""}`;
                sourceBytes += Buffer.byteLength(raw); writeSync(fd, file.source.endsWith(".gz") ? gzipSync(raw) : Buffer.from(raw));
            }
        }
    } finally { for (const fd of handles.values()) closeSync(fd); }
    writeCorpusManifest(output, corpus);
    const indexing = await indexData(output, { maxBytes: Number.MAX_SAFE_INTEGER, maxRecords: Number.MAX_SAFE_INTEGER, normalizationRoot: "/" });
    return { indexing, bytes: directoryBytes(join(output, ".interlinked", "index")), sourceBytes };
}

function legacyFilter(query: EvidenceQuery): { where: string; values: Array<string | number> } {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const columns = { source: "source", category: "category", session: "session", actor: "actor", provider: "provider", model: "model", call: "call_id", kind: "kind", decision: "decision", origin: "origin" } as const;
    for (const key of Object.keys(columns) as Array<keyof typeof columns>) {
        if (query[key] !== undefined) { clauses.push(`r.${columns[key]}=?`); values.push(query[key]); }
    }
    if (query.since !== undefined) { clauses.push("r.event_ms>=?"); values.push(query.since); }
    if (query.until !== undefined) { clauses.push("r.event_ms<=?"); values.push(query.until); }
    if (query.file !== undefined) { clauses.push("EXISTS(SELECT 1 FROM data_files WHERE record_id=r.id AND file=?)"); values.push(query.file); }
    if (query.check !== undefined) { clauses.push("EXISTS(SELECT 1 FROM data_checks WHERE record_id=r.id AND check_id=?)"); values.push(query.check); }
    for (const term of queryTerms(query)) { clauses.push("instr(lower(r.text),?)>0"); values.push(term); }
    return { where: clauses.join(" AND ") || "1=1", values };
}
export function searchLegacyIndex(root: string, query: EvidenceQuery): EvidenceAnswer {
    validateEvidenceQuery(query);
    const corpus = readCorpus(root);
    const coverage = emptyCoverage();
    const results = new EvidenceResults(query);
    if (query.tenant !== undefined && query.tenant !== corpus.tenant) return results.answer("legacy", coverage);
    if (query.project !== undefined && query.project !== corpus.project) return results.answer("legacy", coverage);
    const db = openDataIndex(root, { readOnly: true });
    const filter = legacyFilter(query);
    try {
        const status = db.prepare("SELECT count(*) n FROM data_sources WHERE status!='complete' OR malformed>0 OR oversized>0").get();
        coverage.complete = dataRow(status).n === 0;
        const matches = db.prepare(`SELECT r.id,r.source,r.raw_hash,r.event_ms FROM data_records r WHERE ${filter.where}`).all(...filter.values).map((value) => {
            const row = dataRow(value);
            return { legacyId: dataString(row, "id"), id: evidenceHash(`${corpus.tenant}\0${corpus.project}\0${dataString(row, "source")}\0${dataString(row, "raw_hash")}`), time: typeof row.event_ms === "number" ? row.event_ms : null };
        }).sort(compareEvidence);
        const offset = query.offset ?? 0;
        const rows = matches.slice(offset, offset + (query.limit ?? 20)).map((match) => hydrateLegacyRecord(db, corpus, match.legacyId));
        coverage.records = matches.length;
        return { engine: "legacy", ids: matches.map((match) => match.id).sort(), rows, total: matches.length, coverage };
    } finally { db.close(); }
}
function hydrateLegacyRecord(db: DataIndexDatabase, corpus: EvidenceCorpus, id: string): EvidenceRecord {
    const row = dataRow(db.prepare("SELECT * FROM data_records WHERE id=?").get(id));
    const hash = dataString(row, "raw_hash");
    const source = dataString(row, "source");
    return { id: evidenceHash(`${corpus.tenant}\0${corpus.project}\0${source}\0${hash}`), hash, source,
        category: dataString(row, "category"), tenant: corpus.tenant, project: corpus.project,
        session: nullableString(row.session), actor: nullableString(row.actor), provider: nullableString(row.provider), model: nullableString(row.model),
        call: nullableString(row.call_id), kind: nullableString(row.kind), decision: nullableString(row.decision), origin: dataString(row, "origin"),
        time: typeof row.event_ms === "number" ? row.event_ms : null, text: dataString(row, "text"), truncated: row.text_truncated === 1,
        files: db.prepare("SELECT file FROM data_files WHERE record_id=?").all(id).map((file) => dataString(dataRow(file), "file")),
        checks: db.prepare("SELECT check_id FROM data_checks WHERE record_id=?").all(id).map((check) => dataString(dataRow(check), "check_id")),
        path: "", offset: 0, end: 0 };
}
function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
