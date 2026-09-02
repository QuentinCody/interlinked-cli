// ===========================================
// Function-complexity ledger integrity detector (sibling of baseline-integrity-gate.ts)
// ===========================================
// `.interlinked/function-complexity-baseline.json` is the per-function
// grandfather ledger the two complexity write gates consult
// (src/harness/function-complexity-baseline.ts). Like every other water-line it
// is agent-writable, so a hand-edit that ADDS an entry, RAISES an entry's
// recorded value, or RAISES a metric cap pre-authorizes complexity the ratchet
// was meant to burn down. Direction per field:
//
//   metrics.<m>.cap          → may only TIGHTEN (fall)
//   metrics.<m>.entries[i]   → value may only FALL; an entry may be REMOVED
//   entries list             → SHRINK-ONLY, with ONE admission: when the cap
//                              tightens in the same change, a function whose
//                              value lies in (newCap, oldCap] may enter — that
//                              is exactly what `caps ratchet` writes, and it
//                              pre-authorizes nothing the old cap did not allow
//   a whole metric section   → may be removed, or added EMPTY (cap only)
//   the file itself          → created ONLY by `caps ratchet` (internal write)
//
// The admission rule is what keeps the EFFECT arm (baseline-effect-guard.ts)
// quiet on a legitimate `interlinked caps ratchet` run from the shell: the
// ratchet adds only functions the tightening newly put over the cap, so the
// same detector that blocks a hand-added entry reads the ratchet's own write as
// a tightening. (The first section for a metric has no old cap, so its entries
// still read as additions — one warning on the first seeding of a second
// metric, documented in caps-ratchet.ts.)
//
// Kept as a sibling module because baseline-integrity-gate.ts sits at the
// 500-line cap (the same reason disposition-ledger-gate.ts exists). The ledger
// is a WATER_LINE_FILES stem (water-line-files.ts), so baseline-integrity-gate
// dispatches here through KIND_MAP and the bash / effect / replay arms cover
// the file like every other water-line. `detectSiblingBaseline` /
// `isSiblingBaselinePath` remain the seam for the disposition ledger, which is
// NOT a water-line. The ratchet's own regeneration goes through
// `saveFunctionComplexityBaseline` (internal fs), never the edit tools.

import { isJsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import { COMPLEXITY_METRICS, type ComplexityMetric } from "../function-complexity-baseline.js";
import { safeJsonParse } from "./config-loosening-gate.js";
import { detectDispositionLedger, isDispositionLedgerPath } from "./disposition-ledger-gate.js";

/** Structurally identical to baseline-integrity-gate's `BaselineGamingFinding`
 *  so the delegation there returns these directly (import edge stays one-way). */
export interface LedgerFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

const LEDGER_RE = /(?:^|\/)\.interlinked\/function-complexity-baseline\.json$/;

/** Is this the committed per-function complexity grandfather ledger? */
export function isFunctionComplexityBaselinePath(filePath: string): boolean {
	return LEDGER_RE.test(filePath.replace(/\\/g, "/"));
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** Values recorded per (file, name), sorted descending — same-named entries
 *  (collisions / anonymous callbacks) compare rank-by-rank. Non-numeric values
 *  are dropped, never string-compared. */
function valuesByKey(section: unknown): Map<string, number[]> {
	const out = new Map<string, number[]>();
	const entries = isJsonObject(section) && Array.isArray(section.entries) ? section.entries : [];
	for (const raw of entries) {
		if (!isJsonObject(raw) || typeof raw.file !== "string" || typeof raw.name !== "string") continue;
		if (!isNum(raw.value)) continue;
		const key = `${raw.file}:${raw.name}`;
		const list = out.get(key) ?? [];
		list.push(raw.value);
		out.set(key, list);
	}
	for (const list of out.values()) list.sort((a, b) => b - a);
	return out;
}

function capFinding(file: string, metric: ComplexityMetric, b: unknown, a: unknown): LedgerFinding | null {
	const bCap = isJsonObject(b) ? b.cap : undefined;
	const aCap = isJsonObject(a) ? a.cap : undefined;
	if (!isNum(bCap) || !isNum(aCap) || aCap <= bCap) return null;
	return {
		file,
		rule: `${metric}:cap`,
		before: bCap,
		after: aCap,
		message: `function-complexity ${metric} cap raised ${bCap}→${aCap}. A complexity cap may only tighten — use \`interlinked caps ratchet ${metric} --to <n>\` with a smaller n.`,
	};
}

/** The old cap when THIS change tightens the section's cap, else null. A new
 *  entry may enter only under a tightening, and only at a value the old cap
 *  already allowed (≤ oldCap) — the ratchet's own admission rule. */
function tighteningFrom(b: unknown, a: unknown): number | null {
	const bCap = isJsonObject(b) ? b.cap : undefined;
	const aCap = isJsonObject(a) ? a.cap : undefined;
	return isNum(bCap) && isNum(aCap) && aCap < bCap ? bCap : null;
}

/** Findings for one (file:name) key: rank-wise raises and additions. */
function keyFindings(
	file: string,
	metric: ComplexityMetric,
	key: string,
	before: number[],
	after: number[],
	admitUpTo: number | null,
): LedgerFinding[] {
	const out: LedgerFinding[] = [];
	for (let i = 0; i < after.length; i++) {
		const av = after[i];
		const bv = before[i];
		if (av === undefined) continue;
		if (bv === undefined) {
			if (admitUpTo !== null && av <= admitUpTo) continue; // newly over the tightened cap
			out.push({
				file,
				rule: `${metric}:grandfather-new:${key}`,
				before: undefined,
				after: av,
				message: `new ${metric} grandfather entry ${key}=${av}. That pre-authorizes an over-cap function — entries enter only via \`interlinked caps ratchet\` (internal write); decompose the function instead.`,
			});
		} else if (av > bv) {
			out.push({
				file,
				rule: `${metric}:grandfather:${key}`,
				before: bv,
				after: av,
				message: `${metric} grandfather value for ${key} raised ${bv}→${av}. A grandfathered function may shrink or hold, never grow.`,
			});
		}
	}
	return out;
}

function sectionFindings(file: string, metric: ComplexityMetric, b: unknown, a: unknown): LedgerFinding[] {
	const out: LedgerFinding[] = [];
	const cap = capFinding(file, metric, b, a);
	if (cap) out.push(cap);
	const before = valuesByKey(b);
	const admitUpTo = tighteningFrom(b, a);
	for (const [key, after] of valuesByKey(a)) {
		out.push(...keyFindings(file, metric, key, before.get(key) ?? [], after, admitUpTo));
	}
	return out;
}

/**
 * Pure detector: the loosening findings for a proposed edit to the ledger.
 * Empty for a brand-new ledger (no before text), unparseable JSON on either
 * side, a non-object shape, or any tightening-direction move.
 */
export function detectFunctionComplexityBaseline(
	filePath: string,
	beforeText: string,
	afterText: string,
): LedgerFinding[] {
	if (!beforeText) return [];
	const before = safeJsonParse(beforeText);
	const after = safeJsonParse(afterText);
	if (!isJsonObject(before) || !isJsonObject(after)) return [];
	const bMetrics = isJsonObject(before.metrics) ? before.metrics : {};
	const aMetrics = isJsonObject(after.metrics) ? after.metrics : {};
	const out: LedgerFinding[] = [];
	for (const metric of COMPLEXITY_METRICS) {
		out.push(...sectionFindings(filePath, metric, bMetrics[metric], aMetrics[metric]));
	}
	return out;
}

/**
 * Block for a Write that CREATES the ledger. No ledger means legacy delta
 * semantics, so a hand-written first ledger pre-authorizes whatever it lists —
 * creation is a loosening for this file specifically, unlike the other
 * water-lines (a fresh metric-caps.json can only tighten). Only `caps ratchet`
 * creates it, through the internal writer.
 */
export function ledgerCreationBlock(filePath: string): HarnessDecision {
	return {
		decision: "block",
		reason:
			`BLOCKED: ${filePath} does not exist yet, and the per-function complexity ledger is created only by ` +
			"`interlinked caps ratchet <cyclomatic|cognitive> --to <n>` (an internal write). A hand-written first " +
			"ledger pre-authorizes every function it lists. Run the ratchet instead, or set " +
			"INTERLINKED_DISABLE_BASELINE_GUARD=1 for an intentional reset.",
		rule_id: "baseline_integrity_gate",
		severity: "high",
		category: "config",
	};
}

// ---- the delegation seam baseline-integrity-gate.ts calls --------------------

/** A ledger guarded by a sibling detector (outside WATER_LINE_FILES): today the
 *  disposition ledger only — the complexity ledger is a water-line stem. */
export function isSiblingBaselinePath(filePath: string): boolean {
	return isDispositionLedgerPath(filePath);
}

/** Dispatch a non-water-line path to its sibling detector (empty when none). */
export function detectSiblingBaseline(filePath: string, beforeText: string, afterText: string): LedgerFinding[] {
	return detectDispositionLedger(filePath, beforeText, afterText);
}
