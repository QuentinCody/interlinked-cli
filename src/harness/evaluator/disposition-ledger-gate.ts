// ===========================================
// Disposition-ledger monotonicity detector (plan 18 M0, §4.2)
// ===========================================
// A sibling of baseline-integrity-gate.ts, kept separate ONLY because that file
// sits at the 500-line cap. Wired INTO it (detectBaselineGaming delegates here
// for the ledger path; the event entry point lets the ledger path through its
// early guard), so it rides the EXISTING `baseline_integrity_gate` rule — no new
// rule, no registry entry, no new per-edit latency. The commit-gate backstop
// reaches it the same way (it calls detectBaselineGaming per tracked baseline).
//
// A disposition is an agent-writable record that removes a survivor from the
// work-list (§1.4 proved this is an open gaming surface today). So the ledger is
// monotonic under the same water-line discipline every other ratchet uses —
// except the tightening direction is FEWER / WEAKER records, not a bigger number:
//
//   record removed            → allow  (re-opens work; always safe)
//   suppressionLevel lowered  → allow  (weakening a claim is safe)
//   record ADDED              → block  (records enter only via the store's fs write)
//   suppressionLevel RAISED   → block  (the upgrade move)
//   symbolHash rewritten      → block  (resurrects a stale record — a rebind)
//   certificate/approval sub-object added or altered → block  (manufacturing evidence)
//
// The harness's own writes go through saveLedger's internal fs call (never the
// Write/Edit tools), so they never reach this detector — the same exemption every
// ratchet raise relies on. Pure JSON diff; no execution, no model.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { parseDisposition } from "../mutation/disposition.js";
import { type SuppressionLevel, suppressionLevel } from "../mutation/disposition-store.js";
import { safeJsonParse } from "./config-loosening-gate.js";

/** Structurally identical to baseline-integrity-gate's `BaselineGamingFinding` so
 *  the delegation there returns these directly. Declared here to keep the import
 *  edge one-directional (that file imports this one, never the reverse). */
interface DispositionLedgerFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

const LEDGER_RE = /(?:^|\/)\.interlinked\/mutation-dispositions\.json$/;

/** Is this the committed disposition ledger? */
export function isDispositionLedgerPath(filePath: string): boolean {
	return LEDGER_RE.test(filePath.replace(/\\/g, "/"));
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Index the ledger's records by (file, symbolId, mutantId). Unkeyable rows are
 *  dropped — loadLedger would drop them too, so they suppress nothing. */
function recordsByKey(parsed: unknown): Map<string, JsonObject> {
	const out = new Map<string, JsonObject>();
	const arr = isJsonObject(parsed) && Array.isArray(parsed.records) ? parsed.records : [];
	for (const r of arr) {
		if (!isJsonObject(r)) continue;
		const file = str(r.file);
		const symbolId = str(r.symbolId);
		const mutantId = str(r.mutantId);
		if (!file || !symbolId || !mutantId) continue;
		out.set(`${file} ${symbolId} ${mutantId}`, r);
	}
	return out;
}

/** Level of a raw (untrusted) disposition. Unparseable ⇒ 0 (the weakest): a
 *  disposition mangled into garbage suppresses nothing once loadLedger drops it,
 *  which is weakening, not gaming. A well-formed ADD is caught by the add check. */
function rawLevel(rawDisposition: unknown): SuppressionLevel {
	const parsed = parseDisposition(rawDisposition);
	return parsed ? suppressionLevel(parsed) : 0;
}

/** A stable signature of the credential sub-objects a disposition may carry. In
 *  M0 no recordable kind has one, so any non-empty signature is manufactured. */
function credentialSig(record: JsonObject): string {
	const d = isJsonObject(record.disposition) ? record.disposition : {};
	const cert = d.certificate ?? null;
	const approval = d.approval ?? null;
	if (cert === null && approval === null) return "";
	return JSON.stringify({ cert, approval });
}

function finding(file: string, rule: string, before: unknown, after: unknown, message: string): DispositionLedgerFinding {
	return { file, rule, before, after, message };
}

/** Compare one surviving (present-in-both) record for a tightening→loosening move. */
function diffExistingRecord(file: string, key: string, before: JsonObject, after: JsonObject): DispositionLedgerFinding[] {
	const out: DispositionLedgerFinding[] = [];
	const bHash = str(before.symbolHash);
	const aHash = str(after.symbolHash);
	if (bHash && aHash && bHash !== aHash) {
		out.push(
			finding(
				file,
				`disposition-rebind:${key}`,
				bHash,
				aHash,
				`disposition record ${key} had its symbolHash rewritten ${bHash}→${aHash}. That resurrects a stale record against code it was never judged against — a rebind, not an edit. Re-record it through \`interlinked mutation disposition\`.`,
			),
		);
	}
	const bLevel = rawLevel(before.disposition);
	const aLevel = rawLevel(after.disposition);
	if (aLevel > bLevel) {
		out.push(
			finding(
				file,
				`disposition-raised:${key}`,
				bLevel,
				aLevel,
				`disposition record ${key} had its suppression strengthened (level ${bLevel}→${aLevel}). Records enter or strengthen only via the store's internal write; a hand-edit that raises suppression silences the work-list. Weakening is allowed; strengthening is not.`,
			),
		);
	}
	const bCred = credentialSig(before);
	const aCred = credentialSig(after);
	if (aCred !== "" && aCred !== bCred) {
		out.push(
			finding(
				file,
				`disposition-credential:${key}`,
				bCred || null,
				aCred,
				`disposition record ${key} gained or altered a certificate/approval sub-object. Evidence artifacts are minted by a verifier, never hand-written into the ledger.`,
			),
		);
	}
	return out;
}

/**
 * Public API — pure detector for a proposed edit to the disposition ledger.
 * Returns [] for a non-ledger path, a brand-new ledger (creation is not
 * loosening), unparseable JSON, or a safe-direction move (removal / weakening).
 * A hand-ADDED record, a raised suppression, a symbolHash rebind, or a
 * manufactured credential each yields a finding.
 */
export function detectDispositionLedger(filePath: string, beforeText: string, afterText: string): DispositionLedgerFinding[] {
	if (!isDispositionLedgerPath(filePath)) return [];
	if (!beforeText) return []; // new ledger — creating it is not loosening
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (before === null || after === null) return []; // fail open on unparseable JSON

	const beforeMap = recordsByKey(before);
	const afterMap = recordsByKey(after);
	const out: DispositionLedgerFinding[] = [];
	for (const [key, afterRec] of afterMap) {
		const beforeRec = beforeMap.get(key);
		if (!beforeRec) {
			out.push(
				finding(
					filePath,
					`disposition-added:${key}`,
					undefined,
					key,
					`disposition record ${key} was hand-added to the ledger. New records enter only via \`interlinked mutation disposition\` (an internal fs write that bypasses this gate); a hand-add silences the survivor work-list. Records may be removed or weakened by hand, never added.`,
				),
			);
			continue;
		}
		out.push(...diffExistingRecord(filePath, key, beforeRec, afterRec));
	}
	return out;
}
