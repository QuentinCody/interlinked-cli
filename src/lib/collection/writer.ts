// ===========================================
// Collection v1 — JSONL Writer
// ===========================================
// Appends collection.v1 records to .interlinked/collection.jsonl.
// Synchronous, fire-and-forget — mirrors appendLocalActivity() semantics.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendFileWithMutationLock } from "../file-mutation-lock.js";
import type { AgentEventRecord, CollectionRecord } from "./types.js";
import { captureEnvelope, recordCaptureReceipt } from "../data/capture.js";
import { getDataDir } from "../config.js";
import { assertCaptureIsolation } from "../data/capture-isolation.js";

export function getCollectionPath(cwd: string): string {
	return join(getDataDir(cwd), "collection.jsonl");
}

export function appendCollection(record: CollectionRecord | AgentEventRecord, cwd: string): void {
    assertCaptureIsolation(getCollectionPath(cwd));
	try {
		const filePath = getCollectionPath(cwd);
		const dir = getDataDir(cwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const captured = { ...record, capture: captureEnvelope({ cwd, producer: "lib/collection/writer" }) };
		appendFileWithMutationLock(filePath, `${JSON.stringify(captured)}\n`);
		recordCaptureReceipt({ cwd, producer: "lib/collection/writer" }, { source: "collection", status: "written", records: 1 });
	} catch {
		recordCaptureReceipt({ cwd, producer: "lib/collection/writer" }, { source: "collection", status: "failed", error: "append-failed" });
	}
}
