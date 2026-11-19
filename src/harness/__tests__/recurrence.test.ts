// Tests for the recurrence aggregation primitive.
//
// Pure-function tests for deriveSignature / aggregateRecurrences /
// parseDurationMs / resolveSinceCutoff / proposeAction; tmpdir-backed
// tests for the JSONL append/read round-trip.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	aggregateRecurrences,
	deriveSignature,
	loadRecurrenceEvents,
	markOutcome,
	parseDurationMs,
	proposeAction,
	type Recurrence,
	type RecurrenceEvent,
	recordHarnessCaught,
	recordHarnessMissed,
	recordRecurrenceEvent,
	recordToolFailure,
	recurrencesPath,
	resolveSinceCutoff,
} from "../recurrence.js";

function ev(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
	return {
		ts: "2026-05-01T00:00:00.000Z",
		kind: "harness_caught",
		check_id: "misused_promises",
		agent_source: "claude",
		session_id: "s1",
		file: "src/foo.ts",
		message: "x",
		...overrides,
	};
}

describe("deriveSignature", () => {
	it("groups harness_caught by check_id + agent_source", () => {
		expect(deriveSignature(ev({ check_id: "x", agent_source: "claude" }))).toBe(
			"harness_caught:x:claude",
		);
		expect(deriveSignature(ev({ check_id: "x", agent_source: "codex" }))).toBe(
			"harness_caught:x:codex",
		);
	});

	it("groups codebase_existing by check_id only (file-agnostic)", () => {
		const a = deriveSignature(ev({ kind: "codebase_existing", check_id: "y", file: "a.ts" }));
		const b = deriveSignature(ev({ kind: "codebase_existing", check_id: "y", file: "b.ts" }));
		expect(a).toBe(b);
		expect(a).toBe("codebase_existing:y");
	});

	it("groups harness_missed by user signature, not by file", () => {
		const a = deriveSignature(ev({ kind: "harness_missed", signature: "raw-sql-concat", file: "a.ts" }));
		const b = deriveSignature(ev({ kind: "harness_missed", signature: "raw-sql-concat", file: "b.ts" }));
		expect(a).toBe(b);
		expect(a).toBe("harness_missed:raw-sql-concat");
	});

	it("falls back to message then 'untagged' for harness_missed without signature", () => {
		expect(deriveSignature(ev({ kind: "harness_missed", signature: undefined, message: "fallback" }))).toBe(
			"harness_missed:fallback",
		);
		expect(
			deriveSignature(ev({ kind: "harness_missed", signature: undefined, message: undefined })),
		).toBe("harness_missed:untagged");
	});
});

describe("aggregateRecurrences", () => {
	it("counts events per signature, ranks by count descending", () => {
		const rows = aggregateRecurrences([
			ev({ check_id: "a", session_id: "s1", file: "f1.ts" }),
			ev({ check_id: "a", session_id: "s2", file: "f2.ts" }),
			ev({ check_id: "b", session_id: "s1", file: "f3.ts" }),
			ev({ check_id: "a", session_id: "s2", file: "f1.ts" }),
		]);
		expect(rows).toHaveLength(2);
		expect(nonNull(rows[0]).check_id).toBe("a");
		expect(nonNull(rows[0]).count).toBe(3);
		expect(nonNull(rows[0]).distinct_sessions).toBe(2);
		expect(nonNull(rows[0]).distinct_files).toBe(2);
		expect(nonNull(rows[1]).check_id).toBe("b");
		expect(nonNull(rows[1]).count).toBe(1);
	});

	it("derives first_seen / last_seen from the event timestamps", () => {
		const rows = aggregateRecurrences([
			ev({ ts: "2026-05-01T00:00:00.000Z" }),
			ev({ ts: "2026-05-03T00:00:00.000Z" }),
			ev({ ts: "2026-05-02T00:00:00.000Z" }),
		]);
		expect(nonNull(rows[0]).first_seen).toBe("2026-05-01T00:00:00.000Z");
		expect(nonNull(rows[0]).last_seen).toBe("2026-05-03T00:00:00.000Z");
	});

	it("collects sample_files most-recent-first, deduplicated", () => {
		const rows = aggregateRecurrences([
			ev({ ts: "2026-05-01T00:00:00.000Z", file: "old.ts" }),
			ev({ ts: "2026-05-02T00:00:00.000Z", file: "mid.ts" }),
			ev({ ts: "2026-05-03T00:00:00.000Z", file: "mid.ts" }), // dup
			ev({ ts: "2026-05-04T00:00:00.000Z", file: "new.ts" }),
		]);
		expect(nonNull(rows[0]).sample_files).toEqual(["new.ts", "mid.ts", "old.ts"]);
	});

	it("collects agent_sources sorted and unique", () => {
		const rows = aggregateRecurrences([
			ev({ agent_source: "claude" }),
			ev({ agent_source: "codex" }),
			ev({ agent_source: "claude" }),
		]);
		// Different agent_sources produce different signatures, so two rows; check both.
		const allSources = rows.flatMap((r: Recurrence) => r.agent_sources);
		expect(allSources).toContain("claude");
		expect(allSources).toContain("codex");
	});

	it("filters by kind, since, agent_source, check_id", () => {
		const events: RecurrenceEvent[] = [
			ev({ ts: "2026-04-01T00:00:00.000Z", kind: "harness_caught", check_id: "a", agent_source: "claude" }),
			ev({ ts: "2026-05-01T00:00:00.000Z", kind: "harness_caught", check_id: "a", agent_source: "codex" }),
			ev({ ts: "2026-05-01T00:00:00.000Z", kind: "codebase_existing", check_id: "a" }),
		];
		expect(aggregateRecurrences(events, { kind: "codebase_existing" })).toHaveLength(1);
		expect(aggregateRecurrences(events, { since: "2026-04-15T00:00:00.000Z" }).reduce((n: number, r: Recurrence) => n + r.count, 0)).toBe(2);
		expect(aggregateRecurrences(events, { agent_source: "codex" })).toHaveLength(1);
		expect(aggregateRecurrences(events, { check_id: "a" }).reduce((n: number, r: Recurrence) => n + r.count, 0)).toBe(3);
	});

	it("preserves only present check ids and agent sources, then sorts sources", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "tool_failure", signature: "tool_failure:shared", check_id: "bash", agent_source: "codex" }),
			ev({ kind: "tool_failure", signature: "tool_failure:shared", check_id: "bash", agent_source: "claude" }),
			ev({ kind: "tool_failure", signature: "tool_failure:shared", check_id: undefined, agent_source: undefined }),
		]);
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).check_id).toBe("bash");
		expect(nonNull(rows[0]).agent_sources).toEqual(["claude", "codex"]);
	});

	it("returns an empty list for an empty input", () => {
		expect(aggregateRecurrences([])).toEqual([]);
	});

	it("does not merge distinct kinds whose signatures collide (round-12 sol #1)", () => {
		// A tool_failure forwarding "harness_missed:x" derives the same signature
		// as a harness_missed with signature "x"; bucketing by (kind, signature)
		// keeps them as two rows instead of one order-dependent merge.
		const rows = aggregateRecurrences([
			ev({ kind: "tool_failure", signature: "harness_missed:x" }),
			ev({ kind: "harness_missed", signature: "x" }),
		]);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.kind))).toEqual(
			new Set(["tool_failure", "harness_missed"]),
		);
	});

	it("clears check_id when a bucket mixes tools, order-independently (round-13 sol #2)", () => {
		// Same forwarded tool_failure signature, different check_id (tool): the
		// row must not claim either tool's id regardless of input order.
		const forward = { kind: "tool_failure" as const, signature: "tool_failure:shared" };
		const ab = aggregateRecurrences([
			ev({ ...forward, check_id: "bash" }),
			ev({ ...forward, check_id: "exec" }),
		]);
		const ba = aggregateRecurrences([
			ev({ ...forward, check_id: "exec" }),
			ev({ ...forward, check_id: "bash" }),
		]);
		expect(ab).toHaveLength(1);
		expect(nonNull(ab[0]).check_id).toBeUndefined();
		expect(nonNull(ba[0]).check_id).toBeUndefined();
	});

	it("keeps check_id ambiguity sticky once two ids appear (round-14 sol #1)", () => {
		// Sequence [bash, exec, bash]: once two distinct ids are seen the row must
		// never re-claim one, regardless of a later matching id.
		const forward = { kind: "tool_failure" as const, signature: "tool_failure:s" };
		const rows = aggregateRecurrences([
			ev({ ...forward, check_id: "bash" }),
			ev({ ...forward, check_id: "exec" }),
			ev({ ...forward, check_id: "bash" }),
		]);
		expect(rows).toHaveLength(1);
		expect(nonNull(rows[0]).check_id).toBeUndefined();
	});

	it("treats a present-but-empty check_id as distinct from a real one (round-15 sol #1)", () => {
		const forward = { kind: "tool_failure" as const, signature: "tool_failure:s" };
		const rows = aggregateRecurrences([
			ev({ ...forward, check_id: "" }),
			ev({ ...forward, check_id: "bash" }),
		]);
		expect(rows).toHaveLength(1);
		// "" and "bash" differ → ambiguous → no claimed id (and never the empty string).
		expect(nonNull(rows[0]).check_id).toBeUndefined();
	});

	it("preserves a lone present-but-empty check_id rather than dropping it (round-16 sol #2)", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "tool_failure", signature: "tool_failure:s", check_id: "" }),
		]);
		expect(rows).toHaveLength(1);
		// One distinct id — the empty string — is preserved, not coerced to undefined.
		expect(nonNull(rows[0]).check_id).toBe("");
	});

	it("caps sample_files so a signature over many files can't amplify output (round-18 sol #1)", () => {
		const events = Array.from({ length: 25 }, (_, i) =>
			ev({ kind: "harness_missed", signature: "s", file: `f${i}.ts`, ts: `2026-05-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z` }),
		);
		const rows = aggregateRecurrences(events);
		expect(nonNull(rows[0]).sample_files.length).toBeLessThanOrEqual(10);
	});

	it("keeps first-seen tie order at the sample boundary when an older file becomes recent", () => {
		const eventFor = (file: string, ts: string) => ev({ kind: "harness_missed", signature: "shared", file, ts });
		const tied = "2026-05-10T00:00:00Z";
		const events = [
			eventFor("updated.ts", "invalid"),
			...Array.from({ length: 12 }, (_, index) => eventFor("f" + index + ".ts", tied)),
			eventFor("updated.ts", tied),
			eventFor("f11.ts", "2026-05-11T00:00:00Z"),
			eventFor("f11.ts", "invalid"),
		];
		const [row] = aggregateRecurrences(events);
		expect(row?.distinct_files).toBe(13);
		expect(row?.sample_files).toEqual(["f11.ts", "updated.ts", "f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts", "f7.ts"]);
	});

	it("keeps distinct_files exact via per-file dedup, sample_files bounded (round-19/20 sol)", () => {
		const events = Array.from({ length: 1005 }, (_, i) =>
			ev({ kind: "harness_missed", signature: "s", file: `f${i}.ts`, ts: "2026-05-01T00:00:00.000Z" }),
		);
		const rows = aggregateRecurrences(events);
		// Exact count (dedup, not a lossy cap); the SAMPLE stays bounded.
		expect(nonNull(rows[0]).distinct_files).toBe(1005);
		expect(nonNull(rows[0]).sample_files.length).toBeLessThanOrEqual(10);
	});

	it("samples the MOST-recent files even after many earlier ones (round-20 sol #2)", () => {
		const events = Array.from({ length: 50 }, (_, i) =>
			ev({ kind: "harness_missed", signature: "s", file: `old${i}.ts`, ts: "2026-01-01T00:00:00.000Z" }),
		);
		events.push(ev({ kind: "harness_missed", signature: "s", file: "latest.ts", ts: "2026-12-31T00:00:00.000Z" }));
		const rows = aggregateRecurrences(events);
		// The newest file leads the sample despite arriving after 50 older ones.
		expect(nonNull(rows[0]).sample_files[0]).toBe("latest.ts");
	});

	it("orders sample_files without NaN when all timestamps are malformed (round-18 sol #3)", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "s", file: "a.ts", ts: "not-a-date" }),
			ev({ kind: "harness_missed", signature: "s", file: "b.ts", ts: "also-bad" }),
		]);
		// No throw, both files retained, deterministic (comparator never returns NaN).
		expect(new Set(nonNull(rows[0]).sample_files)).toEqual(new Set(["a.ts", "b.ts"]));
	});

	it("a malformed first timestamp does not corrupt the bounds when valid ones follow (round-17 sol #2)", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "x", ts: "not-a-date" }),
			ev({ kind: "harness_missed", signature: "x", ts: "2026-05-01T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "x", ts: "2026-05-03T00:00:00.000Z" }),
		]);
		expect(nonNull(rows[0]).first_seen).toBe("2026-05-01T00:00:00.000Z");
		expect(nonNull(rows[0]).last_seen).toBe("2026-05-03T00:00:00.000Z");
	});

	it("never surfaces a malformed-timestamp file as most-recent sample (round-14 sol #4)", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "s", file: "bad.ts", ts: "not-a-date" }),
			ev({ kind: "harness_missed", signature: "s", file: "new.ts", ts: "2026-05-04T00:00:00Z" }),
		]);
		// The valid, most-recent file leads; the invalid-timestamp file sorts last.
		expect(nonNull(rows[0]).sample_files[0]).toBe("new.ts");
	});

	it("excludes malformed event timestamps under a since filter, not fail-open (round-12 sol #5)", () => {
		const rows = aggregateRecurrences(
			[
				ev({ ts: "not-a-date", kind: "harness_missed", signature: "bad" }),
				ev({ ts: "2026-05-10T00:00:00.000Z", kind: "harness_missed", signature: "good" }),
			],
			{ since: "2026-05-01T00:00:00.000Z" },
		);
		// The malformed-timestamp row is dropped; only the valid, in-window row survives.
		expect(rows.map((r) => r.signature)).toEqual(["harness_missed:good"]);
	});

	it("includes an event exactly at the since cutoff", () => {
		const rows = aggregateRecurrences(
			[
				ev({ ts: "2026-05-01T00:00:00.000Z", kind: "harness_missed", signature: "exact" }),
				ev({ ts: "2026-04-30T23:59:59.999Z", kind: "harness_missed", signature: "before" }),
			],
			{ since: "2026-05-01T00:00:00.000Z" },
		);
		expect(rows.map((r) => r.signature)).toEqual(["harness_missed:exact"]);
	});

	it("keeps the latest valid timestamp for each file, including malformed-to-valid repair", () => {
		const rows = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "s", file: "a.ts", ts: "2026-05-10T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "a.ts", ts: "2026-05-01T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "b.ts", ts: "2026-05-05T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "c.ts", ts: "not-a-date" }),
			ev({ kind: "harness_missed", signature: "s", file: "c.ts", ts: "2026-05-09T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "d.ts", ts: "2026-05-08T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "d.ts", ts: "also-not-a-date" }),
			ev({ kind: "harness_missed", signature: "s", file: "e.ts", ts: "2026-05-01T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "s", file: "e.ts", ts: "2026-05-06T00:00:00.000Z" }),
		]);
		expect(nonNull(rows[0]).sample_files).toEqual(["a.ts", "c.ts", "d.ts", "e.ts", "b.ts"]);
	});

	it("orders distinct sample files newest first and preserves insertion order for equal timestamps", () => {
		const unequal = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "unequal", file: "old.ts", ts: "2026-05-01T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "unequal", file: "new.ts", ts: "2026-05-02T00:00:00.000Z" }),
		]);
		expect(nonNull(unequal[0]).sample_files).toEqual(["new.ts", "old.ts"]);

		const equal = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: "equal", file: "first.ts", ts: "2026-05-01T00:00:00.000Z" }),
			ev({ kind: "harness_missed", signature: "equal", file: "second.ts", ts: "2026-05-01T00:00:00.000Z" }),
		]);
		expect(nonNull(equal[0]).sample_files).toEqual(["first.ts", "second.ts"]);
	});

	it("caps the signature prefix fed to the assembly ranker (round-9 perf hardening)", () => {
		// Two signatures that agree on their first > SIGNATURE_ASSEMBLY_CAP chars
		// but diverge after. If the assembly index only sees a bounded prefix,
		// both rows score identically — a deterministic proof the O(1)-per-row
		// bound applies (a long user-supplied harness_missed message can't make
		// the ranker do unbounded work). No timing assertion (those are flaky).
		const shared = "q7x-k2p-m9w-z3v-r8t".repeat(20).slice(0, 256);
		const a = aggregateRecurrences([ev({ kind: "harness_missed", signature: `${shared}${"a".repeat(100)}` })]);
		const b = aggregateRecurrences([ev({ kind: "harness_missed", signature: `${shared}${"abcdefghijklmnopqrstuvwxyz".repeat(4)}` })]);
		expect(nonNull(a[0]).assembly_significance).toBe(
			nonNull(b[0]).assembly_significance,
		);
	});

	it("scores the payload, not the kind prefix, so ranking is prefix-neutral (round-9 sol #2)", () => {
		// The SAME payload under two different kinds must score identically —
		// the fixed "<kind>:" transport prefix must not bias the structural
		// score or eat unevenly into the cap.
		const payload = "shared-payload-abc123";
		const rows = aggregateRecurrences([
			ev({ kind: "harness_missed", signature: payload }),
			ev({ kind: "codebase_existing", check_id: payload }),
		]);
		const missed = rows.find((r) => r.kind === "harness_missed");
		const existing = rows.find((r) => r.kind === "codebase_existing");
		expect(missed?.assembly_significance).toBe(existing?.assembly_significance);
		expect(missed?.assembly_significance).toBeGreaterThan(0);
	});

	it("ranks equal-count rows by assembly significance (spike 14 / round-2 #33)", () => {
		// Two signatures seen the same number of times (count 2). One is highly
		// repetitive (compresses to a tiny grammar → low assembly index); the
		// other is structurally complex (near-incompressible → high index). The
		// complex, load-bearing pattern must rank first among equal counts.
		const repetitive = "aaaaaaaaaaaaaaaaaaaa";
		const complex = "q7x-k2p-m9w-z3v-r8t";
		const events: RecurrenceEvent[] = [
			ev({ kind: "harness_missed", signature: repetitive }),
			ev({ kind: "harness_missed", signature: repetitive }),
			ev({ kind: "harness_missed", signature: complex }),
			ev({ kind: "harness_missed", signature: complex }),
		];
		const rows = aggregateRecurrences(events);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.count === 2)).toBe(true);
		// The field is populated (assembly-score is actually consumed)…
		expect(nonNull(rows[0]).assembly_significance).toBeGreaterThan(0);
		// …and it decides the order: complex signature outranks the repetitive one.
		expect(nonNull(rows[0]).signature).toContain(complex);
		expect(nonNull(rows[1]).signature).toContain(repetitive);
		expect(nonNull(rows[0]).assembly_significance).toBeGreaterThan(
			nonNull(rows[1]).assembly_significance,
		);
	});
});

describe("parseDurationMs", () => {
	it("parses suffixed durations s/m/h/d/w", () => {
		expect(parseDurationMs("90s")).toBe(90 * 1000);
		expect(parseDurationMs("30m")).toBe(30 * 60 * 1000);
		expect(parseDurationMs("12h")).toBe(12 * 60 * 60 * 1000);
		expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
		expect(parseDurationMs("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
	});
	it("tolerates whitespace and case", () => {
		expect(parseDurationMs("  7D  ")).toBe(7 * 24 * 60 * 60 * 1000);
	});
	it("returns null on malformed input", () => {
		expect(parseDurationMs("seven days")).toBeNull();
		expect(parseDurationMs("7y")).toBeNull();
		expect(parseDurationMs("")).toBeNull();
	});
	it("returns null when the product overflows to Infinity (round-12 sol #3)", () => {
		// A finite but enormous amount overflows amount*unitMs → Infinity.
		expect(parseDurationMs(`${"9".repeat(306)}s`)).toBeNull();
	});
});

describe("resolveSinceCutoff", () => {
	const NOW = new Date("2026-05-04T12:00:00.000Z");
	it("resolves a relative duration to an absolute past timestamp", () => {
		expect(resolveSinceCutoff("1d", NOW)).toBe("2026-05-03T12:00:00.000Z");
	});
	it("accepts an absolute ISO timestamp as-is (normalized)", () => {
		expect(resolveSinceCutoff("2026-04-01T00:00:00Z", NOW)).toBe("2026-04-01T00:00:00.000Z");
	});
	it("returns null for unparseable input or empty", () => {
		expect(resolveSinceCutoff(undefined, NOW)).toBeNull();
		expect(resolveSinceCutoff("garbage", NOW)).toBeNull();
	});
	it("returns null (never throws) on an oversized duration (round-12 sol #3)", () => {
		expect(() => resolveSinceCutoff(`${"9".repeat(309)}w`, NOW)).not.toThrow();
		expect(resolveSinceCutoff(`${"9".repeat(309)}w`, NOW)).toBeNull();
	});
});

describe("proposeAction", () => {
	const baseRow = (overrides: Partial<Recurrence>): Recurrence => ({
		kind: "harness_caught",
		signature: "harness_caught:foo:claude",
		check_id: "foo",
		count: 5,
		first_seen: "2026-05-01T00:00:00.000Z",
		last_seen: "2026-05-03T00:00:00.000Z",
		distinct_sessions: 3,
		distinct_files: 2,
		agent_sources: ["claude"],
		sample_files: ["a.ts", "b.ts"],
		assembly_significance: 0,
		...overrides,
	});

	it("harness_caught → ratchet", () => {
		const a = proposeAction(baseRow({}));
		expect(a.kind).toBe("ratchet");
		expect(a.headline).toContain("foo");
		expect(a.detail).toContain("guard-rules.local.json");
	});

	it("falls back to the full signature when a row has no check id", () => {
		const a = proposeAction(
			baseRow({ check_id: undefined, signature: "harness_caught:foo:claude" }),
		);
		expect(a.headline).toContain("harness_caught:foo:claude");
	});

	it("harness_missed → scaffold_rule", () => {
		const a = proposeAction(
			baseRow({
				kind: "harness_missed",
				signature: "harness_missed:raw-sql-concat",
				check_id: undefined,
			}),
		);
		expect(a.kind).toBe("scaffold_rule");
		expect(a.headline).toContain("raw-sql-concat");
		expect(a.detail).toContain("deterministic rule or quality check");
	});

	it("codebase_existing → cleanup_pr", () => {
		const a = proposeAction(
			baseRow({
				kind: "codebase_existing",
				signature: "codebase_existing:foo",
				check_id: undefined,
				distinct_files: 12,
				sample_files: ["a.ts", "b.ts", "c.ts"],
			}),
		);
		expect(a.kind).toBe("cleanup_pr");
		expect(a.headline).toContain("12 file(s) with codebase_existing:foo");
		expect(a.detail).toBe("Fix existing findings across sample files: a.ts, b.ts, c.ts.");

		const empty = proposeAction(baseRow({ kind: "codebase_existing", sample_files: [] }));
		expect(empty.detail).toContain("none recorded");
	});
});

describe("recurrencesPath / recordRecurrenceEvent / loadRecurrenceEvents", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-recurrence-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("recurrencesPath resolves under .interlinked/recurrences.jsonl in the given cwd", () => {
		expect(recurrencesPath(dir)).toBe(join(dir, ".interlinked", "recurrences.jsonl"));
	});

	it("returns an empty array when the file does not exist", () => {
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("appends + reads back round-trip preserves event order", () => {
		recordRecurrenceEvent(ev({ ts: "2026-05-01T00:00:00.000Z" }), dir);
		recordRecurrenceEvent(ev({ ts: "2026-05-02T00:00:00.000Z" }), dir);
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(2);
		expect(nonNull(out[0]).ts).toBe("2026-05-01T00:00:00.000Z");
		expect(nonNull(out[1]).ts).toBe("2026-05-02T00:00:00.000Z");
	});

	it("recordToolFailure records a tool_failure event keyed by tool_name", () => {
		recordToolFailure({
			tool_name: "Bash",
			signature: "tool_failure:Bash:enoent:cmd",
			agent_source: "claude",
			session_id: "s1",
			file: "src/x.ts",
			message: "boom",
			ts: "2026-05-05T00:00:00.000Z",
			cwd: dir,
		});
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).kind).toBe("tool_failure");
		expect(nonNull(out[0]).check_id).toBe("Bash");
		expect(nonNull(out[0]).signature).toBe("tool_failure:Bash:enoent:cmd");
	});

	it("recordToolFailure defaults the timestamp when it is omitted", () => {
		recordToolFailure({
			tool_name: "Bash",
			signature: "tool_failure:Bash:enoent:cmd",
			agent_source: "claude",
			session_id: "s1",
			cwd: dir,
		});
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ts).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
	});

	it("recordToolFailure never throws on an unwritable cwd", () => {
		// File-as-parent = ENOTDIR on every platform. NEVER a "/proc/…" path:
		// recursive mkdir under /proc spins forever on the Linux CI runner
		// (guard-state.test.ts finding 2026-06; re-hit 2026-07-29 as the shard
		// hangs in runs 30410747800/30412876710/30466905490 — this file's old
		// /proc probe was the REAL cause of its 2026-07 "collection hang"
		// quarantine).
		const fileAsParent = join(dir, "not-a-directory");
		writeFileSync(fileAsParent, "x");
		expect(() =>
			recordToolFailure({
				tool_name: "Bash",
				signature: "tool_failure:Bash:x",
				agent_source: "claude",
				session_id: "s",
				cwd: join(fileAsParent, "nested"),
			}),
		).not.toThrow();
	});

	it("recordHarnessMissed records a harness_missed event with the supplied signature", () => {
		recordHarnessMissed({
			signature: "raw-sql-concat",
			file: "src/db.ts",
			message: "string-templated SQL",
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).kind).toBe("harness_missed");
		expect(nonNull(events[0]).signature).toBe("raw-sql-concat");
		expect(nonNull(events[0]).file).toBe("src/db.ts");
	});

	it("recordHarnessCaught wraps recordRecurrenceEvent with kind=harness_caught + a fresh ts", () => {
		recordHarnessCaught({
			check_id: "misused_promises",
			agent_source: "claude",
			session_id: "s1",
			file: "src/foo.ts",
			message: "x",
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).kind).toBe("harness_caught");
		expect(nonNull(events[0]).check_id).toBe("misused_promises");
		expect(nonNull(events[0]).agent_source).toBe("claude");
		expect(nonNull(events[0]).session_id).toBe("s1");
		expect(nonNull(events[0]).file).toBe("src/foo.ts");
		expect(nonNull(events[0]).message).toBe("x");
		// ts auto-populated as ISO 8601
		expect(nonNull(events[0]).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("keeps operational no-verdict rows out of source recurrence", () => {
		for (const checkId of [
			"external_check_deferred",
			"affected_tests_deferred",
			"project_typecheck_deferred",
			"project_tests_deferred",
		]) {
			recordHarnessCaught({
				check_id: checkId,
				agent_source: "claude",
				session_id: "s1",
				file: "src/foo.ts",
				cwd: dir,
			});
		}
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("markOutcome writes outcome_marker rows that survive reload", () => {
		markOutcome({
			check_id: "misused_promises",
			file: "src/foo.ts",
			session_id: "s1",
			signal: "agent_suppressed",
			reason: "inline suppression with justification",
			fire_ts: "2026-05-01T00:00:00.000Z",
			ts: "2026-05-02T00:00:00.000Z",
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			ts: "2026-05-02T00:00:00.000Z",
			kind: "outcome_marker",
			check_id: "misused_promises",
			file: "src/foo.ts",
			session_id: "s1",
			outcome_signal: "agent_suppressed",
			outcome_reason: "inline suppression with justification",
			fire_ts: "2026-05-01T00:00:00.000Z",
		});
	});

	it("markOutcome never throws on an unwritable cwd", () => {
		// File-as-parent, never /proc — see recordToolFailure's twin above.
		const fileAsParent = join(dir, "not-a-directory-2");
		writeFileSync(fileAsParent, "x");
		expect(() =>
			markOutcome({
				check_id: "x",
				file: "f",
				session_id: "s",
				signal: "agent_fixed",
				cwd: join(fileAsParent, "nested"),
			}),
		).not.toThrow();
	});

	it("skips torn / malformed lines without throwing", () => {
		const path = join(dir, ".interlinked", "recurrences.jsonl");
		recordRecurrenceEvent(ev(), dir); // ensures dir exists
		writeFileSync(
			path,
			[
				JSON.stringify(ev({ ts: "2026-05-01T00:00:00.000Z" })),
				"{not valid json",
				"",
				JSON.stringify(ev({ ts: "2026-05-02T00:00:00.000Z" })),
			].join("\n"),
		);
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(2);
		expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
	});

	it("skips valid JSON lines that are not recurrence events", () => {
		const path = join(dir, ".interlinked", "recurrences.jsonl");
		recordRecurrenceEvent(ev({ ts: "2026-05-01T00:00:00.000Z" }), dir);
		writeFileSync(
			path,
			[
				JSON.stringify(ev({ ts: "2026-05-01T00:00:00.000Z" })),
				JSON.stringify({ ts: 123, kind: "harness_caught" }),
				JSON.stringify({ ts: "2026-05-01T00:00:00.000Z", kind: "not-a-kind" }),
				JSON.stringify({ ts: "2026-05-01T00:00:00.000Z" }),
				JSON.stringify(["2026-05-01T00:00:00.000Z", "harness_caught"]),
			].join("\n"),
		);
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).kind).toBe("harness_caught");
		expect(nonNull(out[0]).ts).toBe("2026-05-01T00:00:00.000Z");
	});

	it("recordHarnessCaught swallows storage errors so the PostToolUse hot path is never aborted", () => {
		// Force a filesystem failure: pass a regular file as the cwd so the
		// implicit `mkdir <cwd>/.interlinked` fails with ENOTDIR.
		const blocking = join(dir, "blocking-file");
		writeFileSync(blocking, "hello");
		expect(() =>
			recordHarnessCaught({
				check_id: "x",
				agent_source: "claude",
				session_id: "s",
				file: "f",
				cwd: blocking,
			}),
		).not.toThrow();
	});

	it("recordRecurrenceEvent still throws on filesystem errors (CLI surfaces them)", () => {
		// Counterpart to the test above: the low-level write primitive must
		// keep its loud-failure semantics so `interlinked recurrence flag`
		// reports disk-full / permission errors to the user. Only the
		// PostToolUse wrapper (`recordHarnessCaught`) swallows.
		const blocking = join(dir, "blocking-file-2");
		writeFileSync(blocking, "hello");
		expect(() => recordRecurrenceEvent(ev(), blocking)).toThrow();
	});
});
