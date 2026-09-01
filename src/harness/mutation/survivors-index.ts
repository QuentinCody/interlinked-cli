/**
 * The survivors-index SIDECAR — the daemon's read model for mutation results.
 *
 * WHY THIS FILE EXISTS (repair-followups #25; daemon deaths 2026-08-16):
 * `mutation-manifest.json` is ~44MB of per-mutant records. A fresh
 * `JSON.parse` of it allocates ~1.7GB of transient heap and the parsed object
 * stays ~1.7GB RESIDENT in `manifest.ts`'s cache. The daemon's Stop check does
 * not need any of that — it needs "when was this measured" and, for future
 * consumers, "which mutants survived in file X". `loadManifestStaleOk` only
 * lowered the re-parse FREQUENCY; this module removes the manifest from the
 * daemon hot path ENTIRELY.
 *
 * The sidecar carries survivor mutant IDS and per-file counts only — never a
 * full `MutantRecord` (mutator, lexemes, replacement, events and dispositions
 * are the bulk). That is the whole size argument: hundreds of KB, not 44MB.
 *
 * FRESHNESS CONTRACT: the sidecar is written in the SAME operation as the
 * manifest, at every persist site (`makeManifestPersisterWithIndex` for the
 * per-edit gate, the explicit call in `commands/mutation-measure-support.ts`
 * for the CLI measure/sweep path) — never on a separate cadence. A reader that
 * wants to PROVE it is looking at the current snapshot compares
 * {@link SurvivorsIndex.generation} against the manifest's own
 * ({@link survivorsIndexMatchesGeneration}); a mismatch means someone persisted
 * the manifest through a path that skipped the sidecar.
 *
 * This module deliberately does NOT import `manifest.ts`: the whole point is
 * that a daemon Stop path can reach survivor data without linking the 44MB
 * loader and its resident cache into the same call graph.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MutantRecord, MutationManifest, StableId, SymbolRecord } from "./types.js";

/** Bumped only on a BREAKING shape change; a reader that sees a version it does
 *  not know treats the file as absent (silent, zero-FP) rather than guessing. */
export const SURVIVORS_INDEX_VERSION = 1;

/** Per-file survivor summary. Counts are over measured mutants in that file. */
export interface SurvivorsIndexFileEntry {
	/** `mutantId`s whose status is exactly `"survived"` — the raw engine signal.
	 *  Dispositioned survivors (accepted-equivalent, dead-code) are INCLUDED:
	 *  a disposition is a judgement layer that lives in the manifest, and a
	 *  sidecar consumer asking "did anything survive here" wants the mechanical
	 *  answer. Records already flipped to `status: "equivalent"` are not
	 *  survivors and do not appear. */
	survivors: StableId[];
	/** Every mutant record for the file, all statuses. */
	mutantCount: number;
	/** Mutants with status exactly `"killed"`. `timeout` / `uncovered` /
	 *  `equivalent` / `indeterminate` are counted in neither field — they are
	 *  recoverable as a lump from `mutantCount - survivors.length - killed`,
	 *  which is all any sidecar consumer has needed. */
	killed: number;
}

export interface SurvivorsIndex {
	version: number;
	/** ISO timestamp of THIS derivation. */
	generatedAt: string;
	/** The manifest generation this was folded from — the drift key. */
	generation: number;
	/** Mirrors `MutationManifest.authoritativeAt`: the measurement run's own
	 *  timestamp. Carried because it is the ONE manifest field the Stop check
	 *  reads; without it, switching that check off the manifest is impossible. */
	authoritativeAt: string;
	/** Manifest key (repo-relative POSIX path) → summary. Keys are copied
	 *  verbatim, so they are already `normalizeManifestKey`d by the writer. */
	files: Record<string, SurvivorsIndexFileEntry>;
}

export function survivorsIndexPath(dir: string): string {
	return join(dir, "mutation-survivors-index.json");
}

function foldSymbol(symbol: SymbolRecord | undefined, entry: SurvivorsIndexFileEntry): void {
	// `symbol.mutants` is declared `Record<StableId, MutantRecord>`, but this
	// fold runs over manifests built in memory (never healed by
	// `loadManifest`), so a caller-constructed manifest can genuinely violate
	// that shape at runtime (see the malformed-shape tests in
	// survivors-index.test.ts). Treat it as `unknown` and validate rather than
	// trusting the declared type.
	const mutants: unknown = symbol?.mutants;
	if (!mutants || typeof mutants !== "object") return;
	for (const mutant of Object.values(mutants as Record<string, unknown>)) {
		if (!mutant || typeof mutant !== "object") continue;
		const m = mutant as MutantRecord;
		entry.mutantCount++;
		if (m.status === "survived") entry.survivors.push(m.mutantId);
		else if (m.status === "killed") entry.killed++;
	}
}

/**
 * Pure fold: manifest → sidecar. No I/O, and no clock beyond the injectable
 * `at`.
 *
 * Defensive about record shape on purpose — this runs over manifests built in
 * memory (which never pass through `loadManifest`'s healer), and a malformed
 * symbol must yield a smaller index, never a throw at the persist site that
 * would abort the manifest write itself.
 */
export function deriveSurvivorsIndex(manifest: MutationManifest, at?: string): SurvivorsIndex {
	const files: Record<string, SurvivorsIndexFileEntry> = {};
	const source = manifest.files;
	for (const key of Object.keys(source)) {
		const entry: SurvivorsIndexFileEntry = { survivors: [], mutantCount: 0, killed: 0 };
		const symbols = source[key];
		if (symbols && typeof symbols === "object") {
			for (const symbol of Object.values(symbols)) foldSymbol(symbol, entry);
		}
		files[key] = entry;
	}
	return {
		version: SURVIVORS_INDEX_VERSION,
		// interlinked: defer untestable_time_in_source -- `at` is the injection seam; tests pass it.
		generatedAt: at ?? new Date().toISOString(),
		generation: manifest.generation,
		authoritativeAt: manifest.authoritativeAt,
		files,
	};
}

interface IndexCacheEntry {
	path: string;
	mtimeMs: number;
	size: number;
	index: SurvivorsIndex;
}
let indexCache: IndexCacheEntry | null = null;

/**
 * Derive + write the sidecar next to the manifest. Returns what it wrote, so a
 * caller can assert on it without a re-read.
 *
 * Primes the read cache with the object just written, exactly as `saveManifest`
 * does: without it every persist invalidates the cache and the next reader
 * re-parses — the cache would self-defeat under the traffic it exists for.
 */
export function writeSurvivorsIndex(
	dir: string,
	manifest: MutationManifest,
	at?: string,
): SurvivorsIndex {
	const index = deriveSurvivorsIndex(manifest, at);
	const path = survivorsIndexPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(index)}\n`, "utf-8");
	const stat = statSync(path);
	indexCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, index };
	return index;
}

function parseFileEntry(value: unknown): SurvivorsIndexFileEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	// SAFETY: object-shape checked immediately above; every field read below is
	// individually type-guarded before it reaches the returned entry.
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.survivors)) return null;
	if (typeof raw.mutantCount !== "number" || typeof raw.killed !== "number") return null;
	const survivors: StableId[] = [];
	for (const id of raw.survivors) if (typeof id === "string") survivors.push(id);
	return { survivors, mutantCount: raw.mutantCount, killed: raw.killed };
}

/** Constructed parser at the JSON boundary — never a bare cast (repo boundary
 *  convention). A file that fails any check reads as ABSENT, never as empty:
 *  "no sidecar" is silent, while an "empty sidecar" would assert that nothing
 *  survived anywhere. */
export function parseSurvivorsIndex(value: unknown): SurvivorsIndex | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	// SAFETY: object-shape checked above; each field is type-guarded before use.
	const raw = value as Record<string, unknown>;
	if (raw.version !== SURVIVORS_INDEX_VERSION) return null;
	if (typeof raw.generation !== "number") return null;
	if (typeof raw.generatedAt !== "string" || typeof raw.authoritativeAt !== "string") return null;
	if (typeof raw.files !== "object" || raw.files === null || Array.isArray(raw.files)) return null;
	const files: Record<string, SurvivorsIndexFileEntry> = {};
	// SAFETY: `raw.files` proven a non-array object above; entry values are
	// validated one at a time by `parseFileEntry`, which rejects on any drift.
	for (const [key, entryValue] of Object.entries(raw.files as Record<string, unknown>)) {
		const entry = parseFileEntry(entryValue);
		if (entry === null) return null;
		files[key] = entry;
	}
	return {
		version: SURVIVORS_INDEX_VERSION,
		generatedAt: raw.generatedAt,
		generation: raw.generation,
		authoritativeAt: raw.authoritativeAt,
		files,
	};
}

/**
 * Read the sidecar, with its own mtime+size cache. Cheap by construction — the
 * file is hundreds of KB, so even a cache MISS is a rounding error next to the
 * manifest parse this replaces.
 *
 * Returns null when the file is absent, unreadable, or malformed. Every daemon
 * consumer must read null as "cannot tell" and stay SILENT.
 */
export function loadSurvivorsIndex(dir: string): SurvivorsIndex | null {
	const path = survivorsIndexPath(dir);
	if (!existsSync(path)) return null;
	try {
		const stat = statSync(path);
		if (
			indexCache &&
			indexCache.path === path &&
			indexCache.mtimeMs === stat.mtimeMs &&
			indexCache.size === stat.size
		) {
			return indexCache.index;
		}
		const parsed = parseSurvivorsIndex(JSON.parse(readFileSync(path, "utf-8")));
		if (parsed === null) return null;
		indexCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, index: parsed };
		return parsed;
	} catch {
		return null;
	}
}

/** Survivor ids for one manifest key, or null when the sidecar has no entry for
 *  it (never measured) — distinct from `[]`, which means "measured, and nothing
 *  survived". */
export function survivorsForFile(index: SurvivorsIndex, key: string): StableId[] | null {
	return index.files[key]?.survivors ?? null;
}

/** Drift check: is this sidecar the fold of THAT manifest snapshot? False means
 *  someone persisted the manifest through a path that skipped the sidecar. */
export function survivorsIndexMatchesGeneration(
	index: SurvivorsIndex,
	manifest: Pick<MutationManifest, "generation">,
): boolean {
	return index.generation === manifest.generation;
}

/**
 * Decorate an existing manifest persister so the sidecar is written in the same
 * operation, write-after-write. Wrapping the caller's persister (rather than
 * importing `saveManifest` here) is what keeps the 44MB loader out of this
 * module's import graph — see the module docstring.
 */
export function makeManifestPersisterWithIndex<R>(
	dir: string,
	base: (manifest: MutationManifest, receipt: R) => void,
): (manifest: MutationManifest, receipt: R) => void {
	return (manifest, receipt) => {
		base(manifest, receipt);
		writeSurvivorsIndex(dir, manifest);
	};
}
