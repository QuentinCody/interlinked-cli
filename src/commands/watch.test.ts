import { parseWire, wireAbsentOptional, wireArray, wireBoolean, wireNullable, wireNumber, wireObject, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// watch command — behavioral coverage
// ===========================================
// Drives `watchCommand` end-to-end against a mocked api-client and a
// stubbed (pass-through) formatter so output strings are deterministic
// regardless of TTY / NO_COLOR / CI. The watch loop's recurring
// `setTimeout(tick, ...)` is driven with fake timers (no real polling),
// so every branch — output modes, follow ticks, empty vs populated
// payloads, change-detection deltas, render ternaries, the runOnce
// catch path, and interval parsing — is exercised synchronously.
//
// Note: watch.ts installs NO SIGINT/SIGTERM handlers and never calls
// process.exit — the only termination control surfaced to the user is
// Ctrl+C against the recurring timer (the "(Ctrl+C to stop)" banner).
// Error paths route through outputError, which sets process.exitCode = 1
// rather than calling process.exit; that exit-code side-effect is asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted so the vi.mock factories can close over them)
// ---------------------------------------------------------------------------

const { mockCallTool, mockIsAuthenticated, mockIsLocalDevServer, mockGetClient } = vi.hoisted(
	() => ({
		mockCallTool: vi.fn(),
		mockIsAuthenticated: vi.fn().mockReturnValue(true),
		mockIsLocalDevServer: vi.fn().mockReturnValue(false),
		mockGetClient: vi.fn(),
	}),
);

vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
	InterlinkedClient: vi.fn(),
}));

// Pass-through formatter: every color helper returns its input unchanged so
// asserted output strings are exact and env-independent. `c` is the only
// formatter export watch.ts consumes.
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string) => s;
	return {
		c: {
			bold: identity,
			dim: identity,
			italic: identity,
			red: identity,
			green: identity,
			yellow: identity,
			blue: identity,
			magenta: identity,
			cyan: identity,
			gray: identity,
			white: identity,
		},
	};
});

import { watchCommand } from "./watch.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type Tool = "has_unread_messages" | "list_tasks" | "list_agents";

interface RawTask {
	id: number;
	title: string;
	status: string;
	priority: string;
	assignee_name: string | null;
}

interface RawAgent {
	name: string;
	role: string | null;
	status: string;
	last_active_ts: string | null;
}

/**
 * Configure mockCallTool to resolve per-tool payloads. Each entry may be a
 * single value (used for every poll) or an array consumed one-per-poll so
 * follow-loop ticks can return different snapshots. A `null` value rejects
 * that tool's promise (exercising the Promise.allSettled "rejected" arms).
 */
function programClient(perTool: Partial<Record<Tool, unknown | unknown[]>>): void {
	const queues = new Map<Tool, unknown[]>();
	const singles = new Map<Tool, unknown>();
	const tools: Tool[] = ["has_unread_messages", "list_tasks", "list_agents"];
	for (const tool of tools) {
		const val = perTool[tool];
		if (Array.isArray(val)) queues.set(tool, [...val]);
		else singles.set(tool, val);
	}
	mockCallTool.mockImplementation((tool: Tool) => {
		let value: unknown;
		if (queues.has(tool)) {
			const q = queues.get(tool)!;
			value = q.length > 1 ? q.shift() : q[0];
		} else {
			value = singles.get(tool);
		}
		if (value === null) return Promise.reject(new Error(`tool ${tool} failed`));
		return Promise.resolve(value ?? {});
	});
	mockGetClient.mockReturnValue({
		callTool: mockCallTool,
		isAuthenticated: mockIsAuthenticated,
		isLocalDevServer: mockIsLocalDevServer,
	});
}

/** All console.log output joined into one searchable string. */
function loggedText(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((args) => String(args[0] ?? ""))
		.join("\n");
}

function erroredText(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((args) => String(args[0] ?? ""))
		.join("\n");
}

/** The last console.log payload parsed as JSON (json-mode assertions). */
function lastLogJson(): unknown {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") throw new Error(`expected string log, got ${typeof raw}`);
	return JSON.parse(raw);
}

let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
	vi.clearAllMocks();
	mockIsAuthenticated.mockReturnValue(true);
	mockIsLocalDevServer.mockReturnValue(false);
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	// process.stdout.write is called for the clear-screen escape in non-json ticks.
	stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================
// Authentication gate (fetchWorkStatus early return)
// ===========================================

describe("watch — authentication gate", () => {
	it("reports offline + the login hint when unauthenticated and not a dev server (json)", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(false);
		programClient({});

		await watchCommand({ json: true });

		// callTool must NOT run when the gate trips.
		expect(mockCallTool).not.toHaveBeenCalled();
		const payload = parseWire(lastLogJson(), wireObject({ "server": wireObject({ "reachable": wireBoolean, "error": wireAbsentOptional(wireString) }), "messages": wireUnknown, "tasks": wireUnknown, "agents": wireUnknown, "notifications": wireArray(wireUnknown) }), "watch output");
		expect(payload.server.reachable).toBe(false);
		expect(payload.server.error).toBe("Not authenticated. Run: interlinked login");
		expect(payload.messages).toBeNull();
		expect(payload.tasks).toBeNull();
		expect(payload.agents).toBeNull();
		expect(payload.notifications).toEqual([]);
	});

	it("renderShort prints the offline error string when unreachable", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(false);
		programClient({});

		await watchCommand({ short: true });

		expect(loggedText()).toContain("offline: Not authenticated. Run: interlinked login");
	});

	it("renderNormal prints the Server: <error> line when unreachable", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		programClient({});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("Interlinked Watch");
		expect(out).toContain("Server: Not authenticated. Run: interlinked login");
		// Unreachable normal render returns early — no Messages/Work Queue sections.
		expect(out).not.toContain("Work Queue");
	});

	it("proceeds to fetch when unauthenticated but pointed at a local dev server", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(true);
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });

		expect(mockCallTool).toHaveBeenCalledWith("has_unread_messages", {});
		expect(mockCallTool).toHaveBeenCalledWith("list_tasks", { limit: 50 });
		expect(mockCallTool).toHaveBeenCalledWith("list_agents", {});
		expect(parseWire(lastLogJson(), wireObject({ "server": wireObject({ "reachable": wireBoolean }) }), "watch output").server.reachable).toBe(true);
	});
});

// ===========================================
// fetchWorkStatus aggregation (json mode, single poll)
// ===========================================

describe("watch — data aggregation (json)", () => {
	it("aggregates messages, task buckets, agent counts, and cross-references current_task", async () => {
		programClient({
			has_unread_messages: {
				has_unread: true,
				unread_count: 3,
				oldest_unread_at: "2026-06-06T11:00:00.000Z",
			},
			list_tasks: {
				tasks: [
					{ id: 1, title: "P", status: "pending", priority: "high", assignee_name: null },
					{
						id: 2,
						title: "Build feature",
						status: "in_progress",
						priority: "high",
						assignee_name: "worker-1",
					},
					{ id: 3, title: "B", status: "blocked", priority: "low", assignee_name: "worker-2" },
					{ id: 4, title: "Done", status: "completed", priority: "low", assignee_name: "w" },
					{ id: 5, title: "Gone", status: "cancelled", priority: "low", assignee_name: null },
				] satisfies RawTask[],
			},
			list_agents: {
				agents: [
					{ name: "worker-1", role: "builder", status: "active", last_active_ts: "t1" },
					{ name: "worker-2", role: null, status: "active", last_active_ts: null },
					{ name: "System", role: null, status: "active", last_active_ts: "t" },
					{ name: "HumanOverseer", role: null, status: "active", last_active_ts: "t" },
					{ name: "sleepy", role: null, status: "inactive", last_active_ts: "t" },
				] satisfies RawAgent[],
			},
		});

		await watchCommand({ json: true });

		const p = parseWire(lastLogJson(), wireObject({ "messages": wireObject({ "has_unread": wireBoolean, "unread_count": wireNumber, "oldest_unread_at": wireString }), "tasks": wireObject({ "pending": wireNumber, "in_progress": wireNumber, "blocked": wireNumber, "unassigned": wireNumber, "items": wireArray(wireObject({ "id": wireNumber })) }), "agents": wireObject({ "total": wireNumber, "online": wireNumber, "idle": wireNumber, "items": wireArray(wireObject({ "name": wireString, "current_task": wireNullable(wireString) })) }) }), "watch output");

		expect(p.messages).toEqual({
			has_unread: true,
			unread_count: 3,
			oldest_unread_at: "2026-06-06T11:00:00.000Z",
		});
		// Buckets: completed/cancelled excluded from items; counts over all rows.
		expect(p.tasks.pending).toBe(1);
		expect(p.tasks.in_progress).toBe(1);
		expect(p.tasks.blocked).toBe(1);
		expect(p.tasks.unassigned).toBe(1); // task #1 (pending, no assignee)
		expect(p.tasks.items.map((t) => t.id).sort()).toEqual([1, 2, 3]);

		// Agents: System + HumanOverseer + inactive filtered out → worker-1, worker-2.
		expect(p.agents.total).toBe(2);
		expect(p.agents.online).toBe(1); // only worker-1 has last_active_ts
		expect(p.agents.idle).toBe(1); // worker-2 has no in_progress task
		const wk1 = p.agents.items.find((a) => a.name === "worker-1");
		expect(wk1?.current_task).toBe("Build feature"); // cross-referenced from in_progress task #2
		const wk2 = p.agents.items.find((a) => a.name === "worker-2");
		expect(wk2?.current_task).toBeNull();
	});

	it("sets each section null when its tool rejects (Promise.allSettled rejected arms)", async () => {
		programClient({
			has_unread_messages: null, // reject
			list_tasks: null, // reject
			list_agents: null, // reject
		});

		await watchCommand({ json: true });

		const p = parseWire(lastLogJson(), wireObject({ "server": wireObject({ "reachable": wireBoolean }), "messages": wireUnknown, "tasks": wireUnknown, "agents": wireUnknown }), "watch output");
		// Server still reachable (auth passed); individual tools degraded to null.
		expect(p.server.reachable).toBe(true);
		expect(p.messages).toBeNull();
		expect(p.tasks).toBeNull();
		expect(p.agents).toBeNull();
	});

	it("tolerates missing tasks/agents arrays via the `|| []` fallbacks", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {}, // no `tasks` key → `value.tasks || []`
			list_agents: {}, // no `agents` key → `value.agents || []`
		});

		await watchCommand({ json: true });

		const p = parseWire(lastLogJson(), wireObject({ "tasks": wireObject({ "pending": wireNumber, "items": wireArray(wireUnknown) }), "agents": wireObject({ "total": wireNumber, "items": wireArray(wireUnknown) }) }), "watch output");
		expect(p.tasks.pending).toBe(0);
		expect(p.tasks.items).toEqual([]);
		expect(p.agents.total).toBe(0);
		expect(p.agents.items).toEqual([]);
	});
});

// ===========================================
// renderShort — every branch
// ===========================================

describe("watch — renderShort branches", () => {
	it("renders unread/active/unassigned/idle segments joined by ' | '", async () => {
		programClient({
			has_unread_messages: { has_unread: true, unread_count: 4, oldest_unread_at: "x" },
			list_tasks: {
				tasks: [
					{ id: 1, title: "p", status: "pending", priority: "low", assignee_name: null },
					{ id: 2, title: "w", status: "in_progress", priority: "low", assignee_name: "a" },
				],
			},
			list_agents: {
				agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }],
			},
		});

		await watchCommand({ short: true });

		const out = loggedText();
		expect(out).toContain("4 unread");
		expect(out).toContain("2 active tasks");
		expect(out).toContain("1 unassigned"); // task #1 pending+unassigned
		expect(out).toContain("1 agents");
		expect(out).toContain(" | ");
	});

	it("renders the zero/dim segments when nothing is pending", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ short: true });

		const out = loggedText();
		expect(out).toContain("0 unread");
		expect(out).toContain("0 tasks");
		expect(out).toContain("0 agents");
		// No unassigned/idle suffixes when their counts are zero.
		expect(out).not.toContain("unassigned");
		expect(out).not.toContain("idle");
	});

	it("appends the idle suffix to the agents segment when agents are idle", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: {
				agents: [{ name: "lonely", role: null, status: "active", last_active_ts: "t" }],
			},
		});

		await watchCommand({ short: true });

		expect(loggedText()).toContain("1 agents (1 idle)");
	});

	it("omits the messages/tasks/agents segments entirely when those tools reject", async () => {
		programClient({
			has_unread_messages: null,
			list_tasks: null,
			list_agents: null,
		});

		await watchCommand({ short: true });

		// All three sections null → parts is empty → join yields "".
		const firstLine = vi.mocked(console.log).mock.calls[0]?.[0];
		expect(firstLine).toBe("");
	});
});

// ===========================================
// renderNormal — every branch
// ===========================================

describe("watch — renderNormal branches", () => {
	it("renders unread messages with the oldest-timestamp line", async () => {
		programClient({
			has_unread_messages: {
				has_unread: true,
				unread_count: 2,
				oldest_unread_at: "2026-06-06T10:00:00.000Z",
			},
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("2 unread messages");
		expect(out).toContain("oldest: 2026-06-06T10:00:00.000Z");
		expect(out).toContain("No active tasks");
		expect(out).toContain("No active agents");
	});

	it("renders 'No unread messages' when nothing is unread", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		expect(loggedText()).toContain("No unread messages");
	});

	it("renders '(unavailable)' for each section when its tool rejects", async () => {
		programClient({
			has_unread_messages: null,
			list_tasks: null,
			list_agents: null,
		});

		await watchCommand({});

		const out = loggedText();
		// Three sections each fall through to their "(unavailable)" arm.
		expect(out.match(/\(unavailable\)/g)?.length).toBe(3);
	});

	it("renders the full work-queue summary, unassigned-first ordering, badges, and overflow", async () => {
		// 14 active tasks → exercises slice(0,12) + the "... and N more" overflow.
		const tasks: RawTask[] = [];
		// One assigned in_progress task first in the array, so the sort must
		// hoist the later unassigned-pending task above it (-1 / +1 arms).
		tasks.push({
			id: 100,
			title: "assigned-in-progress",
			status: "in_progress",
			priority: "high",
			assignee_name: "worker-1",
		});
		tasks.push({
			id: 101,
			title: "needs-pickup",
			status: "pending",
			priority: "high",
			assignee_name: null,
		});
		tasks.push({
			id: 102,
			title: "blocked-one",
			status: "blocked",
			priority: "low",
			assignee_name: "worker-2",
		});
		for (let i = 0; i < 11; i++) {
			tasks.push({
				id: 200 + i,
				title: `filler ${i}`,
				status: "in_progress",
				priority: "low",
				assignee_name: "worker-1",
			});
		}

		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks },
			list_agents: {
				agents: [
					{ name: "worker-1", role: "builder", status: "active", last_active_ts: "t" },
					{ name: "worker-2", role: null, status: "active", last_active_ts: "t" },
				],
			},
		});

		await watchCommand({});

		// renderNormal emits the whole dashboard as ONE console.log call (a
		// single newline-joined string), so ordering is checked via string
		// position within that block rather than per-call index.
		const out = loggedText();

		// Summary line: pending | in progress | blocked.
		expect(out).toContain("1 pending");
		expect(out).toContain("12 in progress");
		expect(out).toContain("1 blocked");
		expect(out).toContain("1 unassigned — needs pickup");

		// Unassigned-first ordering: the unassigned pending task line precedes
		// the assigned in-progress one in the rendered output.
		const idxUnassigned = out.indexOf("#101 needs-pickup");
		const idxAssigned = out.indexOf("#100 assigned-in-progress");
		expect(idxUnassigned).toBeGreaterThanOrEqual(0);
		expect(idxAssigned).toBeGreaterThanOrEqual(0);
		expect(idxUnassigned).toBeLessThan(idxAssigned);

		// Badges + assignee/unassigned suffixes.
		expect(out).toContain("(unassigned)");
		expect(out).toContain("-> worker-1");

		// 14 active tasks, only 12 shown → overflow line for the remaining 2.
		expect(out).toContain("... and 2 more");

		// Agents section: total/working/idle summary + working dot with task title.
		// worker-1 is on in_progress tasks (working); worker-2 is only on a
		// blocked task, which never enters the assignee map → idle.
		expect(out).toContain("2 total, 1 working, 1 idle");
		expect(out).toContain("worker-1 (builder)");
		// worker-1's working dot carries a current-task title. The assignee→task
		// map is last-write-wins, so among worker-1's many in_progress tasks the
		// final one ("filler 10") is the surfaced current_task.
		expect(out).toContain("worker-1 (builder) -> filler 10");
	});

	it("renders an idle agent (○ + ' idle') when it has no in-progress task", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: {
				agents: [{ name: "idle-bot", role: null, status: "active", last_active_ts: "t" }],
			},
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("1 total, 0 working, 1 idle");
		// Exact glyph + name + no-role + idle-suffix, all in one substring: the
		// idle dot (○), the role fallback (empty, no stray text), and the
		// " idle" suffix must all render verbatim and adjacently.
		expect(out).toContain("○ idle-bot idle");
		expect(out).not.toContain("Stryker");
	});

	it("truncates over-length task titles to the 45-char budget", async () => {
		const longTitle = "x".repeat(80);
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 7, title: longTitle, status: "pending", priority: "low", assignee_name: null },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		// truncate(s,45) => first 42 chars + "..." ; full 80-char title absent.
		expect(out).toContain(`${"x".repeat(42)}...`);
		expect(out).not.toContain(longTitle);
	});

	it("omits the 'N pending' segment when pending is zero but other work exists", async () => {
		// in_progress + blocked > 0 with pending === 0 exercises the false arm of
		// `if (pending > 0)` in the summary while still rendering the summary line.
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "wip", status: "in_progress", priority: "low", assignee_name: "a" },
					{ id: 2, title: "stuck", status: "blocked", priority: "low", assignee_name: "b" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).not.toContain("No active tasks");
		expect(out).not.toContain("pending"); // pending === 0 → segment omitted
		expect(out).toContain("1 in progress");
		expect(out).toContain("1 blocked");
	});

	it("evaluates the OR right-operand on both sides of the sort comparator", async () => {
		// Comparator OR `(peer.assignee || peer.status !== "pending")`: the right
		// operand is reached only when the peer has no assignee. With the
		// unassigned-pending task BRACKETED by two unassigned-blocked tasks
		// (B, P, B), TimSort compares the pending task as both the first and the
		// second comparator argument, so both `||` right-operands (the a-side and
		// the b-side) are evaluated.
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "blocked-a", status: "blocked", priority: "low", assignee_name: null },
					{ id: 2, title: "pick-me", status: "pending", priority: "low", assignee_name: null },
					{ id: 3, title: "blocked-b", status: "blocked", priority: "low", assignee_name: null },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		// Unassigned-pending is hoisted ahead of both unassigned-blocked peers.
		expect(out).toContain("#2 pick-me");
		expect(out.indexOf("#2 pick-me")).toBeLessThan(out.indexOf("#1 blocked-a"));
		expect(out.indexOf("#2 pick-me")).toBeLessThan(out.indexOf("#3 blocked-b"));
	});
});

// ===========================================
// taskBadge — all four arms (default exercised via an unknown status)
// ===========================================

describe("watch — taskBadge default arm", () => {
	it("falls through to the default badge for an unrecognized active status", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			// One pending task makes pending+in_progress+blocked > 0 so the item
			// loop runs; "in_review" is not completed/cancelled (so it stays an
			// active item) and not pending/in_progress/blocked (so taskBadge hits
			// its default arm when rendering it).
			list_tasks: {
				tasks: [
					{ id: 1, title: "queued", status: "pending", priority: "low", assignee_name: "a" },
					{ id: 9, title: "review me", status: "in_review", priority: "low", assignee_name: "a" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		// Both items render; the in_review item proves the default-badge arm ran.
		expect(out).toContain("1 pending");
		expect(out).toContain("#1 queued");
		expect(out).toContain("#9 review me");
		expect(out).not.toContain("No active tasks");
		// Default badge is exactly "·" (dim middle-dot), not undefined/blank —
		// kills the taskBadge BlockStatement-emptied and default-case mutants.
		expect(out).toContain("· #9 review me");
	});
});

// ===========================================
// Targeted mutant kills (boundary / logic-flip cases)
// ===========================================

describe("watch — targeted mutant kills", () => {
	it("computes unassigned strictly as pending AND no assignee (not OR, not always-true)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "a", status: "pending", priority: "low", assignee_name: null }, // true unassigned
					{ id: 2, title: "b", status: "pending", priority: "low", assignee_name: "bob" }, // pending but assigned
					{ id: 3, title: "c", status: "blocked", priority: "low", assignee_name: null }, // unassigned but not pending
					{ id: 4, title: "d", status: "in_progress", priority: "low", assignee_name: "x" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });

		const p = parseWire(lastLogJson(), wireObject({ "tasks": wireObject({ "unassigned": wireNumber }) }), "watch output");
		expect(p.tasks.unassigned).toBe(1);
	});

	it("computes agents.online strictly from non-null last_active_ts (not the inverse)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: {
				agents: [
					{ name: "a", role: null, status: "active", last_active_ts: "t" },
					{ name: "b", role: null, status: "active", last_active_ts: null },
					{ name: "c", role: null, status: "active", last_active_ts: null },
				],
			},
		});

		await watchCommand({ json: true });

		const p = parseWire(lastLogJson(), wireObject({ "agents": wireObject({ "online": wireNumber }) }), "watch output");
		expect(p.agents.online).toBe(1);
	});

	it("truncate does not cut a string exactly at the max-length boundary", async () => {
		const exact45 = "a".repeat(45);
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: exact45, status: "pending", priority: "low", assignee_name: null },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain(exact45);
		expect(out).not.toContain(`${"a".repeat(42)}...`);
	});

	it("omits in-progress and blocked summary segments, and the unassigned callout, when each is zero", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "only pending", status: "pending", priority: "low", assignee_name: "a" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("1 pending");
		expect(out).not.toContain("in progress");
		expect(out).not.toContain("blocked");
		expect(out).not.toContain("needs pickup");
	});

	it("shows exactly 12 items with no overflow line at exactly the 12-item boundary", async () => {
		const tasks: RawTask[] = Array.from({ length: 12 }, (_, i) => ({
			id: 300 + i,
			title: `t${i}`,
			status: "pending",
			priority: "low",
			assignee_name: "a",
		}));
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).not.toContain("more");
		for (const t of tasks) {
			expect(out).toContain(`#${t.id}`);
		}
	});

	it("renders the correct badge glyph per task status", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "p", status: "pending", priority: "low", assignee_name: "a" },
					{ id: 2, title: "ip", status: "in_progress", priority: "low", assignee_name: "a" },
					{ id: 3, title: "bl", status: "blocked", priority: "low", assignee_name: "a" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("○ #1 p");
		expect(out).toContain("● #2 ip");
		expect(out).toContain("✕ #3 bl");
	});

	it("omits the Notifications header block when there are no notifications (first poll)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		expect(loggedText()).not.toContain("Notifications");
	});

	it("prints section headers verbatim in normal mode", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("Messages");
		expect(out).toContain("Work Queue");
		expect(out).toContain("Agents");
	});

	it("reprints the refresh banner on every non-json tick, not just the initial render", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});
		await vi.advanceTimersByTimeAsync(10_000);

		const occurrences = loggedText().match(/Refreshing every 10s/g) ?? [];
		expect(occurrences.length).toBeGreaterThanOrEqual(2);
	});
});

// ===========================================
// detectChanges — driven across two polls via the follow loop
// ===========================================

describe("watch — change detection across ticks", () => {
	it("emits notifications for new messages, new tasks, new unassigned, and agents online (plural)", async () => {
		programClient({
			has_unread_messages: [
				{ has_unread: true, unread_count: 1, oldest_unread_at: "t" },
				{ has_unread: true, unread_count: 3, oldest_unread_at: "t" }, // +2 unread
			],
			list_tasks: [
				{
					tasks: [
						{ id: 1, title: "first", status: "pending", priority: "low", assignee_name: "a" },
					],
				},
				{
					tasks: [
						{ id: 1, title: "first", status: "pending", priority: "low", assignee_name: "a" },
						{ id: 2, title: "brand new", status: "pending", priority: "low", assignee_name: null },
						{ id: 3, title: "also new", status: "pending", priority: "low", assignee_name: null },
					],
				},
			],
			list_agents: [
				{ agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }] },
				{
					agents: [
						{ name: "a", role: null, status: "active", last_active_ts: "t" },
						{ name: "b", role: null, status: "active", last_active_ts: "t" },
						{ name: "c", role: null, status: "active", last_active_ts: "t" },
					],
				},
			],
		});

		await watchCommand({ json: true });
		// First poll: no previous → notifications empty.
		expect(parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications).toEqual([]);

		// Fire one follow tick → second snapshot diffed against the first.
		await vi.advanceTimersByTimeAsync(10_000);

		const notes = parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications;
		expect(notes).toContain("2 new unread messages"); // delta 2 → plural
		expect(notes).toContain("New task #2: brand new");
		expect(notes).toContain("New task #3: also new");
		expect(notes).toContain("2 tasks waiting for assignment"); // unassigned 0→2, plural
		expect(notes).toContain("2 new agents came online"); // +2 agents, plural
	});

	it("emits singular wording for a single-unit delta and detects agents going offline", async () => {
		programClient({
			has_unread_messages: [
				{ has_unread: true, unread_count: 1, oldest_unread_at: "t" },
				{ has_unread: true, unread_count: 2, oldest_unread_at: "t" }, // +1 unread
			],
			list_tasks: [
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: null },
					],
				},
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: null },
						{ id: 2, title: "single new", status: "pending", priority: "low", assignee_name: null },
					],
				},
			],
			list_agents: [
				{
					agents: [
						{ name: "a", role: null, status: "active", last_active_ts: "t" },
						{ name: "b", role: null, status: "active", last_active_ts: "t" },
					],
				},
				{ agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }] }, // b left
			],
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		const notes = parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications;
		expect(notes).toContain("1 new unread message"); // singular
		expect(notes).toContain("New task #2: single new");
		expect(notes).toContain("1 task waiting for assignment"); // unassigned 1→2, singular
		expect(notes).toContain("1 agent went offline"); // -1 agent, singular
	});

	it("produces no notifications when the snapshot is unchanged", async () => {
		const steady = {
			has_unread_messages: { has_unread: true, unread_count: 5, oldest_unread_at: "t" },
			list_tasks: {
				tasks: [{ id: 1, title: "same", status: "pending", priority: "low", assignee_name: null }],
			},
			list_agents: {
				agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }],
			},
		};
		programClient(steady);

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications).toEqual([]);
	});

	it("renders the Notifications header block in normal mode when changes occur", async () => {
		programClient({
			has_unread_messages: [
				{ has_unread: true, unread_count: 0, oldest_unread_at: null },
				{ has_unread: true, unread_count: 4, oldest_unread_at: "t" },
			],
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({}); // normal mode
		await vi.advanceTimersByTimeAsync(10_000);

		const out = loggedText();
		expect(out).toContain("Notifications");
		expect(out).toContain("4 new unread messages");
	});

	it("truncates long new-task titles in the notification text", async () => {
		const longTitle = "y".repeat(60);
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: [
				{ tasks: [] },
				{
					tasks: [
						{ id: 5, title: longTitle, status: "pending", priority: "low", assignee_name: "a" },
					],
				},
			],
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		const notes = parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications;
		// truncate(title, 40) => 37 chars + "..."
		expect(notes).toContain(`New task #5: ${"y".repeat(37)}...`);
	});

	it("uses singular wording when exactly one agent comes online", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: [
				{ agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }] },
				{
					agents: [
						{ name: "a", role: null, status: "active", last_active_ts: "t" },
						{ name: "b", role: null, status: "active", last_active_ts: "t" }, // +1 only
					],
				},
			],
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications).toContain(
			"1 new agent came online", // singular branch of the came-online ternary
		);
	});

	it("uses plural wording when multiple agents go offline", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: [
				{
					agents: [
						{ name: "a", role: null, status: "active", last_active_ts: "t" },
						{ name: "b", role: null, status: "active", last_active_ts: "t" },
						{ name: "c", role: null, status: "active", last_active_ts: "t" },
					],
				},
				{ agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }] }, // -2
			],
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications).toContain(
			"2 agents went offline", // plural branch of the went-offline ternary
		);
	});

	it("skips each change-detection block when its section drops to null on a later poll", async () => {
		// First poll: all sections present. Second poll: every tool rejects, so
		// curr.{messages,tasks,agents} are null while prev exists — exercising the
		// false arm of each `if (curr.X && prev.X)` guard in detectChanges.
		programClient({
			has_unread_messages: [
				{ has_unread: true, unread_count: 1, oldest_unread_at: "t" },
				null, // reject on 2nd poll → curr.messages null
			],
			list_tasks: [
				{
					tasks: [
						{ id: 1, title: "t", status: "pending", priority: "low", assignee_name: null },
					],
				},
				null,
			],
			list_agents: [
				{ agents: [{ name: "a", role: null, status: "active", last_active_ts: "t" }] },
				null,
			],
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		const p = parseWire(lastLogJson(), wireObject({ "messages": wireUnknown, "notifications": wireArray(wireString) }), "watch output");
		expect(p.messages).toBeNull();
		// No deltas can be computed when curr sections are null → empty notes.
		expect(p.notifications).toEqual([]);
	});
});

// ===========================================
// Watch loop / follow behavior + interval parsing
// ===========================================

describe("watch — follow loop and interval parsing", () => {
	it("non-json: prints the refresh banner, then on each tick clears the screen and re-renders", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({}); // default 10s interval

		// Initial render happened; banner mentions the interval + Ctrl+C.
		expect(loggedText()).toContain("Refreshing every 10s... (Ctrl+C to stop)");
		// No clear-screen before the first tick fires.
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
		// 3 poll calls so far (one per tool, single poll).
		expect(mockCallTool).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(10_000); // fire tick #1

		// Clear-screen escape written, and a second poll ran (3 more tool calls).
		expect(stdoutWriteSpy).toHaveBeenCalledWith("\x1B[2J\x1B[0f");
		expect(mockCallTool).toHaveBeenCalledTimes(6);

		await vi.advanceTimersByTimeAsync(10_000); // fire tick #2 → confirms reschedule
		expect(mockCallTool).toHaveBeenCalledTimes(9);
	});

	it("honors a custom interval and does not tick before it elapses", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ interval: "5" });

		expect(loggedText()).toContain("Refreshing every 5s");
		// Just shy of 5s → no tick yet.
		await vi.advanceTimersByTimeAsync(4_999);
		expect(mockCallTool).toHaveBeenCalledTimes(3);
		// Crossing 5s → tick fires.
		await vi.advanceTimersByTimeAsync(1);
		expect(mockCallTool).toHaveBeenCalledTimes(6);
	});

	it("falls back to the 10s default when the interval is below the 2s minimum", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ interval: "1" }); // < MIN_INTERVAL_SEC (2) → ignored

		expect(loggedText()).toContain("Refreshing every 10s");
		await vi.advanceTimersByTimeAsync(9_999);
		expect(mockCallTool).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockCallTool).toHaveBeenCalledTimes(6);
	});

	it("falls back to the 10s default when the interval is not a number", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ interval: "abc" }); // NaN → ignored

		expect(loggedText()).toContain("Refreshing every 10s");
	});

	it("accepts a custom interval at exactly the 2s minimum", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ interval: "2" });

		expect(loggedText()).toContain("Refreshing every 2s");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(mockCallTool).toHaveBeenCalledTimes(6);
	});

	it("json mode: prints no refresh banner / clear-screen but still polls on each tick", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });

		// One JSON document logged; no human banner.
		expect(loggedText()).not.toContain("Refreshing every");
		expect(mockCallTool).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(10_000); // json tick

		// No clear-screen escape in json mode, but the poll still ran.
		expect(stdoutWriteSpy).not.toHaveBeenCalled();
		expect(mockCallTool).toHaveBeenCalledTimes(6);
		// Second JSON document emitted.
		expect(() => lastLogJson()).not.toThrow();
	});
});

// ===========================================
// runOnce catch path → outputError
// ===========================================

// ===========================================
// Additional line-precise mutant kills (Stryker survivor sweep)
// ===========================================

describe("watch — additional mutant kills (survivor sweep)", () => {
	it("fires the unassigned-growth notification only strictly above zero (0 -> 1 boundary)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: [
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: "a" }, // unassigned=0
					],
				},
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: "a" },
						{ id: 2, title: "t2", status: "pending", priority: "low", assignee_name: null }, // unassigned=1
					],
				},
			],
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		const notes = parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications;
		expect(notes).toContain("1 task waiting for assignment");
	});

	it("does not fire the unassigned-growth notification when unassigned holds steady", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: [
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: null }, // unassigned=1
					],
				},
				{
					tasks: [
						{ id: 1, title: "t1", status: "pending", priority: "low", assignee_name: null }, // still 1
					],
				},
			],
			list_agents: { agents: [] },
		});

		await watchCommand({ json: true });
		await vi.advanceTimersByTimeAsync(10_000);

		const notes = parseWire(lastLogJson(), wireObject({ "notifications": wireArray(wireString) }), "watch output").notifications;
		expect(notes.some((n) => n.includes("waiting for assignment"))).toBe(false);
	});

	it("renderShort: idle segment fallback is exactly empty (no stray placeholder text) when nothing is idle", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({ short: true });

		const out = loggedText();
		expect(out).not.toContain("Stryker");
		expect(out).toContain("0 agents");
	});

	it("renders no stray placeholder text when there are no notifications", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).not.toContain("Notifications");
		expect(out).not.toContain("Stryker");
	});

	it("renders the exact Notifications header text and no stray placeholder text when changes occur", async () => {
		programClient({
			has_unread_messages: [
				{ has_unread: true, unread_count: 0, oldest_unread_at: null },
				{ has_unread: true, unread_count: 4, oldest_unread_at: "t" },
			],
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});
		await vi.advanceTimersByTimeAsync(10_000);

		const out = loggedText();
		expect(out).toContain("  Notifications");
		expect(out).not.toContain("Stryker");
		// Exact bullet-prefixed notification line: the ">" bullet char must
		// precede the note text verbatim.
		expect(out).toContain("> 4 new unread messages");
	});

	it("omits the oldest-unread line when oldest_unread_at is falsy but has_unread is true", async () => {
		programClient({
			has_unread_messages: { has_unread: true, unread_count: 2, oldest_unread_at: "" },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).toContain("2 unread messages");
		expect(out).not.toContain("oldest:");
	});

	it("prints the actual timestamp text on the header line", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		expect(loggedText()).toContain("2026-06-06T12:00:00.000Z");
	});

	it("joins the dashboard with real newlines, not a flattened string (reachable path)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks: [] },
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const raw = vi.mocked(console.log).mock.calls[0]?.[0];
		expect(typeof raw).toBe("string");
		expect((parseWire(raw, wireString, "test JSON value")).includes("\n")).toBe(true);
		expect((parseWire(raw, wireString, "test JSON value")).split("\n").length).toBeGreaterThan(5);
	});

	it("joins the dashboard with real newlines when the server is unreachable", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		programClient({});

		await watchCommand({});

		const raw = vi.mocked(console.log).mock.calls[0]?.[0];
		expect(typeof raw).toBe("string");
		expect((parseWire(raw, wireString, "test JSON value")).includes("\n")).toBe(true);
	});

	it("keeps two adjacent unassigned-pending tasks in their original relative order (stable sort)", async () => {
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 10, title: "first-U", status: "pending", priority: "low", assignee_name: null },
					{ id: 11, title: "second-U", status: "pending", priority: "low", assignee_name: null },
					{ id: 12, title: "assigned", status: "pending", priority: "low", assignee_name: "a" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		const idxFirst = out.indexOf("#10 first-U");
		const idxSecond = out.indexOf("#11 second-U");
		const idxAssigned = out.indexOf("#12 assigned");
		expect(idxFirst).toBeGreaterThanOrEqual(0);
		expect(idxSecond).toBeGreaterThan(idxFirst);
		expect(idxAssigned).toBeGreaterThan(idxSecond);
	});

	it("does not give assigned-pending tasks unassigned-priority treatment in the sort", async () => {
		// Categories: A=assigned+pending, U=unassigned+pending, B=unassigned+non-pending,
		// C=assigned+non-pending, laid out A,U,B,C. Correct behavior: only U hoists to
		// the front; A/B/C keep their original relative order (stable sort). A comparator
		// bug that ORs the assignee/status checks for the `a` side (instead of ANDing them)
		// would incorrectly grant A the same front-of-queue priority as U.
		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: {
				tasks: [
					{ id: 1, title: "cat-A", status: "pending", priority: "low", assignee_name: "x" },
					{ id: 2, title: "cat-U", status: "pending", priority: "low", assignee_name: null },
					{ id: 3, title: "cat-B", status: "blocked", priority: "low", assignee_name: null },
					{ id: 4, title: "cat-C", status: "blocked", priority: "low", assignee_name: "x" },
				],
			},
			list_agents: { agents: [] },
		});

		await watchCommand({});

		const out = loggedText();
		const idxA = out.indexOf("#1 cat-A");
		const idxU = out.indexOf("#2 cat-U");
		const idxB = out.indexOf("#3 cat-B");
		const idxC = out.indexOf("#4 cat-C");
		expect(idxU).toBeGreaterThanOrEqual(0);
		// U is hoisted ahead of everything else.
		expect(idxU).toBeLessThan(idxA);
		expect(idxU).toBeLessThan(idxB);
		expect(idxU).toBeLessThan(idxC);
		// A, B, C keep their original relative order (only U jumps the queue).
		expect(idxA).toBeLessThan(idxB);
		expect(idxB).toBeLessThan(idxC);
	});

	it("renders exact work-queue summary text, per-agent dot glyphs, no placeholder text, and caps at 12 rows", async () => {
		const tasks: RawTask[] = [];
		tasks.push({
			id: 100,
			title: "assigned-in-progress",
			status: "in_progress",
			priority: "high",
			assignee_name: "worker-1",
		});
		tasks.push({
			id: 101,
			title: "needs-pickup",
			status: "pending",
			priority: "high",
			assignee_name: null,
		});
		tasks.push({
			id: 102,
			title: "blocked-one",
			status: "blocked",
			priority: "low",
			assignee_name: "worker-2",
		});
		for (let i = 0; i < 11; i++) {
			tasks.push({
				id: 200 + i,
				title: `filler ${i}`,
				status: "in_progress",
				priority: "low",
				assignee_name: "worker-1",
			});
		}

		programClient({
			has_unread_messages: { has_unread: false, unread_count: 0, oldest_unread_at: null },
			list_tasks: { tasks },
			list_agents: {
				agents: [
					{ name: "worker-1", role: "builder", status: "active", last_active_ts: "t" },
					{ name: "worker-2", role: null, status: "active", last_active_ts: "t" },
				],
			},
		});

		await watchCommand({});

		const out = loggedText();
		expect(out).not.toContain("Stryker");
		// Exact summary line text (segment order + " | " separator).
		expect(out).toContain("1 pending | 12 in progress | 1 blocked");
		// Slice(0, 12): only the first 12 of 14 sorted items render; the last two
		// (filler 9 / filler 10, ids 209/210) are pushed past the cap.
		expect(out).not.toContain("#209");
		expect(out).not.toContain("#210");
		// Working agent's dot glyph is present (green ●), not stripped.
		expect(out).toContain("● worker-1");
	});
});

describe("watch — error handling (runOnce catch)", () => {
	it("routes a thrown fetch error through outputError and sets process.exitCode (json)", async () => {
		// getClient() throwing inside fetchWorkStatus makes runOnce's try reject.
		mockGetClient.mockImplementation(() => {
			throw new Error("client construction failed");
		});

		await watchCommand({ json: true });

		const errJson = parseWire(JSON.parse(parseWire(vi.mocked(console.error).mock.calls.at(-1)?.[0], wireString, "test JSON value")), wireObject({ "error": wireString }), "test JSON value");
		expect(errJson.error).toBe("client construction failed");
		expect(process.exitCode).toBe(1);
	});

	it("routes a thrown fetch error through outputError in normal mode (human prefix)", async () => {
		mockGetClient.mockImplementation(() => {
			throw new Error("boom");
		});

		await watchCommand({});

		expect(erroredText()).toContain("Error: boom");
		expect(process.exitCode).toBe(1);
		// The loop still arms; a recovered tick renders normally.
		mockGetClient.mockReturnValue({
			callTool: mockCallTool,
			isAuthenticated: mockIsAuthenticated,
			isLocalDevServer: mockIsLocalDevServer,
		});
		mockCallTool.mockResolvedValue({});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(loggedText()).toContain("Interlinked Watch");
	});
});
