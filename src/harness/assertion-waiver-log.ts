// ===========================================
// Assertion-removal campaign waiver ledger
// ===========================================
// GATE 2 (mutation_directed_assertion_removal, evaluator/mutation-directed-
// guard.ts) blocks an edit that deletes kill evidence from a mutation-directed
// test file. A test-consolidation campaign legitimately deletes hundreds of
// such lines, and a file-level verify-suppressions.json entry per file is the
// wrong grain for that. INTERLINKED_ASSERTION_MOVE_WAIVER=1 turns the block
// into an ALLOW that leaves a trace: every waived removal is appended to
// `.interlinked/assertion-waivers.jsonl` with file, line, assertion text and
// session id, so the campaign is auditable line by line afterwards.
//
// The waiver is honored only when the ledger write succeeds — a waiver that
// loses its receipt is indistinguishable from evidence going missing, which
// is the exact failure GATE 2 exists to catch. A dry run (`interlinked
// harness test`, HarnessEvent.dry_run) reports success WITHOUT writing: the
// verdict is computed as the real edit would see it, and no ledger row is
// left behind (CLAUDE.md, "A dry run must not move the gate").
//
// SCOPE OF THE FLAG: it is read from the DAEMON's process.env (the same
// precedent as INTERLINKED_DISABLE_BASELINE_GUARD). The hook does not forward
// the agent's shell environment to the event, so `VAR=1 <one tool call>` in
// the agent's shell does nothing — export it in the daemon's environment and
// (re)start the daemon (`interlinked harness restart`), or in the
// `interlinked harness test` shell, which evaluates in-process.
//
// REDEMPTION (cross-call moves): Claude Code sends ONE file per PreToolUse
// call, so a cross-file move is two calls — the removal (waived, one pending
// row per line) and, later, the addition. The addition call matches its
// introduced assertion lines against this session's pending rows by the same
// equivalence key checks/assertion-move.ts uses and appends a `redeemed_by`
// row per match, so the audit reads "moved to <file>" instead of "waived".
// Redemption is bookkeeping only: it never changes a verdict, and it cannot
// make the FIRST call pass without the waiver.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { InlineMatch } from "./check-registry/types.js";
import { partitionMovedAssertions } from "./checks/assertion-move.js";
import { REMOVED_ASSERTION_CHECK_ID } from "./checks/mutation-directed-profile.js";

/** Campaign escape hatch, read from the daemon's environment (see the module
 *  header: not per-command). `1` only — no other truthy spelling. */
export const ASSERTION_WAIVER_ENV = "INTERLINKED_ASSERTION_MOVE_WAIVER";

/** Ledger file name under `<projectRoot>/.interlinked/`. */
export const ASSERTION_WAIVER_LOG = "assertion-waivers.jsonl";

/** Public API — the ledger row shape `interlinked query
 *  .interlinked/assertion-waivers.jsonl` consumers read back. */
export interface AssertionWaiverRecord {
	ts: string;
	session_id: string;
	rule_id: string;
	file: string;
	line: number;
	/** The removed line's text (already trimmed/truncated by GATE 2). */
	assertion: string;
	/** Present on a REDEMPTION row only: the file whose later same-session
	 *  edit introduced an equivalent assertion. `file`/`line`/`assertion`
	 *  repeat the pending row they redeem; `ts` is the redemption time. */
	redeemed_by?: string;
}

/** Boundary parser for one ledger line read back from disk — a CONSTRUCTED
 *  record or null (foreign or truncated lines are skipped, never trusted). */
function parseWaiverRecord(text: string): AssertionWaiverRecord | null {
	let row: unknown;
	try {
		row = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isJsonObject(row)) return null;
	const { ts, session_id, rule_id, file, line, assertion, redeemed_by } = row;
	if (typeof session_id !== "string" || typeof file !== "string" || typeof assertion !== "string") return null;
	if (typeof line !== "number") return null;
	const rec: AssertionWaiverRecord = {
		ts: typeof ts === "string" ? ts : "",
		session_id,
		rule_id: typeof rule_id === "string" ? rule_id : REMOVED_ASSERTION_CHECK_ID,
		file,
		line,
		assertion,
	};
	if (typeof redeemed_by === "string") rec.redeemed_by = redeemed_by;
	return rec;
}

/** Identity of a pending row: a newline separator cannot occur inside a
 *  single JSONL line's fields once parsed from one line. */
function pendingKey(r: AssertionWaiverRecord): string {
	return `${r.file}\n${r.line}\n${r.assertion}`;
}

/**
 * This session's waived removals that no later row has redeemed, in ledger
 * order. Absent or unreadable ledger ⇒ [] (redemption is bookkeeping, never a
 * verdict, so a read failure costs nothing but the audit trail).
 */
function pendingWaivedRemovals(opts: { projectRoot: string; sessionId: string }): AssertionWaiverRecord[] {
	const path = join(opts.projectRoot, ".interlinked", ASSERTION_WAIVER_LOG);
	let raw: string;
	try {
		raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
	} catch {
		return [];
	}
	const pending = new Map<string, AssertionWaiverRecord>();
	for (const line of raw.split("\n")) {
		const rec = line.trim() ? parseWaiverRecord(line) : null;
		if (!rec || rec.session_id !== opts.sessionId) continue;
		if (rec.redeemed_by) pending.delete(pendingKey(rec));
		else pending.set(pendingKey(rec), rec);
	}
	return [...pending.values()];
}

/**
 * The second call of a cross-file move: match the assertion lines `addingFile`
 * INTRODUCES against this session's pending waived removals (same equivalence
 * key as a same-edit move) and append one `redeemed_by` row per match.
 * Returns the redeemed rows, or [] when nothing matched or the append failed;
 * a dry run returns the matches without writing.
 */
export function redeemWaivedRemovals(opts: {
	projectRoot: string;
	sessionId: string;
	addingFile: string;
	added: InlineMatch[];
	dryRun: boolean | undefined;
	clock?: () => number;
}): AssertionWaiverRecord[] {
	if (opts.added.length === 0) return [];
	const pending = pendingWaivedRemovals(opts);
	if (pending.length === 0) return [];
	const byLine = new Map(pending.map((p) => [{ line: p.line, text: p.assertion }, p] as const));
	const { moved } = partitionMovedAssertions([...byLine.keys()], opts.added);
	const ts = new Date((opts.clock ?? Date.now)()).toISOString();
	const redeemed = moved.flatMap((m) => {
		const p = byLine.get(m);
		return p ? [{ ...p, ts, redeemed_by: opts.addingFile }] : [];
	});
	if (redeemed.length === 0 || !appendAssertionWaivers(opts.projectRoot, redeemed, opts.dryRun)) return [];
	return redeemed;
}

/** True when the campaign waiver is switched on for this process. */
export function assertionMoveWaiverActive(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[ASSERTION_WAIVER_ENV] === "1";
}

/** One ledger row per removed line. Split from the appender so callers can
 *  build-and-inspect without touching disk. */
export function buildAssertionWaiverRecords(opts: {
	filePath: string;
	removed: InlineMatch[];
	sessionId: string;
	/** Injected clock (epoch ms); tests pass a fixed value. */
	clock?: () => number;
}): AssertionWaiverRecord[] {
	const ts = new Date((opts.clock ?? Date.now)()).toISOString();
	return opts.removed.map((m) => ({
		ts,
		session_id: opts.sessionId,
		rule_id: REMOVED_ASSERTION_CHECK_ID,
		file: opts.filePath,
		line: m.line,
		assertion: m.text,
	}));
}

/**
 * Append the records to `<projectRoot>/.interlinked/assertion-waivers.jsonl`.
 * Returns true when every record is durably appended, or when `dryRun` is set
 * (nothing may persist, but the waiver verdict still stands). Returns false
 * when the `.interlinked` directory is absent or the append throws — the
 * caller must then fall back to the block.
 */
export function appendAssertionWaivers(
	projectRoot: string,
	records: AssertionWaiverRecord[],
	dryRun: boolean | undefined,
): boolean {
	if (dryRun) return true;
	try {
		const dir = join(projectRoot, ".interlinked");
		if (!existsSync(dir)) return false;
		const body = records.map((r) => `${JSON.stringify(r)}\n`).join("");
		appendFileSync(join(dir, ASSERTION_WAIVER_LOG), body);
		return true;
	} catch {
		return false;
	}
}
