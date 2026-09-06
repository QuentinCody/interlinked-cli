// ===========================================
// Durable mutation journal — v9 migration edge cases
// ===========================================
// Targets the defensive throws inside migrateV9's ensureV9OnboardingIdentity
// check (schema and uniqueness mismatches on `mutation_onboarding_intents`)
// that the acceptance suite in mutation-journal-sqlite.test.ts doesn't reach.
// Builds a v8-shaped database via the real migration path, then hand-edits
// the raw tables (same technique as mutation-journal-sqlite.test.ts's
// P0f/N0e cases) before letting `openMutationJournal` re-run the v9
// migration and observing what it throws.
//
// Also covered here: uniqueColumnSets' two identifier-shape guards (an
// invalid unique-index name, and a non-string index-column name), driven
// through the `SqliteDatabase` parameter rather than through SQLite. No
// legitimate, uncorrupted node:sqlite schema reaches either guard from this
// migration's call path. Verified empirically against this SQLite build
// (3.50.4): `ALTER TABLE ... RENAME` re-derives a UNIQUE(...) constraint's
// auto-index name from the NEW table name (a hyphenated staging name does
// not survive the rename), and a `CONSTRAINT "name" UNIQUE(...)` clause is
// silently ignored for auto-index naming too. The guards defend the exported
// entry point's driver argument instead — a seam this module's own doc
// comment declares public for "future backend implementations" — whose
// PRAGMA fields are typed `unknown` precisely because the reported index
// name is interpolated into a second PRAGMA. The last two cases drive that
// seam with hand-supplied PRAGMA rows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqlite, type SqliteDatabase } from "./mutation-journal-driver.js";
import { migrateMutationJournal } from "./mutation-journal-schema.js";
import { mutationJournalPath, openMutationJournal } from "./mutation-journal-sqlite.js";
import type { MutationJournal } from "./mutation-journal-types.js";

/** Every column mutation-journal-schema.ts's V7_SQL / V9_ONBOARDING_COLUMNS
 *  expect on `mutation_onboarding_intents`, verbatim from the module source. */
const ONBOARDING_COLUMNS_SQL = `
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
`;

let root = "";
let journal: MutationJournal | null = null;
/** Raw driver handle for the `SqliteDatabase`-seam cases at the bottom. */
let seamDb: SqliteDatabase | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-mutation-journal-schema-"));
});

afterEach(() => {
	journal?.close();
	journal = null;
	seamDb?.close();
	seamDb = null;
	rmSync(root, { recursive: true, force: true });
});

/**
 * Opens a fresh (fully-migrated, v9) journal, then rewinds it to a v8-shaped
 * database whose `mutation_onboarding_intents` table is replaced by
 * `onboardingCreateSql` — matching the rename trick
 * mutation-journal-onboarding.test.ts uses to reach schema states the normal
 * migration path never produces. `mutation_jobs`'s v9 authority columns are
 * dropped back to zero so `ensureV9JobAuthorityColumns` takes its no-op
 * "add fresh" branch and the onboarding path is what's actually under test.
 */
function rewindToV8WithOnboardingTable(onboardingCreateSql: string): void {
	journal = openMutationJournal(root);
	journal.close();
	journal = null;
	const raw = openNodeSqlite(mutationJournalPath(root));
	raw.exec(`DROP INDEX mutation_jobs_claimable;
		ALTER TABLE mutation_jobs DROP COLUMN authority_tenant;
		ALTER TABLE mutation_jobs DROP COLUMN authority_project;
		ALTER TABLE mutation_jobs DROP COLUMN authority_repository;
		DROP TABLE mutation_onboarding_intents;
		${onboardingCreateSql}
		PRAGMA user_version = 8;`);
	raw.close();
}

describe("migrateMutationJournal — v9 onboarding-identity edge cases", () => {
	it("throws when the onboarding table's columns don't match the expected v9 shape", () => {
		// Same column list minus `changeset_hash` (unreferenced by any CHECK
		// constraint, so dropping it is a clean, targeted schema mismatch).
		rewindToV8WithOnboardingTable(`
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
		`);
		expect(() => openMutationJournal(root)).toThrow(
			"mutation_onboarding_intents has an incompatible schema for v9",
		);
	});

	it("throws when the onboarding table has neither the old nor the new uniqueness constraint", () => {
		// Full expected column shape, but no UNIQUE(...) at all — uniqueSets
		// comes back empty, which matches neither the pre-v9 3-column identity
		// nor the v9 5-column identity.
		rewindToV8WithOnboardingTable(`
			CREATE TABLE mutation_onboarding_intents (${ONBOARDING_COLUMNS_SQL});
		`);
		expect(() => openMutationJournal(root)).toThrow(
			"mutation_onboarding_intents has an incompatible uniqueness constraint for v9",
		);
	});
});

/**
 * Wraps a real driver so the listed PRAGMA statements answer with hand-supplied
 * rows and every other statement still hits SQLite. `migrateMutationJournal`
 * accepts any `SqliteDatabase`, and reads its PRAGMA fields as `unknown`
 * because the index name reported here is interpolated into a second PRAGMA —
 * so a backend that answers differently from node:sqlite is exactly what the
 * two identifier-shape guards defend against.
 */
function withPragmaRows(db: SqliteDatabase, rowsByPragma: Record<string, unknown[]>): SqliteDatabase {
	return {
		exec: (sql: string) => {
			db.exec(sql);
		},
		close: () => {
			db.close();
		},
		prepare: (sql: string) => {
			const rows = rowsByPragma[sql];
			if (rows === undefined) return db.prepare(sql);
			return { run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => rows };
		},
	};
}

/** A v8 database whose onboarding table carries the exact v9 column shape, so
 *  the migration gets past `ensureV9OnboardingIdentity`'s column check and on
 *  to `uniqueColumnSets`. `afterEach` closes the handle. */
function openV8JournalAtUniqueColumnSets(): SqliteDatabase {
	rewindToV8WithOnboardingTable(`
		CREATE TABLE mutation_onboarding_intents (${ONBOARDING_COLUMNS_SQL});
	`);
	seamDb = openNodeSqlite(mutationJournalPath(root));
	return seamDb;
}

describe("migrateMutationJournal — uniqueColumnSets identifier-shape guards", () => {
	it("throws when the driver reports a unique index name that is not a bare identifier", () => {
		const db = withPragmaRows(openV8JournalAtUniqueColumnSets(), {
			"PRAGMA index_list(mutation_onboarding_intents)": [
				{ name: "sqlite_autoindex_mutation-onboarding-intents_1", unique: 1, origin: "u" },
			],
		});
		expect(() => migrateMutationJournal(db)).toThrow(
			"mutation onboarding table has an invalid unique-index name",
		);
	});

	it("throws when the driver reports a non-string index column name", () => {
		const db = withPragmaRows(openV8JournalAtUniqueColumnSets(), {
			"PRAGMA index_list(mutation_onboarding_intents)": [
				{ name: "sqlite_autoindex_mutation_onboarding_intents_1", unique: 1, origin: "u" },
			],
			// The shape SQLite uses for an expression column in an index: a null name.
			"PRAGMA index_info(sqlite_autoindex_mutation_onboarding_intents_1)": [{ name: null }],
		});
		expect(() => migrateMutationJournal(db)).toThrow(
			"mutation onboarding table has an invalid unique index",
		);
	});
});
