// Behavioral coverage for `interlinked status`.
//
// status.ts is a ~246-stmt commander handler that fans out to local readers
// (sessions / stats / sync-diagnostics / activity) plus an optional server
// health check, then renders one of four output modes (json / short / normal
// / full) and a guidance block. These tests mock the `../lib/*` data sources
// and the api-client, keep the real formatter + output router so we assert on
// the actual emitted strings, and drive every branch: each output mode, the
// configured-vs-not permutations, server reachable / unreachable / timeout /
// throw, empty-vs-populated sessions and activity, the watch loop (interval
// normalization + initial render + tick), and the error/catch path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force deterministic, color-free output. The formatter resolves `supportsColor`
// from env at module-load time, so this must run before the module graph loads —
// `vi.hoisted` executes before the static imports above are evaluated.
vi.hoisted(() => {
	process.env.NO_COLOR = "1";
});

import type { ResolvedConfig } from "../lib/config.js";
// Real (unmocked) formatter helper used to build exact-expected rendered lines
// so mutation-killing assertions don't hand-count padding/whitespace.
import { kvLine } from "../lib/formatter.js";
import type {
	LocalActivityEvent,
	LocalStats,
	SessionState,
	SyncDiagnostics,
} from "../lib/local-activity.js";

// ===========================================
// Hoisted mock fns
// ===========================================

const {
	mockResolveConfig,
	mockReadLocalSessions,
	mockGetLocalStats,
	mockGetSyncDiagnostics,
	mockReadLocalActivity,
	mockHealthCheck,
} = vi.hoisted(() => ({
	mockResolveConfig: vi.fn(),
	mockReadLocalSessions: vi.fn(),
	mockGetLocalStats: vi.fn(),
	mockGetSyncDiagnostics: vi.fn(),
	mockReadLocalActivity: vi.fn(),
	mockHealthCheck: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	resolveConfig: mockResolveConfig,
}));

vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({ healthCheck: mockHealthCheck }),
}));

// Keep the real type re-exports; replace only the four reader functions.
vi.mock("../lib/local-activity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/local-activity.js")>();
	return {
		...actual,
		readLocalSessions: mockReadLocalSessions,
		getLocalStats: mockGetLocalStats,
		getSyncDiagnostics: mockGetSyncDiagnostics,
		readLocalActivity: mockReadLocalActivity,
	};
});

// status.ts has no direct node:fs import, but every code path that would touch
// the disk is mocked above. We still stub node:fs so an accidental fs reach
// during refactors fails loud instead of writing to a real `.interlinked/`.
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => {
		throw new Error("node:fs.readFileSync should not be reached in status tests");
	}),
	readdirSync: vi.fn(() => []),
	statSync: vi.fn(() => {
		throw new Error("node:fs.statSync should not be reached in status tests");
	}),
	writeFileSync: vi.fn(),
	appendFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

// Real (mocked-module) bindings used to seed a non-empty enforcement ledger
// for a single call — see "statusCommand — Scorecard section" below.
import { existsSync, readFileSync } from "node:fs";
import { statusCommand } from "./status.js";

// ===========================================
// Fixture builders (omit absent optional keys — exactOptionalPropertyTypes)
// ===========================================

function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		server_url: "https://server.example.com",
		workspace_id: "ws_main",
		default_workspace_key: "main",
		default_project: "proj",
		agent_name: "Alice",
		sync_mode: "realtime",
		...over,
	} as ResolvedConfig;
}

function makeStats(over: Partial<LocalStats> = {}): LocalStats {
	return {
		total_events: 0,
		file_size_bytes: 0,
		pending_sync: 0,
		...over,
	};
}

function makeSync(over: Partial<SyncDiagnostics> = {}): SyncDiagnostics {
	return {
		pending_realtime_retry: 0,
		sync_error_count: 0,
		...over,
	};
}

function makeSession(over: Partial<SessionState> = {}): SessionState {
	return {
		session_id: "sess-1",
		agent: "Alice",
		phase: "ACTIVE",
		started_at: "2026-06-01T10:00:00.000Z",
		last_event_at: "2026-06-01T10:05:00.000Z",
		tool_count: 3,
		error_count: 0,
		files_touched: [],
		tools_used: {},
		...over,
	};
}

function makeActivity(over: Partial<LocalActivityEvent> = {}): LocalActivityEvent {
	return {
		ts: "2026-06-01T10:05:00.000Z",
		agent: "Alice",
		type: "PreToolUse",
		...over,
	};
}

// Default the four readers to empty/healthy so each test only overrides what
// it exercises.
function setReaders(opts: {
	config?: ResolvedConfig;
	sessions?: SessionState[];
	stats?: LocalStats;
	sync?: SyncDiagnostics;
	activity?: LocalActivityEvent[];
}): void {
	mockResolveConfig.mockReturnValue(opts.config ?? makeConfig());
	mockReadLocalSessions.mockReturnValue(opts.sessions ?? []);
	mockGetLocalStats.mockReturnValue(opts.stats ?? makeStats());
	mockGetSyncDiagnostics.mockReturnValue(opts.sync ?? makeSync());
	mockReadLocalActivity.mockReturnValue(opts.activity ?? []);
}

/** Concatenate every console.log argument across all calls. */
function loggedText(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((args) => args.map((a) => String(a)).join(" "))
		.join("\n");
}

/** First console.log call's first arg (the rendered block for a single run). */
function firstLog(): string {
	const raw = vi.mocked(console.log).mock.calls[0]?.[0];
	return typeof raw === "string" ? raw : String(raw);
}

function erroredText(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((args) => args.map((a) => String(a)).join(" "))
		.join("\n");
}

// ===========================================
// Setup
// ===========================================

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	// Health check resolves "reachable + authed" by default.
	mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
	setReaders({});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	process.exitCode = undefined;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ===========================================
// JSON mode
// ===========================================

describe("statusCommand — json mode", () => {
	it("emits a single JSON document with sessions, stats, config and server keys", async () => {
		const sessions = [makeSession()];
		const stats = makeStats({ total_events: 42, pending_sync: 5, file_size_bytes: 2048 });
		const sync = makeSync({ pending_realtime_retry: 1, sync_error_count: 2 });
		const activity = [makeActivity({ summary: "ran tsc" })];
		setReaders({ sessions, stats, sync, activity });

		await statusCommand({ json: true });

		expect(console.log).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(firstLog()) as Record<string, unknown>;
		expect(parsed.sessions).toEqual(sessions);
		expect(parsed.stats).toEqual(stats);
		expect(parsed.sync_diagnostics).toEqual(sync);
		expect(parsed.recent_activity).toEqual(activity);
		expect(parsed.server).toEqual({
			reachable: true,
			authenticated: true,
			workspaceName: "ws_main",
		});
		const cfg = parsed.config as Record<string, unknown>;
		expect(cfg.server_url).toBe("https://server.example.com");
		expect(cfg.workspace_id).toBe("ws_main");
		expect(cfg.default_workspace_key).toBe("main");
		expect(cfg.default_project).toBe("proj");
		expect(cfg.agent_name).toBe("Alice");
		expect(cfg.sync_mode).toBe("realtime");
	});

	it("falls back to nulls/defaults for unset config fields (||/?? branches)", async () => {
		setReaders({
			config: makeConfig({
				workspace_id: undefined,
				default_workspace_key: undefined,
				default_project: undefined,
				agent_name: undefined,
			}),
		});

		await statusCommand({ json: true });

		const parsed = JSON.parse(firstLog()) as { config: Record<string, unknown> };
		expect(parsed.config.workspace_id).toBeNull();
		expect(parsed.config.default_workspace_key).toBe("main");
		expect(parsed.config.default_project).toBe("main");
		expect(parsed.config.agent_name).toBeNull();
	});
});

// ===========================================
// Short mode
// ===========================================

describe("statusCommand — short mode", () => {
	it("singularizes counts and reports server 'ok' when authenticated", async () => {
		setReaders({
			sessions: [makeSession({ phase: "ACTIVE" })],
			stats: makeStats({ total_events: 1, pending_sync: 0 }),
		});

		await statusCommand({ short: true });

		const out = firstLog();
		expect(out).toContain("1 session,");
		expect(out).toContain("1 event,");
		expect(out).toContain("mcp-server: ok");
		// No optional segments when their counters are zero.
		expect(out).not.toContain("unsynced");
		expect(out).not.toContain("retry-buffered");
		expect(out).not.toContain("sync-errors");
	});

	it("pluralizes counts and includes unsynced / retry / error segments", async () => {
		setReaders({
			sessions: [
				makeSession({ session_id: "a", phase: "ACTIVE" }),
				makeSession({ session_id: "b", phase: "ACTIVE" }),
				makeSession({ session_id: "c", phase: "ENDED" }),
			],
			stats: makeStats({ total_events: 7, pending_sync: 4 }),
			sync: makeSync({ pending_realtime_retry: 2, sync_error_count: 3 }),
		});

		await statusCommand({ short: true });

		const out = firstLog();
		expect(out).toContain("2 sessions,"); // only ACTIVE counted
		expect(out).toContain("7 events,");
		expect(out).toContain("4 unsynced");
		expect(out).toContain("2 retry-buffered");
		expect(out).toContain("3 sync-errors");
	});

	it("labels server 'unauth' when reachable but not authenticated", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({});

		await statusCommand({ short: true });

		expect(firstLog()).toContain("mcp-server: unauth");
	});

	it("labels server 'offline' when unreachable", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		setReaders({});

		await statusCommand({ short: true });

		expect(firstLog()).toContain("mcp-server: offline");
	});
});

// ===========================================
// Normal mode
// ===========================================

describe("statusCommand — normal mode", () => {
	it("renders empty-state copy for no sessions and no activity", async () => {
		setReaders({});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Sessions");
		expect(out).toContain("No sessions recorded");
		expect(out).toContain("Recent Activity");
		expect(out).toContain("No recent activity");
		expect(out).toContain("Sync Status");
		expect(out).toContain("Total events");
		expect(out).toContain("Server");
		expect(out).toContain("https://server.example.com");
	});

	it("renders an active-session table plus an ended-session footnote", async () => {
		setReaders({
			sessions: [
				makeSession({ agent: "Alice", phase: "ACTIVE", tool_count: 9 }),
				makeSession({ session_id: "old1", phase: "ENDED" }),
				makeSession({ session_id: "old2", phase: "ENDED" }),
			],
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Alice");
		expect(out).toContain("Agent"); // table header
		expect(out).toContain("Last Event");
		expect(out).toContain("+ 2 ended sessions");
	});

	it("renders ended-only line when there are no active sessions", async () => {
		setReaders({
			sessions: [makeSession({ phase: "ENDED" })],
		});

		await statusCommand({});

		expect(firstLog()).toContain("1 ended session (no active)");
	});

	it("renders 'ended session' (singular) footnote alongside an active session", async () => {
		// active present + exactly 1 ended -> the `!== 1 ? "s" : ""` singular arm.
		setReaders({
			sessions: [
				makeSession({ session_id: "live", phase: "ACTIVE" }),
				makeSession({ session_id: "done", phase: "ENDED" }),
			],
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("+ 1 ended session");
		expect(out).not.toContain("+ 1 ended sessions");
	});

	it("renders multiple ended-only sessions (plural) when none are active", async () => {
		setReaders({
			sessions: [
				makeSession({ session_id: "d1", phase: "ENDED" }),
				makeSession({ session_id: "d2", phase: "ENDED" }),
			],
		});

		await statusCommand({});

		expect(firstLog()).toContain("2 ended sessions (no active)");
	});

	it("falls back to 'main' for unset workspace/project keys in the normal reachable block", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({
			config: makeConfig({
				workspace_id: "ws_y",
				default_workspace_key: undefined,
				default_project: undefined,
			}),
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("workspace_key");
		expect(out).toContain("project_key");
	});

	it("formats a sub-kilobyte log size with the 'N B' branch", async () => {
		setReaders({ stats: makeStats({ total_events: 0, file_size_bytes: 512 }) });
		await statusCommand({});
		expect(firstLog()).toContain("512 B");
	});

	it("formats a zero-byte log with the 'bytes === 0' branch", async () => {
		setReaders({ stats: makeStats({ total_events: 0, file_size_bytes: 0 }) });
		await statusCommand({});
		expect(firstLog()).toContain("0 B");
	});

	it("renders recent activity rows with agent and summary", async () => {
		setReaders({
			activity: [
				makeActivity({ agent: "Bob", type: "PreToolUse", tool: "Bash", summary: "ls -la" }),
				// agent falsy -> dim "-" fallback branch
				makeActivity({ agent: "", type: "Stop" }),
			],
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Bob");
		expect(out).toContain("Recent Activity");
		// The dim "-" fallback for the empty-agent row.
		expect(out).toContain("-");
	});

	it("shows unsynced in yellow form and sync diagnostic fields when present", async () => {
		setReaders({
			stats: makeStats({ total_events: 3, pending_sync: 2, file_size_bytes: 1536 }),
			sync: makeSync({
				pending_realtime_retry: 1,
				sync_error_count: 4,
				last_sync_success_at: "2026-06-01T09:00:00Z",
				last_sync_error_at: "2026-06-01T09:30:00Z",
				last_sync_error: "ECONNREFUSED while flushing batch",
			}),
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("2 events"); // Unsynced kvLine value
		expect(out).toContain("1.5 KB"); // formatBytes KB branch
		expect(out).toContain("Last sync success");
		expect(out).toContain("Last sync error");
		expect(out).toContain("Last sync error msg");
		expect(out).toContain("ECONNREFUSED");
	});

	it("shows 'Unsynced 0' (green) branch when nothing is pending", async () => {
		setReaders({ stats: makeStats({ total_events: 5, pending_sync: 0 }) });

		await statusCommand({});

		expect(firstLog()).toContain("Unsynced");
	});

	it("renders reachable server block with workspace + keys", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({ config: makeConfig({ workspace_id: "ws_42" }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("reachable");
		expect(out).toContain("authenticated");
		expect(out).toContain("ws_42"); // Workspace line
		expect(out).toContain("workspace_key");
		expect(out).toContain("project_key");
	});

	it("renders reachable-but-unauthenticated server block (no workspace line when unset)", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({ config: makeConfig({ workspace_id: undefined }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("not authenticated");
		expect(out).not.toContain("Workspace ");
	});

	it("renders unreachable server block with error line", async () => {
		mockHealthCheck.mockResolvedValue({
			serverReachable: false,
			authenticated: false,
			error: "boom upstream",
		});
		setReaders({});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("unreachable");
		expect(out).toContain("Error");
		expect(out).toContain("boom upstream");
	});
});

// ===========================================
// Guidance block (renderGuidance, shared by normal+full)
// ===========================================

describe("statusCommand — guidance", () => {
	it("nudges to set agent name when unconfigured", async () => {
		setReaders({ config: makeConfig({ agent_name: undefined }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Guidance");
		expect(out).toContain("Agent name is not configured");
		expect(out).toContain("interlinked attach --agent");
	});

	it("warns about 'unknown' attribution when sessions/activity are unknown", async () => {
		setReaders({
			sessions: [makeSession({ agent: "unknown" })],
			activity: [
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "unknown" }),
			],
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("attributed to 'unknown'");
		expect(out).toContain("interlinked clean --dry-run");
	});

	it("local server: reachable+unauth emits 'auth is optional on localhost'", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "http://localhost:8787" }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("auth is optional on localhost");
		expect(out).toContain("interlinked doctor --fix");
	});

	it("local server: unreachable emits 'Local server is not reachable' + npm run dev", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "http://127.0.0.1:8787" }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Local server is not reachable");
		expect(out).toContain("npm run dev");
	});

	it("remote server: reachable+unauth emits login guidance", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Server reachable but not authenticated");
		expect(out).toContain("interlinked login");
	});

	it("remote server: unreachable emits offline-still-works guidance", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("Remote unavailable");
	});

	it("emits no Guidance section when everything is configured + healthy", async () => {
		// agent set, no unknowns, remote reachable + authed.
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		expect(firstLog()).not.toContain("Guidance");
	});
});

// ===========================================
// Full mode
// ===========================================

describe("statusCommand — full mode", () => {
	it("renders per-session detail: files, tools, tokens, subagents, code activity, commits", async () => {
		const session = makeSession({
			agent: "Alice",
			session_id: "sess-full",
			started_at: "2026-06-01T08:00:00Z",
			tool_count: 5,
			error_count: 1,
			files_touched: Array.from({ length: 22 }, (_, i) => `src/file${i}.ts`),
			tools_used: { Bash: 3, Edit: 2 },
			tokens_total: { input: 1000, output: 500, cache_read: 10, cache_creation: 5 },
			token_events: 4,
			subagents: {
				worker: {
					files_touched: ["src/a.ts"],
					tools_used: { Read: 1 },
					tool_count: 1,
					tokens: { input: 100, output: 50 },
				},
			},
			by_agent: {
				Alice: {
					agent_name: "Alice",
					session_id: "sess-full",
					files_touched: ["src/a.ts", "src/b.ts"],
					total_added: 30,
					total_removed: 4,
					edit_count: 6,
				},
			},
			commits: Array.from({ length: 7 }, (_, i) => ({
				commit_hash: `abcdef0${i}1234567890`,
				timestamp: "2026-06-01T08:30:00Z",
				message: `commit ${i}`,
				files: [],
			})),
		});
		setReaders({ sessions: [session] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("sess-full");
		expect(out).toContain("Errors"); // full table has an Errors column
		expect(out).toContain("Files touched (22)");
		expect(out).toContain("... and 2 more"); // >20 files truncation
		expect(out).toContain("Tools used:");
		expect(out).toContain("Bash: 3");
		expect(out).toContain("Token usage:");
		expect(out).toContain("across 4 events");
		expect(out).toContain("Subagents:");
		expect(out).toContain("worker: 1 tools, 1 files");
		expect(out).toContain("Code activity:");
		expect(out).toContain("Alice: +30/-4 (6 edits, 2 files)");
		expect(out).toContain("Commits attributed: 7");
		expect(out).toContain("... and 2 more"); // >5 commits truncation
		// Aggregated Token Usage summary section across all sessions.
		expect(out).toContain("Token Usage");
		expect(out).toContain("Est. cost");
	});

	it("renders commit with '(no message)' fallback and token_events-absent suffix", async () => {
		const session = makeSession({
			tokens_total: { input: 200, output: 0 },
			subagents: {
				w: {
					files_touched: [],
					tools_used: {},
					tool_count: 0,
					// no tokens -> empty tokStr branch
				},
			},
			commits: [
				{ commit_hash: "deadbeef1234567", timestamp: "2026-06-01T08:30:00Z", files: [] },
			],
		});
		setReaders({ sessions: [session] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("(no message)");
		expect(out).toContain("Token usage:"); // present (input>0) but no "across N events"
		expect(out).not.toContain("across");
		expect(out).toContain("w: 0 tools, 0 files"); // subagent without tokens
	});

	it("renders empty-state and skips Token Usage summary when no token totals", async () => {
		setReaders({ sessions: [] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("No sessions recorded");
		expect(out).not.toContain("Token Usage");
	});

	it("uses readLocalActivity(limit:50) for the full activity list and renders [tool] detail", async () => {
		setReaders({
			sessions: [makeSession()],
			activity: [makeActivity()],
		});
		// Full mode re-queries activity with limit 50; return a distinct payload
		// on the second call so we can prove it is the one rendered.
		mockReadLocalActivity
			.mockReturnValueOnce([]) // limit:10 inside fetchStatusData
			.mockReturnValueOnce([
				makeActivity({ agent: "Carol", type: "PostToolUse", tool: "Write", summary: "wrote x" }),
				makeActivity({ agent: "", type: "Stop" }), // empty-agent dim fallback
			]);

		await statusCommand({ full: true });

		expect(mockReadLocalActivity).toHaveBeenLastCalledWith({ limit: 50 });
		const out = firstLog();
		expect(out).toContain("Carol");
		expect(out).toContain("[Write]"); // tool-detail suffix branch
	});

	it("renders 'No recent activity' in full mode when the 50-limit query is empty", async () => {
		setReaders({ sessions: [makeSession()] });
		mockReadLocalActivity.mockReturnValueOnce([]).mockReturnValueOnce([]);

		await statusCommand({ full: true });

		expect(firstLog()).toContain("No recent activity");
	});

	it("renders oldest/newest event lines when stats include them", async () => {
		setReaders({
			sessions: [makeSession()],
			stats: makeStats({
				total_events: 9,
				file_size_bytes: 5 * 1024 * 1024,
				oldest_event: "2026-05-01T00:00:00Z",
				newest_event: "2026-06-01T00:00:00Z",
			}),
		});

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("Oldest event");
		expect(out).toContain("Newest event");
		expect(out).toContain("5.0 MB"); // formatBytes MB branch
	});

	it("renders an ENDED session as 'offline', skips token/subagent/code sections when absent, and lists 1-20 files without truncation", async () => {
		const session = makeSession({
			phase: "ENDED", // line 336 offline badge branch
			files_touched: ["src/only.ts"], // 1 file: >0 true, >20 false (no truncation)
			tools_used: {}, // empty -> Tools used breakdown skipped
			// no tokens_total / subagents / by_agent / commits -> those blocks skipped
		});
		setReaders({ sessions: [session] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("Files touched (1)");
		expect(out).toContain("src/only.ts");
		expect(out).not.toContain("... and"); // no >20 / >5 truncation lines
		expect(out).not.toContain("Token usage:");
		expect(out).not.toContain("Subagents:");
		expect(out).not.toContain("Code activity:");
		expect(out).not.toContain("Commits attributed:");
	});

	it("aggregates output-only tokens and zero-valued subagent tokens (||/?? fallbacks)", async () => {
		const session = makeSession({
			// input falsy, output truthy -> exercises the `|| output` alt at the
			// per-session guard AND the `input || 0` fallback in the reduce.
			tokens_total: { input: 0, output: 250 },
			subagents: {
				w: {
					files_touched: [],
					tools_used: {},
					tool_count: 0,
					tokens: { input: 0, output: 0 }, // input||0 / output||0 fallbacks
				},
			},
		});
		setReaders({ sessions: [session] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("Token usage:"); // per-session line via output>0
		expect(out).toContain("(0 in / 0 out)"); // zero-token subagent suffix
		expect(out).toContain("Token Usage"); // aggregate summary (output>0)
	});

	it("renders the FULL-mode unreachable server block + sync diagnostics + guidance", async () => {
		mockHealthCheck.mockResolvedValue({
			serverReachable: false,
			authenticated: false,
			error: "full-mode upstream down",
		});
		setReaders({
			// agent unset -> guidance section fires in full mode (lines 507-510)
			config: makeConfig({ agent_name: undefined, server_url: "https://remote.example.com" }),
			sessions: [makeSession()],
			stats: makeStats({ total_events: 4, pending_sync: 3 }), // pending_sync>0 in full
			sync: makeSync({
				pending_realtime_retry: 1,
				sync_error_count: 2,
				last_sync_success_at: "2026-06-01T09:00:00Z", // full-mode lines 464-465
				last_sync_error_at: "2026-06-01T09:30:00Z", // full-mode lines 467-468
				last_sync_error: "full flush failed", // full-mode lines 470-472
			}),
		});

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("3 events"); // full-mode Unsynced yellow value (line 456)
		expect(out).toContain("Last sync success");
		expect(out).toContain("Last sync error");
		expect(out).toContain("Last sync error msg");
		expect(out).toContain("full flush failed");
		expect(out).toContain("unreachable"); // full-mode line 501
		expect(out).toContain("full-mode upstream down"); // full-mode lines 502-503
		expect(out).toContain("Guidance"); // full-mode lines 508-510
	});

	it("renders FULL reachable-but-unauthenticated block and omits the workspace line when unset", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({
			config: makeConfig({ workspace_id: undefined }), // workspaceName null -> no Workspace line
			sessions: [makeSession()],
		});

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("not authenticated"); // line 490 false arm
		expect(out).not.toContain("Workspace "); // line 495 false arm
		expect(out).toContain("workspace_key"); // keys still printed
	});

	it("renders FULL unreachable block without an Error line when no error is set", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		// Empty sessions so the sessions table (which has an "Errors" column header)
		// isn't rendered — isolates the server-block Error kvLine, line 502 false arm.
		setReaders({ sessions: [] });

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("unreachable");
		expect(out).not.toContain("Error"); // line 502 false arm (no error kvLine)
	});

	it("falls back to 'main' for unset workspace/project keys in the FULL reachable block", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({
			config: makeConfig({
				workspace_id: "ws_x",
				default_workspace_key: undefined,
				default_project: undefined,
			}),
			sessions: [makeSession()],
		});

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).toContain("workspace_key"); // value "main" fallback (line 498)
		expect(out).toContain("project_key"); // value "main" fallback (line 499)
		expect(out).toContain("ws_x"); // Workspace line present (line 495-496)
	});
});

// ===========================================
// Server health: timeout + thrown getClient
// ===========================================

describe("statusCommand — server health edge cases", () => {
	it("reports a timeout error when healthCheck never resolves within the window", async () => {
		// healthCheck pending forever -> Promise.race resolves via the setTimeout(null).
		mockHealthCheck.mockReturnValue(new Promise<never>(() => {}));
		setReaders({});

		const p = statusCommand({});
		// Advance past the 3s server-health timeout so the race settles.
		await vi.advanceTimersByTimeAsync(3000);
		await p;

		const out = firstLog();
		expect(out).toContain("unreachable");
		expect(out).toContain("Timeout (3s)");
	});

	it("catches a throwing health check and reports 'Not configured or unreachable'", async () => {
		mockHealthCheck.mockRejectedValue(new Error("client exploded"));
		setReaders({});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("unreachable");
		expect(out).toContain("Not configured or unreachable");
	});
});

// ===========================================
// Top-level catch (error path)
// ===========================================

describe("statusCommand — error path", () => {
	it("routes an Error thrown during data fetch through outputError (normal mode)", async () => {
		mockResolveConfig.mockImplementation(() => {
			throw new Error("config blew up");
		});

		await statusCommand({});

		expect(erroredText()).toContain("Error: config blew up");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throw and emits structured json error in json mode", async () => {
		mockResolveConfig.mockImplementation(() => {
			throw "plain string failure";
		});

		await statusCommand({ json: true });

		const errText = erroredText();
		expect(errText).toContain("plain string failure");
		const parsed = JSON.parse(errText) as { error: string };
		expect(parsed.error).toBe("plain string failure");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// Watch mode (interval normalization + initial render + tick)
// ===========================================

describe("statusCommand — watch mode", () => {
	it("warns + clamps a too-small interval, renders once, then ticks on the timer", async () => {
		setReaders({ sessions: [makeSession()] });

		// watch="1" is below MIN_WATCH_SEC(2) -> warn + normalize to 10s.
		await statusCommand({ watch: "1" });

		// Warning line + initial render both went to console.log.
		expect(loggedText()).toContain("Watch interval must be >= 2s. Using 10s.");
		const initialCalls = vi.mocked(console.log).mock.calls.length;
		expect(initialCalls).toBeGreaterThanOrEqual(2);

		// Advance one interval (10s) to fire the recurring tick.
		await vi.advanceTimersByTimeAsync(10_000);

		// Tick clears the screen and re-renders -> more log calls + a stdout clear.
		expect(vi.mocked(console.log).mock.calls.length).toBeGreaterThan(initialCalls);
		expect(loggedText()).toContain("Refreshing every 10s");
		expect(process.stdout.write).toHaveBeenCalledWith("\x1B[2J\x1B[0f");
	});

	it("honors a valid numeric-string interval without warning", async () => {
		setReaders({});

		await statusCommand({ watch: "5" });

		expect(loggedText()).not.toContain("Watch interval must be");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(loggedText()).toContain("Refreshing every 5s");
	});

	it("uses the default interval when watch is boolean true", async () => {
		setReaders({});

		await statusCommand({ watch: true });

		expect(loggedText()).not.toContain("Watch interval must be");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(loggedText()).toContain("Refreshing every 10s");
	});

	it("suppresses the clamp warning in json mode even for a bad interval", async () => {
		setReaders({});

		await statusCommand({ watch: "1", json: true });

		// json mode -> no human warning; first emission is the JSON doc.
		expect(loggedText()).not.toContain("Watch interval must be");
		expect(() => JSON.parse(firstLog())).not.toThrow();
	});

	it("does not enter watch mode when watch is false", async () => {
		setReaders({});

		await statusCommand({ watch: false });

		// Single render, no recurring timer text even after advancing.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(loggedText()).not.toContain("Refreshing every");
	});

	it("falls back to default interval when watch string is non-numeric (NaN guard)", async () => {
		setReaders({});

		await statusCommand({ watch: "abc" });

		// NaN parse -> not finite -> normalized to default 10s, with a warning
		// (normalizedWatch !== parsedWatch since NaN !== anything).
		expect(loggedText()).toContain("Using 10s");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(loggedText()).toContain("Refreshing every 10s");
	});

	it("never enters the watch loop when opts.watch is entirely absent", async () => {
		// Mutation target: `opts.watch !== undefined && opts.watch !== false`
		// forced to `true` would enter the loop even for a plain `{}` call.
		setReaders({});

		await statusCommand({});
		await vi.advanceTimersByTimeAsync(60_000);

		expect(loggedText()).not.toContain("Refreshing every");
	});

	it("accepts watch='2' at the exact MIN_WATCH_SEC boundary with no clamp warning", async () => {
		// Mutation target: `parsedWatch >= MIN_WATCH_SEC` flipped to `>` would
		// reject the boundary value 2 and clamp it to the 10s default instead.
		setReaders({});

		await statusCommand({ watch: "2" });

		expect(loggedText()).not.toContain("Watch interval must be");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(loggedText()).toContain("Refreshing every 2s");
	});
});

// ===========================================
// unknownRecentCount / unknownSessionCount — exact filter-predicate coverage
// ===========================================
//
// `unknownRecentCount`/`unknownSessionCount` feed the `> 0 || >= 3` guard at
// the top of renderGuidance. Each pair below isolates ONE counter at a time
// (holding the other at a value that cannot independently satisfy the OR) so
// a broken predicate — over-count, under-count, or a dropped `.filter()`
// entirely — flips the boolean outcome of the "attributed to 'unknown'" line.

describe("statusCommand — unknown-attribution predicate boundaries", () => {
	it("counts exactly 3 unknown-agent activity events as meeting the >=3 threshold", async () => {
		setReaders({
			sessions: [], // unknownSessionCount stays 0 — isolates the activity filter
			activity: [
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "unknown" }),
			],
		});

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("attributed to 'unknown'");
		expect(out).toContain(
			"Regenerate hooks (`interlinked enable`) and/or set a stable identity (`interlinked attach --agent <name>`).",
		);
	});

	it("does not count named-agent events as unknown (mixed 2-unknown/3-named, under threshold)", async () => {
		setReaders({
			sessions: [],
			activity: [
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "unknown" }),
				makeActivity({ agent: "Alice" }),
				makeActivity({ agent: "Bob" }),
				makeActivity({ agent: "Carol" }),
			],
		});

		await statusCommand({});

		expect(firstLog()).not.toContain("attributed to 'unknown'");
	});

	it("counts a single unknown-agent session as meeting the >0 threshold", async () => {
		setReaders({
			sessions: [makeSession({ agent: "unknown" })],
			activity: [], // unknownRecentCount stays 0 — isolates the session filter
		});

		await statusCommand({});

		expect(firstLog()).toContain("attributed to 'unknown'");
	});

	it("does not count named-agent sessions as unknown (3 distinctly-named sessions)", async () => {
		setReaders({
			sessions: [
				makeSession({ session_id: "a", agent: "Alice" }),
				makeSession({ session_id: "b", agent: "Bob" }),
				makeSession({ session_id: "c", agent: "Carol" }),
			],
			activity: [],
		});

		await statusCommand({});

		expect(firstLog()).not.toContain("attributed to 'unknown'");
	});

	it("calls readLocalActivity with the exact {limit:10} argument for the recent-activity fetch", async () => {
		setReaders({});

		await statusCommand({});

		expect(mockReadLocalActivity).toHaveBeenCalledWith({ limit: 10 });
	});
});

// ===========================================
// renderGuidance — server/local boundary conditions (negative direction)
// ===========================================
//
// Existing tests exercise the "shows" (true) direction of each guidance
// clause. These add the "should NOT show" boundary so a `&&`/`||` swap or a
// clause dropped from the compound condition is caught.

describe("statusCommand — guidance negative boundaries", () => {
	it("does not show the agent-name nudge but does show its full copy when it IS unconfigured", async () => {
		setReaders({ config: makeConfig({ agent_name: undefined }) });

		await statusCommand({});

		expect(firstLog()).toContain(
			"Project-level capture is active with session-scoped agent IDs.",
		);
	});

	it("local server reachable+authenticated: does NOT show the 'auth is optional' nudge", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({ config: makeConfig({ server_url: "http://localhost:9999" }) });

		await statusCommand({});

		expect(firstLog()).not.toContain("auth is optional on localhost");
	});

	it("remote unreachable: does NOT show the local-server-unreachable nudge", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		expect(firstLog()).not.toContain("Local server is not reachable");
	});

	it("remote reachable+authenticated: does NOT show the 'reachable but not authenticated' nudge", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		expect(firstLog()).not.toContain("Server reachable but not authenticated");
	});

	it("remote reachable+unauthenticated: shows the full local-only-commands copy", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({ config: makeConfig({ server_url: "https://remote.example.com" }) });

		await statusCommand({});

		expect(firstLog()).toContain(
			"Local-only commands still work: interlinked status, activity, explain, doctor.",
		);
	});
});

// ===========================================
// renderServerSection — exact kvLine assertions
// ===========================================
//
// Built from the real (unmocked) `kvLine` so exact padding/label text is
// asserted without hand-counting whitespace. Catches label/value
// StringLiteral mutants that a `.toContain` substring check would miss when
// the mutated string collides with other rendered text.

describe("statusCommand — server section exact lines", () => {
	it("renders exact URL/Status/Auth/Workspace/key lines when reachable+authenticated", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({
			config: makeConfig({
				server_url: "https://server.example.com",
				workspace_id: "ws_42",
				default_workspace_key: "wsk",
				default_project: "projX",
			}),
		});

		await statusCommand({});

		const lines = firstLog().split("\n");
		expect(lines).toContain(kvLine("URL", "https://server.example.com"));
		expect(lines).toContain(kvLine("Status", "reachable"));
		expect(lines).toContain(kvLine("Auth", "authenticated"));
		expect(lines).toContain(kvLine("Workspace", "ws_42"));
		expect(lines).toContain(kvLine("workspace_key", "wsk"));
		expect(lines).toContain(kvLine("project_key", "projX"));
	});

	it("renders the exact 'Auth: not authenticated' line when reachable but unauthenticated", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: false });
		setReaders({});

		await statusCommand({});

		expect(firstLog().split("\n")).toContain(kvLine("Auth", "not authenticated"));
	});

	it("renders the exact 'Status: unreachable' line when unreachable", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: false, authenticated: false });
		setReaders({ sessions: [] });

		await statusCommand({});

		expect(firstLog().split("\n")).toContain(kvLine("Status", "unreachable"));
	});

	it("falls back workspace_key/project_key to the exact 'main' value when both are unset", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({
			config: makeConfig({
				workspace_id: "ws_y",
				default_workspace_key: undefined,
				default_project: undefined,
			}),
		});

		await statusCommand({});

		const lines = firstLog().split("\n");
		expect(lines).toContain(kvLine("workspace_key", "main"));
		expect(lines).toContain(kvLine("project_key", "main"));
	});
});

// ===========================================
// renderSyncStatus — exact kvLine assertions
// ===========================================

describe("statusCommand — sync status exact lines", () => {
	it("renders exact zero-state Log size / Unsynced / retry-buffer / sync-errors lines, no last-sync lines", async () => {
		setReaders({
			stats: makeStats({ total_events: 0, pending_sync: 0, file_size_bytes: 0 }),
			sync: makeSync({ pending_realtime_retry: 0, sync_error_count: 0 }),
		});

		await statusCommand({});

		const out = firstLog();
		const lines = out.split("\n");
		expect(lines).toContain(kvLine("Log size", "0 B"));
		expect(lines).toContain(kvLine("Unsynced", "0"));
		expect(lines).toContain(kvLine("Realtime retry buffer", "0"));
		expect(lines).toContain(kvLine("Sync errors", "0"));
		expect(out).not.toContain("Last sync success");
		expect(out).not.toContain("Last sync error");
	});

	it("renders the exact 'N events' pluralized Unsynced line when pending_sync > 0", async () => {
		setReaders({ stats: makeStats({ total_events: 4, pending_sync: 4 }) });

		await statusCommand({});

		expect(firstLog().split("\n")).toContain(kvLine("Unsynced", "4 events"));
	});

	it("renders the Last-sync-error line (and omits Last-sync-success) when only error_at is set", async () => {
		setReaders({
			sync: makeSync({ last_sync_error_at: "2026-06-01T09:30:00Z" }),
		});

		await statusCommand({});

		const out = firstLog();
		expect(out.split("\n")).toContain(kvLine("Last sync error", "2026-06-01T09:30:00Z"));
		expect(out).not.toContain("Last sync success");
	});

	it("formats exactly 1024 bytes as '1.0 KB' (BYTES_PER_KB boundary)", async () => {
		setReaders({ stats: makeStats({ file_size_bytes: 1024 }) });

		await statusCommand({});

		expect(firstLog().split("\n")).toContain(kvLine("Log size", "1.0 KB"));
	});

	it("formats exactly 1048576 bytes as '1.0 MB' (BYTES_PER_MB boundary)", async () => {
		setReaders({ stats: makeStats({ file_size_bytes: 1048576 }) });

		await statusCommand({});

		expect(firstLog().split("\n")).toContain(kvLine("Log size", "1.0 MB"));
	});
});

// ===========================================
// renderNormal — additional exact/negative assertions
// ===========================================

describe("statusCommand — normal mode additional coverage", () => {
	it("does not render the empty-state copy when a session is present", async () => {
		setReaders({ sessions: [makeSession({ phase: "ACTIVE" })] });

		await statusCommand({});

		expect(firstLog()).not.toContain("No sessions recorded");
	});

	it("renders the exact '[active]' badge and Phase/Tools table headers for an active session", async () => {
		setReaders({ sessions: [makeSession({ phase: "ACTIVE" })] });

		await statusCommand({});

		const out = firstLog();
		expect(out).toContain("[active]");
		expect(out).toContain("Phase");
		expect(out).toContain("Tools");
	});

	it("omits the ended-session footnote entirely when there are zero ended sessions", async () => {
		setReaders({ sessions: [makeSession({ phase: "ACTIVE" })] });

		await statusCommand({});

		expect(firstLog()).not.toContain("ended session");
	});

	it("never leaks the Stryker sentinel string from an active+ended session footnote", async () => {
		setReaders({
			sessions: [
				makeSession({ session_id: "act", phase: "ACTIVE" }),
				makeSession({ session_id: "end1", phase: "ENDED" }),
			],
		});

		await statusCommand({});

		expect(firstLog()).not.toContain("Stryker was here");
	});

	it("never leaks the Stryker sentinel string from any normal-mode array initializer", async () => {
		setReaders({ sessions: [makeSession()], activity: [makeActivity()] });

		await statusCommand({});

		expect(firstLog()).not.toContain("Stryker was here");
	});

	it("does not append a '[tool]' detail suffix to normal-mode activity rows", async () => {
		setReaders({
			activity: [makeActivity({ agent: "Bob", tool: "Bash", summary: "ls -la" })],
		});

		await statusCommand({});

		expect(firstLog()).not.toContain("[Bash]");
	});

	it("joins rendered lines with an actual newline (Total events directly precedes Log size)", async () => {
		setReaders({ stats: makeStats({ total_events: 0, file_size_bytes: 0 }) });

		await statusCommand({});

		expect(firstLog()).toContain(
			`${kvLine("Total events", "0")}\n${kvLine("Log size", "0 B")}`,
		);
	});
});

// ===========================================
// Scorecard — the enforcement-ledger section
// ===========================================

describe("statusCommand — Scorecard section", () => {
	it("renders the ledger's since date once tool calls have been judged", async () => {
		// The module-level node:fs mock defaults existsSync to false, which is
		// the fresh-install path exercised everywhere else in this file. Here we
		// answer the ONE existsSync/readFileSync pair `loadEnforcementLedger`
		// makes with a real, non-empty ledger for this call only.
		vi.mocked(existsSync).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockReturnValueOnce(
			JSON.stringify({
				version: 1,
				since: "2026-01-02T03:04:05.000Z",
				cursor: 0,
				blocked: 1,
				caught: 2,
				evaluated: 5,
			}),
		);

		await statusCommand({});

		expect(firstLog()).toContain(kvLine("Tool calls judged", "5 since 2026-01-02"));
	});
});

// ===========================================
// renderFull — additional exact/negative assertions
// ===========================================

describe("statusCommand — full mode additional coverage", () => {
	it("healthy config: skips Guidance and Oldest/Newest-event lines and leaks no Stryker sentinel", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({}); // default config: agent_name set, no unknowns, remote reachable+authed

		await statusCommand({ full: true });

		const out = firstLog();
		expect(out).not.toContain("Guidance");
		expect(out).not.toContain("Oldest event");
		expect(out).not.toContain("Newest event");
		expect(out).not.toContain("Stryker was here");
	});

	it("joins full-mode lines with an actual newline (Total events directly precedes Log size)", async () => {
		setReaders({
			sessions: [makeSession()],
			stats: makeStats({ total_events: 0, file_size_bytes: 0 }),
		});

		await statusCommand({ full: true });

		expect(firstLog()).toContain(
			`${kvLine("Total events", "0")}\n${kvLine("Log size", "0 B")}`,
		);
	});
});

// ===========================================
// Server health: exact server-status object (timeout / thrown)
// ===========================================

describe("statusCommand — server health exact object shape", () => {
	it("timeout produces an exact {reachable:false, authenticated:false, ...} server object (json)", async () => {
		mockHealthCheck.mockReturnValue(new Promise<never>(() => {}));
		setReaders({});

		const p = statusCommand({ json: true });
		await vi.advanceTimersByTimeAsync(3000);
		await p;

		const parsed = JSON.parse(firstLog()) as { server: unknown };
		expect(parsed.server).toStrictEqual({
			reachable: false,
			authenticated: false,
			workspaceName: null,
			error: "Timeout (3s)",
		});
	});

	it("a thrown health check produces an exact {reachable:false, authenticated:false, ...} server object (json)", async () => {
		mockHealthCheck.mockRejectedValue(new Error("client exploded"));
		setReaders({});

		await statusCommand({ json: true });

		const parsed = JSON.parse(firstLog()) as { server: unknown };
		expect(parsed.server).toStrictEqual({
			reachable: false,
			authenticated: false,
			workspaceName: null,
			error: "Not configured or unreachable",
		});
	});
});

// ===========================================
// renderShort — exact whole-string assertion
// ===========================================

describe("statusCommand — short mode exact output", () => {
	it("renders the exact zero-state summary string with no leading sentinel prefix", async () => {
		mockHealthCheck.mockResolvedValue({ serverReachable: true, authenticated: true });
		setReaders({
			sessions: [],
			stats: makeStats({ total_events: 0, pending_sync: 0 }),
		});

		await statusCommand({ short: true });

		expect(firstLog()).toBe("0 sessions, 0 events, mcp-server: ok");
	});
});
