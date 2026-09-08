import { parseWire, wireArray, wireUnknown } from "../lib/value-validation.js";
// Mutation-kill hardening for `interlinked recurrence` (src/commands/recurrence.ts).
//
// The existing companion `__tests__/recurrence.test.ts` already drives every
// branch, but with loose `toContain`/`toMatch` assertions. Many surviving
// mutants (a truthy-vs-nullish swap on a private predicate, blanked
// table-header literals, a dropped `.sort()`, an increment turned into a
// decrement) are invisible to that style because the loose assertions are
// satisfied by EITHER the pristine or the mutated output. This file adds
// exact substring / count / order assertions targeted at the specific
// survivors, duplicating whatever minimal setup is needed so the file is a
// self-contained, statically-imported SUT consumer.
//
// Several other survivors are NOT tested here because they are argued
// equivalent (receipts: scratch/fleet-r3/receipts/src_commands_recurrence.ts.jsonl,
// classification suspected_equivalent / left_open):
//   - buildFilters' and recurrenceFlagCommand's `!== undefined` / truthy
//     guards forced to `true` (or `opts.agentSource`/`opts.checkId`/`cutoff`
//     forced true) only ever make the code assign an EXPLICIT `undefined`
//     where pristine code would have omitted the object key entirely; every
//     downstream consumer (matchesFilters' truthy checks, JSON.stringify's
//     undefined-drop) treats the two identically.
//   - isRecurrenceKind's `value !== undefined` forced to `true` is
//     algebraically identical to the original for every reachable input,
//     since KNOWN_KINDS never contains `undefined`.
//   - loadAndAggregate's `top && Number.isFinite(top)` swapped to `||`, and
//     `top > 0` widened to `top >= 0`, only diverge from pristine at
//     top === Infinity or top === 0 respectively, and both routes end up
//     calling `rows.slice(0, <value that clamps to a content-identical
//     array>)` — no observable output difference.
//   - ageString's `sec < 60` widened to `sec <= 60` is only observable at
//     the exact sec === 60 boundary (a 1-second-wide window), which this
//     suite cannot pin without faking Date.now (disallowed).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordHarnessCaught, recordRecurrenceEvent } from "../harness/recurrence.js";
import {
	recurrenceDetailCommand,
	recurrenceListCommand,
	recurrenceProposeCommand,
	recurrenceScanCommand,
} from "./recurrence.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-rec-mk-"));
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

/** True when SOME console.log call in this test received exactly one
 *  argument, the empty string — the shape of every "blank line" separator
 *  in this file's source. Distinguishes a genuine `console.log("")` from a
 *  StringLiteral mutant that replaces it with sentinel text. */
function hasBareEmptyLogCall(): boolean {
	return logSpy.mock.calls.some((c: unknown[]) => c.length === 1 && c[0] === "");
}

/** ISO timestamp `seconds` in the past, relative to now — same helper as the
 *  companion file, duplicated for self-containment. */
function isoSecondsAgo(seconds: number): string {
	return new Date(Date.now() - seconds * 1_000).toISOString();
}

/** Parses one `console.log(JSON.stringify(...))` call's captured output.
 *  SAFETY: every call site below drives a `{ json: true }` command whose
 *  ONLY stdout write is `JSON.stringify(rows)` for an array of aggregated
 *  Recurrence rows (recurrenceListCommand's json branch) — the source
 *  guarantees an array, so `unknown[]` is the sound (not `unknown`) shape. */
function capturedJsonArray(): unknown[] {
	return parseWire(JSON.parse(captured()), wireArray(wireUnknown), "test JSON value");
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

// ===========================================
// isRecurrenceKind / buildFilters: an unrecognized --kind must be IGNORED,
// not applied as a (always-empty) filter.
// ===========================================

describe("recurrence list — an unrecognized --kind value is ignored, not applied as a filter", () => {
	// An unrecognized --kind string wrongly passing the guard sets
	// filters.kind to the bogus value, so matchesFilters excludes every real
	// row (none has kind === "bogus-unknown-kind").
	// test-contract: invariant — kills e6e8df01ad0af81d, e66e73d8473a49ba, 67750eea5c798260.
	it("returns every row, unfiltered, when --kind is not one of the four known kinds", async () => {
		seedThreeCaughtEvents();

		await recurrenceListCommand({ cwd: dir, kind: "bogus-unknown-kind", json: true });

		expect(capturedJsonArray()).toHaveLength(1);
	});
});

// ===========================================
// loadAndAggregate: a negative --top must not be read as a positive cap.
// ===========================================

describe("recurrence list — a negative --top is not treated as a positive cap", () => {
	// top=-1 wrongly satisfying the "cap the rows" condition makes
	// rows.slice(0, -1) drop the last row; pristine code treats a negative
	// top as "no cap applied" and returns every row.
	// test-contract: invariant — kills 30f687f1e9370ea1, d2f19381b902cd6d.
	it("returns every row, unsliced, when --top is negative", async () => {
		for (const id of ["a", "b", "c"]) {
			recordHarnessCaught({ check_id: id, agent_source: "claude", session_id: "s", file: "f.ts", cwd: dir });
		}

		await recurrenceListCommand({ cwd: dir, top: "-1", json: true });

		expect(capturedJsonArray()).toHaveLength(3);
	});
});

// ===========================================
// ageString: bucket boundaries killable WITHOUT faking the clock (real
// elapsed-time windows wide enough that normal test overhead can't cross
// them — the companion file's own "renders age buckets" test relies on the
// same real-clock-tolerance convention).
// ===========================================

describe("recurrence list — ageString bucket boundaries (real clock, wide safety margins)", () => {
	// A just-recorded event must render as "<N>s ago"; skipping straight to
	// the minute bucket gives "0m ago", and emptying the seconds template
	// gives " ago" with nothing before it — neither matches /\ds ago/.
	// test-contract: invariant — kills 608db14a80adbe24, 11e1e262daeab4ab.
	it("renders a just-now event with the seconds bucket", async () => {
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "recent-sig" }, dir);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toMatch(/\ds ago/);
	});

	// At exactly 3600s ago, min === 60 exactly (a 59-second-wide safe window
	// either side of the boundary, since min stays 60 for any sec in
	// [3600, 3659]): pristine code falls through to the hour bucket
	// ("1h ago") while a widened `min <= 60` keeps it at "60m ago".
	// test-contract: invariant — kills 0d2b056b3d5511a3, a boundary widening.
	it("renders an exactly-60-minutes-old event as '1h ago', not '60m ago'", async () => {
		recordRecurrenceEvent({ ts: isoSecondsAgo(3600), kind: "harness_missed", signature: "hour-boundary-sig" }, dir);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toMatch(/1h ago/);
	});

	// At exactly 86400s ago, hr === 24 exactly (a ~3599-second-wide safe
	// window): pristine code falls through to the day bucket ("1d ago")
	// while a widened `hr <= 24` keeps it at "24h ago".
	// test-contract: invariant — kills 2d4fefd1012f0ec7, a boundary widening.
	it("renders an exactly-24-hours-old event as '1d ago', not '24h ago'", async () => {
		recordRecurrenceEvent({ ts: isoSecondsAgo(86400), kind: "harness_missed", signature: "day-boundary-sig" }, dir);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toMatch(/1d ago/);
	});
});

// ===========================================
// renderRow: agent_sources column (presence, absence, and join separator).
// ===========================================

describe("recurrence list — renderRow: agent_sources column", () => {
	// Forcing the "empty" ternary branch even when a real agent_source IS
	// present would keep "claude" out of the rendered row entirely.
	// test-contract: invariant — kills 1ef1eb80f0f0f71b, 4b06d0ae3ab92392.
	it("renders the real agent_source when one is present", async () => {
		seedThreeCaughtEvents();

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toContain("claude");
	});

	// check_id is set here so the ONLY possible em-dash in this row is the
	// sources column; forcing the "non-empty" branch (or a length >= 0
	// tautology, or blanking the "—" fallback) replaces it with an empty
	// join instead.
	// test-contract: invariant — kills 9699be15aa89477a, 33233910fb01efe4, c22ca286fd6b8195.
	it("renders an em-dash for the sources column when agent_sources is empty", async () => {
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "codebase_existing", check_id: "eval_usage" }, dir);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toContain("—");
	});

	// agent_source is set (non-empty sources column) and check_id is never
	// provided, so the ONLY possible em-dash in this row is the check_id
	// column's own "—" fallback (ordinal 1).
	// test-contract: invariant — kills a57a8c7f6e8b5728.
	it("renders an em-dash for the check_id column when no check_id was ever recorded", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "no-checkid-case", agent_source: "claude" },
			dir,
		);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toContain("—");
	});

	// Two events sharing one harness_missed signature but different
	// agent_source values merge into ONE row with TWO distinct
	// agent_sources, so the "/" separator is only observable with >= 2
	// sources (a lone source never inserts it).
	// test-contract: invariant — kills 872348e5b201545e.
	it("joins multiple agent_sources with a '/' separator", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "flaky-test", agent_source: "claude" },
			dir,
		);
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "flaky-test", agent_source: "codex" },
			dir,
		);

		await recurrenceListCommand({ cwd: dir });

		expect(captured()).toContain("claude/codex");
	});

	// Computing the expected gap from the SAME padEnd calls the source uses
	// (rather than hand-counting spaces) keeps this robust to the exact
	// padded width while still pinning the "  " column-join separator.
	// test-contract: invariant — kills f563816d63482f05.
	it("separates the kind and check_id columns with two literal spaces", async () => {
		seedThreeCaughtEvents();

		await recurrenceListCommand({ cwd: dir });

		const expectedGap = `${"harness_caught".padEnd(18)}  ${"misused_promises".padEnd(28)}`;
		expect(captured()).toContain(expectedGap);
	});
});

// ===========================================
// recurrenceListCommand: exact header line and the blank-line separator.
// ===========================================

describe("recurrence list — header row and blank-line separator", () => {
	// Matching the header against the EXACT template the source builds
	// (rather than a per-word substring check) pins all four column-name
	// literals — and their exact padding — in one assertion.
	// test-contract: invariant — kills 41984a269f477543, 630a5bd9345db357, 055ada2a02309ab6, a4ece0662601e3fc.
	it("prints the exact column-header line", async () => {
		seedThreeCaughtEvents();

		await recurrenceListCommand({ cwd: dir });

		const expectedHeader = `${"COUNT".padStart(4)}  ${"KIND".padEnd(18)}  ${"CHECK".padEnd(28)}  ${"AGENTS".padEnd(18)}  ${"SCOPE".padEnd(10)}  LAST`;
		expect(captured().split("\n")).toContain(expectedHeader);
	});

	// A bare, single-argument console.log("") call between the rows and the
	// closing summary is only present in pristine code.
	// test-contract: invariant — kills 564a5b1725db1a7d.
	it("prints a bare blank line between the rows and the closing summary", async () => {
		seedThreeCaughtEvents();

		await recurrenceListCommand({ cwd: dir });

		expect(hasBareEmptyLogCall()).toBe(true);
	});
});

// ===========================================
// recurrenceDetailCommand: exact hint text, blank line, per-field em-dashes,
// and the message-line guard.
// ===========================================

describe("recurrence detail — exact hint text, blank line, and per-field em-dashes", () => {
	// The companion file's /no events|unknown/i match is satisfied by the
	// FIRST stderr line alone, so it can't see this SECOND hint line go
	// blank.
	// test-contract: invariant — kills 65da0c1f288fc425.
	it("prints the exact hint line on stderr for an unknown signature", async () => {
		await recurrenceDetailCommand("not-a-real-signature", { cwd: dir });

		expect(errCaptured()).toContain("(run `interlinked recurrence list` to see known signatures)");
	});

	// A bare, single-argument console.log("") call before the per-event
	// rows is only present in pristine code's found-events path.
	// test-contract: invariant — kills f2ab5d095d21c3f1.
	it("prints a bare blank line before the per-event rows", async () => {
		seedThreeCaughtEvents();

		await recurrenceDetailCommand("harness_caught:misused_promises:claude", { cwd: dir });

		expect(hasBareEmptyLogCall()).toBe(true);
	});

	// session_id and agent_source are both set, so the ONLY possible
	// em-dash on this event's printed line is the file field's own "—"
	// fallback (ordinal 0).
	// test-contract: invariant — kills 0ab0ba9b14e4af48.
	it("renders an em-dash for a missing file", async () => {
		recordRecurrenceEvent(
			{
				ts: isoSecondsAgo(5),
				kind: "harness_missed",
				signature: "file-dash-case",
				session_id: "s1",
				agent_source: "claude",
			},
			dir,
		);

		await recurrenceDetailCommand("harness_missed:file-dash-case", { cwd: dir });

		expect(captured()).toContain("—");
	});

	// file and agent_source are both set, so the ONLY possible em-dash is
	// session_id's own "—" fallback (ordinal 1).
	// test-contract: invariant — kills 6fc1eb166de90298.
	it("renders an em-dash for a missing session_id", async () => {
		recordRecurrenceEvent(
			{
				ts: isoSecondsAgo(5),
				kind: "harness_missed",
				signature: "session-dash-case",
				file: "f.ts",
				agent_source: "claude",
			},
			dir,
		);

		await recurrenceDetailCommand("harness_missed:session-dash-case", { cwd: dir });

		expect(captured()).toContain("—");
	});

	// file and session_id are both set, so the ONLY possible em-dash is
	// agent_source's own "—" fallback (ordinal 2).
	// test-contract: invariant — kills db239cee17a2c6e4.
	it("renders an em-dash for a missing agent_source", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "agent-dash-case", file: "f.ts", session_id: "s1" },
			dir,
		);

		await recurrenceDetailCommand("harness_missed:agent-dash-case", { cwd: dir });

		expect(captured()).toContain("—");
	});

	// Three events with no message set must print no message line at all;
	// forcing the guard true would print the literal text "undefined" once
	// per event (`${e.message}` stringifying the JS value `undefined`).
	// test-contract: invariant — kills eafc064758f555b4.
	it("prints no message line, and no literal 'undefined', for events with no message", async () => {
		seedThreeCaughtEvents();

		await recurrenceDetailCommand("harness_caught:misused_promises:claude", { cwd: dir });

		expect(captured()).not.toContain("undefined");
	});
});

// ===========================================
// recurrenceProposeCommand: blank-line separator.
// ===========================================

describe("recurrence propose — blank-line separator", () => {
	// A bare, single-argument console.log("") call between the headline and
	// the detail text is only present in pristine code.
	// test-contract: invariant — kills ee3330cadda2adf4.
	it("prints a bare blank line between the headline and the detail text", async () => {
		seedThreeCaughtEvents();

		await recurrenceProposeCommand("harness_caught:misused_promises:claude", { cwd: dir });

		expect(hasBareEmptyLogCall()).toBe(true);
	});
});

// ===========================================
// KNOWN_KINDS module-level literals: every member must still work as a
// --kind filter value, not just "codebase_existing" (already covered by the
// companion file's "filters by --kind" test).
// ===========================================

describe("recurrence list — --kind filters correctly for every remaining KNOWN_KINDS member", () => {
	// Blanking any one KNOWN_KINDS member makes isRecurrenceKind reject that
	// exact literal, so filters.kind never gets set and the kind filter
	// silently stops applying for it — with all four kinds present,
	// filtering must reduce to exactly one row per --kind call.
	// test-contract: invariant — kills 2be149105b1e2ef0, 8110e93b406f6d6a, affc239b13506d8f.
	it("filters down to exactly one row for harness_caught, harness_missed, and tool_failure", async () => {
		recordRecurrenceEvent(
			{ ts: isoSecondsAgo(5), kind: "harness_caught", check_id: "c", agent_source: "claude" },
			dir,
		);
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "harness_missed", signature: "sig" }, dir);
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "codebase_existing", check_id: "c2" }, dir);
		recordRecurrenceEvent({ ts: isoSecondsAgo(5), kind: "tool_failure", check_id: "t", signature: "tf" }, dir);

		await recurrenceListCommand({ cwd: dir, kind: "harness_caught", json: true });
		expect(capturedJsonArray()).toHaveLength(1);

		logSpy.mockClear();
		await recurrenceListCommand({ cwd: dir, kind: "harness_missed", json: true });
		expect(capturedJsonArray()).toHaveLength(1);

		logSpy.mockClear();
		await recurrenceListCommand({ cwd: dir, kind: "tool_failure", json: true });
		expect(capturedJsonArray()).toHaveLength(1);
	});
});

// ===========================================
// recurrenceScanCommand: per-check count arithmetic and blank-line
// separators.
// ===========================================

describe("recurrence scan — per-check count arithmetic and blank-line separators", () => {
	function seedSingleEvalFinding(): void {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), ["export function run(x) {", "  return eval(x);", "}", ""].join("\n"));
	}

	// A check_id appearing exactly once must print count "1"; turning the
	// increment into a decrement prints "-1", and turning the `?? 0`
	// fallback into `&& 0` yields `undefined` (then NaN once incremented)
	// on a first sighting.
	// test-contract: invariant — kills e95103364a464a5f, 944e13d04fb81970.
	it("prints count '1' for a check_id with exactly one finding", async () => {
		seedSingleEvalFinding();

		await recurrenceScanCommand({ cwd: dir });

		const expectedLine = `  ${String(1).padStart(4)}  eval_usage`;
		expect(captured()).toContain(expectedLine);
	});

	// A bare, single-argument console.log("") call before the "Recorded as
	// codebase_existing events" notice is only present in pristine code's
	// --record branch.
	// test-contract: invariant — kills 31fde63c9a0cf6d1.
	it("prints a bare blank line before the recorded-events notice with --record", async () => {
		seedSingleEvalFinding();

		await recurrenceScanCommand({ cwd: dir, record: true });

		expect(hasBareEmptyLogCall()).toBe(true);
	});

	// A bare, single-argument console.log("") call before the "(dry run...)"
	// notice is only present in pristine code's non-record branch.
	// test-contract: invariant — kills 150aca4d8f5de03c.
	it("prints a bare blank line before the dry-run notice without --record", async () => {
		seedSingleEvalFinding();

		await recurrenceScanCommand({ cwd: dir });

		expect(hasBareEmptyLogCall()).toBe(true);
	});
});

// ===========================================
// recurrenceScanCommand: the per-check count list is sorted DESCENDING by
// count, not left in scan-order.
// ===========================================

describe("recurrence scan — check-count list is sorted descending by count", () => {
	/** Two roots, each producing findings for a DIFFERENT, single-purpose,
	 *  per-line detector: "low" trips eval_usage exactly once, "high" trips
	 *  inner_html exactly twice. `--root` order controls scan (and therefore
	 *  Map-insertion) order exactly, sidestepping any readdir-order
	 *  ambiguity. */
	function seedLowAndHighFindings(): void {
		mkdirSync(join(dir, "low"), { recursive: true });
		mkdirSync(join(dir, "high"), { recursive: true });
		writeFileSync(join(dir, "low", "a.ts"), ["export function low(x) {", "  return eval(x);", "}", ""].join("\n"));
		writeFileSync(
			join(dir, "high", "b.ts"),
			[
				"export function high(el, el2) {",
				'  el.innerHTML = "<b>1</b>";',
				'  el2.innerHTML = "<b>2</b>";',
				"}",
				"",
			].join("\n"),
		);
	}

	// Scanning "low" (1 eval_usage finding) before "high" (2 inner_html
	// findings) makes insertion order [eval_usage(1), inner_html(2)] — the
	// OPPOSITE of count-descending — so only a real, working sort reorders
	// inner_html to print first; dropping .sort() (or degrading its
	// comparator to always "leave order unchanged") leaves eval_usage first.
	// test-contract: invariant — kills f7d444d98c308ef6, 7090ed01b0239cf8.
	it("prints the higher-count check first when it was scanned SECOND", async () => {
		seedLowAndHighFindings();

		await recurrenceScanCommand({ cwd: dir, root: ["low", "high"] });

		const out = captured();
		expect(out).toContain("eval_usage");
		expect(out).toContain("inner_html");
		expect(out.indexOf("inner_html")).toBeLessThan(out.indexOf("eval_usage"));
	});

	// Scanning "high" (2 inner_html findings) before "low" (1 eval_usage
	// finding) makes insertion order ALREADY match count-descending order,
	// so pristine code's sort is a no-op here — only a comparator that is
	// always positive for real counts (b[1] + a[1] instead of b[1] - a[1])
	// wrongly swaps this already-correct order.
	// test-contract: invariant — kills ab73909152e84a39.
	it("keeps the higher-count check first when it was scanned FIRST", async () => {
		seedLowAndHighFindings();

		await recurrenceScanCommand({ cwd: dir, root: ["high", "low"] });

		const out = captured();
		expect(out).toContain("eval_usage");
		expect(out).toContain("inner_html");
		expect(out.indexOf("inner_html")).toBeLessThan(out.indexOf("eval_usage"));
	});
});
