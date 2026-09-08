// ===========================================
// `interlinked trajectory` — wave-62 mutation-kill suite
// ===========================================
// Targets survivors from scratch/fleet-r3/w62-briefs/src_commands_trajectory.ts.json.
// `trajectoryReplayCommand` tests mock out the sequence-detector dispatcher
// and the SessionTracker so the exact `phase`/`family`/`match` shapes passed
// through can be asserted without depending on real detector behavior.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runSequenceDetectorsForPhaseMock, formatSequenceFindingMock } = vi.hoisted(() => ({
	runSequenceDetectorsForPhaseMock: vi.fn(),
	formatSequenceFindingMock: vi.fn(),
}));

vi.mock("../harness/sequence-checks/index.js", () => ({
	runSequenceDetectorsForPhase: (...args: unknown[]) => runSequenceDetectorsForPhaseMock(...args),
	formatSequenceFinding: (...args: unknown[]) => formatSequenceFindingMock(...args),
}));

vi.mock("../harness/session-state.js", () => ({
	SessionTracker: class {
		recordEvent(event: { session_id: string }) {
			return { session_id: event.session_id };
		}
	},
}));

import { trajectoryReplayCommand, trajectoryShowCommand } from "./trajectory.js";

let workDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let lines: string[];

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "trajectory-w62-"));
	lines = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	runSequenceDetectorsForPhaseMock.mockReset();
	formatSequenceFindingMock.mockReset();
	formatSequenceFindingMock.mockImplementation(
		(f: { detector_id: string; family: string; phase: string; match: { message?: string } }) =>
			`FMT|${f.detector_id}|${f.family}|${f.phase}|${f.match?.message ?? "<no-message>"}`,
	);
});

afterEach(() => {
	logSpy.mockRestore();
	rmSync(workDir, { recursive: true, force: true });
});

function writeSnapshot(dir: string, sessionId: string, content: Record<string, unknown>): void {
	mkdirSync(join(dir, ".interlinked", "sessions"), { recursive: true });
	writeFileSync(
		join(dir, ".interlinked", "sessions", `${sessionId}.trajectory.json`),
		JSON.stringify(content),
		"utf-8",
	);
}

// ---------------------------------------------------------------------------
// trajectoryShowCommand — session selection
// ---------------------------------------------------------------------------

describe("trajectoryShowCommand — session selection (positive)", () => {
	it("P1: selects the requested session, not the first snapshot found", async () => {
		writeSnapshot(workDir, "session-alpha", { session_id: "session-alpha", agent_name: "a1" });
		writeSnapshot(workDir, "session-beta", { session_id: "session-beta", agent_name: "b1" });

		await trajectoryShowCommand({ cwd: workDir, session: "session-beta" });

		const idLine = lines.find((l) => l.startsWith("session_id:"));
		expect(idLine).toBe("session_id: session-beta");
	});

	it("N1: throws for a session id that matches nothing", async () => {
		writeSnapshot(workDir, "session-alpha", { session_id: "session-alpha", agent_name: "a1" });
		writeSnapshot(workDir, "session-beta", { session_id: "session-beta", agent_name: "b1" });

		await expect(
			trajectoryShowCommand({ cwd: workDir, session: "does-not-exist" }),
		).rejects.toThrow(/no trajectory snapshot found for session does-not-exist/);
	});
});

// ---------------------------------------------------------------------------
// trajectoryShowCommand — malformed JSON cause
// ---------------------------------------------------------------------------

describe("trajectoryShowCommand — malformed snapshot error cause", () => {
	it("P1: wraps the JSON parse error as .cause", async () => {
		mkdirSync(join(workDir, ".interlinked", "sessions"), { recursive: true });
		writeFileSync(
			join(workDir, ".interlinked", "sessions", "bad.trajectory.json"),
			"{ not valid json",
			"utf-8",
		);
		let caught: unknown;
		try {
			await trajectoryShowCommand({ cwd: workDir, session: "bad" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("Expected a replay error");
		expect(caught.cause).toBeDefined();
		expect(caught.cause).toBeInstanceOf(Error);
	});
});

// ---------------------------------------------------------------------------
// trajectoryShowCommand — session_id/agent_name skip from generic loop
// ---------------------------------------------------------------------------

describe("trajectoryShowCommand — session_id/agent_name printed exactly once", () => {
	it("P1: does not re-print session_id/agent_name via the generic field loop", async () => {
		const longSessionId = "S".repeat(300);
		const longAgentName = "A".repeat(300);
		writeSnapshot(workDir, "dupe-check", {
			session_id: longSessionId,
			agent_name: longAgentName,
			foo: "bar",
		});

		await trajectoryShowCommand({ cwd: workDir, session: "dupe-check" });

		const sessionIdLines = lines.filter((l) => l.startsWith("session_id:"));
		const agentNameLines = lines.filter((l) => l.startsWith("agent_name:"));
		expect(sessionIdLines).toHaveLength(1);
		expect(agentNameLines).toHaveLength(1);
		// The special-cased print uses the full value (no truncation); a
		// generic-loop leak would additionally print a truncated `…` line.
		expect(sessionIdLines[0]).toBe(`session_id: ${longSessionId}`);
		expect(agentNameLines[0]).toBe(`agent_name: ${longAgentName}`);
		expect(lines.some((l) => l.includes("…"))).toBe(false);
		expect(lines).toContain("foo: bar");
	});
});

// ---------------------------------------------------------------------------
// summarizeValue (reached only through trajectoryShowCommand's generic loop)
// ---------------------------------------------------------------------------

describe("trajectoryShowCommand — summarizeValue length threshold (positive/negative)", () => {
	it("P1: a 200-char string field is NOT truncated (length > 200 is false at exactly 200)", async () => {
		const exactly200 = "x".repeat(200);
		writeSnapshot(workDir, "boundary", {
			session_id: "boundary",
			agent_name: "n",
			field: exactly200,
		});
		await trajectoryShowCommand({ cwd: workDir, session: "boundary" });
		expect(lines).toContain(`field: ${exactly200}`);
	});

	it("N1: a short string field is NOT truncated", async () => {
		writeSnapshot(workDir, "short-check", {
			session_id: "short-check",
			agent_name: "n",
			field: "short",
		});
		await trajectoryShowCommand({ cwd: workDir, session: "short-check" });
		expect(lines).toContain("field: short");
		expect(lines.some((l) => l.startsWith("field:") && l.includes("…"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// trajectoryReplayCommand — default phase set + finding shape
// ---------------------------------------------------------------------------

function eventLine(sessionId: string): string {
	return JSON.stringify({
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		timestamp: "2026-01-01T00:00:00.000Z",
	});
}

describe("trajectoryReplayCommand — default phase array runs all three phases", () => {
	it("P1: findings are produced for pre_block, pre_warn, and stop", async () => {
		runSequenceDetectorsForPhaseMock.mockImplementation(
			(args: { phase: string }) => {
				if (args.phase === "pre_block") return [{ detector_id: "D_BLOCK", match: { message: "blockmsg" } }];
				if (args.phase === "pre_warn") return [{ detector_id: "D_WARN", match: { message: "warnmsg" } }];
				if (args.phase === "stop") return [{ detector_id: "D_STOP", match: { message: "stopmsg" } }];
				return [];
			},
		);
		const evFile = join(workDir, "events.jsonl");
		writeFileSync(evFile, `${eventLine("s1")}\n`, "utf-8");

		let captured = "";
		logSpy.mockImplementation((...args: unknown[]) => {
			captured += args.map(String).join(" ");
		});

		await trajectoryReplayCommand({ cwd: workDir, file: evFile, json: true });

		const parsed = JSON.parse(captured);
		expect(parsed.findings).toHaveLength(3);
		const phases = parsed.findings.map((f: { phase: string }) => f.phase).sort();
		expect(phases).toEqual(["pre_block", "pre_warn", "stop"]);
	});
});

describe("trajectoryReplayCommand — human-readable formatting call shape", () => {
	it("P1: formatSequenceFinding is invoked with family 'quality' and match.message set", async () => {
		runSequenceDetectorsForPhaseMock.mockImplementation((args: { phase: string }) => {
			if (args.phase === "pre_block") {
				return [{ detector_id: "D_ONE", match: { message: "hello-message" } }];
			}
			return [];
		});
		const evFile = join(workDir, "events2.jsonl");
		writeFileSync(evFile, `${eventLine("s2")}\n`, "utf-8");

		await trajectoryReplayCommand({ cwd: workDir, file: evFile });

		expect(formatSequenceFindingMock).toHaveBeenCalledTimes(1);
		const arg = formatSequenceFindingMock.mock.calls[0]?.[0];
		expect(arg.family).toBe("quality");
		expect(arg.match).toEqual({ message: "hello-message" });
		expect(lines.some((l) => l.includes("FMT|D_ONE|quality|pre_block|hello-message"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseHarnessEvent — field-type validation (via trajectoryReplayCommand)
// ---------------------------------------------------------------------------

describe("trajectoryReplayCommand — parseHarnessEvent validation (negative)", () => {
	beforeEach(() => {
		runSequenceDetectorsForPhaseMock.mockReturnValue([]);
	});

	it("N1: rejects a non-string agent_source", async () => {
		const evFile = join(workDir, "bad-agent-source.jsonl");
		writeFileSync(
			evFile,
			`${JSON.stringify({
				hook_event: "PreToolUse",
				session_id: "s3",
				agent_source: 42,
				timestamp: "2026-01-01T00:00:00.000Z",
			})}\n`,
			"utf-8",
		);
		await expect(trajectoryReplayCommand({ cwd: workDir, file: evFile })).rejects.toThrow(
			/missing\/invalid agent_source/,
		);
	});

	it("N2: rejects a non-string timestamp", async () => {
		const evFile = join(workDir, "bad-timestamp.jsonl");
		writeFileSync(
			evFile,
			`${JSON.stringify({
				hook_event: "PreToolUse",
				session_id: "s4",
				agent_source: "claude",
				timestamp: 12345,
			})}\n`,
			"utf-8",
		);
		await expect(trajectoryReplayCommand({ cwd: workDir, file: evFile })).rejects.toThrow(
			/missing\/invalid timestamp/,
		);
	});
});
