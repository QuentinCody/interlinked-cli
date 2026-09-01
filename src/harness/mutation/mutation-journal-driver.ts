// ===========================================
// Durable mutation journal — SQLite driver boundary
// ===========================================
// Node 22.5 introduced node:sqlite, while this package still supports early
// Node 22 for non-journal commands. Keep the dependency behind this runtime
// boundary: opening the journal on an older runtime fails loudly; importing
// the CLI does not. Node 22 currently emits its own ExperimentalWarning when
// this module loads. We intentionally do not suppress that warning.

import { createRequire } from "node:module";

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteRunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
	run(...values: SqliteValue[]): SqliteRunResult;
	get(...values: SqliteValue[]): unknown;
	all(...values: SqliteValue[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface NodeSqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

class MutationJournalUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MutationJournalUnavailableError";
	}
}

const NODE_SQLITE_MAJOR = 22;
const NODE_SQLITE_MINOR = 5;

function supportsNodeSqlite(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > NODE_SQLITE_MAJOR || (major === NODE_SQLITE_MAJOR && minor >= NODE_SQLITE_MINOR);
}

/** Load the real built-in SQLite engine. No JSON or in-memory fallback: a
 * durable mutation decision either uses SQLite or is unavailable. */
export function openNodeSqlite(path: string): SqliteDatabase {
	if (!supportsNodeSqlite(process.versions.node)) {
		throw new MutationJournalUnavailableError(
			`the durable mutation journal requires node:sqlite (Node >=22.5; running ${process.versions.node})`,
		);
	}
	try {
		const require = createRequire(import.meta.url);
		// SAFETY: runtime-version-gated built-in module. Local structural types
		// above cover only the stable synchronous API this journal uses.
		const sqlite = require("node:sqlite") as NodeSqliteModule;
		return new sqlite.DatabaseSync(path);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new MutationJournalUnavailableError(
			`node:sqlite could not open the durable mutation journal (${detail}); no non-SQLite fallback is used`,
			{ cause: error },
		);
	}
}
