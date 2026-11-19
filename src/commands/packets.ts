// ===========================================
// `interlinked packets compile|status` — instruction packets (stage 1: shadow)
// ===========================================
// `compile --from <draft.json>` is the deterministic half of the compiler
// (docs/design/instruction-jev-evaluator.md §5): the /enforce agent writes a
// draft; this command hashes it, carries over calibration for unchanged
// packets, replays every trigger over the local collection log (counts, width,
// cold, delivery support for the runner) and writes
// `.interlinked/instruction-packets.json` by an internal write (temp + rename).
// `--dry` prints the replay table and writes nothing. `status` lists packets.
// Nothing here calls Jev.

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CalibrationResult, calibratePacket, type Label } from "../harness/packets/calibrate.js";
import { compilePacketFile } from "../harness/packets/compile.js";
import { activeRuleIds, cosignStatusLines, pairedRule } from "../harness/packets/cosign-pairing.js";
import { judgmentId, PACKET_LEDGER, type PacketJudgmentRow } from "../harness/packets/evaluator.js";
import { buildLabelSheet, cohortKey, labeledJudgments, observationAliases } from "../harness/packets/label-sheet.js";
import { applyPromotions, type BindableRow, type ShownItem, shownAdjudications, shownItemsOf } from "../harness/packets/promote.js";
import { WINDOW_LEDGER, type WindowJudgmentRow, windowJudgmentId } from "../harness/packets/trajectory.js";
import { buildWindowLabelSheet, windowJudgedRows, windowLabeledJudgments } from "../harness/packets/window-labels.js";
import { readWindowSources } from "../harness/packets/window-source.js";
import { loadRules } from "../harness/rules-loader.js";
import { type DryRunRow, dryRun, readCollectionRows, type ReplayRow } from "../harness/packets/replay.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import { resolveSourcePath } from "../harness/packets/source-path.js";
import { acquirePacketLock, lockRefusal, sweepStaleTemps, writeAtomic } from "./packets-release-io.js";
import { pairPostToPre, readCallRows } from "./packets-replay.js";
import type { PacketFile } from "../harness/packets/types.js";
import { DEFAULT_TAIL_MB, loadPacketFileOrNull, packetPath, readLedger, readOrNull } from "./packets-read.js";

export interface PacketsCalibrateExportOpts {
	out: string;
	tailMb?: number;
	cwd?: string;
}

export interface PacketsCalibrateScoreOpts {
	/** Two or more label files: `{ "<judgment id>": { "label": "true"|"false"|"unsure" } }`. */
	labels: string[];
	apply?: boolean;
	/** With --apply: allow warn → cosign when the prerequisites hold (recall, adjudication body). */
	cosign?: boolean;
	json?: boolean;
	cwd?: string;
}

export interface PacketsCompileOpts {
	from: string;
	dry?: boolean;
	runner?: string;
	/** Newest megabytes of collection.jsonl to replay (default 256). */
	tailMb?: number;
	json?: boolean;
	cwd?: string;
}

export interface PacketsStatusOpts {
	json?: boolean;
	cwd?: string;
}

const DEFAULT_RUNNER = "claude-code";

function replayLine(r: DryRunRow): string {
	const flags = [r.cold ? "COLD" : null, r.too_wide ? "TOO WIDE" : null, r.support.supported ? null : `UNSUPPORTED: ${r.support.reason}`].filter(Boolean).join("; ");
	return `${r.id.padEnd(28)} ${r.triggered}/${r.tool_rows} rows (${(100 * r.width).toFixed(1)}%), ${r.sessions} sessions${flags ? `  ${flags}` : ""}`;
}

function writeAtomically(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** Run `plan` (read the packet file, decide) and write its text to the packet file, both under the lock that release
 *  and restore hold, so neither can land between the read and the write. `dry`: no lock, no write. Null: the lock is
 *  busy (the reason is printed). */
function writeUnderPacketLock<T>(cwd: string, verb: string, dry: boolean, plan: () => { write: string | null; value: T }): { value: T; written: boolean } | null {
	if (dry) return { value: plan().value, written: false };
	const target = packetPath(cwd);
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	const lock = acquirePacketLock(target);
	if (!lock.ok) {
		console.error(`packets ${verb}: ${lockRefusal(lock)}`);
		return null;
	}
	try {
		sweepStaleTemps(target);
		const { write, value } = plan();
		if (write !== null) writeAtomic(target, write);
		return { value, written: write !== null };
	} finally {
		lock.release();
	}
}

/** Exit codes: 0 compiled (or dry), 1 draft refused or another packet-file write running, 2 draft unreadable. */
export async function packetsCompileCommand(opts: PacketsCompileOpts): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const draft = readOrNull(opts.from);
	if (draft === null) {
		console.error(`packets compile: cannot read draft ${opts.from}`);
		return 2;
	}
	const target = packetPath(cwd);
	// Read, compile and write under the lock release/restore hold: a release that landed between this read and the
	// write would be overwritten, leaving its pointer in the source and its words in neither file (review-100 P1).
	const locked = writeUnderPacketLock<ReturnType<typeof compilePacketFile>>(cwd, "compile", opts.dry === true, () => {
		const out = compilePacketFile(draft, readOrNull(target), {
			now: new Date().toISOString(),
			readSource: (file) => readOrNull(resolveSourcePath(cwd, file)),
		});
		return out.ok ? { write: `${JSON.stringify(out.file, null, 2)}\n`, value: out } : { write: null, value: out };
	});
	if (locked === null) return 1;
	const compiled = locked.value;
	if (!compiled.ok) {
		console.error(`packets compile: ${compiled.error}`);
		return 1;
	}
	const written = locked.written ? target : null;
	const rows: ReplayRow[] = [];
	for await (const r of readCollectionRows(join(cwd, ".interlinked", "collection.jsonl"), (opts.tailMb ?? DEFAULT_TAIL_MB) * 1024 * 1024)) rows.push(r);
	const replay = dryRun(compiled.file, rows, opts.runner ?? DEFAULT_RUNNER);
	if (opts.json) {
		console.log(JSON.stringify({ written, packets: compiled.file.packets.length, skipped: compiled.file.skipped.length, notes: compiled.notes, replay_rows: rows.length, replay }, null, 2));
		return 0;
	}
	console.log(`packets: ${compiled.file.packets.length} compiled, ${compiled.file.skipped.length} skipped; replayed ${rows.length} rows`);
	for (const line of replay.map(replayLine)) console.log(`  ${line}`);
	for (const note of compiled.notes) console.log(`  note: ${note}`);
	console.log(written ? `wrote ${written} (every new packet at shadow)` : "dry run: nothing written");
	return 0;
}

/** Window judgments (the trajectory layer's ledger); a torn line is skipped. */
export function readWindowLedger(cwd: string): WindowJudgmentRow[] {
	const text = readOrNull(join(cwd, ".interlinked", WINDOW_LEDGER));
	if (text === null) return [];
	const rows: WindowJudgmentRow[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line) as WindowJudgmentRow);
		} catch {
			continue;
		}
	}
	return rows;
}

/** Exit codes: 0 sheet written, 1 packet file missing or invalid, 2 no judgments. */
export async function packetsCalibrateExportCommand(opts: PacketsCalibrateExportOpts): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const file = loadPacketFileOrNull(cwd);
	if (!file) {
		console.error("packets calibrate export: no valid packet file; run `interlinked packets compile` first");
		return 1;
	}
	const judgments = readLedger(cwd) ?? [];
	const windowRows = readWindowLedger(cwd);
	if (judgments.length === 0 && windowRows.length === 0) {
		console.error(`packets calibrate export: no judgments in .interlinked/${PACKET_LEDGER} or .interlinked/${WINDOW_LEDGER}; run with packets.enabled and jev.enabled first`);
		return 2;
	}
	const tailBytes = (opts.tailMb ?? DEFAULT_TAIL_MB) * 1024 * 1024;
	// Every call row, empty post rows included, so a live row keyed by its post seq pairs with its pre row (n140).
	const rows = await readCallRows(join(cwd, ".interlinked", "collection.jsonl"), tailBytes);
	const { sheet, unjoined } = buildLabelSheet(judgments, file, rows, pairPostToPre(rows));
	const windowJudged = windowJudgedRows(windowRows, file);
	const sources = await readWindowSources(join(cwd, ".interlinked", "collection.jsonl"), join(cwd, ".interlinked", "timeline.jsonl"), tailBytes, new Set(windowJudged.map((r) => r.session_id)));
	const windows = buildWindowLabelSheet(windowJudged, file, sources, loadRules(cwd).packets ?? { enabled: false }, cwd);
	const all = [...sheet, ...windows.sheet];
	writeAtomically(opts.out, all.map((s) => JSON.stringify(s)).join("\n") + (all.length ? "\n" : ""));
	console.log(`packets calibrate export: ${all.length} rows written to ${opts.out} (${sheet.length} per-call, ${windows.sheet.length} window); ${unjoined + windows.unjoined} unjoined; judged rows read: ${judgments.length} per-call, ${windowJudged.length} window`);
	console.log('Label blind: each labeler answers the row\'s question from its evidence alone and writes {"<id>": {"label": "true"|"false"|"unsure"}}.');
	return 0;
}

function readLabelFile(path: string): Record<string, Label> | null {
	const text = readOrNull(path);
	if (text === null) return null;
	try {
		const raw = JSON.parse(text) as Record<string, { label?: unknown } | string>;
		const out: Record<string, Label> = {};
		for (const [id, v] of Object.entries(raw)) {
			const label = typeof v === "string" ? v : v?.label;
			if (label === "true" || label === "false" || label === "unsure") out[id] = label;
		}
		return out;
	} catch {
		return null;
	}
}

function groupByPacket(items: ReturnType<typeof labeledJudgments>): Map<string, typeof items> {
	const by = new Map<string, typeof items>();
	for (const item of items) by.set(item.packet, [...(by.get(item.packet) ?? []), item]);
	return by;
}

function describeResult(r: CalibrationResult): string {
	const h = r.holdout;
	const verdict = r.decision.promote ? "PROMOTE → warn" : `stay (${r.decision.reasons.join("; ")})`;
	return `${r.packet.padEnd(28)} labeled ${r.labeled} gold ${r.gold} κ=${r.kappa === null ? "—" : r.kappa.toFixed(2)} tau=${r.tau ?? "—"} holdout n=${h.n} pos=${h.pos} AUROC=${h.auroc === null ? "—" : h.auroc.toFixed(2)} P@τ=${h.precision_at_tau.tp}/${h.precision_at_tau.flagged} R@τ=${h.recall_at_tau.tp}/${h.recall_at_tau.pos}  ${verdict}`;
}

/** Exit codes: 0 scored (and applied when asked), 1 packet file or ledger unusable, 2 fewer than two label files. */
export async function packetsCalibrateScoreCommand(opts: PacketsCalibrateScoreOpts): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	// --apply reads the packet file and rewrites it: both under the release/restore lock (review-100 P1). A plain
	// score only reads, so it takes no lock.
	const locked = writeUnderPacketLock<ReturnType<typeof scoreOnce>>(cwd, "calibrate score", opts.apply !== true, () => {
		const scored = scoreOnce(cwd, opts);
		if (typeof scored === "number") return { write: null, value: scored };
		const changed = scored.applied.applied.length > 0 || scored.applied.demoted.length > 0;
		return { write: changed ? `${JSON.stringify(scored.applied.file, null, 2)}\n` : null, value: scored };
	});
	if (locked === null) return 1;
	if (typeof locked.value === "number") return locked.value;
	printScore(locked.value.results, locked.value.applied, opts.apply === true, opts.json === true);
	return 0;
}

/** One scoring pass over the packet file as it is now: an exit code (reason printed) or the results and promotions. */
function scoreOnce(cwd: string, opts: PacketsCalibrateScoreOpts): number | { results: CalibrationResult[]; applied: ReturnType<typeof applyPromotions> } {
	const file = loadPacketFileOrNull(cwd);
	// Either ledger may be absent (a repo with only window packets has no per-call rows); both empty is still scorable as "nothing".
	const judgments = readLedger(cwd) ?? [];
	const labelers = readLabelers(opts.labels, cwd, observationAliases(judgments));
	if (!file || !labelers) {
		console.error("packets calibrate score: packet file or a label file is missing or invalid");
		return 1;
	}
	if (Object.keys(labelers).length < 2) {
		console.error("packets calibrate score: gold needs two independent labelers (two --labels files, or one plus `packets adjudicate` rows)");
		return 2;
	}
	// Only rows judged under each packet's CURRENT hash count: a recompiled packet is a new
	// question, and its old rows (same judgment ids) would double-count and mis-bind.
	const currentHash = new Map(file.packets.map((p) => [p.id, p.packet_hash]));
	const current = judgments.filter((r) => r.packet_hash !== null && currentHash.get(r.packet) === r.packet_hash);
	const windowCurrent = windowJudgedRows(readWindowLedger(cwd), file);
	const { results, rowsByPacket } = scoreLabeledCohorts(file, current, windowCurrent, labelers);
	const shownItems: ShownItem[] = [...shownItemsOf(current), ...windowCurrent.map((r) => ({ id: windowJudgmentId(r), ts: r.ts, shown: r.shown, packet: r.packet }))];
	// An adjudication given under either id of one observation (a cosign call's pre and post rows) counts once.
	const adjudicated = readAdjudications(cwd, observationAliases(current));
	// Rolling last-30 decides demotion; the ALL-TIME history is the cosign prerequisite (R32: a 30-window can never reach 200).
	const applied = applyPromotions(file, results, rowsByPacket, new Date().toISOString(), shownAdjudications(shownItems, adjudicated), {
		cosign: opts.cosign === true,
		shownHistory: shownAdjudications(shownItems, adjudicated, Number.POSITIVE_INFINITY),
		// §5 pairing (C9): a cosign grant needs a cosignal that names a rule the guard runs here.
		activeRules: activeRuleIds(loadRules(cwd)),
	});
	return { results, applied };
}

/** One evaluator COHORT per packet (model|runner|renderer|redaction): the largest labeled cohort is scored,
 *  and the binding rows are exactly the rows that were scored — never an unlabeled stray row. Both ledgers
 *  feed one pass: per-call and window rows are labeled under their own ids and carry the same binding fields. */
function scoreLabeledCohorts(file: PacketFile, current: readonly PacketJudgmentRow[], windowCurrent: readonly WindowJudgmentRow[], labelers: Record<string, Record<string, Label>>): { results: CalibrationResult[]; rowsByPacket: Record<string, BindableRow[]> } {
	const aliases = observationAliases(current);
	const bindable: { id: string; cohort: string; row: BindableRow }[] = [
		...current.map((r) => ({ id: aliases.get(judgmentId(r)) ?? judgmentId(r), cohort: cohortKey(r), row: r })),
		...windowCurrent.map((r) => ({ id: windowJudgmentId(r), cohort: cohortKey(r), row: r })),
	];
	const labeled = [...labeledJudgments(current, labelers), ...windowLabeledJudgments(windowCurrent, labelers, file)];
	const results: CalibrationResult[] = [];
	const rowsByPacket: Record<string, BindableRow[]> = {};
	for (const items of groupByPacket(labeled).values()) {
		const byCohort = new Map<string, typeof items>();
		for (const item of items) byCohort.set(item.cohort ?? "?", [...(byCohort.get(item.cohort ?? "?") ?? []), item]);
		const [cohort, chosen] = [...byCohort.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? ["?", []];
		if (chosen.length === 0) continue;
		const ids = new Set(chosen.map((i) => i.id));
		results.push(calibratePacket(chosen));
		rowsByPacket[chosen[0]?.packet ?? ""] = bindable.filter((b) => b.cohort === cohort && ids.has(b.id)).map((b) => b.row);
	}
	return { results, rowsByPacket };
}

/** Every label file read, or null when any is missing or malformed. A labeler is keyed by the file's identity
 *  (`dev:ino` of the target), so one file named twice (another spelling, a symlink, a hardlink, a case variant on a
 *  case-insensitive FS) is one labeler and cannot make gold alone (audit C8, R6 W5). */
function readLabelers(paths: readonly string[], cwd: string, aliases: ReadonlyMap<string, string>): Record<string, Record<string, Label>> | null {
	const labelers: Record<string, Record<string, Label>> = {};
	for (const path of paths) {
		const labels = readLabelFile(path);
		if (!labels) return null;
		const { dev, ino } = statSync(path);
		labelers[`${dev}:${ino}`] = labels;
	}
	const adjudicated = readAdjudications(cwd, aliases);
	if (Object.keys(adjudicated).length > 0) labelers.adjudication = adjudicated;
	return labelers;
}

export const PACKET_ADJUDICATIONS = "packet-adjudications.jsonl";

export interface PacketsAdjudicateOpts {
	/** The judgment id printed on the warning line (`<packet>:<session8>:<seq>`). */
	id: string;
	label: string;
	note?: string;
	cwd?: string;
}

/** The newest user label per judgment id from the adjudication ledger (the user is a labeler named `adjudication`). */
function readAdjudications(cwd: string, aliases?: ReadonlyMap<string, string>): Record<string, Label> {
	const text = readOrNull(join(cwd, ".interlinked", PACKET_ADJUDICATIONS));
	return text === null ? {} : parseAdjudications(text, aliases);
}

/** The newest label per id, in ledger (append) order. With `aliases`, every id is first mapped to its observation's
 *  representative, so the newest adjudication of an observation wins under whichever id it was given (break R5
 *  #11: canonicalizing afterwards let an older label on the representative beat a newer correction on an alias). */
export function parseAdjudications(text: string, aliases?: ReadonlyMap<string, string>): Record<string, Label> {
	const out: Record<string, Label> = {};
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as { id?: unknown; label?: unknown };
			if (typeof row.id === "string" && (row.label === "true" || row.label === "false" || row.label === "unsure")) out[aliases?.get(row.id) ?? row.id] = row.label;
		} catch {
			continue; // a torn line is skipped; the next adjudication of the same id wins
		}
	}
	return out;
}

/** Exit codes: 0 recorded, 2 bad label. `true` = the rule WAS violated (the warning was right), `false` = false positive. */
export function packetsAdjudicateCommand(opts: PacketsAdjudicateOpts): number {
	const cwd = opts.cwd ?? process.cwd();
	if (opts.label !== "true" && opts.label !== "false" && opts.label !== "unsure") {
		console.error(`packets adjudicate: label must be true, false or unsure (got ${opts.label})`);
		return 2;
	}
	const row = { ts: new Date().toISOString(), id: opts.id, label: opts.label, note: opts.note ?? null };
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	writeFileSync(join(cwd, ".interlinked", PACKET_ADJUDICATIONS), `${JSON.stringify(row)}\n`, { flag: "a" });
	console.log(`recorded ${opts.id} = ${opts.label}; it counts as the "adjudication" labeler in \`interlinked packets calibrate score\``);
	return 0;
}

function printScore(results: CalibrationResult[], applied: ReturnType<typeof applyPromotions>, apply: boolean, json: boolean): void {
	if (json) {
		console.log(JSON.stringify({ results, applied: apply ? applied.applied : [], would_apply: applied.applied, demoted: applied.demoted, skipped: applied.skipped }, null, 2));
		return;
	}
	for (const r of results) console.log(describeResult(r));
	for (const d of applied.demoted) console.log(`  ${d.id}: DEMOTED to shadow — ${d.reason}`);
	for (const s of applied.skipped) console.log(`  ${s.id}: not applied — ${s.reason}`);
	console.log(apply ? `applied: ${applied.applied.join(", ") || "none"}; demoted: ${applied.demoted.map((d) => d.id).join(", ") || "none"}` : `would apply with --apply: ${applied.applied.join(", ") || "none"}; would demote: ${applied.demoted.map((d) => d.id).join(", ") || "none"}`);
}

export { packetsReplayCommand, packetsReplayWindowsCommand, type PacketsReplayOpts, type PacketsReplayWindowsOpts } from "./packets-replay.js";
export { packetsBudgetCommand, packetsReleaseCommand, packetsRestoreCommand, type PacketsBudgetOpts, type PacketsReleaseOpts, type PacketsRestoreOpts } from "./packets-release.js";

function statusLine(file: PacketFile): string[] {
	return file.packets.map((p) => `  ${p.id.padEnd(28)} ${p.calibration.status.padEnd(7)} tau=${p.calibration.tau ?? "—"}  ${p.release ? "RELEASED" : "in source"}  ${p.source.file}`);
}

/** Exit codes: 0 reported, 1 the file does not parse. */
export function packetsStatusCommand(opts: PacketsStatusOpts): number {
	const cwd = opts.cwd ?? process.cwd();
	const target = packetPath(cwd);
	if (!existsSync(target)) {
		console.log(opts.json ? JSON.stringify({ file: null, packets: [] }) : `no packet file at ${target}; write a draft and run \`interlinked packets compile --from <draft.json>\``);
		return 0;
	}
	const parsed = parsePacketFile(readOrNull(target) ?? "");
	if (!parsed.ok) {
		console.error(`packets status: ${target} does not parse: ${parsed.error}`);
		return 1;
	}
	// The cosign monitor (C9): each cosign packet's pair under the rules the guard runs here, and its asks.
	const active = activeRuleIds(loadRules(cwd));
	if (opts.json) {
		const packets = parsed.value.packets.map((p) => ({ id: p.id, status: p.calibration.status, tau: p.calibration.tau, released: p.release !== null, source: p.source.file, ...(p.calibration.status === "cosign" ? { cosign_rule: pairedRule(p, active) } : {}) }));
		console.log(JSON.stringify({ file: target, compiled_at: parsed.value.compiled_at, packets }, null, 2));
		return 0;
	}
	console.log(`${target} (compiled ${parsed.value.compiled_at}): ${parsed.value.packets.length} packets, ${parsed.value.skipped.length} skipped`);
	for (const line of statusLine(parsed.value)) console.log(line);
	const cosign = parsed.value.packets.some((p) => p.calibration.status === "cosign") ? cosignStatusLines(parsed.value, active, readLedger(cwd) ?? []) : [];
	for (const line of cosign) console.log(line);
	return 0;
}
