// Coverage companion for compact-plain-state.ts's manifest-parsing edges:
// loadPlainManifest must reject a manifest whose top-level shape (wrong
// schema version) doesn't match, discarding even a well-formed segment
// entry inside it, rather than trusting the shape and parsing anyway.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDataDir } from "../lib/config-paths.js";
import { loadPlainManifest } from "./compact-plain-state.js";

let cwd: string;

function manifestPath(log: string): string {
	return join(getDataDir(cwd), "archive", `manifest-${log}.json`);
}

function writeManifest(log: string, body: unknown): void {
	const path = manifestPath(log);
	mkdirSync(join(cwd, ".interlinked", "archive"), { recursive: true });
	writeFileSync(path, JSON.stringify(body));
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "compact-plain-state-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("loadPlainManifest", () => {
	it("discards the whole manifest, including already-valid segments, when one segment fails to parse", () => {
		writeManifest("collection", {
			version: 1,
			segments: [
				{
					seq: 1,
					file: "collection-0001.jsonl.gz",
					bytes: 10,
					gz_bytes: 5,
					records: 2,
					created_at: "2026-01-01T00:00:00Z",
				},
				{ not: "an archive segment" },
			],
		});

		const result = loadPlainManifest("collection", cwd);

		expect(result).toEqual({ version: 1, segments: [] });
	});

	it("discards a manifest at the wrong schema version, even with an otherwise well-formed segment", () => {
		writeManifest("timeline", {
			version: 2,
			segments: [
				{
					seq: 1,
					file: "timeline-0001.jsonl.gz",
					bytes: 20,
					gz_bytes: 8,
					records: 3,
					created_at: "2026-01-01T00:00:00Z",
				},
			],
		});

		const result = loadPlainManifest("timeline", cwd);

		expect(result).toEqual({ version: 1, segments: [] });
	});
});
