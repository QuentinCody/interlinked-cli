// Instruction packets — context-budget accounting (design §9, the product claim).
//
// Per source file: how many characters (tokens ≈ chars / 4, the same estimate
// `tool-result-checks.ts` uses) the file costs per turn, and which spans are
// held by something that enforces them: a Pass 1 distilled rule, a live
// (warn/cosign) packet, a release already made, or a shadow packet (enforced in
// shadow, still in context). A quote the file no longer holds is listed as
// unlocated and counts nothing.
//
// Two figures are claims about savings, so both are computed from what the
// release really does, never estimated span by span (seventh review, audit D):
//   - `releasable_chars` is the byte delta of the SAME `releaseEdit` the
//     `packets release <file>` command runs, so it is all-or-nothing exactly as
//     the release is: an ambiguous quote, an overlap, a short span, a stale set
//     or a global (`~/`) source makes it 0 and `releasable_blocked` says why;
//   - `released` counts NET characters (text minus pointer) only for a release
//     that is in effect — pointer present and the packet live. A demoted or
//     not-live packet's text is re-injected by the fallback, and an interrupted
//     release left the words in the file: both go to `released_fallback`.
// Pure: the command supplies the file reader, the distilled rules and, when it
// can, the set of released packets the fallback oracle says are not live here.

import { createHash } from "node:crypto";
import { locateQuote, pointerLine, releaseEdit } from "./release.js";
import { statusRank } from "./schema.js";
import { isGlobalSource } from "./source-path.js";
import type { Packet, PacketFile } from "./types.js";

/** A Pass 1 rule's provenance, as `.interlinked/distilled-rules.json` records it. */
export interface Pass1Rule {
	id: string;
	file: string;
	quote: string;
}

export interface SpanCount {
	packets: number;
	chars: number;
}

export interface SourceBudget {
	file: string;
	readable: boolean;
	/** A home-relative file every project loads: budgeted, never released from a repo. */
	global: boolean;
	chars: number;
	/** chars / 4, rounded: an estimate, not a tokenizer count. */
	tokens: number;
	pass1: { rules: number; chars: number };
	/** Live (warn/cosign) packets not yet released: located span characters (gross, informational). */
	live: SpanCount;
	/** Releases in effect: NET characters out of context (released text minus pointer). */
	released: SpanCount;
	/** Releases with no saving: the packet is not live (the fallback re-injects the text) or the pointer is missing. */
	released_fallback: SpanCount;
	shadow: SpanCount;
	/** Exactly the characters `interlinked packets release <file>` would remove now (0 when it would refuse). */
	releasable_chars: number;
	releasable_packets: number;
	/** Why the release would refuse this file although live unreleased packets exist; null otherwise. */
	releasable_blocked: string | null;
	unlocated: string[];
}

export interface BudgetOptions {
	/** Released packet ids the fallback oracle reports as not live here; without it, status < warn is the proxy. */
	notLive?: ReadonlySet<string>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function located(source: string | null, quote: string): number | null {
	if (source === null) return null;
	const hit = locateQuote(source, quote);
	return hit.ok ? hit.end - hit.start : null;
}

function emptyRow(file: string, source: string | null): SourceBudget {
	const chars = source?.length ?? 0;
	const zero = () => ({ packets: 0, chars: 0 });
	return { file, readable: source !== null, global: isGlobalSource(file), chars, tokens: Math.round(chars / 4), pass1: { rules: 0, chars: 0 }, live: zero(), released: zero(), released_fallback: zero(), shadow: zero(), releasable_chars: 0, releasable_packets: 0, releasable_blocked: null, unlocated: [] };
}

/** The first instruction file whose bytes no longer match the compiled digest, or null (mirrors `loadPacketFile`). */
function staleSource(file: PacketFile, readSource: (file: string) => string | null): string | null {
	for (const [name, digest] of Object.entries(file.sources)) {
		const text = readSource(name);
		if (text === null || sha256(text) !== digest) return name;
	}
	return null;
}

const isLive = (p: Packet) => statusRank(p.calibration.status) >= statusRank("warn");

function countReleased(row: SourceBudget, packet: Packet, source: string | null, opts: BudgetOptions): void {
	const text = packet.release?.text ?? "";
	const live = opts.notLive ? !opts.notLive.has(packet.id) && isLive(packet) : isLive(packet);
	const pointer = pointerLine(packet.id, packet.source.file);
	if (live && source !== null && source.includes(pointer)) {
		row.released.packets++;
		row.released.chars += Math.max(0, text.length - pointer.length);
	} else {
		row.released_fallback.packets++;
		row.released_fallback.chars += text.length;
	}
}

/** The release's own verdict on this file: its byte delta when it would succeed, else 0 and the reason. */
function releasableOf(row: SourceBudget, file: PacketFile, source: string | null, stale: string | null): void {
	if (row.live.packets === 0) return; // nothing live to release is not a refusal
	if (row.global) {
		row.releasable_blocked = "global instruction file loaded by every project: never released from a repo";
		return;
	}
	if (stale !== null) {
		row.releasable_blocked = `set stale: ${stale} changed since compile (run \`interlinked packets compile\`, or \`restore\` after an interrupted release)`;
		return;
	}
	if (source === null) {
		row.releasable_blocked = "unreadable";
		return;
	}
	const edit = releaseEdit(file, row.file, source, "budget");
	if (!edit.ok) {
		row.releasable_blocked = edit.error;
		return;
	}
	row.releasable_chars = source.length - edit.source.length;
	row.releasable_packets = edit.released.length;
}

/** Budget rows for every file a packet or a Pass 1 rule names, sorted by file name. */
export function packetBudget(file: PacketFile, pass1: readonly Pass1Rule[], readSource: (file: string) => string | null, opts: BudgetOptions = {}): SourceBudget[] {
	const rows = new Map<string, { row: SourceBudget; source: string | null }>();
	const rowFor = (name: string) => {
		let entry = rows.get(name);
		if (!entry) {
			const source = readSource(name);
			entry = { row: emptyRow(name, source), source };
			rows.set(name, entry);
		}
		return entry;
	};
	for (const name of Object.keys(file.sources)) rowFor(name);
	for (const rule of pass1) {
		const { row, source } = rowFor(rule.file);
		row.pass1.rules++;
		const n = located(source, rule.quote);
		if (n === null) row.unlocated.push(rule.id);
		else row.pass1.chars += n;
	}
	for (const packet of file.packets) {
		const { row, source } = rowFor(packet.source.file);
		if (packet.release) {
			countReleased(row, packet, source, opts);
			continue;
		}
		const bucket = isLive(packet) ? row.live : row.shadow;
		bucket.packets++;
		const n = located(source, packet.source.quote);
		if (n === null) row.unlocated.push(packet.id);
		else bucket.chars += n;
	}
	const stale = staleSource(file, readSource);
	for (const { row, source } of rows.values()) releasableOf(row, file, source, stale);
	return [...rows.values()].map((e) => e.row).sort((a, b) => a.file.localeCompare(b.file));
}

const tok = (chars: number) => Math.round(chars / 4);

function fileLines(r: SourceBudget): string[] {
	const tags = [r.readable ? null : "unreadable", r.global ? "global: budget only, never released from a repo" : null].filter(Boolean);
	const lines = [`${r.file}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}: ${r.chars} chars ≈ ${r.tokens} tokens`];
	lines.push(`  held by Pass 1 rules: ${r.pass1.rules} rule(s), ${r.pass1.chars} chars ≈ ${tok(r.pass1.chars)} tokens`);
	lines.push(`  released already: ${r.released.packets} packet(s), ${r.released.chars} chars net out of context ≈ ${tok(r.released.chars)} tokens`);
	if (r.released_fallback.packets > 0) lines.push(`  released but not saving: ${r.released_fallback.packets} packet(s), ${r.released_fallback.chars} chars re-injected by the fallback (packet not live, or the pointer is missing)`);
	lines.push(r.releasable_blocked !== null ? `  releasable now: none — ${r.releasable_blocked}` : `  releasable now: ${r.releasable_packets} packet(s), ${r.releasable_chars} chars net ≈ ${tok(r.releasable_chars)} tokens (what \`packets release ${r.file}\` would remove)`);
	lines.push(`  enforced in shadow, still in context: ${r.shadow.packets} packet(s), ${r.shadow.chars} chars ≈ ${tok(r.shadow.chars)} tokens`);
	if (r.unlocated.length > 0) lines.push(`  not located in the file: ${r.unlocated.join(", ")}`);
	return lines;
}

/** Human table: header, one block per file, totals (each total is the sum of the rows, tokens included). */
export function renderBudget(rows: readonly SourceBudget[]): string {
	const lines = ["instruction context budget (tokens ≈ chars / 4, an estimate; spans located by quote)"];
	const sum = (f: (r: SourceBudget) => number) => rows.reduce((n, r) => n + f(r), 0);
	for (const r of rows) lines.push(...fileLines(r));
	lines.push(`total: ${sum((r) => r.chars)} chars ≈ ${sum((r) => r.tokens)} tokens; released ${sum((r) => tok(r.released.chars))}, releasable ${sum((r) => tok(r.releasable_chars))}, shadow ${sum((r) => tok(r.shadow.chars))}, pass-1 ${sum((r) => tok(r.pass1.chars))} tokens`);
	return lines.join("\n");
}
