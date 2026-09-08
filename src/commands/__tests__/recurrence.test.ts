import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../../lib/value-validation.js";
// Tests for the `interlinked recurrence` CLI subcommands.
//
// Each command is exported as a plain async function that accepts an
// options object — same convention as activity / checkpoint / etc.
// Output is captured by spying on console.log; the assertions check the
// shape of what the user (or an agent) sees.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadRecurrenceEvents,
	recordHarnessCaught,
	recordRecurrenceEvent,
} from "../../harness/recurrence.js";
import { nonNull } from "../../lib/non-null.js";
import {
	recurrenceDetailCommand,
	recurrenceFlagCommand,
	recurrenceListCommand,
	recurrenceProposeCommand,
	recurrenceScanCommand,
} from "../recurrence.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-rec-cli-"));
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	logSpy.mockRestore();
	errSpy.mockRestore();
});

function captured(): string {
	return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function errCaptured(): string {
	return errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

/** ISO timestamp `seconds` in the past, relative to now. Lets us drive the
 *  age-bucketing (`s`/`m`/`h`/`d`) branches deterministically through the
 *  human-readable list renderer. */
function isoSecondsAgo(seconds: number): string {
	return new Date(Date.now() - seconds * 1_000).toISOString();
}

function seedThreeCaughtEvents(): void {
	for (let i = 0; i < 3; i++) {
		recordHarnessCaught({
			check_id: "misused_promises",
			agent_source: "claude",
			session_id: `s${i}`,
			file: `src/foo${i}.ts`,
			cwd: dir,
		});
	}
}

describe("recurrence list", () => {
	it("prints '(no recurrences yet)' when the log is empty", async () => {
		await recurrenceListCommand({ cwd: dir });
		expect(captured()).toMatch(/no recurrences/i);
	});

	it("prints a table row including count, kind, and check_id when events exist", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ cwd: dir });
		const out = captured();
		expect(out).toContain("misused_promises");
		expect(out).toContain("harness_caught");
		expect(out).toContain("3");
	});

	it("emits structured JSON when --json is set", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ cwd: dir, json: true });
		const out = captured();
		const parsed = parseWire(JSON.parse(out), wireArray(wireObject({ "count": wireNumber, "kind": wireString })), "test JSON value");
		expect(parsed).toHaveLength(1);
		expect(nonNull(parsed[0]).count).toBe(3);
		expect(nonNull(parsed[0]).kind).toBe("harness_caught");
	});

	it("filters by --kind", async () => {
		seedThreeCaughtEvents();
		recordRecurrenceEvent(
			{ ts: "2026-05-04T00:00:00.000Z", kind: "codebase_existing", check_id: "no_test_file", file: "src/x.ts" },
			dir,
		);
		await recurrenceListCommand({ cwd: dir, kind: "codebase_existing", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "kind": wireString })), "test JSON value");
		expect(parsed.every((r: { kind: string }) => r.kind === "codebase_existing")).toBe(true);
	});

	it("respects --top to cap the number of rows", async () => {
		// Seed multiple distinct signatures.
		for (const id of ["a", "b", "c"]) {
			recordHarnessCaught({
				check_id: id,
				agent_source: "claude",
				session_id: "s",
				file: "f.ts",
				cwd: dir,
			});
		}
		await recurrenceListCommand({ cwd: dir, top: "2", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
		expect(parsed).toHaveLength(2);
	});
});

describe("recurrence detail", () => {
	it("lists each event for the named signature", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("harness_caught:misused_promises:claude", { cwd: dir });
		const out = captured();
		expect(out).toContain("src/foo0.ts");
		expect(out).toContain("src/foo1.ts");
		expect(out).toContain("src/foo2.ts");
	});

	it("warns and exits cleanly when the signature is unknown", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("not_a_real_signature", { cwd: dir });
		const allOutput = captured() + errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(allOutput).toMatch(/no events|unknown/i);
	});
});

describe("recurrence flag", () => {
	it("appends a harness_missed event with the supplied signature", async () => {
		await recurrenceFlagCommand("raw-sql-concat", { cwd: dir, message: "spotted in db.ts" });
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).kind).toBe("harness_missed");
		expect(nonNull(events[0]).signature).toBe("raw-sql-concat");
		expect(nonNull(events[0]).message).toBe("spotted in db.ts");
	});
});

describe("recurrence propose", () => {
	it("prints a ratchet headline for harness_caught rows", async () => {
		seedThreeCaughtEvents();
		await recurrenceProposeCommand("harness_caught:misused_promises:claude", { cwd: dir });
		const out = captured();
		expect(out.toLowerCase()).toContain("ratchet");
		expect(out).toContain("misused_promises");
	});

	it("returns gracefully when the signature is unknown", async () => {
		await recurrenceProposeCommand("nothing", { cwd: dir });
		const out = captured() + errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("recurrence list — filters and rendering", () => {
	it("filters by --agent-source (only matching rows survive)", async () => {
		recordHarnessCaught({
			check_id: "eval_usage",
			agent_source: "claude",
			session_id: "s1",
			file: "a.ts",
			cwd: dir,
		});
		recordHarnessCaught({
			check_id: "eval_usage",
			agent_source: "codex",
			session_id: "s2",
			file: "b.ts",
			cwd: dir,
		});
		await recurrenceListCommand({ cwd: dir, agentSource: "codex", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "agent_sources": wireArray(wireString) })), "test JSON value");
		// Both events share the same check_id but a *different* agent_source, so
		// they aggregate to distinct signatures — the filter must keep only codex.
		expect(parsed).toHaveLength(1);
		expect(nonNull(parsed[0]).agent_sources).toEqual(["codex"]);
	});

	it("filters by --check-id", async () => {
		recordHarnessCaught({
			check_id: "eval_usage",
			agent_source: "claude",
			session_id: "s1",
			file: "a.ts",
			cwd: dir,
		});
		recordHarnessCaught({
			check_id: "raw_sql_concat",
			agent_source: "claude",
			session_id: "s2",
			file: "b.ts",
			cwd: dir,
		});
		await recurrenceListCommand({ cwd: dir, checkId: "raw_sql_concat", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "check_id": wireString })), "test JSON value");
		expect(parsed).toHaveLength(1);
		expect(nonNull(parsed[0]).check_id).toBe("raw_sql_concat");
	});

	it("filters by --since (events older than the cutoff are dropped)", async () => {
		recordRecurrenceEvent(
			{
				ts: isoSecondsAgo(60 * 60 * 24 * 30),
				kind: "harness_caught",
				check_id: "eval_usage",
				agent_source: "claude",
				session_id: "old",
				file: "old.ts",
			},
			dir,
		);
		recordRecurrenceEvent(
			{
				ts: isoSecondsAgo(5),
				kind: "harness_caught",
				check_id: "eval_usage",
				agent_source: "claude",
				session_id: "recent",
				file: "recent.ts",
			},
			dir,
		);
		await recurrenceListCommand({ cwd: dir, since: "1h", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "count": wireNumber, "distinct_sessions": wireNumber })), "test JSON value");
		// Same signature; the old event must be filtered out by the cutoff.
		expect(parsed).toHaveLength(1);
		expect(nonNull(parsed[0]).count).toBe(1);
		expect(nonNull(parsed[0]).distinct_sessions).toBe(1);
	});

	it("ignores an unparseable --since (no cutoff applied, all rows kept)", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ cwd: dir, since: "not-a-duration", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "count": wireNumber })), "test JSON value");
		expect(nonNull(parsed[0]).count).toBe(3);
	});

	it("ignores a non-numeric --top (returns all rows)", async () => {
		for (const id of ["a", "b", "c"]) {
			recordHarnessCaught({
				check_id: id,
				agent_source: "claude",
				session_id: "s",
				file: "f.ts",
				cwd: dir,
			});
		}
		await recurrenceListCommand({ cwd: dir, top: "abc", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
		expect(parsed).toHaveLength(3);
	});

	it("ignores --top=0 (zero is not a positive cap, returns all rows)", async () => {
		for (const id of ["a", "b", "c"]) {
			recordHarnessCaught({
				check_id: id,
				agent_source: "claude",
				session_id: "s",
				file: "f.ts",
				cwd: dir,
			});
		}
		await recurrenceListCommand({ cwd: dir, top: "0", json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
		expect(parsed).toHaveLength(3);
	});

	it("renders age buckets (minutes/hours/days) in the human-readable table", async () => {
		// One signature per age band so each row's last_seen lands in a
		// different bucket — exercises ageString's m/h/d branches.
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(90), kind: "harness_caught", check_id: "mins_check", agent_source: "claude", session_id: "s", file: "m.ts" },
			dir,
		);
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(60 * 60 * 2), kind: "harness_caught", check_id: "hours_check", agent_source: "claude", session_id: "s", file: "h.ts" },
			dir,
		);
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(60 * 60 * 24 * 3), kind: "harness_caught", check_id: "days_check", agent_source: "claude", session_id: "s", file: "d.ts" },
			dir,
		);
		await recurrenceListCommand({ cwd: dir });
		const out = captured();
		expect(out).toMatch(/1m ago/);
		expect(out).toMatch(/2h ago/);
		expect(out).toMatch(/3d ago/);
		// Header + closing summary line are part of the human-readable surface.
		expect(out).toContain("COUNT");
		expect(out).toMatch(/3 row\(s\)/);
	});

	it("renders an em-dash for rows with no agent_source and no check_id", async () => {
		// harness_missed rows derived from a bare message carry neither an
		// agent_source nor a check_id — renderRow must substitute the em-dash.
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(10), kind: "harness_missed", message: "some repeated miss" },
			dir,
		);
		await recurrenceListCommand({ cwd: dir });
		const out = captured();
		expect(out).toContain("harness_missed");
		expect(out).toContain("—");
		// distinct scope counter shows zero sessions / zero files for this row.
		expect(out).toMatch(/0s\/0f/);
	});
});

describe("recurrence detail — json and message rendering", () => {
	it("emits the matching events as JSON when --json is set", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("harness_caught:misused_promises:claude", {
			cwd: dir,
			json: true,
		});
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "kind": wireString, "file": wireAbsentOptional(wireOptional(wireString)) })), "test JSON value");
		expect(parsed).toHaveLength(3);
		expect(parsed.every((e) => e.kind === "harness_caught")).toBe(true);
		expect(parsed.map((e) => e.file)).toContain("src/foo0.ts");
	});

	it("prints the per-event message line when an event carries one", async () => {
		recordRecurrenceEvent(
			{
				ts: isoSecondsAgo(5),
				kind: "harness_missed",
				signature: "raw-sql-concat",
				message: "spotted in db.ts during review",
				file: "src/db.ts",
			},
			dir,
		);
		await recurrenceDetailCommand("harness_missed:raw-sql-concat", { cwd: dir });
		const out = captured();
		expect(out).toContain("Signature: harness_missed:raw-sql-concat");
		expect(out).toContain("Total events: 1");
		expect(out).toContain("spotted in db.ts during review");
		expect(out).toContain("src/db.ts");
	});

	it("substitutes em-dashes for absent file/session/agent fields", async () => {
		// A codebase_existing event has no session_id or agent_source.
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "codebase_existing", check_id: "eval_usage" },
			dir,
		);
		await recurrenceDetailCommand("codebase_existing:eval_usage", { cwd: dir });
		const out = captured();
		expect(out).toContain("Signature: codebase_existing:eval_usage");
		expect(out).toContain("—");
	});

	it("derives 'unknown' for a harness_caught event missing check_id and agent_source", async () => {
		// Omitting both fields (exactOptionalPropertyTypes: don't set them at
		// all) must drive signatureOf's `?? "unknown"` fallbacks on both sides.
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_caught", file: "src/anon.ts" },
			dir,
		);
		await recurrenceDetailCommand("harness_caught:unknown:unknown", { cwd: dir });
		const out = captured();
		expect(out).toContain("Signature: harness_caught:unknown:unknown");
		expect(out).toContain("src/anon.ts");
	});

	it("derives 'unknown' for a codebase_existing event missing check_id", async () => {
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "codebase_existing" }, dir);
		await recurrenceDetailCommand("codebase_existing:unknown", { cwd: dir });
		expect(captured()).toContain("Signature: codebase_existing:unknown");
	});

	it("falls back to message then 'untagged' for harness_missed without a signature", async () => {
		// message-only → signature is the message text.
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(6), kind: "harness_missed", message: "msg-keyed" },
			dir,
		);
		// neither signature nor message → "untagged".
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "harness_missed" }, dir);

		await recurrenceDetailCommand("harness_missed:msg-keyed", { cwd: dir });
		expect(captured()).toContain("Signature: harness_missed:msg-keyed");

		logSpy.mockClear();
		await recurrenceDetailCommand("harness_missed:untagged", { cwd: dir });
		expect(captured()).toContain("Signature: harness_missed:untagged");
	});
});

describe("recurrence — defaults to process.cwd() when --cwd is omitted", () => {
	// Each command resolves its working directory as `opts.cwd ?? process.cwd()`.
	// With cwd omitted, a process.cwd() spy pointed at the temp dir proves the
	// fallback path is taken (and that the command reads/writes there).
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
	});
	afterEach(() => {
		cwdSpy.mockRestore();
	});

	it("list reads the recurrences log from process.cwd()", async () => {
		seedThreeCaughtEvents();
		await recurrenceListCommand({ json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "count": wireNumber })), "test JSON value");
		expect(nonNull(parsed[0]).count).toBe(3);
	});

	it("detail reads events from process.cwd()", async () => {
		seedThreeCaughtEvents();
		await recurrenceDetailCommand("harness_caught:misused_promises:claude", { json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
		expect(parsed).toHaveLength(3);
	});

	it("flag writes the event under process.cwd()", async () => {
		await recurrenceFlagCommand("cwd-default-miss", {});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).signature).toBe("cwd-default-miss");
	});

	it("scan walks process.cwd()", async () => {
		await recurrenceScanCommand({});
		expect(captured()).toMatch(/scan found no codebase_existing patterns/);
	});

	it("propose reads aggregated rows from process.cwd()", async () => {
		seedThreeCaughtEvents();
		await recurrenceProposeCommand("harness_caught:misused_promises:claude", { json: true });
		const parsed = parseWire(JSON.parse(captured()), wireObject({ "action": wireObject({ "kind": wireString }) }), "test JSON value");
		expect(parsed.action.kind).toBe("ratchet");
	});
});

describe("recurrence flag — usage error and json", () => {
	it("prints a usage error and writes nothing when the signature is empty", async () => {
		await recurrenceFlagCommand("", { cwd: dir });
		expect(errCaptured()).toMatch(/Usage: interlinked recurrence flag/);
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("emits a confirmation JSON object when --json is set", async () => {
		await recurrenceFlagCommand("raw-sql-concat", {
			cwd: dir,
			json: true,
			checkId: "raw_sql_concat",
			file: "src/db.ts",
		});
		const parsed = parseWire(JSON.parse(captured()), wireObject({ "ok": wireBoolean, "signature": wireString }), "test JSON value");
		expect(parsed).toEqual({ ok: true, signature: "raw-sql-concat" });
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).check_id).toBe("raw_sql_concat");
		expect(nonNull(events[0]).file).toBe("src/db.ts");
	});

	it("prints a human-readable confirmation without --json", async () => {
		await recurrenceFlagCommand("dupe-error-shape", { cwd: dir });
		expect(captured()).toContain("Flagged harness_missed: dupe-error-shape");
	});
});

describe("recurrence propose — variants and json", () => {
	it("proposes a cleanup_pr for codebase_existing rows", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "codebase_existing", check_id: "eval_usage", file: "src/x.ts" },
			dir,
		);
		await recurrenceProposeCommand("codebase_existing:eval_usage", { cwd: dir });
		const out = captured();
		expect(out).toContain("Action: cleanup_pr");
		expect(out).toContain("eval_usage");
		expect(out).toContain("src/x.ts");
	});

	it("proposes scaffold_rule for harness_missed rows", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "leaky-fd" },
			dir,
		);
		await recurrenceProposeCommand("harness_missed:leaky-fd", { cwd: dir });
		const out = captured();
		expect(out).toContain("Action: scaffold_rule");
		expect(out).toContain("leaky-fd");
	});

	it("emits {row, action} as JSON when --json is set", async () => {
		seedThreeCaughtEvents();
		await recurrenceProposeCommand("harness_caught:misused_promises:claude", {
			cwd: dir,
			json: true,
		});
		const parsed = parseWire(JSON.parse(captured()), wireObject({ "row": wireObject({ "signature": wireString, "count": wireNumber }), "action": wireObject({ "kind": wireString }) }), "test JSON value");
		expect(parsed.row.signature).toBe("harness_caught:misused_promises:claude");
		expect(parsed.row.count).toBe(3);
		expect(parsed.action.kind).toBe("ratchet");
	});

	it("writes the not-found notice to stderr for an unknown signature", async () => {
		seedThreeCaughtEvents();
		await recurrenceProposeCommand("harness_caught:does_not_exist:claude", { cwd: dir });
		expect(errCaptured()).toMatch(/No recurrence row found/);
		// nothing on stdout for the miss path
		expect(captured()).toBe("");
	});
});

describe("recurrence scan", () => {
	/** Seed a source tree under `dir` whose contents trip a handful of the
	 *  inline agent-safety detectors, so the scanner returns real findings. */
	function seedScannableSource(): void {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(
			join(dir, "src", "a.ts"),
			[
				"export function run(userInput) {",
				"  const x = eval(userInput);",
				'  const q = "SELECT * FROM users WHERE id = " + userInput;',
				"  void Promise.resolve(1);",
				"  return x + q;",
				"}",
				"",
			].join("\n"),
		);
	}

	it("dry-run by default does not write to recurrences.jsonl", async () => {
		await recurrenceScanCommand({ cwd: dir });
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("prints the no-findings notice when no source roots exist to scan", async () => {
		// No `src/` tree at all → the walker yields nothing → zero findings.
		// (Asserting on a genuinely clean *file* is brittle: even a trivial
		// `export const` trips the dead_exports detector.)
		await recurrenceScanCommand({ cwd: dir });
		expect(captured()).toMatch(/scan found no codebase_existing patterns/);
	});

	it("summarizes findings grouped by check and notes the dry run", async () => {
		seedScannableSource();
		await recurrenceScanCommand({ cwd: dir });
		const out = captured();
		expect(out).toMatch(/Scanned \d+ finding\(s\) across \d+ check\(s\)/);
		expect(out).toContain("eval_usage");
		expect(out).toMatch(/dry run/);
		// dry run must not persist anything.
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("records codebase_existing events and reports them with --record", async () => {
		seedScannableSource();
		await recurrenceScanCommand({ cwd: dir, record: true });
		const out = captured();
		expect(out).toContain("Recorded as codebase_existing events");
		const events = loadRecurrenceEvents(dir);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e.kind === "codebase_existing")).toBe(true);
		const checkIds = new Set(events.map((e) => e.check_id));
		expect(checkIds.has("eval_usage")).toBe(true);
	});

	it("emits findings as JSON when --json is set", async () => {
		seedScannableSource();
		await recurrenceScanCommand({ cwd: dir, json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireObject({ "file": wireString, "check_id": wireString, "line": wireNumber })), "test JSON value");
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed.some((f) => f.check_id === "eval_usage")).toBe(true);
		expect(parsed.every((f) => f.file.startsWith("src/"))).toBe(true);
	});

	it("honors an explicit --root so an unscanned subtree yields no findings", async () => {
		seedScannableSource();
		mkdirSync(join(dir, "empty-root"), { recursive: true });
		await recurrenceScanCommand({ cwd: dir, root: ["empty-root"], json: true });
		const parsed = parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
		// The scannable source lives under src/, which the custom root excludes.
		expect(parsed).toEqual([]);
	});
});
