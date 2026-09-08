import { isJsonObject, type JsonObject } from "../json-types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../checkpoints.js";

// Mock dependencies
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({
	randomBytes: vi.fn(() => Buffer.from("abcdef123456", "hex")),
}));

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
	rewindToCheckpoint,
	shouldAutoCheckpoint,
} from "../checkpoints.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExecSync = vi.mocked(execSync);

function writtenCheckpoints(): JsonObject[] {
	const written = mockWriteFileSync.mock.calls.at(-1)?.[1];
	if (typeof written !== "string") throw new Error("Expected a checkpoint JSON write");
	const value: unknown = JSON.parse(written);
	if (!Array.isArray(value) || !value.every(isJsonObject)) throw new Error("Expected checkpoint objects");
	return value;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// Build a Checkpoint with sensible defaults; override only what a test cares about.
function mkCheckpoint(over: Partial<Checkpoint> & { id: string }): Checkpoint {
	return {
		session_id: "s",
		agent: "agent-x",
		message: "msg",
		timestamp: "2025-01-01T00:00:00Z",
		base_commit: "base000",
		trigger: "manual",
		files_changed: [],
		restorable: true,
		...over,
	};
}

// Only the checkpoints.json file exists on disk for these tests (config.local.json absent
// so getDataDir() falls back to the default .interlinked dir).
function onlyCheckpointsFileExists(): void {
	mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
		String(path).includes("checkpoints.json"),
	);
}

// Route git invocations by matching the command substring, with a default fallthrough.
// `execSync` is called as `execSync("git <args>", opts)` inside the module.
function routeGit(routes: Array<[string, string]>, fallthrough = ""): void {
	mockExecSync.mockImplementation((cmd: string) => {
		for (const [needle, out] of routes) {
			if (cmd.includes(needle)) return out;
		}
		return fallthrough;
	});
}

describe("createCheckpoint", () => {
	it("creates a checkpoint with stash", () => {
		// Mock git commands
		mockExecSync
			.mockReturnValueOnce("ok") // rev-parse --git-dir
			.mockReturnValueOnce("abc123\n") // rev-parse HEAD
			.mockReturnValueOnce("src/index.ts\nsrc/lib/config.ts\n") // diff --name-only
			.mockReturnValueOnce("") // ls-files --others
			.mockReturnValueOnce("") // stash push
			.mockReturnValueOnce("deadbeef\n") // stash list -1
			.mockReturnValueOnce(""); // stash pop

		// Mock checkpoints file
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			if (String(path).includes("checkpoints.json")) return false;
			if (String(path).includes("config.local.json")) return false;
			return true;
		});

		const cp = createCheckpoint({
			sessionId: "session-1",
			agent: "test-agent",
			message: "Test checkpoint",
			trigger: "manual",
			cwd: "/test/repo",
		});

		expect(cp.id).toHaveLength(12);
		expect(cp.session_id).toBe("session-1");
		expect(cp.agent).toBe("test-agent");
		expect(cp.message).toBe("Test checkpoint");
		expect(cp.trigger).toBe("manual");
		expect(cp.base_commit).toBe("abc123");
		expect(cp.files_changed).toEqual(["src/index.ts", "src/lib/config.ts"]);
		expect(cp.restorable).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("throws when not in a git repo", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		mockExistsSync.mockReturnValue(false);

		expect(() =>
			createCheckpoint({
				sessionId: "s1",
				agent: "a1",
				message: "test",
				trigger: "manual",
				cwd: "/not/a/repo",
			}),
		).toThrow("Not a git repository");
	});
});

describe("listCheckpoints", () => {
	const sampleCheckpoints: Checkpoint[] = [
		{
			id: "aaa111",
			session_id: "s1",
			agent: "agent-1",
			message: "First",
			timestamp: "2025-01-01T00:00:00Z",
			base_commit: "abc",
			trigger: "manual",
			files_changed: ["a.ts"],
			restorable: true,
		},
		{
			id: "bbb222",
			session_id: "s2",
			agent: "agent-2",
			message: "Second",
			timestamp: "2025-01-02T00:00:00Z",
			base_commit: "def",
			trigger: "session_end",
			files_changed: ["b.ts"],
			restorable: true,
		},
		{
			id: "ccc333",
			session_id: "s1",
			agent: "agent-1",
			message: "Third",
			timestamp: "2025-01-03T00:00:00Z",
			base_commit: "ghi",
			trigger: "task_complete",
			files_changed: ["c.ts"],
			restorable: false,
		},
	];

	beforeEach(() => {
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).includes("checkpoints.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(sampleCheckpoints));
	});

	it("returns all checkpoints sorted newest first", () => {
		const result = listCheckpoints({ cwd: "/test" });
		expect(result).toHaveLength(3);
		expect(result[0].id).toBe("ccc333");
		expect(result[2].id).toBe("aaa111");
	});

	it("filters by agent", () => {
		const result = listCheckpoints({ agent: "agent-1", cwd: "/test" });
		expect(result).toHaveLength(2);
		expect(result.every((c) => c.agent === "agent-1")).toBe(true);
	});

	it("filters by session", () => {
		const result = listCheckpoints({ session: "s1", cwd: "/test" });
		expect(result).toHaveLength(2);
	});

	it("applies limit", () => {
		const result = listCheckpoints({ limit: 1, cwd: "/test" });
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("ccc333"); // newest
	});
});

describe("getCheckpoint", () => {
	it("returns checkpoint by id", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify([
				{
					id: "abc123",
					message: "Found",
					session_id: "s1",
					agent: "a",
					timestamp: "",
					base_commit: "",
					trigger: "manual",
					files_changed: [],
					restorable: true,
				},
			]),
		);
		const cp = getCheckpoint("abc123", "/test");
		expect(cp?.message).toBe("Found");
	});

	it("returns null for unknown id", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify([]));
		expect(getCheckpoint("unknown", "/test")).toBeNull();
	});
});

describe("pruneCheckpoints", () => {
	it("prunes by keep_latest", () => {
		const three: Checkpoint[] = [
			{
				id: "a",
				session_id: "s",
				agent: "a",
				message: "1",
				timestamp: "2025-01-01T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
			{
				id: "b",
				session_id: "s",
				agent: "a",
				message: "2",
				timestamp: "2025-01-02T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
			{
				id: "c",
				session_id: "s",
				agent: "a",
				message: "3",
				timestamp: "2025-01-03T00:00:00Z",
				base_commit: "x",
				trigger: "manual",
				files_changed: [],
				restorable: true,
			},
		];

		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			return String(path).includes("checkpoints.json");
		});
		mockReadFileSync.mockReturnValue(JSON.stringify(three));

		const removed = pruneCheckpoints({ keep_latest: 2, cwd: "/test" });
		expect(removed).toBe(1);
	});
});

describe("archiveCheckpoints", () => {
	it("archives old restorable checkpoints", () => {
		// Pin "now" so the test is deterministic across clock changes.
		const fixedNow = new Date("2030-06-15T12:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);

		try {
			const old: Checkpoint[] = [
				{
					id: "a",
					session_id: "s",
					agent: "a",
					message: "old",
					timestamp: "2020-01-01T00:00:00Z",
					base_commit: "x",
					trigger: "manual",
					files_changed: [],
					restorable: true,
					stash_ref: "abc",
				},
				{
					id: "b",
					session_id: "s",
					agent: "a",
					message: "new",
					timestamp: fixedNow.toISOString(),
					base_commit: "x",
					trigger: "manual",
					files_changed: [],
					restorable: true,
					stash_ref: "def",
				},
			];

			mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
				return String(path).includes("checkpoints.json");
			});
			mockReadFileSync.mockReturnValue(JSON.stringify(old));

			const result = archiveCheckpoints({ cwd: "/test" });
			expect(result.archived).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("shouldAutoCheckpoint", () => {
	it("returns true for session_end by default", () => {
		expect(shouldAutoCheckpoint("session_end")).toBe(true);
	});

	it("returns true for task_completed by default", () => {
		expect(shouldAutoCheckpoint("task_completed")).toBe(true);
	});

	it("returns false for tool_use", () => {
		expect(shouldAutoCheckpoint("tool_use")).toBe(false);
	});

	it("respects custom config", () => {
		expect(
			shouldAutoCheckpoint("session_start", { auto_checkpoint_on: ["session_start"] }),
		).toBe(true);
		expect(shouldAutoCheckpoint("session_end", { auto_checkpoint_on: ["session_start"] })).toBe(
			false,
		);
	});
});

describe("compareCheckpoints", () => {
	it("computes file diffs between two checkpoints", () => {
		const cps: Checkpoint[] = [
			{
				id: "from1",
				session_id: "s",
				agent: "a",
				message: "from",
				timestamp: "2025-01-01T00:00:00Z",
				base_commit: "aaa",
				trigger: "manual",
				files_changed: ["a.ts", "b.ts"],
				restorable: true,
			},
			{
				id: "to1",
				session_id: "s",
				agent: "a",
				message: "to",
				timestamp: "2025-01-02T00:00:00Z",
				base_commit: "bbb",
				trigger: "manual",
				files_changed: ["b.ts", "c.ts"],
				restorable: true,
			},
		];

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));
		mockExecSync.mockReturnValue("2 files changed\n");

		const result = compareCheckpoints("from1", "to1", "/test");
		expect(result.files_added).toEqual(["c.ts"]);
		expect(result.files_deleted).toEqual(["a.ts"]);
		expect(result.files_modified).toEqual(["b.ts"]);
	});

	it("falls back to computed counts when git diff fails", () => {
		const cps = [
			mkCheckpoint({ id: "f", base_commit: "aaa", files_changed: ["a.ts", "b.ts"] }),
			mkCheckpoint({ id: "t", base_commit: "bbb", files_changed: ["b.ts", "c.ts"] }),
		];
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));
		mockExecSync.mockImplementation(() => {
			throw new Error("git diff exploded");
		});

		const result = compareCheckpoints("f", "t", "/test");
		// 1 added (c.ts), 1 modified (b.ts), 1 deleted (a.ts)
		expect(result.diff_summary).toBe("1 added, 1 modified, 1 deleted");
		expect(result.files_added).toEqual(["c.ts"]);
		expect(result.files_modified).toEqual(["b.ts"]);
		expect(result.files_deleted).toEqual(["a.ts"]);
	});

	it("throws when the from checkpoint is missing", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify([mkCheckpoint({ id: "t" })]));
		expect(() => compareCheckpoints("missing-from", "t", "/test")).toThrow(
			"Checkpoint not found: missing-from",
		);
	});

	it("throws when the to checkpoint is missing", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify([mkCheckpoint({ id: "f" })]));
		expect(() => compareCheckpoints("f", "missing-to", "/test")).toThrow(
			"Checkpoint not found: missing-to",
		);
	});
});

describe("readCheckpointsFile (via getCheckpoint)", () => {
	it("treats corrupt JSON as an empty list", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue("{ this is not valid json ]");
		expect(getCheckpoint("anything", "/test")).toBeNull();
	});

	it("returns empty list when the checkpoints file is absent", () => {
		mockExistsSync.mockReturnValue(false);
		expect(getCheckpoint("anything", "/test")).toBeNull();
		// readFileSync must not be reached when the file does not exist.
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});
});

describe("createCheckpoint (edge cases)", () => {
	it("records a metadata-only checkpoint when stash fails (no changes to stash)", () => {
		// rev-parse --git-dir ok, rev-parse HEAD ok, diff/ls-files ok, but stash push throws.
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("rev-parse HEAD")) return "headcommit\n";
			if (cmd.includes("diff --name-only")) return "";
			if (cmd.includes("ls-files")) return "";
			if (cmd.includes("stash")) throw new Error("No local changes to save");
			return "";
		});
		onlyCheckpointsFileExists();
		// No prior checkpoints file content -> file does not exist branch on read.
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			// directory exists check during write -> true; checkpoints.json read -> false
			if (String(path).includes("checkpoints.json")) return false;
			return true;
		});

		const cp = createCheckpoint({
			sessionId: "sx",
			agent: "vendor-model-v6",
			message: "nothing staged",
			trigger: "session_end",
			cwd: "/test/repo",
		});

		expect(cp.restorable).toBe(false);
		expect(cp.stash_ref).toBeUndefined();
		expect(cp.files_changed).toEqual([]);
		expect(cp.agent).toBe("vendor-model-v6");
		expect(mockWriteFileSync).toHaveBeenCalled();
	});

	it("captures untracked files and persists supplied metadata", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("rev-parse HEAD")) return "abc999\n";
			if (cmd.includes("diff --name-only")) return "tracked.ts\n";
			if (cmd.includes("ls-files")) return "new-untracked.ts\n";
			if (cmd.includes("stash push")) return "";
			if (cmd.includes("stash list")) return "feedbeef\n";
			if (cmd.includes("stash pop")) return "";
			return "";
		});
		// checkpoints.json read returns existing content; dir exists for write.
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			if (String(path).includes("checkpoints.json")) return true;
			return true;
		});
		mockReadFileSync.mockReturnValue(JSON.stringify([mkCheckpoint({ id: "prior" })]));

		const cp = createCheckpoint({
			sessionId: "sy",
			agent: "agent-y",
			message: "with meta",
			trigger: "task_complete",
			cwd: "/test/repo",
			metadata: { task: "ABC-1", count: 3 },
		});

		expect(cp.files_changed).toEqual(["tracked.ts", "new-untracked.ts"]);
		expect(cp.restorable).toBe(true);
		expect(cp.stash_ref).toBe("feedbeef");
		expect(cp.metadata).toEqual({ task: "ABC-1", count: 3 });

		// Newly written array appends to the prior checkpoint (read-modify-write).
		const parsed = writtenCheckpoints();
		expect(parsed).toHaveLength(2);
		expect(parsed[0].id).toBe("prior");
		expect(parsed[1].id).toBe(cp.id);
	});

	it("leaves files_changed empty when the diff command throws (empty repo)", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("rev-parse HEAD")) return "root0\n";
			if (cmd.includes("diff --name-only")) throw new Error("no HEAD yet");
			if (cmd.includes("stash")) throw new Error("nothing to stash");
			return "";
		});
		mockExistsSync.mockImplementation((path: string | Buffer | URL) => {
			if (String(path).includes("checkpoints.json")) return false;
			return true;
		});

		const cp = createCheckpoint({
			sessionId: "sz",
			agent: "agent-z",
			message: "empty repo",
			trigger: "session_start",
			cwd: "/test/repo",
		});

		expect(cp.files_changed).toEqual([]);
		expect(cp.restorable).toBe(false);
	});
});

describe("listCheckpoints (since filter)", () => {
	it("filters out checkpoints older than the since timestamp", () => {
		const cps = [
			mkCheckpoint({ id: "old", timestamp: "2025-01-01T00:00:00Z" }),
			mkCheckpoint({ id: "mid", timestamp: "2025-06-01T00:00:00Z" }),
			mkCheckpoint({ id: "new", timestamp: "2025-12-01T00:00:00Z" }),
		];
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));

		const since = new Date("2025-06-01T00:00:00Z").getTime();
		const result = listCheckpoints({ since, cwd: "/test" });
		const ids = result.map((c) => c.id);
		// "old" excluded; "mid" (== boundary, >=) and "new" retained, newest first.
		expect(ids).toEqual(["new", "mid"]);
	});

	it("ignores a non-positive limit and returns all", () => {
		const cps = [mkCheckpoint({ id: "one" }), mkCheckpoint({ id: "two" })];
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));

		const result = listCheckpoints({ limit: 0, cwd: "/test" });
		expect(result).toHaveLength(2);
	});
});

describe("pruneCheckpoints (older_than_days)", () => {
	it("removes checkpoints older than the day cutoff", () => {
		const fixedNow = new Date("2030-06-15T12:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
		try {
			const cps = [
				mkCheckpoint({ id: "ancient", timestamp: "2020-01-01T00:00:00Z" }),
				mkCheckpoint({ id: "recent", timestamp: fixedNow.toISOString() }),
			];
			onlyCheckpointsFileExists();
			mockReadFileSync.mockReturnValue(JSON.stringify(cps));

			const removed = pruneCheckpoints({ older_than_days: 7, cwd: "/test" });
			expect(removed).toBe(1);

			const survivors = writtenCheckpoints();
			expect(survivors.map((c) => c.id)).toEqual(["recent"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns 0 and keeps everything with no prune options", () => {
		const cps = [mkCheckpoint({ id: "a" }), mkCheckpoint({ id: "b" })];
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify(cps));

		const removed = pruneCheckpoints({ cwd: "/test" });
		expect(removed).toBe(0);
		expect(writtenCheckpoints()).toHaveLength(2);
	});
});

describe("archiveCheckpoints (limit + no-op paths)", () => {
	it("archives stashes beyond max_stash_count even when recent", () => {
		const fixedNow = new Date("2030-06-15T12:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
		try {
			// Three recent, restorable checkpoints; max_stash_count=1 forces 2 archived.
			const cps = [
				mkCheckpoint({
					id: "r1",
					timestamp: "2030-06-15T11:00:00Z",
					stash_ref: "s1",
				}),
				mkCheckpoint({
					id: "r2",
					timestamp: "2030-06-15T10:00:00Z",
					stash_ref: "s2",
				}),
				mkCheckpoint({
					id: "r3",
					timestamp: "2030-06-15T09:00:00Z",
					stash_ref: "s3",
				}),
			];
			onlyCheckpointsFileExists();
			mockReadFileSync.mockReturnValue(JSON.stringify(cps));

			const result = archiveCheckpoints({
				older_than_days: 3650, // far in the past so age never triggers
				max_stash_count: 1,
				cwd: "/test",
			});
			expect(result.archived).toBe(2);

			const parsed = writtenCheckpoints();
			const stillRestorable = parsed.filter((c) => c.restorable);
			// The loop walks newest-first and archives while count > max, decrementing
			// each time; so the newest two (r1, r2) get archived and the oldest of the
			// three recent ones (r3) is the single survivor.
			expect(stillRestorable).toHaveLength(1);
			expect(stillRestorable[0].id).toBe("r3");
			const archivedOnes = parsed.filter((c) => !c.restorable);
			expect(archivedOnes.map((c) => c.id).sort()).toEqual(["r1", "r2"]);
			expect(archivedOnes.every((c) => c.stash_ref === undefined)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not write when nothing needs archiving", () => {
		const fixedNow = new Date("2030-06-15T12:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(fixedNow);
		try {
			const cps = [
				mkCheckpoint({ id: "fresh", timestamp: fixedNow.toISOString(), stash_ref: "s" }),
				// already-archived entry: restorable false, skipped by the continue branch.
				mkCheckpoint({
					id: "done",
					timestamp: "2020-01-01T00:00:00Z",
					restorable: false,
					stash_ref: undefined,
				}),
			];
			onlyCheckpointsFileExists();
			mockReadFileSync.mockReturnValue(JSON.stringify(cps));

			const result = archiveCheckpoints({ cwd: "/test" });
			expect(result.archived).toBe(0);
			expect(mockWriteFileSync).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("rewindToCheckpoint", () => {
	it("throws when the checkpoint id is unknown", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify([]));
		expect(() => rewindToCheckpoint("nope", { cwd: "/test" })).toThrow(
			"Checkpoint not found: nope",
		);
	});

	it("throws when the checkpoint is not restorable", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "arch", restorable: false })]),
		);
		expect(() => rewindToCheckpoint("arch", { cwd: "/test" })).toThrow("is not restorable");
	});

	it("throws when not inside a git repository", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify([mkCheckpoint({ id: "cp" })]));
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) throw new Error("not a repo");
			return "";
		});
		expect(() => rewindToCheckpoint("cp", { cwd: "/test" })).toThrow("Not a git repository.");
	});

	it("refuses to rewind over a dirty tree without --force", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(JSON.stringify([mkCheckpoint({ id: "cp" })]));
		routeGit([
			["rev-parse --git-dir", "ok"],
			["status --porcelain", " M dirty.ts\n"],
		]);
		expect(() => rewindToCheckpoint("cp", { cwd: "/test" })).toThrow(
			"Working tree has uncommitted changes",
		);
	});

	it("force-discards a dirty tree and applies the matching stash", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([
				mkCheckpoint({
					id: "cp1",
					base_commit: "targetbase",
					files_changed: ["x.ts", "y.ts"],
				}),
			]),
		);
		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return " M dirty.ts\n";
			if (cmd.includes("rev-parse HEAD")) return "differenthead\n";
			if (cmd.includes("stash list")) {
				return "stash@{0}:WIP\nstash@{1}:interlinked:checkpoint:cp1:{...}\n";
			}
			return "";
		});

		const result = rewindToCheckpoint("cp1", { cwd: "/test", force: true });
		expect(result.success).toBe(true);
		expect(result.warning).toBeUndefined();
		expect(result.files_restored).toEqual(["x.ts", "y.ts"]);
		// Force path must discard local changes.
		expect(calls.some((c) => c.includes("checkout -- ."))).toBe(true);
		expect(calls.some((c) => c.includes("clean -fd"))).toBe(true);
		// HEAD differed from base -> checkout of the base commit.
		expect(calls.some((c) => c.includes("checkout targetbase"))).toBe(true);
		// The matching stash (stash@{1}) is applied, not the unrelated WIP one.
		expect(calls.some((c) => c.includes("stash apply stash@{1}"))).toBe(true);
	});

	it("applies a stash on a clean tree without touching checkout/clean", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "cp2", base_commit: "samehead", files_changed: ["z.ts"] })]),
		);
		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return ""; // clean
			if (cmd.includes("rev-parse HEAD")) return "samehead\n"; // matches base_commit
			if (cmd.includes("stash list")) return "stash@{0}:interlinked:checkpoint:cp2:{}\n";
			return "";
		});

		const result = rewindToCheckpoint("cp2", { cwd: "/test" });
		expect(result.success).toBe(true);
		expect(result.warning).toBeUndefined();
		// Clean tree -> no discard, and HEAD already matches base -> no checkout of base.
		expect(calls.some((c) => c.includes("checkout -- ."))).toBe(false);
		expect(calls.some((c) => c.includes("clean -fd"))).toBe(false);
		expect(calls.some((c) => c.includes("checkout samehead"))).toBe(false);
		expect(calls.some((c) => c.includes("stash apply"))).toBe(true);
	});

	it("warns when no matching stash is found", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "lost", base_commit: "h0", files_changed: ["a.ts"] })]),
		);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return "";
			if (cmd.includes("rev-parse HEAD")) return "h0\n";
			// stash list returns only unrelated entries -> no match.
			if (cmd.includes("stash list")) return "stash@{0}:some other work\n";
			return "";
		});

		const result = rewindToCheckpoint("lost", { cwd: "/test" });
		expect(result.success).toBe(true);
		expect(result.warning).toContain("Stash not found");
		expect(result.files_restored).toEqual(["a.ts"]);
	});

	it("continues to stash apply when the base-commit checkout fails", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "cp3", base_commit: "gonecommit", files_changed: [] })]),
		);
		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return "";
			if (cmd.includes("rev-parse HEAD")) return "otherhead\n";
			if (cmd.includes("checkout gonecommit")) throw new Error("unknown revision");
			if (cmd.includes("stash list")) return "stash@{0}:interlinked:checkpoint:cp3:{}\n";
			return "";
		});

		const result = rewindToCheckpoint("cp3", { cwd: "/test" });
		// Checkout threw but the function swallows it and still applies the stash.
		expect(result.success).toBe(true);
		expect(result.warning).toBeUndefined();
		expect(calls.some((c) => c.includes("stash apply stash@{0}"))).toBe(true);
	});

	it("treats a failed status check as a clean tree", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "cp4", base_commit: "hh", files_changed: [] })]),
		);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) throw new Error("status blew up");
			if (cmd.includes("rev-parse HEAD")) return "hh\n";
			if (cmd.includes("stash list")) return "stash@{0}:interlinked:checkpoint:cp4:{}\n";
			return "";
		});

		// status throwing -> hasChanges stays false -> no dirty-tree error even without force.
		const result = rewindToCheckpoint("cp4", { cwd: "/test" });
		expect(result.success).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	it("warns when the stash list command itself fails", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "cp5", base_commit: "kk", files_changed: ["q.ts"] })]),
		);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return "";
			if (cmd.includes("rev-parse HEAD")) return "kk\n";
			if (cmd.includes("stash list")) throw new Error("stash list failed");
			return "";
		});

		const result = rewindToCheckpoint("cp5", { cwd: "/test" });
		expect(result.success).toBe(true);
		expect(result.warning).toContain("Stash not found");
	});
});

// These exercise the `opts.cwd || process.cwd()` default-cwd fallthrough on every
// exported function (the right-hand side of each `|| process.cwd()`). fs and
// child_process are fully mocked, so process.cwd() never touches the real disk.
describe("default cwd fallthrough (no cwd argument)", () => {
	it("createCheckpoint defaults cwd to process.cwd()", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("rev-parse HEAD")) return "defhead\n";
			if (cmd.includes("diff --name-only")) return "";
			if (cmd.includes("ls-files")) return "";
			if (cmd.includes("stash")) throw new Error("nothing to stash");
			return "";
		});
		// No checkpoints.json yet (read returns empty); dir exists for the write.
		mockExistsSync.mockImplementation((path: string | Buffer | URL) =>
			String(path).includes("checkpoints.json") ? false : true,
		);

		const cp = createCheckpoint({
			sessionId: "def-s",
			agent: "agent-def",
			message: "default cwd",
			trigger: "manual",
		});
		expect(cp.base_commit).toBe("defhead");
		expect(cp.restorable).toBe(false);
	});

	it("listCheckpoints, getCheckpoint, pruneCheckpoints, archiveCheckpoints default cwd", () => {
		// File absent -> readCheckpointsFile returns [] without reading.
		mockExistsSync.mockReturnValue(false);

		expect(listCheckpoints()).toEqual([]);
		expect(getCheckpoint("x")).toBeNull();
		expect(pruneCheckpoints()).toBe(0);
		expect(archiveCheckpoints()).toEqual({ archived: 0 });
	});

	it("compareCheckpoints defaults cwd to process.cwd()", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([
				mkCheckpoint({ id: "df", base_commit: "a", files_changed: ["a.ts"] }),
				mkCheckpoint({ id: "dt", base_commit: "b", files_changed: ["b.ts"] }),
			]),
		);
		mockExecSync.mockReturnValue("1 file changed\n");

		const result = compareCheckpoints("df", "dt");
		expect(result.files_added).toEqual(["b.ts"]);
		expect(result.files_deleted).toEqual(["a.ts"]);
		expect(result.diff_summary).toBe("1 file changed");
	});

	it("rewindToCheckpoint defaults cwd to process.cwd()", () => {
		onlyCheckpointsFileExists();
		mockReadFileSync.mockReturnValue(
			JSON.stringify([mkCheckpoint({ id: "dr", base_commit: "dh", files_changed: ["r.ts"] })]),
		);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse --git-dir")) return "ok";
			if (cmd.includes("status --porcelain")) return "";
			if (cmd.includes("rev-parse HEAD")) return "dh\n";
			if (cmd.includes("stash list")) return "stash@{0}:interlinked:checkpoint:dr:{}\n";
			return "";
		});

		const result = rewindToCheckpoint("dr");
		expect(result.success).toBe(true);
		expect(result.warning).toBeUndefined();
		expect(result.files_restored).toEqual(["r.ts"]);
	});
});
