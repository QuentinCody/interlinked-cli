import { wireAbsentOptional, parseWire, wireNumber, wireObject, wireOptional, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked activity — behavioral tests
// ===========================================
// Drives activityCommand through every branch: output modes, local/server
// merge precedence, the server-down (local-only) fallback, --since duration
// filtering, --limit validation, empty vs populated rendering, token totals,
// the localToActivity normalizer, and the catch path. Real formatter / output
// / activity-utils run unmocked so assertions check the actual emitted strings;
// only the I/O boundaries (api-client, local-activity) are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- I/O boundary mocks ---------------------------------------------------
const mockCallTool = vi.fn();
const mockReadLocalActivity = vi.fn();
const mockMergeAndDedup = vi.fn();

vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({ callTool: mockCallTool }),
}));

vi.mock("../lib/local-activity.js", () => ({
	readLocalActivity: (...args: unknown[]) => mockReadLocalActivity(...args),
	mergeAndDedup: (...args: unknown[]) => mockMergeAndDedup(...args),
}));

// Keep ANSI out of the asserted strings so matchers are exact. Must run via
// vi.hoisted: ES imports hoist above module-body statements, so a bare
// assignment here executes AFTER the formatter has already read the env and
// the styled path leaks into assertions (3 tests failed exactly that way).
vi.hoisted(() => {
	process.env.NO_COLOR = "1";
});

import { nonNull } from "../lib/non-null.js";
import { shortTimestamp } from "../lib/formatter.js";
import { activityCommand } from "./activity.js";

// ---- console / exit capture ----------------------------------------------
interface Captured {
	stdout: string;
	stderr: string;
	exitCode: number | undefined;
}

function captureIO(): { read: () => Captured; restore: () => void } {
	let stdout = "";
	let stderr = "";
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const join = (args: unknown[]): string =>
		args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
	const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout += `${join(a)}\n`;
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr += `${join(a)}\n`;
	});
	return {
		read: () => ({
			stdout,
			stderr,
			exitCode: typeof process.exitCode === "number" ? process.exitCode : undefined,
		}),
		restore: () => {
			logSpy.mockRestore();
			errSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

/** Parse the last console.log call as the JSON payload activityCommand printed. */
function lastJson(io: { read: () => Captured }): {
	events: Array<Record<string, unknown>>;
	source: string;
} {
	const out = io.read().stdout.trim();
	// In JSON mode there is exactly one log line.
	return JSON.parse(out);
}

let io: ReturnType<typeof captureIO>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-06-06T12:00:00Z"));
	mockCallTool.mockReset();
	mockReadLocalActivity.mockReset();
	mockMergeAndDedup.mockReset();
	// Default merge: server-first then local (mirrors the real precedence-free
	// concat the regression suite uses); individual tests override as needed.
	mockMergeAndDedup.mockImplementation((local: unknown[], server: unknown[]) => [
		...server,
		...local,
	]);
	io = captureIO();
});

afterEach(() => {
	io.restore();
	vi.useRealTimers();
});

// A fully-populated local row as readLocalActivity returns it (pre-normalize).
function localRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ts: "2026-06-06T11:59:00.000Z",
		agent: "local-agent",
		type: "tool_use",
		tool: "Edit",
		summary: "src/app.ts",
		tokens: { input: 10, output: 20, cache_read: 5, cache_creation: 3 },
		duration_ms: 42,
		files_modified: ["src/app.ts"],
		...over,
	};
}

describe("activityCommand — --limit validation", () => {
	it("rejects a non-numeric --limit before touching any source", async () => {
		await activityCommand({ limit: "abc" });
		const { stderr, exitCode } = io.read();
		expect(stderr).toContain('Invalid --limit value "abc"');
		expect(stderr).toContain("Expected a positive integer");
		expect(exitCode).toBe(1);
		// Early return: neither source was consulted.
		expect(mockReadLocalActivity).not.toHaveBeenCalled();
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("rejects a zero / negative --limit", async () => {
		await activityCommand({ limit: "0" });
		expect(io.read().stderr).toContain('Invalid --limit value "0"');
		expect(io.read().exitCode).toBe(1);
		io.read().exitCode; // settle
		await activityCommand({ limit: "-5" });
		expect(io.read().stderr).toContain('Invalid --limit value "-5"');
	});

	it("emits a structured JSON error for a bad --limit in --json mode", async () => {
		await activityCommand({ limit: "nope", json: true });
		const parsed = JSON.parse(io.read().stderr.trim());
		expect(parsed.error).toContain('Invalid --limit value "nope"');
		expect(io.read().exitCode).toBe(1);
	});
});

describe("activityCommand — source precedence (JSON mode)", () => {
	it("labels source 'merged' and runs mergeAndDedup when both sources are non-empty", async () => {
		mockReadLocalActivity.mockReturnValue([localRow()]);
		mockCallTool.mockResolvedValue({
			events: [{ agent_name: "srv", event_type: "tool_use", tool_name: "Read", occurred_at: "2026-06-06T11:58:00.000Z" }],
		});

		await activityCommand({ json: true, limit: "10" });

		const payload = lastJson(io);
		expect(payload.source).toBe("merged");
		expect(mockMergeAndDedup).toHaveBeenCalledTimes(1);
		// Both the local (normalized) and server (tagged) events are present.
		expect(payload.events.map((e) => e._source).sort()).toEqual(["local", "server"]);
	});

	it("labels source 'server' and skips merge when local is empty", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			activities: [{ agent_name: "srv", event_type: "tool_use", occurred_at: "2026-06-06T11:58:00.000Z" }],
		});

		await activityCommand({ json: true, limit: "10" });

		const payload = lastJson(io);
		expect(payload.source).toBe("server");
		expect(mockMergeAndDedup).not.toHaveBeenCalled();
		expect(payload.events).toHaveLength(1);
		expect(nonNull(payload.events[0])._source).toBe("server");
	});

	it("labels source 'local' and skips merge when the server is down", async () => {
		mockReadLocalActivity.mockReturnValue([localRow()]);
		mockCallTool.mockRejectedValue(new Error("ECONNREFUSED"));

		await activityCommand({ json: true, limit: "10" });

		const payload = lastJson(io);
		expect(payload.source).toBe("local");
		expect(mockMergeAndDedup).not.toHaveBeenCalled();
		expect(payload.events).toHaveLength(1);
		expect(nonNull(payload.events[0])._source).toBe("local");
	});

	it("returns an empty set (source 'local') when server is down AND local is empty", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockRejectedValue(new Error("offline"));

		await activityCommand({ json: true, limit: "10" });

		const payload = lastJson(io);
		expect(payload.events).toEqual([]);
		// isServerDown wins the eventSource ternary even when local is also empty.
		expect(payload.source).toBe("local");
	});
});

describe("activityCommand — server result field variants & null-coalescing", () => {
	it.each([
		["events", "events"],
		["activities", "activities"],
		["activity", "activity"],
	])("reads server rows from the '%s' field", async (field) => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			[field]: [{ agent_name: "srv", event_type: "x", occurred_at: "2026-06-06T11:58:00.000Z" }],
		});

		await activityCommand({ json: true, limit: "5" });
		expect(lastJson(io).events).toHaveLength(1);
	});

	it("tolerates a null tool result (?? / || chain) and yields an empty server set", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue(null);

		await activityCommand({ json: true, limit: "5" });
		const payload = lastJson(io);
		// local empty + server (null→[]) empty → eventSource is "server"
		expect(payload.source).toBe("server");
		expect(payload.events).toEqual([]);
	});

	it("tolerates a result object with none of the known fields", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ unrelated: true });

		await activityCommand({ json: true, limit: "5" });
		expect(lastJson(io).events).toEqual([]);
	});
});

describe("activityCommand — --since duration filter", () => {
	it("passes the computed since timestamp to readLocalActivity and filters server rows by age", async () => {
		// now = 2026-06-06T12:00:00Z; 1h window → cutoff 11:00:00Z.
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [
				{ agent_name: "fresh", event_type: "x", occurred_at: "2026-06-06T11:30:00.000Z" },
				{ agent_name: "stale", event_type: "x", occurred_at: "2026-06-06T09:00:00.000Z" },
			],
		});

		await activityCommand({ json: true, since: "1h", limit: "10" });

		// readLocalActivity received a numeric `since` cutoff.
		const callArg = parseWire(nonNull(mockReadLocalActivity.mock.calls[0])[0], wireObject({ "since": wireAbsentOptional(wireOptional(wireNumber)), "limit": wireNumber }), "test JSON value");
		expect(callArg.since).toBe(Date.parse("2026-06-06T11:00:00.000Z"));
		expect(callArg.limit).toBe(20); // limit * 2

		const payload = lastJson(io);
		expect(payload.events).toHaveLength(1);
		expect(nonNull(payload.events[0]).agent_name).toBe("fresh");
	});

	it("keeps server rows that carry no timestamp at all (filter returns true)", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [{ agent_name: "no-ts", event_type: "x" }],
		});

		await activityCommand({ json: true, since: "30m", limit: "10" });
		expect(lastJson(io).events).toHaveLength(1);
	});

	it("surfaces a parseDuration error through the catch path", async () => {
		await activityCommand({ since: "banana", limit: "10" });
		const { stderr, exitCode } = io.read();
		expect(stderr).toContain('Invalid duration "banana"');
		expect(exitCode).toBe(1);
	});

	it("does not call readLocalActivity with a since key when --since is absent", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ events: [] });
		await activityCommand({ json: true, limit: "10" });
		const callArg = parseWire(nonNull(mockReadLocalActivity.mock.calls[0])[0], wireRecord(wireUnknown), "test JSON value");
		expect(callArg).not.toHaveProperty("since");
	});
});

describe("activityCommand — agent filter wiring", () => {
	it("forwards --agent to both readLocalActivity and the server tool call", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({ json: true, agent: "agent-x", limit: "7" });

		expect(nonNull(mockReadLocalActivity.mock.calls[0])[0]).toMatchObject({ agent: "agent-x" });
		expect(mockCallTool).toHaveBeenCalledWith("query_activity_feed", {
			limit: 14,
			agent_name: "agent-x",
		});
	});

	it("omits agent_name from the server call when --agent is not given", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({ json: true, limit: "7" });
		expect(mockCallTool).toHaveBeenCalledWith("query_activity_feed", { limit: 14 });
		expect(nonNull(mockReadLocalActivity.mock.calls[0])[0]).not.toHaveProperty("agent");
	});
});

describe("activityCommand — limit applied after merge", () => {
	it("slices the merged set down to --limit", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: Array.from({ length: 5 }, (_, i) => ({
				agent_name: `srv-${i}`,
				event_type: "x",
				occurred_at: "2026-06-06T11:58:00.000Z",
			})),
		});

		await activityCommand({ json: true, limit: "2" });
		expect(lastJson(io).events).toHaveLength(2);
	});
});

describe("activityCommand — normal (table) rendering", () => {
	it("prints the empty-state line when there is no activity", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		expect(stdout).toContain("Activity Feed");
		expect(stdout).toContain("Activity Feed\n");
		expect(stdout).toContain("No recent activity");
		// No "(local)" suffix when the server responded (empty) successfully.
		expect(stdout).not.toContain("(local)");
	});

	it("appends the '(local)' label when serving local-only after a server failure", async () => {
		mockReadLocalActivity.mockReturnValue([localRow()]);
		mockCallTool.mockRejectedValue(new Error("down"));

		await activityCommand({ limit: "10" });
		expect(io.read().stdout).toContain("Activity Feed (local)");
	});

	it("does not label an empty local fallback as '(local)'", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockRejectedValue(new Error("down"));

		await activityCommand({ limit: "10" });

		const stdout = io.read().stdout;
		expect(stdout).toContain("Activity Feed\n");
		expect(stdout).not.toContain("Activity Feed (local)");
	});

	it("renders a populated table with the token totals footer", async () => {
		mockReadLocalActivity.mockReturnValue([localRow()]);
		mockCallTool.mockRejectedValue(new Error("down")); // local-only, deterministic order

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		// Column headers
		for (const h of ["Time", "Agent", "Event", "Tool", "Summary", "Duration", "Tokens"]) {
			expect(stdout).toContain(h);
		}
		// Row values from localRow()
		expect(stdout).toContain("local-agent");
		expect(stdout).toContain("tool_use");
		expect(stdout).toContain("Edit");
		expect(stdout).toContain("src/app.ts");
		expect(stdout).toContain("42ms"); // duration_ms present
		expect(stdout).toContain("30 tok"); // input(10)+output(20) per-row token cell
		// Totals footer: tokenEventCount === 1
		expect(stdout).toContain("Totals");
		expect(stdout).toContain("Totals: 10 in / 20 out / 5 cache");
		expect(stdout).toContain("across 1 events");
		expect(stdout).toContain("Activity Feed (local)\n");
	});

	it("omits the totals footer when no row carries token data", async () => {
		mockReadLocalActivity.mockReturnValue([localRow({ tokens: undefined, duration_ms: undefined })]);
		mockCallTool.mockRejectedValue(new Error("down"));

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		expect(stdout).not.toContain("Totals");
		// duration_ms absent → dash cell, no "ms" suffix for this row's duration.
		expect(stdout).not.toContain("42ms");
		expect(stdout).not.toContain("undefinedms");
	});

	it("resolves a row timestamp from ts / timestamp / created_at fallbacks", async () => {
		// Local empty + server up → table renders the server rows. Each row omits
		// occurred_at so the `e.occurred_at || e.ts || e.timestamp || e.created_at`
		// chain falls through to the next field in turn.
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [
				{ agent_name: "a1", event_type: "x", ts: "2026-06-06T11:55:00.000Z" },
				{ agent_name: "a2", event_type: "x", timestamp: "2026-06-06T11:56:00.000Z" },
				{ agent_name: "a3", event_type: "x", created_at: "2026-06-06T11:57:00.000Z" },
			],
		});

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		// All three rows rendered (timestamps resolved, not blank-dropped).
		for (const a of ["a1", "a2", "a3"]) expect(stdout).toContain(a);
		for (const timestamp of [
			"2026-06-06T11:55:00.000Z",
			"2026-06-06T11:56:00.000Z",
			"2026-06-06T11:57:00.000Z",
		]) {
			expect(stdout).toContain(shortTimestamp(timestamp));
		}
	});

	it("includes a server event exactly on the --since cutoff", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [{ agent_name: "boundary", event_type: "x", occurred_at: "2026-06-06T11:00:00.000Z" }],
		});

		await activityCommand({ json: true, since: "1h", limit: "10" });

		expect(lastJson(io).events).toHaveLength(1);
	});

	it("zero-fills missing token sub-fields in both the per-row cell and the totals", async () => {
		// Server rows (local empty) with partial token objects exercise the
		// `e.tokens.input || 0` style fallbacks at L166 and L183-186.
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [
				// only output present → input || 0 fires (row cell + totals.input)
				{ agent_name: "out", event_type: "x", occurred_at: "2026-06-06T11:58:00.000Z", tokens: { output: 7 } },
				// only input present → output || 0, cache_read || 0, cache_creation || 0
				{ agent_name: "in", event_type: "x", occurred_at: "2026-06-06T11:58:30.000Z", tokens: { input: 4 } },
			],
		});

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		// Per-row cells: 0+7 and 4+0.
		expect(stdout).toContain("7 tok");
		expect(stdout).toContain("4 tok");
		// Totals footer aggregates both token-bearing rows.
		expect(stdout).toContain("across 2 events");
	});

	it("falls back to '-' for missing agent / event / tool fields in a row", async () => {
		// A server row (local empty) with only a timestamp — every display field
		// other than time is missing, exercising the || c.dim('-') fallbacks.
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({
			events: [{ occurred_at: "2026-06-06T11:58:00.000Z" }],
		});

		await activityCommand({ limit: "10" });
		const { stdout } = io.read();
		expect(stdout).toContain("Activity Feed");
		// With NO_COLOR the missing display fields are five bare dash cells.
		expect((stdout.match(/-/g) ?? []).length).toBe(5);
		// Missing summary uses the empty fallback, not a mutation marker.
		expect(stdout).not.toContain("Stryker was here!");
	});
});

describe("activityCommand — localToActivity normalization", () => {
	it("maps local field names onto the canonical ActivityEvent shape", async () => {
		mockReadLocalActivity.mockReturnValue([localRow()]);
		mockCallTool.mockRejectedValue(new Error("down"));

		await activityCommand({ json: true, limit: "10" });
		const ev = lastJson(io).events[0];
		expect(ev).toMatchObject({
			agent_name: "local-agent",
			event_type: "tool_use",
			tool_name: "Edit",
			tool_input_summary: "src/app.ts",
			occurred_at: "2026-06-06T11:59:00.000Z",
			ts: "2026-06-06T11:59:00.000Z",
			duration_ms: 42,
			files_modified: ["src/app.ts"],
			_source: "local",
		});
		expect(nonNull(ev)).toHaveProperty(["tokens","input"], 10);
	});

	it("coalesces null tool/summary to null and drops absent optional fields", async () => {
		mockReadLocalActivity.mockReturnValue([
			{ ts: "2026-06-06T11:59:00.000Z", agent: "a", type: "session_end", tool: null, summary: null },
		]);
		mockCallTool.mockRejectedValue(new Error("down"));

		await activityCommand({ json: true, limit: "10" });
		const ev = lastJson(io).events[0];
		expect(nonNull(ev).tool_name).toBeNull();
		expect(nonNull(ev).tool_input_summary).toBeNull();
		// Optional fields were undefined on input → omitted from the object.
		expect(ev).not.toHaveProperty("tokens");
		expect(ev).not.toHaveProperty("duration_ms");
		expect(ev).not.toHaveProperty("files_modified");
	});
});

describe("activityCommand — catch path", () => {
	it("reports the message of a thrown Error", async () => {
		mockReadLocalActivity.mockImplementation(() => {
			throw new Error("local read blew up");
		});
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({ limit: "10" });
		expect(io.read().stderr).toContain("local read blew up");
		expect(io.read().exitCode).toBe(1);
	});

	it("stringifies a non-Error throw", async () => {
		mockReadLocalActivity.mockImplementation(() => {
			throw "string failure";
		});
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({ json: true, limit: "10" });
		const parsed = JSON.parse(io.read().stderr.trim());
		expect(parsed.error).toBe("string failure");
	});
});

describe("activityCommand — defaults", () => {
	it("defaults to a limit of 30 (server call requests limit*2 = 60)", async () => {
		mockReadLocalActivity.mockReturnValue([]);
		mockCallTool.mockResolvedValue({ events: [] });

		await activityCommand({});
		expect(nonNull(mockReadLocalActivity.mock.calls[0])[0]).toMatchObject({ limit: 60 });
		expect(mockCallTool).toHaveBeenCalledWith("query_activity_feed", { limit: 60 });
	});
});
