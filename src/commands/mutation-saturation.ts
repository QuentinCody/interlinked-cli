// ===========================================
// `interlinked mutation saturation`
// ===========================================
// Per-file saturation status from the recorded manifest (harness/mutation/
// saturation.ts): saturated, open, unknown, unmeasured, gone. Reads state only;
// no runner. `--ratchet` adds every saturated file to
// `.interlinked/saturation-baseline.json` (it never removes one). A listed file
// that is no longer saturated is a regression: exit 1.
//
// Saturation is a STABILITY signal: a change to a saturated file fails a test.
// It does not show that the behaviour is the required one.

import { resolve } from "node:path";
import { loadLedger, withDispositions } from "../harness/mutation/disposition-store.js";
import { corruptManifestMessage, loadManifestState } from "../harness/mutation/manifest.js";
import {
	type FileSaturation,
	loadSaturationBaseline,
	ratchetSaturationBaseline,
	type SaturationCensus,
	saturationCensus,
	saturationRegressions,
	saveSaturationBaseline,
} from "../harness/mutation/saturation.js";
import { getConfigDir } from "../lib/config.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface SaturationCliOptions {
	cwd?: string;
	file?: string;
	ratchet?: boolean;
	top?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function openWork(row: FileSaturation): number {
	return row.counts.survived + row.counts.uncovered;
}

function fileLine(row: FileSaturation): string {
	const c = row.counts;
	const drift = row.staleSymbols + row.unmeasuredSymbols > 0 ? ` · ${row.staleSymbols} stale / ${row.unmeasuredSymbols} unmeasured symbol(s)` : "";
	return `  ${row.status.padEnd(10)} ${row.file}  killed ${c.killed} · equivalent ${c.equivalent} · survived ${c.survived} · uncovered ${c.uncovered}${c.accepted > 0 ? ` (${c.accepted} accepted)` : ""}${drift}`;
}

export function renderSaturation(census: SaturationCensus, regressions: readonly FileSaturation[], top: number): string {
	const t = census.totals;
	const lines = [
		`saturation: ${t.saturated}/${t.files} saturated · ${t.open} open · ${t.unknown} unknown (stale or unmeasured symbols) · ${t.unmeasured} unmeasured · ${t.gone} gone`,
		"  Saturated = every recorded mutant killed or proved equivalent on the current bytes. This is stability, not correctness: it shows a change fails a test, not that the behaviour is the required one.",
	];
	if (regressions.length > 0) {
		lines.push(`  REGRESSIONS: ${regressions.length} file(s) in the saturation baseline are no longer saturated`);
		lines.push(...regressions.slice(0, top).map(fileLine));
	}
	const open = census.rows.filter(row => row.status === "open").sort((a, b) => openWork(b) - openWork(a) || a.file.localeCompare(b.file));
	if (open.length > 0) {
		lines.push(`  Most open work (${Math.min(top, open.length)} of ${open.length}):`);
		lines.push(...open.slice(0, top).map(fileLine));
	}
	return lines.join("\n");
}

export async function mutationSaturationCommand(options: SaturationCliOptions): Promise<void> {
	const mode = getOutputMode(options);
	const configDir = getConfigDir(resolve(options.cwd ?? process.cwd()));
	const root = resolve(configDir, "..");
	const state = loadManifestState(configDir);
	if (state.kind !== "valid") {
		outputError(mode, state.kind === "corrupt" ? corruptManifestMessage(configDir, state.detail) : "No mutation manifest. Measure a file first: `interlinked mutation measure <file> --record`.");
		process.exitCode = 2;
		return;
	}
	const manifest = withDispositions(state.manifest, loadLedger(configDir));
	const needle = options.file?.toLowerCase();
	const only = needle === undefined ? undefined : new Set(Object.keys(manifest.files).filter(file => file.toLowerCase().includes(needle)));
	const census = saturationCensus(root, manifest, only);
	const previous = loadSaturationBaseline(configDir);
	const regressions = saturationRegressions(previous, census.rows);
	let added: string[] = [];
	if (options.ratchet === true) {
		const next = ratchetSaturationBaseline(previous, census.rows);
		added = next.saturated.filter(file => !previous.saturated.includes(file));
		saveSaturationBaseline(configDir, next);
	}
	const parsedTop = Number.parseInt(options.top ?? "", 10);
	const top = Number.isFinite(parsedTop) && parsedTop > 0 ? parsedTop : 20;
	output(mode, { totals: census.totals, regressions, ratchetAdded: added, rows: census.rows }, {
		normal: () => renderSaturation(census, regressions, top) + (options.ratchet === true ? `\n  ratchet: ${added.length} file(s) added to the saturation baseline` : ""),
		short: () => `saturation ${census.totals.saturated}/${census.totals.files} · ${regressions.length} regression(s)`,
	});
	process.exitCode = regressions.length > 0 ? 1 : 0;
}
