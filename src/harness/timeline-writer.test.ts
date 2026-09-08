import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: spies on statSync only (call-through to the real implementation by
// default) while every other fs export stays untouched. Plain `vi.spyOn(fs,
// ...)` throws "Module namespace is not configurable in ESM" for node:fs —
// see background-task-log.test.ts for prior art.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: vi.fn(actual.statSync),
	};
});

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import {
	appendTimelineRecords,
	appendTimelineRecordsAtBasis,
	dedupeTimeline,
	existingTimelineKeys,
	MAX_EXISTING_TIMELINE_KEY_SCAN_BYTES,
	MAX_EXISTING_TIMELINE_KEYS,
	MAX_TIMELINE_REWRITE_CATCHUP_BYTES,
	MAX_TIMELINE_REWRITE_BYTES,
	recentTimelineKeys,
	RECENT_TIMELINE_KEY_BYTES,
	recordKey,
	removeExistingTimelineCandidates,
	sortTimeline,
	timelinePath,
	writeTimeline,
	TimelineRewriteConflictError,
	TimelineScanError,
} from "./timeline-writer.js";
import {
	fileMutationLockOwnerPath,
	fileMutationLockPath,
} from "../lib/file-mutation-lock.js";
import { readFileMutationProcessIdentity } from "../lib/file-mutation-lock-identity.js";
import type { TimelineRecord } from "./transcript-record.js";
import { compactPlainLog } from "../commands/compact-plain.js";
import {
	loadRotationClaim,
	rotationClaimPath,
} from "../commands/compact-rotation-claim.js";
import { PendingFileRotationError } from "../lib/file-rotation-fence.js";
import { nonNull } from "../lib/non-null.js";

function rec(over: Partial<TimelineRecord> & Pick<TimelineRecord, "ts" | "uuid" | "seq">): TimelineRecord {
	return { schema: "timeline.v1", session: "s1", category: "agent_message", role: "assistant", ...over };
}

describe("timeline-writer ordering + dedup", () => {
	it("recordKey is uuid#seq", () => {
		expect(recordKey(rec({ ts: "t", uuid: "u", seq: 3 }))).toBe("u#3");
	});

	it("sortTimeline orders by ts, then session, then seq (stable)", () => {
		const sorted = sortTimeline([
			rec({ ts: "2026-06-28T10:00:02.000Z", uuid: "c", seq: 0 }),
			rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 1, session: "s2" }),
			rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, session: "s2" }),
		]);
		expect(sorted.map((r) => `${r.uuid}${r.seq}`)).toEqual(["a0", "a1", "c0"]);
	});

	it("dedupeTimeline keeps the first occurrence of each uuid#seq", () => {
		const out = dedupeTimeline([
			rec({ ts: "t", uuid: "u", seq: 0, text: "first" }),
			rec({ ts: "t", uuid: "u", seq: 0, text: "dup" }),
			rec({ ts: "t", uuid: "u", seq: 1, text: "other" }),
		]);
		expect(out).toHaveLength(2);
		expect(out[0]?.text).toBe("first");
	});
});

describe("timeline-writer file I/O", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlw-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writeTimeline writes sorted + deduped JSONL and returns the count", () => {
		const n = writeTimeline(
			[
				rec({ ts: "2026-06-28T10:00:01.000Z", uuid: "b", seq: 0, text: "second" }),
				rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, text: "first" }),
				rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, text: "first-dup" }),
			],
			cwd,
		);
		expect(n).toBe(2);
		const texts = readFileSync(timelinePath(cwd), "utf-8")
			.trim()
			.split("\n")
			.map((l) => {
				const p: { text?: string } = JSON.parse(l);
				return p.text;
			});
		expect(texts).toEqual(["first", "second"]);
	});

	it("writeTimeline with no records writes an empty file", () => {
		expect(writeTimeline([], cwd)).toBe(0);
		expect(readFileSync(timelinePath(cwd), "utf-8")).toBe("");
	});

	it("reconciles valid rows already captured live with the backfill", () => {
		const live = rec({ ts: "2026-06-28T10:00:02.000Z", uuid: "live", seq: 0 });
		const backfill = rec({ ts: "2026-06-28T10:00:01.000Z", uuid: "backfill", seq: 0 });
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(timelinePath(cwd), `${JSON.stringify(live)}\n`);

		expect(writeTimeline([backfill], cwd)).toBe(2);
		const rows = readFileSync(timelinePath(cwd), "utf8")
			.trim()
			.split("\n")
			.map((line) => parseWire(JSON.parse(line), wireObject({ "uuid": wireString }), "test JSON value"));
		expect(rows.map((row) => row.uuid)).toEqual(["backfill", "live"]);
	});

	it("refuses a rewrite across a crashed rotation, then resumes after compaction recovery", () => {
		const records = Array.from({ length: 80 }, (_, index) =>
			rec({
				ts: `2026-08-31T10:${String(index).padStart(2, "0")}:00.000Z`,
				uuid: `row-${index}`,
				seq: 0,
				text: "x".repeat(64),
			}),
		);
		writeTimeline(records, cwd);
		const path = timelinePath(cwd);
		const original = readFileSync(path);
		const archiveDir = join(cwd, ".interlinked", "archive");
		const manifestBlocker = join(archiveDir, "manifest-timeline.json.tmp");
		mkdirSync(manifestBlocker, { recursive: true });

		expect(() => compactPlainLog("timeline", { cwd, keepRecentBytes: 256 })).toThrow();
		const claimPath = rotationClaimPath(archiveDir, "timeline");
		expect(existsSync(claimPath)).toBe(true);
		expect(() => writeTimeline(records, cwd)).toThrow(PendingFileRotationError);
		expect(readFileSync(path).equals(original)).toBe(true);

		const claim = nonNull(loadRotationClaim(archiveDir, "timeline"));
		writeFileSync(
			join(archiveDir, "manifest-timeline.json"),
			JSON.stringify({
				version: 1,
				segments: [{
					seq: claim.seq,
					file: claim.file,
					bytes: claim.cut_bytes,
					gz_bytes: claim.gz_bytes,
					records: claim.records,
					created_at: claim.created_at,
					pending_live_drop: {
						cut_bytes: claim.cut_bytes,
						source: claim.source,
						replacement: claim.replacement,
					},
				}],
			}),
		);
		rmSync(claimPath);
		expect(() => writeTimeline(records, cwd)).toThrow(PendingFileRotationError);
		expect(readFileSync(path).equals(original)).toBe(true);

		rmSync(manifestBlocker, { recursive: true });
		const recovered = compactPlainLog("timeline", { cwd, keepRecentBytes: 256 });
		expect(recovered.segment).toBe("timeline-0001.jsonl.gz");
		expect(existsSync(claimPath)).toBe(false);
		expect(writeTimeline(records, cwd)).toBe(records.length);
	});

	it(
		"does not overwrite a live row appended while a child waits on the shared lock",
		{ timeout: 60_000 },
		async () => {
			const path = timelinePath(cwd);
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			const old = rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "old", seq: 0 });
			const backfill = rec({
				ts: "2026-06-28T10:00:01.000Z",
				uuid: "backfill",
				seq: 0,
			});
			const late = rec({ ts: "2026-06-28T10:00:02.000Z", uuid: "late", seq: 0 });
			writeFileSync(path, `${JSON.stringify(old)}\n`);

			const lockPath = fileMutationLockPath(path);
			const token = "timeline-parent";
			mkdirSync(lockPath);
			const ownerPath = fileMutationLockOwnerPath(path, token);
			const identity = readFileMutationProcessIdentity(process.pid, 1);
			writeFileSync(
				ownerPath,
				JSON.stringify({
					pid: process.pid,
					token,
					acquired_at_ms: 1,
					...(identity.bootId ? { boot_id: identity.bootId } : {}),
					...(identity.processStartId
						? { process_start_id: identity.processStartId }
						: {}),
				}),
			);

			const moduleUrl = new URL("./timeline-writer.ts", import.meta.url).href;
			const source = [
				`import { writeTimeline } from ${JSON.stringify(moduleUrl)};`,
				`const records = JSON.parse(process.env.INTERLINKED_TIMELINE_RECORDS);`,
				`const count = writeTimeline(records, process.env.INTERLINKED_TIMELINE_CWD, {`,
				`  afterBasisCaptured: () => process.stdout.write("basis\\n"),`,
				`});`,
				`process.stdout.write(JSON.stringify({ count }) + "\\n");`,
			].join("\n");
			let stderr = "";
			const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
				env: {
					...process.env,
					INTERLINKED_TIMELINE_CWD: cwd,
					INTERLINKED_TIMELINE_RECORDS: JSON.stringify([old, backfill]),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			await once(child.stdout, "data");
			appendFileSync(path, `${JSON.stringify(late)}\n`);
			rmSync(ownerPath);
			rmdirSync(lockPath);

			const [exitCode] = await once(child, "exit");
			expect(exitCode, stderr).toBe(0);
			const rows = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => parseWire(JSON.parse(line), wireObject({ "uuid": wireString }), "test JSON value"));
			expect(rows.map((row) => row.uuid)).toEqual(["old", "backfill", "late"]);
			expect(existsSync(lockPath)).toBe(false);
		},
	);

	it("refuses an unbounded catch-up and leaves the original file intact", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const old = rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "old", seq: 0 });
		const initial = Buffer.from(`${JSON.stringify(old)}\n`);
		const oversizedTail = Buffer.alloc(MAX_TIMELINE_REWRITE_CATCHUP_BYTES + 1, 0x78);
		writeFileSync(path, initial);

		expect(() =>
			writeTimeline([old], cwd, {
				afterBasisCaptured: () => appendFileSync(path, oversizedTail),
			}),
		).toThrow(TimelineRewriteConflictError);
		const preserved = readFileSync(path);
		expect(preserved.length).toBe(initial.length + oversizedTail.length);
		expect(preserved.subarray(0, initial.length).equals(initial)).toBe(true);
		expect(preserved.at(-1)).toBe(0x78);
		expect(readdirSync(join(cwd, ".interlinked")).some((name) => name.includes(".rewrite-"))).toBe(
			false,
		);
	});

	it("fails safely when another replacer changes the source inode", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const old = rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "old", seq: 0 });
		const successor = `${JSON.stringify(rec({ ts: "t", uuid: "successor", seq: 0 }))}\n`;
		writeFileSync(path, `${JSON.stringify(old)}\n`);

		expect(() =>
			writeTimeline([old], cwd, {
				afterBasisCaptured: () => {
					rmSync(path);
					writeFileSync(path, successor);
				},
			}),
		).toThrow(TimelineRewriteConflictError);
		expect(readFileSync(path, "utf8")).toBe(successor);
	});

	it("appendTimelineRecords appends; existingTimelineKeys reads the keys back", () => {
		expect(
			appendTimelineRecords([rec({ ts: "t", uuid: "x", seq: 0 }), rec({ ts: "t", uuid: "x", seq: 1 })], cwd),
		).toBe(true);
		expect(appendTimelineRecords([rec({ ts: "t", uuid: "y", seq: 0 })], cwd)).toBe(true);
		expect(existingTimelineKeys(cwd)).toEqual(new Set(["x#0", "x#1", "y#0"]));
	});

	it("appendTimelineRecords with an empty list is a no-op", () => {
		expect(appendTimelineRecords([], cwd)).toBe(true);
		expect(existingTimelineKeys(cwd).size).toBe(0);
	});

	it("appendTimelineRecords reports a filesystem append failure without throwing", () => {
		mkdirSync(timelinePath(cwd), { recursive: true });
		expect(appendTimelineRecords([rec({ ts: "t", uuid: "x", seq: 0 })], cwd)).toBe(false);
	});

	it("seeds live dedup from a byte-bounded tail while the backfill reader remains complete", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ uuid: "old", seq: 0 })}\n`);
		appendFileSync(path, Buffer.alloc(RECENT_TIMELINE_KEY_BYTES + 1024, 0x20));
		appendFileSync(path, `\n${JSON.stringify({ uuid: "new", seq: 1 })}\n`);

		expect(recentTimelineKeys(cwd, 20)).toEqual(new Set(["new#1"]));
		expect(existingTimelineKeys(cwd)).toEqual(new Set(["old#0", "new#1"]));
	});

	describe("existingTimelineKeys — malformed rows (parseTimelineDedupKey)", () => {
		function seedRawLines(lines: string[]): void {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			appendFileSync(timelinePath(cwd), `${lines.join("\n")}\n`);
		}

		it("P1: keeps a row whose uuid is a string and seq is a number", () => {
			seedRawLines([JSON.stringify({ uuid: "u1", seq: 0 })]);
			expect(existingTimelineKeys(cwd)).toEqual(new Set(["u1#0"]));
		});

		it("N1: rejects rows whose parsed value is not a JSON object", () => {
			seedRawLines(["[1,2,3]", "42", "null", '"str"']);
			expect(() => existingTimelineKeys(cwd)).toThrow(TimelineScanError);
		});

		it("N2: rejects rows whose uuid/seq fields carry the wrong type or are missing", () => {
			seedRawLines([
				JSON.stringify({ uuid: 7, seq: 0 }),
				JSON.stringify({ uuid: "u2", seq: "0" }),
				JSON.stringify({ uuid: "u3" }),
			]);
			expect(() => existingTimelineKeys(cwd)).toThrow(TimelineScanError);
		});
	});

	describe("timelineSize — non-missing stat failure (existingTimelineKeys outer catch)", () => {
		afterEach(() => {
			vi.mocked(statSync).mockRestore();
		});

		it("wraps a non-ENOENT stat error in TimelineScanError instead of treating it as a missing file", () => {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			appendFileSync(timelinePath(cwd), `${JSON.stringify({ uuid: "u1", seq: 0 })}\n`);
			vi.mocked(statSync).mockImplementationOnce(() => {
				throw new Error("EACCES: permission denied, stat");
			});
			expect(() => existingTimelineKeys(cwd)).toThrow(/^cannot inspect timeline: /);
		});
	});

	it("refuses more candidates than the retained-key ceiling before touching the timeline", () => {
		const candidates = {
			size: MAX_EXISTING_TIMELINE_KEYS + 1,
			has: () => false,
			delete: () => false,
		};
		expect(() => removeExistingTimelineCandidates(cwd, candidates)).toThrow(
			new RegExp(
				`refusing ${MAX_EXISTING_TIMELINE_KEYS + 1} timeline candidates \\(limit ${MAX_EXISTING_TIMELINE_KEYS}\\)`,
			),
		);
	});

	it("existingTimelineKeys refuses a timeline with more distinct keys than the retained-key ceiling", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const lines: string[] = [];
		for (let seq = 0; seq <= MAX_EXISTING_TIMELINE_KEYS; seq++) {
			lines.push(JSON.stringify({ uuid: "u", seq }));
		}
		writeFileSync(path, `${lines.join("\n")}\n`);
		expect(() => existingTimelineKeys(cwd)).toThrow(
			new RegExp(`timeline contains more than ${MAX_EXISTING_TIMELINE_KEYS} distinct keys`),
		);
	});

	it("streams a sparse multi-gigabyte history against bounded candidates", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ uuid: "already-there", seq: 0 })}\n`);
		truncateSync(path, 2_200_000_000);
		const candidates = new Map([
			["already-there#0", rec({ ts: "t", uuid: "already-there", seq: 0 })],
		]);

		expect(() => removeExistingTimelineCandidates(cwd, candidates)).toThrow(
			/row larger than/,
		);
		expect([...candidates.keys()]).toEqual(["already-there#0"]);
		expect(() => existingTimelineKeys(cwd)).toThrow(
			new RegExp(`refusing to retain keys.*limit ${MAX_EXISTING_TIMELINE_KEY_SCAN_BYTES}`),
		);
	});

	it("keeps candidates and fails closed on a malformed destination timeline", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(path, "not-json\n");
		const candidates = new Map([
			["new#0", rec({ ts: "t", uuid: "new", seq: 0 })],
		]);

		expect(() => removeExistingTimelineCandidates(cwd, candidates)).toThrow(TimelineScanError);
		expect([...candidates.keys()]).toEqual(["new#0"]);
		expect(readFileSync(path, "utf8")).toBe("not-json\n");
	});

	it("refuses a stale candidate scan when a live append wins the race", () => {
		const old = rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "old", seq: 0 });
		const late = rec({ ts: "2026-06-28T10:00:01.000Z", uuid: "late", seq: 0 });
		const candidate = rec({
			ts: "2026-06-28T10:00:02.000Z",
			uuid: "candidate",
			seq: 0,
		});
		expect(appendTimelineRecords([old], cwd)).toBe(true);
		const candidates = new Map([[recordKey(candidate), candidate]]);
		const basis = removeExistingTimelineCandidates(cwd, candidates);
		expect(appendTimelineRecords([late], cwd)).toBe(true);

		expect(
			appendTimelineRecordsAtBasis({ records: [candidate], cwd, basis }),
		).toBe(false);
		const rows = readFileSync(timelinePath(cwd), "utf8")
			.trim()
			.split("\n")
			.map((line) => parseWire(JSON.parse(line), wireObject({ "uuid": wireString }), "test JSON value"));
		expect(rows.map((row) => row.uuid)).toEqual(["old", "late"]);
	});

	it("fails closed on an oversized or unreadable destination row", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const candidates = new Map([
			["new#0", rec({ ts: "t", uuid: "new", seq: 0 })],
		]);
		writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));
		expect(() => removeExistingTimelineCandidates(cwd, candidates)).toThrow(
			/row larger than/,
		);

		rmSync(path);
		mkdirSync(path);
		expect(() => removeExistingTimelineCandidates(cwd, candidates)).toThrow(
			/cannot scan timeline/,
		);
		expect([...candidates.keys()]).toEqual(["new#0"]);
	});

	it("refuses an over-limit backfill snapshot before materializing it", () => {
		const path = timelinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const initial = `${JSON.stringify(rec({ ts: "t", uuid: "old", seq: 0 }))}\n`;
		writeFileSync(path, initial);
		truncateSync(path, MAX_TIMELINE_REWRITE_BYTES + 1);

		expect(() => writeTimeline([], cwd)).toThrow(
			new RegExp(`refusing to rebuild.*limit ${MAX_TIMELINE_REWRITE_BYTES}`),
		);
		expect(statSync(path).size).toBe(MAX_TIMELINE_REWRITE_BYTES + 1);
	});

	it("bounds live append materialization as well as backfill output", () => {
		const oversized = rec({
			ts: "t",
			uuid: "oversized",
			seq: 0,
			text: "x".repeat(4 * 1024 * 1024),
		});

		expect(appendTimelineRecords([oversized], cwd)).toBe(false);
		expect(() => writeTimeline([oversized], cwd)).toThrow(/row larger than/);
		expect(existsSync(timelinePath(cwd))).toBe(false);
	});

	it("escapes U+2028/U+2029 so the JSONL has no literal line separators", () => {
		const ls = String.fromCharCode(0x2028);
		const ps = String.fromCharCode(0x2029);
		const text = `line one${ls}line two${ps}end`;
		writeTimeline([rec({ ts: "t", uuid: "u", seq: 0, text })], cwd);
		const raw = readFileSync(timelinePath(cwd), "utf-8");
		expect(raw.includes(ls)).toBe(false);
		expect(raw.includes(ps)).toBe(false);
		expect(raw).toContain("\\u2028");
		const parsed: { text?: string } = JSON.parse(raw.trim());
		expect(parsed.text).toBe(text); // round-trips back to the real characters
	});
});
