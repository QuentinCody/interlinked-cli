// ===========================================
// Stop-rescan signal filter
// ===========================================
// The Stop rescan re-runs every inline detector over every file the session
// touched. That is the right SCAN and the wrong REPORT: a 2026-08-16 Stop wall
// ran to 43KB, and its one actionable item was buried under three classes of
// noise this module removes, in order:
//
//   1. CROSS-ATTRIBUTED FILES. A subagent's writes land in the parent's
//      `files_written` (see stop-actor-attribution.ts), so the main actor was
//      told to fix files it never opened. Files a subagent demonstrably wrote
//      collapse to ONE summary line; anything unattributable stays in the main
//      list, because hiding a real finding is the expensive error.
//   2. PRE-EXISTING FINDINGS. The rescan is a WHOLE-FILE scan, so a one-line
//      edit re-printed every legacy finding in the file. Filtered to
//      introduced-only against the session's git baseline, reusing
//      pre-block-gate.ts's `splitIntroduced` — the identical multiset-over-
//      normalized-line-text semantics the write gates already use, so the two
//      surfaces cannot drift on what "introduced" means. Repo policy still
//      asks for touched files to be left clean
//      ([[feedback_fix_pre_existing_in_touched_files]]) and `interlinked
//      verify` still reports the rest; this is about what a STOP WALL says.
//   3. SANCTIONED PROBE PATTERNS. A print statement in `scratch/` is the
//      pattern the scratchpad policy deliberately steers agents toward
//      (CLAUDE.md "Scratch work placement"), so flagging it at Stop punishes
//      compliance. Those classes are dropped there — and ONLY there. They stay
//      fully visible in `interlinked verify --all-checks`, which is the
//      deep-audit surface where a probe's hygiene is actually in scope.
//
// Then the repeat-Stop delta: a second Stop prints only what is NEW since the
// previous one, plus one line stating how many rows resolved and how many are
// unchanged-and-suppressed. Everything filtered out is spooled to
// `.interlinked/stop-digest.jsonl`, so this is relocation, never deletion.

import { join } from "node:path";

import { isRepoScratchPath } from "./large-file-policy.js";
import { splitIntroduced } from "./pre-block-gate.js";
import type { SubagentAttribution } from "./stop-actor-attribution.js";
import {
	appendStopDigestSpool,
	diffAgainstLastStop,
	fingerprintFinding,
	loadStopDigestState,
	priorSnapshot,
	recordStopDigestState,
	type StopDigestSpoolRow,
} from "./stop-digest-state.js";

/**
 * Finding classes that are the SANCTIONED probe pattern under `scratch/`.
 * A probe script prints, runs at import time, and has no companion test — that
 * is what a probe IS. Dropped from the Stop rescan for scratch paths only;
 * `interlinked verify --all-checks` still reports every one of them.
 */
export const SANCTIONED_SCRATCH_CHECKS: ReadonlySet<string> = new Set([
	"ubs_print_debug_leak",
	"no_test_file",
	"top_level_side_effect",
	"json_parse_unsafe",
]);

/** Files listed in full before the main list collapses to a count. */
const MAX_FILES_LISTED = 3;

/** Findings listed per file before the rest become a count. */
const MAX_FINDINGS_PER_FILE = 4;

/** The shape this module consumes. Structurally satisfied by
 *  `PatternRescanFinding` — declared locally so the dependency runs one way
 *  (stop-rescan.ts imports THIS module, never the reverse). */
export interface RescanFindingLike {
	file: string;
	checkId: string;
	line: number;
	text: string;
	deferred: boolean;
	deferReason: string | null;
}

interface DigestStopRescanArgs {
	findings: readonly RescanFindingLike[];
	cwd: string;
	sessionId: string;
	/** Defaults to `<cwd>/.interlinked`. */
	interlinkedDir?: string;
	dryRun?: boolean | undefined;
	/** Baseline detector run for one file, for introduced-only filtering.
	 *  Returns null when no baseline exists (new file / no git anchor), which
	 *  degrades STRICTLY: every finding counts as introduced, matching
	 *  pre-block-gate.ts's own no-baseline rule. */
	scanBaseline?: ((relFile: string) => RescanFindingLike[] | null) | undefined;
	/** Subagent→file attribution; absent ⇒ nothing is re-attributed. */
	attribution?: SubagentAttribution | undefined;
	now?: Date;
}

interface StopRescanDigest {
	/** Warning strings for stderr — already collapsed and capped. */
	warnings: string[];
	/** Fingerprints open at this Stop (the next Stop's diff baseline). */
	openIds: string[];
	/** Detail rows appended to the spool. */
	spoolRows: StopDigestSpoolRow[];
}

/** Group findings by file, preserving encounter order. */
function groupByFile(
	findings: readonly RescanFindingLike[],
): Map<string, RescanFindingLike[]> {
	const byFile = new Map<string, RescanFindingLike[]>();
	for (const f of findings) {
		const list = byFile.get(f.file) ?? [];
		list.push(f);
		byFile.set(f.file, list);
	}
	return byFile;
}

/** True when this finding is the sanctioned probe pattern in `scratch/`. */
function isSanctionedScratchFinding(f: RescanFindingLike, cwd: string): boolean {
	if (!SANCTIONED_SCRATCH_CHECKS.has(f.checkId)) return false;
	return isRepoScratchPath(f.file.replace(/\\/g, "/"), cwd);
}

/** Drop findings the git baseline already carried. `splitIntroduced` keys on
 *  normalized line TEXT, so a pure line-number shift stays pre-existing. */
function keepIntroduced(
	fileFindings: readonly RescanFindingLike[],
	baseline: readonly RescanFindingLike[],
): RescanFindingLike[] {
	const byCheck = new Map<string, RescanFindingLike[]>();
	for (const b of baseline) {
		const list = byCheck.get(b.checkId) ?? [];
		list.push(b);
		byCheck.set(b.checkId, list);
	}
	const kept: RescanFindingLike[] = [];
	for (const [checkId, current] of groupByCheck(fileFindings)) {
		const base = byCheck.get(checkId) ?? [];
		const { introduced } = splitIntroduced(
			current.map((f) => ({ line: f.line, text: f.text })),
			base.map((f) => ({ line: f.line, text: f.text })),
		);
		const introducedKeys = new Set(introduced.map((m) => `${m.line} ${m.text}`));
		for (const f of current) {
			if (introducedKeys.has(`${f.line} ${f.text}`)) kept.push(f);
		}
	}
	return kept;
}

function groupByCheck(
	findings: readonly RescanFindingLike[],
): Map<string, RescanFindingLike[]> {
	const byCheck = new Map<string, RescanFindingLike[]>();
	for (const f of findings) {
		const list = byCheck.get(f.checkId) ?? [];
		list.push(f);
		byCheck.set(f.checkId, list);
	}
	return byCheck;
}

interface PartitionResult {
	/** Files the MAIN actor is accountable for. */
	main: Map<string, RescanFindingLike[]>;
	/** Files a subagent wrote, collapsed to a summary. */
	subagentFiles: Map<string, RescanFindingLike[]>;
	/** Distinct subagent ids implicated. */
	subagents: Set<string>;
	spoolRows: StopDigestSpoolRow[];
}

/** Filters 3 then 2 for ONE file: drop the sanctioned probe pattern under
 *  `scratch/`, then drop what the git baseline already carried. Every drop is
 *  spooled, so filtering relocates detail rather than deleting it. */
function survivingFindings(opts: {
	file: string;
	all: readonly RescanFindingLike[];
	args: DigestStopRescanArgs;
}): { kept: RescanFindingLike[]; rows: StopDigestSpoolRow[] } {
	const { file, all, args } = opts;
	const rows: StopDigestSpoolRow[] = [];
	const afterScratch = all.filter((f) => {
		if (!isSanctionedScratchFinding(f, args.cwd)) return true;
		rows.push({ kind: "sanctioned-scratch", file, check: f.checkId, line: f.line });
		return false;
	});
	if (afterScratch.length === 0) return { kept: [], rows };
	const baseline = args.scanBaseline?.(file) ?? null;
	const kept = baseline === null ? afterScratch : keepIntroduced(afterScratch, baseline);
	const keptSet = new Set(kept);
	for (const dropped of afterScratch) {
		if (keptSet.has(dropped)) continue;
		rows.push({ kind: "pre-existing", file, check: dropped.checkId, line: dropped.line });
	}
	return { kept, rows };
}

/** Spool one row per finding on a subagent-attributed file — the detail the
 *  main list's single summary line points at. */
function subagentSpoolRows(opts: {
	file: string;
	kept: readonly RescanFindingLike[];
	owners: readonly string[];
}): StopDigestSpoolRow[] {
	return opts.kept.map((f) => ({
		kind: "subagent-attributed",
		file: opts.file,
		check: f.checkId,
		line: f.line,
		text: f.text,
		agents: [...opts.owners],
	}));
}

/** Apply the three noise filters and split the survivors by actor. */
function partitionFindings(args: DigestStopRescanArgs): PartitionResult {
	const spoolRows: StopDigestSpoolRow[] = [];
	const main = new Map<string, RescanFindingLike[]>();
	const subagentFiles = new Map<string, RescanFindingLike[]>();
	const subagents = new Set<string>();

	for (const [file, all] of groupByFile(args.findings)) {
		const { kept, rows } = survivingFindings({ file, all, args });
		spoolRows.push(...rows);
		if (kept.length === 0) continue;
		const owners = ownersOf(file, args.attribution);
		if (owners.length === 0) {
			main.set(file, kept);
			continue;
		}
		subagentFiles.set(file, kept);
		for (const a of owners) subagents.add(a);
		spoolRows.push(...subagentSpoolRows({ file, kept, owners }));
	}
	return { main, subagentFiles, subagents, spoolRows };
}

/** Subagent ids that wrote `file`, matching on the recorded path or its
 *  suffix (the timeline records absolute paths; the rescan reports relative
 *  ones). Empty ⇒ unattributable ⇒ the file stays with the main actor. */
function ownersOf(file: string, attribution: SubagentAttribution | undefined): string[] {
	if (attribution === undefined) return [];
	const direct = attribution.byFile.get(file);
	if (direct !== undefined) return direct;
	const norm = file.replace(/\\/g, "/");
	for (const [recorded, agents] of attribution.byFile) {
		const rec = recorded.replace(/\\/g, "/");
		if (rec === norm || rec.endsWith(`/${norm}`) || norm.endsWith(`/${rec}`)) return agents;
	}
	return [];
}

/** One collapsed block per file: up to MAX_FINDINGS_PER_FILE lines, then a
 *  count. Deferred rows never list individually — they are already
 *  acknowledged, so a count is the whole signal. */
function formatFileBlock(file: string, findings: readonly RescanFindingLike[]): string {
	const open = findings.filter((f) => !f.deferred);
	const deferred = findings.filter((f) => f.deferred);
	const shown = open.slice(0, MAX_FINDINGS_PER_FILE);
	const lines = shown.map((f) => `    ${f.checkId}:${f.line} — ${f.text}`);
	if (open.length > shown.length) {
		lines.push(`    ...and ${open.length - shown.length} more (see stop-digest.jsonl)`);
	}
	if (deferred.length > 0) {
		lines.push(`    (${deferred.length} acknowledged-deferred, not escalated)`);
	}
	const head = `  ${file} — ${open.length} introduced finding(s)`;
	return open.length === 0
		? `  ${file} — ${deferred.length} acknowledged-deferred finding(s)`
		: [head, ...lines].join(String.fromCharCode(10));
}

/**
 * Filter, attribute, diff and format one Stop's rescan findings. Persists this
 * Stop's fingerprints and spool rows (both no-ops under `dryRun`).
 */
export function digestStopRescan(args: DigestStopRescanArgs): StopRescanDigest {
	const interlinkedDir = args.interlinkedDir ?? join(args.cwd, ".interlinked");
	const { main, subagentFiles, subagents, spoolRows } = partitionFindings(args);

	const openIds = [...main.values()].flat().map(fingerprintFinding);
	const prior = priorSnapshot(loadStopDigestState(interlinkedDir), args.sessionId);
	const delta = diffAgainstLastStop(prior, openIds);
	const newIds = new Set(delta.newIds);

	const warnings: string[] = [];
	const freshBlocks: string[] = [];
	for (const [file, findings] of main) {
		const fresh = findings.filter((f) => newIds.has(fingerprintFinding(f)));
		if (fresh.length > 0) freshBlocks.push(formatFileBlock(file, fresh));
	}
	if (freshBlocks.length > 0) {
		const shown = freshBlocks.slice(0, MAX_FILES_LISTED);
		const overflow =
			freshBlocks.length > shown.length
				? [`  ...and ${freshBlocks.length - shown.length} more file(s) — see stop-digest.jsonl`]
				: [];
		warnings.push(
			[
				`[interlinked:stop-rescan] ${freshBlocks.length} file(s) you touched carry findings introduced this session:`,
				...shown,
				...overflow,
				"Fix them, or add `// interlinked: defer <check-id> -- <reason>` to acknowledge.",
			].join(String.fromCharCode(10)),
		);
	}
	if (delta.resolved > 0 || delta.unchanged > 0) {
		warnings.push(
			`[interlinked:stop-rescan] ${delta.resolved} resolved, ${delta.unchanged} unchanged (suppressed) since the previous stop.`,
		);
	}
	if (subagentFiles.size > 0) {
		const open = [...subagentFiles.values()].flat().length;
		warnings.push(
			`[interlinked:stop-rescan] ${subagentFiles.size} file(s) touched by ${subagents.size} subagent(s) carry ${open} open finding(s) — details: .interlinked/stop-digest.jsonl`,
		);
	}

	const spooled = appendStopDigestSpool({
		interlinkedDir,
		sessionId: args.sessionId,
		rows: spoolRows,
		alreadySpooled: prior?.spooled ?? 0,
		dryRun: args.dryRun,
		...(args.now ? { now: args.now } : {}),
	});
	recordStopDigestState({
		interlinkedDir,
		sessionId: args.sessionId,
		openIds,
		tags: [],
		spooledDelta: spooled,
		dryRun: args.dryRun,
		...(args.now ? { now: args.now } : {}),
	});

	return { warnings, openIds, spoolRows };
}
