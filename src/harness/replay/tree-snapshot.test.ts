// G2 tree snapshots — pins the probe-verified design
// (docs/design/reproducibility/g2-tree-snapshots.md): temp-index write-tree
// captures tracked+untracked while honoring ignores and never touching the
// real index; snapshots chain through commits under ONE ref so `git gc
// --prune=now` cannot reap them; restoreTree round-trips byte-identical.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStateSnapshot } from "./state-archive.js";
import {
	loadSnapshotIndex,
	maybeRecordReplaySnapshots,
	parseTreeSnapshotRecord,
	phaseForHookEvent,
	recordTreeSnapshot,
	restoreTree,
	snapshotIndexPath,
} from "./tree-snapshot.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** A tiny real repo: one committed file, a gitignore covering ignored/ and
 *  .interlinked/, then a tracked modification + an untracked file. */
function makeFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-g2-"));
	cleanups.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t.local");
	git(dir, "config", "user.name", "probe");
	writeFileSync(join(dir, ".gitignore"), "ignored/\n.interlinked/\n");
	writeFileSync(join(dir, "a.txt"), "a\n");
	git(dir, "add", ".gitignore", "a.txt");
	git(dir, "commit", "-qm", "init");
	writeFileSync(join(dir, "a.txt"), "a\nmodified\n");
	writeFileSync(join(dir, "untracked.txt"), "new\n");
	mkdirSync(join(dir, "ignored"), { recursive: true });
	writeFileSync(join(dir, "ignored", "x.txt"), "x\n");
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "y.txt"), "y\n");
	return dir;
}

function snap(dir: string, seq: number, phase: "pre" | "post"): void {
	recordTreeSnapshot({
		cwd: dir,
		sessionId: "sess-g2",
		seq,
		toolUseId: `toolu_${seq}`,
		phase,
		log: () => undefined,
	});
}

describe("recordTreeSnapshot", () => {
	it("captures tracked mod + untracked, excludes ignored + .interlinked, real index untouched", () => {
		const dir = makeFixture();
		const before = git(dir, "status", "--short");
		snap(dir, 1, "pre");
		const rows = loadSnapshotIndex(dir);
		expect(rows).toHaveLength(1);
		const tree = rows[0]?.tree ?? "";
		const paths = git(dir, "ls-tree", "-r", "--name-only", tree).split("\n").sort();
		expect(paths).toEqual([".gitignore", "a.txt", "untracked.txt"]);
		expect(git(dir, "status", "--short")).toBe(before);
	});

	it("stamps the index row with session/seq/tool_use/phase", () => {
		const dir = makeFixture();
		snap(dir, 7, "post");
		const row = loadSnapshotIndex(dir)[0];
		expect(row).toMatchObject({
			schema: "tree-snapshot.v1",
			session_id: "sess-g2",
			seq: 7,
			tool_use_id: "toolu_7",
			phase: "post",
			backend: "git",
		});
	});

	it("chains snapshots under one ref and survives git gc --prune=now", () => {
		const dir = makeFixture();
		snap(dir, 1, "pre");
		writeFileSync(join(dir, "a.txt"), "a\nmodified twice\n");
		snap(dir, 2, "post");
		const rows = loadSnapshotIndex(dir);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.tree).not.toBe(rows[1]?.tree);

		const tip = git(dir, "rev-parse", "refs/interlinked/replay/sess-g2");
		const parent = git(dir, "rev-parse", `${tip}^`);
		expect(git(dir, "rev-parse", `${tip}^{tree}`)).toBe(rows[1]?.tree);
		expect(git(dir, "rev-parse", `${parent}^{tree}`)).toBe(rows[0]?.tree);

		git(dir, "gc", "-q", "--prune=now");
		expect(git(dir, "cat-file", "-t", rows[0]?.tree ?? "")).toBe("tree");
		expect(git(dir, "cat-file", "-t", rows[1]?.tree ?? "")).toBe("tree");
	});

	it("an unchanged world produces the same tree sha (content-addressed dedup)", () => {
		const dir = makeFixture();
		snap(dir, 1, "pre");
		snap(dir, 2, "post");
		const rows = loadSnapshotIndex(dir);
		expect(rows[0]?.tree).toBe(rows[1]?.tree);
	});

	it("fails open on a non-git directory (logs, no throw, no row)", () => {
		const dir = mkdtempSync(join(tmpdir(), "il-g2-nogit-"));
		cleanups.push(dir);
		const logs: string[] = [];
		recordTreeSnapshot({
			cwd: dir,
			sessionId: "s",
			seq: 1,
			toolUseId: null,
			phase: "pre",
			log: (m) => logs.push(m),
		});
		expect(loadSnapshotIndex(dir)).toEqual([]);
		expect(logs.length).toBeGreaterThan(0);
	});
});

describe("phaseForHookEvent", () => {
	it("maps pre/post hook names and rejects lifecycle events", () => {
		expect(phaseForHookEvent("PreToolUse")).toBe("pre");
		expect(phaseForHookEvent("BeforeTool")).toBe("pre");
		expect(phaseForHookEvent("PostToolUse")).toBe("post");
		expect(phaseForHookEvent("PostToolUseFailure")).toBe("post");
		expect(phaseForHookEvent("SessionEnd")).toBeNull();
		expect(phaseForHookEvent(undefined)).toBeNull();
	});
});

describe("maybeRecordReplaySnapshots — env gate", () => {
	it("is inert without INTERLINKED_REPLAY_TREE_SNAPSHOTS=1", () => {
		const dir = makeFixture();
		const prev = process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS;
		delete process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS;
		try {
			maybeRecordReplaySnapshots({
				cwd: dir,
				sessionId: "sess-gate",
				seq: 1,
				toolUseId: "toolu_g",
				phase: "pre",
				liveSnapshot: { n: 1 },
				log: () => undefined,
			});
			expect(loadSnapshotIndex(dir)).toEqual([]);
		} finally {
			if (prev !== undefined) process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS = prev;
		}
	});

	it("records BOTH the tree row and the state pointer when enabled", () => {
		const dir = makeFixture();
		const prev = process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS;
		process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS = "1";
		try {
			maybeRecordReplaySnapshots({
				cwd: dir,
				sessionId: "sess-gate",
				seq: 5,
				toolUseId: "toolu_g",
				phase: "post",
				liveSnapshot: { tool_call_count: 5 },
				log: () => undefined,
			});
			expect(loadSnapshotIndex(dir)).toHaveLength(1);
			expect(loadStateSnapshot(dir, "sess-gate", 5)?.live_snapshot).toEqual({
				tool_call_count: 5,
			});
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS;
			else process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS = prev;
		}
	});
});

describe("loadSnapshotIndex", () => {
	it("skips a torn line and keeps the rows written on either side of it", () => {
		const dir = makeFixture();
		snap(dir, 1, "pre");
		// A crash mid-append leaves a prefix of one JSON object. The reader's
		// contract is to drop that line, not to lose the whole index.
		appendFileSync(snapshotIndexPath(dir), '{"schema":"tree-snapshot.v1","seq":\n');
		writeFileSync(join(dir, "a.txt"), "a\nmodified again\n");
		snap(dir, 2, "post");
		const rows = loadSnapshotIndex(dir);
		expect(rows.map((r) => r.seq)).toEqual([1, 2]);
		expect(rows.map((r) => r.phase)).toEqual(["pre", "post"]);
	});
});

describe("restoreTree", () => {
	it("reproduces the captured files byte-identically", () => {
		const dir = makeFixture();
		snap(dir, 1, "pre");
		const tree = loadSnapshotIndex(dir)[0]?.tree ?? "";
		const dest = mkdtempSync(join(tmpdir(), "il-g2-restore-"));
		cleanups.push(dest);
		restoreTree(dir, tree, dest);
		expect(readFileSync(join(dest, "a.txt"), "utf-8")).toBe("a\nmodified\n");
		expect(readFileSync(join(dest, "untracked.txt"), "utf-8")).toBe("new\n");
	});
});

describe("parseTreeSnapshotRecord", () => {
	const valid = {
		schema: "tree-snapshot.v1",
		session_id: "sess-g2",
		seq: 7,
		tool_use_id: "toolu_7",
		phase: "post",
		backend: "git",
		tree: "a".repeat(40),
		commit: "b".repeat(40),
		ts: "2026-08-10T00:00:00Z",
	};

	it("P1: accepts a well-formed row", () => {
		expect(parseTreeSnapshotRecord(valid)).toEqual(valid);
	});

	it("P2: accepts null seq and null tool_use_id (degraded capture)", () => {
		const row = { ...valid, seq: null, tool_use_id: null };
		expect(parseTreeSnapshotRecord(row)).toEqual(row);
	});

	it("N1: rejects the wrong schema tag", () => {
		expect(parseTreeSnapshotRecord({ ...valid, schema: "other.v1" })).toBeNull();
	});

	it("N2: rejects a backend other than git", () => {
		expect(parseTreeSnapshotRecord({ ...valid, backend: "hg" })).toBeNull();
	});

	it("N3: rejects a phase outside pre/post", () => {
		expect(parseTreeSnapshotRecord({ ...valid, phase: "during" })).toBeNull();
	});

	it("N4: rejects a non-string tree", () => {
		expect(parseTreeSnapshotRecord({ ...valid, tree: 12345 })).toBeNull();
	});

	it("N5: rejects a non-object line (array)", () => {
		expect(parseTreeSnapshotRecord(["tree-snapshot.v1"])).toBeNull();
	});
});
