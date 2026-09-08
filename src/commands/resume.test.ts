// ===========================================
// resume command — behavioral coverage
// ===========================================
// Mocks the data layer (../lib/checkpoints.js for git/fs, ../lib/local-activity.js
// for session lookup) and the dynamically-imported ../lib/api-client.js for the
// optional server-context fetch. Exercises the real output.js + formatter.js so we
// can assert on actual rendered strings, side-effects (process.exitCode), and every
// branch of resumeCommand: output modes, empty vs populated session, rewind
// success/skip/throw/archived, server-context auth/result/timeout/import-failure,
// files-changed overflow, and both error/catch paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "../lib/checkpoints.js";
import type { SessionState } from "../lib/local-activity.js";

// ---- module boundary mocks (the only things that touch git / fs / network) ----
vi.mock("../lib/checkpoints.js", () => ({
	getCheckpoint: vi.fn(),
	listCheckpoints: vi.fn(),
	rewindToCheckpoint: vi.fn(),
}));

vi.mock("../lib/local-activity.js", () => ({
	readLocalSessions: vi.fn(),
}));

// resume.ts reaches the server via a *dynamic* `await import("../lib/api-client.js")`.
// Mocking the module is enough — the dynamic import resolves to the mock factory.
vi.mock("../lib/api-client.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/api-client.js")>(),
	getClient: vi.fn(),
}));

import { getClient, InterlinkedClient } from "../lib/api-client.js";
import { getCheckpoint, listCheckpoints, rewindToCheckpoint } from "../lib/checkpoints.js";
import { readLocalSessions } from "../lib/local-activity.js";
import { resumeCommand } from "./resume.js";

// Real formatter colors are TTY/NO_COLOR-dependent; strip ANSI so assertions
// are hermetic regardless of how the test runner is invoked.
const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
	return s.replace(ANSI, "");
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

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
	getCheckpoint: vi.mocked(getCheckpoint),
	listCheckpoints: vi.mocked(listCheckpoints),
	rewindToCheckpoint: vi.mocked(rewindToCheckpoint),
	readLocalSessions: vi.mocked(readLocalSessions),
	getClient: vi.mocked(getClient),
};

function makeCheckpoint(over: Partial<Checkpoint> = {}): Checkpoint {
	return {
		id: "abc123def456",
		session_id: "sess-1",
		agent: "claude",
		message: "snapshot",
		timestamp: "2099-01-01T00:00:00.000Z",
		base_commit: "0123456789abcdef0123456789abcdef01234567",
		trigger: "manual",
		files_changed: ["src/a.ts", "src/b.ts"],
		restorable: true,
		...over,
	};
}

function makeSession(over: Partial<SessionState> = {}): SessionState {
	return {
		session_id: "sess-1",
		agent: "claude",
		phase: "ACTIVE",
		started_at: "2099-01-01T00:00:00.000Z",
		last_event_at: "2099-01-01T00:00:00.000Z",
		tool_count: 7,
		error_count: 0,
		files_touched: ["src/a.ts", "src/b.ts"],
		tools_used: {},
		...over,
	};
}

/** A fake api-client whose auth + callTool behavior is configurable per test. */
function fakeClient(opts: {
	authenticated?: boolean;
	callTool?: () => Promise<unknown>;
}): InterlinkedClient {
	const client = new InterlinkedClient({ serverUrl: "https://api.example", token: "test-token" });
	vi.spyOn(client, "isAuthenticated").mockReturnValue(opts.authenticated ?? false);
	vi.spyOn(client, "callTool").mockImplementation(opts.callTool ?? (() => Promise.resolve(null)));
	return client;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// Safe defaults so a test that doesn't care about a given boundary still works.
	mocks.readLocalSessions.mockReturnValue([]);
	mocks.getClient.mockReturnValue(
		fakeClient({ authenticated: false }),
	);
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ===========================================
// Checkpoint resolution (the `targetId` branch)
// ===========================================
describe("resumeCommand — checkpoint resolution", () => {
	it("resolves the most-recent checkpoint when no id is given (no agent filter)", async () => {
		mocks.listCheckpoints.mockReturnValue([makeCheckpoint({ id: "recent-1" })]);
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ id: "recent-1", restorable: false }));

		await resumeCommand(undefined, {});

		// `opts.agent` undefined → the spread omits `agent`, only `limit:1` is passed.
		expect(mocks.listCheckpoints).toHaveBeenCalledWith({ limit: 1 });
		expect(mocks.getCheckpoint).toHaveBeenCalledWith("recent-1");
		expect(logged()).toContain("Resume from recent-1");
	});

	it("threads the --agent filter into listCheckpoints when resolving the latest", async () => {
		mocks.listCheckpoints.mockReturnValue([makeCheckpoint({ id: "agent-cp" })]);
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ id: "agent-cp", restorable: false }));

		await resumeCommand(undefined, { agent: "claude" });

		expect(mocks.listCheckpoints).toHaveBeenCalledWith({ agent: "claude", limit: 1 });
	});

	it("errors and returns early when no checkpoints exist", async () => {
		mocks.listCheckpoints.mockReturnValue([]);

		await resumeCommand(undefined, {});

		expect(errored()).toContain("No checkpoints found");
		expect(errored()).toContain("interlinked checkpoint <message>");
		expect(process.exitCode).toBe(1);
		expect(mocks.getCheckpoint).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("uses an explicit id without listing checkpoints", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ id: "explicit", restorable: false }));

		await resumeCommand("explicit", {});

		expect(mocks.listCheckpoints).not.toHaveBeenCalled();
		expect(mocks.getCheckpoint).toHaveBeenCalledWith("explicit");
	});

	it("errors and returns early when the checkpoint is not found", async () => {
		mocks.getCheckpoint.mockReturnValue(null);

		await resumeCommand("ghost", {});

		expect(errored()).toContain("Checkpoint not found: ghost");
		expect(process.exitCode).toBe(1);
		expect(mocks.readLocalSessions).not.toHaveBeenCalled();
	});

	it("falls back to default opts when called with no opts at all (opts || {})", async () => {
		mocks.listCheckpoints.mockReturnValue([]);

		await resumeCommand();

		// getOutputMode(opts || {}) + opts?.agent both exercised on the undefined path.
		expect(mocks.listCheckpoints).toHaveBeenCalledWith({ limit: 1 });
		expect(errored()).toContain("No checkpoints found");
	});
});

// ===========================================
// Rewind branches
// ===========================================
describe("resumeCommand — rewind", () => {
	it("renders 'restored' when a restorable checkpoint rewinds successfully", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: true }));
		mocks.rewindToCheckpoint.mockReturnValue({ success: true, files_restored: ["src/a.ts"] });

		await resumeCommand("abc123def456", {});

		expect(mocks.rewindToCheckpoint).toHaveBeenCalledWith("abc123def456", { force: false });
		const out = logged();
		expect(out).toContain("Rewind");
		expect(out).toContain("restored");
	});

	it("renders 'skipped (uncommitted changes)' when rewind reports success:false", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: true }));
		mocks.rewindToCheckpoint.mockReturnValue({
			success: false,
			files_restored: [],
			warning: "dirty",
		});

		await resumeCommand("abc123def456", {});

		expect(logged()).toContain("skipped (uncommitted changes)");
	});

	it("swallows a rewind throw and falls to the restorable-but-null-result branch", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: true }));
		mocks.rewindToCheckpoint.mockImplementation(() => {
			throw new Error("working tree dirty");
		});

		await resumeCommand("abc123def456", {});

		// rewindResult stays null → `else if (checkpoint.restorable)` renders the skip line.
		expect(logged()).toContain("skipped (uncommitted changes)");
		// The throw was caught inside resume, not surfaced as a command error.
		expect(process.exitCode).toBeUndefined();
	});

	it("renders 'not available (archived)' and never calls rewind for a non-restorable checkpoint", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));

		await resumeCommand("abc123def456", {});

		expect(mocks.rewindToCheckpoint).not.toHaveBeenCalled();
		expect(logged()).toContain("not available (archived)");
	});
});

// ===========================================
// Session context branches
// ===========================================
describe("resumeCommand — session context", () => {
	it("renders the session block with a bounded files list when a session matches", async () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ session_id: "sess-1", restorable: false }),
		);
		mocks.readLocalSessions.mockReturnValue([
			makeSession({ session_id: "other" }),
			makeSession({
				session_id: "sess-1",
				tool_count: 7,
				files_touched: ["f0", "f1", "f2", "f3", "f4", "f5", "f6"],
			}),
		]);

		await resumeCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("Session Context:");
		expect(out).toContain("Tools used");
		expect(out).toContain("7");
		// Only the first 5 files are joined.
		expect(out).toContain("f0, f1, f2, f3, f4");
		expect(out).not.toContain("f5");
	});

	it("omits the session Files line when the matched session touched no files", async () => {
		// files_changed:[] removes the "Files at checkpoint" block so the only
		// possible "Files" kvLine left would be the session one — which must be absent.
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ session_id: "sess-1", files_changed: [], restorable: false }),
		);
		mocks.readLocalSessions.mockReturnValue([
			makeSession({ session_id: "sess-1", tool_count: 3, files_touched: [] }),
		]);

		await resumeCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("Session Context:");
		expect(out).toContain("Tools used");
		// files_touched.length === 0 → the `if (... > 0)` Files kvLine is skipped,
		// and files_changed:[] means no "Files at checkpoint" block either.
		expect(out).not.toContain("Files");
	});

	it("omits the entire Session Context block when no session matches", async () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ session_id: "missing-sess", restorable: false }),
		);
		mocks.readLocalSessions.mockReturnValue([makeSession({ session_id: "different" })]);

		await resumeCommand("abc123def456", {});

		expect(logged()).not.toContain("Session Context:");
	});
});

// ===========================================
// Files-at-checkpoint branches
// ===========================================
describe("resumeCommand — files at checkpoint", () => {
	it("lists files and omits the overflow note when there are 10 or fewer", async () => {
		const files = Array.from({ length: 4 }, (_, i) => `src/file${i}.ts`);
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ files_changed: files, restorable: false }),
		);

		await resumeCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("Files at checkpoint:");
		expect(out).toContain("src/file0.ts");
		expect(out).toContain("src/file3.ts");
		expect(out).not.toContain("more");
	});

	it("truncates the files list at 10 and reports the overflow count", async () => {
		const files = Array.from({ length: 14 }, (_, i) => `src/file${i}.ts`);
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ files_changed: files, restorable: false }),
		);

		await resumeCommand("abc123def456", {});

		const out = logged();
		expect(out).toContain("src/file9.ts");
		expect(out).not.toContain("src/file10.ts");
		expect(out).toContain("... and 4 more");
	});

	it("omits the files-at-checkpoint block entirely when none changed", async () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({ files_changed: [], restorable: false }),
		);

		await resumeCommand("abc123def456", {});

		expect(logged()).not.toContain("Files at checkpoint:");
	});
});

// ===========================================
// Server-context branches (dynamic api-client import)
// ===========================================
describe("resumeCommand — server context", () => {
	it("renders the Server Context block when authenticated and the tool returns data", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ agent: "claude", restorable: false }));
		const callTool = vi.fn().mockResolvedValue({ recent: "work-summary" });
		mocks.getClient.mockReturnValue(
			fakeClient({ authenticated: true, callTool }),
		);

		await resumeCommand("abc123def456", {});

		expect(callTool).toHaveBeenCalledWith("get_work_context", { agent_name: "claude" });
		const out = logged();
		expect(out).toContain("Server Context:");
		expect(out).toContain("work-summary");
	});

	it("skips the server fetch entirely when the client is not authenticated", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));
		const callTool = vi.fn();
		mocks.getClient.mockReturnValue(
			fakeClient({ authenticated: false, callTool }),
		);

		await resumeCommand("abc123def456", {});

		expect(callTool).not.toHaveBeenCalled();
		expect(logged()).not.toContain("Server Context:");
	});

	it("falls back to null (no Server Context) when the fetch times out", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));
		// callTool never resolves → the 3s timeout race rejects → .catch(() => null).
		const callTool = vi.fn().mockReturnValue(new Promise(() => {}));
		mocks.getClient.mockReturnValue(
			fakeClient({ authenticated: true, callTool }),
		);

		const p = resumeCommand("abc123def456", {});
		// Drive the fake timer past the SERVER_CONTEXT_TIMEOUT_MS setTimeout.
		await vi.advanceTimersByTimeAsync(3000);
		await p;

		expect(logged()).not.toContain("Server Context:");
	});

	it("falls back to null when the callTool promise itself rejects", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));
		const callTool = vi.fn().mockRejectedValue(new Error("502 bad gateway"));
		mocks.getClient.mockReturnValue(
			fakeClient({ authenticated: true, callTool }),
		);

		await resumeCommand("abc123def456", {});

		expect(logged()).not.toContain("Server Context:");
		expect(process.exitCode).toBeUndefined();
	});

	it("swallows a getClient throw and continues with local context only", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));
		mocks.getClient.mockImplementation(() => {
			throw new Error("client construction blew up");
		});

		await resumeCommand("abc123def456", {});

		// The throw is caught by the inner try; the command still renders normally.
		expect(logged()).toContain("Resume from abc123def456");
		expect(logged()).not.toContain("Server Context:");
		expect(process.exitCode).toBeUndefined();
	});
});

// ===========================================
// Output modes + full-render assertions
// ===========================================
describe("resumeCommand — output modes", () => {
	it("emits the full data object in --json mode", async () => {
		mocks.getCheckpoint.mockReturnValue(makeCheckpoint({ restorable: false }));
		mocks.readLocalSessions.mockReturnValue([makeSession({ session_id: "sess-1" })]);

		await resumeCommand("abc123def456", { json: true });

		const parsed = JSON.parse(logged());
		expect(parsed).toMatchObject({
			checkpoint: { id: "abc123def456" },
			session: { session_id: "sess-1" },
			rewindResult: null,
			serverContext: null,
		});
	});

	it("renders the full normal-mode header block with the 8-char base commit", async () => {
		mocks.getCheckpoint.mockReturnValue(
			makeCheckpoint({
				id: "header-cp",
				agent: "claude",
				message: "snapshot msg",
				trigger: "manual",
				timestamp: "2099-01-01T00:00:00.000Z",
				restorable: false,
			}),
		);

		await resumeCommand("header-cp", {});

		const out = logged();
		expect(out).toContain("Resume from header-cp");
		expect(out).toContain("Agent");
		expect(out).toContain("Message");
		expect(out).toContain("snapshot msg");
		expect(out).toContain("Trigger");
		expect(out).toContain("Created");
		// base_commit sliced to first 8 chars only.
		expect(out).toContain("01234567");
		expect(out).not.toContain("0123456789");
	});
});

// ===========================================
// Outer catch (error path)
// ===========================================
describe("resumeCommand — error handling", () => {
	it("reports an Error message via outputError when a boundary throws", async () => {
		mocks.getCheckpoint.mockImplementation(() => {
			throw new Error("checkpoints.json corrupt");
		});

		await resumeCommand("abc123def456", {});

		expect(errored()).toContain("Error: checkpoints.json corrupt");
		expect(process.exitCode).toBe(1);
	});

	it("coerces a non-Error throw to a string in the catch branch", async () => {
		mocks.getCheckpoint.mockImplementation(() => {
			throw "raw-string-failure";
		});

		await resumeCommand("abc123def456", {});

		expect(errored()).toContain("Error: raw-string-failure");
		expect(process.exitCode).toBe(1);
	});

	it("routes catch output through JSON shape in --json mode", async () => {
		mocks.getCheckpoint.mockImplementation(() => {
			throw new Error("json-path failure");
		});

		await resumeCommand("abc123def456", { json: true });

		expect(JSON.parse(errored())).toMatchObject({ error: "json-path failure" });
		expect(process.exitCode).toBe(1);
	});
});
