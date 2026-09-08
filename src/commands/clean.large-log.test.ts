import { nonNull } from "../lib/non-null.js";
import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanCommand } from "./clean.js";

const SPARSE_PREFIX_BYTES = 513 * 1024 * 1024;

describe("clean — sparse large activity log", () => {
	let tmp: string;
	let output: string[];

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clean-large-"));
		mkdirSync(join(tmp, ".interlinked"));
		output = [];
		vi.spyOn(process, "cwd").mockReturnValue(tmp);
		vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			output.push(String(value));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("retains the final 10K lines of a >512 MiB sparse log with bounded reads", async () => {
		const activityPath = join(tmp, ".interlinked", "activity.jsonl");
		const syncStatePath = join(tmp, ".interlinked", "sync-state.json");
		const lines = Array.from({ length: 10005 }, (_, index) => `{"n":${index}}`);
		const tail = Buffer.from(`${lines.join("\n")}\n`);
		const fd = openSync(activityPath, "w");
		try {
			ftruncateSync(fd, SPARSE_PREFIX_BYTES);
			writeSync(fd, tail, 0, tail.length, SPARSE_PREFIX_BYTES);
		} finally {
			closeSync(fd);
		}
		expect(statSync(activityPath).size).toBeGreaterThan(512 * 1024 * 1024);

		await cleanCommand({ force: true, json: true });

		const kept = readFileSync(activityPath, "utf8").trim().split("\n");
		expect(kept).toHaveLength(10000);
		expect(kept[0]).toBe('{"n":5}');
		expect(kept.at(-1)).toBe('{"n":10004}');
		expect(JSON.parse(readFileSync(syncStatePath, "utf8"))).toMatchObject({
			synced_through_bytes: 0,
			reason: "activity_log_truncated",
		});
		// SAFETY: JSON mode emitted exactly one console line above.
		expect(JSON.parse(nonNull(output.at(-1)))).toMatchObject({ total_removed: 2 });
	});

	it("refuses a whole-file cleanup while crash recovery owns the activity path", async () => {
		const activityPath = join(tmp, ".interlinked", "activity.jsonl");
		const archiveDir = join(tmp, ".interlinked", "archive");
		const fencePath = join(archiveDir, ".pending-activity-rotation.json");
		const manifestPath = join(archiveDir, "manifest.json");
		mkdirSync(archiveDir, { recursive: true });
		const fd = openSync(activityPath, "w");
		const lines = Array.from({ length: 10005 }, (_, index) => `{"n":${index}}`);
		const tail = Buffer.from(`${lines.join("\n")}\n`);
		try {
			ftruncateSync(fd, SPARSE_PREFIX_BYTES);
			writeSync(fd, tail, 0, tail.length, SPARSE_PREFIX_BYTES);
		} finally {
			closeSync(fd);
		}
		const originalSize = statSync(activityPath).size;
		writeFileSync(fencePath, "crash-left claim bytes");

		await cleanCommand({ force: true, json: true });
		expect(statSync(activityPath).size).toBe(originalSize);
		// SAFETY: JSON mode emitted exactly one console line above.
		expect(JSON.parse(nonNull(output.at(-1)))).toMatchObject({
			total_removed: 0,
			stale_items: [{ cleanup_outcome: "refused" }],
		});

		rmSync(fencePath);
		output.length = 0;
		writeFileSync(
			manifestPath,
			JSON.stringify({ version: 1, segments: [{ pending_live_drop: { cut_bytes: 1 } }] }),
		);
		await cleanCommand({ force: true, json: true });
		expect(statSync(activityPath).size).toBe(originalSize);
		// SAFETY: JSON mode emitted exactly one console line above.
		expect(JSON.parse(nonNull(output.at(-1)))).toMatchObject({
			total_removed: 0,
			stale_items: [{ cleanup_outcome: "refused" }],
		});

		rmSync(manifestPath);
		output.length = 0;
		await cleanCommand({ force: true, json: true });
		expect(statSync(activityPath).size).toBeLessThan(originalSize);
		// SAFETY: JSON mode emitted exactly one console line above.
		expect(JSON.parse(nonNull(output.at(-1)))).toMatchObject({ total_removed: 2 });
	});
});
