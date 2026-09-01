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
//   2. REVERSIBILITY — the pre-call bytes are kept, so the agent gets a
//      one-command undo instead of having to reconstruct a baseline by hand.
//   3. INERTNESS — `trustedBaselineValue` serves the pre-tamper value to the
//      ratchets, so a loosening has no effect even before it is reverted. This
//      is the channel-independent half: it does not matter whether the write
//      came from Bash, an editor, or a background process.
//   4. PROPORTION — `effectIsReversible` names the rule for when a
//      pre-execution block is justified at all: only when the effect cannot be
//      undone afterwards. A recoverable file write should never default-block;
//      `rm -rf`, a force push and a network send must, because no amount of
//      post-hoc evidence brings the bytes back.
//
// NOT a trust boundary (feedback_local_checks_not_a_trust_boundary): an agent
// with filesystem access can rewrite the undo store too. What this buys is that
// gaming stops being one shell line, has to stay mutually consistent across two
// files, and is recorded where a human or the cloud tier can see it.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { WATER_LINE_PATHS } from "./water-line-files.js";

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
		const findings = detectBaselineGaming(rel, beforeText, afterText);
		if (findings.length === 0) continue;
		out.push({ file: rel, beforeText, afterText, details: findings.map((f) => f.message) });
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
	if (!parsed || typeof parsed !== "object") return null;
	const rec = parsed as Partial<UndoRecord>;
	if (!Array.isArray(rec.entries)) return null;
	return { tool_use_id: rec.tool_use_id ?? "", entries: rec.entries };
}

/** Rewrite one water-line to its pre-call bytes. Reports failure rather than
 *  swallowing it — a silent failed restore is the worst outcome for an undo
 *  path, because the agent would believe the water-line was back. */
function restoreOne(root: string, entry: { file: string; beforeText: string }): boolean {
	const target = join(root, entry.file);
	try {
		mkdirSync(dirname(target), { recursive: true });
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
 * This is what makes a loosening inert rather than merely detected, and it is
 * channel-independent: it does not care whether Bash, an editor, or a
 * background process wrote the file. The EARLIEST record wins, so a chain of
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
 * The rule this encodes: **a pre-execution block is justified only when the
 * effect is irreversible.** A recoverable file write should be observed and
 * reversed, not refused — refusing it costs real work and, as the intent gate
 * showed, also refuses the legitimate tightening case. An unrecoverable effect
 * has no post-hoc remedy, so it must be stopped before it runs.
 */
export function effectIsReversible(toolName: string, command: string): boolean {
	if (toolName !== "Bash") return true; // Write/Edit/MultiEdit: content is recoverable
	return !IRREVERSIBLE_BASH.some((re) => re.test(command));
}

/** Pre-call water-line snapshots, keyed by tool call. Bounded: entries are
 *  consumed at post-tool, and the map clears past a small ceiling so a runner
 *  that drops post-tool events cannot grow it without limit. */
const snapshots = new Map<string, BaselineSnapshot>();
const SNAPSHOT_CEILING = 64;

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
	snapshots.set(key, captureBaselines(root));
}

/**
 * Compare against the remembered snapshot, persist the undo material, and
 * return the agent-facing warning — or null when nothing loosened (the common
 * case, which costs one map lookup plus nine small reads).
 */
export function consumeBaselineSnapshot(key: string, root: string): string | null {
	const before = snapshots.get(key);
	snapshots.delete(key);
	if (!before) return null;
	const loosenings = detectBaselineLoosening(before, captureBaselines(root));
	if (loosenings.length === 0) return null;
	writeUndoRecord(root, key, loosenings);
	return buildLooseningWarning(key, loosenings);
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
		"The pre-call values are still in force — the ratchets decide with them, so the change " +
		"has no effect on any gate. Undo it with: " +
		`interlinked baseline restore ${toolUseId}\n` +
		"If the loosening was intentional (a deliberate reset), keep it and re-record the " +
		"water-line through the harness so the override is released."
	);
}
