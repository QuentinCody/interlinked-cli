// Ledger trailer line(s) for a per-function metric gate's block message.
// Extracted out of per-function-metric-gate.ts (which sits at the 500-line
// module cap) so `buildMetricBlock` stays a one-line call site.

import { ledgerDriftNote, ledgerNote, type FileGrandfather } from "../function-complexity-baseline.js";

/** The trailing ledger note(s) for a block message: the burn-down count
 *  always, plus a drift note when the ledger's generation cap no longer
 *  matches the currently effective cap. Empty string when `gf` is null
 *  (legacy delta mode has no ledger trailer). */
export function ledgerBlockLines(
	label: string,
	gf: FileGrandfather | null,
	effectiveCap: number,
): string {
	if (!gf) return "";
	const drift = ledgerDriftNote(label, gf, effectiveCap);
	return `\n${ledgerNote(label, gf)}${drift ? `\n${drift}` : ""}`;
}
