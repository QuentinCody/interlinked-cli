// ===========================================
// explain command — behavioral coverage
// ===========================================
// Mocks the two data-layer boundaries (../lib/api-client.js for the server feed,
// ../lib/local-activity.js for the JSONL read + dedup) and exercises the REAL
// output.js / formatter.js / activity-utils.js so assertions land on actual
// rendered strings, JSON payloads, and side-effects (process.exitCode).
//
// Time is frozen with fake timers so the `Date.now() - durationMs` window filter
// is deterministic: every fixture timestamp is positioned relative to NOW.
//
// Branch map covered: output modes (json/normal/full, short→normal fallback);
// since default vs explicit; localResult fulfilled/rejected; activityResult
// fulfilled/rejected (+ events||activities||activity||[] precedence + isServerDown);
// tool/summary ?? null; ts fallback chain + the !ts `continue`; opts.full detail;
// attribution presence/absence/zero; in-window vs out-of-window filter; agent
// filter on/off; resolveAgentName's three-way ||; the empty-timeline early return
// in both normal and full; the attribution-summary block; and both catch arms
// (Error vs non-Error, normal vs json).
//
// `exactOptionalPropertyTypes` is on: fields typed `string` (not `string |
// undefined`) cannot be set to `undefined` in a Partial. To model a *missing*
// key we build the base fixture then `omit(...)` the key, so the property is
// genuinely absent — which is also how real server payloads arrive.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "../lib/activity-utils.js";
import type { EventAttribution, LocalActivityEvent } from "../lib/local-activity.js";

// ---- module boundary mocks (the only things that touch fs / network) ----
vi.mock("../lib/api-client.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/api-client.js")>(),
	getClient: vi.fn(),
}));

// readLocalActivity reads JSONL off disk; mergeAndDedup is pure but lives in the
// same module — mock the read, keep the REAL merge so dedup/sort behavior is
// exercised, not stubbed.
vi.mock("../lib/local-activity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/local-activity.js")>();
	return {
		...actual,
		readLocalActivity: vi.fn(),
	};
});

import { getClient, InterlinkedClient } from "../lib/api-client.js";
import { readLocalActivity } from "../lib/local-activity.js";
import { explainCommand } from "./explain.js";

// Real formatter colors are TTY/NO_COLOR-dependent; strip ANSI so assertions are
// hermetic regardless of how the runner is invoked.
const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
	return s.replace(ANSI, "");
}

/** Return a shallow copy of `obj` with `keys` removed (a genuinely-absent key). */
function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
	const copy = { ...obj };
	for (const k of keys) delete copy[k];
	return copy;
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
/** The single console.log payload, unstripped (for JSON.parse). */
function rawLog(): string {
	return String(logSpy.mock.calls[0]?.[0] ?? "");
}

const mocks = {
	readLocalActivity: vi.mocked(readLocalActivity),
	getClient: vi.mocked(getClient),
};

// Frozen wall-clock for the whole suite. Every fixture ts is expressed as an
// offset from this instant so "within the last 1h" is exact.
const NOW = new Date("2099-06-01T12:00:00.000Z").getTime();
function isoAgo(ms: number): string {
	return new Date(NOW - ms).toISOString();
}
const MIN = 60_000;

/** Build a server-shaped ActivityEvent (occurred_at + agent_name fields). */
function serverEvent(over: Partial<ActivityEvent> = {}): ActivityEvent {
	return {
		agent_name: "claude",
		event_type: "tool_use",
		tool_name: "Read",
		tool_input_summary: "src/index.ts",
		occurred_at: isoAgo(5 * MIN),
		...over,
	};
}

/** Build a local-shaped event as readLocalActivity returns it. */
function localEvent(over: Partial<LocalActivityEvent> = {}): LocalActivityEvent {
	return {
		ts: isoAgo(10 * MIN),
		agent: "gemini",
		type: "tool_use",
		tool: "Write",
		summary: "src/new.ts",
		...over,
	};
}

/** A fake api-client whose callTool behavior is configurable per test. */
function fakeClient(callTool: () => Promise<unknown>): InterlinkedClient {
	const client = new InterlinkedClient({ serverUrl: "https://api.example", token: "test-token" });
	vi.spyOn(client, "callTool").mockImplementation(callTool);
	return client;
}
/** Wire getClient → a client whose callTool resolves to `value`. */
function serverResolves(value: unknown): void {
	mocks.getClient.mockReturnValue(
		fakeClient(() => Promise.resolve(value)),
	);
}
/** Wire getClient → a client whose callTool rejects (server-down path). */
function serverRejects(err: unknown = new Error("server down")): void {
	mocks.getClient.mockReturnValue(
		fakeClient(() => Promise.reject(err)),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// Safe defaults: no local events, server resolves empty.
	mocks.readLocalActivity.mockReturnValue([]);
	serverResolves({ events: [] });
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ===========================================
// Data fetch wiring (the parallel allSettled + arg threading)
// ===========================================
describe("explainCommand — data fetch wiring", () => {
	it("passes the parsed since-window and limits into readLocalActivity and callTool", async () => {
		const callTool = vi.fn().mockResolvedValue({ events: [] });
		mocks.getClient.mockReturnValue(
			fakeClient(callTool),
		);

		await explainCommand({ since: "30m" });

		// durationMs for "30m" = 1_800_000; since = NOW - that.
		expect(mocks.readLocalActivity).toHaveBeenCalledWith({
			since: NOW - 30 * MIN,
			limit: 200,
		});
		expect(callTool).toHaveBeenCalledWith("query_activity_feed", { limit: 100 });
	});

	it("defaults the window to 1h when --since is omitted", async () => {
		await explainCommand({});

		expect(mocks.readLocalActivity).toHaveBeenCalledWith({
			since: NOW - 60 * MIN,
			limit: 200,
		});
		// The default label shows up in the rendered header.
		expect(logged()).toContain("last 1h");
	});
});

// ===========================================
// Server-response shape precedence (events || activities || activity || [])
// ===========================================
describe("explainCommand — server payload key precedence", () => {
	it("reads from `events` first when present", async () => {
		serverResolves({
			events: [serverEvent({ tool_input_summary: "from-events.ts" })],
			activities: [serverEvent({ tool_input_summary: "from-activities.ts" })],
		});

		await explainCommand({});

		expect(logged()).toContain("from-events.ts");
		expect(logged()).not.toContain("from-activities.ts");
	});

	it("falls back to `activities` when `events` is absent", async () => {
		serverResolves({ activities: [serverEvent({ tool_input_summary: "via-activities.ts" })] });

		await explainCommand({});

		expect(logged()).toContain("via-activities.ts");
	});

	it("falls back to `activity` when both `events` and `activities` are absent", async () => {
		serverResolves({ activity: [serverEvent({ tool_input_summary: "via-activity.ts" })] });

		await explainCommand({});

		expect(logged()).toContain("via-activity.ts");
	});

	it("treats a null tool result as an empty feed (the trailing `|| []`)", async () => {
		serverResolves(null);

		await explainCommand({});

		// No server events, no local events → empty-window message, not a crash.
		expect(logged()).toContain("No events in this time window");
		expect(process.exitCode).toBeUndefined();
	});
});

// ===========================================
// Merge of local + server, source labelling, dedup
// ===========================================
describe("explainCommand — merge + source label", () => {
	it("merges local and server events and labels source `merged` when the server responds", async () => {
		mocks.readLocalActivity.mockReturnValue([
			localEvent({ agent: "gemini", tool: "Write", summary: "local-only.ts" }),
		]);
		serverResolves({ events: [serverEvent({ tool_input_summary: "server-only.ts" })] });

		await explainCommand({ json: true });

		const parsed = JSON.parse(rawLog());
		expect(parsed.source).toBe("merged");
		expect(parsed.timeline).toHaveLength(2);
		const summaries = parsed.timeline.map((e: { summary: string }) => e.summary);
		expect(summaries).toContain("Wrote local-only.ts");
		expect(summaries).toContain("Read server-only.ts");
	});

	it("labels source `local` and appends `(local only)` when the server feed rejects", async () => {
		mocks.readLocalActivity.mockReturnValue([localEvent({ summary: "offline.ts" })]);
		serverRejects();

		await explainCommand({});

		const out = logged();
		expect(out).toContain("(local only)");
		expect(out).toContain("Wrote offline.ts");
	});

	it("reports `local` source in --json mode when the server is down", async () => {
		mocks.readLocalActivity.mockReturnValue([localEvent()]);
		serverRejects();

		await explainCommand({ json: true });

		expect(JSON.parse(rawLog()).source).toBe("local");
	});

	it("routes a synchronous readLocalActivity throw to the outer catch", async () => {
		// readLocalActivity is called *eagerly* as the argument to Promise.resolve(...)
		// (explain.ts L41), so a synchronous throw propagates BEFORE Promise.allSettled
		// and lands in the outer try/catch — it does NOT become a rejected settled
		// result. (The `localResult.status === "rejected" ? ... : []` arm on L57 is
		// therefore unreachable given readLocalActivity's array return type — see the
		// uncovered-lines note in the task report.)
		mocks.readLocalActivity.mockImplementation(() => {
			throw new Error("activity.jsonl unreadable");
		});
		serverResolves({ events: [serverEvent({ tool_input_summary: "server-survives.ts" })] });

		await explainCommand({});

		// Nothing rendered to stdout; the error surfaced via outputError.
		expect(logged()).toBe("");
		expect(errored()).toContain("Error: activity.jsonl unreadable");
		expect(process.exitCode).toBe(1);
	});

	it("dedups a local event that collides with an authoritative server event", async () => {
		// Same agent|type|tool inside the same 2s bucket → mergeAndDedup drops the local copy.
		const sameTs = isoAgo(3 * MIN);
		mocks.readLocalActivity.mockReturnValue([
			localEvent({ agent: "claude", type: "tool_use", tool: "Read", summary: "dup.ts", ts: sameTs }),
		]);
		serverResolves({
			events: [
				serverEvent({
					agent_name: "claude",
					event_type: "tool_use",
					tool_name: "Read",
					tool_input_summary: "dup.ts",
					occurred_at: sameTs,
				}),
			],
		});

		await explainCommand({ json: true });

		// Only the server copy survives.
		expect(JSON.parse(rawLog()).timeline).toHaveLength(1);
	});
});

// ===========================================
// Per-event normalization: ts fallback, tool/summary ?? null, resolveAgentName
// ===========================================
describe("explainCommand — event normalization", () => {
	it("skips a merged event that has no timestamp at all (the `!ts` continue)", async () => {
		// A server event with none of occurred_at/timestamp/created_at is pushed by
		// mergeAndDedup but skipped in the timeline build.
		const noTs = omit(serverEvent({ tool_input_summary: "ghost.ts" }), "occurred_at");
		serverResolves({
			events: [noTs, serverEvent({ tool_input_summary: "real.ts" })],
		});

		await explainCommand({ json: true });

		const summaries = JSON.parse(rawLog()).timeline.map((e: { summary: string }) => e.summary);
		expect(summaries).toContain("Read real.ts");
		expect(summaries).not.toContain("Read ghost.ts");
	});

	it("derives the ts from `timestamp` then `created_at` when `occurred_at` is missing", async () => {
		// occurred_at absent → falls to `timestamp`.
		const byTimestamp = omit(
			serverEvent({ timestamp: isoAgo(2 * MIN), tool_input_summary: "by-timestamp.ts" }),
			"occurred_at",
		);
		// occurred_at + timestamp absent → falls to `created_at`.
		const byCreated = omit(
			serverEvent({ created_at: isoAgo(4 * MIN), tool_input_summary: "by-created.ts" }),
			"occurred_at",
		);
		serverResolves({ events: [byTimestamp, byCreated] });

		await explainCommand({ json: true });

		const summaries = JSON.parse(rawLog()).timeline.map((e: { summary: string }) => e.summary);
		expect(summaries).toContain("Read by-timestamp.ts");
		expect(summaries).toContain("Read by-created.ts");
	});

	it("coerces a local event's null tool/summary into the normalized shape", async () => {
		// tool/summary undefined on the local event → `?? null` → ActivityEvent with
		// tool_name:null, tool_input_summary:null → formatActivitySummary's default arm.
		mocks.readLocalActivity.mockReturnValue([
			omit(localEvent({ type: "tool_use" }), "tool", "summary"),
		]);
		serverResolves({ events: [] });

		await explainCommand({});

		// tool_name null → "unknown tool", no input → "Used unknown tool".
		expect(logged()).toContain("Used unknown tool");
	});

	it("resolveAgentName uses agent_name, then agent, then 'unknown'", async () => {
		const byName = serverEvent({ agent_name: "by-name", occurred_at: isoAgo(1 * MIN) });
		// agent_name absent, `agent` present.
		const byAgent = omit(
			serverEvent({ agent: "by-agent", occurred_at: isoAgo(2 * MIN) }),
			"agent_name",
		);
		// neither present → "unknown".
		const noAgent = omit(
			serverEvent({ occurred_at: isoAgo(3 * MIN) }),
			"agent_name",
			"agent",
		);
		serverResolves({ events: [byName, byAgent, noAgent] });

		await explainCommand({ json: true });

		const agents = JSON.parse(rawLog()).timeline.map((e: { agent: string }) => e.agent);
		expect(agents).toContain("by-name");
		expect(agents).toContain("by-agent");
		expect(agents).toContain("unknown");
	});
});

// ===========================================
// Time-window + agent filters
// ===========================================
describe("explainCommand — filtering", () => {
	it("drops events older than the since-window cutoff", async () => {
		serverResolves({
			events: [
				serverEvent({ occurred_at: isoAgo(10 * MIN), tool_input_summary: "recent.ts" }),
				// 2h ago, outside the default 1h window.
				serverEvent({ occurred_at: isoAgo(120 * MIN), tool_input_summary: "ancient.ts" }),
			],
		});

		await explainCommand({});

		expect(logged()).toContain("recent.ts");
		expect(logged()).not.toContain("ancient.ts");
	});

	it("keeps only the named agent's events when --agent is set", async () => {
		serverResolves({
			events: [
				serverEvent({ agent_name: "claude", tool_input_summary: "claude-file.ts", occurred_at: isoAgo(1 * MIN) }),
				serverEvent({ agent_name: "gemini", tool_input_summary: "gemini-file.ts", occurred_at: isoAgo(2 * MIN) }),
			],
		});

		await explainCommand({ agent: "claude" });

		const out = logged();
		expect(out).toContain("claude-file.ts");
		expect(out).not.toContain("gemini-file.ts");
		expect(out).toContain("for claude");
	});

	it("sorts the surviving events into ascending (narrative) order", async () => {
		serverResolves({
			events: [
				serverEvent({ tool_input_summary: "second.ts", occurred_at: isoAgo(5 * MIN) }),
				serverEvent({ tool_input_summary: "first.ts", occurred_at: isoAgo(20 * MIN) }),
				serverEvent({ tool_input_summary: "third.ts", occurred_at: isoAgo(1 * MIN) }),
			],
		});

		await explainCommand({ json: true });

		const summaries = JSON.parse(rawLog()).timeline.map((e: { summary: string }) => e.summary);
		expect(summaries).toEqual(["Read first.ts", "Read second.ts", "Read third.ts"]);
	});
});

// ===========================================
// Normal-mode rendering (header, rows, detail, attribution, summary)
// ===========================================
describe("explainCommand — normal mode", () => {
	it("renders the header, an event row, and the trailing event count", async () => {
		serverResolves({ events: [serverEvent({ tool_input_summary: "render.ts" })] });

		await explainCommand({});

		const out = logged();
		expect(out).toContain("Timeline (last 1h)");
		expect(out).toContain("claude");
		expect(out).toContain("Read render.ts");
		expect(out).toContain("1 activity events");
	});

	it("shows the empty-window message and skips the count when nothing matches", async () => {
		// Server resolves empty, no local events.
		await explainCommand({});

		const out = logged();
		expect(out).toContain("Timeline (last 1h)");
		expect(out).toContain("No events in this time window");
		expect(out).not.toContain("activity events");
	});

	it("renders an attribution summary line with the agent-authorship percentage", async () => {
		const attribution: EventAttribution = { agent_lines: 30, human_lines: 10 };
		serverResolves({ events: [serverEvent({ attribution, tool_input_summary: "attr.ts" })] });

		await explainCommand({});

		// 30 / 40 = 75%.
		expect(logged()).toContain("Attribution: Agent wrote 30/40 lines (75%)");
	});

	it("treats a missing human_lines / agent_lines as 0 in the attribution totals", async () => {
		// Each event passes the `agent_lines || human_lines` filter on ONE field, so
		// the reduce hits the `|| 0` fallback (L146/L150) for the other, absent field.
		serverResolves({
			events: [
				serverEvent({
					attribution: { agent_lines: 20 }, // no human_lines → human side falls to 0
					occurred_at: isoAgo(2 * MIN),
					tool_input_summary: "a.ts",
				}),
				serverEvent({
					attribution: { human_lines: 5 }, // no agent_lines → agent side falls to 0
					occurred_at: isoAgo(3 * MIN),
					tool_input_summary: "b.ts",
				}),
			],
		});

		await explainCommand({});

		// agent total 20+0=20, human total 0+5=5, total 25 → 20/25 = 80%.
		expect(logged()).toContain("Attribution: Agent wrote 20/25 lines (80%)");
	});

	it("omits the attribution summary when no event carries agent/human line counts", async () => {
		serverResolves({ events: [serverEvent({ tool_input_summary: "no-attr.ts" })] });

		await explainCommand({});

		expect(logged()).not.toContain("Attribution:");
	});

	it("omits the attribution summary when present-but-zero lines sum to zero", async () => {
		// attribution exists (object truthy) but both counts are 0 → the inner
		// `total > 0` guard suppresses the line. Exercises the present-object,
		// zero-total path distinct from the absent-object path above.
		const attribution: EventAttribution = { agent_lines: 0, human_lines: 0 };
		serverResolves({ events: [serverEvent({ attribution, tool_input_summary: "zero-attr.ts" })] });

		await explainCommand({});

		// The `e.attribution && (agent_lines || human_lines)` filter excludes the
		// zero event, so eventsWithAttribution is empty and no line prints.
		expect(logged()).not.toContain("Attribution:");
	});
});

// ===========================================
// Full mode (detail lines on every row + its own empty-window arm)
// ===========================================
describe("explainCommand — full mode", () => {
	it("renders the full-detail header and a per-event detail line", async () => {
		serverResolves({
			events: [
				serverEvent({
					event_type: "tool_use",
					tool_name: "Bash",
					tool_input_summary: "npm test",
					occurred_at: isoAgo(2 * MIN),
				}),
			],
		});

		await explainCommand({ full: true });

		const out = logged();
		expect(out).toContain("Timeline — Full Detail (last 1h)");
		expect(out).toContain("[activity]");
		expect(out).toContain("Ran: npm test");
		// detail line: "tool_use | Bash | npm test"
		expect(out).toContain("tool_use | Bash | npm test");
	});

	it("falls back to empty strings in the detail line when event fields are missing", async () => {
		// session_start has no tool_name/tool_input_summary → detail is " |  | ".
		const sessionStart = omit(
			serverEvent({ event_type: "session_start", occurred_at: isoAgo(2 * MIN) }),
			"tool_name",
			"tool_input_summary",
		);
		serverResolves({ events: [sessionStart] });

		await explainCommand({ full: true });

		const out = logged();
		expect(out).toContain("Session started");
		// "session_start" present, tool + summary empty → "session_start |  | ".
		expect(out).toContain("session_start |  |");
	});

	it("shows the full-mode empty-window message when nothing matches", async () => {
		await explainCommand({ full: true });

		const out = logged();
		expect(out).toContain("Timeline — Full Detail (last 1h)");
		expect(out).toContain("No events in this time window");
	});

	it("falls the detail line's event_type to an empty string when it is absent", async () => {
		// Exercises L89's `e.event_type || ""` falsy arm: a tool-bearing event with
		// no event_type → detail begins with " | " (empty type) but keeps tool+input.
		const noType = omit(
			serverEvent({ tool_name: "Grep", tool_input_summary: "needle", occurred_at: isoAgo(2 * MIN) }),
			"event_type",
		);
		serverResolves({ events: [noType] });

		await explainCommand({ full: true });

		const out = logged();
		expect(out).toContain("Searched: needle");
		// event_type empty, tool+input present → " | Grep | needle".
		expect(out).toContain("| Grep | needle");
	});

	it("renders the `for <agent>` label in the full-mode header when --agent is set", async () => {
		// Exercises L174's `opts.agent ? ... : ""` truthy arm in the full renderer.
		serverResolves({
			events: [serverEvent({ agent_name: "claude", tool_input_summary: "scoped.ts", occurred_at: isoAgo(1 * MIN) })],
		});

		await explainCommand({ full: true, agent: "claude" });

		expect(logged()).toContain("Timeline — Full Detail (last 1h for claude)");
	});
});

// ===========================================
// JSON mode payload shape + detail attachment
// ===========================================
describe("explainCommand — json mode", () => {
	it("emits the timeline/since/agent/source object with full detail attached", async () => {
		serverResolves({
			events: [serverEvent({ tool_name: "Edit", tool_input_summary: "edit.ts", occurred_at: isoAgo(3 * MIN) })],
		});

		await explainCommand({ json: true, full: true, agent: "claude", since: "2h" });

		const parsed = JSON.parse(rawLog());
		expect(parsed.since).toBe("2h");
		expect(parsed.agent).toBe("claude");
		expect(parsed.source).toBe("merged");
		expect(parsed.timeline).toHaveLength(1);
		expect(parsed.timeline[0]).toMatchObject({
			agent: "claude",
			type: "activity",
			summary: "Edited edit.ts",
			detail: "tool_use | Edit | edit.ts",
		});
	});

	it("carries agent:undefined in the payload when --agent is not set", async () => {
		serverResolves({ events: [serverEvent({ occurred_at: isoAgo(1 * MIN) })] });

		await explainCommand({ json: true });

		const parsed = JSON.parse(rawLog());
		// JSON.stringify drops undefined keys, so `agent` is simply absent.
		expect(parsed).not.toHaveProperty("agent");
		expect(parsed.timeline[0]).not.toHaveProperty("detail");
	});
});

// ===========================================
// Short mode (no `short` renderer → output() falls back to normal)
// ===========================================
describe("explainCommand — short mode", () => {
	it("renders the normal-mode output (explain provides no dedicated short renderer)", async () => {
		serverResolves({ events: [serverEvent({ tool_input_summary: "short.ts" })] });

		await explainCommand({ short: true });

		// Falls through to renderers.normal() → same header + count as normal mode.
		const out = logged();
		expect(out).toContain("Timeline (last 1h)");
		expect(out).toContain("Read short.ts");
		expect(out).toContain("1 activity events");
	});

	it("renders a per-event detail line when --short and --full are combined", async () => {
		// getOutputMode picks "short" (it wins over "full"), so renderNormalTimeline
		// runs via output()'s short→normal fallback — but buildTimeline still reads
		// opts.full to decide whether to attach `detail`, so this combination is the
		// only public path that reaches renderNormalTimeline's own `if (event.detail)`
		// arm (L187-188), distinct from renderFullTimeline's identical-looking one.
		serverResolves({
			events: [
				serverEvent({
					event_type: "tool_use",
					tool_name: "Read",
					tool_input_summary: "detail-hit.ts",
					occurred_at: isoAgo(2 * MIN),
				}),
			],
		});

		await explainCommand({
			short: true,
			full: true,
		});

		const out = logged();
		expect(out).toContain("Timeline (last 1h)"); // the NORMAL header, not the full one
		// renderNormalTimeline's detail arm indents with 24 spaces (renderFullTimeline
		// uses 6) — the exact prefix proves which `if (event.detail)` branch ran.
		expect(out).toContain(`${" ".repeat(24)}tool_use | Read | detail-hit.ts`);
	});
});

// ===========================================
// Outer catch (error path) — exercised via parseDuration throwing
// ===========================================
describe("explainCommand — error handling", () => {
	it("reports an Error message via outputError when parseDuration rejects a bad --since", async () => {
		await explainCommand({ since: "banana" });

		expect(errored()).toContain('Error: Invalid duration "banana"');
		expect(process.exitCode).toBe(1);
		// Nothing was rendered to stdout.
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("routes the caught error through the JSON shape in --json mode", async () => {
		await explainCommand({ since: "nope", json: true });

		const parsed = JSON.parse(errored());
		expect(parsed.error).toContain('Invalid duration "nope"');
		expect(process.exitCode).toBe(1);
	});

	it("coerces a non-Error throw to a string in the catch branch", async () => {
		// Make a boundary throw a non-Error value so `err instanceof Error` is false
		// and the `String(err)` arm runs.
		mocks.getClient.mockImplementation(() => {
			throw "raw-string-blowup";
		});

		await explainCommand({});

		expect(errored()).toContain("Error: raw-string-blowup");
		expect(process.exitCode).toBe(1);
	});
});
