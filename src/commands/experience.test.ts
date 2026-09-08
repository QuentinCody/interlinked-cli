import { wireAbsentOptional, parseWire, wireArray, wireNullable, wireNumber, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// `interlinked experience` actions — export/analyze/list over session logs.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c } from "../lib/formatter.js";
import {
	experienceAnalyzeAction,
	experienceExportAction,
	experienceListAction,
} from "./experience.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function writeTimeline(): void {
	const rows = [
		{
			schema: "timeline.v1",
			ts: "2026-07-27T10:00:00.000Z",
			session: "sess-a",
			uuid: "u1",
			seq: 0,
			provider: "claude-code",
			category: "user_prompt",
			role: "user",
			text: "Do the thing.",
		},
		{
			schema: "timeline.v1",
			ts: "2026-07-27T10:00:01.000Z",
			session: "sess-a",
			uuid: "u2",
			seq: 0,
			provider: "claude-code",
			category: "agent_message",
			role: "assistant",
			text: "Done.",
		},
		{
			schema: "timeline.v1",
			ts: "2026-07-27T11:00:00.000Z",
			session: "sess-b",
			uuid: "u3",
			seq: 0,
			provider: "codex",
			category: "agent_message",
			role: "assistant",
			text: "Other session.",
		},
	];
	writeFileSync(
		join(dir, ".interlinked", "timeline.jsonl"),
		`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "experience-cmd-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeTimeline();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	logSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

function loggedText(): string {
	return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("experienceExportAction", () => {
	it("writes an ix trajectory file under .interlinked/trajectories/", () => {
		const code = experienceExportAction({ session: "sess-a", cwd: dir, json: true });
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.ix.jsonl");
		expect(existsSync(outPath)).toBe(true);
		const lines = readFileSync(outPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
		// SAFETY: first exported line is the meta record by construction.
		const meta = parseWire(JSON.parse(nonNull(lines[0])), wireObject({ "role": wireString, "schema": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(meta.role).toBe("meta");
		expect(meta.schema).toBe("trajectory-ix.v1");
	});

	it("exports the letta interop format without ix annotations", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			format: "letta",
			json: true,
		});
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.letta.jsonl");
		const lines = readFileSync(outPath, "utf-8").trim().split("\n");
		// SAFETY: first exported line is the meta record by construction.
		const meta = parseWire(JSON.parse(nonNull(lines[0])), wireRecord(wireUnknown), "test JSON value");
		expect(meta.schema).toBeUndefined();
		expect(meta.role).toBe("meta");
	});

	it("fails with exit 1 for a session with no records", () => {
		const code = experienceExportAction({ session: "sess-none", cwd: dir, json: true });
		expect(code).toBe(1);
	});

	it("rejects a non-numeric --truncate instead of exporting uncapped", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			truncate: "banana",
			json: true,
		});
		expect(code).toBe(1);
	});

	it("rejects an unrecognized --format value", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			format: "yaml",
			json: true,
		});
		expect(code).toBe(1);
	});

	it("accepts a valid --truncate and applies the cap", () => {
		const code = experienceExportAction({
			session: "sess-a",
			cwd: dir,
			truncate: "10",
			json: true,
		});
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.ix.jsonl");
		const lines = readFileSync(outPath, "utf-8").trim().split("\n");
		// SAFETY: first exported line is the meta record by construction.
		const meta = parseWire(JSON.parse(nonNull(lines[0])), wireObject({ "ix_meta": wireObject({ "truncate_chars": wireNumber }) }), "test JSON value");
		expect(meta.ix_meta.truncate_chars).toBe(10);
	});

	it("defaults cwd to process.cwd() when not supplied", () => {
		// `process.chdir` THROWS inside a worker thread, and Stryker's vitest
		// runner pins its own worker-thread pool — a single chdir in scope aborts
		// the whole mutation dry run with a generic "There were failed tests in
		// the initial test run" that names nothing. Spying on cwd is equivalent
		// here and works in both pools. realpathSync matches what the code sees
		// after macOS resolves the /var → /private/var symlink.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(dir));
		try {
			const code = experienceExportAction({ session: "sess-a", json: true });
			expect(code).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("prints a human-readable summary in normal mode with a complete scan", () => {
		const code = experienceExportAction({ session: "sess-a", cwd: dir });
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.ix.jsonl");
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Exported 3 records (ix) for sess-a"),
				`  out                 ${outPath}`,
				`  collection joined   0`,
				`  guard joined        0`,
				`  truncated records   0`,
				`  scan complete`,
			].join("\n"),
		);
	});

	it("flags a truncated scan in the normal-mode summary once the budget is exceeded", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:00.000Z",
				session: "sess-a",
				uuid: "u1",
				seq: 0,
				provider: "claude-code",
				category: "user_prompt",
				role: "user",
				text: "Do the thing.",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:01.000Z",
				session: "sess-a",
				uuid: "u2",
				seq: 0,
				provider: "claude-code",
				category: "agent_message",
				role: "assistant",
				text: "Done.",
			},
		];
		const filler = Array.from({ length: 50_050 }, (_, i) =>
			JSON.stringify({ schema: "filler", i }),
		).join("\n");
		const real = rows.map((r) => JSON.stringify(r)).join("\n");
		writeFileSync(join(dir, ".interlinked", "timeline.jsonl"), `${filler}\n${real}\n`);

		const code = experienceExportAction({ session: "sess-a", cwd: dir });
		expect(code).toBe(0);
		const outPath = join(dir, ".interlinked", "trajectories", "sess-a.ix.jsonl");
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Exported 3 records (ix) for sess-a"),
				`  out                 ${outPath}`,
				`  collection joined   0`,
				`  guard joined        0`,
				`  truncated records   0`,
				c.yellow(
					"  scan hit its budget — oldest records may be missing (raise with --json tooling)",
				),
			].join("\n"),
		);
	});
});

describe("experienceAnalyzeAction", () => {
	it("prints deterministic metrics for the session", () => {
		const code = experienceAnalyzeAction({ session: "sess-a", cwd: dir, json: true });
		expect(code).toBe(0);
		// SAFETY: --json mode prints exactly one JSON document.
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "records": wireNumber, "by_role": wireRecord(wireNumber) }), "test JSON value");
		expect(parsed.records).toBe(2);
		expect(parsed.by_role).toEqual({ user: 1, assistant: 1 });
	});

	it("fails with exit 1 for a session with no records", () => {
		const code = experienceAnalyzeAction({ session: "sess-none", cwd: dir, json: true });
		expect(code).toBe(1);
	});

	it("defaults cwd to process.cwd() when not supplied", () => {
		// See the chdir/worker-thread note above.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(dir));
		try {
			const code = experienceAnalyzeAction({ session: "sess-a", json: true });
			expect(code).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("prints an empty-shaped normal-mode summary (no tool calls, no guard events)", () => {
		const code = experienceAnalyzeAction({ session: "sess-a", cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Experience metrics"),
				`  records            2  episodes=1  span_ms=1000`,
				`  roles              user=1 assistant=1`,
				`  tool calls         0  errors=0  verification_runs=0`,
				`  tool classes       -`,
				`  files              edits=0 distinct=0 reworked=0`,
				`  guard              blocks=0 warns=0`,
				`  verify:edit        -`,
				`  think:message      0.00`,
			].join("\n"),
		);
	});

	it("renders non-empty tool/guard/ratio fields in normal mode", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:00.000Z",
				session: "sess-rich",
				uuid: "u1",
				seq: 0,
				provider: "claude-code",
				category: "user_prompt",
				role: "user",
				text: "Fix the bug.",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:01.000Z",
				session: "sess-rich",
				uuid: "u2",
				seq: 0,
				provider: "claude-code",
				category: "agent_thinking",
				role: "reasoning",
				text: "Thinking about it carefully.",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:02.000Z",
				session: "sess-rich",
				uuid: "u3",
				seq: 0,
				provider: "claude-code",
				category: "tool_use",
				role: "assistant",
				tool_use_id: "tu1",
				tool_name: "Edit",
				tool_input: { file_path: "src/a.ts" },
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:03.000Z",
				session: "sess-rich",
				uuid: "u4",
				seq: 0,
				provider: "claude-code",
				category: "tool_result",
				role: "tool",
				tool_use_id: "tu1",
				text: "ok",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:04.000Z",
				session: "sess-rich",
				uuid: "u5",
				seq: 0,
				provider: "claude-code",
				category: "agent_message",
				role: "assistant",
				text: "Fixed.",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		writeFileSync(
			join(dir, ".interlinked", "collection.jsonl"),
			`${JSON.stringify({
				kind: "tool_event",
				phase: "post",
				session_id: "sess-rich",
				tool_use_id: "tu1",
				tool_class: "file_edit",
				outcome: "ok",
				action: { path: "src/a.ts" },
			})}\n`,
		);
		writeFileSync(
			join(dir, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({
				type: "guard_block",
				tool_use_id: "tu1",
				guard_rule_id: "no-eval",
				guard_reason: "eval() forbidden",
			})}\n`,
		);

		const code = experienceAnalyzeAction({ session: "sess-rich", cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Experience metrics"),
				`  records            5  episodes=1  span_ms=4000`,
				`  roles              user=1 reasoning=1 assistant=2 tool=1`,
				`  tool calls         1  errors=0  verification_runs=0`,
				`  tool classes       file_edit=1`,
				`  files              edits=1 distinct=1 reworked=0`,
				`  guard              blocks=1 warns=0  top: no-eval×1`,
				`  verify:edit        0`,
				`  think:message      4.67`,
			].join("\n"),
		);
	});

	it("shows a dash for think:message when there is no assistant message content", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:00.000Z",
				session: "sess-think",
				uuid: "u1",
				seq: 0,
				provider: "claude-code",
				category: "agent_thinking",
				role: "reasoning",
				text: "Just thinking, never replying.",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceAnalyzeAction({ session: "sess-think", cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Experience metrics"),
				`  records            1  episodes=1  span_ms=0`,
				`  roles              reasoning=1`,
				`  tool calls         0  errors=0  verification_runs=0`,
				`  tool classes       -`,
				`  files              edits=0 distinct=0 reworked=0`,
				`  guard              blocks=0 warns=0`,
				`  verify:edit        -`,
				`  think:message      -`,
			].join("\n"),
		);
	});

	it("shows a dash for span_ms when timestamps are not parseable as dates", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "not-a-real-timestamp",
				session: "sess-badts",
				uuid: "u1",
				seq: 0,
				provider: "claude-code",
				category: "agent_message",
				role: "assistant",
				text: "Hi.",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceAnalyzeAction({ session: "sess-badts", cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Experience metrics"),
				`  records            1  episodes=1  span_ms=-`,
				`  roles              assistant=1`,
				`  tool calls         0  errors=0  verification_runs=0`,
				`  tool classes       -`,
				`  files              edits=0 distinct=0 reworked=0`,
				`  guard              blocks=0 warns=0`,
				`  verify:edit        -`,
				`  think:message      0.00`,
			].join("\n"),
		);
	});
});

describe("experienceListAction", () => {
	it("lists sessions newest-last-activity first with record counts", () => {
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		// SAFETY: --json mode prints exactly one JSON document.
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString, "records": wireNumber, "provider": wireNullable(wireString) })) }), "test JSON value");
		expect(parsed.sessions.map((s) => s.session)).toEqual(["sess-b", "sess-a"]);
		expect(parsed.sessions[1]).toMatchObject({ session: "sess-a", records: 2 });
	});

	it("defaults cwd to process.cwd() when not supplied", () => {
		// See the chdir/worker-thread note above.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(dir));
		try {
			const code = experienceListAction({ json: true });
			expect(code).toBe(0);
			const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
			expect(parsed.sessions.map((s) => s.session)).toEqual(["sess-b", "sess-a"]);
		} finally {
			spy.mockRestore();
		}
	});

	it("honors a valid --limit", () => {
		const code = experienceListAction({ cwd: dir, limit: "1", json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0]?.session).toBe("sess-b");
	});

	it("falls back to the default limit for a non-positive --limit", () => {
		const code = experienceListAction({ cwd: dir, limit: "-3", json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions).toHaveLength(2);
	});

	it("treats an unparsable --limit as the default", () => {
		const code = experienceListAction({ cwd: dir, limit: "not-a-number", json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions).toHaveLength(2);
	});

	it("skips non-timeline rows, missing timestamps, and defaults a missing provider to null", () => {
		const rows = [
			// Wrong schema — must be skipped without throwing.
			{ schema: "other.v1", session: "sess-a", ts: "2026-07-27T12:00:00.000Z" },
			// timeline.v1 but no ts — must be skipped.
			{ schema: "timeline.v1", session: "sess-a" },
			// Valid row with no provider field.
			{
				schema: "timeline.v1",
				ts: "2026-07-27T12:00:00.000Z",
				session: "sess-noprovider",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString, "provider": wireNullable(wireString), "records": wireNumber })) }), "test JSON value");
		expect(parsed.sessions).toEqual([
			{
				session: "sess-noprovider",
				records: 1,
				provider: null,
				first_ts: "2026-07-27T12:00:00.000Z",
				last_ts: "2026-07-27T12:00:00.000Z",
			},
		]);
	});

	it("sorts sessions with identical last_ts as equal (stable order)", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T12:00:00.000Z",
				session: "sess-x",
				provider: "claude-code",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T12:00:00.000Z",
				session: "sess-y",
				provider: "claude-code",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions.map((s) => s.session).sort()).toEqual(["sess-x", "sess-y"]);
	});

	it("prints a normal-mode listing with a complete scan", () => {
		const code = experienceListAction({ cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Sessions in the timeline tail (2/2)"),
				`  sess-b      1 records  codex  2026-07-27T11:00:00.000Z → 2026-07-27T11:00:00.000Z`,
				`  sess-a      2 records  claude-code  2026-07-27T10:00:00.000Z → 2026-07-27T10:00:01.000Z`,
			].join("\n"),
		);
	});

	it("flags a truncated scan in the normal-mode listing once the budget is exceeded", () => {
		const filler = Array.from({ length: 50_050 }, (_, i) =>
			JSON.stringify({ schema: "filler", i }),
		).join("\n");
		const real = JSON.stringify({
			schema: "timeline.v1",
			ts: "2026-07-27T12:00:00.000Z",
			session: "sess-tail",
			provider: "claude-code",
		});
		writeFileSync(join(dir, ".interlinked", "timeline.jsonl"), `${filler}\n${real}\n`);

		const code = experienceListAction({ cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Sessions in the timeline tail (1/1)"),
				`  sess-tail      1 records  claude-code  2026-07-27T12:00:00.000Z → 2026-07-27T12:00:00.000Z`,
				c.dim("  (bounded scan — older sessions may be missing)"),
			].join("\n"),
		);
	});

	it("sorts three sessions with distinct last_ts into newest-first order", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T09:00:00.000Z",
				session: "sess-oldest",
				provider: "claude-code",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T10:00:00.000Z",
				session: "sess-middle",
				provider: "claude-code",
			},
			{
				schema: "timeline.v1",
				ts: "2026-07-27T11:00:00.000Z",
				session: "sess-newest",
				provider: "claude-code",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions.map((s) => s.session)).toEqual([
			"sess-newest",
			"sess-middle",
			"sess-oldest",
		]);
	});

	it("sorts sessions delivered out of chronological insertion order (exercises the '>' comparator arm)", () => {
		// Written top-to-bottom as [mid, new, old]; the backward scan delivers
		// (and thus inserts into the session map) in the order old, new, mid —
		// forcing the sort comparator to directly compare a newer against an
		// older-inserted-but-chronologically-between session.
		const mid = {
			schema: "timeline.v1",
			ts: "2026-07-27T10:00:00.000Z",
			session: "sess-mid",
			provider: "claude-code",
		};
		const newer = {
			schema: "timeline.v1",
			ts: "2026-07-27T11:00:00.000Z",
			session: "sess-newer",
			provider: "claude-code",
		};
		const old = {
			schema: "timeline.v1",
			ts: "2026-07-27T09:00:00.000Z",
			session: "sess-old",
			provider: "claude-code",
		};
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${[mid, newer, old].map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceListAction({ cwd: dir, json: true });
		expect(code).toBe(0);
		const parsed = parseWire(JSON.parse(loggedText()), wireObject({ "sessions": wireArray(wireObject({ "session": wireString })) }), "test JSON value");
		expect(parsed.sessions.map((s) => s.session)).toEqual(["sess-newer", "sess-mid", "sess-old"]);
	});

	it("renders '?' for a session with no provider in normal mode", () => {
		const rows = [
			{
				schema: "timeline.v1",
				ts: "2026-07-27T12:00:00.000Z",
				session: "sess-noprovider",
			},
		];
		writeFileSync(
			join(dir, ".interlinked", "timeline.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		const code = experienceListAction({ cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			[
				c.bold("Sessions in the timeline tail (1/1)"),
				`  sess-noprovider      1 records  ?  2026-07-27T12:00:00.000Z → 2026-07-27T12:00:00.000Z`,
			].join("\n"),
		);
	});
});
