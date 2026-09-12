// ===========================================
// interlinked skill — behavioral tests
// ===========================================
// Covers skillEnter / skillLeave / skillList command handlers plus the private
// socket-send path (via createConnection mock) and the ttl/format helpers
// exercised through the public surface. Module boundaries (node:fs, node:net,
// ./harness.js) are mocked; console.log/console.error are spied; process.exitCode
// is asserted. Deterministic: no Date.now/Math.random in fixtures, fake timers
// drive the socket-timeout branch.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- module-boundary mocks --------------------------------------------------

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock("node:fs", () => ({
	existsSync: (p: string) => existsSyncMock(p),
}));

const createConnectionMock = vi.fn();
vi.mock("node:net", () => ({
	createConnection: (...args: unknown[]) => createConnectionMock(...args),
}));

vi.mock("./harness.js", () => ({
	getSocketPath: () => "/tmp/fake-harness.sock",
}));

import { nonNull } from "../lib/non-null.js";
import {
	skillEnterCommand,
	skillLeaveCommand,
	skillListCommand,
} from "./skill.js";

// ---- fake socket helper -----------------------------------------------------

// A controllable stand-in for the net.Socket returned by createConnection.
// Tests push it through connect/data/error to drive each branch of
// sendSkillEvent deterministically. `written` records the payload framing.
class FakeSocket extends EventEmitter {
	written: string[] = [];
	destroyed = false;
	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

const stripAnsi = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "");

// Collected console output (ANSI-stripped) for assertions.
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = [];
	errs = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(stripAnsi(a.map(String).join(" ")));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(stripAnsi(a.map(String).join(" ")));
	});
	existsSyncMock.mockReset();
	createConnectionMock.mockReset();
	// Default: socket exists. Individual tests override.
	existsSyncMock.mockReturnValue(true);
	process.exitCode = 0;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = 0;
	vi.useRealTimers();
});

// Wire createConnection to return a FakeSocket and, after the handlers attach
// their listeners (next microtask via queueMicrotask), drive it to emit a
// successful reply line carrying `reply`.
function wireSuccessfulReply(reply: unknown): FakeSocket {
	const sock = new FakeSocket();
	createConnectionMock.mockImplementation(() => {
		queueMicrotask(() => {
			sock.emit("connect");
			sock.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`));
		});
		return sock;
	});
	return sock;
}

// =============================================================================
// skillEnterCommand
// =============================================================================

describe("skillEnterCommand", () => {
	it.each([null, [], "allow", 1, true])("reports a non-object daemon reply as unavailable: %j", async (reply) => {
		const sock = wireSuccessfulReply(reply);
		await skillEnterCommand("example", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(sock.destroyed).toBe(true);
	});
	// test-contract: boundary — errors and sets exitCode=1 when name is empty/whitespace
	it("errors and sets exitCode=1 when name is empty/whitespace", async () => {
		await skillEnterCommand("   ", {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
		// Never attempts a socket connection on bad input.
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	// test-contract: boundary — errors and sets exitCode=1 when name is undefined (optional-chain branch)
	it("errors and sets exitCode=1 when name is undefined (optional-chain branch)", async () => {
		// name?.trim() with undefined exercises the ?. branch.
		await skillEnterCommand(undefined, {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — errors on invalid --ttl
	it("errors on invalid --ttl", async () => {
		await skillEnterCommand("deep-research", { ttl: "abc" });
		expect(errs.join("\n")).toContain("invalid --ttl 'abc'");
		expect(process.exitCode).toBe(1);
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	// test-contract: boundary — errors when harness unreachable (no reply)
	it("errors when harness unreachable (no reply)", async () => {
		existsSyncMock.mockReturnValue(false); // socket missing → sendSkillEvent resolves null
		await skillEnterCommand("deep-research", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — enters with a ttl and prints normal output including ttl suffix
	it("enters with a ttl and prints normal output including ttl suffix", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("deep-research", { ttl: "30m" });
		expect(process.exitCode).toBe(0);
		const out = logs.join("\n");
		expect(out).toContain("skill entered: deep-research");
		expect(out).toContain("ttl 30m");
		// Payload framing: trailing newline + SkillEnter event with ttl_seconds.
		expect(sock.written).toHaveLength(1);
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.hook_event).toBe("SkillEnter");
		expect(payload.agent_source).toBe("cli");
		expect(payload.tool_input).toMatchObject({ name: "deep-research", ttl_seconds: 1800 });
	});

	// test-contract: public-api — enters without a ttl (no ttl suffix; ttl_seconds null in json)
	it("enters without a ttl (no ttl suffix; ttl_seconds null in json)", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("verify", { json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "verify", status: "entered", ttl_seconds: null });
	});

	// test-contract: invariant — normal output omits ttl suffix when no ttl given
	it("normal output omits ttl suffix when no ttl given", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("verify", {});
		const out = logs.join("\n");
		expect(out).toContain("skill entered: verify");
		expect(out).not.toContain("ttl ");
	});

	// test-contract: invariant — passes through --source and --session into the payload
	it("passes through --source and --session into the payload", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", { source: "manual", session: "sess-123" });
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.session_id).toBe("sess-123");
		expect(payload.tool_input).toMatchObject({ name: "review", source: "manual" });
		// No ttl → no ttl_seconds key.
		expect(payload.tool_input.ttl_seconds).toBeUndefined();
	});

	// test-contract: boundary — defaults session_id to empty string when --session omitted
	it("defaults session_id to empty string when --session omitted", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", {});
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.session_id).toBe("");
	});

	// test-contract: public-api — json output reports ttl_seconds when a ttl is present
	it("json output reports ttl_seconds when a ttl is present", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("review", { ttl: "2h", json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "review", status: "entered", ttl_seconds: 7200 });
	});
});

// =============================================================================
// skillLeaveCommand
// =============================================================================

describe("skillLeaveCommand", () => {
	// test-contract: boundary — errors and sets exitCode=1 when name is empty
	it("errors and sets exitCode=1 when name is empty", async () => {
		await skillLeaveCommand("  ", {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	// test-contract: boundary — errors when harness unreachable
	it("errors when harness unreachable", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillLeaveCommand("deep-research", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: public-api — leaves and prints normal output
	it("leaves and prints normal output", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("deep-research", { session: "s1" });
		expect(process.exitCode).toBe(0);
		expect(logs.join("\n")).toContain("skill left: deep-research");
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.hook_event).toBe("SkillLeave");
		expect(payload.session_id).toBe("s1");
		expect(payload.tool_input).toEqual({ name: "deep-research" });
	});

	// test-contract: public-api — leaves with json output
	it("leaves with json output", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("deep-research", { json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ skill: "deep-research", status: "left" });
	});
});

// =============================================================================
// skillListCommand
// =============================================================================

describe("skillListCommand", () => {
	// test-contract: boundary — errors when harness unreachable
	it("errors when harness unreachable", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillListCommand({});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — errors on malformed skill list JSON
	it("errors on malformed skill list JSON", async () => {
		wireSuccessfulReply({ additional_context: "{not json" });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — prints 'No active sessions.' when list is empty array
	it("prints 'No active sessions.' when list is empty array", async () => {
		wireSuccessfulReply({ additional_context: "[]" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
		expect(process.exitCode).toBe(0);
	});

	// test-contract: boundary — treats missing additional_context (non-string) as empty list
	it("treats missing additional_context (non-string) as empty list", async () => {
		// raw is undefined → the `typeof raw === "string"` guard is false.
		wireSuccessfulReply({ decision: "allow" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
	});

	// test-contract: boundary — treats empty-string additional_context as empty list
	it("treats empty-string additional_context as empty list", async () => {
		// raw === "" → length > 0 guard is false, parsed stays [].
		wireSuccessfulReply({ additional_context: "" });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active sessions.");
	});

	// test-contract: public-api — prints 'No active skills across all sessions.' when sessions have no skills
	it("prints 'No active skills across all sessions.' when sessions have no skills", async () => {
		const sessions = [{ session_id: "abcdef0123", agent_name: "agentA", skills: [] }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("No active skills across all sessions.");
	});

	// test-contract: public-api — renders a table for sessions with active skills (normal mode)
	it("renders a table for sessions with active skills (normal mode)", async () => {
		const sessions = [
			{
				session_id: "abcdef0123456789",
				agent_name: "agentA",
				skills: [
					{
						name: "deep-research",
						entered_at: 0, // epoch → ISO 00:00:00
						expires_at: 60_000, // 60s from epoch
						source: "cli",
					},
				],
			},
			// A second session with no skills exercises the `continue` branch.
			{ session_id: "zzzz", agent_name: "agentB", skills: [] },
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toContain("Active skills");
		expect(out).toContain("agentA");
		expect(out).toContain("(abcdef01)"); // session id sliced to 8 chars
		expect(out).toContain("deep-research");
		expect(out).toContain("cli");
		expect(out).toContain("00:00:00"); // entered (utc) from entered_at=0
		expect(out).toContain("total");
		// agentB has no skills → must not appear as a section header row.
		expect(out).not.toContain("agentB");
	});

	// test-contract: public-api — returns parsed list verbatim in json mode
	it("returns parsed list verbatim in json mode", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: 0, expires_at: 1000, source: "hook" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({ json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual(sessions);
	});

	// test-contract: public-api — sends a SkillList event with the given session id
	it("sends a SkillList event with the given session id", async () => {
		const sock = wireSuccessfulReply({ additional_context: "[]" });
		await skillListCommand({ session: "sx" });
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.hook_event).toBe("SkillList");
		expect(payload.session_id).toBe("sx");
		expect(payload.tool_input).toEqual({});
	});
});

// =============================================================================
// parseSkillListSessions / parseSkillListSession / parseActiveSkillRecord —
// boundary validation of the harness's SkillList reply (valid JSON, but
// possibly the wrong shape — distinct from the JSON-syntax-error case above,
// which the pre-existing "errors on malformed skill list JSON" test covers).
// =============================================================================

describe("skillListCommand — skill-list boundary parsers (valid JSON, wrong shape)", () => {
	// test-contract: invariant — P1: accepts a well-formed session list (positive control)
	it("P1: accepts a well-formed session list (positive control)", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: 0, expires_at: 1000, source: "manual" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({ json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual(sessions);
	});

	// test-contract: boundary — N1: rejects a top-level object instead of an array
	it("N1: rejects a top-level object instead of an array", async () => {
		wireSuccessfulReply({ additional_context: JSON.stringify({ not: "an array" }) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — N2: rejects a session missing the skills array
	it("N2: rejects a session missing the skills array", async () => {
		const sessions = [{ session_id: "s1", agent_name: "a1" }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — N3: rejects a skill record with an unrecognized source value
	it("N3: rejects a skill record with an unrecognized source value", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: 0, expires_at: 1000, source: "bogus" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — N4: rejects a skill record whose entered_at is a string, not a number
	it("N4: rejects a skill record whose entered_at is a string, not a number", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: "zero", expires_at: 1000, source: "cli" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: boundary — N5: rejects a session missing session_id (previously passed through verbatim by the unchecked cast)
	it("N5: rejects a session missing session_id (previously passed through verbatim by the unchecked cast)", async () => {
		const sessions = [{ agent_name: "a1", skills: [] }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({ json: true });
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});
});

// =============================================================================
// parseTtl — exercised via skillEnter (valid units) + invalid paths
// =============================================================================

describe("parseTtl (via skillEnterCommand)", () => {
	const cases: Array<[string, number]> = [
		["90s", 90],
		["90sec", 90],
		["45", 45], // bare number → seconds default
		["5m", 300],
		["5min", 300],
		["1h", 3600],
		["2hr", 7200],
	];
	for (const [input, seconds] of cases) {
		// test-contract: invariant — parses '${input}' → ${seconds}s
		it(`parses '${input}' → ${seconds}s`, async () => {
			wireSuccessfulReply({ decision: "allow" });
			await skillEnterCommand("x", { ttl: input, json: true });
			const parsed = JSON.parse(logs.join("\n"));
			expect(parsed.ttl_seconds).toBe(seconds);
		});
	}

	// Truthy-but-unparseable / non-positive inputs all hit the `=== null` guard.
	// (An empty "" is falsy → the `opts.ttl ?` guard skips parseTtl entirely,
	// so it is not a rejection case and is excluded here.)
	const invalid = ["abc", "0", "-5", "0s", "10x"];
	for (const input of invalid) {
		// test-contract: boundary — rejects invalid/non-positive ttl '${input}'
		it(`rejects invalid/non-positive ttl '${input}'`, async () => {
			await skillEnterCommand("x", { ttl: input });
			expect(errs.join("\n")).toContain(`invalid --ttl '${input}'`);
			expect(process.exitCode).toBe(1);
			expect(createConnectionMock).not.toHaveBeenCalled();
		});
	}
});

// =============================================================================
// formatTtl — exercised via skillList expires-in column rendering
// =============================================================================

describe("formatTtl (via skillListCommand rendering)", () => {
	function sessionWithExpiry(expires_at: number): unknown[] {
		return [
			{
				session_id: "sess0001",
				agent_name: "a",
				skills: [{ name: "sk", entered_at: 0, expires_at, source: "cli" }],
			},
		];
	}

	// test-contract: public-api — formats sub-minute as seconds
	it("formats sub-minute as seconds", async () => {
		// Date.now() ~ large; expires_at small → max(0, ...) clamps to 0s.
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(0)) });
		await skillListCommand({});
		expect(logs.join("\n")).toContain("0s");
	});

	// test-contract: public-api — formats minutes band
	it("formats minutes band", async () => {
		const expires = Date.now() + 300_000; // +5m
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		expect(logs.join("\n")).toMatch(/\b5m\b/);
	});

	// test-contract: public-api — formats hours band
	it("formats hours band", async () => {
		const expires = Date.now() + 7_200_000; // +2h
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		expect(logs.join("\n")).toMatch(/\b2h\b/);
	});

	// test-contract: mutation-kill — pins the `seconds < 60` boundary; a
	// `<=` mutant would format exactly 60s as "60s" instead of "1m".
	it("formats exactly 60s as '1m', not '60s' (boundary)", async () => {
		const expires = Date.now() + 60_000;
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toMatch(/\b1m\b/);
		expect(out).not.toContain("60s");
	});

	// test-contract: mutation-kill — pins the `seconds < 3600` boundary; a
	// `<=` mutant would format exactly 3600s as "60m" instead of "1h".
	it("formats exactly 3600s as '1h', not '60m' (boundary)", async () => {
		const expires = Date.now() + 3_600_000;
		wireSuccessfulReply({ additional_context: JSON.stringify(sessionWithExpiry(expires)) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toMatch(/\b1h\b/);
		expect(out).not.toContain("60m");
	});
});

// =============================================================================
// sendSkillEvent — socket branch coverage (via the public commands)
// =============================================================================

describe("sendSkillEvent socket paths", () => {
	// test-contract: boundary — resolves null when socket file does not exist
	it("resolves null when socket file does not exist", async () => {
		existsSyncMock.mockReturnValue(false);
		await skillEnterCommand("x", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	// test-contract: boundary — resolves null on socket 'error' event
	it("resolves null on socket 'error' event", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => sock.emit("error", new Error("ECONNREFUSED")));
			return sock;
		});
		await skillEnterCommand("x", {});
		expect(errs.join("\n")).toContain("Could not reach harness");
	});

	// test-contract: boundary — resolves null when the reply line is not valid JSON
	it("resolves null when the reply line is not valid JSON", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => {
				sock.emit("connect");
				sock.emit("data", Buffer.from("not-json\n"));
			});
			return sock;
		});
		await skillEnterCommand("x", {});
		// Bad reply parse → resolve(null) → "could not reach" path.
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(sock.destroyed).toBe(true);
	});

	// test-contract: invariant — buffers across chunks and parses once a newline arrives
	it("buffers across chunks and parses once a newline arrives", async () => {
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => {
				sock.emit("connect");
				// Split the JSON across two data events; no newline until the 2nd.
				sock.emit("data", Buffer.from('{"decision":'));
				sock.emit("data", Buffer.from('"allow"}\n'));
			});
			return sock;
		});
		await skillEnterCommand("x", {});
		expect(logs.join("\n")).toContain("skill entered: x");
		expect(sock.destroyed).toBe(true);
	});

	// test-contract: public-api — times out and resolves null when no data arrives
	it("times out and resolves null when no data arrives", async () => {
		vi.useFakeTimers();
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			// connect, but never emit data → setTimeout fires.
			queueMicrotask(() => sock.emit("connect"));
			return sock;
		});
		const p = skillEnterCommand("x", {});
		// Let the microtask attach listeners + emit connect, then advance the
		// 2000ms socket timeout so the timeout callback runs.
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2001);
		await p;
		expect(errs.join("\n")).toContain("Could not reach harness");
		expect(sock.destroyed).toBe(true);
		// connect handler still wrote the payload before timing out.
		expect(sock.written).toHaveLength(1);
	});

	// test-contract: boundary — timeout swallows a destroy() throw (defensive catch)
	it("timeout swallows a destroy() throw (defensive catch)", async () => {
		vi.useFakeTimers();
		const sock = new FakeSocket();
		sock.destroy = () => {
			throw new Error("already gone");
		};
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => sock.emit("connect"));
			return sock;
		});
		const p = skillEnterCommand("x", {});
		await Promise.resolve();
		// Must not reject despite destroy() throwing inside the timeout handler.
		await vi.advanceTimersByTimeAsync(2001);
		await expect(p).resolves.toBeUndefined();
		expect(errs.join("\n")).toContain("Could not reach harness");
	});

	// test-contract: mutation-kill — the 'error' handler's OWN body
	// (clearTimeout + resolve(null)) must settle the promise immediately; if
	// that body were emptied, the promise would only ever settle via the
	// unrelated 2000ms socket timeout. Fake timers + a 0ms advance (which
	// flushes microtasks but not real elapsed time) distinguish the two: the
	// pristine code has already set exitCode by then, a gutted handler has not.
	it("resolves promptly on socket 'error' via the handler's own resolve (not the 2000ms timeout)", async () => {
		vi.useFakeTimers();
		const sock = new FakeSocket();
		createConnectionMock.mockImplementation(() => {
			queueMicrotask(() => sock.emit("error", new Error("ECONNREFUSED")));
			return sock;
		});
		const p = skillEnterCommand("x", {});
		// Flush microtasks WITHOUT advancing real/fake elapsed time past 0ms —
		// nowhere near the 2000ms socket timeout.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(process.exitCode).toBe(1);
		await p;
	});
});

// =============================================================================
// skillEnterCommand.normal — exact-output pins (checkmark glyph + empty-ttl
// else-branch) beyond the substring checks above.
// =============================================================================

describe("skillEnterCommand — exact normal-mode output", () => {
	// test-contract: mutation-kill — pins the "✓" glyph AND the `""` else
	// branch of the ttl suffix ternary in one exact match.
	it("renders exactly '✓ skill entered: <name>' with no ttl", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("verify", {});
		expect(logs.join("\n")).toBe("✓ skill entered: verify");
	});
});

// =============================================================================
// skillLeaveCommand — additional gaps vs skillEnterCommand's coverage:
// undefined name, default session_id, exact normal-mode output.
// =============================================================================

describe("skillLeaveCommand — additional coverage", () => {
	// test-contract: mutation-kill — exercises name?.trim on `undefined`
	// (OptionalChaining mutant turns this into a throwing `name.trim`).
	it("errors and sets exitCode=1 when name is undefined (optional-chain branch)", async () => {
		await skillLeaveCommand(undefined, {});
		expect(errs.join("\n")).toContain("skill name required");
		expect(process.exitCode).toBe(1);
		expect(createConnectionMock).not.toHaveBeenCalled();
	});

	// test-contract: mutation-kill — pins the `opts.session ?? ""` default.
	it("defaults session_id to empty string when --session omitted (skillLeaveCommand)", async () => {
		const sock = wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("review", {});
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.session_id).toBe("");
	});

	// test-contract: mutation-kill — pins the "✓" glyph in the leave path's
	// normal-mode renderer.
	it("renders exactly '✓ skill left: <name>'", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillLeaveCommand("deep-research", {});
		expect(logs.join("\n")).toBe("✓ skill left: deep-research");
	});
});

// =============================================================================
// parseActiveSkillRecord / parseSkillListSession — additional shape-error
// branches not covered by the existing N1–N5 boundary-parser tests.
// =============================================================================

describe("skillListCommand — additional boundary-parser coverage", () => {
	// test-contract: mutation-kill — a non-object entry in `skills` must fail
	// `isJsonObject` at the record level (distinct from N2's missing-array
	// case and N4's wrong-field-type case).
	it("N6: rejects a skills array containing a non-object entry", async () => {
		const sessions = [{ session_id: "s1", agent_name: "a1", skills: ["not-an-object"] }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: mutation-kill — pins the `typeof name !== "string"` guard.
	it("N7: rejects a skill record whose name is not a string", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: 123, entered_at: 0, expires_at: 1000, source: "cli" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: mutation-kill — pins the `typeof expires_at !== "number"`
	// guard (distinct from N4's entered_at case).
	it("N8: rejects a skill record whose expires_at is not a number", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "a1",
				skills: [{ name: "x", entered_at: 0, expires_at: "soon", source: "cli" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: mutation-kill — a non-object entry in the top-level
	// sessions array must fail `isJsonObject` at the session level (distinct
	// from N1's non-array top-level case).
	it("N9: rejects a sessions array containing a non-object session entry", async () => {
		wireSuccessfulReply({ additional_context: JSON.stringify(["not-an-object"]) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: mutation-kill — pins the
	// `typeof agent_name !== "string"` guard.
	it("N10: rejects a session whose agent_name is not a string", async () => {
		const sessions = [{ session_id: "s1", agent_name: 42, skills: [] }];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(errs.join("\n")).toContain("malformed skill list");
		expect(process.exitCode).toBe(1);
	});

	// test-contract: mutation-kill — pins the `opts.session ?? ""` default
	// for the SkillList event (skillListCommand, distinct from the enter/leave
	// commands' own defaults).
	it("defaults session_id to empty string when --session omitted (skillListCommand)", async () => {
		const sock = wireSuccessfulReply({ additional_context: "[]" });
		await skillListCommand({});
		const payload = JSON.parse(nonNull(sock.written[0]).trimEnd());
		expect(payload.session_id).toBe("");
	});
});

// =============================================================================
// formatSkillListNormal — exact header text, join separator, running total,
// and the entered-at time slice (beyond the loose toContain checks above).
// =============================================================================

describe("formatSkillListNormal — exact rendering pins", () => {
	// test-contract: mutation-kill — pins all four table header strings and
	// the `lines.join("\n")` separator (an emptied separator collapses the
	// whole render onto one line) plus the `lines: string[] = []` init and
	// the blank-line "" pushes (a Stryker placeholder string would leak).
	it("renders exact header row text and a genuinely multi-line output", async () => {
		const sessions = [
			{
				session_id: "abcdef0123456789",
				agent_name: "agentA",
				skills: [{ name: "deep-research", entered_at: 0, expires_at: 60_000, source: "cli" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toContain("skill");
		expect(out).toContain("expires in");
		expect(out).toContain("source");
		expect(out).toContain("entered (utc)");
		expect(out.split("\n").length).toBeGreaterThan(3);
		expect(out).not.toContain("Stryker");
	});

	// test-contract: mutation-kill — pins `total += s.skills.length` against
	// an `-=` mutant: two multi-skill sessions must sum, not cancel out.
	it("sums the running total across multiple sessions", async () => {
		const sessions = [
			{
				session_id: "s1",
				agent_name: "agentA",
				skills: [
					{ name: "a", entered_at: 0, expires_at: 1000, source: "cli" },
					{ name: "b", entered_at: 0, expires_at: 1000, source: "cli" },
				],
			},
			{
				session_id: "s2",
				agent_name: "agentB",
				skills: [
					{ name: "c", entered_at: 0, expires_at: 1000, source: "cli" },
					{ name: "d", entered_at: 0, expires_at: 1000, source: "cli" },
					{ name: "e", entered_at: 0, expires_at: 1000, source: "cli" },
				],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		expect(logs.join("\n")).toMatch(/total\s+5/);
	});

	// test-contract: mutation-kill — pins `.toISOString().slice(11, 19)`
	// against a mutant that drops the `.slice`, which would leak the full
	// ISO date+ms+zone instead of just the time-of-day.
	it("entered (utc) column shows only the time-of-day slice, not the full ISO string", async () => {
		const sessions = [
			{
				session_id: "sess0001",
				agent_name: "a",
				skills: [{ name: "sk", entered_at: 0, expires_at: 60_000, source: "cli" }],
			},
		];
		wireSuccessfulReply({ additional_context: JSON.stringify(sessions) });
		await skillListCommand({});
		const out = logs.join("\n");
		expect(out).toContain("00:00:00");
		expect(out).not.toContain("1970-01-01T00:00:00.000Z");
	});
});

// =============================================================================
// parseTtl — the `.trim()` call (via skillEnterCommand), beyond the
// already-trimmed unit-parametrized cases above.
// =============================================================================

describe("parseTtl — whitespace trimming", () => {
	// test-contract: mutation-kill — pins `raw.trim()`; dropping trim leaves
	// leading/trailing whitespace, which fails the `^...$`-anchored regex and
	// would wrongly report "invalid --ttl" for a value that should parse.
	it("trims surrounding whitespace before matching", async () => {
		wireSuccessfulReply({ decision: "allow" });
		await skillEnterCommand("x", { ttl: "  45  ", json: true });
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed.ttl_seconds).toBe(45);
	});
});
