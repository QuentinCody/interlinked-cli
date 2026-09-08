// test-contract: the journal's SQLite boundary either hands back a working
// node:sqlite database or fails loudly. There is no JSON / in-memory fallback,
// so both refusals must name themselves as MutationJournalUnavailableError.
//
// `process.versions.node` is redefined (it is a configurable, non-writable
// property) to model an older runtime; afterEach restores the real value.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite, type SqliteDatabase } from "./mutation-journal-driver.js";

const REAL_NODE_VERSION = process.versions.node;

function pretendNodeVersion(version: string): void {
	Object.defineProperty(process.versions, "node", {
		value: version,
		configurable: true,
		enumerable: true,
		writable: false,
	});
}

function captureThrow(run: () => void): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`expected an Error, got ${String(error)}`);
	}
	throw new Error("expected openNodeSqlite to throw");
}

let roots: string[] = [];
let opened: SqliteDatabase | null = null;

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-journal-driver-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	pretendNodeVersion(REAL_NODE_VERSION);
	opened?.close();
	opened = null;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

describe("openNodeSqlite", () => {
	it("returns a database that executes statements against the given path", () => {
		opened = openNodeSqlite(join(tempRoot(), "journal.db"));
		opened.exec("CREATE TABLE t (v TEXT NOT NULL)");
		opened.prepare("INSERT INTO t (v) VALUES (?)").run("kept");
		expect(opened.prepare("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
	});

	it("refuses to open the journal on a runtime older than node:sqlite", () => {
		pretendNodeVersion("22.4.0");
		const error = captureThrow(() => openNodeSqlite(join(tempRoot(), "journal.db")));
		expect(error.name).toBe("MutationJournalUnavailableError");
		expect(error.message).toBe(
			"the durable mutation journal requires node:sqlite (Node >=22.5; running 22.4.0)",
		);
	});

	it("reports the engine failure and keeps its cause when the path cannot be opened", () => {
		const root = tempRoot();
		rmSync(root, { recursive: true, force: true });
		const error = captureThrow(() => openNodeSqlite(join(root, "journal.db")));
		expect(error.name).toBe("MutationJournalUnavailableError");
		expect(error.message).toBe(
			"node:sqlite could not open the durable mutation journal (unable to open database file); no non-SQLite fallback is used",
		);
		expect(error.cause).toMatchObject({ code: "ERR_SQLITE_ERROR" });
	});
});
