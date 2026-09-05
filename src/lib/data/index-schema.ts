import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqlite, type SqliteDatabase } from "../../harness/mutation/mutation-journal-driver.js";
import { getDataDir } from "../config.js";
import { isJsonObject } from "../json-types.js";

export type DataIndexDatabase = SqliteDatabase;

export function dataIndexPath(cwd: string): string {
    return join(getDataDir(cwd), "index", "data", "search.sqlite");
}

function prepareIndexDirectory(cwd: string): string {
    mkdirSync(getDataDir(cwd), { recursive: true, mode: 0o700 });
    let parent = realpathSync(getDataDir(cwd));
    for (const name of ["index", "data"]) {
        parent = join(parent, name);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        if (lstatSync(parent).isSymbolicLink()) throw new Error(`data index directory is a symlink: ${parent}`);
    }
    const path = join(parent, "search.sqlite");
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("data index database is a symlink");
    return path;
}

/** Reuses the lazy built-in driver; ordinary CLI commands do not load SQLite. */
export function openDataIndex(cwd: string, options: { readOnly?: boolean } = {}): DataIndexDatabase {
    const path = prepareIndexDirectory(cwd);
    const db = openNodeSqlite(path);
    try {
        db.exec("PRAGMA busy_timeout=5000;");
        if (options.readOnly) {
            db.exec("PRAGMA query_only=ON;");
            assertIndexVersion(db);
            return db;
        }
        chmodSync(path, 0o600);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        db.exec("CREATE TABLE IF NOT EXISTS data_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT OR IGNORE INTO data_meta VALUES ('schema_version','1');");
        assertIndexVersion(db);
        db.exec(DATA_INDEX_SCHEMA);
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

function assertIndexVersion(db: DataIndexDatabase): void {
    const version = db.prepare("SELECT value FROM data_meta WHERE key='schema_version'").get();
    if (!isJsonObject(version) || version.value !== "1") throw new Error("unsupported data index schema version; use the matching CLI version");
}

/** Only derived tables are cleared. Raw sources and their audit history are untouched. */
export function clearDataIndex(db: DataIndexDatabase): void {
    dataTransaction(db, () => {
        for (const table of ["data_text", "data_files", "data_checks", "data_locations", "data_parse_errors", "data_fields", "data_records", "data_heads", "data_source_anchors", "data_sources"]) db.exec(`DELETE FROM ${table}`);
    });
}

export function dataTransaction<T>(db: DataIndexDatabase, run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = run();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

const DATA_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS data_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO data_meta VALUES ('schema_version', '1');
CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, logical_name TEXT NOT NULL,
    identity TEXT NOT NULL, head_bytes INTEGER NOT NULL, head_hash TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL, modified_ms REAL NOT NULL,
    archived INTEGER NOT NULL, compressed INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 1,
    indexed_at TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
    malformed INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS data_sources_path ON data_sources(path, retained);
CREATE TABLE IF NOT EXISTS data_source_anchors (source_id TEXT PRIMARY KEY REFERENCES data_sources(id), start INTEGER NOT NULL, bytes INTEGER NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS data_heads (path TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id));
CREATE TABLE IF NOT EXISTS data_records (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, category TEXT NOT NULL, role TEXT NOT NULL,
    schema_name TEXT, event_ms REAL, ingested_at TEXT NOT NULL,
    session TEXT, actor TEXT, parent_actor TEXT, provider TEXT, model TEXT, call_id TEXT,
    kind TEXT, phase TEXT, tool TEXT, decision TEXT, origin TEXT NOT NULL,
    text TEXT NOT NULL, text_truncated INTEGER NOT NULL,
    raw_hash TEXT NOT NULL, raw_bytes INTEGER NOT NULL,
    input_tokens REAL, output_tokens REAL, cache_read_tokens REAL,
    row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS data_records_time ON data_records(event_ms);
CREATE INDEX IF NOT EXISTS data_records_coverage ON data_records(event_ms, origin, text_truncated);
CREATE INDEX IF NOT EXISTS data_records_session ON data_records(session, event_ms);
CREATE INDEX IF NOT EXISTS data_records_actor ON data_records(actor, event_ms);
CREATE INDEX IF NOT EXISTS data_records_source ON data_records(source, event_ms);
CREATE INDEX IF NOT EXISTS data_records_category ON data_records(category, event_ms);
CREATE INDEX IF NOT EXISTS data_records_call ON data_records(session, call_id);
CREATE TABLE IF NOT EXISTS data_locations (
    source_id TEXT NOT NULL REFERENCES data_sources(id), offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL, record_id TEXT NOT NULL REFERENCES data_records(id),
    PRIMARY KEY (source_id, offset)
);
CREATE INDEX IF NOT EXISTS data_locations_record ON data_locations(record_id);
CREATE TABLE IF NOT EXISTS data_files (
    record_id TEXT NOT NULL REFERENCES data_records(id), file TEXT NOT NULL,
    PRIMARY KEY (record_id, file)
);
CREATE INDEX IF NOT EXISTS data_files_path ON data_files(file, record_id);
CREATE TABLE IF NOT EXISTS data_checks (
    record_id TEXT NOT NULL REFERENCES data_records(id), check_id TEXT NOT NULL,
    status TEXT NOT NULL, severity TEXT, PRIMARY KEY (record_id, check_id, status)
);
CREATE INDEX IF NOT EXISTS data_checks_id ON data_checks(check_id, record_id);
CREATE TABLE IF NOT EXISTS data_fields (
    source TEXT NOT NULL, path TEXT NOT NULL, value_type TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source, path, value_type)
);
CREATE TABLE IF NOT EXISTS data_parse_errors (
    source_id TEXT NOT NULL REFERENCES data_sources(id), offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
    PRIMARY KEY (source_id, offset)
);
CREATE VIRTUAL TABLE IF NOT EXISTS data_text USING fts5(record_id UNINDEXED, text, tokenize='unicode61');
`;
