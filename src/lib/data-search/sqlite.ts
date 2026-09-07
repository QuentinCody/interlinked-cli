import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openNodeSqlite, type SqliteDatabase } from "../../harness/mutation/mutation-journal-driver.js";
import { isJsonObject } from "../json-types.js";
import { corpusRecords, evidenceHash, readCorpus, scanCorpus, verifyCorpus } from "./corpus.js";
import { createPrivateDirectory } from "./snapshot.js";
import { compactSqlFilter, unpackSqlRecord } from "./sqlite-query.js";
import { QUERY_DIMENSIONS, emptyCoverage, type CorpusFile, type EvidenceCorpus, type EvidenceAnswer, type EvidenceQuery, type EvidenceRecord, type SearchCoverage } from "./types.js";
import { dataRow, dataString } from "../data/index-source.js";

export interface CompactIndexReceipt {
    version: 1; corpusHash: string; corpusRoot: string; tenant: string; project: string;
    indexed: number; coverage: SearchCoverage; capacityReached: boolean;
    diskBudget: number; databaseLimit: number; bytes: number; buildMs: number;
    corpusFiles: CorpusFile[];
}
export function directoryBytes(root: string): number {
    let bytes = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        bytes += entry.isDirectory() ? directoryBytes(path) : lstatSync(path).size;
    }
    return bytes;
}
function initializeCompact(db: SqliteDatabase, diskBudget: number): number {
    if (!Number.isSafeInteger(diskBudget) || diskBudget < 256 * 1024) throw new Error("index disk budget must be at least 256 KiB");
    const pageSize = 4096;
    // Reserve a second database-sized rollback journal plus 64 KiB for headers/receipt.
    const pages = Math.floor((diskBudget - 64 * 1024) / (2 * pageSize));
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${pages};`);
    db.exec(`CREATE TABLE IF NOT EXISTS records (rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        ${QUERY_DIMENSIONS.map((key) => `${key} TEXT`).join(",")}, time REAL, text TEXT NOT NULL, extra TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_session ON records(tenant,project,session,time);
        CREATE INDEX IF NOT EXISTS records_source ON records(tenant,project,source,time);
        CREATE INDEX IF NOT EXISTS records_time ON records(time);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text,content='records',content_rowid='rid');`);
    return pages * pageSize;
}
function insertCompactRecord(db: SqliteDatabase, record: EvidenceRecord): void {
    const { id, time, text, ...rest } = record;
    const extra: Record<string, unknown> = { ...rest };
    for (const key of QUERY_DIMENSIONS) delete extra[key];
    const names = ["id", ...QUERY_DIMENSIONS, "time", "text", "extra"];
    const result = db.prepare(`INSERT OR IGNORE INTO records(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
        .run(id, ...QUERY_DIMENSIONS.map((key) => record[key]), time, text, JSON.stringify(extra));
    if (Number(result.changes)) db.prepare("INSERT INTO fts(rowid,text) VALUES(?,?)").run(result.lastInsertRowid, text);
}
function insertCompactBatch(db: SqliteDatabase, records: EvidenceRecord[]): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
        for (const record of records) insertCompactRecord(db, record);
        db.exec("COMMIT");
        return true;
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Intentional: SQLITE_FULL may already have rolled back; the original failure below remains authoritative. */ }
        if (String(error).includes("database or disk is full")) return false;
        throw error;
    }
}
async function populateCompact(db: SqliteDatabase, root: string, coverage: SearchCoverage): Promise<boolean> {
    let batch: EvidenceRecord[] = [];
    for await (const record of corpusRecords(root, coverage)) {
        batch.push(record);
        if (batch.length < 50) continue;
        if (!insertCompactBatch(db, batch)) return true;
        batch = [];
    }
    return batch.length > 0 && !insertCompactBatch(db, batch);
}
function scalarCount(db: SqliteDatabase): number {
    const row = db.prepare("SELECT count(*) AS n FROM records").get();
    if (!isJsonObject(row) || typeof row.n !== "number") throw new Error("invalid SQLite count");
    return row.n;
}
function validateResume(output: string, corpus: EvidenceCorpus, diskBudget: number): void {
    const prior = compactIndexReceipt(output);
    if (prior.tenant !== corpus.tenant || prior.project !== corpus.project) throw new Error("index scope mismatch");
    if (!Array.isArray(prior.corpusFiles)) throw new Error("receipt lacks append provenance; build a new isolated index");
    for (const file of prior.corpusFiles) {
        if (!corpus.files.some((next) => next.path === file.path && next.source === file.source && next.sha256 === file.sha256)) throw new Error("resume requires immutable prior files plus new segments");
    }
    if (lstatSync(join(output, "index.sqlite")).size * 2 + 64 * 1024 > diskBudget) throw new Error("new disk budget cannot accommodate existing index and journal");
}
function publishReceipt(output: string, receipt: CompactIndexReceipt): void {
    const temporary = join(output, `receipt-${randomUUID()}.tmp`);
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (directoryBytes(output) + Buffer.byteLength(text) > receipt.diskBudget) throw new Error("index receipt would exceed disk budget; evidence retained");
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(output, "index.json"));
}
export async function buildCompactIndex(root: string, output: string, options: { diskBudget?: number; resume?: boolean } = {}): Promise<CompactIndexReceipt> {
    await verifyCorpus(root);
    const corpus = readCorpus(root);
    const start = performance.now();
    const diskBudget = options.diskBudget ?? 512 * 1024 * 1024;
    if (options.resume) validateResume(output, corpus, diskBudget);
    else createPrivateDirectory(output);
    const db = openNodeSqlite(join(output, "index.sqlite"));
    const coverage = emptyCoverage();
    let receipt: CompactIndexReceipt;
    try {
        const databaseLimit = initializeCompact(db, diskBudget);
        const capacityReached = await populateCompact(db, root, coverage);
        coverage.complete &&= !capacityReached;
        receipt = { version: 1, corpusHash: evidenceHash(JSON.stringify(corpus)), corpusRoot: root, tenant: corpus.tenant, project: corpus.project,
            indexed: scalarCount(db), coverage, capacityReached, diskBudget, databaseLimit, bytes: 0, buildMs: performance.now() - start, corpusFiles: corpus.files };
    } finally { db.close(); }
    receipt.bytes = directoryBytes(output);
    publishReceipt(output, receipt);
    receipt.bytes = directoryBytes(output);
    if (receipt.bytes > diskBudget) throw new Error("index exceeded reserved disk budget");
    return receipt;
}
export function compactIndexReceipt(root: string): CompactIndexReceipt {
    const path = join(root, "index.json");
    if (!existsSync(path) || lstatSync(path).size > 1024 * 1024) throw new Error("missing or oversized index receipt");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.coverage)) throw new Error("invalid index receipt");
    // SAFETY: private receipt is emitted by buildCompactIndex; query validates bound scope separately.
    return value as unknown as CompactIndexReceipt;
}
export function searchCompactIndex(root: string, query: EvidenceQuery): EvidenceAnswer {
    const receipt = compactIndexReceipt(root);
    const filter = compactSqlFilter(query);
    const db = openNodeSqlite(join(root, "index.sqlite"));
    try {
        db.exec("PRAGMA query_only=ON");
        const ids = db.prepare(`SELECT r.id FROM records r WHERE ${filter.where} ORDER BY r.id`).all(...filter.values).map((row) => dataString(dataRow(row), "id"));
        const rows = db.prepare(`SELECT r.* FROM records r WHERE ${filter.where} ORDER BY r.time DESC,r.id LIMIT ? OFFSET ?`)
            .all(...filter.values, query.limit ?? 20, query.offset ?? 0).map(unpackSqlRecord);
        return { engine: "compact", ids, rows, total: ids.length, coverage: { ...receipt.coverage, records: receipt.indexed, bytes: 0 } };
    } finally { db.close(); }
}
export async function searchBoundedIndex(root: string, corpus: string, query: EvidenceQuery): Promise<EvidenceAnswer> {
    const receipt = compactIndexReceipt(root);
    if (!receipt.coverage.complete || receipt.corpusHash !== evidenceHash(JSON.stringify(readCorpus(corpus)))) {
        const result = await scanCorpus(corpus, query);
        return { ...result, engine: "bounded-scan-fallback" };
    }
    return { ...searchCompactIndex(root, query), engine: "bounded-index" };
}
