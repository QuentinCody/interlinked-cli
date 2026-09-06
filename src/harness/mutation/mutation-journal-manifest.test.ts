// Companion test for the durable mutation journal manifest head: the
// stored-hash integrity check in readManifestHead and the version guard in
// advanceManifestHead. Every other manifest-head path (initialize, advance,
// stale-version conflict) is exercised end to end through the real journal
// in mutation-job-processor.test.ts and mutation-journal-sqlite.test.ts;
// this file targets the two internal guards that class of test never trips.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqlite, type SqliteDatabase } from "./mutation-journal-driver.js";
import { advanceManifestHead, readManifestHead } from "./mutation-journal-manifest.js";
import { migrateMutationJournal } from "./mutation-journal-schema.js";
import type { MutationManifestAuthority } from "./mutation-journal-types.js";

const AUTHORITY: MutationManifestAuthority = Object.freeze({
	tenant: "tenant-1",
	project: "project-1",
	repository: "github.com/example/repo",
});

let root = "";
let db: SqliteDatabase | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-mutation-manifest-"));
	db = openNodeSqlite(join(root, "journal.sqlite"));
	migrateMutationJournal(db);
});

afterEach(() => {
	db?.close();
	db = null;
	rmSync(root, { recursive: true, force: true });
});

function insertHeadRow(snapshotJson: string, snapshotHash: string): void {
	// SAFETY: beforeEach always assigns db before any test body runs.
	(db as SqliteDatabase)
		.prepare(`INSERT INTO mutation_manifest_heads_v3
			(tenant_id, project_id, repository_id, version, snapshot_json, snapshot_sha256, updated_at_ms)
			VALUES (?, ?, ?, 0, ?, ?, 1)`)
		.run(AUTHORITY.tenant, AUTHORITY.project, AUTHORITY.repository, snapshotJson, snapshotHash);
}

describe("readManifestHead", () => {
	it("throws when the stored hash no longer matches the stored snapshot bytes", () => {
		insertHeadRow("{}", "0".repeat(64));
		// SAFETY: beforeEach always assigns db before any test body runs.
		expect(() => readManifestHead(db as SqliteDatabase, AUTHORITY)).toThrow(
			"mutation manifest head hash does not match its stored snapshot",
		);
	});
});

describe("advanceManifestHead", () => {
	it("rejects a negative expectedVersion before ever touching storage", () => {
		expect(() =>
			advanceManifestHead({
				// SAFETY: beforeEach always assigns db before any test body runs.
				db: db as SqliteDatabase,
				authority: AUTHORITY,
				expectedVersion: -1,
				snapshotJson: "{}",
				snapshotHash: "0".repeat(64),
				updatedAtMs: 1,
			}),
		).toThrow("expectedManifestVersion must be a non-negative safe integer");
	});
});
