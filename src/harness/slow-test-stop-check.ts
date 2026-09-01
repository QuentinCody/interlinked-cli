// ===========================================
// Slow-Test — Stop-time measurement-integrity nudge
// ===========================================
// Companion to verification-stop-checks.ts. Sibling-file style, like
// dead-on-arrival.ts / fixture-leak.ts / mutation-kill-evidence-stop-check.ts:
// detector + formatter live together here so lifecycle-stop-warnings.ts can
// mock ONE module (and so this near-cap-pressured file family doesn't grow
// verification-stop-checks.ts itself, which sits close to the 500-line cap).
//
// Motivation (measurement integrity, bug #13 —
// scratch/fleet-r3/repair-followups.txt): Stryker's mutation dry run reuses
// this repo's OWN testTimeout/hookTimeout (30_000ms — vitest.stryker.config.ts),
// with no per-mutant retry. A single legitimate-but-slow test that trips that
// cap turns into "Test timed out in 30000ms" -> a dry-run ConfigError -> no
// report -> an opaque ENOENT further downstream, and the whole FILE the test
// lives in becomes unmeasurable, not just that one test. A slow test is a
// smell, not a defect, so this nudge only ever warns.
//
// Data source: the bundled vitest reporter (lib/viz/reporter-vitest.ts)
// appends one line per finished test case to `.interlinked/test-events.jsonl`
// (lib/viz/test-events.ts) — but ONLY when a run opts in via
// `INTERLINKED_VIZ=1` (vitest.config.ts gates the reporter on that env var so
// a plain `vitest run` stays byte-identical for the harness's own output
// parsers). When the feed is absent, empty, or carries nothing inside this
// session's time window, the detector returns zero hits and the nudge stays
// silent — never guess a duration exists that wasn't actually measured.
//
// Session scoping: the feed has no `session_id` field (it is a process/run
// log, not a session log — see test-events.ts's own docstring), so events are
// bounded to `session.started_at` instead, the same "time-bounded, not
// id-bounded" approach checkWipCommits (lifecycle-stop-warnings.ts) uses
// against a git baseline sha. Under concurrent multi-agent sessions on one
// tree (feedback_multiagent_one_tree_is_normal.md) a run kicked off by
// ANOTHER session could in principle land inside this window too — an
// accepted imprecision for a warn-only, never-block nudge, same tradeoff the
// git-baseline-scoped nudges already make.
//
// Deterministic; touches the filesystem (a single bounded tail-read of the
// feed file). Warning (stderr), never blocks — the same "lever held in
// reserve" stance as every other nudge in this family.

import { existsSync } from "node:fs";
import { nonNull } from "../lib/non-null.js";
import { seedRecentTestEvents, testEventsPath, type TestEvent } from "../lib/viz/test-events.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

/** Absolute tier — "a unit test over ~1s" (task framing). A nudge floor
 *  deliberately well below the 30s dry-run cap so slow tests surface long
 *  before they're anywhere near poisoning a measurement. Integration/bench
 *  files get {@link INTEGRATION_TEST_SLOW_MS} instead — see below. */
const UNIT_TEST_SLOW_MS = 1_000;

/** Absolute tier for integration/bench-named files. They legitimately spawn
 *  real subprocesses (biome/tsc) and do real I/O, so the ~1s unit floor would
 *  flag most of them at every Stop (reviewer finding, 2026-08-15). They still
 *  get an absolute ceiling well under the 30s dry-run cap. */
const INTEGRATION_TEST_SLOW_MS = 10_000;

/** File shapes carrying the higher absolute floor: `*.integration.test.ts`,
 *  `foo-integration.test.ts`, `bench/`/`benchmarks/` dirs, `*.bench.*`. */
const INTEGRATION_FILE_RE = /(?:\.|-)integration\.|(?:^|\/)bench(?:mark)?s?(?:\/|\.)|\.bench\./i;

/** The absolute-tier floor for one test file (unit vs integration/bench). */
function absoluteFloorFor(file: string): number {
	return INTEGRATION_FILE_RE.test(file) ? INTEGRATION_TEST_SLOW_MS : UNIT_TEST_SLOW_MS;
}

/** Relative tier — "far slower than its file's median". A test at or above
 *  this many multiples of its own file's median duration is disproportionate
 *  even if it never crosses the absolute floor above. */
const RELATIVE_MULTIPLIER = 10;

/** Floor below which the relative tier never fires — without this, a file
 *  whose median is a few ms (typical for pure-function unit tests) would flag
 *  any test at a few tens of ms as "10x the median", which is noise, not a
 *  measurement-integrity risk. */
const RELATIVE_FLOOR_MS = 200;

/** Bound on lines read from the feed tail — mirrors the repo-wide bounded-
 *  JSONL-read convention (`interlinked query`'s 20k-record default; see
 *  CLAUDE.md "Querying the local data"). A full-suite run emits roughly one
 *  line per test plus one per file/run boundary, so this comfortably covers
 *  one run without an unbounded read. */
const FEED_SCAN_CAP = 20_000;

/** Max slow tests enumerated in the Stop nudge — matches the sibling nudges'
 *  shared default (dead-on-arrival.ts, fixture-leak.ts). */
const SLOW_TEST_MAX_SHOWN = 5;

export interface SlowTestHit {
	/** Test file, as recorded by the reporter (repo-relative when resolvable). */
	file: string;
	/** Full test name. */
	name: string;
	/** Observed duration in ms — the WORST of any duplicate/retried report for
	 *  this (file, name) pair. */
	ms: number;
	/** This test's file's median duration among tests observed this session. */
	fileMedianMs: number;
	/** Which tier fired: the flat ~1s floor, or far-above-file-median. */
	reason: "absolute" | "relative";
}

interface DetectSlowTestsOpts {
	cwd: string;
	/** `SessionTrajectory.started_at` (ISO 8601) — the lower time bound. */
	sessionStartedAt: string;
	/** Reads the bounded, chronological test-event feed for `cwd`. Defaults to
	 *  the real reporter feed. Injectable so tests drive the detector with
	 *  in-memory events — no real fs, matching the sibling Stop-check pattern
	 *  (mutation-kill-evidence-stop-check.ts's injected gitShow/readFile). */
	readEvents?: (cwd: string) => TestEvent[];
}

/** Default `readEvents` — the real feed on disk, existsSync-gated so an
 *  absent file (the common case: INTERLINKED_VIZ was never set) is a fast,
 *  silent no-op rather than a try/catch around a guaranteed ENOENT. */
function readRealTestEvents(cwd: string): TestEvent[] {
	const path = testEventsPath(cwd);
	if (!existsSync(path)) return [];
	try {
		return seedRecentTestEvents(path, FEED_SCAN_CAP);
	} catch {
		return []; // corrupt/unreadable feed — advisory, so fail silent not loud
	}
}

/** The middle value of `values` (average of the two middles when even-length).
 *  Callers only ever pass a non-empty array (grouped from at least one hit). */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (nonNull(sorted[mid - 1]) + nonNull(sorted[mid])) / 2;
	}
	return nonNull(sorted[mid]);
}

/** Dedup key for a (file, name) pair — a JSON-array encoding so the two parts
 *  can never collide regardless of what characters either one contains. */
function dedupKey(file: string, name: string): string {
	return JSON.stringify([file, name]);
}

interface WorstRecord {
	file: string;
	name: string;
	ms: number;
}

/** Pass 1 — dedupe the raw feed down to one record per (file, name) pair,
 *  keeping the WORST (max) observed `ms` and dropping anything that isn't a
 *  finite per-test duration or falls before `startMs`. Extracted from
 *  `detectSlowTests` to keep each pass under the cyclomatic cap. */
function collectWorstDurations(
	events: readonly TestEvent[],
	startMs: number,
): Map<string, WorstRecord> {
	const worst = new Map<string, WorstRecord>();
	for (const e of events) {
		if (e.kind !== "test") continue;
		if (typeof e.ms !== "number" || !Number.isFinite(e.ms)) continue;
		const evMs = Date.parse(e.ts);
		if (!Number.isFinite(evMs) || evMs < startMs) continue;
		const file = e.file ?? "(unknown file)";
		const name = e.name ?? "(unnamed test)";
		const key = dedupKey(file, name);
		const prev = worst.get(key);
		if (!prev || e.ms > prev.ms) worst.set(key, { file, name, ms: e.ms });
	}
	return worst;
}

/** Pass 2 — group the deduped durations by file and take each file's median. */
function computeMedianByFile(worst: ReadonlyMap<string, WorstRecord>): Map<string, number> {
	const byFile = new Map<string, number[]>();
	for (const r of worst.values()) {
		const arr = byFile.get(r.file);
		if (arr) arr.push(r.ms);
		else byFile.set(r.file, [r.ms]);
	}
	const medianByFile = new Map<string, number>();
	for (const [file, durations] of byFile) medianByFile.set(file, median(durations));
	return medianByFile;
}

/** Pass 3 — classify each deduped record against the two tiers (absolute
 *  ~1s floor, or far above its own file's median). */
function classifySlowTestHits(
	worst: ReadonlyMap<string, WorstRecord>,
	medianByFile: ReadonlyMap<string, number>,
): SlowTestHit[] {
	const hits: SlowTestHit[] = [];
	for (const r of worst.values()) {
		const fileMedianMs = medianByFile.get(r.file) ?? r.ms;
		if (r.ms > absoluteFloorFor(r.file)) {
			hits.push({ ...r, fileMedianMs, reason: "absolute" });
		} else if (
			r.ms >= RELATIVE_FLOOR_MS &&
			fileMedianMs > 0 &&
			r.ms > fileMedianMs * RELATIVE_MULTIPLIER
		) {
			hits.push({ ...r, fileMedianMs, reason: "relative" });
		}
	}
	return hits;
}

/**
 * Public — scan this session's slice of the test-events feed for tests that
 * ran slower than either tiered threshold. Returns `[]` when the feed is
 * absent/empty, when the session's start time can't be parsed (fail silent,
 * not fail open to unscoped history), or when nothing in-window qualifies.
 *
 * Duplicate (file, name) reports — a retried case under vitest's `retry: 1` —
 * collapse to the WORST observed duration before thresholding: the slower
 * attempt is the one that risked the dry-run cap, and the sole survivor a
 * green retry leaves behind would otherwise hide it. Orchestrates three
 * extracted passes (collect -> median -> classify) so no single function
 * carries the whole branch count.
 */
export function detectSlowTests(opts: DetectSlowTestsOpts): SlowTestHit[] {
	const startMs = Date.parse(opts.sessionStartedAt);
	if (!Number.isFinite(startMs)) return [];
	const readEvents = opts.readEvents ?? readRealTestEvents;
	const events = readEvents(opts.cwd);
	if (events.length === 0) return [];

	const worst = collectWorstDurations(events, startMs);
	if (worst.size === 0) return [];

	const medianByFile = computeMedianByFile(worst);
	const hits = classifySlowTestHits(worst, medianByFile);
	hits.sort((a, b) => b.ms - a.ms);
	return hits;
}

interface FormatSlowTestsOpts {
	hits: ReadonlyArray<SlowTestHit>;
	maxShown?: number;
}

/**
 * Public — pure formatter for the slow-test Stop nudge. Returns null when
 * there are no hits. Names the slowest tests and the fix, per-hit annotated
 * with the multiple-of-median for the relative tier (the absolute tier's own
 * ms figure already speaks for itself against the stated ~1s bar).
 */
export function formatSlowTestsWarning(opts: FormatSlowTestsOpts): string | null {
	if (opts.hits.length === 0) return null;
	const max = opts.maxShown ?? SLOW_TEST_MAX_SHOWN;
	const shown = opts.hits.slice(0, max);
	const lines = shown.map((h) => {
		const detail =
			h.reason === "relative"
				? `${h.ms}ms, ~${Math.round(h.ms / Math.max(h.fileMedianMs, 1))}x its file's ${Math.round(h.fileMedianMs)}ms median`
				: `${h.ms}ms`;
		return `  - ${h.file} :: ${h.name} (${detail})`;
	});
	const more = opts.hits.length > max ? `\n  ...and ${opts.hits.length - max} more` : "";
	return (
		`[interlinked:slow-test] Stopping with ${opts.hits.length} test(s) this session that ran ` +
		"slower than expected — a slow test can time out Stryker's mutation dry run (30s per-test " +
		`cap, vitest.stryker.config.ts) and poison kill-measurement for its whole file:\n${lines.join("\n")}${more}\n` +
		"Mock real subprocesses (execSync/spawn), switch real waits to vi.useFakeTimers(), and " +
		"shrink oversized fixtures/corpora. Source: this session's test-events feed " +
		"(.interlinked/test-events.jsonl, opt-in via INTERLINKED_VIZ=1) — a smell, not a defect; " +
		"this is a reflection nudge and never blocks."
	);
}

/** Stop-wiring entry point — same co-located pattern as
 *  `checkFixtureLeaks`/`checkDeadOnArrival`: `lifecycle-stop-warnings.ts`
 *  imports and calls this directly, so adding the nudge cost that near-cap
 *  file one import line and one call line. */
export function checkSlowTests(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	// Self-gating (config read lives here, not in the near-cap wiring file).
	if (ctx.rules.verification_stop_checks?.warn_slow_tests === false) return null;
	const cwd = event.cwd || ctx.cwd;
	const hits = detectSlowTests({ cwd, sessionStartedAt: session.started_at });
	const warning = formatSlowTestsWarning({ hits });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: slow-tests (${hits.length})`);
	return warning;
}
