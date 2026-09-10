import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearCrossSessionCache, loadRecentWorkspaceEvents } from "./cross-session.js";

describe("loadRecentWorkspaceEvents", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xsession-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeLog(events: ReadonlyArray<Record<string, unknown>>): void {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		const lines = events.map((e) => JSON.stringify(e));
		writeFileSync(join(sub, "activity.jsonl"), `${lines.join("\n")}\n`, "utf-8");
	}

	it("returns an empty array when no activity.jsonl is present", () => {
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
	});

	it("parses every JSONL line into a HarnessEvent", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PreToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:02Z" },
		]);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(2);
	});

	it("normalizes the v5 activity wire shape used by the real log", () => {
		writeLog([
			{
				schema_version: 5,
				ts: "2026-05-27T00:00:02Z",
				agent: "worker-7",
				type: "tool_use_start",
				tool: "Edit",
				tool_input: { file_path: "src/live.ts" },
				session: "session-7",
			},
		]);

		expect(loadRecentWorkspaceEvents(dir)).toEqual([
			{
				timestamp: "2026-05-27T00:00:02Z",
				agent_name: "worker-7",
				tool_name: "Edit",
				tool_input: { file_path: "src/live.ts" },
				session_id: "session-7",
				hook_event: "PreToolUse",
				cwd: dir,
			},
		]);
	});

	describe("guard-blocked attempts — positive/negative", () => {
		const attempt = {
			schema_version: 5,
			ts: "2026-05-27T00:00:02Z",
			agent: "worker-7",
			type: "tool_use_start",
			tool: "Write",
			tool_use_id: "toolu_1",
			tool_input: { file_path: "src/live.ts" },
			session: "session-7",
		};

		it("N1: drops a tool_use_start row whose guard_block twin (same tool_use_id) shows the write never landed", () => {
			writeLog([
				attempt,
				{ schema_version: 5, ts: "2026-05-27T00:00:02Z", agent: "worker-7", type: "guard_block", tool: "Write", tool_use_id: "toolu_1", guard_decision: "block", session: "session-7" },
			]);
			expect(loadRecentWorkspaceEvents(dir).filter((e) => e.tool_name === "Write")).toEqual([]);
		});

		it("P1: keeps a tool_use_start row when the guard_block twin carries a different tool_use_id", () => {
			writeLog([
				attempt,
				{ schema_version: 5, ts: "2026-05-27T00:00:03Z", agent: "worker-7", type: "guard_block", tool: "Write", tool_use_id: "toolu_2", guard_decision: "block", session: "session-7" },
			]);
			expect(loadRecentWorkspaceEvents(dir).filter((e) => e.tool_name === "Write")).toHaveLength(1);
		});

		it("P2: keeps a tool_use_start row with no guard_block row at all", () => {
			writeLog([attempt]);
			expect(loadRecentWorkspaceEvents(dir).filter((e) => e.tool_name === "Write")).toHaveLength(1);
		});
	});

	it("filters out events with timestamps below `sinceTimestamp`", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PreToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:05Z" },
		]);
		const filtered = loadRecentWorkspaceEvents(dir, "2026-05-27T00:00:03Z");
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.session_id).toBe("s2");
	});

	it("survives malformed JSONL lines (skips them silently)", () => {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sub, "activity.jsonl"),
			`{"hook_event":"PreToolUse","session_id":"s1","timestamp":"2026-05-27T00:00:01Z"}\nNOT VALID JSON\n{"hook_event":"PreToolUse","session_id":"s2","timestamp":"2026-05-27T00:00:02Z"}\n`,
			"utf-8",
		);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(2);
	});

	it("P: keeps a valid JSON object line (object-shape gate positive case)", () => {
		writeLog([{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" }]);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(1);
	});

	it("N: rejects a well-formed but non-object JSON line — bare array (object-shape gate)", () => {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sub, "activity.jsonl"),
			`${JSON.stringify(["not", "an", "event"])}\n{"hook_event":"PreToolUse","session_id":"s1","timestamp":"2026-05-27T00:00:01Z"}\n`,
			"utf-8",
		);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(1);
	});

	it("N: rejects well-formed but non-object JSON lines — number, string, null (object-shape gate)", () => {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sub, "activity.jsonl"),
			[
				"42",
				'"just a string"',
				"null",
				'{"hook_event":"PreToolUse","session_id":"s1","timestamp":"2026-05-27T00:00:01Z"}',
			].join("\n"),
			"utf-8",
		);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(1);
	});

	it("caches the result and returns the same array on a second call with no file change", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		const second = loadRecentWorkspaceEvents(dir);
		// Same reference confirms cache hit (we return the cached array as-is).
		expect(first).toBe(second);
	});

	it("caps the loaded count at 500 trailing events", () => {
		const many: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			many.push({
				hook_event: "PreToolUse",
				session_id: `s${i}`,
				timestamp: `2026-05-27T00:00:${(i % 60).toString().padStart(2, "0")}Z`,
			});
		}
		writeLog(many);
		expect(loadRecentWorkspaceEvents(dir).length).toBe(500);
	});

	it("keeps only the trailing 500 (drops the OLDEST events, not the newest)", () => {
		const many: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			many.push({
				hook_event: "PreToolUse",
				session_id: `s${i}`,
				timestamp: "2026-05-27T00:00:00Z",
			});
		}
		writeLog(many);
		const got = loadRecentWorkspaceEvents(dir);
		// First retained event is s100 (600 total, last 500 kept => indices 100..599).
		expect(got[0]?.session_id).toBe("s100");
		expect(got[got.length - 1]?.session_id).toBe("s599");
	});

	it("uses the bounded reverse reader instead of materializing the whole activity log", () => {
		const source = readFileSync(new URL("./cross-session.ts", import.meta.url), "utf-8");
		expect(source).toContain(
			"readRecentLines(logPath, MAX_TRAILING_EVENTS, MAX_TRAILING_BYTES)",
		);
		expect(source).not.toContain('readFileSync(logPath, "utf-8")');
	});

	it("reads a valid v5 tail from a sparse 1 GiB log without scanning the sparse prefix", () => {
		const sub = join(dir, ".interlinked");
		const log = join(sub, "activity.jsonl");
		mkdirSync(sub, { recursive: true });
		writeFileSync(log, "");
		truncateSync(log, 1024 * 1024 * 1024);
		appendFileSync(
			log,
			`\n${JSON.stringify({
				schema_version: 5,
				ts: "2026-05-27T00:00:02Z",
				agent: "worker-tail",
				type: "tool_use_start",
				tool: "Edit",
				tool_input: { file_path: "src/tail.ts" },
			})}\n`,
		);

		expect(loadRecentWorkspaceEvents(dir)).toMatchObject([
			{
				timestamp: "2026-05-27T00:00:02Z",
				agent_name: "worker-tail",
				tool_name: "Edit",
			},
		]);
	});

	it("returns [] when activity.jsonl can be stat'd but not read (EISDIR)", () => {
		// statSync succeeds on a directory and yields a numeric mtimeMs, but
		// readFileSync throws EISDIR — exercising the read-failure catch that
		// is distinct from the stat-failure (missing-file) path.
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		// Create activity.jsonl AS A DIRECTORY.
		mkdirSync(join(sub, "activity.jsonl"), { recursive: true });
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
		// And again — the read-failure path returns before populating the
		// cache, so a second call also re-reads and returns [].
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
	});

	it("re-reads (cache miss) after the log file's mtime changes", async () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		expect(first).toHaveLength(1);

		// Rewrite the log with different content. mtimeMs must advance so the
		// cached entry is treated as stale.
		// interlinked-ignore: hardcoded_timeout_in_tests — waits out filesystem mtime resolution so the rewrite gets a distinct mtimeMs; not a flaky race
		await new Promise((r) => setTimeout(r, 12));
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PostToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:02Z" },
		]);

		const second = loadRecentWorkspaceEvents(dir);
		// New content observed => cache was invalidated, fresh parse happened.
		expect(second).not.toBe(first);
		expect(second.map((e) => e.session_id)).toEqual(["s1", "s2"]);
	});

	it("forces a fresh read after _clearCrossSessionCache (new array reference)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		// Same key would normally be a cache hit returning the same reference...
		expect(loadRecentWorkspaceEvents(dir)).toBe(first);
		// ...but after clearing, the next call must re-parse into a NEW array.
		_clearCrossSessionCache();
		const afterClear = loadRecentWorkspaceEvents(dir);
		expect(afterClear).not.toBe(first);
		expect(afterClear.map((e) => e.session_id)).toEqual(["s1"]);
	});

	it("does not evict while at or below the 16-entry cache cap", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// Exactly 16 distinct (cwd, since) keys => cache fills to the cap but
		// never overflows, so the very first key stays resident.
		const refs: Array<ReturnType<typeof loadRecentWorkspaceEvents>> = [];
		for (let i = 0; i < 16; i++) {
			refs.push(loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`));
		}
		// since_0 is still cached: a re-call returns the SAME array reference.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(refs[0]);
	});

	it("evicts the oldest cache entry once the 16-entry cap is exceeded (LRU)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// 17 distinct keys => the 17th insert overflows the 16-entry cap and
		// evicts exactly one entry from the front (the oldest = since_0).
		const refs: Array<ReturnType<typeof loadRecentWorkspaceEvents>> = [];
		for (let i = 0; i < 17; i++) {
			refs.push(loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`));
		}
		// since_0 was evicted: re-calling re-parses into a NEW array reference.
		const reloaded0 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z");
		expect(reloaded0).not.toBe(refs[0]);
		// The most-recently-inserted key (since_16) is still resident: SAME ref.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:16Z")).toBe(refs[16]);
		// Content is still correct after eviction churn.
		expect(reloaded0.map((e) => e.session_id)).toEqual(["s1"]);
	});

	it("a cache HIT promotes the entry, protecting it from later eviction (LRU recency)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// Fill exactly to the cap with keys since_0..since_15 and keep the
		// since_0 and since_1 references to detect later eviction by identity.
		const ref0 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z");
		const ref1 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:01Z");
		for (let i = 2; i < 16; i++) {
			loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`);
		}
		// Touch since_0 -> deleted+reinserted (now most-recent). The eviction
		// front advances past it, so since_1 is now the oldest entry.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(ref0);
		// One more distinct key overflows the cap; eviction removes the OLDEST,
		// which is now since_1 (since_0 was just promoted out of harm's way).
		loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:16Z");
		// since_0 was promoted and survives: SAME reference.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(ref0);
		// since_1 was the eviction victim: reloading yields a DIFFERENT array.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:01Z")).not.toBe(ref1);
	});
});

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
