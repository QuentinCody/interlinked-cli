// Per-actor lineage taint ratchet (H3 option B3): a ratchet taints the acting
// actor AND its ancestors; an actor spawned later inherits; a sibling that was
// already running keeps its own level. Labeled P (must hold) / N (must not).

import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { SessionTracker } from "./session-state.js";
import { clearActorTaint, clearSessionTaint } from "./taint-control.js";
import {
	actorLevel,
	isSubagentActor,
	lineageEntries,
	MAX_LINEAGE_ACTORS,
	readLineageEntries,
	registerActor,
} from "./taint-lineage.js";
import {
	DEFAULT_TAINT_CONFIG,
	formatTaintSources,
	ratchetActorSensitivity,
	ratchetSensitivity,
	shouldBlockNetwork,
} from "./taint-tracker.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

const CFG = DEFAULT_TAINT_CONFIG;
const SID = "lineage-session";
const ROOT = "lead";

function toolEvent(actor?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: SID,
		agent_source: "claude",
		agent_name: actor ?? ROOT,
		...(actor ? { subagent_id: actor } : {}),
		tool_name: "Bash",
		tool_input: { command: "ls" },
		timestamp: "2026-10-05T00:00:00.000Z",
	};
}

function spawnEvent(id: string, parent?: string): HarnessEvent {
	return {
		hook_event: "SubagentStart",
		session_id: SID,
		agent_source: "claude",
		agent_name: id,
		subagent_id: id,
		...(parent ? { parent_agent: parent } : {}),
		timestamp: "2026-10-05T00:00:00.000Z",
	};
}

interface Harness {
	tracker: SessionTracker;
	session: SessionTrajectory;
	spawn: (id: string, parent?: string) => void;
	act: (actor?: string) => void;
}

function start(): Harness {
	const tracker = new SessionTracker();
	const session = tracker.recordEvent(toolEvent());
	return {
		tracker,
		session,
		spawn: (id, parent) => void tracker.recordEvent(spawnEvent(id, parent)),
		act: (actor) => void tracker.recordEvent(toolEvent(actor)),
	};
}

function taint(s: SessionTrajectory, actor: string | undefined, level: "Internal" | "Confidential" = "Confidential"): boolean {
	return ratchetActorSensitivity(s, actor, { file: "<command-output>", level, detail: "sig-x" }, CFG);
}

const blocked = (s: SessionTrajectory, actor?: string) => shouldBlockNetwork(s, CFG, actor);

describe("lineage ratchet — positive (must hold)", () => {
	it("P1: a tainted child blocks network for the child AND the root", () => {
		const h = start();
		h.spawn("child-a");
		expect(taint(h.session, "child-a")).toBe(true);
		expect(blocked(h.session, "child-a")).toBe(true);
		expect(blocked(h.session, ROOT)).toBe(true);
		expect(blocked(h.session, SID)).toBe(true);
		expect(h.session.sensitivity_level).toBe("Confidential");
	});

	it("P2: an actor spawned AFTER the taint inherits the root's level", () => {
		const h = start();
		h.spawn("child-a");
		taint(h.session, "child-a");
		h.spawn("child-c");
		expect(actorLevel(h.session, "child-c")).toBe("Confidential");
		expect(blocked(h.session, "child-c")).toBe(true);
	});

	it("P3: an actor first seen without a SubagentStart inherits the root's CURRENT level", () => {
		const h = start();
		taint(h.session, ROOT);
		h.act("late-worker");
		expect(isSubagentActor(h.session, "late-worker")).toBe(true);
		expect(blocked(h.session, "late-worker")).toBe(true);
	});

	it("P4: the root tainted directly ⇒ children spawned later are blocked", () => {
		const h = start();
		taint(h.session, ROOT);
		expect(blocked(h.session, ROOT)).toBe(true);
		h.spawn("child-d");
		expect(blocked(h.session, "child-d")).toBe(true);
	});

	it("P5: an explicit parent is honored — the whole ancestor chain is tainted", () => {
		const h = start();
		h.spawn("mid");
		h.spawn("leaf", "mid");
		h.spawn("other");
		taint(h.session, "leaf");
		expect(blocked(h.session, "leaf")).toBe(true);
		expect(blocked(h.session, "mid")).toBe(true);
		expect(blocked(h.session, ROOT)).toBe(true);
		expect(blocked(h.session, "other")).toBe(false);
	});

	it("P6: a ratchet with no actor (legacy caller) taints every actor — fail safe", () => {
		const h = start();
		h.spawn("child-a");
		h.spawn("child-b");
		ratchetSensitivity(h.session, ".env", "Confidential", CFG);
		expect(blocked(h.session, "child-a")).toBe(true);
		expect(blocked(h.session, "child-b")).toBe(true);
	});

	it("P7: an OLD snapshot (no per-actor data) hydrates every actor at the stored level", () => {
		const h = start();
		h.spawn("child-a");
		taint(h.session, ROOT);
		const snap = nonNull(h.tracker.serialize(SID));
		delete snap.taint_actors;
		delete snap.taint_files;
		const restored = nonNull(new SessionTracker().hydrate(snap));
		expect(actorLevel(restored, "child-a")).toBe("Confidential");
		expect(shouldBlockNetwork(restored, CFG, "child-a")).toBe(true);
		expect(shouldBlockNetwork(restored, CFG, ROOT)).toBe(true);
	});

	it("P8: a NEW snapshot round-trips per-actor levels (tainted child, clean sibling)", () => {
		const h = start();
		h.spawn("child-a");
		h.spawn("child-b");
		taint(h.session, "child-a");
		const restored = nonNull(new SessionTracker().hydrate(nonNull(h.tracker.serialize(SID))));
		expect(shouldBlockNetwork(restored, CFG, "child-a")).toBe(true);
		expect(shouldBlockNetwork(restored, CFG, "child-b")).toBe(false);
		expect(lineageEntries(restored).map((e) => [e.actor, e.parent, e.level])).toEqual([
			[SID, null, "Confidential"],
			["child-a", SID, "Confidential"],
			["child-b", SID, "Public"],
		]);
	});

	it("P9: clear lowers EVERY actor, and a named --actor clear lowers only that actor", () => {
		const h = start();
		h.spawn("child-a");
		h.spawn("child-b");
		taint(h.session, "child-a");
		h.spawn("child-c");
		const one = clearActorTaint(h.session, "child-c", "spawned after a false positive");
		expect(one).toMatchObject({ ok: true, previous_level: "Confidential" });
		expect(blocked(h.session, "child-c")).toBe(false);
		expect(blocked(h.session, "child-a")).toBe(true);
		clearSessionTaint(h.session, CFG, "false positive");
		for (const actor of [ROOT, "child-a", "child-b", "child-c"]) expect(blocked(h.session, actor)).toBe(false);
	});

	it("P10: the block reason names the source that set the ACTING actor's level", () => {
		const h = start();
		h.spawn("child-a");
		taint(h.session, "child-a");
		expect(formatTaintSources(h.session, "child-a")).toContain("set by <command-output: sig-x> at step");
		expect(h.session.taint_sources.at(-1)).toMatchObject({ actor: "child-a", escalated: true });
	});
});

describe("lineage ratchet — negative (must not hold)", () => {
	it("N1: a sibling that was already running when its sibling ratcheted stays unblocked", () => {
		const h = start();
		h.spawn("child-a");
		h.spawn("child-b");
		taint(h.session, "child-a");
		expect(blocked(h.session, "child-b")).toBe(false);
		expect(actorLevel(h.session, "child-b")).toBe("Public");
	});

	it("N2: a session with no subagents behaves exactly as before (one actor)", () => {
		const h = start();
		expect(blocked(h.session)).toBe(false);
		expect(ratchetSensitivity(h.session, ".env", "Confidential", CFG)).toBe(true);
		expect(blocked(h.session)).toBe(true);
		expect(blocked(h.session, ROOT)).toBe(true);
		expect(h.session.step_limit).toBe(CFG.step_limits.Confidential);
		expect(h.session.taint_sources).toHaveLength(1);
		expect(lineageEntries(h.session)).toEqual([{ actor: SID, parent: null, level: "Confidential", spawned_at: null }]);
	});

	it("N3: a root-level ratchet does not reach a child that was already running", () => {
		const h = start();
		h.spawn("child-e");
		taint(h.session, ROOT);
		expect(blocked(h.session, "child-e")).toBe(false);
	});

	it("N4: re-registering a known actor or the root itself changes nothing", () => {
		const h = start();
		h.spawn("child-a");
		taint(h.session, ROOT);
		expect(registerActor(h.session, "child-a")).toBe(false);
		expect(registerActor(h.session, SID)).toBe(false);
		expect(actorLevel(h.session, "child-a")).toBe("Public");
	});

	it("N5: a ratchet below the actor's current level reports no escalation", () => {
		const h = start();
		h.spawn("child-a");
		taint(h.session, "child-a");
		expect(taint(h.session, "child-a", "Internal")).toBe(false);
		expect(clearActorTaint(h.session, SID, "r")).toMatchObject({ ok: false });
	});

	it("N6: malformed per-actor snapshot rows are dropped (they re-register fail-safe)", () => {
		expect(readLineageEntries([{ actor: "a", parent: "p", level: "Secret", spawned_at: 1 }, "x", { actor: 3 }])).toEqual([]);
		expect(readLineageEntries(undefined)).toEqual([]);
	});

	it("N7: the actor table is bounded; an evicted actor falls back to the session level", () => {
		const h = start();
		for (let i = 0; i <= MAX_LINEAGE_ACTORS; i++) registerActor(h.session, `w${i}`);
		expect(isSubagentActor(h.session, "w0")).toBe(false);
		taint(h.session, `w${MAX_LINEAGE_ACTORS}`);
		expect(actorLevel(h.session, "w0")).toBe("Confidential");
	});
});
