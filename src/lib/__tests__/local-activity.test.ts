import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendActivityRecordOnly,
	appendLocalActivity,
	appendSyncError,
	captureActivitySyncBasis,
	checkpointSyncState,
	getLocalStats,
	getSyncDiagnostics,
	getUnsyncedEvents,
	type LastSyncSummary,
	type LocalActivityEvent,
	mergeAndDedup,
	readLocalActivity,
	readLocalSessions,
	readSyncState,
	updateSyncState,
} from "../local-activity.js";

// Tests run in isolated tmpdirs; we point the module's data directory
// there by setting INTERLINKED_DATA_DIR before calling getDataDir-sensitive
// APIs. appendLocalActivity + readLocalActivity accept an explicit cwd.
//
// getDataDir() honors INTERLINKED_DATA_DIR ABOVE the explicit cwd argument, so
// the cwd-based isolation in this file is only correct when that env var is
// unset. We clear it here and restore it afterward so a stray ambient value
// (or a leak from a sibling suite) cannot redirect writes out of the tmpdir.
const PREV_DATA_DIR = process.env.INTERLINKED_DATA_DIR;
beforeEach(() => {
	delete process.env.INTERLINKED_DATA_DIR;
});
afterEach(() => {
	if (PREV_DATA_DIR === undefined) delete process.env.INTERLINKED_DATA_DIR;
	else process.env.INTERLINKED_DATA_DIR = PREV_DATA_DIR;
});

const INTERLINKED = ".interlinked";

/** Write a raw JSONL file under the tmpdir's .interlinked dir, bypassing the
 *  collection mirror so the legacy activity.jsonl reader path is exercised. */
function writeRaw(tmp: string, name: string, lines: string[]): void {
	mkdirSync(join(tmp, INTERLINKED), { recursive: true });
	writeFileSync(join(tmp, INTERLINKED, name), lines.length ? `${lines.join("\n")}\n` : "");
}

describe("appendLocalActivity / readLocalActivity", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("appends a JSONL line and reads it back", () => {
		appendLocalActivity(
			{
				ts: "2026-04-22T10:00:00.000Z",
				agent: "alice",
				type: "tool_use",
				tool: "Read",
			},
			tmp,
		);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
		expect(events[0].agent).toBe("alice");
	});

	it("supports multiple appends; readLocalActivity returns newest-first", () => {
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "a", type: "tool_use" }, tmp);
		appendLocalActivity({ ts: "2026-04-22T10:00:01Z", agent: "b", type: "tool_use" }, tmp);
		const events = readLocalActivity({ cwd: tmp });
		// Read order is newest → oldest (tail-style scan).
		expect(events.map((e) => e.agent)).toEqual(["b", "a"]);
	});

	it("readLocalActivity returns [] on a fresh tmpdir", () => {
		expect(readLocalActivity({ cwd: tmp })).toEqual([]);
	});

	it("activity.jsonl is an append-only file", () => {
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x" }, tmp);
		appendLocalActivity({ ts: "2026-04-22T10:00:01Z", agent: "b", type: "y" }, tmp);
		const raw = readFileSync(join(tmp, ".interlinked", "activity.jsonl"), "utf-8");
		expect(raw.trim().split("\n").length).toBe(2);
	});
});

describe("sync state", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("readSyncState returns defaults when no state file exists", () => {
		const state = readSyncState(tmp);
		expect(state.synced_through_bytes).toBe(0);
		expect(state.last_sync_at).toBe("");
	});

	it("updateSyncState persists the byte cursor", () => {
		updateSyncState(42, undefined, tmp);
		expect(readSyncState(tmp).synced_through_bytes).toBe(42);
	});

	it("getUnsyncedEvents returns events beyond the cursor", () => {
		appendLocalActivity({ ts: "t1", agent: "a", type: "x" }, tmp);
		const before = getUnsyncedEvents(undefined, tmp);
		expect(before.events.length).toBe(1);

		updateSyncState(before.newOffset, undefined, tmp);
		appendLocalActivity({ ts: "t2", agent: "b", type: "y" }, tmp);
		const after = getUnsyncedEvents(undefined, tmp);
		expect(after.events.length).toBe(1);
		expect(after.events[0].agent).toBe("b");
	});
});

describe("getLocalStats", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports zero events on a fresh tmpdir", () => {
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(0);
	});

	it("counts appended events", () => {
		for (let i = 0; i < 5; i++) {
			appendLocalActivity({ ts: `t${i}`, agent: "a", type: "x" }, tmp);
		}
		expect(getLocalStats(tmp).total_events).toBe(5);
	});
});

describe("mergeAndDedup", () => {
	it("dedups by agent|type|tool within a 2s bucket; server wins collisions", () => {
		const local = [
			{
				ts: "2026-04-22T10:00:00Z",
				agent: "a",
				type: "tool_use",
				tool: "Read",
				from: "local",
			},
			{
				ts: "2026-04-22T10:00:30Z",
				agent: "a",
				type: "tool_use",
				tool: "Edit",
				from: "local",
			},
		];
		const server = [
			{
				ts: "2026-04-22T10:00:00Z",
				agent: "a",
				type: "tool_use",
				tool: "Read",
				from: "server",
			},
			{
				ts: "2026-04-22T11:00:00Z",
				agent: "b",
				type: "tool_use",
				tool: "Write",
				from: "server",
			},
		];
		const merged = mergeAndDedup(local, server);
		// 2 server + 1 unique local (Edit) = 3
		expect(merged.length).toBe(3);
		// Server event wins on the Read collision
		const read = merged.find((e) => e.tool === "Read");
		expect(read?.from).toBe("server");
	});

	it("handles empty inputs", () => {
		expect(mergeAndDedup([], [])).toEqual([]);
	});

	it("sorts merged output newest-first", () => {
		const merged = mergeAndDedup(
			[{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x", tool: "T1" }],
			[{ ts: "2026-04-22T11:00:00Z", agent: "b", type: "y", tool: "T2" }],
		);
		expect(merged[0].agent).toBe("b");
		expect(merged[1].agent).toBe("a");
	});
});

describe("readLocalActivity — canonical collection.jsonl source", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-coll-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writeCollection(records: object[]): void {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "collection.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			schema: "collection.v1",
			kind: "tool_event",
			ts: "2026-06-06T10:00:00.000Z",
			session_id: "s1",
			agent_name: "alice",
			provider: "claude-code",
			phase: "post",
			provider_tool: "Bash",
			cwd: "/repo",
			action: { command: "ls -la" },
			...over,
		};
	}

	it("projects a collection.v1 record onto the v5 display shape", () => {
		writeCollection([rec()]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
		expect(events[0].agent).toBe("alice");
		expect(events[0].type).toBe("tool_use");
		expect(events[0].tool).toBe("Bash");
		expect(events[0].summary).toBe("ls -la");
		expect(events[0].session).toBe("s1");
	});

	it("falls back to provider when agent_name is null and maps pre-phase to tool_use_start", () => {
		writeCollection([
			rec({ agent_name: null, provider: "codex", phase: "pre", provider_tool: "Read", action: { path: "/a.ts" } }),
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events[0].agent).toBe("codex");
		expect(events[0].type).toBe("tool_use_start");
		expect(events[0].summary).toBe("/a.ts");
	});

	it("collection.jsonl supplies the TOOL events (a dual-written legacy twin is deduped)", () => {
		// The legacy row is a TRUE TWIN of the collection record (same hook payload
		// → same ts / session / tool) — exactly what the dual-write produces. The
		// enriched collection projection wins; the raw row is dropped.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "from-activity", type: "tool_use", tool: "Bash", session: "s1" })}\n`,
		);
		writeCollection([rec({ agent_name: "from-collection" })]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["from-collection"]);
	});

	it("PRESERVES legacy tool events with NO collection twin (pre-collection history) — finding 2026-06", () => {
		// History written BEFORE the collection stream existed lives only in
		// activity.jsonl. Type-level dropping made it vanish from activity/status
		// output despite remaining on disk; identity dedup keeps it.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-01T08:00:00.000Z", agent: "old", type: "tool_use", tool: "Read", session: "s0" })}\n`,
		);
		writeCollection([rec({ agent_name: "new" })]); // a different, later event
		const agents = readLocalActivity({ cwd: tmp }).map((e) => e.agent);
		expect(agents).toEqual(["new", "old"]); // newest-first, history intact
	});

	it("PRESERVES a tool event whose collection append FAILED (only in activity.jsonl)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${[
				// Twin of the collection record → deduped.
				JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Bash", session: "s1" }),
				// No twin (its collection append failed) → must survive.
				JSON.stringify({ ts: "2026-06-06T10:00:05.000Z", agent: "a", type: "tool_use", tool: "Write", session: "s1" }),
			].join("\n")}\n`,
		);
		writeCollection([rec()]);
		const all = readLocalActivity({ cwd: tmp });
		expect(all.filter((e) => e.type === "tool_use").length).toBe(2); // collection Bash + legacy Write
		expect(all.some((e) => e.tool === "Write")).toBe(true);
	});

	it("dedups by tool_use_id when the field key cannot match (id is the primary identity)", () => {
		// The legacy row lacks `session` (so the ts|session|type|tool key differs)
		// but carries the same tool_use_id → still recognized as the same event.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Bash", tool_use_id: "tu-1" })}\n`,
		);
		writeCollection([rec({ tool_use_id: "tu-1" })]);
		expect(readLocalActivity({ cwd: tmp }).length).toBe(1);
	});

	it("two PARALLEL calls with different tool_use_ids in the same millisecond both survive — finding 2026-06", () => {
		// Same ts / session / type / tool, DIFFERENT ids: the field fallback must
		// not collapse them — the id decides, so the legacy tu-B event is NOT a
		// twin of the collection's tu-A event.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Bash", session: "s1", tool_use_id: "tu-B" })}\n`,
		);
		writeCollection([rec({ tool_use_id: "tu-A" })]);
		const all = readLocalActivity({ cwd: tmp });
		expect(all.length).toBe(2); // both parallel calls visible
		expect(all.some((e) => e.tool_use_id === "tu-B")).toBe(true);
	});

	it("an id-bearing legacy event never dedups via the field fallback (prefer differing ids)", () => {
		// The collection twin candidate has NO id but an identical field key; the
		// legacy event HAS an id → identity is the id alone → it survives. The
		// reviewer-chosen tradeoff: a possible duplicate beats a silent drop.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Bash", session: "s1", tool_use_id: "tu-X" })}\n`,
		);
		writeCollection([rec()]); // no tool_use_id on the collection record
		expect(readLocalActivity({ cwd: tmp }).length).toBe(2);
	});

	it("does NOT duplicate a permission_request (collection-backed pre event) — finding 2026-06", () => {
		// The collection builder CONSUMES permission_request (projected as a pre
		// tool event); the merge filter must drop the raw activity row for it, or one
		// request appears twice and can displace real events under a limit. The filter
		// is IMPORTED from the builder now (a hand-mirrored copy is what drifted).
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${[
				// Raw permission_request — its collection twin is the PRE projection
				// below; the identity key must match across the type mapping.
				JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "permission_request", tool: "Bash", session: "s1" }),
				JSON.stringify({ ts: "2026-06-06T10:00:01.000Z", agent: "a", type: "session_start" }),
			].join("\n")}\n`,
		);
		writeCollection([rec({ ts: "2026-06-06T10:00:00.000Z", agent_name: "a", phase: "pre" })]);

		const all = readLocalActivity({ cwd: tmp });
		// Exactly ONE record for the request (the collection projection)…
		expect(all.filter((e) => e.type === "tool_use_start").length).toBe(1);
		expect(all.filter((e) => e.type === "permission_request").length).toBe(0);
		// …while genuinely non-tool events still survive the merge.
		expect(all.some((e) => e.type === "session_start")).toBe(true);
		expect(all.length).toBe(2);
	});

	it("RESTORES non-tool events from activity.jsonl when collection.jsonl exists (finding 11)", () => {
		// activity.jsonl carries a session_start (non-tool) + a tool_use; collection.jsonl
		// carries the enriched tool event. The session_start must NOT be dropped.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${[
				JSON.stringify({ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "session_start" }),
				JSON.stringify({ ts: "2026-06-06T10:00:02.000Z", agent: "a", type: "tool_use", tool: "Bash", session: "s1" }),
			].join("\n")}\n`,
		);
		writeCollection([rec({ ts: "2026-06-06T10:00:02.000Z", agent_name: "a" })]);

		const all = readLocalActivity({ cwd: tmp });
		expect(all.some((e) => e.type === "session_start")).toBe(true); // non-tool event preserved
		expect(all.filter((e) => e.type === "tool_use").length).toBe(1); // tool event not duplicated
		// `logs --type session_start` works again (was empty once any tool event landed).
		expect(readLocalActivity({ cwd: tmp, type: "session_start" }).map((e) => e.agent)).toEqual(["a"]);
	});

	it("applies agent / type / limit filters on the collection source", () => {
		writeCollection([
			rec({ ts: "2026-06-06T10:00:00.000Z", agent_name: "a", phase: "post", provider_tool: "Bash" }),
			rec({ ts: "2026-06-06T10:00:01.000Z", agent_name: "b", phase: "pre", provider_tool: "Read", action: { path: "p" } }),
		]);
		expect(readLocalActivity({ cwd: tmp, agent: "a" }).map((e) => e.agent)).toEqual(["a"]);
		expect(readLocalActivity({ cwd: tmp, type: "tool_use_start" }).map((e) => e.tool)).toEqual([
			"Read",
		]);
		expect(readLocalActivity({ cwd: tmp, limit: 1 }).length).toBe(1);
	});

	it("summarizes by path/pattern/url/task/tool precedence and yields null when empty", () => {
		writeCollection([
			rec({ phase: "pre", provider_tool: "Grep", action: { pattern: "needle" } }),
			rec({ phase: "pre", provider_tool: "WebFetch", action: { url: "https://example.test" } }),
			rec({ phase: "pre", provider_tool: "TaskCreate", action: { task: "ship it" } }),
			rec({ phase: "pre", provider_tool: "Mystery", action: { tool: "fallback-tool" } }),
			// action with no recognized label field -> summary null
			rec({ phase: "pre", provider_tool: "Bare", action: { foo: "bar" } }),
			// action entirely absent -> summarizeAction(null) -> null
			rec({ phase: "pre", provider_tool: "NoAction", action: null }),
		]);
		// Newest-first read order mirrors file order reversed.
		const summaries = readLocalActivity({ cwd: tmp }).map((e) => e.summary);
		expect(summaries).toEqual([
			null, // NoAction (action null)
			null, // Bare (unrecognized field)
			"fallback-tool",
			"ship it",
			"https://example.test",
			"needle",
		]);
	});

	it("carries cwd and tool_use_id through the collection projection when present", () => {
		writeCollection([rec({ cwd: "/work/repo", tool_use_id: "tu-42" })]);
		const ev = readLocalActivity({ cwd: tmp })[0];
		expect(ev.cwd).toBe("/work/repo");
		expect(ev.tool_use_id).toBe("tu-42");
	});

	it("omits cwd / tool_use_id when the collection record lacks them", () => {
		writeCollection([rec({ cwd: undefined, tool_use_id: undefined })]);
		const ev = readLocalActivity({ cwd: tmp })[0];
		expect(ev.cwd).toBeUndefined();
		expect(ev.tool_use_id).toBeUndefined();
	});

	it("falls back to 'unknown' agent when both agent_name and provider are absent", () => {
		writeCollection([rec({ agent_name: null, provider: null })]);
		expect(readLocalActivity({ cwd: tmp })[0].agent).toBe("unknown");
	});

	it("honors the since cutoff against collection timestamps (breaks on first older row)", () => {
		// The reader scans newest-first (tail order), so the newest record must
		// be physically LAST in the file. The older row, read after it, trips the
		// since break and is excluded.
		writeCollection([
			rec({ ts: "2026-06-06T09:00:00.000Z", agent_name: "old" }),
			rec({ ts: "2026-06-06T10:00:02.000Z", agent_name: "new" }),
		]);
		const cutoff = new Date("2026-06-06T10:00:00.000Z").getTime();
		expect(readLocalActivity({ cwd: tmp, since: cutoff }).map((e) => e.agent)).toEqual(["new"]);
	});

	it("skips malformed collection lines without throwing", () => {
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		writeFileSync(
			join(tmp, INTERLINKED, "collection.jsonl"),
			`${JSON.stringify(rec({ agent_name: "good" }))}\n{not-json}\n`,
		);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.map((e) => e.agent)).toEqual(["good"]);
	});

	it("returns [] when collection.jsonl path resolves but the file is absent", () => {
		// No collection file written at all -> existsSync false -> legacy path -> [].
		expect(readLocalActivity({ cwd: tmp })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Legacy activity.jsonl reader path (collection.jsonl absent)
// ---------------------------------------------------------------------------
describe("readLocalActivity — legacy activity.jsonl fallback", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-legacy-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function legacyLines(events: Partial<LocalActivityEvent>[]): void {
		writeRaw(tmp, "activity.jsonl", events.map((e) => JSON.stringify(e)));
	}

	it("filters by agent on the legacy log", () => {
		legacyLines([
			{ ts: "2026-04-22T10:00:00Z", agent: "alice", type: "tool_use" },
			{ ts: "2026-04-22T10:00:01Z", agent: "bob", type: "tool_use" },
		]);
		expect(readLocalActivity({ cwd: tmp, agent: "alice" }).map((e) => e.agent)).toEqual(["alice"]);
	});

	it("filters by type on the legacy log", () => {
		legacyLines([
			{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "tool_use" },
			{ ts: "2026-04-22T10:00:01Z", agent: "a", type: "session_start" },
		]);
		expect(readLocalActivity({ cwd: tmp, type: "session_start" }).map((e) => e.type)).toEqual([
			"session_start",
		]);
	});

	it("honors limit and the since cutoff on the legacy log", () => {
		legacyLines([
			{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x" },
			{ ts: "2026-04-22T10:00:01Z", agent: "b", type: "x" },
			{ ts: "2026-04-22T10:00:02Z", agent: "c", type: "x" },
		]);
		// Newest-first: limit 2 -> c, b
		expect(readLocalActivity({ cwd: tmp, limit: 2 }).map((e) => e.agent)).toEqual(["c", "b"]);
		// since cutoff drops the oldest; read stops at first older row
		const cutoff = new Date("2026-04-22T10:00:01Z").getTime();
		expect(readLocalActivity({ cwd: tmp, since: cutoff }).map((e) => e.agent)).toEqual(["c", "b"]);
	});

	it("skips malformed legacy lines and keeps valid ones", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "2026-04-22T10:00:00Z", agent: "ok", type: "x" }),
			"{broken",
		]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["ok"]);
	});

	it("returns [] for an empty legacy file (zero-byte scan budget short-circuit)", () => {
		writeRaw(tmp, "activity.jsonl", []);
		expect(readLocalActivity({ cwd: tmp })).toEqual([]);
	});

	it("reads correctly across a 64KB chunk boundary (multi-chunk tail scan)", () => {
		// Force readRecentLines into more than one 64KB read: each line ~70KB.
		const big = "z".repeat(70 * 1024);
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "2026-04-22T10:00:00Z", agent: "first", type: "x", summary: big }),
			JSON.stringify({ ts: "2026-04-22T10:00:01Z", agent: "second", type: "x", summary: big }),
		]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["second", "first"]);
	});

	it("tolerates a leading blank line within a chunk (carry shift fallback)", () => {
		// File begins with a newline so the first split part is "" -> shift()||"".
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		writeFileSync(
			join(tmp, INTERLINKED, "activity.jsonl"),
			`\n${JSON.stringify({ ts: "2026-04-22T10:00:00Z", agent: "lead", type: "x" })}\n`,
		);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["lead"]);
	});

	// --- parseLocalActivityEvent boundary parser, exercised at this call site ---

	it("P: extra fields the LocalActivityEvent interface does not declare do not break the row", () => {
		// Real activity.jsonl carries write-side-only fields this interface
		// never declared (hash/previousHash on guard-chain records, turn_id,
		// tool_outcome — confirmed unread by every reader of this log). They
		// must not prevent the well-formed ts/agent/type row from parsing.
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({
				ts: "2026-04-22T10:00:00Z",
				agent: "ok",
				type: "x",
				hash: "a".repeat(64),
				turn_id: "t1",
				tool_outcome: "success",
			}),
		]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["ok"]);
	});

	it("N: a syntactically-valid line missing a required field (agent) is skipped, not partially served", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "2026-04-22T10:00:00Z", type: "x" }), // no agent
			JSON.stringify({ ts: "2026-04-22T10:00:01Z", agent: "ok", type: "x" }),
		]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["ok"]);
	});
});

// ---------------------------------------------------------------------------
// readLocalSessions
// ---------------------------------------------------------------------------
describe("readLocalSessions", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-sessions-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] when the sessions directory does not exist", () => {
		expect(readLocalSessions(tmp)).toEqual([]);
	});

	it("reads valid .json session files and skips non-json + malformed entries", () => {
		const dir = join(tmp, INTERLINKED, "sessions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "s1.json"),
			JSON.stringify({
				session_id: "s1",
				agent: "alice",
				phase: "ACTIVE",
				started_at: "t0",
				last_event_at: "t1",
				tool_count: 3,
				error_count: 0,
				files_touched: ["a.ts"],
				tools_used: { Read: 3 },
			}),
		);
		writeFileSync(join(dir, "s2.json"), "{ not valid json");
		writeFileSync(join(dir, "notes.txt"), "ignored, not a .json file");

		const sessions = readLocalSessions(tmp);
		expect(sessions.map((s) => s.session_id)).toEqual(["s1"]);
		expect(sessions[0].tool_count).toBe(3);
	});

	it("uses process.cwd() when no cwd is passed (default-arg path)", () => {
		// Exercises getSessionsDir()'s default-arg branch against a sessions dir
		// we control: the repo's own .interlinked/sessions holds live session
		// files that can exceed the per-file scan limit, which made this test
		// depend on the developer's current session size.
		const cwd = mkdtempSync(join(tmpdir(), "la-cwd-"));
		const sessionsDir = join(cwd, ".interlinked", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(
			join(sessionsDir, "s1.json"),
			JSON.stringify({
				session_id: "s1",
				agent: "alice",
				phase: "ACTIVE",
				started_at: "t0",
				last_event_at: "t1",
				tool_count: 1,
				error_count: 0,
				files_touched: [],
				tools_used: { Read: 1 },
			}),
		);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		try {
			const sessions = readLocalSessions();
			expect(Array.isArray(sessions)).toBe(true);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.session_id).toBe("s1");
		} finally {
			cwdSpy.mockRestore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Sync state: malformed JSON, summary persistence
// ---------------------------------------------------------------------------
describe("readSyncState / updateSyncState — edge cases", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-syncstate-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resets to defaults when sync-state.json is malformed", () => {
		writeRaw(tmp, "sync-state.json", ["{ corrupt"]);
		const state = readSyncState(tmp);
		expect(state.synced_through_bytes).toBe(0);
		expect(state.last_sync_at).toBe("");
	});

	it("persists a last_summary alongside the cursor", () => {
		const summary: LastSyncSummary = {
			server_url: "https://sync.test",
			workspace_id: "ws-1",
			events_total: 10,
			accepted: 9,
			skipped: 1,
			scrubbed: 0,
			batches: 1,
			by_type: { tool_use: 9 },
			by_agent: { alice: 9 },
			top_tools: [["Read", 5]],
			sessions: 1,
			time_range: { earliest: "t0", latest: "t9" },
		};
		updateSyncState(256, summary, tmp);
		const raw = JSON.parse(readFileSync(join(tmp, INTERLINKED, "sync-state.json"), "utf-8"));
		expect(raw.synced_through_bytes).toBe(256);
		expect(raw.last_summary.accepted).toBe(9);
		expect(raw.last_summary.server_url).toBe("https://sync.test");
	});

	it("creates the data directory on first updateSyncState when absent", () => {
		const fresh = join(tmp, "nested", "deep");
		updateSyncState(7, undefined, fresh);
		expect(readSyncState(fresh).synced_through_bytes).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// appendSyncError + rotation
// ---------------------------------------------------------------------------
describe("appendSyncError — rotation and defaults", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-syncerr-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function errorsPath(): string {
		return join(tmp, INTERLINKED, "sync-errors.jsonl");
	}

	it("appends a JSONL error row defaulting transient to false", () => {
		appendSyncError({ stage: "batch_post", message: "boom", status: 500, batch: 2, attempt: 1 }, tmp);
		const row = JSON.parse(readFileSync(errorsPath(), "utf-8").trim());
		expect(row.stage).toBe("batch_post");
		expect(row.message).toBe("boom");
		expect(row.status).toBe(500);
		expect(row.transient).toBe(false);
		expect(typeof row.ts).toBe("string");
	});

	it("preserves an explicit transient flag", () => {
		appendSyncError({ stage: "net", message: "timeout", transient: true }, tmp);
		const row = JSON.parse(readFileSync(errorsPath(), "utf-8").trim());
		expect(row.transient).toBe(true);
	});

	it("rotates the log to .1 once it crosses the 10MB cap", () => {
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		// Pre-seed a file just over the 10MB threshold so the next append rotates.
		const oversized = `${"x".repeat(10 * 1024 * 1024 + 16)}\n`;
		writeFileSync(errorsPath(), oversized);
		appendSyncError({ stage: "s", message: "after-rotate" }, tmp);

		// The oversized content moved to .1; the live file holds only the new row.
		const archived = readFileSync(`${errorsPath()}.1`, "utf-8");
		expect(archived.length).toBeGreaterThan(10 * 1024 * 1024);
		const liveRows = readFileSync(errorsPath(), "utf-8").trim().split("\n");
		expect(liveRows.length).toBe(1);
		expect(JSON.parse(liveRows[0]).message).toBe("after-rotate");
	});

	it("overwrites a pre-existing .1 archive on the next rotation (single-generation retention)", () => {
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		// A stale archive already exists; rotation must unlink+replace it.
		writeFileSync(`${errorsPath()}.1`, "STALE ARCHIVE CONTENT\n");
		writeFileSync(errorsPath(), `${"y".repeat(10 * 1024 * 1024 + 16)}\n`);
		appendSyncError({ stage: "s", message: "second-rotate" }, tmp);

		const archived = readFileSync(`${errorsPath()}.1`, "utf-8");
		expect(archived.startsWith("STALE")).toBe(false);
		expect(archived.length).toBeGreaterThan(10 * 1024 * 1024);
	});

	it("does not rotate while under the cap", () => {
		appendSyncError({ stage: "s", message: "one" }, tmp);
		appendSyncError({ stage: "s", message: "two" }, tmp);
		const rows = readFileSync(errorsPath(), "utf-8").trim().split("\n");
		expect(rows.length).toBe(2);
		// No archive created.
		expect(() => statSync(`${errorsPath()}.1`)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// getUnsyncedEvents — offsets, limits, malformed rows
// ---------------------------------------------------------------------------
describe("getUnsyncedEvents — edge cases", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-unsynced-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty with offset 0 when no activity.jsonl exists", () => {
		const res = getUnsyncedEvents(undefined, tmp);
		expect(res.events).toEqual([]);
		expect(res.newOffset).toBe(0);
	});

	it("returns empty and reports file size once the cursor is at/after EOF", () => {
		appendLocalActivity({ ts: "t1", agent: "a", type: "tool_use" }, tmp);
		const size = statSync(join(tmp, INTERLINKED, "activity.jsonl")).size;
		updateSyncState(size, undefined, tmp);
		const res = getUnsyncedEvents(undefined, tmp);
		expect(res.events).toEqual([]);
		expect(res.newOffset).toBe(size);
	});

	it("applies a limit and advances the offset by exactly the consumed bytes", () => {
		const e1 = { ts: "t1", agent: "a", type: "x" };
		const e2 = { ts: "t2", agent: "b", type: "y" };
		const e3 = { ts: "t3", agent: "c", type: "z" };
		writeRaw(tmp, "activity.jsonl", [JSON.stringify(e1), JSON.stringify(e2), JSON.stringify(e3)]);

		const res = getUnsyncedEvents(2, tmp);
		expect(res.events.map((e) => e.agent)).toEqual(["a", "b"]);
		const consumed =
			Buffer.byteLength(`${JSON.stringify(e1)}\n`) + Buffer.byteLength(`${JSON.stringify(e2)}\n`);
		expect(res.newOffset).toBe(consumed);

		// Advancing the cursor then re-reading yields the remaining event.
		updateSyncState(res.newOffset, undefined, tmp);
		const rest = getUnsyncedEvents(undefined, tmp);
		expect(rest.events.map((e) => e.agent)).toEqual(["c"]);
	});

	it("skips a malformed line in the full read while still returning valid events", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "t1", agent: "a", type: "x" }),
			"{bad json",
			JSON.stringify({ ts: "t2", agent: "b", type: "y" }),
		]);
		const res = getUnsyncedEvents(undefined, tmp);
		expect(res.events.map((e) => e.agent)).toEqual(["a", "b"]);
	});

	it("advances the offset past a malformed line inside a limited partial read", () => {
		// First line is malformed; with limit=1 the partial loop must still count
		// the bad line's bytes so the cursor never sticks (no infinite retry).
		const bad = "{bad json";
		const good = JSON.stringify({ ts: "t2", agent: "b", type: "y" });
		writeRaw(tmp, "activity.jsonl", [bad, good, JSON.stringify({ ts: "t3", agent: "c", type: "z" })]);

		const res = getUnsyncedEvents(1, tmp);
		// Only one valid event fits the limit; it is the good row.
		expect(res.events.map((e) => e.agent)).toEqual(["b"]);
		// Offset must have advanced past BOTH the malformed line and the good line.
		const consumed = Buffer.byteLength(`${bad}\n`) + Buffer.byteLength(`${good}\n`);
		expect(res.newOffset).toBe(consumed);
	});

	it("does not consume an unterminated trailing JSONL row", () => {
		const complete = JSON.stringify({ ts: "t1", agent: "a", type: "x" });
		const partial = JSON.stringify({ ts: "t2", agent: "b", type: "y" });
		writeRaw(tmp, "activity.jsonl", [complete]);
		const path = join(tmp, INTERLINKED, "activity.jsonl");
		appendFileSync(path, partial);

		const first = getUnsyncedEvents(undefined, tmp);
		expect(first.events.map((e) => e.agent)).toEqual(["a"]);
		expect(first.newOffset).toBe(Buffer.byteLength(`${complete}\n`));

		appendFileSync(path, "\n");
		updateSyncState(first.newOffset, undefined, tmp);
		const second = getUnsyncedEvents(undefined, tmp);
		expect(second.events.map((e) => e.agent)).toEqual(["b"]);
		expect(second.newOffset).toBe(statSync(path).size);
	});

	it("pages a frozen byte range without changing the persisted cursor", () => {
		const rows = [
			JSON.stringify({ ts: "t1", agent: "a", type: "x" }),
			JSON.stringify({ ts: "t2", agent: "b", type: "y" }),
			JSON.stringify({ ts: "t3", agent: "c", type: "z" }),
		];
		writeRaw(tmp, "activity.jsonl", rows);
		const endExclusive = statSync(join(tmp, INTERLINKED, "activity.jsonl")).size;

		const first = getUnsyncedEvents(1, tmp, { startOffset: 0, endExclusive });
		const second = getUnsyncedEvents(1, tmp, {
			startOffset: first.newOffset,
			endExclusive,
		});
		expect(first.events.map((e) => e.agent)).toEqual(["a"]);
		expect(second.events.map((e) => e.agent)).toEqual(["b"]);
		expect(readSyncState(tmp).synced_through_bytes).toBe(0);
	});

	it("rejects a persisted cursor beyond the current activity-log EOF", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "t1", agent: "a", type: "x" }),
		]);
		const size = statSync(join(tmp, INTERLINKED, "activity.jsonl")).size;
		updateSyncState(size + 1, undefined, tmp);

		expect(() => getUnsyncedEvents(undefined, tmp)).toThrow(/cursor .* exceeds/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(size + 1);
	});

	it("rejects a nonzero cursor when the activity log disappeared", () => {
		updateSyncState(1, undefined, tmp);

		expect(() => getUnsyncedEvents(undefined, tmp)).toThrow(/cursor 1 exceeds/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(1);
	});

	it("leaves the cursor before an oversized valid JSONL row", () => {
		const oversized = JSON.stringify({
			ts: "t1",
			agent: "a",
			type: "x",
			summary: "v".repeat(4 * 1024 * 1024),
		});
		writeRaw(tmp, "activity.jsonl", [oversized]);

		expect(() => getUnsyncedEvents(undefined, tmp)).toThrow(/row at byte 0 exceeds.*not advanced/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(0);
	});

	it("leaves the cursor before an oversized malformed JSONL row", () => {
		writeRaw(tmp, "activity.jsonl", [`{${"x".repeat(4 * 1024 * 1024)}`]);

		expect(() => getUnsyncedEvents(undefined, tmp)).toThrow(/row at byte 0 exceeds.*not advanced/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(0);
	});

	it("bounds a materialized page by aggregate JSONL bytes", () => {
		const rows = ["a", "b", "c"].map((agent) =>
			JSON.stringify({
				ts: `t-${agent}`,
				agent,
				type: "x",
				summary: agent.repeat(3 * 1024 * 1024),
			}),
		);
		writeRaw(tmp, "activity.jsonl", rows);
		const afterTwo = Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`);

		const first = getUnsyncedEvents(100, tmp);
		expect(first.events.map((event) => event.agent)).toEqual(["a", "b"]);
		expect(first.newOffset).toBe(afterTwo);

		const second = getUnsyncedEvents(100, tmp, { startOffset: first.newOffset });
		expect(second.events.map((event) => event.agent)).toEqual(["c"]);
		expect(second.newOffset).toBe(statSync(join(tmp, INTERLINKED, "activity.jsonl")).size);
	});

	it("checkpoints a page only while the captured activity generation is current", () => {
		const row = JSON.stringify({ ts: "t1", agent: "a", type: "x" });
		writeRaw(tmp, "activity.jsonl", [row]);
		const basis = captureActivitySyncBasis(0, tmp);
		const page = getUnsyncedEvents(1, tmp, {
			startOffset: 0,
			endExclusive: basis.endExclusive,
			expectedIdentity: basis.identity,
		});

		checkpointSyncState({ basis, expectedCursor: 0, nextCursor: page.newOffset, cwd: tmp });
		expect(readSyncState(tmp).synced_through_bytes).toBe(page.newOffset);
	});

	it("does not write an old-coordinate checkpoint after activity-log replacement", () => {
		const activityPath = join(tmp, INTERLINKED, "activity.jsonl");
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "t1", agent: "a", type: "x" }),
		]);
		const basis = captureActivitySyncBasis(0, tmp);
		const replacement = `${activityPath}.replacement`;
		writeFileSync(
			replacement,
			`${JSON.stringify({ ts: "t2", agent: "b", type: "x" })}\n`,
		);
		renameSync(replacement, activityPath);

		expect(() =>
			checkpointSyncState({
				basis,
				expectedCursor: 0,
				nextCursor: basis.endExclusive,
				cwd: tmp,
			}),
		).toThrow(/activity log was replaced/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(0);
	});

	it("does not overwrite a cursor rebased after the sync basis was captured", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "t1", agent: "a", type: "x" }),
		]);
		const basis = captureActivitySyncBasis(0, tmp);
		updateSyncState(1, undefined, tmp);

		expect(() =>
			checkpointSyncState({
				basis,
				expectedCursor: 0,
				nextCursor: basis.endExclusive,
				cwd: tmp,
			}),
		).toThrow(/persisted cursor moved from 0 to 1/);
		expect(readSyncState(tmp).synced_through_bytes).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// getLocalStats — edge cases
// ---------------------------------------------------------------------------
describe("getLocalStats — edge cases", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-stats-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports timestamp range and a pending-sync estimate proportional to unsynced bytes", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x" }),
			JSON.stringify({ ts: "2026-04-22T10:00:01Z", agent: "b", type: "x" }),
			JSON.stringify({ ts: "2026-04-22T10:00:02Z", agent: "c", type: "x" }),
			JSON.stringify({ ts: "2026-04-22T10:00:03Z", agent: "d", type: "x" }),
		]);
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(4);
		expect(stats.oldest_event).toBe("2026-04-22T10:00:00Z");
		expect(stats.newest_event).toBe("2026-04-22T10:00:03Z");
		// Nothing synced yet -> the whole file is pending.
		expect(stats.pending_sync).toBe(4);
	});

	it("scales the pending estimate down after the cursor advances", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "t0", agent: "a", type: "x" }),
			JSON.stringify({ ts: "t1", agent: "b", type: "x" }),
		]);
		const full = statSync(join(tmp, INTERLINKED, "activity.jsonl")).size;
		updateSyncState(Math.floor(full / 2), undefined, tmp);
		const stats = getLocalStats(tmp);
		// ~half the bytes pending -> ~1 of 2 events estimated pending.
		expect(stats.pending_sync).toBe(1);
	});

	it("leaves timestamps undefined when the boundary lines are unparseable", () => {
		writeRaw(tmp, "activity.jsonl", ["{not json", "also-not-json"]);
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(2);
		expect(stats.oldest_event).toBeUndefined();
		expect(stats.newest_event).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getSyncDiagnostics — branches not covered by the dedicated suite
// ---------------------------------------------------------------------------
describe("getSyncDiagnostics — additional branches", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-diag-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports zeros and undefined fields on a pristine data dir", () => {
		const diag = getSyncDiagnostics(tmp);
		expect(diag.pending_realtime_retry).toBe(0);
		expect(diag.sync_error_count).toBe(0);
		expect(diag.last_sync_success_at).toBeUndefined();
		expect(diag.last_sync_error_at).toBeUndefined();
		expect(diag.last_sync_error).toBeUndefined();
	});

	it("counts realtime-retry lines, ignoring blank rows", () => {
		writeRaw(tmp, "realtime-retry.jsonl", [JSON.stringify({ id: 1 }), "", JSON.stringify({ id: 2 })]);
		expect(getSyncDiagnostics(tmp).pending_realtime_retry).toBe(2);
	});

	it("keeps error_at/error undefined when the newest sync-error row is malformed", () => {
		// Non-empty error file (so count>0) but the most-recent line cannot parse.
		writeRaw(tmp, "sync-errors.jsonl", ["{corrupt-error-line"]);
		const diag = getSyncDiagnostics(tmp);
		expect(diag.sync_error_count).toBe(1);
		expect(diag.last_sync_error_at).toBeUndefined();
		expect(diag.last_sync_error).toBeUndefined();
	});

	it("treats an empty last_sync_at as 'never succeeded' (undefined)", () => {
		// updateSyncState always stamps a time, so write the state file directly.
		writeRaw(tmp, "sync-state.json", [JSON.stringify({ synced_through_bytes: 5, last_sync_at: "" })]);
		expect(getSyncDiagnostics(tmp).last_sync_success_at).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// mergeAndDedup / dedupKey / getTimestamp — alternate field-name shapes
// ---------------------------------------------------------------------------
describe("mergeAndDedup — alternate timestamp and identity field names", () => {
	it("dedups records that use agent_name / event_type / tool_name / occurred_at aliases", () => {
		// Local and server describe the same action via the *alias* field set;
		// they must collide in the same 2s bucket and the server copy must win.
		const local = [
			{
				occurred_at: "2026-04-22T10:00:00Z",
				agent_name: "alice",
				event_type: "tool_use",
				tool_name: "Read",
				origin: "local",
			},
		];
		const server = [
			{
				occurred_at: "2026-04-22T10:00:01Z",
				agent_name: "alice",
				event_type: "tool_use",
				tool_name: "Read",
				origin: "server",
			},
		];
		const merged = mergeAndDedup(local, server);
		expect(merged.length).toBe(1);
		expect(merged[0].origin).toBe("server");
	});

	it("falls back through created_at and timestamp for ordering", () => {
		const merged = mergeAndDedup<Record<string, unknown>>(
			[{ created_at: "2026-04-22T10:00:00Z", agent: "a", type: "x", tool: "T1" }],
			[{ timestamp: "2026-04-22T11:00:00Z", agent: "b", type: "y", tool: "T2" }],
		);
		// Newest-first ordering using the alias timestamps.
		expect(merged[0].agent).toBe("b");
		expect(merged[1].agent).toBe("a");
	});

	it("buckets records with no timestamp into bucket 0 and dedups them together", () => {
		// Both timestamp-less with identical identity -> same key (...|0) -> 1 row.
		const local = [{ agent: "a", type: "t", tool: "T", origin: "local" }];
		const server = [{ agent: "a", type: "t", tool: "T", origin: "server" }];
		const merged = mergeAndDedup(local, server);
		expect(merged.length).toBe(1);
		expect(merged[0].origin).toBe("server");
	});

	it("keeps two same-identity events in different 2s buckets as distinct rows", () => {
		const local = [
			{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "t", tool: "T" },
			{ ts: "2026-04-22T10:00:10Z", agent: "a", type: "t", tool: "T" },
		];
		expect(mergeAndDedup(local, []).length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// appendLocalActivity — collection mirror behavior
// ---------------------------------------------------------------------------
describe("appendLocalActivity — collection mirror", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-mirror-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("mirrors a tool_use event into collection.jsonl alongside activity.jsonl", () => {
		appendLocalActivity(
			{
				ts: "2026-04-22T10:00:00Z",
				agent: "alice",
				type: "tool_use",
				tool: "Bash",
				tool_input: { command: "ls" },
			},
			tmp,
		);
		const activity = readFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "utf-8").trim();
		expect(activity.split("\n").length).toBe(1);
		const collection = readFileSync(join(tmp, INTERLINKED, "collection.jsonl"), "utf-8").trim();
		const rec = JSON.parse(collection);
		expect(rec.schema).toBe("collection.v1");
		expect(rec.provider_tool).toBe("Bash");
		expect(rec.tool_class).toBe("shell_exec");
	});

	it("does NOT write a collection mirror for a non-tool event", () => {
		// A lifecycle event (not in TOOL_EVENT_TYPES) -> buildCollectionRecord null.
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "alice", type: "session_start" }, tmp);
		expect(readFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "utf-8").trim().length).toBeGreaterThan(0);
		// No collection file created for a non-tool event.
		expect(() => readFileSync(join(tmp, INTERLINKED, "collection.jsonl"), "utf-8")).toThrow();
	});

	it("does NOT mirror guard telemetry into collection.jsonl", () => {
		// guard_* records are local-only; buildCollectionRecord returns null.
		appendLocalActivity(
			{ ts: "2026-04-22T10:00:00Z", agent: "alice", type: "guard_block", tool: "Bash" },
			tmp,
		);
		expect(readFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "utf-8").trim().length).toBeGreaterThan(0);
		expect(() => readFileSync(join(tmp, INTERLINKED, "collection.jsonl"), "utf-8")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Default-arg (no explicit cwd) paths — isolated via chdir + INTERLINKED_DATA_DIR
// ---------------------------------------------------------------------------
describe("default cwd resolution", () => {
	let tmp: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry
	// run for any file whose graph-selected test scope includes this one.
	// The functions under test resolve cwd via `cwd || process.cwd()` /
	// `?? process.cwd()`, so the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-defaultcwd-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	});
	afterEach(() => {
		cwdSpy?.mockRestore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("appendLocalActivity / readLocalActivity default to process.cwd()", () => {
		// No cwd argument -> the `cwd || process.cwd()` and `?? process.cwd()`
		// fallbacks resolve to the tmpdir we chdir'd into.
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "solo", type: "tool_use", tool: "Read" });
		const events = readLocalActivity();
		expect(events.map((e) => e.agent)).toEqual(["solo"]);
		// The mirror landed under the cwd we switched to, not the repo root.
		const rec = JSON.parse(
			readFileSync(join(tmp, INTERLINKED, "collection.jsonl"), "utf-8").trim(),
		);
		expect(rec.provider_tool).toBe("Read");
	});

	it("readLocalActivity defaults to the legacy log under cwd when no collection exists", () => {
		writeRaw(tmp, "activity.jsonl", [
			JSON.stringify({ ts: "2026-04-22T10:00:00Z", agent: "legacy-default", type: "tool_use" }),
		]);
		expect(readLocalActivity().map((e) => e.agent)).toEqual(["legacy-default"]);
	});

	it("appendActivityRecordOnly writes to cwd-derived path and skips the collection mirror", () => {
		// Direct call with no cwd exercises the `cwd || process.cwd()` fallback and
		// the activity-only write path (no collection.jsonl side-effect).
		appendActivityRecordOnly({
			ts: "2026-04-22T10:00:00Z",
			agent: "record-only",
			type: "tool_use",
			tool: "Bash",
		});
		const activity = readFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "utf-8").trim();
		expect(JSON.parse(activity).agent).toBe("record-only");
		// activity-record-only must NOT create the collection mirror.
		expect(() => readFileSync(join(tmp, INTERLINKED, "collection.jsonl"), "utf-8")).toThrow();
	});

	it("appendActivityRecordOnly creates the .interlinked directory when absent", () => {
		// Fresh chdir'd tmpdir has no .interlinked yet -> mkdir recursive branch.
		appendActivityRecordOnly({ ts: "t", agent: "mkdir-path", type: "tool_use" });
		expect(readLocalActivity().map((e) => e.agent)).toEqual(["mkdir-path"]);
	});
});

// ---------------------------------------------------------------------------
// dedupKey identity fallbacks + getLocalStats blank-line edge
// ---------------------------------------------------------------------------
describe("dedupKey identity '' fallbacks", () => {
	it("collapses two records lacking every identity field into one bucket-0 key", () => {
		// Neither agent/agent_name, type/event_type, nor tool/tool_name present and
		// no timestamp -> key becomes "|||0" for both -> server wins, one row.
		const merged = mergeAndDedup<Record<string, unknown>>(
			[{ payload: "local" }],
			[{ payload: "server" }],
		);
		expect(merged.length).toBe(1);
		expect(merged[0].payload).toBe("server");
	});
});

describe("getLocalStats — blank-line-only file", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-blank-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("estimates zero pending when the file has bytes but no non-blank lines", () => {
		// A lone newline: nonzero file size, but filter(Boolean) yields no lines,
		// so the pending estimate takes its lines.length === 0 -> 0 branch.
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		writeFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "\n");
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(0);
		expect(stats.file_size_bytes).toBeGreaterThan(0);
		expect(stats.pending_sync).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Schema round-trip invariant (finding 5): a normalized activity event written
// through appendLocalActivity (which mirrors to the CANONICAL collection.jsonl)
// must read back through readLocalActivity with its event-type discriminator
// intact. The regression: once collection.jsonl exists the reader prefers it,
// and a failed tool (`tool_use_error`) used to collapse to a plain `tool_use`,
// so `logs --type tool_use_error` returned nothing.
// ---------------------------------------------------------------------------

describe("canonical round-trip preserves the event-type discriminator", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-roundtrip-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** A minimal normalized tool event with the given type/tool. */
	function toolEvent(type: string, tool: string): LocalActivityEvent {
		return {
			ts: "2026-06-07T00:00:00.000Z",
			agent: "claude",
			type,
			tool,
			summary: tool,
			session: "s1",
			hook: type === "tool_use_start" ? "PreToolUse" : "PostToolUse",
		};
	}

	it.each(["tool_use_start", "tool_use", "tool_use_error"])(
		"%s survives the collection.jsonl round-trip",
		(type) => {
			appendLocalActivity(toolEvent(type, "Bash"), tmp);
			// collection.jsonl now exists → readLocalActivity reads the CANONICAL stream.
			const back = readLocalActivity({ type, cwd: tmp });
			expect(back.length).toBe(1);
			expect(back[0].type).toBe(type);
		},
	);

	it("a failed tool is queryable as tool_use_error and is NOT mislabeled tool_use", () => {
		appendLocalActivity(toolEvent("tool_use_error", "Bash"), tmp);
		appendLocalActivity(toolEvent("tool_use", "Read"), tmp);

		const failures = readLocalActivity({ type: "tool_use_error", cwd: tmp });
		expect(failures.map((e) => e.tool)).toEqual(["Bash"]);

		const successes = readLocalActivity({ type: "tool_use", cwd: tmp });
		expect(successes.map((e) => e.tool)).toEqual(["Read"]); // the failure is NOT here
		expect(successes.some((e) => e.type === "tool_use_error")).toBe(false);
	});
});
