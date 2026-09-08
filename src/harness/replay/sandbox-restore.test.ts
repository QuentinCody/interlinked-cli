// T2 restore — materialize a session's fork point: the captured working tree
// at seq N plus the archived harness state (live snapshot + baseline
// water-lines written back under .interlinked/), and rebuild the reservation
// cache from the event log via replayTransitions — its first production
// consumption (docs/design/reproducibility/tier2-onpolicy-env.md).

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildReservationCacheAt, restoreSessionStep } from "./sandbox-restore.js";
import { recordStateSnapshot } from "./state-archive.js";
import { recordTreeSnapshot } from "./tree-snapshot.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = "sess-restore";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-restore-"));
	cleanups.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t.local");
	git(dir, "config", "user.name", "probe");
	writeFileSync(join(dir, "app.ts"), "export const version = 1;\n");
	git(dir, "add", "app.ts");
	git(dir, "commit", "-qm", "init");
	writeFileSync(join(dir, "app.ts"), "export const version = 2;\n");
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "metric-caps.json"), '{"lines":500}');
	recordTreeSnapshot({
		cwd: dir,
		sessionId: SESSION,
		seq: 9,
		toolUseId: "toolu_9",
		phase: "pre",
		log: () => undefined,
	});
	recordStateSnapshot({
		cwd: dir,
		sessionId: SESSION,
		seq: 9,
		liveSnapshot: { tool_call_count: 4 },
		log: () => undefined,
	});
	return dir;
}

describe("restoreSessionStep", () => {
	it("materializes the tree + live snapshot + baseline files at a seq", () => {
		const dir = fixture();
		const dest = mkdtempSync(join(tmpdir(), "il-restore-dest-"));
		cleanups.push(dest);
		const summary = restoreSessionStep({ cwd: dir, sessionId: SESSION, seq: 9, destDir: dest });
		expect(summary.tree).toMatch(/^[0-9a-f]{40}$/);
		expect(summary.state_found).toBe(true);
		expect(readFileSync(join(dest, "app.ts"), "utf-8")).toBe("export const version = 2;\n");
		expect(readFileSync(join(dest, ".interlinked", "metric-caps.json"), "utf-8")).toBe(
			'{"lines":500}',
		);
		const live = JSON.parse(
			readFileSync(join(dest, ".interlinked", "restored-live-snapshot.json"), "utf-8"),
		);
		expect(live).toEqual({ tool_call_count: 4 });
	});

	it("throws a descriptive error when no snapshot exists for the seq", () => {
		const dir = fixture();
		const dest = mkdtempSync(join(tmpdir(), "il-restore-none-"));
		cleanups.push(dest);
		expect(() =>
			restoreSessionStep({ cwd: dir, sessionId: SESSION, seq: 999, destDir: dest }),
		).toThrow(/no tree snapshot/);
	});
});

describe("rebuildReservationCacheAt", () => {
	function writeLog(dir: string, rows: unknown[]): void {
		const path = join(dir, ".interlinked", "reservation-events.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	}

	it("replays grants/releases up to the cutoff via replayTransitions", () => {
		const dir = fixture();
		writeLog(dir, [
			{ ts: "2026-07-24T10:00:00Z", action: "grant", file: "a.ts", agent_name: "alice", cohort: "local", expires_at: "2026-07-24T10:05:00Z" },
			{ ts: "2026-07-24T10:01:00Z", action: "grant", file: "b.ts", agent_name: "bob", cohort: "remote", expires_at: "2026-07-24T10:06:00Z" },
			{ ts: "2026-07-24T10:02:00Z", action: "conflict", file: "a.ts", agent_name: "bob", holder: "alice" },
			{ ts: "2026-07-24T10:03:00Z", action: "release", file: "a.ts", agent_name: "alice" },
			{ ts: "2026-07-24T10:04:00Z", action: "grant", file: "c.ts", agent_name: "alice", cohort: "local", expires_at: "2026-07-24T10:09:00Z" },
		]);
		const atCutoff = rebuildReservationCacheAt(dir, "2026-07-24T10:03:30Z");
		expect([...atCutoff.keys()].sort()).toEqual(["b.ts"]);
		expect(atCutoff.get("b.ts")?.cohort).toBe("remote");

		const beforeRelease = rebuildReservationCacheAt(dir, "2026-07-24T10:02:30Z");
		expect([...beforeRelease.keys()].sort()).toEqual(["a.ts", "b.ts"]);

		const all = rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z");
		expect([...all.keys()].sort()).toEqual(["b.ts", "c.ts"]);
	});

	it("returns an empty cache when the log is missing", () => {
		expect(rebuildReservationCacheAt(fixture(), "2026-07-24T23:59:59Z").size).toBe(0);
	});

	it("N1: an array-shaped line (valid JSON, not an object) is skipped, not thrown", () => {
		const dir = fixture();
		writeLog(dir, [
			["not", "an", "object"],
			{ ts: "2026-07-24T10:00:00Z", action: "grant", file: "a.ts", agent_name: "alice", cohort: "local", expires_at: "2026-07-24T10:05:00Z" },
		]);
		expect(() => rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z")).not.toThrow();
		const cache = rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z");
		expect([...cache.keys()]).toEqual(["a.ts"]);
	});

	it("N2: a bare-string JSON line is skipped, not thrown", () => {
		const dir = fixture();
		writeLog(dir, ["just-a-string"]);
		expect(() => rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z")).not.toThrow();
		expect(rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z").size).toBe(0);
	});

	it("N3: a line that fails JSON.parse outright (malformed text, not just the wrong shape) is skipped, not thrown, and later valid rows still replay", () => {
		const dir = fixture();
		const path = join(dir, ".interlinked", "reservation-events.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, "{this is not json at all\n");
		const validRow = JSON.stringify({
			ts: "2026-07-24T10:00:00Z",
			action: "grant",
			file: "a.ts",
			agent_name: "alice",
			cohort: "local",
			expires_at: "2026-07-24T10:05:00Z",
		});
		appendFileSync(path, `${validRow}\n`);
		expect(() => rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z")).not.toThrow();
		const cache = rebuildReservationCacheAt(dir, "2026-07-24T23:59:59Z");
		expect([...cache.keys()]).toEqual(["a.ts"]);
	});
});
