import { describe, expect, it } from "vitest";
import {
	actorKey,
	AgentRoster,
	hueForAgent,
	isActive,
	labelFor,
	runnerOf,
	UNATTRIBUTED,
} from "./agent-roster.js";
import type { VizEvent } from "./event-stream.js";

const ev = (over: Partial<VizEvent> = {}): VizEvent => ({
	ts: "2026-08-05T00:00:00.000Z",
	type: "tool_use",
	agent: "session-claude-5a6ba76e",
	...over,
});

describe("runnerOf", () => {
	it("recognizes each runner family in an agent name", () => {
		expect(runnerOf("session-claude-5a6ba76e")).toBe("claude");
		expect(runnerOf("session-codex-abc")).toBe("codex");
		expect(runnerOf("session-gemini-abc")).toBe("gemini");
		expect(runnerOf("session-opencode-abc")).toBe("opencode");
		expect(runnerOf("session-opencode2-abc")).toBe("opencode2");
		expect(runnerOf("session-pi-abc")).toBe("pi");
	});

	it("falls back to unknown for an unrecognized name", () => {
		expect(runnerOf("some-other-thing")).toBe("unknown");
	});
});

describe("hueForAgent", () => {
	it("is stable for the same id", () => {
		expect(hueForAgent("session-claude-a")).toBe(hueForAgent("session-claude-a"));
	});

	it("stays inside the hue circle", () => {
		for (const id of ["a", "session-claude-5a6ba76e", "", "x".repeat(200)]) {
			const hue = hueForAgent(id);
			expect(hue).toBeGreaterThanOrEqual(0);
			expect(hue).toBeLessThan(360);
		}
	});

	it("separates two different sessions", () => {
		expect(hueForAgent("session-claude-aaaaaaa")).not.toBe(hueForAgent("session-claude-bbbbbbb"));
	});
});

describe("labelFor", () => {
	it("renders runner and the identifying tail", () => {
		expect(labelFor("session-claude-5a6ba76e")).toBe("claude·5a6ba76e");
	});

	it("marks a subagent under its parent", () => {
		expect(labelFor("session-claude-5a6ba76e", "sub-12345678")).toBe("claude·5a6ba76e ▸ sub·sub-12");
	});
});

describe("actorKey", () => {
	it("keys by agent name", () => {
		expect(actorKey(ev())).toBe("session-claude-5a6ba76e");
	});

	it("gives a subagent its own lane under the parent", () => {
		expect(actorKey(ev({ subagent_id: "s1" }))).toBe("session-claude-5a6ba76e/s1");
	});

	it("keys an actorless row as unattributed", () => {
		expect(actorKey({ ts: "t", type: "tool_use" })).toBe(UNATTRIBUTED);
	});
});

describe("AgentRoster", () => {
	it("creates one lane per agent and keeps them separate", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ agent: "session-claude-aaa" }));
		roster.apply(ev({ agent: "session-codex-bbb" }));
		expect(roster.list().map((a) => a.id).sort()).toEqual(["session-claude-aaa", "session-codex-bbb"]);
	});

	it("counts events, edits, blocks and warns per actor", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ tool: "Edit" }));
		roster.apply(ev({ tool: "Write" }));
		roster.apply(ev({ tool: "Bash", decision: "block" }));
		roster.apply(ev({ tool: "Read", severity: "warning" }));
		const a = roster.get("session-claude-5a6ba76e");
		expect(a).toMatchObject({ events: 4, edits: 2, blocks: 1, warns: 1 });
	});

	it("does not attribute a subagent's work to its parent lane", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ tool: "Edit" }));
		roster.apply(ev({ tool: "Edit", subagent_id: "s1" }));
		expect(roster.get("session-claude-5a6ba76e")?.edits).toBe(1);
		expect(roster.get("session-claude-5a6ba76e/s1")?.edits).toBe(1);
	});

	it("records a spawned subagent on the parent lane and marks the child", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ tool: "Edit" }));
		roster.apply(ev({ tool: "Edit", subagent_id: "s1" }));
		roster.apply(ev({ tool: "Edit", subagent_id: "s1" }));
		expect(roster.get("session-claude-5a6ba76e")?.subagents).toEqual(["s1"]);
		const child = roster.get("session-claude-5a6ba76e/s1");
		expect(child).toMatchObject({ isSubagent: true, parent: "session-claude-5a6ba76e" });
	});

	it("links an explicitly named parent thread through the root lane's session", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ agent: "root-agent", session: "root-thread" }));
		const child = roster.apply(
			ev({
				agent: "child-task",
				session: "root-thread",
				subagent_id: "child-thread",
				parent_agent: "root-thread",
			}),
		);

		expect(child.parent).toBe("root-agent");
		expect(roster.get("root-agent")?.subagents).toEqual(["child-thread"]);
	});

	it("tracks recent files newest-first without duplicates", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ file: "a.ts" }));
		roster.apply(ev({ file: "b.ts" }));
		roster.apply(ev({ file: "a.ts" }));
		expect(roster.get("session-claude-5a6ba76e")?.files).toEqual(["a.ts", "b.ts"]);
	});

	it("caps the recent-file ring", () => {
		const roster = new AgentRoster();
		for (let i = 0; i < 20; i++) roster.apply(ev({ file: `f${i}.ts` }));
		const files = roster.get("session-claude-5a6ba76e")?.files ?? [];
		expect(files).toHaveLength(6);
		expect(files[0]).toBe("f19.ts");
	});

	it("carries model and session through when the row reports them", () => {
		const roster = new AgentRoster();
		const presence = roster.apply(ev({ model: "vendor-model-v6", session: "5a6ba76e" }));
		expect(presence).toMatchObject({ model: "vendor-model-v6", session: "5a6ba76e" });
	});

	it("advances lastSeen and returns the updated lane", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ ts: "2026-08-05T00:00:00.000Z" }));
		const updated = roster.apply(ev({ ts: "2026-08-05T00:05:00.000Z", tool: "Edit" }));
		expect(updated.firstSeen).toBe("2026-08-05T00:00:00.000Z");
		expect(updated.lastSeen).toBe("2026-08-05T00:05:00.000Z");
	});

	it("lists the most recently active actor first", () => {
		const roster = new AgentRoster();
		roster.apply(ev({ agent: "session-claude-old", ts: "2026-08-05T00:00:00.000Z" }));
		roster.apply(ev({ agent: "session-claude-new", ts: "2026-08-05T01:00:00.000Z" }));
		expect(roster.list()[0]?.id).toBe("session-claude-new");
	});

	it("folds actorless rows into one unattributed lane", () => {
		const roster = new AgentRoster();
		roster.apply({ ts: "2026-08-05T00:00:00.000Z", type: "tool_use" });
		expect(roster.list()[0]).toMatchObject({ id: UNATTRIBUTED, runner: "unknown" });
	});
});

describe("isActive", () => {
	const now = Date.parse("2026-08-05T00:10:00.000Z");
	const presence = (lastSeen: string) => ({ ...new AgentRoster().apply(ev({ ts: lastSeen })) });

	it("is true within the idle window", () => {
		expect(isActive(presence("2026-08-05T00:09:00.000Z"), now)).toBe(true);
	});

	it("is false once the actor has been silent past the window", () => {
		expect(isActive(presence("2026-08-05T00:00:00.000Z"), now)).toBe(false);
	});

	it("is false when the timestamp is unparseable", () => {
		expect(isActive(presence("not-a-date"), now)).toBe(false);
	});
});
