// ===========================================
// Obligation ledger — file I/O (.interlinked/obligations.jsonl)
// ===========================================
// The thin fs adapter over the pure engine in `obligations.ts`: append a
// transition, or read the append-only log and net it to the currently-open
// coverage debts. Total / fail-open — a missing, torn, or unusable ledger reads
// as "no debts" and a failed append is swallowed; bookkeeping must never crash
// the harness (same contract as `coverage-obligation-ledger.ts`).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Obligation as OrphanCandidate } from "./obligations.js";
import {
	METRIC_DESCRIPTORS,
	type Obligation,
	type ObligationTxn,
	obligationId,
	openObligations,
	parseObligationTxn,
	replayObligations,
} from "./obligations.js";

const LEDGER = join(".interlinked", "obligations.jsonl");

function ledgerPath(projectRoot: string): string {
	return join(projectRoot, LEDGER);
}

/** Append one transition to the ledger. Best-effort; a failed write is swallowed. */
export function appendDebtTxn(projectRoot: string, txn: ObligationTxn): void {
	const path = ledgerPath(projectRoot);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(txn)}\n`, "utf-8");
	} catch {
		// intentional: a failed ledger write must not crash the harness.
	}
}

/** Every parsed transition in the ledger, in append order — the raw history
 *  the `interlinked debt show` inspection renders. Total — a missing /
 *  unreadable ledger reads as no transitions, and a torn / foreign line is
 *  skipped (fail-open, same contract as `readOpenDebts`). */
export function readDebtTxns(projectRoot: string): ObligationTxn[] {
	const path = ledgerPath(projectRoot);
	if (!existsSync(path)) return [];
	try {
		const raw = readFileSync(path, "utf-8");
		const txns: ObligationTxn[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const parsed = parseObligationTxn(safeJsonParse(line));
			if (parsed) txns.push(parsed);
		}
		return txns;
	} catch {
		return []; // unreadable (e.g. the path is a directory) → fail-open
	}
}

/** True when a transition belongs to `file`'s obligations: an `open` names the
 *  file directly; a `discharge`/`escalate` carries only the obligation id, so
 *  it matches when the id is `kind:file` (file-level), `kind:file:start-end`
 *  (region-level), or either form suffixed `#detector` (transient) for any
 *  registered kind — derived via `obligationId`, never re-parsed by hand. */
function txnTouchesFile(txn: ObligationTxn, file: string): boolean {
	if (txn.op === "open") return txn.file === file;
	for (const { kind } of Object.values(METRIC_DESCRIPTORS)) {
		const base = obligationId(kind, file);
		if (txn.id === base || txn.id.startsWith(`${base}:`) || txn.id.startsWith(`${base}#`)) {
			return true;
		}
	}
	return false;
}

/** The full transition history for ONE file's obligations, in append order —
 *  what `interlinked debt show <file>` prints. */
export function readDebtTxnsForFile(projectRoot: string, file: string): ObligationTxn[] {
	return readDebtTxns(projectRoot).filter((txn) => txnTouchesFile(txn, file));
}

/** The currently-open pair-scoped debts (coverage + red_suite — the two kinds
 *  the per-edit wander rule enforces), netted over the append-only log. Total —
 *  a missing / unreadable / torn ledger reads as no debts (fail-open). */
export function readOpenDebts(projectRoot: string): Obligation[] {
	const state = replayObligations(readDebtTxns(projectRoot));
	return [...openObligations(state, "coverage"), ...openObligations(state, "red_suite")];
}

/**
 * The currently-open `transient` debts this session can act on.
 *
 * Deliberately a SEPARATE reader from `readOpenDebts`: transient debt must
 * never feed the coverage/red-suite WIP rule (different teeth, different
 * relatedness), and coverage debt must never be discharged by a tsc overlay.
 * Same fail-open contract.
 *
 * Session-scoped for the same reason `readDischargeableDebts` is: a debt is
 * cleared by a later edit re-running the checker, so a debt another session
 * opened is undischargeable by anything THIS session does — blocking on one is
 * a permanent stop with no action that resolves it. Observed live on landing:
 * a parallel session in this repo had a TS2304 debt two strikes deep, which
 * would have blocked an unrelated session's next edit. Omitting the session id
 * keeps the unscoped view for reporting surfaces.
 */
export function readOpenTransientDebts(projectRoot: string, sessionId?: string): Obligation[] {
	const all = openObligations(replayObligations(readDebtTxns(projectRoot)), "transient");
	return sessionId ? all.filter((d) => !d.sessionId || d.sessionId === sessionId) : all;
}

/** Every filename a session may leave behind. A session writes `.live.json`
 *  and `.trajectory.json` while running; older builds wrote a bare `<id>.json`.
 *  Probing only the bare form marks CURRENTLY RUNNING sessions as gone. */
const SESSION_ARTIFACT_SUFFIXES = [".json", ".live.json", ".trajectory.json"] as const;

/**
 * A debt whose owning session left no trace on disk at all.
 *
 * Lives in the harness layer, not `commands/debt.ts`, because both the reporter
 * and the write gate need it and the harness must never import from the command
 * layer.
 *
 * Probes every artifact shape a session can leave. The original predicate
 * checked only `<id>.json`, which current builds do not write — so it reported
 * the RUNNING session's own debts as orphaned. Verified 2026-07-27: the live
 * session had `.live.json` and `.trajectory.json` and no bare `.json`.
 */
export function isOrphanedDebt(projectRoot: string, debt: OrphanCandidate): boolean {
	if (!debt.sessionId) return false;
	const dir = join(projectRoot, ".interlinked", "sessions");
	return !SESSION_ARTIFACT_SUFFIXES.some((sfx) => existsSync(join(dir, `${debt.sessionId}${sfx}`)));
}

/**
 * Open debts the CURRENT session can actually discharge.
 *
 * A debt is cleared only by its own session's subsequent green run, so a debt
 * opened by a different session is undischargeable by anything this session
 * does — blocking on one is a permanent stop with no action that resolves it.
 * That is the failure mode that left two debts open for 28 hours after the
 * failure they described was fixed (2026-07-26).
 *
 * Session identity rather than artifact liveness: a `.trajectory.json` persists
 * long after its session ends, so "a file exists" cannot tell a live session
 * from a finished one. Debts with no session id are keepable by anyone.
 *
 * Cross-session debts are not lost — `interlinked debt list` still reports
 * them, and `debt resolve` still closes them. They just stop blocking a session
 * that has no way to satisfy them.
 */
export function readDischargeableDebts(projectRoot: string, currentSessionId?: string): Obligation[] {
	return readOpenDebts(projectRoot).filter(
		(d) => !d.sessionId || !currentSessionId || d.sessionId === currentSessionId,
	);
}

function safeJsonParse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null; // torn line → null, which parseObligationTxn rejects
	}
}
