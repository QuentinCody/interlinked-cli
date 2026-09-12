// Companion tests for the collection-stream reader + low-level JSONL helpers.
//
// Everything here drives the REAL functions against REAL files in a tmpdir —
// no mocks. The two projection functions (`collectionToActivity`,
// `agentEventToActivity`) are module-private, so they are exercised the only
// way a caller can reach them: by writing collection.jsonl lines and asserting
// the projected `LocalActivityEvent` that comes back.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventRecord, CollectionRecord } from "./collection/types.js";
import {
	countJsonlLines,
	parseCollectionOrAgentEvent,
	parseLocalActivityEvent,
	readCollectionActivity,
	readRecentLines,
} from "./local-activity-collection.js";
import type { LocalActivityEvent } from "./local-activity-types.js";
import { nonNull } from "./non-null.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTERLINKED = ".interlinked";

/** Write collection.jsonl. Plain strings pass through verbatim so malformed /
 *  legacy-shaped lines can be exercised. */
function writeCollection(tmp: string, records: unknown[]): void {
	mkdirSync(join(tmp, INTERLINKED), { recursive: true });
	const body = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
	writeFileSync(join(tmp, INTERLINKED, "collection.jsonl"), records.length ? `${body}\n` : "");
}

function toolEvent(over: Partial<CollectionRecord> = {}): CollectionRecord {
	return {
		schema: "collection.v1",
		kind: "tool_event",
		ts: "2026-07-30T10:00:00Z",
		session_id: "sess-1",
		agent_name: "alpha",
		turn_id: null,
		tool_use_id: null,
		provider: "claude",
		phase: "post",
		tool_class: "shell_exec",
		provider_tool: "Bash",
		cwd: null,
		git: null,
		action: { command: "ls -la" },
		observation: null,
		fidelity: {
			record: { source: "provider_hook", completeness: "complete" },
			fields: {},
		},
		privacy: {
			redaction_status: "not_required",
			redaction_passes: [],
			sensitivity: "unknown",
			contains_sensitive: "unknown",
			allowed_for_training: false,
			allowed_for_cloud_upload: false,
		},
		provider_raw: {
			tool_input_ref: null,
			tool_response_ref: null,
			tool_input_sha256: null,
			tool_response_sha256: null,
		},
		...over,
	};
}

function agentEvent(over: Partial<AgentEventRecord> = {}): AgentEventRecord {
	return {
		schema: "collection.v1",
		kind: "agent_event",
		ts: "2026-07-30T11:00:00Z",
		session_id: "sess-1",
		agent_name: "alpha",
		provider: "claude",
		event: "subagent_stop",
		agent_type_source: null,
		metrics: null,
		subagent_id: null,
		agent_type: null,
		parent_agent: null,
		agent_transcript_path: null,
		last_assistant_message: null,
		message_source: null,
		task: null,
		cwd: null,
		...over,
	};
}

/** Write one record and return the single projected event. */
function projectOne(tmp: string, rec: unknown): LocalActivityEvent {
	writeCollection(tmp, [rec]);
	const events = readCollectionActivity({ cwd: tmp });
	expect(events).toHaveLength(1);
	return nonNull(events[0]);
}

// ---------------------------------------------------------------------------
// readCollectionActivity — tool_event projection
// ---------------------------------------------------------------------------

describe("readCollectionActivity — tool_event projection", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-tool-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] when collection.jsonl does not exist", () => {
		expect(readCollectionActivity({ cwd: tmp })).toEqual([]);
	});

	it("projects a post tool_event to the full v5 display shape", () => {
		const ev = projectOne(
			tmp,
			toolEvent({ cwd: "/work/repo", tool_use_id: "tu_9", outcome: "ok" }),
		);
		expect(ev).toEqual({
			schema_version: 5,
			ts: "2026-07-30T10:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tool: "Bash",
			summary: "ls -la",
			session: "sess-1",
			hook: "PostToolUse",
			cwd: "/work/repo",
			tool_use_id: "tu_9",
		});
	});

	it("omits cwd and tool_use_id when the record carries neither", () => {
		const ev = projectOne(tmp, toolEvent({ cwd: null, tool_use_id: null }));
		expect("cwd" in ev).toBe(false);
		expect("tool_use_id" in ev).toBe(false);
	});

	const phaseCases: Array<{
		name: string;
		over: Partial<CollectionRecord>;
		type: string;
		hook: string;
	}> = [
		{ name: "pre", over: { phase: "pre" }, type: "tool_use_start", hook: "PreToolUse" },
		{
			name: "pre ignores outcome",
			over: { phase: "pre", outcome: "error" },
			type: "tool_use_start",
			hook: "PreToolUse",
		},
		{
			name: "post ok",
			over: { phase: "post", outcome: "ok" },
			type: "tool_use",
			hook: "PostToolUse",
		},
		{
			name: "post error",
			over: { phase: "post", outcome: "error" },
			type: "tool_use_error",
			hook: "PostToolUse",
		},
		{
			name: "post legacy (no outcome field) reads as success",
			over: { phase: "post" },
			type: "tool_use",
			hook: "PostToolUse",
		},
	];

	it.each(phaseCases)("maps phase/outcome — $name", ({ over, type, hook }) => {
		const ev = projectOne(tmp, toolEvent(over));
		expect(ev.type).toBe(type);
		expect(ev.hook).toBe(hook);
	});

	const agentNameCases: Array<{ name: string; over: Partial<CollectionRecord>; agent: string }> = [
		{ name: "agent_name wins", over: { agent_name: "alpha" }, agent: "alpha" },
		{ name: "provider is the fallback", over: { agent_name: null }, agent: "claude" },
	];

	it.each(agentNameCases)("resolves the agent label — $name", ({ over, agent }) => {
		expect(projectOne(tmp, toolEvent(over)).agent).toBe(agent);
	});

	it('falls back to "unknown" when a legacy line has neither agent_name nor provider', () => {
		// A hand-written / pre-agent_name record: both attribution fields absent.
		const ev = projectOne(tmp, '{"kind":"tool_event","ts":"2026-07-30T10:00:00Z","phase":"post"}');
		expect(ev.agent).toBe("unknown");
	});

	const summaryCases: Array<{ name: string; action: unknown; summary: string | null }> = [
		{ name: "shell command", action: { command: "git status" }, summary: "git status" },
		{ name: "file path", action: { path: "src/a.ts" }, summary: "src/a.ts" },
		{ name: "search pattern", action: { pattern: "TODO", path: null }, summary: "TODO" },
		{ name: "fetch url", action: { url: "https://example.test" }, summary: "https://example.test" },
		{ name: "task", action: { task: "review the diff" }, summary: "review the diff" },
		{ name: "mcp tool", action: { tool: "search_docs" }, summary: "search_docs" },
		{ name: "null action", action: null, summary: null },
		{ name: "no recognised key", action: { provider_input: { a: 1 } }, summary: null },
		{
			name: "empty command falls through to the next key",
			action: { command: "", path: "src/b.ts" },
			summary: "src/b.ts",
		},
		{
			name: "non-string command falls through to the next key",
			action: { command: 42, url: "https://fallback.test" },
			summary: "https://fallback.test",
		},
		{
			name: "precedence: command outranks path",
			action: { command: "rg x", path: "src/c.ts" },
			summary: "rg x",
		},
	];

	it.each(summaryCases)("summarizes the action — $name", ({ action, summary }) => {
		const ev = projectOne(tmp, { ...toolEvent(), action });
		expect(ev.summary).toBe(summary);
	});
});

// ---------------------------------------------------------------------------
// readCollectionActivity — agent_event projection
// ---------------------------------------------------------------------------

describe("readCollectionActivity — agent_event projection", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-agent-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("projects a fully-populated subagent_stop record", () => {
		const ev = projectOne(
			tmp,
			agentEvent({
				last_assistant_message: "done: 3 files changed",
				subagent_id: "agent-77",
				agent_type: "code-reviewer",
				parent_agent: "alpha",
				agent_transcript_path: "/home/u/.claude/subagents/agent-77.jsonl",
				cwd: "/work/repo",
			}),
		);
		expect(ev).toEqual({
			schema_version: 5,
			ts: "2026-07-30T11:00:00Z",
			agent: "alpha",
			type: "subagent_stop",
			tool: "code-reviewer",
			summary: "done: 3 files changed",
			session: "sess-1",
			hook: "SubagentStop",
			cwd: "/work/repo",
			subagent_id: "agent-77",
			parent_agent: "alpha",
			agent_type: "code-reviewer",
			last_assistant_message: "done: 3 files changed",
			agent_transcript_path: "/home/u/.claude/subagents/agent-77.jsonl",
		});
	});

	it("omits every optional field when the record carries none of them", () => {
		const ev = projectOne(tmp, agentEvent());
		const optional = [
			"cwd",
			"subagent_id",
			"parent_agent",
			"agent_type",
			"last_assistant_message",
			"agent_transcript_path",
		];
		expect(optional.filter((k) => k in ev)).toEqual([]);
		// The always-present columns still project.
		expect(ev.tool).toBeNull();
		expect(ev.summary).toBeNull();
		expect(ev.type).toBe("subagent_stop");
		expect(ev.hook).toBe("SubagentStop");
	});

	const hookCases: Array<{ event: AgentEventRecord["event"]; hook: string }> = [
		{ event: "subagent_start", hook: "SubagentStart" },
		{ event: "subagent_stop", hook: "SubagentStop" },
		{ event: "task_completed", hook: "TaskCompleted" },
	];

	it.each(hookCases)("labels the $event hook column as $hook", ({ event, hook }) => {
		const ev = projectOne(tmp, agentEvent({ event }));
		expect(ev.hook).toBe(hook);
		// `type` carries the raw event name so `logs --type task_completed` works.
		expect(ev.type).toBe(event);
	});

	const summaryCases: Array<{
		name: string;
		over: Partial<AgentEventRecord>;
		summary: string | null;
	}> = [
		{
			name: "the final assistant message wins",
			over: {
				last_assistant_message: "result text",
				task: { task_id: "t1", task_subject: "subject", teammate_name: null, team_name: null },
			},
			summary: "result text",
		},
		{
			name: "task_subject is the fallback when no message was captured",
			over: {
				event: "task_completed",
				last_assistant_message: null,
				task: {
					task_id: "t1",
					task_subject: "ship the ratchet",
					teammate_name: "bo",
					team_name: "core",
				},
			},
			summary: "ship the ratchet",
		},
		{
			name: "null when the task block has no subject",
			over: {
				last_assistant_message: null,
				task: { task_id: "t1", task_subject: null, teammate_name: null, team_name: null },
			},
			summary: null,
		},
		{
			name: "null when there is neither a message nor a task block",
			over: { last_assistant_message: null, task: null },
			summary: null,
		},
	];

	it.each(summaryCases)("derives the summary — $name", ({ over, summary }) => {
		expect(projectOne(tmp, agentEvent(over)).summary).toBe(summary);
	});

	const CAP = 200;

	it("keeps a message of exactly the cap length intact", () => {
		const msg = "m".repeat(CAP);
		const ev = projectOne(tmp, agentEvent({ last_assistant_message: msg }));
		expect(ev.summary).toBe(msg);
		expect(nonNull(ev.summary)).toHaveLength(CAP);
	});

	it("truncates a message exactly one character past the cap", () => {
		// The exact boundary, which the CAP+4 test below does NOT pin: CAP chars
		// survive intact (test above), CAP+1 does not. Together the two pin the
		// constant in both directions — a cap of 199 reddens the intact test, a
		// cap of 201 reddens this one.
		const ev = projectOne(tmp, agentEvent({ last_assistant_message: `${"m".repeat(CAP)}X` }));
		expect(ev.summary).toBe("m".repeat(CAP));
		expect(nonNull(ev.summary)).toHaveLength(CAP);
	});

	it("truncates the summary past the cap but keeps the full message on the event", () => {
		const msg = `${"m".repeat(CAP)}TAIL`; // CAP + 4 chars
		const ev = projectOne(tmp, agentEvent({ last_assistant_message: msg }));
		expect(ev.summary).toBe("m".repeat(CAP));
		expect(ev.summary).not.toContain("TAIL");
		// The display cap bounds the summary column only — the full text survives.
		expect(ev.last_assistant_message).toBe(msg);
	});

	it("truncates a long task_subject fallback too", () => {
		const subject = `${"s".repeat(CAP)}OVERFLOW`;
		const ev = projectOne(
			tmp,
			agentEvent({
				last_assistant_message: null,
				task: { task_id: "t", task_subject: subject, teammate_name: null, team_name: null },
			}),
		);
		expect(ev.summary).toBe("s".repeat(CAP));
	});

	it("falls back from agent_name to provider for the agent label", () => {
		expect(projectOne(tmp, agentEvent({ agent_name: null })).agent).toBe("claude");
	});

	it('falls back to "unknown" when a legacy agent_event line has no provider', () => {
		const ev = projectOne(
			tmp,
			'{"kind":"agent_event","ts":"2026-07-30T11:00:00Z","event":"subagent_stop"}',
		);
		expect(ev.agent).toBe("unknown");
		expect(ev.hook).toBe("SubagentStop");
	});
});

// ---------------------------------------------------------------------------
// readCollectionActivity — mixed streams, filters, bounded scan
// ---------------------------------------------------------------------------

describe("readCollectionActivity — filters and scan bounds", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-filter-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns newest-first and dispatches each line on its kind", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z", action: { command: "first" } }),
			agentEvent({ ts: "2026-07-30T10:00:01Z", last_assistant_message: "middle" }),
			toolEvent({ ts: "2026-07-30T10:00:02Z", action: { command: "last" } }),
		]);
		expect(readCollectionActivity({ cwd: tmp }).map((e) => [e.type, e.summary])).toEqual([
			["tool_use", "last"],
			["subagent_stop", "middle"],
			["tool_use", "first"],
		]);
	});

	it("skips malformed lines and keeps the valid ones", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z", action: { command: "good-old" } }),
			"{not json",
			"null",
			"42",
			"{}",
			toolEvent({ ts: "2026-07-30T10:00:02Z", action: { command: "good-new" } }),
		]);
		expect(readCollectionActivity({ cwd: tmp }).map((e) => e.summary)).toEqual([
			"good-new",
			"good-old",
		]);
	});

	it("filters by agent", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z", agent_name: "alpha" }),
			toolEvent({ ts: "2026-07-30T10:00:01Z", agent_name: "beta" }),
			agentEvent({ ts: "2026-07-30T10:00:02Z", agent_name: "beta" }),
		]);
		expect(readCollectionActivity({ cwd: tmp, agent: "beta" }).map((e) => e.type)).toEqual([
			"subagent_stop",
			"tool_use",
		]);
	});

	it("filters by projected type across both record kinds", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z", phase: "post", outcome: "error" }),
			toolEvent({ ts: "2026-07-30T10:00:01Z", phase: "pre" }),
			agentEvent({ ts: "2026-07-30T10:00:02Z", event: "task_completed" }),
		]);
		expect(readCollectionActivity({ cwd: tmp, type: "tool_use_error" })).toHaveLength(1);
		expect(readCollectionActivity({ cwd: tmp, type: "task_completed" })).toHaveLength(1);
		expect(readCollectionActivity({ cwd: tmp, type: "tool_use" })).toEqual([]);
	});

	it("applies the limit after filtering, newest-first", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z", agent_name: "alpha", action: { command: "a1" } }),
			toolEvent({ ts: "2026-07-30T10:00:01Z", agent_name: "beta", action: { command: "b1" } }),
			toolEvent({ ts: "2026-07-30T10:00:02Z", agent_name: "alpha", action: { command: "a2" } }),
			toolEvent({ ts: "2026-07-30T10:00:03Z", agent_name: "alpha", action: { command: "a3" } }),
		]);
		expect(
			readCollectionActivity({ cwd: tmp, agent: "alpha", limit: 2 }).map((e) => e.summary),
		).toEqual(["a3", "a2"]);
	});

	it("treats a non-positive limit as unbounded — zero and negative alike", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:00:00Z" }),
			toolEvent({ ts: "2026-07-30T10:00:01Z" }),
		]);
		// 0 and -5 take DIFFERENT short-circuits through `opts?.limit && opts.limit > 0`:
		// 0 is falsy and never reaches the comparison, while -5 is truthy and is
		// rejected only by the `> 0` half. Dropping that half would let -5 through
		// as the limit, and `events.length >= -5` is true on the first row — so the
		// negative case is the one that pins the comparison (the zero case cannot).
		expect(readCollectionActivity({ cwd: tmp, limit: 0 })).toHaveLength(2);
		expect(readCollectionActivity({ cwd: tmp, limit: -5 })).toHaveLength(2);
	});

	it("stops at the first record older than the since cutoff (append-order early exit)", () => {
		// Deliberately out-of-order on disk: the `since` check BREAKS rather than
		// skipping, so anything behind an older row is not scanned. That early exit
		// is what keeps the tail scan cheap on an append-ordered log.
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T10:02:00Z", action: { command: "behind-the-old-row" } }),
			toolEvent({ ts: "2026-07-30T09:00:00Z", action: { command: "old" } }),
			toolEvent({ ts: "2026-07-30T10:03:00Z", action: { command: "newest" } }),
		]);
		const since = new Date("2026-07-30T10:00:00Z").getTime();
		expect(readCollectionActivity({ cwd: tmp, since }).map((e) => e.summary)).toEqual(["newest"]);
		// Without the cutoff every row is projected, proving the break — not a
		// parse failure — is what dropped it.
		expect(readCollectionActivity({ cwd: tmp })).toHaveLength(3);
	});

	it("includes a record whose timestamp is exactly the since cutoff", () => {
		writeCollection(tmp, [
			toolEvent({ ts: "2026-07-30T09:59:59Z", action: { command: "too-old" } }),
			toolEvent({ ts: "2026-07-30T10:00:00Z", action: { command: "at-cutoff" } }),
			toolEvent({ ts: "2026-07-30T10:00:01Z", action: { command: "newest" } }),
		]);
		const since = new Date("2026-07-30T10:00:00Z").getTime();
		expect(readCollectionActivity({ cwd: tmp, since }).map((e) => e.summary)).toEqual([
			"newest",
			"at-cutoff",
		]);
	});

	it("bounds the tail scan: a small limit cannot see past the 500-line floor", () => {
		const rows: unknown[] = [
			toolEvent({ ts: "2026-07-30T09:00:00Z", agent_name: "needle", action: { command: "deep" } }),
		];
		for (let i = 0; i < 600; i++) {
			rows.push(
				toolEvent({ ts: "2026-07-30T10:00:00Z", agent_name: "haystack", action: { command: "n" } }),
			);
		}
		writeCollection(tmp, rows);
		// limit 1 -> scan budget max(1*20, 500) = 500 lines; the needle sits 601
		// lines from the tail, outside the budget.
		expect(readCollectionActivity({ cwd: tmp, agent: "needle", limit: 1 })).toEqual([]);
		// limit 100 -> budget 2000 lines, which reaches it.
		expect(
			readCollectionActivity({ cwd: tmp, agent: "needle", limit: 100 }).map((e) => e.summary),
		).toEqual(["deep"]);
	});
});

// ---------------------------------------------------------------------------
// readCollectionActivity — the process.cwd() default
// ---------------------------------------------------------------------------
// Every other test in this file passes an explicit `cwd`, which leaves the
// `opts?.cwd ?? process.cwd()` fallback (local-activity-collection.ts:119)
// unevaluated. That arm is not hypothetical: readLocalActivity
// (local-activity.ts:211) forwards its caller's opts verbatim, and
// `interlinked status` (status.ts:79, status-full-render.ts:204), `explain`
// (explain.ts:42) and `activity` (activity.ts:82) all omit `cwd` — only
// logs.ts and trace.ts pass one. So the default arm is what those four
// commands actually execute. These three tests drive it for real by chdir-ing
// into the fixture, the same technique local-activity.test.ts uses for its own
// default-cwd block. `process.cwd()` is restored in afterEach, so nothing about
// the ambient working directory leaks in or out.

describe("readCollectionActivity — process.cwd() default", () => {
	let tmp: string;
	let elsewhere: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry
	// run for any file whose graph-selected test scope includes this one.
	// readCollectionActivity resolves cwd via `opts?.cwd ?? process.cwd()`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-defaultcwd-"));
		elsewhere = mkdtempSync(join(tmpdir(), "lac-elsewhere-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	});
	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(tmp, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("reads the collection under the current working directory when no cwd is given", () => {
		writeCollection(tmp, [toolEvent({ action: { command: "from-default-cwd" } })]);
		expect(readCollectionActivity().map((e) => e.summary)).toEqual(["from-default-cwd"]);
		// Same arm with the other options populated, so the default is not only
		// exercised on the trivial call shape.
		expect(readCollectionActivity({ limit: 5, agent: "alpha" }).map((e) => e.summary)).toEqual([
			"from-default-cwd",
		]);
	});

	it("an explicit cwd overrides the working directory rather than merging with it", () => {
		// Both directories hold a collection.jsonl with a distinguishable row, so
		// this discriminates "uses opts.cwd" from "always uses process.cwd()" —
		// the mutant that would otherwise survive alongside the test above.
		writeCollection(tmp, [toolEvent({ action: { command: "from-default-cwd" } })]);
		writeCollection(elsewhere, [toolEvent({ action: { command: "from-explicit-cwd" } })]);
		expect(readCollectionActivity({ cwd: elsewhere }).map((e) => e.summary)).toEqual([
			"from-explicit-cwd",
		]);
	});

	it("returns [] when the working directory has no collection.jsonl", () => {
		// The `!existsSync` early return reached through the default arm: chdir'd
		// into a fixture that was never written to.
		expect(readCollectionActivity()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// readRecentLines
// ---------------------------------------------------------------------------

describe("readRecentLines", () => {
	let tmp: string;
	let file: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-lines-"));
		file = join(tmp, "log.jsonl");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] for a non-positive maxLines without touching the file", () => {
		// No file is created — a maxLines<=0 caller must short-circuit before statSync.
		expect(readRecentLines(join(tmp, "missing.jsonl"), 0)).toEqual([]);
		expect(readRecentLines(join(tmp, "missing.jsonl"), -5)).toEqual([]);
	});

	it("returns [] for a zero-byte file", () => {
		writeFileSync(file, "");
		expect(readRecentLines(file, 10)).toEqual([]);
	});

	it("returns lines newest-first including the very first line of the file", () => {
		writeFileSync(file, "one\ntwo\nthree\n");
		expect(readRecentLines(file, 10)).toEqual(["three", "two", "one"]);
	});

	it("reads a file with no trailing newline", () => {
		writeFileSync(file, "one\ntwo");
		expect(readRecentLines(file, 10)).toEqual(["two", "one"]);
	});

	it("trims the final line when it has surrounding whitespace and no newline", () => {
		writeFileSync(file, "first\n  final  ");
		expect(readRecentLines(file, 10)).toEqual(["final", "first"]);
	});

	it("drops blank and whitespace-only lines and trims the rest", () => {
		writeFileSync(file, "\n  alpha  \n\n\t\n beta\n\n");
		expect(readRecentLines(file, 10)).toEqual(["beta", "alpha"]);
	});

	it("caps at maxLines, keeping the newest and never reaching the head line", () => {
		writeFileSync(file, "a\nb\nc\nd\ne\n");
		expect(readRecentLines(file, 2)).toEqual(["e", "d"]);
		expect(readRecentLines(file, 4)).toEqual(["e", "d", "c", "b"]);
		expect(readRecentLines(file, 5)).toEqual(["e", "d", "c", "b", "a"]);
	});

	it("caps bytes and discards the oldest partial line at the budget boundary", () => {
		writeFileSync(file, "outside\nmiddle\nnewest\n");
		const midLineBudget = Buffer.byteLength("iddle\nnewest\n", "utf-8");
		expect(readRecentLines(file, 10, midLineBudget)).toEqual(["newest"]);
		expect(readRecentLines(file, 10, 0)).toEqual([]);
	});

	// test-contract: invariant — bounded tail reads never return more than the requested line count
	it("does not append additional nonblank lines after reaching maxLines", () => {
		writeFileSync(file, "head\n  middle  \n\n newest \n");
		expect(readRecentLines(file, 2)).toStrictEqual(["newest", "middle"]);
	});

	// test-contract: boundary — trailing JSONL fragments are trimmed and whitespace-only fragments omitted
	it("trims a nonblank trailing fragment but omits a whitespace-only fragment", () => {
		writeFileSync(file, "head\n  tail  ");
		expect(readRecentLines(file, 10)).toStrictEqual(["tail", "head"]);

		writeFileSync(file, "head\n   ");
		expect(readRecentLines(file, 10)).toStrictEqual(["head"]);
	});

	it("reassembles an ASCII line split across the 64KB chunk boundary", () => {
		// Each line is ~70KB, so the tail scan needs multiple reads and the
		// raw-byte carry has to stitch the halves back together.
		const big = "z".repeat(70 * 1024);
		writeFileSync(file, `head-${big}\nmid-${big}\ntail-${big}\n`);
		const lines = readRecentLines(file, 10);
		expect(lines.map((l) => l.slice(0, 5))).toEqual(["tail-", "mid-z", "head-"]);
		// No truncation at the seam: every ASCII line keeps its full payload.
		expect(lines.map((l) => l.length)).toEqual([
			5 + big.length,
			4 + big.length,
			5 + big.length,
		]);
	});

	it("stops early mid-chunk once maxLines is reached on a multi-chunk file", () => {
		const big = "z".repeat(70 * 1024);
		writeFileSync(file, `head-${big}\nmid-${big}\ntail-${big}\n`);
		expect(readRecentLines(file, 1).map((l) => l.slice(0, 5))).toEqual(["tail-"]);
	});

	// --- multi-byte UTF-8 at the chunk seam ---------------------------------
	// "é" is two bytes (C3 A9). The file below is 2*ACCENTS + 1 bytes — an ODD
	// length — while the tail scan's first read is a fixed 65536 bytes measured
	// back from EOF, so the slice boundary lands at an odd offset: between the
	// two bytes of one character. Deterministic on every platform; nothing here
	// depends on locale, TZ, or any ambient state.
	const ACCENTS = 40_000;

	it("a multi-byte line that fits in one chunk survives intact (control)", () => {
		const payload = "é".repeat(1000); // 2001 bytes — a single read, no seam
		writeFileSync(file, `${payload}\n`);
		expect(readRecentLines(file, 10)).toEqual([payload]);
	});

	it("still returns exactly one whole line when a multi-byte char straddles the seam", () => {
		// The line is neither dropped nor split in two, and its head is undamaged.
		const payload = "é".repeat(ACCENTS);
		writeFileSync(file, `${payload}\n`);
		const lines = readRecentLines(file, 10);
		expect(lines).toHaveLength(1);
		expect(nonNull(lines[0]).slice(0, 4)).toBe("éééé");
	});

	it("does not corrupt a multi-byte character at the chunk seam", () => {
		const payload = "é".repeat(ACCENTS);
		writeFileSync(file, `${payload}\n`);
		const line = nonNull(readRecentLines(file, 10)[0]);
		const REPLACEMENT_CHAR = String.fromCharCode(0xfffd); // U+FFFD
		expect(line.includes(REPLACEMENT_CHAR)).toBe(false);
		expect(line).toHaveLength(payload.length);
	});

	it("skips an oversized line while retaining older complete lines", () => {
		const oversized = "x".repeat(4 * 1024 * 1024 + 1);
		writeFileSync(file, `older\n${oversized}\n`);
		expect(readRecentLines(file, 10)).toEqual(["older"]);
	});

	it("caps total retained line bytes even when maxLines is enormous", () => {
		const payloadBytes = 3 * 1024 * 1024;
		const oldest = `oldest-${"a".repeat(payloadBytes)}`;
		const middle = `middle-${"b".repeat(payloadBytes)}`;
		const newest = `newest-${"c".repeat(payloadBytes)}`;
		writeFileSync(file, `${oldest}\n${middle}\n${newest}\n`);

		const lines = readRecentLines(file, Number.MAX_SAFE_INTEGER);
		expect(lines.map((line) => line.slice(0, 7))).toEqual(["newest-", "middle-"]);
		expect(lines.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0)).toBeLessThanOrEqual(
			8 * 1024 * 1024,
		);
	});
});

// ---------------------------------------------------------------------------
// countJsonlLines
// ---------------------------------------------------------------------------

describe("countJsonlLines", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lac-count-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns 0 for a missing file", () => {
		expect(countJsonlLines(join(tmp, "nope.jsonl"))).toBe(0);
	});

	it("returns 0 for an empty file", () => {
		const f = join(tmp, "empty.jsonl");
		writeFileSync(f, "");
		expect(countJsonlLines(f)).toBe(0);
	});

	it("counts only non-blank lines, with or without a trailing newline", () => {
		const withNl = join(tmp, "a.jsonl");
		writeFileSync(withNl, '{"a":1}\n\n{"b":2}\n   \n{"c":3}\n');
		expect(countJsonlLines(withNl)).toBe(3);

		const withoutNl = join(tmp, "b.jsonl");
		writeFileSync(withoutNl, '{"a":1}\n{"b":2}');
		expect(countJsonlLines(withoutNl)).toBe(2);
	});

	it("returns 0 rather than throwing when the path exists but is unreadable", () => {
		// A directory exists but readFileSync on it throws EISDIR — the helper
		// reports "no lines" instead of surfacing the error to the caller.
		const dir = join(tmp, "a-directory.jsonl");
		mkdirSync(dir);
		expect(countJsonlLines(dir)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// parseCollectionOrAgentEvent — direct boundary-parser coverage
// ---------------------------------------------------------------------------
// readCollectionActivity's own describe blocks above already exercise this
// parser end-to-end (including the two "legacy line" fixtures with most
// fields entirely absent). These add DIRECT positive/negative cases per the
// boundary-parsers campaign contract.

describe("parseCollectionOrAgentEvent", () => {
	it("P1: accepts a well-formed tool_event and keeps its used fields", () => {
		const parsed = parseCollectionOrAgentEvent({
			kind: "tool_event",
			ts: "2026-08-01T00:00:00Z",
			phase: "post",
			outcome: "ok",
			agent_name: "alpha",
			provider: "claude",
			provider_tool: "Bash",
			action: { command: "ls" },
			session_id: "s1",
			cwd: "/repo",
			tool_use_id: "tu_1",
		});
		expect(parsed).toEqual({
			ts: "2026-08-01T00:00:00Z",
			phase: "post",
			outcome: "ok",
			agent_name: "alpha",
			provider: "claude",
			provider_tool: "Bash",
			action: { command: "ls" },
			session_id: "s1",
			cwd: "/repo",
			tool_use_id: "tu_1",
		});
	});

	it("P2: accepts a well-formed agent_event and keeps its used fields", () => {
		const parsed = parseCollectionOrAgentEvent({
			kind: "agent_event",
			ts: "2026-08-01T00:00:00Z",
			event: "subagent_stop",
			agent_name: "alpha",
			agent_type: "reviewer",
			session_id: "s1",
			subagent_id: "sub_1",
		});
		expect(parsed).toEqual({
			ts: "2026-08-01T00:00:00Z",
			event: "subagent_stop",
			agent_type: "reviewer",
			session_id: "s1",
			agent_name: "alpha",
			subagent_id: "sub_1",
		});
	});

	// test-contract: boundary — absent task metadata must not leak an undefined output key
	it("omits task when an agent_event does not carry task metadata", () => {
		expect(
			parseCollectionOrAgentEvent({
				kind: "agent_event",
				ts: "2026-08-01T00:00:00Z",
				event: "subagent_stop",
			}),
		).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			event: "subagent_stop",
			agent_type: null,
			session_id: null,
		});
	});

	it("P2b: preserves null task and omits malformed optional agent fields", () => {
		expect(
			parseCollectionOrAgentEvent({
				kind: "agent_event",
				ts: "2026-08-01T00:00:00Z",
				event: "subagent_stop",
				provider: 42,
				agent_name: 42,
				agent_type: false,
				session_id: 99,
				subagent_id: 42,
				parent_agent: false,
				agent_transcript_path: 42,
				last_assistant_message: false,
				cwd: 42,
				task: null,
			}),
		).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			event: "subagent_stop",
			agent_type: null,
			session_id: null,
			task: null,
		});
	});

	it("P2c: keeps a task object but omits an absent or malformed subject", () => {
		expect(
			parseCollectionOrAgentEvent({
				kind: "agent_event",
				ts: "2026-08-01T00:00:00Z",
				event: "task_completed",
				task: {},
			}),
		).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			event: "task_completed",
			agent_type: null,
			session_id: null,
			task: {},
		});
		expect(
			parseCollectionOrAgentEvent({
				kind: "agent_event",
				ts: "2026-08-01T00:00:00Z",
				event: "task_completed",
				task: { task_subject: 42 },
			}),
		).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			event: "task_completed",
			agent_type: null,
			session_id: null,
			task: {},
		});
	});

	it("P3: a tool_event with agent_name entirely absent still parses (real-world drift)", () => {
		// The hand-written hook-runtime collection writer omits agent_name on
		// most rows — measured against the live .interlinked/collection.jsonl
		// tail. A stricter parser that required the key would drop ~88% of
		// real tool_event rows.
		const parsed = parseCollectionOrAgentEvent({
			kind: "tool_event",
			ts: "2026-08-01T00:00:00Z",
			phase: "post",
		});
		expect(parsed).not.toBeNull();
		expect(parsed && "agent_name" in parsed).toBe(false);
	});

	it("P4: normalizes malformed optional tool fields without leaking undefined keys", () => {
		const parsed = parseCollectionOrAgentEvent({
			kind: "tool_event",
			ts: "2026-08-01T00:00:00Z",
			phase: "during",
			outcome: "unknown",
			agent_name: null,
			provider: 42,
			provider_tool: 99,
			session_id: false,
			action: null,
			cwd: 42,
			tool_use_id: false,
		});
		expect(parsed).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			agent_name: null,
			provider_tool: null,
			session_id: null,
			action: null,
		});
	});

	it("P5: omits a non-object action rather than treating it as null", () => {
		expect(
			parseCollectionOrAgentEvent({
				kind: "tool_event",
				ts: "2026-08-01T00:00:00Z",
				action: ["not", "an", "object"],
			}),
		).toStrictEqual({ ts: "2026-08-01T00:00:00Z", provider_tool: null, session_id: null });
	});

	it("N1: rejects a non-object value", () => {
		expect(parseCollectionOrAgentEvent(["not", "an", "object"])).toBeNull();
		expect(parseCollectionOrAgentEvent("a string")).toBeNull();
		expect(parseCollectionOrAgentEvent(null)).toBeNull();
	});

	it("N2: rejects a record with no ts (or a non-string ts)", () => {
		expect(parseCollectionOrAgentEvent({ kind: "tool_event", phase: "post" })).toBeNull();
		expect(parseCollectionOrAgentEvent({ kind: "tool_event", ts: 12345 })).toBeNull();
	});

	it("N3: rejects an agent_event whose event value is not one of the three known names", () => {
		expect(
			parseCollectionOrAgentEvent({
				kind: "agent_event",
				ts: "2026-08-01T00:00:00Z",
				event: "subagent_paused",
			}),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseLocalActivityEvent — direct boundary-parser coverage
// ---------------------------------------------------------------------------

describe("parseLocalActivityEvent", () => {
	it("P1: a minimal record with only the 3 required fields parses intact", () => {
		expect(parseLocalActivityEvent({ ts: "2026-08-01T00:00:00Z", agent: "alpha", type: "prompt" })).toEqual({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "prompt",
		});
	});

	it("P2: a richly-populated record keeps every field, including nested tokens/attribution", () => {
		const parsed = parseLocalActivityEvent({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tool: "Bash",
			summary: "ls -la",
			session: "s1",
			cwd: "/repo",
			duration_ms: 120,
			scrubbed: true,
			files_modified: ["a.ts", "b.ts"],
			schema_version: 5,
			guard_decision: "block",
			guard_warnings: ["one", "two"],
			tokens: { input: 10, output: 20 },
			attribution: { agent_lines: 3, human_lines: 1 },
			tool_input: { some: "blob" },
		});
		expect(parsed).toMatchObject({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tool: "Bash",
			summary: "ls -la",
			session: "s1",
			cwd: "/repo",
			duration_ms: 120,
			scrubbed: true,
			files_modified: ["a.ts", "b.ts"],
			schema_version: 5,
			guard_decision: "block",
			guard_warnings: ["one", "two"],
			tokens: { input: 10, output: 20 },
			attribution: { agent_lines: 3, human_lines: 1 },
			tool_input: { some: "blob" },
		});
	});

	it("P3: guard_decision:\"warn\" (a real value outside the declared union) drops only that field", () => {
		// Measured on the live .interlinked/activity.jsonl tail: 310/20000 rows
		// carry guard_decision:"warn", which local-activity-types.ts does not
		// declare. The row must still be accepted.
		const parsed = parseLocalActivityEvent({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			guard_decision: "warn",
		});
		expect(parsed).not.toBeNull();
		expect(parsed && "guard_decision" in parsed).toBe(false);
	});

	it("P4: a wrongly-typed optional field is dropped, not fatal to the row", () => {
		const parsed = parseLocalActivityEvent({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tokens: "not-an-object",
			duration_ms: "not-a-number",
			files_modified: "not-an-array",
		});
		expect(parsed).toEqual({ ts: "2026-08-01T00:00:00Z", agent: "alpha", type: "tool_use" });
	});

	it("P5: preserves explicitly supplied nullable payloads and rejects malformed typed fields", () => {
		const parsed = parseLocalActivityEvent({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tool_input: { command: "ls" },
			tool_response: { stdout: "ok" },
			error: { message: "nope" },
			permission_suggestions: ["use a safe command"],
			guard_warnings: null,
			cwd: 42,
			scrubbed: "yes",
			files_modified: ["ok.ts", 42],
			tokens: "not-an-object",
		});
		expect(parsed).toStrictEqual({
			ts: "2026-08-01T00:00:00Z",
			agent: "alpha",
			type: "tool_use",
			tool_input: { command: "ls" },
			tool_response: { stdout: "ok" },
			error: { message: "nope" },
			permission_suggestions: ["use a safe command"],
			guard_warnings: null,
		});
	});

	it("P6: accepts every supported schema version and omits invalid versions", () => {
		for (const version of [2, 3, 4, 5]) {
			expect(
				parseLocalActivityEvent({ ts: "t", agent: "a", type: "x", schema_version: version }),
			).toStrictEqual({ ts: "t", agent: "a", type: "x", schema_version: version });
		}
		for (const version of [1, 6, "5", null, undefined]) {
			const value = { ts: "t", agent: "a", type: "x", schema_version: version };
			expect(parseLocalActivityEvent(value)).toStrictEqual({ ts: "t", agent: "a", type: "x" });
		}
	});

	it("P7: keeps allow/block/ask decisions and drops unknown decisions", () => {
		for (const decision of ["allow", "block", "ask"]) {
			expect(
				parseLocalActivityEvent({ ts: "t", agent: "a", type: "x", guard_decision: decision }),
			).toStrictEqual({ ts: "t", agent: "a", type: "x", guard_decision: decision });
		}
		expect(
			parseLocalActivityEvent({ ts: "t", agent: "a", type: "x", guard_decision: "warn" }),
		).toStrictEqual({ ts: "t", agent: "a", type: "x" });
	});

	it("N1: rejects a record missing ts", () => {
		expect(parseLocalActivityEvent({ agent: "alpha", type: "tool_use" })).toBeNull();
	});

	it("N2: rejects a record whose agent is not a string", () => {
		expect(parseLocalActivityEvent({ ts: "2026-08-01T00:00:00Z", agent: 42, type: "tool_use" })).toBeNull();
	});

	it("N3: rejects a record whose type is not a string", () => {
		expect(parseLocalActivityEvent({ ts: "2026-08-01T00:00:00Z", agent: "alpha", type: 42 })).toBeNull();
		expect(parseLocalActivityEvent({ ts: "2026-08-01T00:00:00Z", agent: "alpha", type: null })).toBeNull();
	});

	it("N3: rejects a non-object value", () => {
		expect(parseLocalActivityEvent(["not", "an", "object"])).toBeNull();
		expect(parseLocalActivityEvent(null)).toBeNull();
		expect(parseLocalActivityEvent(5)).toBeNull();
	});
});
