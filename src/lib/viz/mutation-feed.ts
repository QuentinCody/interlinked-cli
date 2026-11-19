// ===========================================
// Viz Mutation Feed — live mutants for the dashboard
// ===========================================
// The mutation gate's `mutation-manifest.json` is a keyed STATE document, not an
// append-only log: mutants appear when a symbol is first mutated and flip status
// when a run resolves them. This module turns that state into a stream — a
// snapshot for a joining client, plus per-mutant events (`born` / `flip`) derived
// by diffing successive reads.
//
// Reading is defensive by construction: the manifest is written by another
// process and may be mid-write, partial, or from a future schema. Anything
// unparseable yields an empty snapshot rather than an exception.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { asJsonObject, type JsonObject } from "../json-types.js";

/** A mutant flattened for display: where it lives, what it changed, how it ended. */
export interface MutantView {
	id: string;
	file: string;
	symbol: string;
	mutator: string;
	original: string;
	replacement: string;
	status: string;
}

/** One change observed between two manifest reads. */
export interface MutantEvent {
	kind: "born" | "flip";
	mutant: MutantView;
	/** Previous status, present only on a `flip`. */
	from?: string;
}

export interface MutantSnapshot {
	generation: number;
	engine: string;
	files: number;
	mutants: MutantView[];
	/** Count per status across the WHOLE manifest, unaffected by the display cap. */
	byStatus: Record<string, number>;
	/** Total mutants in the manifest (may exceed `mutants.length` when capped). */
	total: number;
}

/** Display cap — the dashboard renders a wall of mutants, not the whole corpus. */
const MUTANT_CAP = 600;

/** Default manifest location under a project root. */
export function mutationManifestPath(root: string): string {
	return join(root, ".interlinked", "mutation-manifest.json");
}

/** An empty snapshot — the honest answer when there is no manifest yet. */
export function emptySnapshot(): MutantSnapshot {
	return { generation: 0, engine: "", files: 0, mutants: [], byStatus: {}, total: 0 };
}

function str(o: JsonObject, key: string, fallback = ""): string {
	const v = o[key];
	return typeof v === "string" ? v : fallback;
}

/** Project one raw mutant record into a view, or null if it lacks an identity. */
function mapMutant(raw: unknown, file: string, symbol: string): MutantView | null {
	const m = asJsonObject(raw);
	if (!m) return null;
	const id = str(m, "mutantId");
	if (!id) return null;
	return {
		id,
		file,
		symbol,
		mutator: str(m, "mutator", "unknown"),
		original: str(m, "originalLexeme"),
		replacement: str(m, "replacement"),
		status: str(m, "status", "indeterminate"),
	};
}

/** Collect every mutant of one symbol record into `out`. */
function collectSymbol(raw: unknown, file: string, out: MutantView[], byStatus: Record<string, number>): void {
	const symbol = asJsonObject(raw);
	if (!symbol) return;
	const mutants = asJsonObject(symbol.mutants);
	if (!mutants) return;
	const name = str(symbol, "qualifiedName", "anonymous");
	for (const entry of Object.values(mutants)) {
		const view = mapMutant(entry, file, name);
		if (!view) continue;
		byStatus[view.status] = (byStatus[view.status] ?? 0) + 1;
		out.push(view);
	}
}

/** Parse manifest JSON text into a snapshot. Never throws. */
export function parseManifest(text: string): MutantSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		void err; /* mid-write or corrupt manifest — report nothing, not a crash */
		return emptySnapshot();
	}
	const root = asJsonObject(parsed);
	const files = root && asJsonObject(root.files);
	if (!root || !files) return emptySnapshot();

	const mutants: MutantView[] = [];
	const byStatus: Record<string, number> = {};
	for (const [file, symbols] of Object.entries(files)) {
		const bySymbol = asJsonObject(symbols);
		if (!bySymbol) continue;
		for (const symbol of Object.values(bySymbol)) collectSymbol(symbol, file, mutants, byStatus);
	}
	const generation = typeof root.generation === "number" ? root.generation : 0;
	return {
		generation,
		engine: str(root, "engine"),
		files: Object.keys(files).length,
		mutants: mutants.slice(0, MUTANT_CAP),
		byStatus,
		total: mutants.length,
	};
}

/** Read the manifest from disk, or an empty snapshot when absent/unreadable. */
export function readMutantSnapshot(path: string): MutantSnapshot {
	try {
		if (!existsSync(path)) return emptySnapshot();
		return parseManifest(readFileSync(path, "utf-8"));
	} catch (err) {
		void err; /* unreadable manifest is a no-data condition, not a failure */
		return emptySnapshot();
	}
}

/**
 * Diff two snapshots into per-mutant events: a mutant absent from `prev` was
 * `born`, one whose status changed `flip`ped. Disappearances are not reported —
 * a regenerated manifest drops identities routinely and the dashboard's wall
 * would flicker.
 */
export function diffSnapshots(prev: MutantSnapshot, next: MutantSnapshot): MutantEvent[] {
	const before = new Map(prev.mutants.map((m) => [m.id, m.status]));
	const events: MutantEvent[] = [];
	for (const mutant of next.mutants) {
		const was = before.get(mutant.id);
		if (was === undefined) events.push({ kind: "born", mutant });
		else if (was !== mutant.status) events.push({ kind: "flip", mutant, from: was });
	}
	return events;
}

/** Poll interval for the manifest — state file, so cheap mtime checks suffice. */
const MANIFEST_POLL_MS = 1000;

/** File mtime in ms, or 0 when the file is absent/unreadable. */
function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch (err) {
		void err; /* absent manifest — treated as "unchanged at time 0" */
		return 0;
	}
}

/**
 * Watch the manifest and deliver a `MutantEvent` for every change. Re-reads only
 * when the mtime moves, so the steady state costs one `stat` per interval. The
 * interval is unref'd so it never keeps the server alive on its own.
 */
export function createMutantWatcher(
	path: string,
	onEvent: (ev: MutantEvent) => void,
	intervalMs = MANIFEST_POLL_MS,
): { stop: () => void } {
	let seen = readMutantSnapshot(path);
	let mtime = mtimeOf(path);
	const iv = setInterval(() => {
		const now = mtimeOf(path);
		if (now === mtime) return;
		mtime = now;
		const next = readMutantSnapshot(path);
		for (const ev of diffSnapshots(seen, next)) onEvent(ev);
		seen = next;
	}, intervalMs);
	if (typeof iv.unref === "function") iv.unref();
	return { stop: () => clearInterval(iv) };
}
