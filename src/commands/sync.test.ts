import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked sync — behavioral coverage
// ===========================================
// Deep behavioral tests for `syncCommand`. Every module boundary that touches
// fs / network / state is mocked so each branch runs deterministically with no
// real I/O:
//   - ../lib/local-activity (getLocalStats / getUnsyncedEvents / readSyncState /
//     updateSyncState / appendSyncError) for the cursor + stats + error log
//   - ../lib/config (resolveConfig) for server_url / workspace_id / keys
//   - ../lib/auth (resolveAuthToken) for the Bearer-token gate
//   - ../lib/secrets (loadScrubConfig / scrubEgressPayload / recordScrub) for
//     the egress redaction accounting
//   - global fetch (ok / non-ok 401 / non-ok 5xx-retry / non-ok 4xx-fatal /
//     network throw / AbortError timeout)
// We deliberately do NOT mock ../lib/output or ../lib/formatter so the real
// renderer strings (the bulk of this module) are exercised and asserted.
// console.log / console.error capture the human + json output; process.stderr
// captures the per-batch failure lines; process.exitCode captures error paths.
// Fake timers drive the retry-backoff sleeps without wall-clock waits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ActivitySyncBasis,
	LocalActivityEvent,
	UnsyncedEvents,
} from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";
import { fmtTime } from "./sync-format.js";

// ---- ../lib/local-activity mock ---------------------------------------
const mockGetLocalStats = vi.fn<() => { pending_sync: number } & Record<string, unknown>>();
const mockGetUnsyncedEvents = vi.fn<
	(
		limit?: number,
		cwd?: string,
		range?: { startOffset?: number; endExclusive?: number },
	) => UnsyncedEvents
>();
const mockReadSyncState = vi.fn<() => {
	synced_through_bytes: number;
	last_sync_at: string;
	last_summary?: Record<string, unknown>;
}>();
const mockUpdateSyncState = vi.fn<(offset: number, summary?: unknown) => void>();
const mockAppendSyncError = vi.fn<(entry: Record<string, unknown>) => void>();
const mockCaptureActivitySyncBasis = vi.fn<(cursor: number) => ActivitySyncBasis>();
const mockCheckpointSyncState = vi.fn<
	(checkpoint: { nextCursor: number; summary?: unknown }) => void
>();

vi.mock("../lib/local-activity.js", () => ({
	assertActivitySyncCursor: (cursor: number, fileSize: number) => {
		if (cursor > fileSize) throw new Error("activity sync cursor basis changed");
	},
	captureActivitySyncBasis: (cursor: number) => mockCaptureActivitySyncBasis(cursor),
	checkpointSyncState: (checkpoint: { nextCursor: number; summary?: unknown }) =>
		mockCheckpointSyncState(checkpoint),
	getLocalStats: () => ({ file_size_bytes: Number.MAX_SAFE_INTEGER, ...mockGetLocalStats() }),
	getUnsyncedEvents: (
		limit?: number,
		cwd?: string,
		range?: { startOffset?: number; endExclusive?: number },
	) => mockGetUnsyncedEvents(limit, cwd, range),
	readSyncState: () => mockReadSyncState(),
	updateSyncState: (offset: number, summary?: unknown) => mockUpdateSyncState(offset, summary),
	appendSyncError: (entry: Record<string, unknown>) => mockAppendSyncError(entry),
}));

// ---- ../lib/config mock -----------------------------------------------
interface FakeConfig {
	server_url: string;
	workspace_id?: string;
	default_workspace_key?: string;
	default_project?: string;
	sync_mode: string;
}
const mockResolveConfig = vi.fn<() => FakeConfig>();
vi.mock("../lib/config.js", () => ({
	resolveConfig: () => mockResolveConfig(),
}));

// ---- ../lib/auth mock -------------------------------------------------
const mockResolveAuthToken = vi.fn<() => string | null>();
vi.mock("../lib/auth.js", () => ({
	resolveAuthToken: () => mockResolveAuthToken(),
}));

// ---- ../lib/secrets mock ----------------------------------------------
// scrubEgressPayload reports {found,types}; tests that want scrub accounting
// script mockScrubResult to a positive `found`.
let mockScrubResult: { found: number; types: string[] };
const mockLoadScrubConfig = vi.fn<() => Record<string, unknown>>();
const mockScrubEgressPayload = vi.fn<() => { found: number; types: string[] }>();
const mockRecordScrub = vi.fn<(types: string[]) => void>();
vi.mock("../lib/secrets.js", () => ({
	loadScrubConfig: () => mockLoadScrubConfig(),
	scrubEgressPayload: () => mockScrubEgressPayload(),
	recordScrub: (types: string[]) => mockRecordScrub(types),
}));

import { syncCommand } from "./sync.js";

// --- capture helpers ---------------------------------------------------

const SYNC_RESPONSE_BODY_LIMIT = 256 * 1024;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** Strip ANSI color codes so assertions hold regardless of color support. */
function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function stdout(): string {
	return plain((logSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("\n"));
}
function stderrConsole(): string {
	return plain((errSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("\n"));
}
function processStderr(): string {
	return plain((stderrSpy.mock.calls).map((a: unknown[]) => String(a[0])).join(""));
}
/** Parse the single JSON blob console.log emitted in --json mode. */
function jsonOut(): Record<string, unknown> {
	const raw = (logSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("\n");
	return parseWire(JSON.parse(raw), wireRecord(wireUnknown), "test JSON value");
}
/** The init object handed to the Nth fetch call. */
function fetchInit(n = 0): RequestInit {
	const fetchFn = vi.mocked(fetch);
	return nonNull(nonNull(fetchFn.mock.calls[n])[1]);
}

/** Build a LocalActivityEvent with sensible defaults; override per test. */
function ev(over: Partial<LocalActivityEvent> = {}): LocalActivityEvent {
	return {
		ts: "2026-06-01T10:00:00.000Z",
		agent: "alice",
		type: "tool_use",
		tool: "Read",
		session: "s1",
		...over,
	};
}

/** A fetch Response stub for the ok-with-json path. */
function okRes(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
/** A fetch Response stub for a non-ok status with a text body. */
function failRes(status: number, text = "boom"): Response {
	return new Response(text, { status });
}
/** A non-ok Response whose stream rejects while the body is read. */
function failResTextThrows(status: number): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("body read failed"));
		},
	});
	return new Response(body, { status });
}

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	process.exitCode = undefined;

	// Default happy-path scripting (overridden per test as needed).
	mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
	mockGetUnsyncedEvents.mockReturnValue({ events: [ev()], newOffset: 4096 });
	mockReadSyncState.mockReturnValue({ synced_through_bytes: 0, last_sync_at: "" });
	mockCaptureActivitySyncBasis.mockImplementation(() => ({
		identity: { dev: "test", ino: "activity" },
		endExclusive: Number.MAX_SAFE_INTEGER,
	}));
	mockCheckpointSyncState.mockImplementation((checkpoint) =>
		mockUpdateSyncState(checkpoint.nextCursor, checkpoint.summary),
	);
	mockResolveConfig.mockReturnValue({
		server_url: "https://api.example.com",
		workspace_id: "ws-123",
		default_workspace_key: "wkey",
		default_project: "proj",
		sync_mode: "realtime",
	});
	mockResolveAuthToken.mockReturnValue("tok-abc");
	mockLoadScrubConfig.mockReturnValue({});
	mockScrubResult = { found: 0, types: [] };
	mockScrubEgressPayload.mockImplementation(() => mockScrubResult);

	const okResponse = okRes({ accepted: 1, skipped: 0, errors: 0 });
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async () => okResponse),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	process.exitCode = undefined;
});

// =======================================================================
// Early-exit branches (no network)
// =======================================================================

describe("syncCommand — up-to-date short-circuits", () => {
	it("rejects an old-basis cursor beyond EOF instead of reporting up to date", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0, file_size_bytes: 10 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 11, last_sync_at: "x" });

		await syncCommand({ json: true });

		expect(JSON.parse(stderrConsole())).toMatchObject({
			error: expect.stringContaining("activity sync cursor basis changed"),
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(mockGetUnsyncedEvents).not.toHaveBeenCalled();
	});

	it("pending_sync === 0 prints 'Already up to date' and skips fetch (normal)", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		await syncCommand({});
		expect(stdout()).toContain("Already up to date.");
		expect(stdout()).toContain("No unsynced events.");
		expect(fetch).not.toHaveBeenCalled();
		expect(mockGetUnsyncedEvents).not.toHaveBeenCalled();
	});

	it("pending_sync === 0 emits the JSON up-to-date envelope (json mode)", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		await syncCommand({ json: true });
		expect(jsonOut()).toEqual({ synced: 0, pending: 0, message: "Already up to date" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("empty unsynced batch (pending>0 but 0 events) short-circuits to up-to-date", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [], newOffset: 100 });
		await syncCommand({});
		expect(stdout()).toContain("Already up to date.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("empty unsynced batch in JSON mode emits the up-to-date envelope", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [], newOffset: 100 });
		await syncCommand({ json: true });
		expect(jsonOut()).toEqual({ synced: 0, pending: 0, message: "Already up to date" });
	});

	it("formatUpToDate renders the rich last_summary block when present", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({
			synced_through_bytes: 8192,
			last_sync_at: "2026-06-01T12:00:00.000Z",
			last_summary: {
				server_url: "https://api.example.com",
				workspace_id: "ws-123",
				events_total: 7,
				accepted: 6,
				skipped: 1,
				scrubbed: 0,
				batches: 1,
				by_type: { tool_use: 5, session_end: 2 },
				by_agent: { alice: 4, bob: 3 },
				top_tools: [["Read", 3]],
				sessions: 1,
				time_range: {
					earliest: "2026-06-01T10:00:00.000Z",
					latest: "2026-06-01T11:00:00.000Z",
				},
			},
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Last sync:");
		expect(out).toContain("Server:    https://api.example.com");
		expect(out).toContain("Workspace: ws-123");
		// "1 session" singular (sessions === 1)
		expect(out).toContain("7 events (6 new, 1 dedup) across 1 session");
		expect(out).not.toContain("1 sessions");
		expect(out).toContain("Covering:");
		expect(out).toContain("Agents: alice, bob");
		// type summary, underscores spaced
		expect(out).toContain("5 tool use");
		expect(out).toContain("2 session end");
	});

	it("formatUpToDate pluralizes sessions and omits optional rows when absent", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({
			synced_through_bytes: 1,
			last_sync_at: "2026-06-01T12:00:00.000Z",
			last_summary: {
				server_url: "https://api.example.com",
				workspace_id: null, // no Workspace row
				events_total: 3,
				accepted: 3,
				skipped: 0,
				scrubbed: 0,
				batches: 1,
				by_type: {}, // no Events row
				by_agent: {}, // no Agents row
				top_tools: [],
				sessions: 2, // plural
				time_range: { earliest: "", latest: "" }, // no Covering row
			},
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("across 2 sessions");
		expect(out).not.toContain("Workspace:");
		expect(out).not.toContain("Covering:");
		expect(out).not.toContain("Agents:");
	});

	it("formatUpToDate omits the summary block when last_summary is absent", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 0 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 0, last_sync_at: "" });
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Already up to date.");
		expect(out).not.toContain("Last sync:");
	});
});

// =======================================================================
// Dry-run branch
// =======================================================================

describe("syncCommand — dry-run", () => {
	it("normal dry-run prints batch math and never calls fetch", async () => {
		// 250 events -> ceil(250/100) === 3 batches
		const events = Array.from({ length: 250 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 250 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 9999 });
		await syncCommand({ dryRun: true });
		const out = stdout();
		expect(out).toContain("Sync (dry-run)");
		expect(out).toContain("Pending events");
		expect(out).toContain("250");
		expect(out).toContain("Batches needed");
		expect(out).toContain("3");
		expect(out).toContain("New offset");
		expect(out).toContain("9999 bytes");
		expect(out).toContain("Run 'interlinked sync'");
		expect(fetch).not.toHaveBeenCalled();
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("json dry-run emits dry_run envelope with batches + sync_state", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [ev()], newOffset: 4096 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 42, last_sync_at: "x" });
		await syncCommand({ json: true, dryRun: true });
		const j = jsonOut();
		expect(j.dry_run).toBe(true);
		expect(j.pending_events).toBe(1);
		expect(j.batches).toBe(1);
		expect(j.sync_state).toEqual({ synced_through_bytes: 42, last_sync_at: "x" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("--limit bounds each dry-run page and preserves the frozen byte range", async () => {
		await syncCommand({ dryRun: true, limit: "50" });
		expect(mockGetUnsyncedEvents).toHaveBeenNthCalledWith(
			1,
			50,
			undefined,
			expect.objectContaining({ startOffset: 0 }),
		);
	});

	it("omitting --limit still caps each materialized page at BATCH_SIZE", async () => {
		await syncCommand({ dryRun: true });
		expect(mockGetUnsyncedEvents).toHaveBeenNthCalledWith(
			1,
			100,
			undefined,
			expect.objectContaining({ startOffset: 0 }),
		);
	});

	// test-contract: invariant — pending_sync > 0 means the outer up-to-date
	// short-circuit (line ~67) is skipped, but the basis capture can still
	// race the cursor to end up already at basis.endExclusive, so the preview
	// itself sees 0 events. Dry-run must report up to date from THIS second
	// check too, without ever paging through getUnsyncedEvents.
	it("dry-run whose preview lands on 0 events reports up to date (normal)", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 500, last_sync_at: "x" });
		mockCaptureActivitySyncBasis.mockReturnValue({
			identity: { dev: "test", ino: "activity" },
			endExclusive: 500,
		});
		await syncCommand({ dryRun: true });
		expect(stdout()).toContain("Already up to date.");
		expect(mockGetUnsyncedEvents).not.toHaveBeenCalled();
	});

	it("dry-run whose preview lands on 0 events emits the JSON up-to-date envelope", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 5 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 500, last_sync_at: "x" });
		mockCaptureActivitySyncBasis.mockReturnValue({
			identity: { dev: "test", ino: "activity" },
			endExclusive: 500,
		});
		await syncCommand({ json: true, dryRun: true });
		expect(jsonOut()).toEqual({ synced: 0, pending: 0, message: "Already up to date" });
		expect(mockGetUnsyncedEvents).not.toHaveBeenCalled();
	});
});

// =======================================================================
// Local-dev guard (workspace_id required)
// =======================================================================

describe("syncCommand — local-dev workspace guard", () => {
	it("localhost server without workspace_id errors out before fetch", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({});
		expect(stderrConsole()).toContain("workspace_id required for local dev sync");
		expect(process.exitCode).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("127.0.0.1 server without workspace_id also trips the guard (json error)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://127.0.0.1:8787",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({ json: true });
		const j = parseWire(JSON.parse(stderrConsole()), wireObject({ "error": wireString }), "test JSON value");
		expect(j.error).toContain("workspace_id required");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("localhost WITH workspace_id proceeds and omits the Bearer header (dev bypass)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "http://localhost:8787",
			workspace_id: "ws-local",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "local",
		});
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const headers = parseWire(fetchInit(0).headers, wireRecord(wireString), "test JSON value");
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("production with no token still sends (no Authorization header)", async () => {
		mockResolveAuthToken.mockReturnValue(null);
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const fetchFn = vi.mocked(fetch);
		const [url] = nonNull(fetchFn.mock.calls[0]);
		expect(url).toBe("https://api.example.com/api/hooks/activity/batch");
		const init = fetchInit(0);
		expect(init.method).toBe("POST");
		const headers = parseWire(init.headers, wireRecord(wireString), "test JSON value");
		expect(headers.Authorization).toBeUndefined();
	});
});

// =======================================================================
// Happy-path success: cursor advance, headers, body, summary breakdown
// =======================================================================

describe("syncCommand — successful sync", () => {
	it("does not report success when the generation-checked checkpoint is refused", async () => {
		mockCheckpointSyncState.mockImplementation(() => {
			throw new Error("activity sync cursor basis changed: activity log was replaced");
		});

		await syncCommand({ json: true });

		expect(JSON.parse(stderrConsole())).toMatchObject({
			error: expect.stringContaining("activity log was replaced"),
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("sends Bearer auth + workspace_uuid to prod and advances the cursor", async () => {
		await syncCommand({});
		expect(fetch).toHaveBeenCalledTimes(1);
		const fetchFn = vi.mocked(fetch);
		const url = (nonNull(fetchFn.mock.calls[0]))[0];
		const init = fetchInit(0);
		expect(url).toBe("https://api.example.com/api/hooks/activity/batch");
		expect(init.method).toBe("POST");
		const headers = parseWire(init.headers, wireRecord(wireString), "test JSON value");
		expect(headers.Authorization).toBe("Bearer tok-abc");
		const body = parseWire(JSON.parse(parseWire(init.body, wireString, "fetch request body")), wireRecord(wireUnknown), "test JSON value");
		expect(body.workspace_key).toBe("wkey");
		expect(body.project_key).toBe("proj");
		expect(body.workspace_uuid).toBe("ws-123");
		expect(Array.isArray(body.events)).toBe(true);
		// cursor advanced to newOffset with a summary object
		expect(mockUpdateSyncState).toHaveBeenCalledTimes(1);
		expect(mockUpdateSyncState).toHaveBeenCalledWith(4096, expect.any(Object));
	});

	it("omits workspace_uuid from the body when no workspace_id is set", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({});
		const body = parseWire(JSON.parse(parseWire(fetchInit(0).body, wireString, "fetch request body")), wireRecord(wireUnknown), "test JSON value");
		expect(body).not.toHaveProperty("workspace_uuid");
		// workspace_id is null in the summary path
		expect(mockUpdateSyncState).toHaveBeenCalledWith(
			4096,
			expect.objectContaining({ workspace_id: null }),
		);
	});

	it("renders the full Sync Complete breakdown (types/agents/tools/sessions/time)", async () => {
		const events: LocalActivityEvent[] = [
			ev({ type: "tool_use", tool: "Read", agent: "alice", session: "s1", ts: "2026-06-01T10:00:00.000Z" }),
			ev({ type: "tool_use", tool: "Read", agent: "alice", session: "s1", ts: "2026-06-01T10:05:00.000Z" }),
			ev({ type: "tool_use", tool: "Edit", agent: "bob", session: "s2", ts: "2026-06-01T09:00:00.000Z" }),
			ev({ type: "session_end", tool: null, agent: "alice", session: "s1", ts: "2026-06-01T11:00:00.000Z" }),
			// an "unknown" agent must be excluded from the agent breakdown
			ev({ type: "tool_use", tool: "Bash", agent: "unknown", session: "s3", ts: "2026-06-01T10:30:00.000Z" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: events.length });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 5, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Sync Complete");
		expect(out).toContain("Server");
		expect(out).toContain("https://api.example.com");
		expect(out).toContain("Workspace");
		expect(out).toContain("ws-123");
		expect(out).toContain("5 total (5 new, 0 dedup)");
		expect(out).toContain("Batches");
		// Time range present (earliest 09:00 -> latest 11:00)
		expect(out).toContain("Time Range");
		// Event types section, descending; underscores spaced
		expect(out).toContain("Event Types");
		expect(out).toContain("tool use");
		expect(out).toContain("session end");
		// Agents: alice(2 tool_use + 1 session_end = 3), bob(1); "unknown" excluded
		expect(out).toContain("Agents");
		expect(out).toContain("alice");
		expect(out).toContain("bob");
		expect(out).not.toMatch(/\bunknown\b/);
		// Top Tools section
		expect(out).toContain("Top Tools");
		expect(out).toContain("Read");
		expect(out).toContain("Edit");
		expect(out).toContain("Bash");
		// Sessions count (s1,s2,s3 => 3)
		expect(out).toContain("Sessions");
	});

	it("'... +N more' tool overflow line appears past the top-5", async () => {
		// 7 distinct tools, descending counts so top-5 leaves 2 others
		const tools = ["A", "B", "C", "D", "E", "F", "G"];
		const events: LocalActivityEvent[] = [];
		tools.forEach((t, idx) => {
			const count = tools.length - idx; // 7,6,5,4,3,2,1
			for (let i = 0; i < count; i++) {
				events.push(ev({ tool: t, session: `s${t}${i}` }));
			}
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: events.length });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 7000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: events.length, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		expect(stdout()).toContain("... +2 more");
	});

	it("omits Time Range / Sessions sections when events carry neither ts-pair nor sessions", async () => {
		// events with empty ts and no session -> earliest/latest stay "", sessions empty
		mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ ts: "", session: null, tool: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const out = stdout();
		expect(out).toContain("Sync Complete");
		expect(out).not.toContain("Time Range");
		// No Top Tools (tool null), no Sessions row
		expect(out).not.toContain("Top Tools");
		expect(out).not.toContain("Sessions");
	});

	it("JSON success envelope carries totals, breakdown, new_offset === newOffset", async () => {
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 1, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.server_url).toBe("https://api.example.com");
		expect(j.workspace_id).toBe("ws-123");
		expect(j.accepted).toBe(1);
		expect(j.skipped).toBe(0);
		expect(j.errors).toBe(0);
		expect(j.batches_sent).toBe(1);
		expect(j.retries).toBe(0);
		expect(j.new_offset).toBe(4096);
		const breakdown = parseWire(j.breakdown, wireRecord(wireUnknown), "test JSON value");
		expect(breakdown.sessions).toBe(1);
	});

	it("accumulates accepted/skipped across multiple batches", async () => {
		const events = Array.from({ length: 150 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 150 });
		mockGetUnsyncedEvents
			.mockReturnValueOnce({ events: events.slice(0, 100), newOffset: 5000 })
			.mockReturnValueOnce({ events: events.slice(100), newOffset: 8000 })
			.mockReturnValue({ events: [], newOffset: 8000 });
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(okRes({ accepted: 100, skipped: 0, errors: 0 }))
			.mockResolvedValueOnce(okRes({ accepted: 40, skipped: 10, errors: 0 }));
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(j.accepted).toBe(140);
		expect(j.skipped).toBe(10);
		expect(j.batches_sent).toBe(2);
		expect(mockUpdateSyncState).toHaveBeenNthCalledWith(1, 5000, expect.any(Object));
		expect(mockUpdateSyncState).toHaveBeenNthCalledWith(2, 8000, expect.any(Object));
	});

	it("an empty success receipt fails closed without advancing the cursor", async () => {
		(vi.mocked(fetch)).mockResolvedValue(okRes({}));
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.accepted).toBe(0);
		expect(j.skipped).toBe(0);
		expect(j.errors).toBe(1);
		expect(j.batches_sent).toBe(0);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_receipt", transient: false }),
		);
	});

	it("JSON success with no workspace_id reports workspace_id: null (|| null arm)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 1, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.workspace_id).toBeNull();
	});
});

// =======================================================================
// Per-event payload mapping: optional-field inclusion
// =======================================================================

describe("syncCommand — payload field mapping", () => {
	function sentEvent(): Record<string, unknown> {
		const body = parseWire(JSON.parse(parseWire(fetchInit(0).body, wireString, "fetch request body")), wireObject({ "events": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		return nonNull(body.events[0]);
	}

	it("maps required fields with || fallbacks (agent/workspace/project)", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ agent: "", workspace_key: null, project_key: null, tool: null, summary: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.agent_name).toBe("unknown");
		expect(e.workspace_key).toBe("wkey"); // defaultWorkspaceKey
		expect(e.project_key).toBe("proj"); // defaultProjectKey
		expect(e.event_type).toBe("tool_use");
		expect(e.tool_name).toBeUndefined();
		expect(e.tool_input_summary).toBeUndefined();
	});

	it("includes the full set of v2/v3/v4 optional fields when present", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [
				ev({
					duration_ms: 12,
					tokens: { input: 5, output: 6, cache_read: 7, cache_creation: 8 },
					parent_agent: "root",
					subagent_id: "sub-1",
					files_modified: ["a.ts"],
					hook: "PostToolUse",
					error: { code: "E" },
					tool_input: { x: 1 },
					tool_response: { y: 2 },
					prompt: "p",
					last_assistant_message: "lam",
					cwd: "/tmp",
					model: "claude",
					source: "cli",
					agent_type: "main",
					tool_use_id: "tu1",
					is_interrupt: false,
					notification_type: "nt",
					notification_title: "ntt",
					task_subject: "ts",
					task_id: "tid",
					task_description: "td",
					trigger: "trg",
					reason: "rsn",
					permission_mode: "pm",
					transcript_path: "/t",
					teammate_name: "tm",
					team_name: "team",
					custom_instructions: "ci",
					stop_hook_active: true,
					permission_suggestions: ["s"],
					agent_transcript_path: "/at",
				}),
			],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.duration_ms).toBe(12);
		expect(e.tokens_input).toBe(5);
		expect(e.tokens_output).toBe(6);
		expect(e.tokens_cache_read).toBe(7);
		expect(e.tokens_cache_creation).toBe(8);
		expect(e.parent_agent).toBe("root");
		expect(e.subagent_id).toBe("sub-1");
		expect(e.files_modified).toEqual(["a.ts"]);
		expect(e.hook_event).toBe("PostToolUse");
		// object error -> JSON.stringify, mirrored to message + detail
		expect(e.error_message).toBe('{"code":"E"}');
		expect(e.error_detail).toBe('{"code":"E"}');
		// object tool_input/response -> JSON.stringify
		expect(e.tool_input_json).toBe('{"x":1}');
		expect(e.tool_response_json).toBe('{"y":2}');
		expect(e.prompt).toBe("p");
		expect(e.last_assistant_message).toBe("lam");
		expect(e.cwd).toBe("/tmp");
		expect(e.model).toBe("claude");
		expect(e.source).toBe("cli");
		expect(e.agent_type_hook).toBe("main");
		expect(e.tool_use_id).toBe("tu1");
		expect(e.is_interrupt).toBe(false); // included because !== undefined
		expect(e.notification_type).toBe("nt");
		expect(e.notification_title).toBe("ntt");
		expect(e.task_subject).toBe("ts");
		expect(e.task_id_hook).toBe("tid");
		expect(e.task_description_hook).toBe("td");
		expect(e.trigger).toBe("trg");
		expect(e.reason).toBe("rsn");
		expect(e.permission_mode).toBe("pm");
		expect(e.transcript_path).toBe("/t");
		expect(e.teammate_name).toBe("tm");
		expect(e.team_name).toBe("team");
		expect(e.custom_instructions).toBe("ci");
		expect(e.stop_hook_active).toBe(true);
		expect(e.permission_suggestions).toBe('["s"]');
		expect(e.agent_transcript_path).toBe("/at");
	});

	it("string error / tool_input / tool_response pass through without JSON.stringify; session maps", async () => {
		mockGetUnsyncedEvents.mockReturnValue({
			events: [
				ev({
					error: "plain error",
					tool_input: "raw-input",
					tool_response: "raw-response",
					permission_suggestions: "already-string",
					session: "sess-9",
				}),
			],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.error_message).toBe("plain error");
		expect(e.error_detail).toBe("plain error");
		expect(e.tool_input_json).toBe("raw-input");
		expect(e.tool_response_json).toBe("raw-response");
		expect(e.permission_suggestions).toBe("already-string");
		expect(e.session_id).toBe("sess-9");
	});

	it("config defaults fall back to 'main' when keys are absent", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			workspace_id: "ws-123",
			sync_mode: "realtime",
		});
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ workspace_key: null, project_key: null })],
			newOffset: 1,
		});
		await syncCommand({});
		const e = sentEvent();
		expect(e.workspace_key).toBe("main");
		expect(e.project_key).toBe("main");
	});
});

// =======================================================================
// Scrubbing accounting
// =======================================================================

describe("syncCommand — egress scrubbing", () => {
	it("counts scrubbed secrets, records types, and surfaces the Scrubbed row", async () => {
		mockScrubResult = { found: 3, types: ["aws_key", "email"] };
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev(), ev({ session: "s2" })],
			newOffset: 100,
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		await syncCommand({});
		// scrub called once per event (2), each reporting found:3 -> total 6
		expect(mockScrubEgressPayload).toHaveBeenCalledTimes(2);
		expect(mockRecordScrub).toHaveBeenCalledWith(["aws_key", "email"]);
		expect(stdout()).toContain("Scrubbed");
		expect(stdout()).toContain("6 events had secrets redacted");
	});

	it("no Scrubbed row when nothing was redacted (found === 0)", async () => {
		mockScrubResult = { found: 0, types: [] };
		await syncCommand({});
		expect(mockRecordScrub).not.toHaveBeenCalled();
		expect(stdout()).not.toContain("Scrubbed");
	});
});

// =======================================================================
// Request timeout / AbortController wiring
// =======================================================================

describe("syncCommand — request timeout wiring", () => {
	it("aborts the fetch AbortSignal after BATCH_SYNC_REQUEST_TIMEOUT_MS (10s) elapses", async () => {
		vi.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {}); // never resolves; we only observe the signal
		});
		vi.stubGlobal("fetch", fetchFn);
		void syncCommand({ json: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(capturedSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(9999);
		expect(capturedSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("clears the abort timeout after a successful response (.finally is not a no-op)", async () => {
		vi.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
			capturedSignal = init?.signal ?? undefined;
			return Promise.resolve(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		});
		vi.stubGlobal("fetch", fetchFn);
		await syncCommand({ json: true });
		// The response already resolved; if clearTimeout wasn't actually called
		// in .finally, the 10s abort timer is still live and will later flip
		// the (already-irrelevant, but observable) signal to aborted.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(capturedSignal?.aborted).toBe(false);
	});

	it("keeps the timeout active while an endless body is read after headers", async () => {
		vi.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		const fetchFn = vi.fn<typeof fetch>();
		fetchFn.mockImplementationOnce(async (_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					capturedSignal?.addEventListener("abort", () => {
						controller.error(new DOMException("request timed out", "AbortError"));
					});
				},
			});
			return new Response(body, { status: 200 });
		});
		fetchFn.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		vi.stubGlobal("fetch", fetchFn);

		const run = syncCommand({ json: true });
		await vi.advanceTimersByTimeAsync(9999);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(capturedSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(capturedSignal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		await run;

		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(jsonOut()).toMatchObject({ accepted: 1, errors: 0, retries: 1 });
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_timeout", transient: true }),
		);
	});
});

describe("syncCommand — bounded response bodies", () => {
	it("accepts an exact-limit success receipt", async () => {
		const receipt = JSON.stringify({ accepted: 1, skipped: 0, errors: 0 });
		const exactLimitBody = receipt + " ".repeat(SYNC_RESPONSE_BODY_LIMIT - receipt.length);
		(vi.mocked(fetch)).mockResolvedValue(
			new Response(exactLimitBody, { status: 200 }),
		);

		await syncCommand({ json: true });

		expect(jsonOut()).toMatchObject({ accepted: 1, errors: 0, batches_sent: 1 });
		expect(mockUpdateSyncState).toHaveBeenCalledWith(4096, expect.any(Object));
	});

	it("cancels an oversized streamed success body and preserves the cursor", async () => {
		let pulls = 0;
		let cancelled = false;
		const block = new Uint8Array(128 * 1024).fill(97);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(block);
			},
			cancel() {
				cancelled = true;
			},
		});
		(vi.mocked(fetch)).mockResolvedValue(
			new Response(body, { status: 200 }),
		);

		await syncCommand({ json: true });

		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(4);
		expect(jsonOut()).toMatchObject({ accepted: 0, errors: 1, batches_sent: 0 });
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_receipt",
				message: expect.stringContaining(`exceeded ${SYNC_RESPONSE_BODY_LIMIT} bytes`),
			}),
		);
	});

	it("rejects an oversized error body from Content-Length without buffering it", async () => {
		(vi.mocked(fetch)).mockResolvedValue(
			new Response("server-controlled detail", {
				status: 400,
				headers: { "content-length": String(SYNC_RESPONSE_BODY_LIMIT + 1) },
			}),
		);

		await syncCommand({});

		expect(processStderr()).toContain(`response body exceeded ${SYNC_RESPONSE_BODY_LIMIT} bytes`);
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_http",
				status: 400,
				message: expect.stringContaining(`exceeded ${SYNC_RESPONSE_BODY_LIMIT} bytes`),
			}),
		);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});
});

describe("syncCommand — bounded cumulative summary", () => {
	const uniqueEvents = 300;

	function scriptUniqueRun(): void {
		mockGetLocalStats.mockReturnValue({ pending_sync: uniqueEvents });
		mockCaptureActivitySyncBasis.mockReturnValue({
			identity: { dev: "test", ino: "activity" },
			endExclusive: uniqueEvents,
		});
		mockGetUnsyncedEvents.mockImplementation((limit, _cwd, range) => {
			const start = range?.startOffset ?? 0;
			const count = Math.min(limit ?? 100, uniqueEvents - start);
			const events = Array.from({ length: count }, (_, offset) => {
				const id = start + offset;
				return ev({
					type: `type-${id}`,
					agent: `agent-${id}`,
					tool: `tool-${id}`,
					session: `session-${id}`,
				});
			});
			return { events, newOffset: start + count };
		});
		// SAFETY: beforeEach installs fetch as a Vitest mock for every test.
		const fetchFn = vi.mocked(fetch);
		fetchFn.mockImplementation(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				// SAFETY: sync serializes this request body from buildBatchBody immediately before fetch.
				const sent = parseWire(JSON.parse(String(init?.body)), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
				return okRes({ accepted: sent.events.length, skipped: 0, errors: 0 });
			},
		);
	}

	it("marks an ordinary bounded summary complete", async () => {
		await syncCommand({ json: true });

		const result = jsonOut();
		expect(result.breakdown_complete).toBe(true);
		expect(result.summary_truncated).toBeNull();
	});

	it("retains bounded keys across many pages while preserving totals and cursor", async () => {
		scriptUniqueRun();

		await syncCommand({ json: true });

		const result = jsonOut();
		// SAFETY: the sync JSON contract always emits breakdown as an object.
		const breakdown = parseWire(result.breakdown, wireRecord(wireUnknown), "test JSON value");
		// SAFETY: breakdown.by_type is the serialized bounded count dictionary.
		const byType = parseWire(breakdown.by_type, wireRecord(wireNumber), "test JSON value");
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(result.accepted).toBe(uniqueEvents);
		expect(Object.keys(byType)).toHaveLength(256);
		expect(breakdown.sessions).toBe(256);
		expect(mockUpdateSyncState).toHaveBeenLastCalledWith(uniqueEvents, undefined);
	});

	it("reports omitted occurrences rather than presenting the bounded summary as exact", async () => {
		scriptUniqueRun();

		await syncCommand({ json: true });

		const result = jsonOut();
		expect(result.breakdown_complete).toBe(false);
		expect(result.summary_truncated).toEqual({
			exact: false,
			retained_key_limit: 256,
			omitted_occurrences: { by_type: 44, by_agent: 44, by_tool: 44, sessions: 44 },
		});
	});

	it("labels retained counts and omissions in normal output", async () => {
		scriptUniqueRun();

		await syncCommand({});

		expect(stdout()).toContain("Sessions (retained)");
		expect(stdout()).toContain("Summary");
		expect(stdout()).toContain("partial (bounded memory)");
		expect(stdout()).toContain(
			"Omitted occurrences — event types: 44, agents: 44, tools: 44, sessions: 44",
		);
	});

	it("omits overlong summary keys with explicit accounting", async () => {
		const longKey = "x".repeat(513);
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev({ type: longKey, agent: longKey, tool: longKey, session: longKey })],
			newOffset: 4096,
		});

		await syncCommand({ json: true });

		const result = jsonOut();
		// SAFETY: the sync JSON contract always emits breakdown as an object.
		const breakdown = parseWire(result.breakdown, wireRecord(wireUnknown), "test JSON value");
		expect(breakdown).toMatchObject({ by_type: {}, by_agent: {}, top_tools: [], sessions: 0 });
		expect(result.summary_truncated).toMatchObject({
			omitted_occurrences: { by_type: 1, by_agent: 1, by_tool: 1, sessions: 1 },
		});
	});
});

// =======================================================================
// HTTP error branches
// =======================================================================

describe("syncCommand — 401 auth failure", () => {
	it("logs a sync error, prints re-auth guidance, and aborts (normal)", async () => {
		(vi.mocked(fetch)).mockResolvedValue(failRes(401, "nope"));
		await syncCommand({});
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_auth",
				status: 401,
				transient: false,
				message: "Authentication failed (401) during sync",
			}),
		);
		expect(stderrConsole()).toContain("Authentication failed");
		expect(stderrConsole()).toContain("interlinked login");
		expect(process.exitCode).toBe(1);
		// 401 returns before cursor advance
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("401 in JSON mode emits a structured error envelope", async () => {
		(vi.mocked(fetch)).mockResolvedValue(failRes(401));
		await syncCommand({ json: true });
		const j = parseWire(JSON.parse(stderrConsole()), wireObject({ "error": wireString }), "test JSON value");
		expect(j.error).toContain("Authentication failed");
	});
});

describe("syncCommand — fatal (non-transient) HTTP error", () => {
	it("400 is logged once, counts batch.length as errors, no cursor advance (json)", async () => {
		(vi.mocked(fetch)).mockResolvedValue(failRes(400, "bad payload"));
		mockGetUnsyncedEvents.mockReturnValue({
			events: [ev(), ev({ session: "s2" })],
			newOffset: 100,
		});
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockReadSyncState.mockReturnValue({ synced_through_bytes: 77, last_sync_at: "x" });
		await syncCommand({ json: true });
		// transient=false -> single appendSyncError at manual_sync_http
		expect(mockAppendSyncError).toHaveBeenCalledTimes(1);
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_http", status: 400, transient: false }),
		);
		const j = jsonOut();
		expect(j.errors).toBe(2); // batch.length
		expect(j.batches_sent).toBe(0);
		// cursor NOT advanced; new_offset falls back to readSyncState().synced_through_bytes
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		expect(j.new_offset).toBe(77);
		// json mode -> the per-batch failure line must NOT go to process.stderr
		expect(processStderr()).toBe("");
	});

	it("400 in normal mode writes the dim per-batch failure line to process.stderr", async () => {
		(vi.mocked(fetch)).mockResolvedValue(failRes(400, "bad payload"));
		await syncCommand({});
		expect(processStderr()).toContain("Batch 1 failed (400)");
		expect(processStderr()).toContain("bad payload");
		// errors>0 -> the failed page remains pending for the next run
		expect(stdout()).toContain("Failed batch remains pending");
		expect(stdout()).toContain("Errors");
		expect(stdout()).not.toContain("Stryker was here");
	});

	it("truncates a long error body to 100 chars in the process.stderr failure line", async () => {
		const longBody = "y".repeat(300);
		(vi.mocked(fetch)).mockResolvedValue(failRes(400, longBody));
		await syncCommand({});
		expect(processStderr()).toContain(`Batch 1 failed (400): ${"y".repeat(100)}\n`);
		expect(processStderr()).not.toContain("y".repeat(101));
	});

	it("reports a bounded read failure when a non-success body stream rejects", async () => {
		(vi.mocked(fetch)).mockResolvedValue(failResTextThrows(400));
		await syncCommand({});
		expect(processStderr()).toContain(
			"Batch 1 failed (400): [response body could not be read: body read failed]",
		);
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_http",
				status: 400,
				message:
					"Batch 1 failed with status 400: [response body could not be read: body read failed]",
			}),
		);
	});

	it("truncates a long error body to 200 chars in the appendSyncError message", async () => {
		const longBody = "x".repeat(300);
		(vi.mocked(fetch)).mockResolvedValue(failRes(400, longBody));
		await syncCommand({});
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_http",
				status: 400,
				message: `Batch 1 failed with status 400: ${"x".repeat(200)}`,
			}),
		);
	});
});

describe("syncCommand — transient HTTP error then retry", () => {
	it("503 retries with backoff then succeeds; retries counted", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		// transient logged on the failed attempt
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_http", status: 503, transient: true }),
		);
		const j = jsonOut();
		expect(j.accepted).toBe(1);
		expect(j.batches_sent).toBe(1);
		// one transient retry (retriesUsed++ on continue) + attempt>1 success bump
		expect(j.retries).toBeGreaterThanOrEqual(1);
		expect(j.errors).toBe(0);
		expect(mockUpdateSyncState).toHaveBeenCalled();
	});

	it("actually waits for the backoff timer before retrying (sleep() is not a no-op)", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		// Flush microtasks without advancing fake-timer clock time: if sleep()
		// doesn't actually schedule via setTimeout (e.g. resolves synchronously
		// or is a no-op), the retry fetch would already have fired here.
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Now advance past the real backoff window and let the retry complete.
		await vi.advanceTimersByTimeAsync(1000);
		await p;
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [retryUrl] = nonNull(fetchFn.mock.calls[1]);
		expect(retryUrl).toBe("https://api.example.com/api/hooks/activity/batch");
	});

	it("uses RETRY_BACKOFF_MS[attempt-1] exactly: 250ms before retry 1, 750ms before retry 2", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable")) // attempt 1 -> retry after 250ms
			.mockResolvedValueOnce(failRes(503, "unavailable")) // attempt 2 -> retry after 750ms
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 })); // attempt 3 -> success
		const p = syncCommand({ json: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Just under the 250ms backoff for attempt 1: no retry yet.
		await vi.advanceTimersByTimeAsync(249);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Cross the 250ms threshold: retry 1 fires.
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		// Just under the 750ms backoff for attempt 2: no retry yet.
		await vi.advanceTimersByTimeAsync(749);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		// Cross the 750ms threshold: retry 2 fires and succeeds.
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(fetchFn).toHaveBeenCalledTimes(3);
		const [finalUrl] = nonNull(fetchFn.mock.calls[2]);
		expect(finalUrl).toBe("https://api.example.com/api/hooks/activity/batch");
	});

	it("429 exhausts all retries then counts the batch as failed", async () => {
		vi.useFakeTimers();
		(vi.mocked(fetch)).mockResolvedValue(failRes(429, "slow down"));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		// 3 attempts each append an error (transient true)
		expect(mockAppendSyncError).toHaveBeenCalledTimes(3);
		const j = jsonOut();
		expect(j.errors).toBe(1); // batch.length === 1
		expect(j.batches_sent).toBe(0);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		// only attempts 1 and 2 satisfy `attempt < MAX_BATCH_RETRIES` (3) and
		// bump retriesUsed; the terminal attempt 3 does not retry.
		expect(j.retries).toBe(2);
	});
});

describe("syncCommand — network throw / timeout", () => {
	it("network-error retries use RETRY_BACKOFF_MS[attempt-1] exactly: 250ms then 750ms", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockRejectedValueOnce(new Error("ECONNRESET")) // attempt 1 -> retry after 250ms
			.mockRejectedValueOnce(new Error("ECONNRESET")) // attempt 2 -> retry after 750ms
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 })); // attempt 3
		const p = syncCommand({ json: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(249);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(749);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(fetchFn).toHaveBeenCalledTimes(3);
		const [finalUrl] = nonNull(fetchFn.mock.calls[2]);
		expect(finalUrl).toBe("https://api.example.com/api/hooks/activity/batch");
	});

	it("retries on a network error then exhausts and counts the batch failed", async () => {
		vi.useFakeTimers();
		(vi.mocked(fetch)).mockRejectedValue(new Error("ECONNRESET"));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "manual_sync_network",
				message: "ECONNRESET",
				transient: true,
			}),
		);
		expect(mockAppendSyncError).toHaveBeenCalledTimes(3);
		const j = jsonOut();
		expect(j.errors).toBe(1);
		expect(j.batches_sent).toBe(0);
	});

	it("counts exactly 2 retries (retriesUsed++, not --) across two network errors then success", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		const j = jsonOut();
		// Exactly two retry attempts were scheduled; eventual success does not
		// count either retry a second time.
		expect(j.retries).toBe(2);
		expect(j.accepted).toBe(1);
	});

	it("AbortError (timeout) logs manual_sync_timeout and writes the timeout stderr line", async () => {
		vi.useFakeTimers();
		const abortErr = new Error("aborted");
		abortErr.name = "AbortError";
		(vi.mocked(fetch)).mockRejectedValue(abortErr);
		const p = syncCommand({});
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_timeout", transient: true }),
		);
		expect(processStderr()).toContain("Batch timed out (10s)");
	});

	it("non-timeout network error exhausted in normal mode does NOT write 'Batch timed out'", async () => {
		vi.useFakeTimers();
		(vi.mocked(fetch)).mockRejectedValue(new Error("ECONNRESET"));
		const p = syncCommand({});
		await vi.runAllTimersAsync();
		await p;
		expect(processStderr()).not.toContain("Batch timed out");
	});

	it("AbortError (timeout) exhausted in JSON mode writes nothing to process.stderr", async () => {
		vi.useFakeTimers();
		const abortErr = new Error("aborted");
		abortErr.name = "AbortError";
		(vi.mocked(fetch)).mockRejectedValue(abortErr);
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(processStderr()).toBe("");
	});

	it("non-Error thrown value is stringified into the sync-error message", async () => {
		vi.useFakeTimers();
		(vi.mocked(fetch)).mockRejectedValue("string-failure");
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_network", message: "string-failure" }),
		);
	});
});

// =======================================================================
// Top-level catch
// =======================================================================

// =======================================================================
// Mutation-driven hardening: loop boundary, batch slicing, batch numbering,
// time_range payload, sort ordering, status-code boundary, null-json
// response body, and exact retry/error accounting.
// =======================================================================

describe("syncCommand — batch loop boundary and slicing", () => {
	it("an exact-multiple event count sends exactly one batch (no trailing empty batch)", async () => {
		// events.length === BATCH_SIZE exactly: `i < events.length` must stop the
		// loop after i=0; `i <= events.length` would run a second, empty-batch
		// iteration (i=100), producing a second fetch call.
		const events = Array.from({ length: 100 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 100 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 100, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		expect(fetch).toHaveBeenCalledTimes(1);
		const j = jsonOut();
		expect(j.batches_sent).toBe(1);
	});

	it("splits into correctly-sized batches (100 then 50), not the whole array twice", async () => {
		const events = Array.from({ length: 150 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 150 });
		mockGetUnsyncedEvents
			.mockReturnValueOnce({ events: events.slice(0, 100), newOffset: 5000 })
			.mockReturnValueOnce({ events: events.slice(100), newOffset: 8000 })
			.mockReturnValue({ events: [], newOffset: 8000 });
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(okRes({ accepted: 100, skipped: 0, errors: 0 }))
			.mockResolvedValueOnce(okRes({ accepted: 50, skipped: 0, errors: 0 }));
		await syncCommand({ json: true });
		const body0 = parseWire(JSON.parse(parseWire(fetchInit(0).body, wireString, "fetch request body")), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		const body1 = parseWire(JSON.parse(parseWire(fetchInit(1).body, wireString, "fetch request body")), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(body0.events.length).toBe(100);
		expect(body1.events.length).toBe(50);
	});

	it("uses 1-based sequential batch numbers in failure reporting (Math.floor(i/BATCH_SIZE)+1)", async () => {
		const events = Array.from({ length: 150 }, (_, i) => ev({ session: `s${i}` }));
		mockGetLocalStats.mockReturnValue({ pending_sync: 150 });
		mockGetUnsyncedEvents
			.mockReturnValueOnce({ events: events.slice(0, 100), newOffset: 5000 })
			.mockReturnValueOnce({ events: events.slice(100), newOffset: 8000 });
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(okRes({ accepted: 100, skipped: 0, errors: 0 }))
			.mockResolvedValueOnce(failRes(400, "bad"));
		await syncCommand({});
		expect(processStderr()).toContain("Batch 2 failed (400)");
		expect(mockUpdateSyncState).toHaveBeenCalledTimes(1);
		expect(mockUpdateSyncState).toHaveBeenCalledWith(5000, expect.any(Object));
	});
});

describe("syncCommand — dry-run exact rendering", () => {
	it("dry-run output never leaks mutation-testing placeholder text, and lines are newline-joined", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 1 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [ev()], newOffset: 4096 });
		await syncCommand({ dryRun: true });
		const out = stdout();
		expect(out).not.toContain("Stryker was here");
		// lines.join("\n") must actually separate the header/body/footer lines
		expect(out.split("\n").length).toBeGreaterThan(3);
	});
});

describe("syncCommand — success output exact rendering", () => {
	it("normal success output never leaks mutation-testing placeholder text", async () => {
		await syncCommand({});
		expect(stdout()).not.toContain("Stryker was here");
	});

	it("omits the Workspace row entirely when workspaceId is falsy (not just body field)", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://api.example.com",
			default_workspace_key: "wkey",
			default_project: "proj",
			sync_mode: "realtime",
		});
		await syncCommand({});
		expect(stdout()).not.toContain("Workspace");
	});

	it("labels the events row with the literal 'Events' key", async () => {
		await syncCommand({});
		expect(stdout()).toContain("Events");
	});

	it("newline-joins the success output lines (lines.join('\\n'), not '')", async () => {
		await syncCommand({});
		expect(stdout().split("\n").length).toBeGreaterThan(3);
	});

	it("omits the Errors row when totalErrors === 0 (not a forced-true/>=0 mutant)", async () => {
		await syncCommand({});
		expect(stdout()).not.toContain("Errors");
	});

	it("omits the Retries row when retriesUsed === 0 (not a forced-true/>=0 mutant)", async () => {
		await syncCommand({});
		expect(stdout()).not.toContain("Retries");
	});

	it("shows the Retries row with the exact count when retriesUsed > 0 (normal mode)", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({});
		await vi.runAllTimersAsync();
		await p;
		const out = stdout();
		const retriesLine = out.split("\n").find((line) => line.includes("Retries"));
		expect(retriesLine).toContain("1");
	});

	it("renders the actual formatted earliest/latest timestamps on the Time Range line", async () => {
		const events: LocalActivityEvent[] = [
			ev({ ts: "2026-06-01T09:00:00.000Z", session: "s1" }),
			ev({ ts: "2026-06-01T11:00:00.000Z", session: "s2" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 2, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		const out = stdout();
		const expectedLine = `${fmtTime("2026-06-01T09:00:00.000Z")} → ${fmtTime("2026-06-01T11:00:00.000Z")}`;
		expect(out).toContain(expectedLine);
	});
});

describe("syncCommand — Cursor-not-advanced advisory gating", () => {
	it("omits the 'Cursor not advanced' advisory when totalErrors === 0", async () => {
		await syncCommand({});
		expect(stdout()).not.toContain("Cursor not advanced due to errors");
	});
});

describe("syncCommand — time_range payload fidelity", () => {
	it("persists the real earliest/latest timestamps into the saved sync-state summary", async () => {
		const events: LocalActivityEvent[] = [
			ev({ ts: "2026-06-01T09:00:00.000Z", session: "s1" }),
			ev({ ts: "2026-06-01T11:00:00.000Z", session: "s2" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 2, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		expect(mockUpdateSyncState).toHaveBeenCalledWith(
			5000,
			expect.objectContaining({
				time_range: {
					earliest: "2026-06-01T09:00:00.000Z",
					latest: "2026-06-01T11:00:00.000Z",
				},
			}),
		);
	});

	it("carries the real earliest/latest timestamps into the JSON success envelope", async () => {
		const events: LocalActivityEvent[] = [
			ev({ ts: "2026-06-01T09:00:00.000Z", session: "s1" }),
			ev({ ts: "2026-06-01T11:00:00.000Z", session: "s2" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 2, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.time_range).toEqual({
			earliest: "2026-06-01T09:00:00.000Z",
			latest: "2026-06-01T11:00:00.000Z",
		});
	});

	it("omits the Time Range section when earliest and latest disagree on truthiness (&&, not ||)", async () => {
		// Event order matters: a non-empty ts followed by an empty ts drives
		// earliest to "" while latest stays non-empty (see buildBatchSummary's
		// `!earliest || e.ts < earliest` — "" sorts below everything). This
		// distinguishes `earliest && latest` from a `||` mutant, which the
		// all-empty / all-present fixtures elsewhere in this file cannot.
		const events: LocalActivityEvent[] = [
			ev({ ts: "2026-06-01T09:00:00.000Z", session: "s1" }),
			ev({ ts: "", session: "s2" }),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 5000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 2, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		expect(stdout()).not.toContain("Time Range");
	});
});

describe("syncCommand — sort ordering (descending by count)", () => {
	it("Event Types / Agents render strictly descending, not ascending", async () => {
		const events: LocalActivityEvent[] = [
			...Array.from({ length: 1 }, (_, i) => ev({ type: "rare_type", agent: "carl", session: `r${i}` })),
			...Array.from({ length: 5 }, (_, i) => ev({ type: "common_type", agent: "alice", session: `c${i}` })),
		];
		mockGetLocalStats.mockReturnValue({ pending_sync: events.length });
		mockGetUnsyncedEvents.mockReturnValue({ events, newOffset: 6000 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: events.length, skipped: 0, errors: 0 }),
		);
		await syncCommand({});
		const out = stdout();
		// "common type" (count 5) must appear before "rare type" (count 1) —
		// a flipped comparator (b-a swapped to a-b, or b+a) would reorder or
		// corrupt this.
		const commonIdx = out.indexOf("common type");
		const rareIdx = out.indexOf("rare type");
		expect(commonIdx).toBeGreaterThan(-1);
		expect(rareIdx).toBeGreaterThan(-1);
		expect(commonIdx).toBeLessThan(rareIdx);
		// "alice" (count 5) must appear before "carl" (count 1) in the Agents
		// section — a flipped comparator on byAgent would reorder these too.
		const aliceIdx = out.indexOf("alice");
		const carlIdx = out.indexOf("carl");
		expect(aliceIdx).toBeGreaterThan(-1);
		expect(carlIdx).toBeGreaterThan(-1);
		expect(aliceIdx).toBeLessThan(carlIdx);
	});
});

describe("syncCommand — status-code boundary and null response body", () => {
	it("exactly status 500 is treated as transient (retried), not the >500-only boundary", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(500, "server error"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ status: 500, transient: true }),
		);
		const j = jsonOut();
		expect(j.errors).toBe(0);
		expect(j.batches_sent).toBe(1);
	});

	it("a null JSON response body fails closed without advancing the cursor", async () => {
		const nullBodyRes = new Response("null", {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		(vi.mocked(fetch)).mockResolvedValue(nullBodyRes);
		await syncCommand({ json: true });
		expect(fetch).toHaveBeenCalledTimes(1);
		const j = jsonOut();
		expect(j.accepted).toBe(0);
		expect(j.skipped).toBe(0);
		expect(j.errors).toBe(1);
		expect(j.batches_sent).toBe(0);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
		expect(mockAppendSyncError).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "manual_sync_receipt" }),
		);
	});

	it("a malformed success receipt fails closed without advancing the cursor", async () => {
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: "1", skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		expect(jsonOut()).toMatchObject({ accepted: 0, skipped: 0, errors: 1, batches_sent: 0 });
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("an under-accounted success receipt fails closed", async () => {
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 0, skipped: 0, errors: 0 }),
		);
		await syncCommand({ json: true });
		expect(jsonOut()).toMatchObject({ errors: 1, batches_sent: 0 });
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("an exact accepted-plus-skipped receipt permits the checkpoint", async () => {
		mockGetLocalStats.mockReturnValue({ pending_sync: 2 });
		mockGetUnsyncedEvents.mockReturnValue({ events: [ev(), ev()], newOffset: 200 });
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 1, skipped: 1, errors: 0 }),
		);
		await syncCommand({ json: true });
		expect(jsonOut()).toMatchObject({ accepted: 1, skipped: 1, errors: 0, batches_sent: 1 });
		expect(mockUpdateSyncState).toHaveBeenCalledWith(200, expect.any(Object));
	});
});

describe("syncCommand — exact error/retry accounting", () => {
	it("a success receipt reporting errors fails the whole submitted page", async () => {
		(vi.mocked(fetch)).mockResolvedValue(
			okRes({ accepted: 1, skipped: 0, errors: 2 }),
		);
		await syncCommand({ json: true });
		const j = jsonOut();
		expect(j.errors).toBe(1);
		expect(j.batches_sent).toBe(0);
		expect(mockUpdateSyncState).not.toHaveBeenCalled();
	});

	it("retries counted exactly across a transient-then-success batch (503 -> ok)", async () => {
		vi.useFakeTimers();
		const fetchFn = vi.mocked(fetch);
		fetchFn
			.mockResolvedValueOnce(failRes(503, "unavailable"))
			.mockResolvedValueOnce(okRes({ accepted: 1, skipped: 0, errors: 0 }));
		const p = syncCommand({ json: true });
		await vi.runAllTimersAsync();
		await p;
		const j = jsonOut();
		// One failed attempt scheduled one retry; success does not double count it.
		expect(j.retries).toBe(1);
	});
});

describe("syncCommand — top-level error handling", () => {
	it("an Error thrown by getLocalStats is surfaced via outputError (normal)", async () => {
		mockGetLocalStats.mockImplementation(() => {
			throw new Error("disk gone");
		});
		await syncCommand({});
		expect(stderrConsole()).toContain("Error: disk gone");
		expect(process.exitCode).toBe(1);
	});

	it("a non-Error throw is stringified by the catch (json)", async () => {
		mockGetUnsyncedEvents.mockImplementation(() => {
			throw "boom-string";
		});
		await syncCommand({ json: true });
		const j = parseWire(JSON.parse(stderrConsole()), wireObject({ "error": wireString }), "test JSON value");
		expect(j.error).toBe("boom-string");
		expect(process.exitCode).toBe(1);
	});
});
