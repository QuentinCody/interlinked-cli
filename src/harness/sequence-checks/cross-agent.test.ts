import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrajectoryFixture, makeCandidate } from "../__tests__/sequence-fixtures.js";
import { _clearCrossSessionCache } from "../cross-session.js";
import {
	CROSS_AGENT_DETECTORS,
	fileOverwriteAfterOtherAgent,
	staleReadThenWrite,
	subagentDivergedEdit,
} from "./cross-agent.js";

// Pin "now" so detectors that compare ISO timestamps against `Date.now()`
// (subagent_diverged_edit, file_overwrite_after_other_agent) behave
// deterministically across CI runs.
const FROZEN_NOW = new Date("2026-05-27T12:00:00.000Z");

beforeAll(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
	vi.useRealTimers();
});

// ===========================================
// Shared helpers
// ===========================================

interface ActivityRow {
	hook_event?: string;
	session_id?: string;
	agent_source?: string;
	agent_name?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	timestamp: string;
	cwd?: string;
}

function writeActivityLog(dir: string, events: ReadonlyArray<ActivityRow>): void {
	const sub = join(dir, ".interlinked");
	mkdirSync(sub, { recursive: true });
	const lines = events.map((e) =>
		JSON.stringify({
			hook_event: "PostToolUse",
			session_id: "other-session",
			agent_source: "claude",
			...e,
		}),
	);
	writeFileSync(join(sub, "activity.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

function writeV5ActivityLog(dir: string, events: ReadonlyArray<Record<string, unknown>>): void {
	const sub = join(dir, ".interlinked");
	mkdirSync(sub, { recursive: true });
	writeFileSync(
		join(sub, "activity.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf-8",
	);
}

/** Minutes from now, formatted as ISO. Negative values are in the past. */
function isoMinutesFromNow(minutes: number): string {
	return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// ===========================================
// stale_read_then_write
// ===========================================

describe("stale_read_then_write", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stale-read-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("fires when another agent wrote the file after this session's started_at", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = staleReadThenWrite.fn(session, candidate);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/stale|rival|since this session/i);
	});

	it("fires from a real v5 activity row after wire-field normalization", () => {
		const filePath = "src/v5-live.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeV5ActivityLog(dir, [
			{
				schema_version: 5,
				ts: "2026-05-27T00:05:00.000Z",
				agent: "rival",
				type: "tool_use_start",
				tool: "Edit",
				tool_input: { file_path: filePath },
				session: "other-session",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});

		expect(staleReadThenWrite.fn(session, candidate)).toMatchObject([
			{ prior_summary: expect.stringContaining(`rival wrote ${filePath}`) },
		]);
	});

	it("fires for Write candidate even when prior other-agent write was MultiEdit", () => {
		const filePath = "src/auth.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "MultiEdit",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:10:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate).length).toBe(1);
	});

	it("fires when multiple other-agent writes are observed, summarizing the latest", () => {
		const filePath = "src/db.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:03:00.000Z",
			},
			{
				agent_name: "rival",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:09:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = staleReadThenWrite.fn(session, candidate);
		expect(matches.length).toBe(1);
		expect(matches[0]?.prior_event_count).toBe(2);
	});

	it("does not fire when the candidate is not a Write/Edit", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the session has never read the file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "other.ts" }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the only other writes are by the same agent_name", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "me",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	describe("subagent self-attribution — positive/negative (2026-09-02 false-positive fix)", () => {
		it("N1: does not fire on a subagent's own prior write — same session_id, different agent_name", () => {
			// Reproduces the observed shape: a subagent's tool calls land in
			// activity.jsonl under the PARENT session id, but with the
			// subagent's own per-call agent_name hash. Same session, so it
			// must read as self even though agent_name differs from the
			// trajectory's ("me").
			const filePath = "src/gate.ts";
			const { session } = buildTrajectoryFixture(
				[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
				{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me", session_id: "test-session" },
			);
			writeActivityLog(dir, [
				{
					agent_name: "a24a6a5628eeba5b3",
					session_id: "test-session",
					tool_name: "Edit",
					tool_input: { file_path: filePath },
					timestamp: "2026-05-27T00:05:00.000Z",
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				cwd: dir,
				agent_name: "me",
				session_id: "test-session",
			});
			expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
		});

		it("P1: fires on a write from a different session_id and different agent_name", () => {
			const filePath = "src/gate.ts";
			const { session } = buildTrajectoryFixture(
				[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
				{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me", session_id: "test-session" },
			);
			writeActivityLog(dir, [
				{
					agent_name: "rival",
					session_id: "rival-session",
					tool_name: "Edit",
					tool_input: { file_path: filePath },
					timestamp: "2026-05-27T00:05:00.000Z",
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				cwd: dir,
				agent_name: "me",
				session_id: "test-session",
			});
			expect(staleReadThenWrite.fn(session, candidate)).toHaveLength(1);
		});
	});

	it("does not fire when tool_input is missing (getFilePath's !toolInput branch)", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		const candidate = makeCandidate({ tool_name: "Edit", cwd: dir, agent_name: "me" });
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when tool_input is present but file_path is not a string (getFilePath's typeof branch)", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: 123 as unknown as string },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("skips an activity row missing file_path (fileMatches' empty-eventFile guard), then still matches", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			// Write tool but no file_path at all — eventFilePath resolves to "",
			// hitting fileMatches' `!eventFile` guard.
			{
				agent_name: "rival",
				tool_name: "Write",
				timestamp: "2026-05-27T00:02:00.000Z",
			},
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when the candidate has no cwd", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		const candidate = makeCandidate({ tool_name: "Edit", tool_input: { file_path: filePath }, agent_name: "me" });
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when isAfter's operands are empty (started_at unset)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the other-agent write's timestamp EQUALS started_at (isAfter's strict >)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:10:00.000Z", agent_name: "me" },
		);
		// Equal to started_at: loadRecentWorkspaceEvents' `<` filter keeps it
		// (not strictly earlier), but isAfter requires strictly `>` — this
		// exercises that gap, not the loader's own boundary.
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:10:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});

	it("skips a non-write-tool row and an unrelated-file row, then still matches a later row (fileMatches false + tool filter)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			// Not a write tool at all — hits the WRITE_TOOLS.has() false branch.
			{
				agent_name: "rival",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				timestamp: "2026-05-27T00:01:00.000Z",
			},
			// A write, but to a totally unrelated path — fileMatches returns
			// false via its final `return false` (no equal, no tail match).
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "docs/unrelated.md" },
				timestamp: "2026-05-27T00:02:00.000Z",
			},
			// The actual match.
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = staleReadThenWrite.fn(session, candidate);
		expect(matches.length).toBe(1);
	});

	it("matches via a tail-match: an absolute event path ending with the relative candidate path", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "/repo/project/src/foo.ts" },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate).length).toBe(1);
	});

	it("matches via a tail-match: a relative event path that the absolute candidate path ends with", () => {
		const filePath = "/repo/project/src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:00:00.000Z", agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "src/foo.ts" },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when the other-agent write predates started_at", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ started_at: "2026-05-27T00:10:00.000Z", agent_name: "me" },
		);
		// Write is older than started_at — but loadRecentWorkspaceEvents
		// would filter it out at the since-timestamp boundary, so this
		// also exercises that we don't accidentally include pre-session
		// writes.
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T00:05:00.000Z",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(staleReadThenWrite.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// subagent_diverged_edit
// ===========================================

describe("subagent_diverged_edit", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "subagent-div-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("fires when this session and another agent both recently wrote the same file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "subagent-x",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-10),
			},
		]);
		const candidate = makeCandidate({
			hook_event: "Stop",
			cwd: dir,
			agent_name: "parent",
		});
		const matches = subagentDivergedEdit.fn(session, candidate);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/subagent|divergence|both|wrote/i);
	});

	it("fires once per file even with multiple other-agent writes", () => {
		const filePath = "src/db.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Edit", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub-a",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-20),
			},
			{
				agent_name: "sub-b",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		const matches = subagentDivergedEdit.fn(session, candidate);
		expect(matches.length).toBe(1);
	});

	it("fires for two different files written by two different other agents", () => {
		const fileA = "src/a.ts";
		const fileB = "src/b.ts";
		const { session } = buildTrajectoryFixture(
			[
				{ tool_name: "Write", tool_input: { file_path: fileA }, cwd: dir },
				{ tool_name: "Edit", tool_input: { file_path: fileB }, cwd: dir },
			],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub-a",
				tool_name: "Edit",
				tool_input: { file_path: fileA },
				timestamp: isoMinutesFromNow(-5),
			},
			{
				agent_name: "sub-b",
				tool_name: "Write",
				tool_input: { file_path: fileB },
				timestamp: isoMinutesFromNow(-3),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		const matches = subagentDivergedEdit.fn(session, candidate);
		expect(matches.length).toBe(2);
	});

	it("does not fire when the other-agent write is older than 30 minutes", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-90),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when only this agent has written the file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "parent",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the candidate has no cwd", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		const candidate = makeCandidate({ hook_event: "Stop", agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("handles an empty written file_path safely (canonicalKey's !path branch)", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: "" }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Edit",
				tool_input: { file_path: "src/real.ts" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("skips a non-write-tool row before finding the real match", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				timestamp: isoMinutesFromNow(-5),
			},
			{
				agent_name: "sub",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-4),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when the other-agent write's timestamp fails to parse (Number.isNaN branch)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				// Lexically sorts after the loader's ISO since-boundary (leading
				// letter > any digit) so it survives loadRecentWorkspaceEvents'
				// string filter, but Date.parse cannot parse it.
				timestamp: "zzz-not-a-real-timestamp",
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the parsed instant is before the window despite a lexically-later timestamp string", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Write", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "parent" },
		);
		// FROZEN_NOW is 2026-05-27T12:00:00.000Z; the 30-minute window starts at
		// 11:30:00.000Z. "+01:00" makes the string lexically GREATER (hour "12" >
		// "11") than the UTC since-boundary, so loadRecentWorkspaceEvents' plain
		// string compare keeps it — but it numerically resolves to 11:29:00Z,
		// one minute BEFORE the window start.
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T12:29:00+01:00",
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when this session has not written anything", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" }, cwd: dir }],
			{ agent_name: "parent" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "sub",
				tool_name: "Write",
				tool_input: { file_path: "src/foo.ts" },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({ hook_event: "Stop", cwd: dir, agent_name: "parent" });
		expect(subagentDivergedEdit.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// file_overwrite_after_other_agent
// ===========================================

describe("file_overwrite_after_other_agent", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "overwrite-other-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("fires when another agent wrote the file in the last hour and we haven't read it", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "other.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-15),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		const matches = fileOverwriteAfterOtherAgent.fn(session, candidate);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/overwrite|read it|rival/i);
	});

	it("fires for Edit candidate, not just Write", () => {
		const filePath = "src/auth.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Edit",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate).length).toBe(1);
	});

	it("fires even when no activity log existed for the session before now", () => {
		const filePath = "src/new.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-1),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when this session has already read the file", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: filePath }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-10),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the other-agent write is older than one hour", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-120),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the only other writes are by the same agent_name", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "me",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	describe("subagent self-attribution — positive/negative (2026-09-02 false-positive fix)", () => {
		it("N1: does not fire on a subagent's own prior write — same session_id, different agent_name", () => {
			const filePath = "src/gate.ts";
			const { session } = buildTrajectoryFixture(
				[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
				{ agent_name: "me", session_id: "test-session" },
			);
			writeActivityLog(dir, [
				{
					agent_name: "afdfb5ad4ab629fa8",
					session_id: "test-session",
					tool_name: "Edit",
					tool_input: { file_path: filePath },
					timestamp: isoMinutesFromNow(-5),
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Write",
				tool_input: { file_path: filePath },
				cwd: dir,
				agent_name: "me",
				session_id: "test-session",
			});
			expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
		});

		it("P1: fires on a write from a different session_id and different agent_name", () => {
			const filePath = "src/gate.ts";
			const { session } = buildTrajectoryFixture(
				[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
				{ agent_name: "me", session_id: "test-session" },
			);
			writeActivityLog(dir, [
				{
					agent_name: "rival",
					session_id: "rival-session",
					tool_name: "Edit",
					tool_input: { file_path: filePath },
					timestamp: isoMinutesFromNow(-5),
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Write",
				tool_input: { file_path: filePath },
				cwd: dir,
				agent_name: "me",
				session_id: "test-session",
			});
			expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toHaveLength(1);
		});
	});

	it("skips a non-write-tool row and an unrelated-file row, then still matches", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-30),
			},
			{
				agent_name: "rival",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				timestamp: isoMinutesFromNow(-20),
			},
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: "docs/other.md" },
				timestamp: isoMinutesFromNow(-10),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when the other-agent write's timestamp fails to parse (Number.isNaN branch)", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "zzz-not-a-real-timestamp",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the parsed instant is before the window despite a lexically-later timestamp string", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		// FROZEN_NOW is 2026-05-27T12:00:00.000Z; the 1-hour window starts at
		// 11:00:00.000Z. "+01:00" makes the string lexically greater than the
		// UTC since-boundary (so the loader keeps it) while numerically
		// resolving to 10:59:00Z — one minute before the window start.
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-27T11:59:00+01:00",
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the candidate has no file_path", () => {
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		const candidate = makeCandidate({ tool_name: "Write", cwd: dir, agent_name: "me" });
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the candidate has no cwd", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		const candidate = makeCandidate({ tool_name: "Write", tool_input: { file_path: filePath }, agent_name: "me" });
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});

	it("does not fire on non-Write candidates", () => {
		const filePath = "src/foo.ts";
		const { session } = buildTrajectoryFixture(
			[{ tool_name: "Read", tool_input: { file_path: "unrelated.ts" }, cwd: dir }],
			{ agent_name: "me" },
		);
		writeActivityLog(dir, [
			{
				agent_name: "rival",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: isoMinutesFromNow(-5),
			},
		]);
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: filePath },
			cwd: dir,
			agent_name: "me",
		});
		expect(fileOverwriteAfterOtherAgent.fn(session, candidate)).toEqual([]);
	});
});

// ===========================================
// CROSS_AGENT_DETECTORS array export
// ===========================================

describe("CROSS_AGENT_DETECTORS", () => {
	it("exports the three detectors in declared order", () => {
		expect(CROSS_AGENT_DETECTORS).toEqual([
			staleReadThenWrite,
			subagentDivergedEdit,
			fileOverwriteAfterOtherAgent,
		]);
	});

	it("every detector has family === 'cross-agent'", () => {
		for (const d of CROSS_AGENT_DETECTORS) {
			expect(d.family).toBe("cross-agent");
		}
	});

	it("every detector has determinism === 'fully_deterministic' and default_enabled === true", () => {
		for (const d of CROSS_AGENT_DETECTORS) {
			expect(d.determinism).toBe("fully_deterministic");
			expect(d.default_enabled).toBe(true);
		}
	});
});
