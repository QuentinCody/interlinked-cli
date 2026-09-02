// Review-finding reconciliation (docs/design/spec-audit-runtime-checks.md
// §4): an append-only sidecar txn log tracking what happened to each
// ingested review finding — touched by an edit, or explicitly acked with a
// reason. The findings corpus stays pristine (it records WHAT was found);
// this log records what the session DID about it. Deterministic fold, the
// reservations edge-defined-once discipline: one txn union, one apply.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";

type ReconciliationState = "open" | "touched" | "acked";

interface ReconciliationTxn {
	finding_id: string;
	action: "touched" | "acked" | "reopened" | "reanchored";
	/** Session (touch) or actor (ack) attribution. */
	by: string;
	reason?: string;
	/** Repo-relative file whose edit produced a touch. */
	file?: string;
	/** New 1-based anchor line (reanchor txns — `findings verify --write`). */
	line?: number;
	ts: string;
}

const SIDECAR_REL = join(".interlinked", "findings", "reconciliation.jsonl");

export function reconciliationPath(cwd: string): string {
	return join(cwd, SIDECAR_REL);
}

/** "\n" when the file exists and lacks a trailing newline (a torn tail),
 *  else "". Prevents concatenating a new txn onto a malformed last line
 *  (round-2 #10). */
function tornTailPrefix(path: string): string {
	if (!existsSync(path)) return "";
	try {
		const buf = readFileSync(path);
		return buf.length > 0 && buf[buf.length - 1] !== 0x0a ? "\n" : "";
	} catch {
		return "";
	}
}

export function appendReconciliationTxn(cwd: string, txn: ReconciliationTxn): void {
	const path = reconciliationPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${tornTailPrefix(path)}${JSON.stringify(txn)}\n`);
}

/** One finding's folded state. */
interface ReconciliationEntry {
	state: ReconciliationState;
	last_txn?: ReconciliationTxn;
}

function applyTxn(
	current: ReconciliationEntry | undefined,
	txn: ReconciliationTxn,
): ReconciliationEntry {
	if (txn.action === "reopened") return { state: "open", last_txn: txn };
	if (txn.action === "acked") return { state: "acked", last_txn: txn };
	// A reanchor is ledger maintenance, not progress: the state is untouched
	// (nothing auto-closes — LG-6's remap-to-keep-true, never remap-to-apply).
	if (txn.action === "reanchored") return { state: current?.state ?? "open", last_txn: txn };
	// A touch never downgrades an ack — the human's decision stands.
	if (current?.state === "acked") return current;
	return { state: "touched", last_txn: txn };
}

/** Parse one sidecar line; null for malformed/torn lines (append-only logs
 *  tolerate torn tails — the fold simply skips them). */
const VALID_ACTIONS = new Set(["touched", "acked", "reopened", "reanchored"]);

/**
 * Type/shape validation — a bad `action` must NOT silently fold to "touched"
 * and falsely close a finding (round-2 #9).
 *
 * Returns a CONSTRUCTED txn rather than asserting `txn is ReconciliationTxn`,
 * so the compiler checks the literal against the interface: adding a required
 * field fails to compile here instead of going unvalidated. The predecessor
 * predicate never checked `ts` (found by `type_predicate_drift`), so a row
 * without it narrowed to a full txn and the fold read `.ts` as `undefined`.
 * Every writer goes through `appendReconciliationTxn`, which takes a fully
 * typed txn, so no on-disk row is lost to this tightening.
 */
/** finding_id/action/by/ts are the txn's required, always-present fields. */
function hasValidRequiredShape(
	finding_id: unknown,
	action: unknown,
	by: unknown,
	ts: unknown,
): boolean {
	if (typeof finding_id !== "string" || finding_id.length === 0) return false;
	if (typeof action !== "string" || !VALID_ACTIONS.has(action)) return false;
	if (typeof by !== "string") return false;
	if (typeof ts !== "string") return false;
	return true;
}

/** reason/file/line are optional — absent is valid, present-but-wrong-typed is not. */
function hasValidOptionalShape(reason: unknown, file: unknown, line: unknown): boolean {
	if (reason !== undefined && typeof reason !== "string") return false;
	if (file !== undefined && typeof file !== "string") return false;
	if (line !== undefined && typeof line !== "number") return false;
	return true;
}

/** Constructed as a literal (not asserted) so the compiler checks it against
 *  `ReconciliationTxn` — see the parseTxn doc comment above. */
function buildTxn(
	finding_id: string,
	action: ReconciliationTxn["action"],
	by: string,
	ts: string,
	reason: unknown,
	file: unknown,
	line: unknown,
): ReconciliationTxn {
	return {
		finding_id,
		action,
		by,
		ts,
		...(reason !== undefined ? { reason: reason as string } : {}),
		...(file !== undefined ? { file: file as string } : {}),
		...(line !== undefined ? { line: line as number } : {}),
	};
}

function parseTxn(value: unknown): ReconciliationTxn | null {
	if (!isJsonObject(value)) return null;
	const { finding_id, action, by, reason, file, line, ts } = value;
	if (!hasValidRequiredShape(finding_id, action, by, ts)) return null;
	if (!hasValidOptionalShape(reason, file, line)) return null;
	return buildTxn(
		finding_id as string,
		action as ReconciliationTxn["action"],
		by as string,
		ts as string,
		reason,
		file,
		line,
	);
}

/** Parse one sidecar line; null for malformed/torn or semantically invalid. */
function parseTxnLine(line: string): ReconciliationTxn | null {
	try {
		return parseTxn(JSON.parse(line));
	} catch {
		return null;
	}
}

/** Fold the sidecar into finding_id → state. Missing file = everything open. */
export function loadReconciliation(cwd: string): Map<string, ReconciliationEntry> {
	const out = new Map<string, ReconciliationEntry>();
	const path = reconciliationPath(cwd);
	if (!existsSync(path)) return out;
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Advisory state: an unreadable sidecar folds to "everything open".
		return out;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const txn = parseTxnLine(line);
		if (txn) out.set(txn.finding_id, applyTxn(out.get(txn.finding_id), txn));
	}
	return out;
}

/** State for one finding (open when never mentioned in the log). */
export function reconciliationStateOf(
	map: Map<string, ReconciliationEntry>,
	findingId: string,
): ReconciliationState {
	return map.get(findingId)?.state ?? "open";
}
