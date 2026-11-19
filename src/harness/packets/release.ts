// Instruction packets — release and restore of instruction text (design §9).
//
// A packet at warn/cosign is enforced at hook time, so its instruction span can
// leave the context window. `releaseEdit` copies the span VERBATIM into
// `release.text`, puts one pointer line in its place and recomputes
// `sources[file]` for the pointer-bearing file, all in one value the command
// writes as one transaction (both files or neither). `restoreEdit` is the exact
// inverse: release then restore is byte-identical. Nothing here touches the
// filesystem; `commands/packets-release.ts` does the writes.
//
// A quote is located by exact substring first, then with whitespace folded
// (the draft compiler often unwraps a line-wrapped sentence); it must occur
// exactly once. Spans never overlap; a pointer already present refuses the
// release because a restore could not tell the two apart.

import { createHash } from "node:crypto";
import { CODEX_ADDITIONAL_CONTEXT_LIMIT } from "../adapters/provider-capabilities.js";
import { codeMask, droppableMarkers, emphasisPairs } from "./markdown-emphasis.js";
import { statusRank } from "./schema.js";
import { isGlobalSource } from "./source-path.js";
import type { Packet, PacketFile } from "./types.js";

/** The longest span a release may move out: its fallback line (header ≈ 150 chars + the text) must fit whole in
 *  the smallest known hook-context limit, or that runner gets the words cut (break R1, Codex truncation). */
export const MAX_RELEASE_CHARS = CODEX_ADDITIONAL_CONTEXT_LIMIT - 500;

export type Located = { ok: true; start: number; end: number; lines: [number, number] } | { ok: false; error: string };

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Fold whitespace runs to one space and drop the emphasis markers that are presentation — only runs of a
 *  matched pair, never content such as `__init__`, `*.ts` or anything in code (markdown-emphasis.ts, audit D1).
 *  `map[i]` is the source offset of folded char i. */
function fold(text: string): { folded: string; map: number[] } {
	let folded = "";
	const map: number[] = [];
	let inSpace = false;
	const drop = droppableMarkers(text);
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (drop[i] === 1) continue;
		if (/\s/.test(ch)) {
			if (!inSpace) {
				folded += " ";
				map.push(i);
			}
			inSpace = true;
		} else {
			folded += ch;
			map.push(i);
			inSpace = false;
		}
	}
	return { folded, map };
}

/** Grow a span outward over adjacent PAIRED emphasis markers so a release removes balanced `**…**`, never an
 *  identifier's underscore or the next phrase's opener (audit D2). */
function coverEmphasis(drop: Uint8Array, start: number, end: number): [number, number] {
	let s = start;
	let e = end;
	while (s > 0 && drop[s - 1] === 1) s--;
	while (e < drop.length && drop[e] === 1) e++;
	return [s, e];
}

/** Why the cut [start, end) is not a clean unit of the instruction file, or null: it must not split a matched
 *  emphasis pair (a lone `**` would leak bold into the rest of the file) and must not start or end inside a word
 *  (`…the delete` must not cut `deleted`) — audit D2/M1b. */
function cutDefect(source: string, start: number, end: number): string | null {
	for (const p of emphasisPairs(source)) {
		const openIn = p.open >= start && p.open < end;
		const closeIn = p.close >= start && p.close < end;
		if (openIn !== closeIn) return "the quote starts or ends inside an emphasized phrase; quote the whole phrase";
	}
	const before = source[start - 1];
	const after = source[end];
	if (WORD_CHAR.test(source[start] ?? "") && before !== undefined && WORD_CHAR.test(before)) return "the quote starts inside a word";
	if (WORD_CHAR.test(source[end - 1] ?? "") && after !== undefined && WORD_CHAR.test(after)) return "the quote ends inside a word";
	return null;
}

function occurrences(hay: string, needle: string): number[] {
	const out: number[] = [];
	let at = hay.indexOf(needle);
	while (at !== -1) {
		out.push(at);
		at = hay.indexOf(needle, at + 1);
	}
	return out;
}

/** Character span of `quote` in `source`: exact first, then whitespace-folded; exactly one hit. */
export function locateQuote(source: string, quote: string): Located {
	const needle = quote.trim();
	if (needle === "") return { ok: false, error: "quote is empty" };
	let start: number;
	let end: number;
	const exact = occurrences(source, needle);
	if (exact.length === 1) {
		start = exact[0] as number;
		end = start + needle.length;
		// The folded path never matches inside a code span; the exact path must not either (R6 X2).
		const mask = codeMask(source);
		if (mask[start] === 1 || mask[end - 1] === 1) return { ok: false, error: "the quote starts or ends inside a code span" };
	} else if (exact.length > 1) {
		return { ok: false, error: `quote occurs ${exact.length} times; a release needs exactly one` };
	} else {
		const { folded, map } = fold(source);
		const foldedNeedle = fold(needle).folded;
		const hits = occurrences(folded, foldedNeedle);
		if (hits.length === 0) return { ok: false, error: "quote not found in the source" };
		if (hits.length > 1) return { ok: false, error: `quote occurs ${hits.length} times; a release needs exactly one` };
		const hit = hits[0] as number;
		start = map[hit] as number;
		end = (map[hit + foldedNeedle.length - 1] as number) + 1;
	}
	// The exact path grows over a surrounding `**…**` too, so `**whole rule**` is cut whole (audit D, M2).
	[start, end] = coverEmphasis(droppableMarkers(source), start, end);
	const defect = cutDefect(source, start, end);
	if (defect !== null) return { ok: false, error: defect };
	return { ok: true, start, end, lines: [lineOf(source, start), lineOf(source, Math.max(start, end - 1))] };
}

/** The one-line pointer that replaces a released span. Deterministic per (packet, file); no newline; short,
 *  because every byte of it is paid on every turn (`interlinked packets status` names the restore command). */
export function pointerLine(packetId: string, _file: string): string {
	return `[interlinked packet ${packetId}: enforced by hook]`;
}

export interface ReleaseOutcome {
	file: PacketFile;
	source: string;
	released: string[];
}
export interface RestoreOutcome {
	file: PacketFile;
	source: string;
	restored: string[];
}
export type ReleaseResult = { ok: true } & ReleaseOutcome | { ok: false; error: string };
export type RestoreResult = { ok: true } & RestoreOutcome | { ok: false; error: string };

interface Cut {
	packet: Packet;
	start: number;
	end: number;
	replacement: string;
}

/** Apply non-overlapping cuts (checked) from the end so earlier offsets stay valid. */
function splice(source: string, cuts: Cut[], file: string): { ok: true; text: string } | { ok: false; error: string } {
	const ordered = [...cuts].sort((a, b) => a.start - b.start);
	for (let i = 1; i < ordered.length; i++) {
		const prev = ordered[i - 1] as Cut;
		const cur = ordered[i] as Cut;
		if (cur.start < prev.end) return { ok: false, error: `${cur.packet.id} overlaps ${prev.packet.id} in ${file}; release one of them` };
	}
	let text = source;
	for (const c of [...ordered].reverse()) text = text.slice(0, c.start) + c.replacement + text.slice(c.end);
	return { ok: true, text };
}

function withSource(file: PacketFile, name: string, source: string, packets: Packet[]): PacketFile {
	return { ...file, sources: { ...file.sources, [name]: sha256(source) }, packets };
}

/** Rehash `name` only when the pre-edit bytes were the compiled ones; a set that was stale before the edit
 *  stays stale after it, so an unrelated hand change is never re-validated by a restore (R42). */
function withSourceIfFresh(file: PacketFile, name: string, before: string, after: string, packets: Packet[]): PacketFile {
	return file.sources[name] === sha256(before) ? withSource(file, name, after, packets) : { ...file, packets };
}

/** Characters a release of this packet would take out of the file: span minus pointer (R45). */
export function netSaving(packet: Packet, spanChars: number): number {
	return spanChars - pointerLine(packet.id, packet.source.file).length;
}

const POINTER = /\[interlinked packet ([a-z0-9][a-z0-9_.-]{0,99}): enforced by hook\]/g;

/** Packet ids whose pointer line stands in `text` (the commit gate checks each has a release). */
export function pointerIdsIn(text: string): string[] {
	return [...new Set([...text.matchAll(POINTER)].map((m) => m[1] as string))];
}

type CutPlan = { kind: "cut"; cut: Cut } | { kind: "refused"; reason: string } | { kind: "error"; error: string };

/** Admission of one packet to a release: status, not yet released, located once, and a positive net saving.
 *  A refusal is reported and the others proceed; an error (ambiguous quote, pointer present) stops the edit. */
function planCut(packet: Packet, source: string): CutPlan {
	if (packet.release) return { kind: "refused", reason: `${packet.id} already released` };
	if (statusRank(packet.calibration.status) < statusRank("warn")) return { kind: "refused", reason: `${packet.id} is at ${packet.calibration.status} (release needs warn or cosign)` };
	const pointer = pointerLine(packet.id, packet.source.file);
	if (source.includes(pointer)) return { kind: "error", error: `${packet.id}: the source already holds this packet's pointer line` };
	const hit = locateQuote(source, packet.source.quote);
	if (!hit.ok) return { kind: "error", error: `${packet.id}: ${hit.error}` };
	// A span over another packet's pointer would take that pointer out of the file, so its restore finds none and
	// the whole file's restore refuses (review-100). Its own pointer was refused above.
	const held = pointerIdsIn(source.slice(hit.start, hit.end))[0];
	if (held !== undefined) return { kind: "error", error: `${packet.id}'s span holds the pointer line of packet ${held}; restore ${held} first` };
	const span = hit.end - hit.start;
	if (netSaving(packet, span) <= 0) return { kind: "refused", reason: `${packet.id} span (${span} chars) is not longer than its pointer (${pointer.length} chars); nothing to gain` };
	if (span > MAX_RELEASE_CHARS) return { kind: "refused", reason: `${packet.id} span (${span} chars) is longer than ${MAX_RELEASE_CHARS}: a runner that keeps only the head of hook context (Codex, ${CODEX_ADDITIONAL_CONTEXT_LIMIT}) would receive its fallback cut; split the instruction` };
	return { kind: "cut", cut: { packet, start: hit.start, end: hit.end, replacement: pointer } };
}

/** A packet NOT being released whose instruction lies inside a cut would lose its words with nothing enforcing
 *  them (a shadow packet, a short one refused for net saving, one outside `--only`): the release refuses
 *  (audit D6). Returns the reason, or null. */
function swallowedPacket(file: PacketFile, sourceFile: string, source: string, cuts: readonly Cut[]): string | null {
	const cutIds = new Set(cuts.map((c) => c.packet.id));
	for (const other of file.packets) {
		if (other.source.file !== sourceFile || other.release || cutIds.has(other.id)) continue;
		// EVERY copy, not only a unique one: an ambiguous quote whose copies all lie inside the cut is swallowed just
		// the same (break R5 #1, P1). One copy outside every cut keeps the words in the file.
		const ranges = quoteRanges(source, other.source.quote);
		const inCut = (r: readonly [number, number]) => cuts.find((c) => r[0] < c.end && c.start < r[1]);
		// A quote that cannot be located may still lie inside the cut in a form the locator misses: refuse (R6 W3).
		if (ranges.length === 0) return `quote of ${other.id} cannot be located; survival cannot be proven`;
		if (!ranges.every((r) => inCut(r) !== undefined)) continue;
		const cut = inCut(ranges[0] as [number, number]) as Cut;
		return `${cut.packet.id}'s span also holds packet ${other.id}'s instruction (status ${other.calibration.status}); releasing it would remove those words with nothing enforcing them`;
	}
	return null;
}

/** Every [start, end) where `quote` occurs: the union of exact and whitespace-folded copies, deduplicated, so a
 *  folded copy outside the cut counts even when an exact copy lies inside it (R6 W3). */
function quoteRanges(source: string, quote: string): Array<readonly [number, number]> {
	const needle = quote.trim();
	if (needle === "") return [];
	const out = new Map<string, readonly [number, number]>();
	for (const s of occurrences(source, needle)) out.set(`${s}:${s + needle.length}`, [s, s + needle.length]);
	const { folded, map } = fold(source);
	const foldedNeedle = fold(needle).folded;
	if (foldedNeedle !== "") {
		for (const h of occurrences(folded, foldedNeedle)) {
			const r = [map[h] as number, (map[h + foldedNeedle.length - 1] as number) + 1] as const;
			out.set(`${r[0]}:${r[1]}`, r);
		}
	}
	return [...out.values()];
}

/** Release every live (warn/cosign), unreleased packet of `sourceFile` — or only `only` — into the packet file. */
export function releaseEdit(file: PacketFile, sourceFile: string, source: string, now: string, only?: readonly string[]): ReleaseResult {
	if (isGlobalSource(sourceFile)) return { ok: false, error: `${sourceFile} is a global instruction file loaded by every project; a release and its fallback live in one repo, so it is never released (the budget still reports it)` };
	const cuts: Cut[] = [];
	const refused: string[] = [];
	for (const packet of file.packets) {
		if (packet.source.file !== sourceFile) continue;
		if (only && !only.includes(packet.id)) continue;
		const plan = planCut(packet, source);
		if (plan.kind === "error") return { ok: false, error: plan.error };
		if (plan.kind === "refused") refused.push(plan.reason);
		else cuts.push(plan.cut);
	}
	if (cuts.length === 0) return { ok: false, error: `no packet to release in ${sourceFile}${refused.length ? `: ${refused.join("; ")}` : ""}` };
	const swallowed = swallowedPacket(file, sourceFile, source, cuts);
	if (swallowed !== null) return { ok: false, error: swallowed };
	const spliced = splice(source, cuts, sourceFile);
	if (!spliced.ok) return spliced;
	const releasedIds = new Set(cuts.map((c) => c.packet.id));
	const packets = file.packets.map((p) => {
		const cut = cuts.find((c) => c.packet.id === p.id);
		if (!cut) return p;
		const text = source.slice(cut.start, cut.end);
		return { ...p, release: { text, released_at: now, span_hash: sha256(text) } };
	});
	return { ok: true, file: withSource(file, sourceFile, spliced.text, packets), source: spliced.text, released: file.packets.filter((p) => releasedIds.has(p.id)).map((p) => p.id) };
}

/** Put every released span of `sourceFile` back (whatever the packet's status now is) and clear `release`.
 *  A packet whose pointer is absent while the source still holds its words is an interrupted release
 *  (packet file written, source not): its release is cleared without touching the source (R37). */
export function restoreEdit(file: PacketFile, sourceFile: string, source: string): RestoreResult {
	const cuts: Cut[] = [];
	const restoredIds = new Set<string>();
	// The bytes the set's hash should describe: the source as the interrupted release WOULD have left it.
	let expected = source;
	for (const packet of file.packets) {
		if (packet.source.file !== sourceFile || !packet.release) continue;
		if (sha256(packet.release.text) !== packet.release.span_hash) return { ok: false, error: `${packet.id}: release.text does not match span_hash; the file was edited by hand` };
		const pointer = pointerLine(packet.id, sourceFile);
		const hits = occurrences(source, pointer);
		if (hits.length === 0 && source.includes(packet.release.text)) {
			restoredIds.add(packet.id);
			expected = expected.replace(packet.release.text, pointer);
			continue;
		}
		if (hits.length !== 1) return { ok: false, error: `${packet.id}: pointer line not found in ${sourceFile} (expected exactly one)` };
		cuts.push({ packet, start: hits[0] as number, end: (hits[0] as number) + pointer.length, replacement: packet.release.text });
		restoredIds.add(packet.id);
	}
	if (restoredIds.size === 0) return { ok: false, error: `no released packet in ${sourceFile}` };
	const spliced = splice(source, cuts, sourceFile);
	if (!spliced.ok) return spliced;
	const packets = file.packets.map((p) => (restoredIds.has(p.id) ? { ...p, release: null } : p));
	return { ok: true, file: withSourceIfFresh(file, sourceFile, expected, spliced.text, packets), source: spliced.text, restored: [...restoredIds] };
}
