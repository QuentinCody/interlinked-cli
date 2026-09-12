import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TEST_SANDBOX_HOME } from "../test-setup/home-sandbox.js";
import {
	__test_only__,
	codexSessionsDir,
	collectCodexSessions,
	findCodexRollouts,
} from "./codex-collect.js";
import { appendTimelineRecordsAtBasis, TimelineScanError } from "./timeline-writer.js";
import type { TimelineRecord } from "./transcript-record.js";

const { addCandidateRecords } = __test_only__;

// Wraps the real implementation by default (`vi.fn(actual)`), so every test
// in this file except the one that calls `mockReturnValueOnce` below runs
// against genuine append/lock/dedup behavior — only that one test injects
// the race condition finishCollection guards against.
vi.mock("./timeline-writer.js", async () => {
	const actual = await vi.importActual<typeof import("./timeline-writer.js")>("./timeline-writer.js");
	return { ...actual, appendTimelineRecordsAtBasis: vi.fn(actual.appendTimelineRecordsAtBasis) };
});

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	roots.push(d);
	return d;
}

function rollout(session: string): string {
	return [
		{ timestamp: "2026-07-18T18:40:04Z", type: "session_meta", payload: { session_id: session, cwd: "/r" } },
		{ timestamp: "2026-07-18T18:40:05Z", type: "response_item", payload: { type: "turn_context", model: "oai-model-v6" } },
		{ timestamp: "2026-07-18T18:40:06Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Review." }] } },
		{ timestamp: "2026-07-18T18:40:16Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
	]
		.map((e) => JSON.stringify(e))
		.join("\n");
}

describe("codexSessionsDir", () => {
	// test-contract: public-api — collectCodexSessions falls back to this
	// exact path when no `dir` override is given (see the `opts.dir ??
	// codexSessionsDir()` call), so its value is load-bearing, not incidental.
	it("resolves to <home>/.codex/sessions", () => {
		expect(codexSessionsDir()).toBe(join(homedir(), ".codex", "sessions"));
	});
});

describe("findCodexRollouts", () => {
	it("finds rollout files recursively and honors --since mtime", () => {
		const dir = tmp("codex-find-");
		const day = join(dir, "2026", "07", "18");
		mkdirSync(day, { recursive: true });
		const old = join(day, "rollout-old.jsonl");
		const recent = join(day, "rollout-recent.jsonl");
		writeFileSync(old, rollout("s-old"));
		writeFileSync(recent, rollout("s-recent"));
		writeFileSync(join(day, "notes.txt"), "ignore me");
		const t0 = new Date("2026-07-18T00:00:00Z");
		utimesSync(old, t0, t0); // backdate the old file
		expect(findCodexRollouts(dir).sort()).toEqual([old, recent].sort());
		expect(findCodexRollouts(dir, Date.now() - 60_000)).toEqual([recent]);
		expect(findCodexRollouts(join(dir, "does-not-exist"))).toEqual([]);
	});

	// test-contract: invariant — statOrNull's catch must yield null (skip),
	// not propagate, for an entry that vanishes between readdir and stat
	// (here, a symlink whose target never existed), or the whole scan throws.
	it("skips a dangling symlink instead of throwing", () => {
		const dir = tmp("codex-dangling-");
		const real = join(dir, "rollout-real.jsonl");
		writeFileSync(real, rollout("s-real"));
		const broken = join(dir, "rollout-broken.jsonl");
		symlinkSync(join(dir, "no-such-target"), broken);

		let found: string[] = [];
		expect(() => {
			found = findCodexRollouts(dir);
		}).not.toThrow();
		expect(found).toEqual([real]);
	});
});

describe("collectCodexSessions", () => {
	it("imports the default session directory when no directory override is supplied", () => {
		// The suite's home-sandbox setup isolates this real default-path lookup.
		expect(codexSessionsDir()).toBe(join(TEST_SANDBOX_HOME, ".codex", "sessions"));
		mkdirSync(codexSessionsDir(), { recursive: true });
		const day = mkdtempSync(join(codexSessionsDir(), "collect-default-"));
		roots.push(day);
		writeFileSync(join(day, "rollout-default.jsonl"), rollout("default-session"));
		const cwd = tmp("codex-default-destination-");
		const result = collectCodexSessions({ cwd });
		expect(result).toMatchObject({ files: 1, sessions: 1 });
		const records = readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line));
		expect(records).toEqual(expect.arrayContaining([
			expect.objectContaining({ session: "default-session", category: "agent_message", text: "Done." }),
		]));
	});

	it("skips an oversized rollout even when it starts with valid session records", () => {
		const dir = tmp("codex-oversized-source-");
		const file = join(dir, "rollout-oversized.jsonl");
		writeFileSync(file, `${rollout("oversized-session")}\n`);
		// A sparse tail exercises the 64 MiB input limit without allocating it.
		truncateSync(file, 64 * 1024 * 1024 + 1);
		expect(collectCodexSessions({ cwd: tmp("codex-oversized-destination-"), dir })).toEqual({
			files: 1, parsed: 0, added: 0, sessions: 0,
		});
	});

	const setup = () => {
		const dir = tmp("codex-src-");
		const cwd = tmp("codex-cwd-");
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const day = join(dir, "2026", "07", "18");
		mkdirSync(day, { recursive: true });
		writeFileSync(join(day, "rollout-a.jsonl"), rollout("sess-a"));
		writeFileSync(join(day, "rollout-b.jsonl"), rollout("sess-b"));
		return { dir, cwd };
	};

	it("appends normalized codex records to timeline.jsonl", () => {
		const { dir, cwd } = setup();
		const r = collectCodexSessions({ cwd, dir });
		expect(r.files).toBe(2);
		expect(r.sessions).toBe(2);
		expect(r.added).toBe(r.parsed);
		expect(r.added).toBeGreaterThan(0);
		const lines = readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8").trim().split("\n");
		const recs = lines.map((l) => JSON.parse(l));
		expect(recs.every((x) => x.provider === "codex")).toBe(true);
		expect(recs.some((x) => x.category === "user_prompt" && x.text === "Review.")).toBe(true);
		expect(recs.some((x) => x.category === "agent_message" && x.model === "oai-model-v6")).toBe(true);
	});

	it("is idempotent — a second run appends nothing", () => {
		const { dir, cwd } = setup();
		const first = collectCodexSessions({ cwd, dir });
		const second = collectCodexSessions({ cwd, dir });
		expect(first.added).toBeGreaterThan(0);
		expect(second.added).toBe(0);
		expect(second.parsed).toBe(first.parsed); // still parses, just dedups
	});

	it("dryRun reports counts without writing", () => {
		const { dir, cwd } = setup();
		const r = collectCodexSessions({ cwd, dir, dryRun: true });
		expect(r.added).toBeGreaterThan(0);
		let wrote = true;
		try {
			readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8");
		} catch {
			wrote = false;
		}
		expect(wrote).toBe(false);
	});

	it("fails closed without duplicating a sparse multi-gigabyte history", () => {
		const { dir, cwd } = setup();
		const first = collectCodexSessions({ cwd, dir });
		const path = join(cwd, ".interlinked", "timeline.jsonl");
		truncateSync(path, 2_200_000_000);

		expect(first.added).toBeGreaterThan(0);
		expect(() => collectCodexSessions({ cwd, dir })).toThrow(/row larger than/);
		expect(statSync(path).size).toBe(2_200_000_000);
	});

	it("fails closed and preserves a malformed destination timeline", () => {
		const { dir, cwd } = setup();
		const path = join(cwd, ".interlinked", "timeline.jsonl");
		const malformed = "not-json\n";
		writeFileSync(path, malformed);

		expect(() => collectCodexSessions({ cwd, dir })).toThrow(TimelineScanError);
		expect(readFileSync(path, "utf8")).toBe(malformed);
	});

	// test-contract: invariant — readCodexRollout's catch must yield null
	// (skip the file) rather than propagate, for a rollout that exists and
	// matches the name pattern but cannot be opened. An unreadable file is
	// counted as scanned but contributes nothing to parsed/added/sessions.
	it("skips an unreadable rollout file instead of throwing", () => {
		const { dir, cwd } = setup();
		const unreadable = join(dir, "2026", "07", "18", "rollout-c.jsonl");
		writeFileSync(unreadable, rollout("sess-locked"));
		chmodSync(unreadable, 0o000);
		try {
			const r = collectCodexSessions({ cwd, dir });
			expect(r.files).toBe(3); // scanned: a, b, and the locked one
			expect(r.sessions).toBe(2); // only a and b parsed into records
		} finally {
			chmodSync(unreadable, 0o644);
		}
	});

	// test-contract: invariant — finishCollection must refuse to report
	// success when appendTimelineRecordsAtBasis reports the destination
	// changed since it was scanned, so history can never silently drop.
	it("throws when the destination timeline changed underneath the write", () => {
		const { dir, cwd } = setup();
		vi.mocked(appendTimelineRecordsAtBasis).mockReturnValueOnce(false);
		expect(() => collectCodexSessions({ cwd, dir })).toThrow(
			"timeline changed after collection scanned it; no Codex records were appended",
		);
	});
});

describe("addCandidateRecords (bounded batch guard)", () => {
	// test-contract: invariant — a batch already at/over the byte budget must
	// refuse a new record rather than silently growing past it; the check
	// runs BEFORE insertion, so the record must not be added either.
	it("throws instead of accepting a record that would exceed the byte budget", () => {
		const batch = { records: new Map<string, TimelineRecord>(), bytes: Number.MAX_SAFE_INTEGER, parsed: 0 };
		const record: TimelineRecord = {
			schema: "timeline.v1",
			ts: "2026-07-18T00:00:00Z",
			session: "s1",
			uuid: "11111111-1111-1111-1111-111111111111",
			seq: 0,
			category: "user_prompt",
			role: "user",
			text: "hi",
		};
		expect(() => addCandidateRecords(batch, [record])).toThrow(/bounded candidate limit/);
		expect(batch.records.size).toBe(0);
	});
});
