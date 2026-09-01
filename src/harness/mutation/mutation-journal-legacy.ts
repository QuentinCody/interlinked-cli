// ===========================================
// Durable mutation journal — legacy file-store import seam
// ===========================================
// This captures exact bytes only. It NEVER deletes or rewrites the existing
// pending/manifest/receipt/run stores, never promotes a legacy manifest into
// an authoritative v3 head, and never promotes incomplete pending handles into
// claimable v3 jobs (they lack trusted admission inputs).

import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	asRow,
	inTransaction,
	requireString,
	requireTimestamp,
	stableJson,
	stringField,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import type { LegacyMutationImport, MutationJournal } from "./mutation-journal-types.js";

const LEGACY_FILES = [
	["pendingRuns", join(".interlinked", "pending-mutation-runs.json")],
	["manifestSnapshot", join(".interlinked", "mutation-manifest.json")],
	["receipts", join(".interlinked", "mutation-receipts.jsonl")],
	["runRows", join(".interlinked", "mutation-runs.jsonl")],
] as const;

interface CapturedLegacyFile {
	path: string;
	bytes: number;
	mtimeMs: number;
	sha256?: string;
	base64?: string;
	skipReason?: "not_regular_file" | "oversized" | "total_budget_exhausted" | "unreadable";
}

export const LEGACY_CAPTURE_MAX_FILE_BYTES = 256 * 1024;
const LEGACY_CAPTURE_MAX_TOTAL_BYTES = 512 * 1024;

function readBoundedFile(path: string, limit: number): Buffer {
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(limit + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
			if (count === 0) break;
			offset += count;
		}
		return buffer.subarray(0, offset);
	} finally {
		closeSync(descriptor);
	}
}

function captureLegacyFile(path: string, relative: string, remainingBytes: number): {
	record: CapturedLegacyFile;
	consumedBytes: number;
} | null {
	if (!existsSync(path)) return null;
	try {
		const stat = lstatSync(path);
		const metadata = { path: relative, bytes: stat.size, mtimeMs: stat.mtimeMs };
		if (!stat.isFile()) return { record: { ...metadata, skipReason: "not_regular_file" }, consumedBytes: 0 };
		if (stat.size > LEGACY_CAPTURE_MAX_FILE_BYTES) {
			return { record: { ...metadata, skipReason: "oversized" }, consumedBytes: 0 };
		}
		if (stat.size > remainingBytes) {
			return { record: { ...metadata, skipReason: "total_budget_exhausted" }, consumedBytes: 0 };
		}
		const bytes = readBoundedFile(path, Math.min(LEGACY_CAPTURE_MAX_FILE_BYTES, remainingBytes));
		if (bytes.byteLength > remainingBytes || bytes.byteLength > LEGACY_CAPTURE_MAX_FILE_BYTES) {
			return { record: { ...metadata, skipReason: "oversized" }, consumedBytes: 0 };
		}
		return {
			record: {
				path: relative,
				bytes: bytes.byteLength,
				mtimeMs: stat.mtimeMs,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				base64: bytes.toString("base64"),
			},
			consumedBytes: bytes.byteLength,
		};
	} catch {
		return {
			record: { path: relative, bytes: 0, mtimeMs: 0, skipReason: "unreadable" },
			consumedBytes: 0,
		};
	}
}

type LegacyFileImportOutcome =
	| { kind: "none" }
	| {
		kind: "inserted" | "existing";
		sourceId: string;
		files: number;
		manifestCapture: "absent" | "captured";
	};

/** Capture the current legacy stores into the journal as an audit source.
 * Existing readers and writers remain untouched; captured bytes are not a v3
 * baseline seed and are never promoted by this import seam. */
export function importLegacyMutationFiles(
	journal: MutationJournal,
	root: string,
	capturedAtMs: number,
): LegacyFileImportOutcome {
	const captured: Partial<Record<(typeof LEGACY_FILES)[number][0], CapturedLegacyFile>> = {};
	const identity = createHash("sha256");
	let hasManifestCapture = false;
	let files = 0;
	let remainingBytes = LEGACY_CAPTURE_MAX_TOTAL_BYTES;
	for (const [field, relative] of LEGACY_FILES) {
		const path = join(root, relative);
		const found = captureLegacyFile(path, relative, remainingBytes);
		if (found === null) continue;
		captured[field] = found.record;
		remainingBytes -= found.consumedBytes;
		if (field === "manifestSnapshot") hasManifestCapture = true;
		identity.update(field).update("\0").update(stableJson(found.record)).update("\0");
		files++;
	}
	if (files === 0) return { kind: "none" };
	const sourceId = `legacy-files-v1:${identity.digest("hex")}`;
	const kind = journal.importLegacy({ sourceId, capturedAtMs, ...captured });
	return {
		kind,
		sourceId,
		files,
		manifestCapture: hasManifestCapture ? "captured" : "absent",
	};
}

/** Persist one compatibility capture without promoting it to a v3 job. */
export function importLegacyMutationRow(
	db: SqliteDatabase,
	input: LegacyMutationImport,
): "inserted" | "existing" {
	requireString(input.sourceId, "sourceId");
	requireTimestamp(input.capturedAtMs, "capturedAtMs");
	const legacyPayload: Record<string, unknown> = {};
	for (const key of ["pendingRuns", "manifestSnapshot", "receipts", "runRows"] as const) {
		if (input[key] !== undefined) legacyPayload[key] = input[key];
	}
	const payload = stableJson(legacyPayload);
	return inTransaction(db, () => {
		const existing = db.prepare("SELECT payload_json FROM mutation_legacy_imports WHERE source_id = ?")
			.get(input.sourceId);
		if (existing !== undefined) {
			if (stringField(asRow(existing, "legacy import"), "payload_json") !== payload) {
				throw new Error(`legacy import "${input.sourceId}" already exists with different bytes`);
			}
			return "existing";
		}
		db.prepare(`INSERT INTO mutation_legacy_imports
			(source_id, captured_at_ms, payload_json, imported_at_ms) VALUES (?, ?, ?, ?)`).run(
			input.sourceId,
			input.capturedAtMs,
			payload,
			Date.now(),
		);
		return "inserted";
	});
}
