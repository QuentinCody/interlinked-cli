import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(actual.spawnSync),
	};
});

import { spawnSync } from "node:child_process";
import {
	loadSnapshotIndex,
	maybeRecordReplaySnapshots,
	parseTreeSnapshotRecord,
	phaseForHookEvent,
	recordTreeSnapshot,
	restoreTree,
	snapshotIndexPath,
} from "./tree-snapshot.js";

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "tree-snapshot-w50-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

describe("parseTreeSnapshotRecord — positive/negative", () => {
	const valid = {
		schema: "tree-snapshot.v1",
		backend: "git",
		phase: "pre",
		session_id: "s1",
		tree: "deadbeef",
		commit: "cafebabe",
		ts: "2026-01-01T00:00:00.000Z",
	};

	// test-contract: public-api — parseTreeSnapshotRecord is the exported validator; a
	// fully-valid input must round-trip into a non-null record.
	it("P: valid object returns a full record", () => {
		const rec = parseTreeSnapshotRecord({ ...valid });
		expect(rec).not.toBeNull();
		expect(rec?.session_id).toBe("s1");
	});

	// test-contract: boundary — isJsonObject(value) guards every field access below it;
	// a non-object must short-circuit to null rather than throw on property access.
	it("N: non-object value (null) returns null without throwing", () => {
		expect(() => parseTreeSnapshotRecord(null)).not.toThrow();
		expect(parseTreeSnapshotRecord(null)).toBeNull();
	});

	// test-contract: boundary — same isJsonObject guard, a primitive input.
	it("N: non-object value (string) returns null without throwing", () => {
		expect(parseTreeSnapshotRecord("not-an-object")).toBeNull();
	});

	// test-contract: invariant — `typeof session_id !== "string"` must reject a
	// non-string session_id even when every other field is well-typed.
	it("N: session_id not a string returns null", () => {
		expect(parseTreeSnapshotRecord({ ...valid, session_id: 42 })).toBeNull();
	});

	// test-contract: invariant — the `commit`/`ts` OR-check must reject an invalid
	// commit even when ts alone is valid (isolates the commit clause).
	it("N: commit not a string (ts valid) returns null", () => {
		expect(parseTreeSnapshotRecord({ ...valid, commit: 42 })).toBeNull();
	});

	// test-contract: invariant — isolates the ts clause of the same OR-check.
	it("N: ts not a string (commit valid) returns null", () => {
		expect(parseTreeSnapshotRecord({ ...valid, ts: 42 })).toBeNull();
	});

	// test-contract: invariant — `seq !== null && typeof seq !== "number"` must
	// reject a present-but-wrong-typed seq.
	it("N: seq present but not a number returns null", () => {
		expect(parseTreeSnapshotRecord({ ...valid, seq: "not-a-number" })).toBeNull();
	});

	// test-contract: invariant — mirrors the seq check for tool_use_id.
	it("N: tool_use_id present but not a string returns null", () => {
		expect(parseTreeSnapshotRecord({ ...valid, tool_use_id: 42 })).toBeNull();
	});
});

describe("snapshotIndexPath — string literal segments", () => {
	// test-contract: public-api — snapshotIndexPath is exported and its "replay"/
	// "snapshots" path segments are load-bearing (readers/writers must agree).
	it("builds the exact replay/snapshots/index.jsonl path", () => {
		const p = snapshotIndexPath("/tmp/repo-root");
		expect(p).toBe(join("/tmp/repo-root", ".interlinked", "replay", "snapshots", "index.jsonl"));
	});
});

describe("loadSnapshotIndex — filters null parses", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "tree-snapshot-load-w50-"));
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — `if (parsed) out.push(parsed)` must drop rows that
	// parse as JSON but fail parseTreeSnapshotRecord's schema validation.
	it("does not include entries that fail record validation", () => {
		const idxPath = snapshotIndexPath(tmp);
		mkdirSync(dirname(idxPath), { recursive: true });
		writeFileSync(idxPath, `${JSON.stringify({ schema: "not-a-match" })}\n`);
		const recs = loadSnapshotIndex(tmp);
		expect(recs).toEqual([]);
	});

	// test-contract: boundary — loadSnapshotIndex must not throw when the index
	// file has never been created.
	it("returns an empty array when the file is absent", () => {
		const tmp2 = mkdtempSync(join(tmpdir(), "tree-snapshot-missing-w50-"));
		expect(loadSnapshotIndex(tmp2)).toEqual([]);
		rmSync(tmp2, { recursive: true, force: true });
	});
});

describe("phaseForHookEvent", () => {
	// test-contract: invariant — the third disjunct of the post-phase check
	// (`hookEvent === "AfterTool"`) must independently drive the "post" result.
	it("maps AfterTool to post", () => {
		expect(phaseForHookEvent("AfterTool")).toBe("post");
	});
});

describe("restoreTree — throws on tar extraction failure", () => {
	let tmp: string;
	let destDir: string;
	let treeSha: string;

	beforeAll(() => {
		tmp = makeGitRepo();
		treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: tmp, encoding: "utf-8" }).trim();
		destDir = join(tmp, "restore-dest");
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.mocked(spawnSync).mockClear();
	});

	// test-contract: public-api — restoreTree is documented to throw on failure
	// (Tier 2 explicit op); `result.status !== 0` must trigger that throw.
	it("throws with the tar stderr when the extraction exits non-zero", () => {
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 1,
			signal: null,
			pid: 1,
			output: [],
			stdout: Buffer.alloc(0),
			stderr: Buffer.from("boom: extraction failed"),
			// SAFETY: restoreTree only reads .status and .stderr from the result;
			// this fixture supplies both plus the other SpawnSyncReturns fields.
		});
		expect(() => restoreTree(tmp, treeSha, destDir)).toThrow(/tar extract failed/);
	});
});

describe("recordTreeSnapshot — real git repo behavior", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — indexCachePath's "replay"/"snapshots"/"index-cache"
	// literals and the `${safeSession}.gitindex` template determine exactly where
	// the persistent temp index lands; observe it via the file it actually creates.
	it("writes the index-cache file at the exact expected path", () => {
		tmp = makeGitRepo();
		const logs: string[] = [];
		const record = recordTreeSnapshot({
			cwd: tmp,
			sessionId: "sess1",
			seq: 1,
			toolUseId: null,
			phase: "pre",
			log: (m) => logs.push(m),
		});
		expect(record).not.toBeNull();
		const expectedIdx = join(tmp, ".interlinked", "replay", "snapshots", "index-cache", "sess1.gitindex");
		expect(existsSync(expectedIdx)).toBe(true);
		expect(logs).toEqual([]);
	});

	// test-contract: public-api — recordTreeSnapshot must persist to the exact
	// path snapshotIndexPath computes; writers/readers must agree on it.
	it("appends the record to the exact snapshots/index.jsonl path", () => {
		tmp = makeGitRepo();
		recordTreeSnapshot({
			cwd: tmp,
			sessionId: "sess2",
			seq: null,
			toolUseId: null,
			phase: "post",
			log: () => {},
		});
		const expectedIndexPath = join(tmp, ".interlinked", "replay", "snapshots", "index.jsonl");
		expect(existsSync(expectedIndexPath)).toBe(true);
	});

	// test-contract: invariant — the commit message template and its two `??`
	// fallback operators (`opts.seq ?? "?"`, `opts.toolUseId ?? "-"`) must render
	// truthy values verbatim, not their fallback strings.
	it("embeds the exact seq/tool_use/phase values in the commit message", () => {
		tmp = makeGitRepo();
		recordTreeSnapshot({
			cwd: tmp,
			sessionId: "sess3",
			seq: 1,
			toolUseId: "tu-abc",
			phase: "post",
			log: () => {},
		});
		const ref = "refs/interlinked/replay/sess3";
		const msg = execFileSync("git", ["log", "-1", "--format=%s", ref], {
			cwd: tmp,
			encoding: "utf-8",
		}).trim();
		expect(msg).toBe("seq=1 tool_use=tu-abc phase=post");
	});

	// test-contract: bug — recordTreeSnapshot's contract is "never throws"; the
	// catch-branch error string template must render the actual error text, not
	// an empty message that hides the failure from the daemon log.
	it("logs the exact non-fatal failure message and returns null when git is unavailable", () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "tree-snapshot-nogit-w50-"));
		const logs: string[] = [];
		const result = recordTreeSnapshot({
			cwd: nonGitDir,
			sessionId: "sess-fail",
			seq: null,
			toolUseId: null,
			phase: "pre",
			log: (m) => logs.push(m),
		});
		expect(result).toBeNull();
		expect(logs).toHaveLength(1);
		const [first] = logs;
		expect(first).toBeDefined();
		expect(first?.startsWith("tree snapshot failed (non-fatal):")).toBe(true);
		expect(first).not.toBe("");
		rmSync(nonGitDir, { recursive: true, force: true });
	});
});

describe("maybeRecordReplaySnapshots — phase null gate", () => {
	const envKey = "INTERLINKED_REPLAY_TREE_SNAPSHOTS";
	let prevEnv: string | undefined;

	beforeAll(() => {
		prevEnv = process.env[envKey];
		process.env[envKey] = "1";
	});

	afterAll(() => {
		if (prevEnv === undefined) delete process.env[envKey];
		else process.env[envKey] = prevEnv;
	});

	// test-contract: invariant — `opts.phase === null` must gate out recording
	// entirely; observed via zero log calls even though a real failure (non-git
	// cwd) would otherwise be logged.
	it("does not attempt any recording when phase is null", () => {
		const logs: string[] = [];
		maybeRecordReplaySnapshots({
			cwd: "/nonexistent/not-a-git-repo-w50",
			sessionId: "sess-null-phase",
			seq: null,
			toolUseId: null,
			phase: null,
			liveSnapshot: null,
			log: (m) => logs.push(m),
		});
		expect(logs).toEqual([]);
	});
});
