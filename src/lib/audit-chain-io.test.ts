// Coverage fill for src/lib/audit-chain-io.ts: no companion existed prior to
// this file. Targets the one gap recorded in the campaign report — line 204,
// the source read-stream error-forwarding callback in iterateGzipFileLines
// (`forwardSourceError`), which only runs when the SOURCE stream errors
// (a missing/unreadable segment file), not when the gzip decoding itself
// fails (that path is already covered by audit-chain.test.ts's
// "corrupt-stream.jsonl.gz" case, which writes a real-but-invalid-gzip file).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveEvidenceError, iterateAllAuditLinesStreaming } from "./audit-chain-io.js";

let tmp: string;
let dataDir: string;
let archiveDir: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "audit-chain-io-"));
	dataDir = join(tmp, ".interlinked");
	archiveDir = join(dataDir, "archive");
	mkdirSync(archiveDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

async function drain(gen: AsyncGenerator<string>): Promise<void> {
	for await (const _line of gen) {
		// draining is the point — the manifest's segment file never exists
	}
}

describe("iterateAllAuditLinesStreaming — missing segment file", () => {
	it("wraps the source read-stream's ENOENT as a SegmentReadError naming the segment file", async () => {
		// The manifest points at a segment file that is never written to disk.
		// createReadStream's async 'error' event (not the gzip decoder) is what
		// fires here — the exact seam forwardSourceError exists to bridge into
		// the gunzip stream's own error channel.
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "missing.jsonl.gz", seq: 1 }] }),
		);

		const gen = iterateAllAuditLinesStreaming(tmp, join(dataDir, "activity.jsonl"));
		await expect(drain(gen)).rejects.toThrow(ArchiveEvidenceError);
		await expect(drain(iterateAllAuditLinesStreaming(tmp, join(dataDir, "activity.jsonl")))).rejects.toThrow(
			/archive segment missing\.jsonl\.gz unreadable/,
		);
	});
});
