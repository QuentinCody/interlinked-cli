import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../rules-loader.js";
import { SessionTracker } from "../session-state.js";
import { OPERATOR_CLEAR_FILE, type TaintControlReport } from "../taint-control.js";
import { registerActor } from "../taint-lineage.js";
import { ratchetActorSensitivity } from "../taint-tracker.js";
import type { HarnessEvent } from "../types.js";
import { handleTaintControl, type TaintRuntime, taintControlQuery } from "./taint-control.js";

const LEGACY_ID = "c698b9a9-d8f0-449f-a527-d7c3efd48402";

let cwd: string;
let ctx: TaintRuntime;

function event(sessionId: string): HarnessEvent {
	// SAFETY: SessionTracker.recordEvent reads only these identity fields on a
	// lifecycle event; the tool-context members are optional.
	return {
		hook_event: "SessionStart",
		session_id: sessionId,
		agent_source: "claude",
		agent_name: "lead",
		timestamp: "2026-10-05T00:00:00.000Z",
	} as HarnessEvent;
}

/** A pre-`escalated` snapshot: the Confidential source carries no flag, which
 *  is why nothing could re-judge the real session's level. */
function writeLegacySnapshot(id: string): void {
	const dir = join(cwd, ".interlinked", "sessions");
	mkdirSync(dir, { recursive: true });
	const snapshot = {
		session_id: id,
		agent_name: "lead",
		tool_call_count: 769,
		sensitivity_level: "Confidential",
		step_limit: 10_000,
		taint_sources: [
			{ file: "<command-output>", level: "Confidential", at_step: 769, provenance: "local_read" },
		],
	};
	writeFileSync(join(dir, `${id}.live.json`), `${JSON.stringify(snapshot)}\n`);
}

function storedLevel(id: string): unknown {
	const raw = readFileSync(join(cwd, ".interlinked", "sessions", `${id}.live.json`), "utf-8");
	// SAFETY: the file is written by this fixture or by writeLiveSnapshot, both
	// of which serialize a JSON object with a sensitivity_level field.
	return (JSON.parse(raw) as { sensitivity_level?: unknown }).sensitivity_level;
}

function tainted(sessionId: string): void {
	const session = ctx.sessions.recordEvent(event(sessionId));
	session.sensitivity_level = "Confidential";
	session.step_limit = 10_000;
	session.tool_call_count = 500;
	session.taint_sources.push({
		file: ".env",
		level: "Confidential",
		at_step: 12,
		provenance: "local_read",
		escalated: true,
	});
}

/** The levels a status report lists, root first. */
function report_levels(runtime: TaintRuntime, sessionId: string): Array<string | undefined> {
	const report = handleTaintControl(runtime, { operation: "status", session_id: sessionId });
	return (report.session?.actors ?? []).map((a) => a.level);
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "taint-ctl-"));
	ctx = { cwd, rules: getDefaultConfig(), sessions: new SessionTracker(), log: () => {} };
});

describe("taintControlQuery — positive (must fire)", () => {
	it("P1: answers a status event with a report in additional_context", () => {
		writeLegacySnapshot(LEGACY_ID);
		const decision = taintControlQuery(ctx, {
			hook_event: "TaintControl",
			request: { operation: "status", session_id: LEGACY_ID },
		});
		expect(decision?.decision).toBe("allow");
		// SAFETY: the allow arm always sets additional_context to a serialized report.
		const report = JSON.parse(decision?.additional_context ?? "{}") as TaintControlReport;
		expect(report.session?.sensitivity_level).toBe("Confidential");
		expect(report.session?.set_by).toMatchObject({ file: "<command-output>", inferred: true });
	});
});

describe("taintControlQuery — negative (must not fire)", () => {
	it("N1: ignores any other hook event", () => {
		expect(taintControlQuery(ctx, { hook_event: "PreToolUse" })).toBeUndefined();
		expect(taintControlQuery(ctx, "TaintControl")).toBeUndefined();
	});

	it("N2: blocks an unrecognized operation", () => {
		const decision = taintControlQuery(ctx, {
			hook_event: "TaintControl",
			request: { operation: "erase", session_id: LEGACY_ID },
		});
		expect(decision).toMatchObject({ decision: "block" });
	});
});

describe("handleTaintControl status — positive (must fire)", () => {
	it("P1: prefers live daemon state over the snapshot", () => {
		writeLegacySnapshot(LEGACY_ID);
		tainted(LEGACY_ID);
		const report = handleTaintControl(ctx, { operation: "status", session_id: LEGACY_ID });
		expect(report.session?.origin).toBe("daemon-memory");
		expect(report.session?.set_by).toMatchObject({ file: ".env", inferred: false });
	});

	it("P2: with no session id, lists live sessions and tainted snapshots", () => {
		writeLegacySnapshot(LEGACY_ID);
		tainted("other-session");
		const report = handleTaintControl(ctx, { operation: "status" });
		expect(report.sessions?.map((view) => view.session_id).sort()).toEqual(
			[LEGACY_ID, "other-session"].sort(),
		);
	});
});

describe("handleTaintControl status — negative (must not fire)", () => {
	it("N1: refuses an unknown session", () => {
		const report = handleTaintControl(ctx, { operation: "status", session_id: "nope" });
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("Unknown session nope");
	});
});

describe("handleTaintControl clear — positive (must fire)", () => {
	it("P1: lowers live state AND the snapshot it would re-hydrate from", () => {
		writeLegacySnapshot(LEGACY_ID);
		tainted(LEGACY_ID);
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "false positive",
		});
		expect(report.ok).toBe(true);
		expect(report.cleared?.applied_to).toEqual(["daemon-memory", "live-snapshot"]);
		expect(report.cleared).toMatchObject({ previous_level: "Confidential", set_by: ".env" });
		expect(ctx.sessions.get(LEGACY_ID)?.sensitivity_level).toBe("Public");
		expect(ctx.sessions.get(LEGACY_ID)?.step_limit).toBe(Number.POSITIVE_INFINITY);
		expect(storedLevel(LEGACY_ID)).toBe("Public");
		expect(ctx.sessions.get(LEGACY_ID)?.taint_sources.at(-1)).toMatchObject({
			file: OPERATOR_CLEAR_FILE,
			detail: "false positive",
		});
	});

	it("P2: clears a snapshot-only session the daemon never resumed", () => {
		writeLegacySnapshot(LEGACY_ID);
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "operator review",
		});
		expect(report.cleared?.applied_to).toEqual(["live-snapshot"]);
		expect(storedLevel(LEGACY_ID)).toBe("Public");
	});
});

describe("handleTaintControl per-actor (B3) — positive (must fire)", () => {
	it("P1: status reports one row per actor with the root first", () => {
		const session = ctx.sessions.recordEvent(event(LEGACY_ID));
		registerActor(session, "child-a");
		ratchetActorSensitivity(
			session,
			"child-a",
			{ file: "<command-output>", level: "Confidential" },
			ctx.rules.taint_tracking,
		);
		const report = handleTaintControl(ctx, { operation: "status", session_id: LEGACY_ID });
		expect(report.session?.actors).toEqual([
			{ actor: LEGACY_ID, parent: null, level: "Confidential", spawned_at: null },
			{ actor: "child-a", parent: LEGACY_ID, level: "Confidential", spawned_at: 0 },
		]);
	});

	it("P2: clear --actor lowers only that actor and leaves the session level alone", () => {
		const session = ctx.sessions.recordEvent(event(LEGACY_ID));
		registerActor(session, "child-a");
		ratchetActorSensitivity(
			session,
			"child-a",
			{ file: "<command-output>", level: "Confidential" },
			ctx.rules.taint_tracking,
		);
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "youtube public key",
			actor: "child-a",
		});
		expect(report.cleared).toMatchObject({ previous_level: "Confidential", set_by: "actor child-a" });
		expect(session.sensitivity_level).toBe("Confidential");
		expect(report.session?.actors?.find((a) => a.actor === "child-a")?.level).toBe("Public");
	});

	it("P3: a whole-session clear lowers every actor", () => {
		const session = ctx.sessions.recordEvent(event(LEGACY_ID));
		registerActor(session, "child-a");
		ratchetActorSensitivity(
			session,
			"child-a",
			{ file: "<command-output>", level: "Confidential" },
			ctx.rules.taint_tracking,
		);
		handleTaintControl(ctx, { operation: "clear", session_id: LEGACY_ID, reason: "fp" });
		expect(session.sensitivity_level).toBe("Public");
		expect(report_levels(ctx, LEGACY_ID)).toEqual(["Public", "Public"]);
	});
});

describe("handleTaintControl per-actor (B3) — negative (must not fire)", () => {
	it("N1: an unknown actor is refused and nothing changes", () => {
		const session = ctx.sessions.recordEvent(event(LEGACY_ID));
		registerActor(session, "child-a");
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "r",
			actor: "ghost",
		});
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("not a registered subagent");
	});

	it("N2: --actor against a snapshot-only session is refused (no live lineage)", () => {
		writeLegacySnapshot(LEGACY_ID);
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "r",
			actor: "child-a",
		});
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("needs a running daemon");
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
	});
});

describe("handleTaintControl clear — negative (must not fire)", () => {
	it("N1: refuses an unknown session and writes nothing", () => {
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: "nope",
			reason: "r",
		});
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("Unknown session nope");
	});

	it("N2: refuses an already-Public live session", () => {
		ctx.sessions.recordEvent(event(LEGACY_ID));
		const report = handleTaintControl(ctx, {
			operation: "clear",
			session_id: LEGACY_ID,
			reason: "r",
		});
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("already Public");
		expect(ctx.sessions.get(LEGACY_ID)?.taint_sources).toEqual([]);
	});
});
