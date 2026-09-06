// ===========================================
// Durable mutation journal — legacy file-store import seam (unit companion)
// ===========================================
// importLegacyMutationFiles's happy-path capture (real small files, idempotent
// re-import, oversized-before-read) is covered against a real SQLite journal
// in mutation-journal-sqlite.test.ts (P8-P10/N10), which this file's source
// is a sibling import of. This companion targets the three shallow skip
// branches inside the module-private captureLegacyFile that those tests never
// happen to hit: the per-run TOTAL byte budget being exhausted mid-loop, the
// post-read "the file grew since stat()" recheck, and the stat/read failure
// catch-all. The first is reached with real files sized against the public
// constant; the other two need a fs seam poisoned for exactly one call, so
// `node:fs` is wrapped as a call-through spy (the same pattern documented in
// build-staleness.test.ts) rather than mocked wholesale.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fsControl } = vi.hoisted(() => {
	const state: { poisonLstatPath: string | null; forceOverread: boolean } = {
		poisonLstatPath: null,
		forceOverread: false,
	};
	return { fsControl: state };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		lstatSync: ((path: unknown, opts?: unknown) => {
			if (fsControl.poisonLstatPath !== null && String(path) === fsControl.poisonLstatPath) {
				throw new Error(`EACCES: permission denied, lstat '${String(path)}'`);
			}
			// SAFETY: mutation-journal-legacy.ts only ever calls lstatSync(path)
			// with no second argument; every non-poisoned call (including this
			// file's own fixture writes) passes through to the real fs untouched.
			return (actual.lstatSync as (p: unknown, o?: unknown) => unknown)(path, opts);
			// SAFETY: this wrapper only intercepts the poisoned path above; its
			// return shape is identical to the real lstatSync it replaces.
		}) as typeof actual.lstatSync,
		readSync: ((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number | null,
		) => {
			if (fsControl.forceOverread) {
				// Simulate the file having grown past its lstatSync()'d size
				// between the stat and this read: fill the FULL requested span
				// instead of stopping at the real (tiny) on-disk length, exactly
				// as a real concurrent writer racing the capture would produce.
				// SAFETY: readBoundedFile only ever passes a Buffer (a Uint8Array
				// subclass) here — `.fill` is safe on the narrower view type.
				(buffer as Uint8Array).fill(65, offset, offset + length);
				return length;
			}
			// SAFETY: readBoundedFile always calls readSync with all five
			// positional args; the real implementation is used verbatim here.
			return (
				actual.readSync as (
					fd: number,
					buffer: NodeJS.ArrayBufferView,
					offset: number,
					length: number,
					position: number | null,
				) => number
			)(fd, buffer, offset, length, position);
			// SAFETY: this wrapper only intercepts calls while forceOverread is
			// set; its return shape is identical to the real readSync it replaces.
		}) as typeof actual.readSync,
	};
});

import { openNodeSqlite } from "./mutation-journal-driver.js";
import { LEGACY_CAPTURE_MAX_FILE_BYTES, importLegacyMutationFiles } from "./mutation-journal-legacy.js";
import { mutationJournalPath, openMutationJournal } from "./mutation-journal-sqlite.js";
import type { MutationJournal } from "./mutation-journal-types.js";

let root = "";
let journal: MutationJournal | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-mutation-journal-legacy-"));
	fsControl.poisonLstatPath = null;
	fsControl.forceOverread = false;
});

afterEach(() => {
	journal?.close();
	journal = null;
	fsControl.poisonLstatPath = null;
	fsControl.forceOverread = false;
	rmSync(root, { recursive: true, force: true });
});

/** Reads back one legacy field's captured record for the row importLegacyMutationFiles
 *  just wrote — the outcome it returns carries only counts, not per-file detail. */
function capturedField(sourceId: string, field: string): Record<string, unknown> {
	journal?.close();
	journal = null;
	const raw = openNodeSqlite(mutationJournalPath(root));
	// SAFETY: source_id is the primary key and payload_json is stored text.
	const row = raw
		.prepare("SELECT payload_json FROM mutation_legacy_imports WHERE source_id = ?")
		.get(sourceId) as { payload_json: string };
	raw.close();
	// SAFETY: payload_json is written by inTransaction/stableJson from the
	// exact CapturedLegacyFile-keyed object importLegacyMutationFiles built;
	// this test only reads back fields it wrote in the same test.
	const payload = JSON.parse(row.payload_json) as Record<string, Record<string, unknown>>;
	const record = payload[field];
	if (!record) throw new Error(`no captured record for field "${field}"`);
	return record;
}

describe("importLegacyMutationFiles — capture-skip branches", () => {
	// kind: capture-skip — positive (must fire)
	it("P1: exhausting the total capture budget mid-loop skips a later file with total_budget_exhausted, not oversized", () => {
		journal = openMutationJournal(root);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		// Two files at exactly the per-file cap consume exactly the (2x cap)
		// total budget, leaving zero bytes remaining for the third.
		writeFileSync(join(dir, "pending-mutation-runs.json"), Buffer.alloc(LEGACY_CAPTURE_MAX_FILE_BYTES, 65));
		writeFileSync(join(dir, "mutation-manifest.json"), Buffer.alloc(LEGACY_CAPTURE_MAX_FILE_BYTES, 66));
		writeFileSync(join(dir, "mutation-receipts.jsonl"), "tiny\n");

		const imported = importLegacyMutationFiles(journal, root, 100);
		expect(imported).toMatchObject({ kind: "inserted", files: 3 });
		if (imported.kind === "none") throw new Error("expected a capture, not none");

		const receipts = capturedField(imported.sourceId, "receipts");
		expect(receipts).toMatchObject({ bytes: 5, skipReason: "total_budget_exhausted" });
		expect(receipts.sha256).toBeUndefined();
		expect(receipts.base64).toBeUndefined();

		// The two budget-consuming files themselves were captured in full —
		// proves the skip is specific to the exhausted THIRD file, not a
		// blanket budget failure.
		const pendingRuns = capturedField(imported.sourceId, "pendingRuns");
		expect(pendingRuns.skipReason).toBeUndefined();
		expect(typeof pendingRuns.sha256).toBe("string");
	});

	// kind: capture-skip — positive (must fire)
	it("P2: a file that reads longer than its stat()'d size is re-flagged oversized after the read, not captured", () => {
		journal = openMutationJournal(root);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		const pendingPath = join(dir, "pending-mutation-runs.json");
		writeFileSync(pendingPath, "1234567890"); // 10 real bytes — well under both caps

		fsControl.forceOverread = true;
		const imported = importLegacyMutationFiles(journal, root, 100);
		fsControl.forceOverread = false;

		expect(imported).toMatchObject({ kind: "inserted", files: 1 });
		if (imported.kind === "none") throw new Error("expected a capture, not none");

		const pendingRuns = capturedField(imported.sourceId, "pendingRuns");
		// bytes comes from the ORIGINAL stat metadata (10), not the fabricated
		// over-read length — proving this is the post-read recheck branch, not
		// the pre-read size guard (which never fires: 10 is under every cap).
		expect(pendingRuns).toMatchObject({ bytes: 10, skipReason: "oversized" });
		expect(pendingRuns.sha256).toBeUndefined();
		expect(pendingRuns.base64).toBeUndefined();
	});

	// kind: capture-skip — positive (must fire)
	it("P3: a file whose stat/read throws mid-capture is recorded unreadable with zeroed metadata, not thrown", () => {
		journal = openMutationJournal(root);
		const dir = join(root, ".interlinked");
		mkdirSync(dir, { recursive: true });
		const pendingPath = join(dir, "pending-mutation-runs.json");
		writeFileSync(pendingPath, "abc");
		fsControl.poisonLstatPath = pendingPath;

		let imported: ReturnType<typeof importLegacyMutationFiles>;
		expect(() => {
			imported = importLegacyMutationFiles(journal as MutationJournal, root, 100);
		}).not.toThrow();
		fsControl.poisonLstatPath = null;

		expect(imported!).toMatchObject({ kind: "inserted", files: 1 });
		if (imported!.kind === "none") throw new Error("expected a capture, not none");

		const pendingRuns = capturedField(imported!.sourceId, "pendingRuns");
		// The catch block's fallback metadata is a fixed {bytes:0, mtimeMs:0} —
		// distinct from the real 3-byte file's actual stat, proving the throw
		// was caught rather than the file simply being read normally.
		expect(pendingRuns).toEqual({
			path: join(".interlinked", "pending-mutation-runs.json"),
			bytes: 0,
			mtimeMs: 0,
			skipReason: "unreadable",
		});
	});
});
