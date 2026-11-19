// ===========================================
// checkpoint command — behavioral coverage
// ===========================================
// Mocks the data layer (../lib/checkpoints.js for git/fs, ../lib/local-activity.js
// for session lookup) and exercises the real output.js + formatter.js so we can
// assert on actual rendered strings, side-effects (process.exitCode), and every
// branch of each command handler.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../lib/checkpoints.js";
import type { SessionState } from "../lib/local-activity.js";

// ---- module boundary mocks (the only thing that touches git / fs) ----
vi.mock("../lib/checkpoints.js", () => ({
	archiveCheckpoints: vi.fn(),
	compareCheckpoints: vi.fn(),
	createCheckpoint: vi.fn(),
	getCheckpoint: vi.fn(),
	listCheckpoints: vi.fn(),
	pruneCheckpoints: vi.fn(),
}));

vi.mock("../lib/local-activity.js", () => ({
	readLocalSessions: vi.fn(),
}));

import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
} from "../lib/checkpoints.js";
import { readLocalSessions } from "../lib/local-activity.js";
import {
	checkpointArchiveCommand,
	checkpointCommand,
	checkpointCompareCommand,
	checkpointListCommand,
	checkpointPruneCommand,
	checkpointShowCommand,
} from "./checkpoint.js";

// Real formatter colors are TTY/NO_COLOR-dependent; strip ANSI so assertions
// are hermetic regardless of how the test runner is invoked.
const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
	return s.replace(ANSI, "");
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

// Concatenated, ANSI-stripped console.log / console.error output across all calls.
function joinCalls(calls: unknown[][]): string {
	return strip(calls.map((call) => String(call[0])).join("\n"));
}
function logged(): string {
	return joinCalls(logSpy.mock.calls);
}
function errored(): string {
	return joinCalls(errSpy.mock.calls);
}

const mocks = {
	archiveCheckpoints: vi.mocked(archiveCheckpoints),
	compareCheckpoints: vi.mocked(compareCheckpoints),
	createCheckpoint: vi.mocked(createCheckpoint),
	getCheckpoint: vi.mocked(getCheckpoint),
	listCheckpoints: vi.mocked(listCheckpoints),
	pruneCheckpoints: vi.mocked(pruneCheckpoints),
	readLocalSessions: vi.mocked(readLocalSessions),
};

function makeCheckpoint(over: Partial<Checkpoint> = {}): Checkpoint {
	return {
		id: "abc123def456",
		session_id: "sess-1",
		agent: "claude",
		message: "snapshot",
		timestamp: "2099-01-01T00:00:00.000Z", // future → relativeTime() = "just now" (deterministic)
		base_commit: "0123456789abcdef0123456789abcdef01234567",
		trigger: "manual",
		files_changed: ["src/a.ts", "src/b.ts"],
		restorable: true,
		...over,
	};
}

function makeSession(over: Partial<SessionState> = {}): SessionState {
	return {
		session_id: "active-sess",
		agent: "active-agent",
		phase: "ACTIVE",
		// Remaining required SessionState fields the command under test never reads.
		started_at: "2099-01-01T00:00:00.000Z",
		last_event_at: "2099-01-01T00:00:00.000Z",
		tool_count: 0,
		error_count: 0,
		files_touched: [],
		tools_used: {},
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

// ===========================================
// checkpointCommand (top-level dispatcher)
// ===========================================
describe("checkpointCommand", () => {
	it("creates a manual checkpoint with the default message when no arg is given", () => {
		mocks.readLocalSessions.mockReturnValue([]);
		const cp = makeCheckpoint({ message: "Manual checkpoint" });
		mocks.createCheckpoint.mockReturnValue(cp);

		checkpointCommand(undefined, {});

		expect(mocks.createCheckpoint).toHaveBeenCalledWith({
			sessionId: "manual",
			agent: "unknown",
			message: "Manual checkpoint",
			trigger: "manual",
		});
		expect(logged()).toContain("Checkpoint created: abc123def456");
		expect(logged()).toContain("Manual checkpoint");
		expect(process.exitCode).toBeUndefined();
	});

	it("creates a manual checkpoint when called with no opts at all", () => {
		// Exercises the `opts || {}` fallback in getOutputMode + the
		// `messageOrSubcmd || "Manual checkpoint"` default.
		mocks.readLocalSessions.mockReturnValue([]);
		mocks.createCheckpoint.mockReturnValue(makeCheckpoint());

		checkpointCommand();

		expect(mocks.createCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Manual checkpoint" }),
		);
	});

	it("treats a non-subcommand string as a checkpoint message", () => {
		mocks.readLocalSessions.mockReturnValue([]);
		mocks.createCheckpoint.mockReturnValue(makeCheckpoint({ message: "fix the bug" }));

		checkpointCommand("fix the bug", {});

		expect(mocks.createCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({ message: "fix the bug" }),
		);
	});

	it("reaches the Unknown-subcommand error when given a reserved subcommand word", () => {
		// "list" is in the reserved set → the createManualCheckpoint branch is
		// skipped and execution falls through to outputError on the final line.
		checkpointCommand("list", {});

		expect(mocks.createCheckpoint).not.toHaveBeenCalled();
		expect(errored()).toContain("Unknown subcommand: list");
		expect(process.exitCode).toBe(1);
	});

	it.each(["show", "compare", "prune", "archive"])(
		"falls through to Unknown-subcommand for reserved word %s",
		(word) => {
			checkpointCommand(word, {});
			expect(errored()).toContain(`Unknown subcommand: ${word}`);
		},
	);
});

// ===========================================
// createManualCheckpoint (via checkpointCommand)
// ===========================================
describe("createManualCheckpoint branches", () => {
	it("uses the active session id/agent and renders restorable=yes", () => {
		mocks.readLocalSessions.mockReturnValue([
			makeSession({ phase: "ENDED", session_id: "ended", agent: "x" }),
			makeSession({ session_id: "live-1", agent: "agent-live" }),
		]);
		mocks.createCheckpoint.mockReturnValue(
			makeCheckpoint({ agent: "agent-live", restorable: true }),
		);

		checkpointCommand("msg", {});

		expect(mocks.createCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "live-1", agent: "agent-live" }),
		);
		const out = logged();
		expect(out).toContain("Base commit    01234567"); // kvLine pad(14) + space, sliced to 8 chars
		expect(out).not.toContain("0123456789"); // confirms the 8-char slice, not the full hash
		expect(out).toContain("Files");
		expect(out).toContain("Restorable");
		expect(out).toContain("yes");
	});

	it("prefers the explicit --agent option over the active session agent", () => {
		mocks.readLocalSessions.mockReturnValue([makeSession({ agent: "session-agent" })]);
		mocks.createCheckpoint.mockReturnValue(makeCheckpoint());

		checkpointCommand("msg", { agent: "cli-agent" });

		expect(mocks.createCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({ agent: "cli-agent" }),
		);
	});

	it("falls back to agent 'unknown' when the active session has no agent", () => {
		// active?.agent is empty → final `|| "unknown"` branch.
		mocks.readLocalSessions.mockReturnValue([makeSession({ agent: "" })]);
		mocks.createCheckpoint.mockReturnValue(makeCheckpoint());

		checkpointCommand("msg", {});

		expect(mocks.createCheckpoint).toHaveBeenCalledWith(
			expect.objectContaining({ agent: "unknown", sessionId: "active-sess" }),
		);
	});

	it("renders restorable=no when the checkpoint is not restorable", () => {
		mocks.readLocalSessions.mockReturnValue([]);
		mocks.createCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));

		checkpointCommand("msg", {});

		expect(logged()).toContain("no");
	});

	it("emits the raw checkpoint object in --json mode", () => {
		mocks.readLocalSessions.mockReturnValue([]);
		const cp = makeCheckpoint();
		mocks.createCheckpoint.mockReturnValue(cp);

		checkpointCommand("msg", { json: true });

		expect(JSON.parse(logged())).toMatchObject({ id: "abc123def456" });
	});

	it("reports an Error message via outputError on failure", () => {
		mocks.readLocalSessions.mockReturnValue([]);
		mocks.createCheckpoint.mockImplementation(() => {
			throw new Error("git stash failed");
		});

		checkpointCommand("msg", {});

		expect(errored()).toContain("Error: git stash failed");
		expect(process.exitCode).toBe(1);
	});

	it("coerces a non-Error throw to a string in the catch branch", () => {
		mocks.readLocalSessions.mockImplementation(() => {
			// thrown before createCheckpoint is reached, still inside the try
			throw "boom-string";
		});

		checkpointCommand("msg", {});

		expect(errored()).toContain("Error: boom-string");
	});
});

// ===========================================
// checkpointListCommand
// ===========================================
describe("checkpointListCommand", () => {
	it("renders an empty-state message when there are no checkpoints", () => {
		mocks.listCheckpoints.mockReturnValue([]);

		checkpointListCommand({});

		expect(mocks.listCheckpoints).toHaveBeenCalledWith({});
		expect(logged()).toContain("No checkpoints found");
	});

	it("renders a table row and truncates long messages", () => {
		const longMsg = "x".repeat(50);
		mocks.listCheckpoints.mockReturnValue([
			makeCheckpoint({ id: "cp-short", message: "short", restorable: true }),
			makeCheckpoint({ id: "cp-long", message: longMsg, restorable: false }),
		]);

		checkpointListCommand({});

		const out = logged();
		expect(out).toContain("cp-short");
		expect(out).toContain("cp-long");
		expect(out).toContain("short");
		// long message truncated to 30 chars + ellipsis
		expect(out).toContain(`${"x".repeat(30)}...`);
		expect(out).not.toContain("x".repeat(31));
		expect(out).toContain("just now"); // relativeTime on a future timestamp
	});

	it("passes agent, parsed since-duration, and limit through to listCheckpoints", () => {
		const NOW = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		mocks.listCheckpoints.mockReturnValue([]);

		checkpointListCommand({ agent: "claude", since: "2h", limit: "5" });

		expect(mocks.listCheckpoints).toHaveBeenCalledWith({
			agent: "claude",
			since: NOW - 2 * 3_600_000,
			limit: 5,
		});
	});

	it.each<[string, number]>([
		["10s", 10 * 1000],
		["3m", 3 * 60_000],
		["1d", 1 * 86_400_000],
	])("parses since-duration unit %s", (since, deltaMs) => {
		const NOW = 2_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		mocks.listCheckpoints.mockReturnValue([]);

		checkpointListCommand({ since });

		expect(mocks.listCheckpoints).toHaveBeenCalledWith(
			expect.objectContaining({ since: NOW - deltaMs }),
		);
	});

	it("falls back to a 1-day default for an unparseable since-duration", () => {
		const NOW = 3_000_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		mocks.listCheckpoints.mockReturnValue([]);

		checkpointListCommand({ since: "garbage" });

		expect(mocks.listCheckpoints).toHaveBeenCalledWith(
			expect.objectContaining({ since: NOW - 86_400_000 }),
		);
	});

	it("emits a { checkpoints } object in --json mode", () => {
		const cp = makeCheckpoint();
		mocks.listCheckpoints.mockReturnValue([cp]);

		checkpointListCommand({ json: true });

		expect(JSON.parse(logged())).toMatchObject({ checkpoints: [{ id: "abc123def456" }] });
	});

	it("reports listing failures via outputError", () => {
		mocks.listCheckpoints.mockImplementation(() => {
			throw new Error("read failed");
		});

		checkpointListCommand({});

		expect(errored()).toContain("Error: read failed");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// checkpointShowCommand
// ===========================================
describe("checkpointShowCommand", () => {
	it("reports not-found and returns early", () => {
		mocks.getCheckpoint.mockReturnValue(null);

		checkpointShowCommand("missing", {});

		expect(errored()).toContain("Checkpoint not found: missing");
		expect(process.exitCode).toBe(1);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("renders full detail with a bounded files-changed list", () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ files_changed: ["src/a.ts", "src/b.ts"], restorable: true }),
		);

		checkpointShowCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("Checkpoint abc123def456");
		expect(out).toContain("Message");
		expect(out).toContain("Session");
		expect(out).toContain("Trigger");
		expect(out).toContain("Base commit    0123456789abcdef0123456789abcdef01234567");
		expect(out).toContain("yes");
		expect(out).toContain("Files changed (2)");
		expect(out).toContain("src/a.ts");
		expect(out).toContain("src/b.ts");
		expect(out).not.toContain("more");
	});

	it("renders restorable=no and omits the files section when none changed", () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ files_changed: [], restorable: false }),
		);

		checkpointShowCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("no");
		expect(out).not.toContain("Files changed");
	});

	it("truncates the files list at 30 and reports the overflow count", () => {
		const files = Array.from({ length: 35 }, (_, i) => `src/file${i}.ts`);
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ files_changed: files }));

		checkpointShowCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("Files changed (35)");
		expect(out).toContain("src/file0.ts");
		expect(out).toContain("src/file29.ts");
		expect(out).not.toContain("src/file30.ts");
		expect(out).toContain("... and 5 more");
	});

	it("emits the raw checkpoint in --json mode", () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint());

		checkpointShowCommand("abc123def456", { json: true });

		expect(JSON.parse(logged())).toMatchObject({ id: "abc123def456" });
	});

	it("reports show failures via outputError", () => {
		mocks.getCheckpoint.mockImplementation(() => {
			throw new Error("show boom");
		});

		checkpointShowCommand("abc123def456", {});

		expect(errored()).toContain("Error: show boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// checkpointCompareCommand
// ===========================================
describe("checkpointCompareCommand", () => {
	it("renders the comparison with a diff summary", () => {
		mocks.compareCheckpoints.mockReturnValue({
			files_added: ["a"],
			files_modified: ["b", "c"],
			files_deleted: [],
			diff_summary: "3 files changed",
		});

		checkpointCompareCommand("id1", "id2", {});

		expect(mocks.compareCheckpoints).toHaveBeenCalledWith("id1", "id2");
		const out = logged();
		expect(out).toContain("Compare id1 → id2");
		expect(out).toContain("Added");
		expect(out).toContain("Modified");
		expect(out).toContain("Deleted");
		expect(out).toContain("3 files changed");
	});

	it("omits the diff-summary block when it is empty", () => {
		mocks.compareCheckpoints.mockReturnValue({
			files_added: [],
			files_modified: [],
			files_deleted: [],
			diff_summary: "",
		});

		checkpointCompareCommand("id1", "id2", {});

		// Only the header + three kvLines, no extra trailing summary text.
		const out = logged();
		expect(out).toContain("Compare id1 → id2");
		expect(out.trim().endsWith("Deleted        0")).toBe(true);
	});

	it("emits the raw compare result in --json mode", () => {
		mocks.compareCheckpoints.mockReturnValue({
			files_added: ["a"],
			files_modified: [],
			files_deleted: [],
			diff_summary: "x",
		});

		checkpointCompareCommand("id1", "id2", { json: true });

		expect(JSON.parse(logged())).toMatchObject({ files_added: ["a"] });
	});

	it("reports compare failures via outputError", () => {
		mocks.compareCheckpoints.mockImplementation(() => {
			throw new Error("no such checkpoint");
		});

		checkpointCompareCommand("id1", "id2", {});

		expect(errored()).toContain("Error: no such checkpoint");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// checkpointPruneCommand
// ===========================================
describe("checkpointPruneCommand", () => {
	it.each(["", "0", "-1", "1junk", "1.5", "Infinity", "9007199254740992"])("rejects invalid retention selection %j before mutation", (value) => {
		checkpointPruneCommand({ keepLatest: value, olderThan: "7" });
		expect(mocks.pruneCheckpoints).not.toHaveBeenCalled();
		expect(errored()).toContain("--keep-latest must be a positive safe integer");
		expect(process.exitCode).toBe(1);
	});

	it.each(["", "0", "-1", "1junk", "1.5", "Infinity", "9007199254740992"])("rejects invalid age selection %j before mutation", (value) => {
		checkpointPruneCommand({ olderThan: value, keepLatest: "10" });
		expect(mocks.pruneCheckpoints).not.toHaveBeenCalled();
		expect(errored()).toContain("--older-than must be a positive safe integer");
		expect(process.exitCode).toBe(1);
	});

	it("reports the number pruned when > 0", () => {
		mocks.pruneCheckpoints.mockReturnValue(3);

		checkpointPruneCommand({});

		expect(mocks.pruneCheckpoints).toHaveBeenCalledWith({});
		expect(logged()).toContain("Pruned 3 checkpoint(s)");
	});

	it("reports the nothing-to-prune message when 0", () => {
		mocks.pruneCheckpoints.mockReturnValue(0);

		checkpointPruneCommand({});

		expect(logged()).toContain("No checkpoints to prune");
	});

	it("forwards parsed older-than and keep-latest numbers", () => {
		mocks.pruneCheckpoints.mockReturnValue(1);

		checkpointPruneCommand({ olderThan: "7", keepLatest: "10" });

		expect(mocks.pruneCheckpoints).toHaveBeenCalledWith({
			older_than_days: 7,
			keep_latest: 10,
		});
	});

	it("emits a { removed } object in --json mode", () => {
		mocks.pruneCheckpoints.mockReturnValue(2);

		checkpointPruneCommand({ json: true });

		expect(JSON.parse(logged())).toEqual({ removed: 2 });
	});

	it("reports prune failures via outputError", () => {
		mocks.pruneCheckpoints.mockImplementation(() => {
			throw new Error("prune boom");
		});

		checkpointPruneCommand({});

		expect(errored()).toContain("Error: prune boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// checkpointArchiveCommand
// ===========================================
describe("checkpointArchiveCommand", () => {
	it("reports the number archived when > 0", () => {
		mocks.archiveCheckpoints.mockReturnValue({ archived: 4 });

		checkpointArchiveCommand({});

		expect(logged()).toContain("Archived 4 checkpoint(s)");
		expect(logged()).toContain("stashes dropped, metadata preserved");
	});

	it("reports the nothing-to-archive message when 0", () => {
		mocks.archiveCheckpoints.mockReturnValue({ archived: 0 });

		checkpointArchiveCommand({});

		expect(logged()).toContain("No checkpoints to archive");
	});

	it("emits the raw archive result in --json mode", () => {
		mocks.archiveCheckpoints.mockReturnValue({ archived: 4 });

		checkpointArchiveCommand({ json: true });

		expect(JSON.parse(logged())).toEqual({ archived: 4 });
	});

	it("reports archive failures via outputError", () => {
		mocks.archiveCheckpoints.mockImplementation(() => {
			throw new Error("archive boom");
		});

		checkpointArchiveCommand({});

		expect(errored()).toContain("Error: archive boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// Non-Error throws — covers the String(err) side of the
// `err instanceof Error ? err.message : String(err)` ternary in every
// remaining catch block (list / show / compare / prune / archive).
// ===========================================
describe("non-Error throws are stringified in catch blocks", () => {
	it("checkpointListCommand stringifies a non-Error throw", () => {
		mocks.listCheckpoints.mockImplementation(() => {
			throw "list-string-err";
		});

		checkpointListCommand({});

		expect(errored()).toContain("Error: list-string-err");
		expect(process.exitCode).toBe(1);
	});

	it("checkpointShowCommand stringifies a non-Error throw", () => {
		mocks.getCheckpoint.mockImplementation(() => {
			throw "show-string-err";
		});

		checkpointShowCommand("id", {});

		expect(errored()).toContain("Error: show-string-err");
	});

	it("checkpointCompareCommand stringifies a non-Error throw", () => {
		mocks.compareCheckpoints.mockImplementation(() => {
			throw "compare-string-err";
		});

		checkpointCompareCommand("id1", "id2", {});

		expect(errored()).toContain("Error: compare-string-err");
	});

	it("checkpointPruneCommand stringifies a non-Error throw", () => {
		mocks.pruneCheckpoints.mockImplementation(() => {
			throw "prune-string-err";
		});

		checkpointPruneCommand({});

		expect(errored()).toContain("Error: prune-string-err");
	});

	it("checkpointArchiveCommand stringifies a non-Error throw", () => {
		mocks.archiveCheckpoints.mockImplementation(() => {
			throw "archive-string-err";
		});

		checkpointArchiveCommand({});

		expect(errored()).toContain("Error: archive-string-err");
	});
});
