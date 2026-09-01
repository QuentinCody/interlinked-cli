// ===========================================
// Stop digest — signal-ranked end-of-turn report
// ===========================================
// The Stop hook grew ~20 independent nudge families, each individually
// reasonable and each printing in full. On 2026-08-16 that produced a 43KB
// wall whose ONE actionable item — five 5000ms sleeps that would have voided a
// mutation measurement — sat below cross-attributed fleet-agent files,
// re-printed pre-existing findings, and sanctioned scratch-probe prints. A
// report nobody finishes reading is a report that did not run.
//
// This module is the last stage of the Stop path. It takes every warning
// string the Stop branch produced and emits a bounded, ranked digest:
//
//   TOP        up to MAX_TOP_ITEMS warnings, printed in full (each capped at
//              MAX_LINES_PER_TOP_ITEM lines), ordered actionable-first.
//   SUMMARY    one line per remaining category: tag, count, nothing else.
//   POINTER    one line naming the spool that holds everything trimmed.
//
// Ranking is by the `[interlinked:<tag>]` prefix every warning already
// carries, so adding a nudge family costs one table entry, not a rewrite.
// Three tiers, in the order a reader should care:
//
//   0 ACTIONABLE       a defect or broken state introduced this session.
//   1 MEASUREMENT      timing/flake shapes that VOID a measurement — the class
//                      that was buried, and the reason this module exists.
//   2 REFLECTION       counts, cadence, and churn. Real, but never urgent.
//
// Nothing here blocks and nothing is deleted: trimmed content goes to
// `.interlinked/stop-digest.jsonl` (per-session capped) and every check still
// reports in full through `interlinked verify`.

import { join } from "node:path";

import {
	appendStopDigestSpool,
	loadStopDigestState,
	priorSnapshot,
	recordStopDigestState,
	type StopDigestSpoolRow,
} from "./stop-digest-state.js";

const LF = String.fromCharCode(10);

/** Hard ceiling on stderr lines the whole digest may occupy. */
export const STOP_DIGEST_LINE_BUDGET = 15;

/** Warnings printed in full before the rest collapse to counts. */
const MAX_TOP_ITEMS = 3;

/** Lines any single top item may occupy before it is truncated to the spool. */
const MAX_LINES_PER_TOP_ITEM = 4;

/** Turn-end churn nudges below this count are dropped entirely: one re-read or
 *  one re-edit is normal work, and saying so every turn is pure noise. Only a
 *  HIGH count is information. */
const CHURN_MIN_COUNT = 2;

/** The one string every digest ends with, so trimmed detail stays findable. */
export const SPOOL_POINTER = ".interlinked/stop-digest.jsonl";

/** Tag bucket for a warning that carries no `[interlinked:*]` prefix. */
const OTHER_TAG = "other";

/** Reflection-only churn family — collapsed into one line, and only above
 *  {@link CHURN_MIN_COUNT}. Two separate low-value lines (re-read + edit
 *  churn) is what the operator was actually looking past. */
const CHURN_TAG = "turn-end";

/** Families that NEVER occupy a top slot, however quiet the Stop is. Their
 *  body carries no instruction the count line does not already give: "you
 *  re-read files" and "a file was edited 4+ times" are one fact about churn,
 *  and the operator asked for them as one line. */
const SUMMARY_ONLY_TAGS: ReadonlySet<string> = new Set([CHURN_TAG]);

/** Tier 0 — a defect or broken state this session introduced. Fix before
 *  stopping. */
const ACTIONABLE_TAGS: ReadonlySet<string> = new Set([
	"stop-rescan",
	"debt-evasion",
	"spec-drift",
	"commit-gate",
	"effect-residue",
	"content-quality",
	"disputed-ground",
]);

/** Tier 1 — shapes that make a MEASUREMENT untrustworthy. A sleep-laden test
 *  run, a flaky suite, or a stale baseline means the numbers a later decision
 *  rests on were never real. */
const MEASUREMENT_TAGS: ReadonlySet<string> = new Set([
	"slow-test",
	"flake",
	"flake-calibrator",
	"mutation-kill-evidence",
	"mutation",
	"fixture-leak",
	"baseline-staleness",
	"coverage",
]);

/**
 * The `[interlinked:<tag>]` bucket a warning belongs to. The prefix must open
 * the string: a tag mentioned mid-sentence is prose, not provenance.
 */
export function warningTag(warning: string): string {
	const match = /^\[interlinked:([a-z0-9_-]+)\]/.exec(warning);
	return match?.[1] ?? OTHER_TAG;
}

/** 0 = actionable, 1 = measurement-threatening, 2 = reflection. */
function tierOf(tag: string): number {
	if (ACTIONABLE_TAGS.has(tag)) return 0;
	if (MEASUREMENT_TAGS.has(tag)) return 1;
	return 2;
}

/** Cap one warning to {@link MAX_LINES_PER_TOP_ITEM} lines, naming the spool
 *  when it had to cut. */
function truncateItem(warning: string): { text: string; trimmedLines: number } {
	const lines = warning.split(LF);
	if (lines.length <= MAX_LINES_PER_TOP_ITEM) return { text: warning, trimmedLines: 0 };
	const kept = lines.slice(0, MAX_LINES_PER_TOP_ITEM - 1);
	const trimmed = lines.length - kept.length;
	return {
		text: [...kept, `  ...+${trimmed} line(s) → ${SPOOL_POINTER}`].join(LF),
		trimmedLines: trimmed,
	};
}

interface Category {
	tag: string;
	tier: number;
	warnings: string[];
	/** Position of the first member in the original order — a stable tiebreak
	 *  so equal-tier categories keep the Stop path's own emission order. */
	firstIndex: number;
}

/** Bucket warnings by tag, preserving first-seen order within each bucket. */
function categorize(warnings: readonly string[]): Category[] {
	const order: string[] = [];
	const members = new Map<string, string[]>();
	warnings.forEach((w) => {
		const tag = warningTag(w);
		const list = members.get(tag);
		if (list === undefined) {
			order.push(tag);
			members.set(tag, [w]);
			return;
		}
		list.push(w);
	});
	return order
		.map((tag, firstIndex) => ({
			tag,
			tier: tierOf(tag),
			warnings: members.get(tag) ?? [],
			firstIndex,
		}))
		.sort((a, b) => a.tier - b.tier || a.firstIndex - b.firstIndex);
}

/** Drop categories that carry no signal at their observed count. Today only
 *  the churn family qualifies; it is a list, not a special case, so the next
 *  low-value family is one entry rather than another branch. */
function isBelowFloor(category: Category): boolean {
	return category.tag === CHURN_TAG && category.warnings.length < CHURN_MIN_COUNT;
}

interface TopSelection {
	/** Full-text lines for the items that earned the top of the digest. */
	lines: string[];
	/** Stderr lines those items consume. */
	lineCount: number;
	/** Categories that must collapse to a count line instead. */
	demoted: Category[];
}

/** Choose the items printed in full. `categories` arrives sorted by tier, so
 *  the slots fill actionable-first and a reflection nudge only reaches the top
 *  of a QUIET Stop, where printing it costs nothing and hiding it would lose
 *  the whole message. A category whose head is shown but which has MORE
 *  members is also demoted, so its remaining count still gets a line. */
function selectTopItems(categories: readonly Category[]): TopSelection {
	const lines: string[] = [];
	const demoted: Category[] = [];
	let lineCount = 0;
	for (const category of categories) {
		const item = truncateItem(category.warnings[0] ?? "");
		const cost = item.text.split(LF).length;
		const eligible =
			lines.length < MAX_TOP_ITEMS &&
			!SUMMARY_ONLY_TAGS.has(category.tag) &&
			lineCount + cost <= STOP_DIGEST_LINE_BUDGET - 1;
		if (!eligible) {
			demoted.push(category);
			continue;
		}
		lines.push(item.text);
		lineCount += cost;
		if (category.warnings.length > 1) demoted.push(category);
	}
	return { lines, lineCount, demoted };
}

interface BuildStopDigestArgs {
	/** Every warning string the Stop branch produced, in emission order. */
	warnings: readonly string[];
	cwd: string;
	sessionId: string;
	/** Defaults to `<cwd>/.interlinked`. */
	interlinkedDir?: string | undefined;
	dryRun?: boolean | undefined;
	now?: Date;
}

/** Spool rows for everything the digest did not print in full. */
function buildSpoolRows(categories: readonly Category[]): StopDigestSpoolRow[] {
	const rows: StopDigestSpoolRow[] = [];
	for (const c of categories) {
		for (const w of c.warnings) {
			rows.push({ kind: "stop-warning", tag: c.tag, tier: c.tier, text: w });
		}
	}
	return rows;
}

/**
 * Rank, cap, and spool one Stop's warnings. Returns the strings to write to
 * stderr — never more than {@link STOP_DIGEST_LINE_BUDGET} lines in total.
 * An empty input returns an empty array, so a clean Stop stays silent.
 */
export function buildStopDigest(args: BuildStopDigestArgs): string[] {
	if (args.warnings.length === 0) return [];
	const interlinkedDir = args.interlinkedDir ?? join(args.cwd, ".interlinked");
	const categories = categorize(args.warnings).filter((c) => !isBelowFloor(c));
	if (categories.length === 0) return [];

	const top = selectTopItems(categories);
	const out = [...top.lines];
	let lineCount = top.lineCount;

	// Everything else becomes ONE line per category: tag and count, no body.
	// The body is in the spool; repeating it here is what built the wall.
	for (const category of top.demoted) {
		if (lineCount >= STOP_DIGEST_LINE_BUDGET - 1) break;
		const count = category.warnings.length;
		out.push(
			`[interlinked:digest] ${category.tag}${count > 1 ? ` x${count}` : ""} (see ${SPOOL_POINTER})`,
		);
		lineCount++;
	}

	out.push(
		`[interlinked:digest] ${args.warnings.length} stop signal(s) this turn; full detail → ${SPOOL_POINTER}`,
	);

	const prior = priorSnapshot(loadStopDigestState(interlinkedDir), args.sessionId);
	const spooled = appendStopDigestSpool({
		interlinkedDir,
		sessionId: args.sessionId,
		rows: buildSpoolRows(categories),
		alreadySpooled: prior?.spooled ?? 0,
		dryRun: args.dryRun,
		...(args.now ? { now: args.now } : {}),
	});
	// Tags only — `openIds` is omitted so the rescan's fingerprints, written
	// earlier in this same Stop, survive untouched.
	recordStopDigestState({
		interlinkedDir,
		sessionId: args.sessionId,
		tags: categories.map((c) => c.tag),
		spooledDelta: spooled,
		dryRun: args.dryRun,
		...(args.now ? { now: args.now } : {}),
	});

	return out;
}
