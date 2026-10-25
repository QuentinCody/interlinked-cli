// Effect-based baseline integrity — judge what a tool call DID, not what its
// text looked like.
//
// Red-team F1 fixed the symptom (Bash could loosen a water-line) with a
// PreToolUse refusal. That gate reads INTENT: it parses command text, so it
// fails closed on everything it cannot statically resolve — computed paths,
// `$(...)`, an interpreter writing a path it built at runtime — and it refuses
// legitimate TIGHTENING from the shell, because pre-execution it cannot tell
// the two apart.
//
// The evidence exists ~200ms later, in the bytes on disk. This module snapshots
// the water-lines before a tool call and compares after, which gives four
// things the intent gate cannot:
//
//   1. DETECTION from real values — no parser to evade, and a tightening write
//      is provably distinguishable from a loosening one.
//   2. REVIEW MATERIAL — the pre-call bytes are kept for exact manual recovery.
//   3. OPTIONAL TRUSTED READ — `trustedBaselineValue` can serve pre-tamper
//      bytes to a consumer that uses it. Consumers reading disk directly can
//      still act on loosened values; detection is not universal enforcement.
//   4. PROPORTION — `effectIsReversible` classifies whether an effect can be
//      undone from material the harness holds. It USED to decide whether the
//      Bash arm refused at all (2026-08-10: "a recoverable file write should
//      never default-block"). The 2026-10-21 red team retracted that for
//      water-lines: the Bash arm now refuses every write to a water-line it
//      can read and uses this classification only to word the refusal
//      (baseline-bash-guard.ts).
//
// ENFORCEMENT — this arm is the CLASS guarantee (red team 2026-10-21, round 2).
// The PreToolUse Bash arm is a token scanner, and a shell has unbounded
// spellings (`bash -c`, `eval`, `xargs`, `find -exec`, `/bin/cp`, a directory
// destination, `cd .` hops, computed paths in python/node, `patch`, `tar -C`,
// `git apply` …), so verb lists cannot close the class; they only give the
// spellings they recognise an earlier, cheaper refusal. Before EVERY tool call
// this arm snapshots each water-line AND each blocking config water-line
// (tsconfig strictness, vitest/vite coverage denominator — config-effect-guard.ts).
// After the call, any file that got looser than its own pre-call bytes is
// RESTORED to those bytes at once, so no consumer (metric-caps.ts reads disk)
// ever decides with the loosened value past the end of the call. The restored
// bytes are the WHOLE pre-call file: a call that tightened one field and
// loosened another in the same file loses both changes (re-apply the
// tightening with the Edit tool, which the intent gate checks). A call that
// only tightened restores nothing. Every restore leaves an audit record under
// `.interlinked/baseline-undo/restored/`. Bypass, shared with the intent arms:
// INTERLINKED_DISABLE_BASELINE_GUARD=1 in the DAEMON env only (recorded, never
// restored); dry runs neither restore nor record. The command text is never a
// bypass: the gated agent writes it, so a word in it is not an operator's
// decision (red team 2026-10-21, round 3 — the earlier command-text bypass let
// the agent opt any shell call out of the restore by typing one assignment).
//
// RECORD-ONLY (warned and recorded, never restored), because a legitimate
// harness or CLI write is indistinguishable from a hand edit here:
//   - mutation-manifest.json — a mutation run (and the daemon's own PostToolUse
//     harvest) records new survivors, which the detector reads as additions to
//     the accepted set; 8 of the 9 undo records on file in this repo were runs.
//   - a function-complexity ledger change whose only findings sit in a metric
//     section absent before the call — the first `caps ratchet` seeding of a
//     second metric (function-complexity-baseline-gate.ts header).
//
// RESIDUALS (documented, not closed here):
//   - a write performed OUTSIDE any tool call's bracket (a background process
//     started by an earlier call, a `run_in_background` shell that writes after
//     its PostToolUse, a human terminal) is not compared against a pre-call
//     snapshot; the commit-gate backstop covers the tracked baselines. Such a
//     write landing INSIDE another call's bracket is attributed to that call.
//   - water-lines over MAX_SNAPSHOT_BYTES are not held, so not restored.
//   - creating an absent water-line is never a loosening against an absent
//     pre-call value.
//   - a branch switch / pull that brings a looser tracked water-line is
//     restored like any other loosening; use the bypass for an intended reset.
//
// NOT a trust boundary (feedback_local_checks_not_a_trust_boundary): an agent
// with filesystem access can rewrite the undo store too. What this buys is that
// gaming stops being one shell line, has to stay mutually consistent across two
// files, and is recorded where a human or the cloud tier can see it.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { resolveE2eBase } from "../e2e-store.js";
import { WATER_LINE_PATHS } from "./water-line-files.js";
import {
	BASELINE_RESTORE_PREFIX,
	captureConfigWaterLinesSafely,
	type ConfigSnapshot,
	detectConfigWaterLineLoosening,
} from "./config-effect-guard.js";

/** Water-line files, repo-relative — the shared guard set (water-line-files.ts). */
const BASELINE_FILES: readonly string[] = WATER_LINE_PATHS;

/** Where undo records live. One file per tool call that loosened a water-line. */
const UNDO_DIR = ".interlinked/baseline-undo";

/** Raw text of every water-line at one instant; absent files map to null. */
type BaselineSnapshot = Readonly<Record<string, string | null>>;

/** One water-line that a tool call loosened, with the bytes needed to undo it. */
interface BaselineLoosening {
	/** Repo-relative water-line path. */
	file: string;
	/** Exact pre-call bytes — the undo material. */
	beforeText: string;
	/** Exact post-call bytes, or null when the file was deleted. */
	afterText: string | null;
	/** Human-readable deltas from the shared gaming detector. */
	details: string[];
	/** True when the loosening is warned and recorded but never restored
	 *  (see RECORD-ONLY in the header). */
	recordOnly?: boolean;
}

/** Water-lines a legitimate run rewrites in the "looser" direction. */
const RECORD_ONLY_FILES: ReadonlySet<string> = new Set([".interlinked/mutation-manifest.json"]);
const LEDGER_FILE = ".interlinked/function-complexity-baseline.json";

/** Metric sections present in a ledger text (`metrics.<m>`). */
function ledgerSections(text: string): Set<string> {
	const parsed = parseOrNull(text);
	const metrics = isJsonObject(parsed) && isJsonObject(parsed.metrics) ? parsed.metrics : {};
	return new Set(Object.keys(metrics));
}

/** Record-only verdict for one detected loosening (header: RECORD-ONLY). */
function isRecordOnly(rel: string, beforeText: string, rules: readonly string[]): boolean {
	if (RECORD_ONLY_FILES.has(rel)) return true;
	if (rel !== LEDGER_FILE || rules.length === 0) return false;
	const existed = ledgerSections(beforeText);
	return rules.every((rule) => !existed.has(nonNull(rule.split(":")[0])));
}

/**
 * Largest water-line the effect arm will hold in memory.
 *
 * Measured the hard way 2026-08-10: `mutation-manifest.json` is 37 MB in this
 * repo, and snapshotting every water-line per tool call while holding up to
 * SNAPSHOT_CEILING of them drove the daemon into its RSS ceiling twice
 * (1917 MB, then 3229 MB) within minutes of the effect arm going live. Files
 * over this cap are skipped here; they are still covered by the intent gate
 * (PreToolUse) and, for tracked ones, the commit-gate backstop.
 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Read one file, or null when it is absent, unreadable, or too large to hold. */
function readOrNull(path: string): string | null {
	try {
		if (statSync(path).size > MAX_SNAPSHOT_BYTES) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Parse JSON, or null when the text is absent or malformed. */
function parseOrNull(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Snapshot every water-line's raw text. Bounded by MAX_SNAPSHOT_BYTES per
 *  file, so an oversized manifest can never be held per tool call. */
export function captureBaselines(root: string): BaselineSnapshot {
	const snap: Record<string, string | null> = {};
	for (const rel of BASELINE_FILES) snap[rel] = readOrNull(join(root, rel));
	return snap;
}

/**
 * Water-lines that got LOOSER between two snapshots.
 *
 * Values, not text: a reformat with identical numbers is silent, and a
 * tightening write is silent, because both are legitimate. Deletion counts as
 * a loosening — an absent water-line lets every ratchet decide unconstrained.
 */
export function detectBaselineLoosening(
	before: BaselineSnapshot,
	after: BaselineSnapshot,
	root?: string,
): BaselineLoosening[] {
	const out: BaselineLoosening[] = [];
	for (const rel of BASELINE_FILES) {
		const beforeText = before[rel] ?? null;
		const afterText = after[rel] ?? null;
		if (beforeText === null || beforeText === afterText) continue;

		if (afterText === null) {
			out.push({
				file: rel,
				beforeText,
				afterText: null,
				details: ["the water-line file was deleted — every ratchet reading it decides unconstrained"],
			});
			continue;
		}
		// The detector takes RAW TEXT (it parses internally) and reports
		// `message` — same pure function the intent gate uses, so both arms
		// agree on what "looser" means by construction.
		const context = root ? { root, base: resolveE2eBase() } : undefined;
		const findings = detectBaselineGaming(rel, beforeText, afterText, undefined, context);
		if (findings.length === 0) continue;
		const recordOnly = isRecordOnly(rel, beforeText, findings.map((f) => f.rule));
		out.push({ file: rel, beforeText, afterText, details: findings.map((f) => f.message), ...(recordOnly ? { recordOnly } : {}) });
	}
	return out;
}

/** Path of the undo record for one tool call. */
function undoPath(root: string, toolUseId: string): string {
	const safe = toolUseId.replace(/[^A-Za-z0-9_-]/g, "_");
	return join(root, UNDO_DIR, `${safe}.json`);
}

/** Shape persisted per tool call, so a later process can restore without state. */
interface UndoRecord {
	tool_use_id: string;
	entries: Array<{ file: string; beforeText: string }>;
}

/**
 * Persist the pre-call bytes so the change can be undone by id.
 *
 * Returns the record path, or null when nothing loosened (the common case, so
 * the hot path writes nothing).
 */
export function writeUndoRecord(
	root: string,
	toolUseId: string,
	loosenings: readonly BaselineLoosening[],
): string | null {
	if (loosenings.length === 0) return null;
	const record: UndoRecord = {
		tool_use_id: toolUseId,
		entries: loosenings.map((l) => ({ file: l.file, beforeText: l.beforeText })),
	};
	const path = undoPath(root, toolUseId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
	return path;
}

/** Read an undo record by id, or null when absent/unreadable. */
function loadUndoRecord(path: string): UndoRecord | null {
	const parsed = parseOrNull(readOrNull(path));
	if (!isJsonObject(parsed) || !Array.isArray(parsed.entries) || !parsed.entries.every(isUndoEntry)) return null;
	return { tool_use_id: typeof parsed.tool_use_id === "string" ? parsed.tool_use_id : "", entries: parsed.entries };
}

function isUndoEntry(value: unknown): value is UndoRecord["entries"][number] {
	return isJsonObject(value) && typeof value.file === "string" && typeof value.beforeText === "string";
}

/** Rewrite one water-line to its pre-call bytes. Reports failure rather than
 *  swallowing it — a silent failed restore is the worst outcome for an undo
 *  path, because the agent would believe the water-line was back. */
function restoreOne(root: string, entry: { file: string; beforeText: string }): boolean {
	const target = join(root, entry.file);
	try {
		mkdirSync(dirname(target), { recursive: true });
		// A symlink swapped in by the call is replaced, not written through:
		// writing through it would leave the water-line pointing at a file the
		// agent controls outside the snapshot set.
		if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target);
		writeFileSync(target, entry.beforeText);
		return true;
	} catch (err) {
		process.stderr.write(
			`[interlinked:baseline-effect] could not restore ${entry.file}: ${String(err)}\n`,
		);
		return false;
	}
}

/**
 * Put the pre-call bytes back for one tool call. Returns how many water-lines
 * were restored (0 when the id is unknown).
 *
 * The record is consumed only when EVERY entry was restored — a partial
 * restore keeps the override in force, so the ratchets stay on trusted values
 * for whatever could not be rewritten.
 */
export function restoreBaseline(root: string, toolUseId: string): number {
	const path = undoPath(root, toolUseId);
	const record = loadUndoRecord(path);
	if (!record) return 0;
	let restored = 0;
	for (const entry of record.entries) {
		if (restoreOne(root, entry)) restored += 1;
	}
	if (restored === record.entries.length) rmSync(path, { force: true });
	return restored;
}

/** Every pending undo record, oldest first. Absent dir = no tampering recorded. */
function pendingUndoRecords(root: string): UndoRecord[] {
	const dir = join(root, UNDO_DIR);
	if (!existsSync(dir)) return [];
	const out: UndoRecord[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".json")) continue;
		const rec = loadUndoRecord(join(dir, name));
		if (rec) out.push(rec);
	}
	return out;
}

/**
 * The value a ratchet should DECIDE with — the pre-tamper bytes when an
 * unreverted loosening is on record, else null ("trust the file on disk").
 *
 * Only callers using this helper receive the retained values. Direct disk
 * consumers remain affected by loosening. The EARLIEST record wins, so a chain of
 * loosenings cannot walk the water-line down one undo record at a time.
 */
export function trustedBaselineValue(root: string, relPath: string): string | null {
	for (const rec of pendingUndoRecords(root)) {
		const hit = rec.entries.find((e) => e.file === relPath);
		if (hit) return hit.beforeText;
	}
	return null;
}

/** Bash commands whose effect cannot be undone from anything we hold. */
const IRREVERSIBLE_BASH = [
	/\brm\s+-[a-zA-Z]*[rf]/, // recursive/forced delete
	/\bgit\s+push\b[^|;]*--force(?!-with-lease)/, // history overwrite
	/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, // discards working tree
	/\bcurl\b[^|;]*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE)/i, // network send
	/\b(npm|pnpm|yarn)\s+publish\b/, // published artifacts cannot be recalled
	/\b(shutdown|reboot|halt|poweroff)\b/,
	/\bdd\b[^|;]*\bof=/, // raw device/file overwrite
	/\b(mkfs|fdisk|diskutil\s+erase)/,
];

/**
 * Is a tool call's effect undoable from material the harness holds?
 *
 * Classification only. It no longer gates the water-line refusal: the
 * 2026-10-21 red team showed a "reversible" `cp` onto metric-caps.json left a
 * loosened cap live on disk for every later edit, because nothing on the
 * ratchet path reads the retained bytes. The Bash arm refuses both tiers and
 * uses this to say WHY — "cannot be undone" versus "cannot be inspected
 * before it runs" (baseline-bash-guard.ts).
 */
export function effectIsReversible(toolName: string, command: string): boolean {
	if (toolName !== "Bash") return true; // Write/Edit/MultiEdit: content is recoverable
	return !IRREVERSIBLE_BASH.some((re) => re.test(command));
}

/** Pre-call water-line snapshots, keyed by tool call. Bounded: entries are
 *  consumed at post-tool, and the map clears past a small ceiling so a runner
 *  that drops post-tool events cannot grow it without limit. */
const snapshots = new Map<string, { water: BaselineSnapshot; config: ConfigSnapshot }>();
const SNAPSHOT_CEILING = 64;

/**
 * The documented intentional-reset escape hatch, shared with the PreToolUse
 * arms (baseline-bash-guard.ts, baseline-integrity-gate.ts): the DAEMON's own
 * env and nothing else. The command text is deliberately not consulted — the
 * agent being gated writes it (header: ENFORCEMENT).
 */
function baselineGuardBypassed(): boolean {
	return process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1";
}

/** What a PostToolUse call site knows about the call it is closing. */
export interface BaselineEffectOptions {
	/** The shell command text, when the tool was a shell. Accepted from the
	 *  call sites but never read for the bypass: an assignment word in it is
	 *  agent-authored, so it cannot opt the call out of the restore. */
	command?: string | undefined;
	/** A dry run neither restores nor records (CLAUDE.md: a dry run must not move the gate). */
	dryRun?: boolean | undefined;
}

/** Identity pairing a call's two phases: the runner's id, else session+time. */
export function baselineCallKey(opts: {
	toolUseId?: string | undefined;
	sessionId: string;
	timestamp: string;
}): string {
	return opts.toolUseId ?? `${opts.sessionId}:${opts.timestamp}`;
}

/** Snapshot the water-lines before a call runs (the "before" half). */
export function rememberBaselineSnapshot(key: string, root: string): void {
	if (snapshots.size > SNAPSHOT_CEILING) snapshots.clear();
	snapshots.set(key, { water: captureBaselines(root), config: captureConfigWaterLinesSafely(root, readOrNull) });
}

/**
 * Close one call: compare every water-line and config water-line with its
 * pre-call snapshot and RESTORE the pre-call bytes of each loosened file
 * (header: ENFORCEMENT). Returns the agent-facing message — starting with
 * BASELINE_RESTORE_PREFIX when anything was restored — or null when nothing
 * loosened (the common case: one map lookup plus the small snapshot reads).
 */
export function consumeBaselineSnapshot(
	key: string,
	root: string,
	opts: BaselineEffectOptions = {},
): string | null {
	const before = snapshots.get(key);
	snapshots.delete(key);
	if (!before || opts.dryRun) return null;
	const warnings: string[] = [];
	const loosenings: BaselineLoosening[] = [
		...detectBaselineLoosening(before.water, captureBaselines(root), root),
		...detectConfigWaterLineLoosening(root, before.config, readOrNull, warnings),
	];
	if (loosenings.length === 0) return warnings.length > 0 ? warnings.join("\n") : null;
	if (baselineGuardBypassed()) {
		writeUndoRecord(root, key, loosenings);
		return `${buildLooseningWarning(key, loosenings)}\nNot restored: INTERLINKED_DISABLE_BASELINE_GUARD=1 in the daemon environment (intentional reset).`;
	}
	const restorable = loosenings.filter((l) => !l.recordOnly);
	const recordOnly = loosenings.filter((l) => l.recordOnly);
	const messages: string[] = [...warnings];
	if (restorable.length > 0) messages.push(restoreLoosenings(root, key, restorable));
	if (recordOnly.length > 0) {
		writeUndoRecord(root, `${key}.record-only`, recordOnly);
		messages.push(buildLooseningWarning(key, recordOnly));
	}
	return messages.join("\n");
}

/**
 * Put back the pre-call bytes of every restorable loosening. The pending undo
 * record is written FIRST, so a daemon that dies mid-restore leaves the prior
 * values on record; it is reduced to the failed entries afterwards (and gone
 * when all succeeded), and the audit record keeps the whole story.
 */
function restoreLoosenings(root: string, key: string, loosenings: readonly BaselineLoosening[]): string {
	writeUndoRecord(root, key, loosenings);
	const failed = loosenings.filter((l) => !restoreOne(root, l));
	if (failed.length === 0) rmSync(undoPath(root, key), { force: true });
	else writeUndoRecord(root, key, failed);
	const audit = join(dirname(undoPath(root, key)), "restored", `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
	try {
		mkdirSync(dirname(audit), { recursive: true });
		const entries = loosenings.map((l) => ({ ...l, restored: !failed.includes(l) }));
		writeFileSync(audit, `${JSON.stringify({ tool_use_id: key, restored_at: new Date().toISOString(), entries }, null, 2)}\n`);
	} catch (err) {
		process.stderr.write(`[interlinked:baseline-effect] could not write restore audit ${audit}: ${String(err)}\n`);
	}
	return buildRestoreMessage(key, loosenings, failed, relative(root, audit));
}

/** The loud agent-facing report of a restore: file, field, before→after, why. */
function buildRestoreMessage(
	key: string,
	loosenings: readonly BaselineLoosening[],
	failed: readonly BaselineLoosening[],
	auditRel: string,
): string {
	const lines = loosenings.map((l) => `  ${l.file}${failed.includes(l) ? " (RESTORE FAILED)" : ""}: ${l.details.join("; ")}`);
	const failure = failed.length
		? `\n${failed.length} file(s) could NOT be restored; their prior values stay on record for review — restore them by hand.`
		: "";
	const restoration = failed.length === 0
		? "The pre-call bytes are back on disk: ratchet water-lines may only tighten, so the gates keep deciding " +
			"with the prior values. The WHOLE pre-call file was restored — re-apply any tightening in it with the Edit tool. "
		: "The failed water-lines remain unrestored; their retained prior values require manual recovery before the gates can use them. ";
	return (
		`${BASELINE_RESTORE_PREFIX} ${loosenings.length - failed.length} of ${loosenings.length} water-line(s) ` +
		`this tool call loosened (call ${key}):\n${lines.join("\n")}${failure}\n` +
		restoration +
		"Meet the bar instead of moving it; intentional reset: INTERLINKED_DISABLE_BASELINE_GUARD=1. " +
		`Audit: ${auditRel}`
	);
}

/** Agent-facing report for a detected loosening, naming the one-command undo. */
export function buildLooseningWarning(
	toolUseId: string,
	loosenings: readonly BaselineLoosening[],
): string {
	const lines = loosenings.map((l) => `  ${l.file}: ${l.details.join("; ")}`);
	return (
		`[interlinked:baseline-effect] this tool call LOOSENED ${loosenings.length} ratchet ` +
		`water-line(s):\n${lines.join("\n")}\n` +
		"Pre-call values were retained for review. Some consumers may still read the loosened files; " +
		"gate protection is not guaranteed. Review this call's diff and restore the exact prior values " +
		`in the named files. No automatic restore command is available (call ${toolUseId}).`
	);
}
