import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager, getActiveCohort, isLineage, setActiveCohort } from "./cohort.js";
import type { HarnessEvent } from "./types.js";

// All of `cohort.ts`'s nondeterminism is `Date.now()` (synthetic-id suffix in
// agentJoined; the lost-cutoff in detectLostAgents). Pin it with fake timers so
// every assertion is exact. `last_event_at` is parsed via `new Date(...)`, so we
// drive staleness purely through the (controlled) clock vs. ISO strings we set.
const NOW = new Date("2026-06-06T12:00:00.000Z");
const LOST_TIMEOUT_MS = 5 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

/** Build a HarnessEvent with sane defaults; override any field per-test. */
function ev(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-abcdef0123456789",
		agent_source: "claude",
		timestamp: NOW.toISOString(),
		...over,
	} as HarnessEvent;
}

describe("CohortManager.agentJoined", () => {
	it("registers a new agent with all fields populated from the event", () => {
		const c = new CohortManager();
		const agent = c.agentJoined(
			ev({ agent_name: "alice", session_id: "s1", timestamp: "2026-06-06T11:00:00.000Z" }),
		);

		expect(agent).toEqual({
			name: "alice",
			session_id: "s1",
			source: "claude",
			status: "active",
			joined_at: "2026-06-06T11:00:00.000Z",
			last_event_at: "2026-06-06T11:00:00.000Z",
			files_reserved: [],
		});
		expect(c.getAgent("alice")).toBe(agent);
	});

	it("derives a name from source + session-id slice when agent_name is absent", () => {
		const c = new CohortManager();
		// `${source}-${sid.slice(0,8)}` => "claude-" + first 8 chars of session_id.
		const agent = c.agentJoined(ev({ session_id: "0123456789abcdef" }));
		expect(agent.name).toBe("claude-01234567");
		expect(c.hasAgent("claude-01234567")).toBe(true);
	});

	it("falls back to a synthetic session id when session_id is empty", () => {
		const c = new CohortManager();
		// Date.now() is pinned, so the synthetic suffix is deterministic.
		const suffix = Date.now().toString(36);
		const agent = c.agentJoined(ev({ session_id: "" }));

		// name = `${source}-${sid.slice(0,8)}` where sid = `unknown-${suffix}`.
		const expectedSid = `unknown-${suffix}`;
		expect(agent.name).toBe(`claude-${expectedSid.slice(0, 8)}`);
		// session_id stored on the agent is the *original* (empty) event value,
		// not the synthetic id — synthetic id only seeds the name.
		expect(agent.session_id).toBe("");
	});

	it("reuses synthetic-name path with explicit agent_name even on empty session_id", () => {
		const c = new CohortManager();
		const agent = c.agentJoined(ev({ session_id: "", agent_name: "named" }));
		// agent_name short-circuits the name derivation; synthetic sid is unused.
		expect(agent.name).toBe("named");
		expect(agent.session_id).toBe("");
	});

	it("reconnects an existing agent: flips to active, updates session_id and timestamp, same object", () => {
		const c = new CohortManager();
		const first = c.agentJoined(
			ev({ agent_name: "bob", session_id: "old", timestamp: "2026-06-06T10:00:00.000Z" }),
		);
		first.status = "idle"; // simulate a prior disconnect

		const again = c.agentJoined(
			ev({ agent_name: "bob", session_id: "new", timestamp: "2026-06-06T11:30:00.000Z" }),
		);

		expect(again).toBe(first); // mutated in place, not replaced
		expect(again.status).toBe("active");
		expect(again.session_id).toBe("new");
		expect(again.last_event_at).toBe("2026-06-06T11:30:00.000Z");
		expect(again.joined_at).toBe("2026-06-06T10:00:00.000Z"); // join time preserved
		expect(c.getAllAgents()).toHaveLength(1); // no duplicate
	});

	it("reconnect preserves a previously-set undefined session_id update", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "carol", session_id: "had-one" }));
		const re = c.agentJoined(ev({ agent_name: "carol", session_id: undefined as never }));
		// existing.session_id = event.session_id, even when undefined.
		expect(re.session_id).toBeUndefined();
	});
});

describe("CohortManager.agentLeft", () => {
	it("marks a matched agent idle and bumps last_event_at", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice", timestamp: "2026-06-06T10:00:00.000Z" }));
		c.agentLeft(ev({ agent_name: "alice", timestamp: "2026-06-06T11:00:00.000Z" }));

		const a = c.getAgent("alice");
		expect(a?.status).toBe("idle");
		expect(a?.last_event_at).toBe("2026-06-06T11:00:00.000Z");
	});

	it("is a no-op when no agent matches the event", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		// Different name AND different session id => findByEvent returns undefined.
		c.agentLeft(ev({ agent_name: "ghost", session_id: "other" }));
		expect(c.getAgent("alice")?.status).toBe("active");
		expect(c.getCounts()).toEqual({ active: 1, idle: 0, lost: 0 });
	});
});

describe("CohortManager.subagentJoined", () => {
	it("prefers top-level Codex actor identity and lineage fields", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({
				session_id: "shared-session",
				agent_name: "child-task",
				subagent_id: "thread-child-a",
				parent_agent: "thread-root",
				tool_input: {
					subagent_id: "stale-tool-id",
					parent_agent_name: "stale-tool-parent",
				},
			}),
		);

		expect(sub).toMatchObject({
			name: "child-task",
			session_id: "shared-session",
			subagent_id: "thread-child-a",
			parent_agent: "thread-root",
		});
	});

	it("uses agent_name when present and records the parent_agent_name", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({
				agent_name: "sub-explicit",
				tool_input: { parent_agent_name: "parent-A" },
				timestamp: "2026-06-06T09:00:00.000Z",
			}),
		);
		expect(sub).toMatchObject({
			name: "sub-explicit",
			source: "claude",
			status: "active",
			parent_agent: "parent-A",
			joined_at: "2026-06-06T09:00:00.000Z",
			last_event_at: "2026-06-06T09:00:00.000Z",
			files_reserved: [],
		});
		expect(c.getAgent("sub-explicit")).toBe(sub);
	});

	it("falls back to tool_input.subagent_id when agent_name is absent", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({ tool_input: { subagent_id: "sid-123" } }),
		);
		expect(sub.name).toBe("sid-123");
	});

	it("falls back to tool_input.agent_id when name and subagent_id are absent", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({ tool_input: { agent_id: "aid-456" } }),
		);
		expect(sub.name).toBe("aid-456");
	});

	it("falls back to a sub-<session-slice> name when no id is provided at all", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({ tool_input: {}, session_id: "abcdefgh-ignored" }),
		);
		expect(sub.name).toBe("sub-abcdefgh");
	});

	it("falls back to sub-<session-slice> when tool_input itself is undefined", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({ session_id: "zyxwvuts-rest" }),
		);
		// Exercises the `?.` short-circuit on every tool_input access.
		expect(sub.name).toBe("sub-zyxwvuts");
	});

	it("resolves parent_agent via the parent_agent fallback when parent_agent_name is absent", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({ agent_name: "s", tool_input: { parent_agent: "parent-B" } }),
		);
		expect(sub.parent_agent).toBe("parent-B");
	});

	it("leaves parent_agent undefined when no parent hint is present", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(ev({ agent_name: "s", tool_input: {} }));
		expect(sub.parent_agent).toBeUndefined();
	});

	it("prefers parent_agent_name over parent_agent when both are present", () => {
		const c = new CohortManager();
		const sub = c.subagentJoined(
			ev({
				agent_name: "s",
				tool_input: { parent_agent_name: "primary", parent_agent: "secondary" },
			}),
		);
		expect(sub.parent_agent).toBe("primary");
	});

	it("overwrites a same-named entry in the map (last write wins)", () => {
		const c = new CohortManager();
		const first = c.subagentJoined(ev({ agent_name: "dup", tool_input: {} }));
		const second = c.subagentJoined(ev({ agent_name: "dup", tool_input: {} }));
		expect(c.getAgent("dup")).toBe(second);
		expect(c.getAgent("dup")).not.toBe(first);
		expect(c.getAllAgents()).toHaveLength(1);
	});
});

describe("CohortManager.subagentLeft", () => {
	it("marks only the child selected by top-level subagent_id idle", () => {
		const c = new CohortManager();
		c.subagentJoined(
			ev({ agent_name: "child-a", session_id: "shared", subagent_id: "thread-a" }),
		);
		c.subagentJoined(
			ev({ agent_name: "child-b", session_id: "shared", subagent_id: "thread-b" }),
		);

		c.subagentLeft(ev({ session_id: "shared", subagent_id: "thread-b" }));

		expect(c.getAgent("child-a")?.status).toBe("active");
		expect(c.getAgent("child-b")?.status).toBe("idle");
	});

	it("marks a subagent idle by agent_name", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "sub1", tool_input: {} }));
		c.subagentLeft(ev({ agent_name: "sub1", timestamp: "2026-06-06T13:00:00.000Z" }));
		const a = c.getAgent("sub1");
		expect(a?.status).toBe("idle");
		expect(a?.last_event_at).toBe("2026-06-06T13:00:00.000Z");
	});

	it("resolves the name via subagent_id when agent_name is absent", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "sid-x", tool_input: {} }));
		c.subagentLeft(ev({ tool_input: { subagent_id: "sid-x" } }));
		expect(c.getAgent("sid-x")?.status).toBe("idle");
	});

	it("resolves the name via agent_id when name and subagent_id are absent", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "aid-y", tool_input: {} }));
		c.subagentLeft(ev({ tool_input: { agent_id: "aid-y" } }));
		expect(c.getAgent("aid-y")?.status).toBe("idle");
	});

	it("is a no-op when the resolved name is falsy (no name, no ids)", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "present", tool_input: {} }));
		// name resolves to undefined => `if (name)` is false => nothing happens.
		c.subagentLeft(ev({ tool_input: {} }));
		expect(c.getAgent("present")?.status).toBe("active");
	});

	it("is a no-op when the resolved name does not match any agent", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "present", tool_input: {} }));
		c.subagentLeft(ev({ agent_name: "absent", tool_input: {} }));
		expect(c.getAgent("present")?.status).toBe("active");
	});

	it("tolerates undefined tool_input on the leave event", () => {
		const c = new CohortManager();
		c.subagentJoined(ev({ agent_name: "present", tool_input: {} }));
		// agent_name undefined + tool_input undefined => name undefined => no-op.
		c.subagentLeft(ev({}));
		expect(c.getAgent("present")?.status).toBe("active");
	});
});

describe("CohortManager.recordActivity", () => {
	it("updates the selected same-session child instead of its root or sibling", () => {
		const c = new CohortManager();
		c.agentJoined(
			ev({ agent_name: "root", session_id: "shared", timestamp: "2026-06-06T09:00:00.000Z" }),
		);
		c.subagentJoined(
			ev({
				agent_name: "child-a",
				session_id: "shared",
				subagent_id: "thread-a",
				timestamp: "2026-06-06T09:00:00.000Z",
			}),
		);
		c.subagentJoined(
			ev({
				agent_name: "child-b",
				session_id: "shared",
				subagent_id: "thread-b",
				timestamp: "2026-06-06T09:00:00.000Z",
			}),
		);

		c.recordActivity(
			ev({
				session_id: "shared",
				subagent_id: "thread-b",
				timestamp: "2026-06-06T11:00:00.000Z",
			}),
		);

		expect(c.getAgent("root")?.last_event_at).toBe("2026-06-06T09:00:00.000Z");
		expect(c.getAgent("child-a")?.last_event_at).toBe("2026-06-06T09:00:00.000Z");
		expect(c.getAgent("child-b")?.last_event_at).toBe("2026-06-06T11:00:00.000Z");
	});

	it("bumps last_event_at on a matched agent without changing an already-active status", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice", timestamp: "2026-06-06T10:00:00.000Z" }));
		c.recordActivity(ev({ agent_name: "alice", timestamp: "2026-06-06T10:05:00.000Z" }));
		const a = c.getAgent("alice");
		expect(a?.last_event_at).toBe("2026-06-06T10:05:00.000Z");
		expect(a?.status).toBe("active");
	});

	it("revives a non-active agent back to active on new activity", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.agentLeft(ev({ agent_name: "alice" })); // -> idle
		expect(c.getAgent("alice")?.status).toBe("idle");

		c.recordActivity(ev({ agent_name: "alice", timestamp: "2026-06-06T14:00:00.000Z" }));
		const a = c.getAgent("alice");
		expect(a?.status).toBe("active");
		expect(a?.last_event_at).toBe("2026-06-06T14:00:00.000Z");
	});

	it("implicitly JOINS an unknown agent (daemon-restart recovery, 2026-07-10)", () => {
		// Cohort state is in-memory: a daemon restart empties it, and a
		// mid-flight session's SessionStart already happened — without implicit
		// re-join every cohort-gated surface stays dormant until the NEXT
		// session. Tool traffic is the liveness signal.
		const c = new CohortManager();
		c.recordActivity(ev({ agent_name: "restarted-into-us", session_id: "s-mid-flight" }));
		expect(c.getAgent("restarted-into-us")?.status).toBe("active");
		expect(c.getCounts()).toEqual({ active: 1, idle: 0, lost: 0 });
		// Known agents still take the update path, not a duplicate join.
		c.recordActivity(ev({ agent_name: "restarted-into-us", session_id: "s-mid-flight" }));
		expect(c.getAllAgents()).toHaveLength(1);
	});

	it("routes an unmatched event carrying subagent_id through subagentJoined, not agentJoined", () => {
		// If recordActivity checked agent_name before subagent_id here, this event
		// (which carries both) would fall into agentJoined and the resulting
		// record would have no subagent_id field at all.
		const c = new CohortManager();
		c.recordActivity(
			ev({
				agent_name: "helper",
				session_id: "new-session",
				subagent_id: "new-sub",
				timestamp: "2026-06-06T09:30:00.000Z",
			}),
		);
		const agent = c.getAgent("helper");
		expect(agent?.subagent_id).toBe("new-sub");
		expect(agent?.status).toBe("active");
	});
});

describe("CohortManager file reservations", () => {
	it("addFileReservation appends a unique path", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.addFileReservation("alice", "src/a.ts");
		expect(c.getAgent("alice")?.files_reserved).toEqual(["src/a.ts"]);
	});

	it("addFileReservation dedups an already-reserved path", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.addFileReservation("alice", "src/a.ts");
		c.addFileReservation("alice", "src/a.ts"); // includes() => skip
		expect(c.getAgent("alice")?.files_reserved).toEqual(["src/a.ts"]);
	});

	it("addFileReservation is a no-op for an unknown agent", () => {
		const c = new CohortManager();
		c.addFileReservation("ghost", "src/a.ts");
		expect(c.getAgent("ghost")).toBeUndefined();
	});

	it("removeFileReservation drops only the matching path", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.addFileReservation("alice", "src/a.ts");
		c.addFileReservation("alice", "src/b.ts");
		c.removeFileReservation("alice", "src/a.ts");
		expect(c.getAgent("alice")?.files_reserved).toEqual(["src/b.ts"]);
	});

	it("removeFileReservation is a no-op for an unknown agent", () => {
		const c = new CohortManager();
		// No throw, nothing created.
		c.removeFileReservation("ghost", "src/a.ts");
		expect(c.getAllAgents()).toHaveLength(0);
	});

	it("clearReservations empties the list for a known agent", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.addFileReservation("alice", "src/a.ts");
		c.clearReservations("alice");
		expect(c.getAgent("alice")?.files_reserved).toEqual([]);
	});

	it("clearReservations is a no-op for an unknown agent", () => {
		const c = new CohortManager();
		c.clearReservations("ghost");
		expect(c.getAllAgents()).toHaveLength(0);
	});
});

describe("CohortManager.detectLostAgents", () => {
	it("marks active agents whose last event is older than the lost timeout", () => {
		const c = new CohortManager();
		// last_event_at is exactly (timeout + 1ms) old => strictly past the cutoff.
		const stale = new Date(NOW.getTime() - LOST_TIMEOUT_MS - 1).toISOString();
		c.agentJoined(ev({ agent_name: "stale", timestamp: stale }));

		const lost = c.detectLostAgents();
		expect(lost).toHaveLength(1);
		expect(lost[0]?.name).toBe("stale");
		expect(lost[0]?.status).toBe("lost");
		expect(c.getAgent("stale")?.status).toBe("lost");
	});

	it("does not mark agents still within the timeout window", () => {
		const c = new CohortManager();
		// Exactly at the cutoff is NOT lost (strict `<` comparison).
		const fresh = new Date(NOW.getTime() - LOST_TIMEOUT_MS).toISOString();
		c.agentJoined(ev({ agent_name: "fresh", timestamp: fresh }));

		expect(c.detectLostAgents()).toEqual([]);
		expect(c.getAgent("fresh")?.status).toBe("active");
	});

	it("ignores non-active agents even when their last event is ancient", () => {
		const c = new CohortManager();
		const ancient = new Date(NOW.getTime() - LOST_TIMEOUT_MS - 10_000).toISOString();
		c.agentJoined(ev({ agent_name: "idle-old", timestamp: ancient }));
		c.agentLeft(ev({ agent_name: "idle-old", timestamp: ancient })); // -> idle

		// status !== "active" => skipped regardless of staleness.
		expect(c.detectLostAgents()).toEqual([]);
		expect(c.getAgent("idle-old")?.status).toBe("idle");
	});

	it("returns multiple lost agents and leaves fresh ones active", () => {
		const c = new CohortManager();
		const stale = new Date(NOW.getTime() - LOST_TIMEOUT_MS - 1).toISOString();
		const fresh = NOW.toISOString();
		c.agentJoined(ev({ agent_name: "s1", session_id: "z1", timestamp: stale }));
		c.agentJoined(ev({ agent_name: "s2", session_id: "z2", timestamp: stale }));
		c.agentJoined(ev({ agent_name: "ok", session_id: "z3", timestamp: fresh }));

		const lost = c.detectLostAgents().map((a) => a.name).sort();
		expect(lost).toEqual(["s1", "s2"]);
		expect(c.getAgent("ok")?.status).toBe("active");
	});
});

describe("CohortManager queries", () => {
	it("hasAgent reflects membership", () => {
		const c = new CohortManager();
		expect(c.hasAgent("alice")).toBe(false);
		c.agentJoined(ev({ agent_name: "alice" }));
		expect(c.hasAgent("alice")).toBe(true);
	});

	it("getAgent returns the entry or undefined", () => {
		const c = new CohortManager();
		expect(c.getAgent("alice")).toBeUndefined();
		const a = c.agentJoined(ev({ agent_name: "alice" }));
		expect(c.getAgent("alice")).toBe(a);
	});

	it("getActiveAgents returns only active entries", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "active1" }));
		c.agentJoined(ev({ agent_name: "idle1", session_id: "i1" }));
		c.agentLeft(ev({ agent_name: "idle1", session_id: "i1" }));

		const names = c.getActiveAgents().map((a) => a.name);
		expect(names).toEqual(["active1"]);
	});

	it("getAllAgents returns every entry regardless of status", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "a", session_id: "x1" }));
		c.agentJoined(ev({ agent_name: "b", session_id: "x2" }));
		c.agentLeft(ev({ agent_name: "b", session_id: "x2" }));
		expect(c.getAllAgents().map((a) => a.name).sort()).toEqual(["a", "b"]);
	});

	it("getCounts tallies each status, including lost", () => {
		const c = new CohortManager();
		// one active
		c.agentJoined(ev({ agent_name: "act", session_id: "a1" }));
		// one idle
		c.agentJoined(ev({ agent_name: "idl", session_id: "a2" }));
		c.agentLeft(ev({ agent_name: "idl", session_id: "a2" }));
		// one lost (joined stale, then detected)
		const stale = new Date(NOW.getTime() - LOST_TIMEOUT_MS - 1).toISOString();
		c.agentJoined(ev({ agent_name: "lst", session_id: "a3", timestamp: stale }));
		c.detectLostAgents();

		expect(c.getCounts()).toEqual({ active: 1, idle: 1, lost: 1 });
	});

	it("getCounts on an empty cohort returns all-zero", () => {
		expect(new CohortManager().getCounts()).toEqual({ active: 0, idle: 0, lost: 0 });
	});
});

describe("CohortManager.findByEvent (via public methods)", () => {
	it("matches by agent_name when present and registered", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "named", session_id: "s-named" }));
		// recordActivity routes through findByEvent; agent_name hits the map directly.
		c.recordActivity(ev({ agent_name: "named", session_id: "different", timestamp: "2026-06-06T15:00:00.000Z" }));
		expect(c.getAgent("named")?.last_event_at).toBe("2026-06-06T15:00:00.000Z");
	});

	it("falls back to session_id match when agent_name is set but unregistered", () => {
		const c = new CohortManager();
		// Register under a derived name (no agent_name), so the map has no "wrong-name" key.
		const a = c.agentJoined(ev({ session_id: "find-me" }));
		// agent_name present but not in map => loop falls through to session_id.
		c.recordActivity(
			ev({ agent_name: "wrong-name", session_id: "find-me", timestamp: "2026-06-06T16:00:00.000Z" }),
		);
		expect(c.getAgent(a.name)?.last_event_at).toBe("2026-06-06T16:00:00.000Z");
	});

	it("falls back to session_id match when agent_name is absent", () => {
		const c = new CohortManager();
		const a = c.agentJoined(ev({ session_id: "sid-only" }));
		c.recordActivity(
			ev({ session_id: "sid-only", timestamp: "2026-06-06T17:00:00.000Z" }),
		);
		expect(c.getAgent(a.name)?.last_event_at).toBe("2026-06-06T17:00:00.000Z");
	});

	it("returns undefined when neither name nor session_id match", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice", session_id: "alice-sess" }));
		const before = c.getAgent("alice")?.last_event_at;
		// No name match, no session match => findByEvent undefined => no mutation.
		c.recordActivity(ev({ agent_name: "zzz", session_id: "zzz-sess", timestamp: "2026-06-06T18:00:00.000Z" }));
		expect(c.getAgent("alice")?.last_event_at).toBe(before);
	});
});

describe("CohortManager.activeAgentCount — the number cohort rules gate on", () => {
	it("counts a root and same-session Codex siblings as distinct actors", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "root", session_id: "shared" }));
		c.subagentJoined(
			ev({ agent_name: "child-a", session_id: "shared", subagent_id: "thread-a" }),
		);
		c.subagentJoined(
			ev({ agent_name: "child-b", session_id: "shared", subagent_id: "thread-b" }),
		);

		expect(c.activeAgentCount()).toBe(3);
	});

	// Over-counting here is not cosmetic: `active_agent_count_at_least(2)` gates
	// git checkout / stash / rebase, so a phantom second agent blocks a solo
	// session from switching branches. Measured live 2026-08-07.

	it("P1: counts a single agent once", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		expect(c.activeAgentCount()).toBe(1);
	});

	it("P2: counts two genuinely distinct sessions as two", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice", session_id: "sess-a" }));
		c.agentJoined(ev({ agent_name: "bob", session_id: "sess-b" }));
		expect(c.activeAgentCount()).toBe(2);
	});

	it("N1: does NOT count a stale agent that died without a stop event", () => {
		// The rate-limit / stopped-workflow / crash case: no SubagentStop ever
		// arrives, so `status` stays "active" until a timer sweep that may never
		// run. Reading last_event_at at call time makes this correct regardless.
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.subagentJoined(
			ev({ agent_name: "ghost", timestamp: new Date(NOW.getTime() - LOST_TIMEOUT_MS - 1).toISOString() }),
		);
		expect(c.getCounts().active).toBe(2); // the raw field still says 2 …
		expect(c.activeAgentCount()).toBe(1); // … the gated number does not
	});

	it("N2: counts ONE session registered under two names only once", () => {
		// `agentJoined` keys on `agent_name || "<source>-<sid8>"`, so a session
		// whose events sometimes carry agent_name and sometimes do not lands in
		// the map twice and used to count as a cohort of two. The second join
		// here OMITS agent_name, taking the synthetic-name branch.
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice", session_id: "sess-same" }));
		c.agentJoined(ev({ session_id: "sess-same" }));
		expect(c.getCounts().active).toBe(2); // two map keys …
		expect(c.activeAgentCount()).toBe(1); // … one real session
	});

	it("N3: does not count agents that left gracefully", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alice" }));
		c.agentJoined(ev({ agent_name: "bob", session_id: "sess-b" }));
		c.agentLeft(ev({ agent_name: "bob", session_id: "sess-b" }));
		expect(c.activeAgentCount()).toBe(1);
	});

	it("N4: an empty cohort counts zero", () => {
		expect(new CohortManager().activeAgentCount()).toBe(0);
	});
});

describe("active-cohort provider", () => {
	afterEach(() => setActiveCohort(null));

	it("set/get/clear round-trips", () => {
		expect(getActiveCohort()).toBeNull();
		const c = new CohortManager();
		setActiveCohort(c);
		expect(getActiveCohort()).toBe(c);
		setActiveCohort(null);
		expect(getActiveCohort()).toBeNull();
	});
});

describe("isLineage", () => {
	it("matches a child whose parent is identified by the root session id", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "root", session_id: "root-session" }));
		c.subagentJoined(
			ev({
				agent_name: "child",
				session_id: "root-session",
				subagent_id: "thread-child",
				parent_agent: "root-session",
			}),
		);

		expect(isLineage(c, "root", "thread-child")).toBe(true);
		expect(isLineage(c, "thread-child", "root-session")).toBe(true);
	});

	it("true for parent↔child in either direction", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "main", session_id: "s-main" }));
		c.subagentJoined(
			ev({
				hook_event: "SubagentStart",
				agent_name: "explorer-1",
				session_id: "s-sub",
				tool_input: { parent_agent_name: "main" },
			}),
		);
		expect(isLineage(c, "main", "explorer-1")).toBe(true);
		expect(isLineage(c, "explorer-1", "main")).toBe(true);
	});

	it("false for unrelated siblings and for unknown agents", () => {
		const c = new CohortManager();
		c.agentJoined(ev({ agent_name: "alpha", session_id: "s-a" }));
		c.agentJoined(ev({ agent_name: "beta", session_id: "s-b" }));
		expect(isLineage(c, "alpha", "beta")).toBe(false);
		expect(isLineage(c, "alpha", "ghost")).toBe(false);
		expect(isLineage(c, "ghost", "phantom")).toBe(false);
	});
});
