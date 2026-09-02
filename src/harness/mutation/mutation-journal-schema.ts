// ===========================================
// Durable mutation journal — schema + migrations
// ===========================================

import type { SqliteDatabase } from "./mutation-journal-driver.js";
import { MUTATION_JOURNAL_V1_SQL } from "./mutation-journal-schema-v1.js";

/** Public for migration/conformance tests and future backend implementations. */
export const MUTATION_JOURNAL_SCHEMA_VERSION = 9;

const V2_SQL = `
CREATE TABLE IF NOT EXISTS mutation_manifest_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 0),
    snapshot_json TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

ALTER TABLE mutation_manifest_snapshots ADD COLUMN base_version INTEGER;
ALTER TABLE mutation_manifest_snapshots ADD COLUMN committed_version INTEGER;
ALTER TABLE mutation_manifest_snapshots ADD COLUMN snapshot_sha256 TEXT;
`;

const V3_SQL = `
ALTER TABLE mutation_jobs ADD COLUMN next_attempt_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mutation_jobs ADD COLUMN retry_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mutation_jobs ADD COLUMN last_error TEXT;
ALTER TABLE mutation_jobs ADD COLUMN dead_lettered_at_ms INTEGER;

DROP INDEX IF EXISTS mutation_jobs_claimable;
CREATE INDEX mutation_jobs_claimable
ON mutation_jobs(status, dead_lettered_at_ms, next_attempt_at_ms, lease_expires_at_ms, created_at_ms);
`;

const V4_SQL = `
ALTER TABLE mutation_jobs ADD COLUMN dead_letter_token TEXT;
UPDATE mutation_jobs SET dead_letter_token = lower(hex(randomblob(16)))
WHERE dead_lettered_at_ms IS NOT NULL;
`;

const V5_SQL = `
ALTER TABLE mutation_jobs ADD COLUMN baseline_intent TEXT NOT NULL DEFAULT 'require_established'
CHECK (baseline_intent IN ('require_established', 'adopt_current'));
`;

const V6_SQL = `
CREATE TABLE mutation_evidence_bundles (
    evaluation_id INTEGER PRIMARY KEY REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    envelope_json TEXT NOT NULL,
    envelope_sha256 TEXT NOT NULL,
    acceptance_receipt_json TEXT NOT NULL,
    acceptance_receipt_sha256 TEXT NOT NULL,
    execution_receipt_json TEXT,
    execution_receipt_sha256 TEXT,
    terminalization_record_json TEXT,
    terminalization_record_sha256 TEXT,
    report_bytes BLOB,
    report_sha256 TEXT,
    CHECK (
        (execution_receipt_json IS NOT NULL AND execution_receipt_sha256 IS NOT NULL
            AND terminalization_record_json IS NULL AND terminalization_record_sha256 IS NULL)
        OR
        (execution_receipt_json IS NULL AND execution_receipt_sha256 IS NULL
            AND terminalization_record_json IS NOT NULL AND terminalization_record_sha256 IS NOT NULL)
    ),
    CHECK (
        (report_bytes IS NULL AND report_sha256 IS NULL)
        OR
        (typeof(report_bytes) = 'blob' AND report_sha256 IS NOT NULL)
    )
);
`;

const V7_SQL = `
CREATE TABLE mutation_onboarding_intents (
    job_key TEXT PRIMARY KEY,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'activated')),
    tenant TEXT NOT NULL,
    project TEXT NOT NULL,
    repository TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    target_file TEXT NOT NULL,
    request_bytes BLOB NOT NULL,
    request_sha256 TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
	source_artifact_format TEXT NOT NULL CHECK (source_artifact_format = 'git-archive-tar-v1'),
    source_artifact_bytes BLOB NOT NULL,
    source_artifact_sha256 TEXT NOT NULL,
    target_bytes BLOB NOT NULL,
    target_sha256 TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    changeset_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    acceptance_receipt_hash TEXT,
    activated_at_ms INTEGER,
    UNIQUE(repository, commit_sha, target_file),
    CHECK (
        (state = 'prepared' AND acceptance_receipt_hash IS NULL AND activated_at_ms IS NULL)
        OR
		(state = 'accepted' AND acceptance_receipt_hash IS NOT NULL AND activated_at_ms IS NULL)
		OR
        (state = 'activated' AND acceptance_receipt_hash IS NOT NULL AND activated_at_ms IS NOT NULL)
    ),
    CHECK (typeof(request_bytes) = 'blob'),
    CHECK (typeof(source_artifact_bytes) = 'blob'),
    CHECK (typeof(target_bytes) = 'blob')
);
`;

/** v8 deliberately does not copy the legacy singleton head. That row has no
 * authenticated tenant/project/repository binding, so attributing it during
 * migration would silently trust state that cannot prove its authority. */
const V8_SQL = `
CREATE TABLE IF NOT EXISTS mutation_manifest_heads_v3 (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    snapshot_json TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, project_id, repository_id)
);
`;

const V8_MANIFEST_HEAD_COLUMNS = [
	{ name: "tenant_id", type: "TEXT", notnull: 1, pk: 1 },
	{ name: "project_id", type: "TEXT", notnull: 1, pk: 2 },
	{ name: "repository_id", type: "TEXT", notnull: 1, pk: 3 },
	{ name: "version", type: "INTEGER", notnull: 1, pk: 0 },
	{ name: "snapshot_json", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "snapshot_sha256", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "updated_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
] as const;

const V9_JOB_AUTHORITY_COLUMNS = [
	{ name: "authority_tenant", type: "TEXT", notnull: 0, pk: 0 },
	{ name: "authority_project", type: "TEXT", notnull: 0, pk: 0 },
	{ name: "authority_repository", type: "TEXT", notnull: 0, pk: 0 },
] as const;

const V9_ONBOARDING_COLUMNS = [
	{ name: "job_key", type: "TEXT", notnull: 0, pk: 1 },
	{ name: "format_version", type: "INTEGER", notnull: 1, pk: 0 },
	{ name: "state", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "tenant", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "project", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "repository", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "commit_sha", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "target_file", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "request_bytes", type: "BLOB", notnull: 1, pk: 0 },
	{ name: "request_sha256", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "source_artifact_id", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "source_artifact_format", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "source_artifact_bytes", type: "BLOB", notnull: 1, pk: 0 },
	{ name: "source_artifact_sha256", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "target_bytes", type: "BLOB", notnull: 1, pk: 0 },
	{ name: "target_sha256", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "request_hash", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "changeset_hash", type: "TEXT", notnull: 1, pk: 0 },
	{ name: "created_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
	{ name: "acceptance_receipt_hash", type: "TEXT", notnull: 0, pk: 0 },
	{ name: "activated_at_ms", type: "INTEGER", notnull: 0, pk: 0 },
] as const;

const V9_ONBOARDING_TABLE_SQL = `
CREATE TABLE mutation_onboarding_intents_v9 (
    job_key TEXT PRIMARY KEY,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'activated')),
    tenant TEXT NOT NULL,
    project TEXT NOT NULL,
    repository TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    target_file TEXT NOT NULL,
    request_bytes BLOB NOT NULL,
    request_sha256 TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    source_artifact_format TEXT NOT NULL CHECK (source_artifact_format = 'git-archive-tar-v1'),
    source_artifact_bytes BLOB NOT NULL,
    source_artifact_sha256 TEXT NOT NULL,
    target_bytes BLOB NOT NULL,
    target_sha256 TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    changeset_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    acceptance_receipt_hash TEXT,
    activated_at_ms INTEGER,
    UNIQUE(tenant, project, repository, commit_sha, target_file),
    CHECK (
        (state = 'prepared' AND acceptance_receipt_hash IS NULL AND activated_at_ms IS NULL)
        OR
        (state = 'accepted' AND acceptance_receipt_hash IS NOT NULL AND activated_at_ms IS NULL)
        OR
        (state = 'activated' AND acceptance_receipt_hash IS NOT NULL AND activated_at_ms IS NOT NULL)
    ),
    CHECK (typeof(request_bytes) = 'blob'),
    CHECK (typeof(source_artifact_bytes) = 'blob'),
    CHECK (typeof(target_bytes) = 'blob')
);
`;

interface TableColumn {
	name: unknown;
	type: unknown;
	notnull: unknown;
	pk: unknown;
}

function tableColumns(db: SqliteDatabase, table: string): Array<{
	name: unknown;
	type: unknown;
	notnull: unknown;
	pk: unknown;
}> {
	if (!/^[a-z0-9_]+$/.test(table)) throw new Error("invalid SQLite table identifier");
	// SAFETY: table is restricted to a local identifier and PRAGMA table_info
	// returns SQLite's documented column metadata.
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
	return rows.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
}

function uniqueColumnSets(db: SqliteDatabase, table: string): string[][] {
	if (!/^[a-z0-9_]+$/.test(table)) throw new Error("invalid SQLite table identifier");
	// SAFETY: SQLite's PRAGMA index metadata is validated before interpolation
	// into the second identifier-only PRAGMA.
	const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
		name: unknown;
		unique: unknown;
		origin: unknown;
	}>;
	return indexes.filter((index) => index.unique === 1 && index.origin === "u").map((index) => {
		if (typeof index.name !== "string" || !/^[a-zA-Z0-9_]+$/.test(index.name)) {
			throw new Error("mutation onboarding table has an invalid unique-index name");
		}
		// SAFETY: PRAGMA index_info returns SQLite's documented index-column metadata.
		const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: unknown }>;
		if (columns.some(({ name }) => typeof name !== "string")) {
			throw new Error("mutation onboarding table has an invalid unique index");
		}
		return columns.map(({ name }) => String(name));
	});
}

function ensureV9JobAuthorityColumns(db: SqliteDatabase): void {
	const current = tableColumns(db, "mutation_jobs");
	const authority = current.filter(({ name }) =>
		V9_JOB_AUTHORITY_COLUMNS.some((expected) => expected.name === name));
	if (authority.length === 0) {
		db.exec(`ALTER TABLE mutation_jobs ADD COLUMN authority_tenant TEXT;
		ALTER TABLE mutation_jobs ADD COLUMN authority_project TEXT;
		ALTER TABLE mutation_jobs ADD COLUMN authority_repository TEXT;`);
		return;
	}
	if (JSON.stringify(authority) !== JSON.stringify(V9_JOB_AUTHORITY_COLUMNS)) {
		throw new Error("mutation_jobs has incompatible v9 authority columns");
	}
}

function ensureV9OnboardingIdentity(db: SqliteDatabase): void {
	if (JSON.stringify(tableColumns(db, "mutation_onboarding_intents")) !==
		JSON.stringify(V9_ONBOARDING_COLUMNS)) {
		throw new Error("mutation_onboarding_intents has an incompatible schema for v9");
	}
	const uniqueSets = uniqueColumnSets(db, "mutation_onboarding_intents");
	const oldIdentity = ["repository", "commit_sha", "target_file"];
	const newIdentity = ["tenant", "project", "repository", "commit_sha", "target_file"];
	if (uniqueSets.length === 1 && JSON.stringify(uniqueSets[0]) === JSON.stringify(newIdentity)) return;
	if (uniqueSets.length !== 1 || JSON.stringify(uniqueSets[0]) !== JSON.stringify(oldIdentity)) {
		throw new Error("mutation_onboarding_intents has an incompatible uniqueness constraint for v9");
	}
	db.exec(V9_ONBOARDING_TABLE_SQL);
	db.exec(`INSERT INTO mutation_onboarding_intents_v9 SELECT * FROM mutation_onboarding_intents;
		DROP TABLE mutation_onboarding_intents;
		ALTER TABLE mutation_onboarding_intents_v9 RENAME TO mutation_onboarding_intents;`);
}

function migrateV9(db: SqliteDatabase): void {
	ensureV9JobAuthorityColumns(db);
	ensureV9OnboardingIdentity(db);
	db.exec(`DROP INDEX IF EXISTS mutation_jobs_claimable;
		CREATE INDEX mutation_jobs_claimable ON mutation_jobs(
			authority_tenant, authority_project, authority_repository,
			status, dead_lettered_at_ms, next_attempt_at_ms, lease_expires_at_ms, created_at_ms
		);`);
}

function assertV8ManifestHeadSchema(db: SqliteDatabase): void {
	// SAFETY: PRAGMA table_info returns SQLite's documented column metadata;
	// the projection below validates the exact fields used by this migration.
	const actual = tableColumns(db, "mutation_manifest_heads_v3");
	if (JSON.stringify(actual) !== JSON.stringify(V8_MANIFEST_HEAD_COLUMNS)) {
		throw new Error("mutation_manifest_heads_v3 already exists with an incompatible schema");
	}
}

function currentVersion(db: SqliteDatabase): number {
	const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
	return typeof row?.user_version === "number" ? row.user_version : 0;
}

/**
 * Runs one versioned migration step inside its own transaction, exactly
 * mirroring the previous inline pattern: BEGIN IMMEDIATE, run `apply`, bump
 * `PRAGMA user_version`, COMMIT; on any error, ROLLBACK and rethrow.
 * Returns `targetVersion` so callers can chain `version = runVersionedMigration(...)`.
 */
function runVersionedMigration(db: SqliteDatabase, targetVersion: number, apply: () => void): number {
	db.exec("BEGIN IMMEDIATE");
	try {
		apply();
		db.exec(`PRAGMA user_version = ${targetVersion}`);
		db.exec("COMMIT");
		return targetVersion;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function migrateMutationJournal(db: SqliteDatabase): void {
	db.exec(
		"PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
	);
	let version = currentVersion(db);
	if (version > MUTATION_JOURNAL_SCHEMA_VERSION) {
		throw new Error(
			`mutation journal schema ${version} is newer than supported ${MUTATION_JOURNAL_SCHEMA_VERSION}`,
		);
	}
	if (version === 0) {
		version = runVersionedMigration(db, 1, () => db.exec(MUTATION_JOURNAL_V1_SQL));
	}
	if (version === 1) {
		version = runVersionedMigration(db, 2, () => db.exec(V2_SQL));
	}
	if (version === 2) {
		version = runVersionedMigration(db, 3, () => db.exec(V3_SQL));
	}
	if (version === 3) {
		version = runVersionedMigration(db, 4, () => db.exec(V4_SQL));
	}
	if (version === 4) {
		version = runVersionedMigration(db, 5, () => db.exec(V5_SQL));
	}
	if (version === 5) {
		version = runVersionedMigration(db, 6, () => db.exec(V6_SQL));
	}
	if (version === 6) {
		version = runVersionedMigration(db, 7, () => db.exec(V7_SQL));
	}
	if (version === 7) {
		version = runVersionedMigration(db, 8, () => {
			db.exec(V8_SQL);
			assertV8ManifestHeadSchema(db);
		});
	}
	if (version === 8) {
		runVersionedMigration(db, 9, () => migrateV9(db));
	}
}
