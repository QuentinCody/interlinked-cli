// ===========================================
// Per-edit mutation — manifest I/O + the survivor-diff invariant (build step 2)
// ===========================================
// The persistent state and the set-diff that turns "no new changed-region
// survivor" from prose into code (spec §4–§5). The manifest is a sibling of the
// coverage index: a generation-stamped snapshot of per-symbol hashes + per-mutant
// statuses. Pure functions apart from the JSON load/save.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { isTestPath } from "../coverage-test-selector.js";
import type { SymbolHashEntry } from "./identity.js";
import { freshInstability, mutantIdsChurned, updateInstability } from "./instability.js";
import { healManifestFiles } from "./manifest-heal.js";
import { normalizeManifestKey } from "./manifest-key.js";
import type {
	MeasurementProvenance,
	MutantRecord,
	MutationManifest,
	MutationReceipt,
	StableId,
	SymbolRecord,
} from "./types.js";

export function mutationManifestPath(dir: string): string {
	return join(dir, "mutation-manifest.json");
}

// `normalizeManifestKey` moved to ./manifest-key.ts (2026-08-16) to break the
// manifest ↔ manifest-heal import cycle — it was the single VALUE edge the
// healer needed. Re-exported here for the many existing callers; its full
// docstring (the 2026-07-31 five-keys / seventeen-double-records defect
// history) moved with it.
export { normalizeManifestKey } from "./manifest-key.js";

/**
 * Thrown by `applyMeasuredRun` when the resolved key names a test/spec file.
 *
 * Mutating a test asks whether anything would notice a CHANGED TEST — the test
 * is the oracle, so the answer is always "no" and the measurement means
 * nothing (the same reasoning `gate.ts`'s `isMutationTarget` already applies
 * before a file is ever chosen as the primary edit target). This class existed
 * in the wild: 2 `.test.ts` keys were found in the live manifest on 2026-07-31,
 * written by `seedFileBaseline` (adopt.ts) — a caller with no test-file filter
 * of its own, upstream of `isMutationTarget`.
 *
 * Thrown, not silent: a test-file key reaching THIS point is a caller bug, not
 * a normal outcome, so it must be loud rather than quietly dropped (a silent
 * drop would hide exactly the caller defect that put it here). `evaluateMutation`
 * and `seedFileBaseline` both catch it and fold it into their EXISTING
 * "nothing to write" contracts (`unavailable` / `null`) — the daemon and the
 * CLI never see a raw throw, but a new caller that forgets to catch gets an
 * immediate, unambiguous failure instead of silent corruption.
 */
export class MutationManifestTestTargetError extends Error {
	constructor(public readonly key: string) {
		super(
			`mutation manifest: refusing to record a baseline for test file "${key}" — mutating a test proves nothing (the test is the oracle)`,
		);
		this.name = "MutationManifestTestTargetError";
	}
}

export interface ManifestMeta {
	engine: string;
	engineVersion: string;
	dependencyGraphVersion: string;
	environmentHash: string;
	authoritativeAt: string;
}

export function emptyManifest(meta: ManifestMeta): MutationManifest {
	return {
		version: 1,
		generation: 0,
		authoritativeAt: meta.authoritativeAt,
		engine: meta.engine,
		engineVersion: meta.engineVersion,
		dependencyGraphVersion: meta.dependencyGraphVersion,
		environmentHash: meta.environmentHash,
		files: {},
	};
}

/** Parsed-manifest cache, keyed by (path, mtimeMs, size). The daemon calls
 *  `loadManifest` on EVERY code-edit PreToolUse; at 46MB a fresh JSON.parse
 *  costs ~300MB transient heap per call — measured live 2026-07-28 as the
 *  rss-ceiling kill loop (daemon-events.jsonl: heap 1–1.9GB, back-to-back
 *  recycles). The manifest only changes on a measured-clean persist, so an
 *  unchanged file serves the same parsed object. One entry per path — a
 *  daemon serves one repo, and a second path simply evicts the previous. */
let manifestCache: {
	path: string;
	mtimeMs: number;
	size: number;
	manifest: MutationManifest;
} | null = null;

/** Drop the resident parsed manifest — public API for the daemon's
 *  idle-shrink path: an idle daemon should not stay a ~1GB jetsam target for
 *  the sake of a cache the next event rebuilds in ~200ms. */
export function clearManifestCache(): void {
	manifestCache = null;
}

function cachedManifest(path: string, mtimeMs: number, size: number): MutationManifest | null {
	if (!manifestCache) return null;
	const hit =
		manifestCache.path === path && manifestCache.mtimeMs === mtimeMs && manifestCache.size === size;
	return hit ? manifestCache.manifest : null;
}

/**
 * Validate + construct a manifest's top-level shell from parsed JSON.
 *
 * `version` and `files` are the only hard requirements — the exact two
 * fields the unchecked `as MutationManifest` cast this replaces already
 * gated (`raw.version !== 1 || !raw.files`), now checked for real
 * (object-shaped, not merely truthy). Every other scalar defaults rather
 * than rejects the whole manifest: a real manifest.json is written
 * EXCLUSIVELY by this codebase's own writers (`emptyManifest` /
 * `applyMeasuredRun` / `stampProvenance`), so those fields are always
 * well-typed in practice — the defaults are a backstop a real on-disk file
 * never exercises, never a silent rejection of a file the old code would
 * have accepted.
 *
 * `files`' and `fileProvenance`'s own VALUE shapes (SymbolRecord /
 * MutantRecord, MeasurementProvenance) are deliberately trusted, not
 * deep-validated field-by-field: `healManifestFiles` (called right after
 * this by `loadManifest`) already treats shape drift inside `files` as
 * missing per-file records, which every downstream consumer reads as "no
 * baseline" rather than crashing. Duplicating deep validation here would
 * risk this campaign's own known failure mode (silently dropping real rows)
 * on a manifest this repo runs its own per-edit mutation BLOCK gate against.
 */
function parseManifestShell(value: unknown): MutationManifest | null {
	if (!isJsonObject(value)) return null;
	if (value.version !== 1) return null;
	if (!isJsonObject(value.files)) return null;
	return {
		version: 1,
		generation: typeof value.generation === "number" ? value.generation : 0,
		authoritativeAt: typeof value.authoritativeAt === "string" ? value.authoritativeAt : "",
		engine: typeof value.engine === "string" ? value.engine : "",
		engineVersion: typeof value.engineVersion === "string" ? value.engineVersion : "",
		dependencyGraphVersion:
			typeof value.dependencyGraphVersion === "string" ? value.dependencyGraphVersion : "",
		environmentHash: typeof value.environmentHash === "string" ? value.environmentHash : "",
		...(typeof value.sourceRevision === "string" ? { sourceRevision: value.sourceRevision } : {}),
		// SAFETY: object-shape checked above; per-symbol/per-mutant fields are
		// trusted, not deep-validated — see docstring above.
		files: value.files as Record<string, Record<StableId, SymbolRecord>>,
		...(isJsonObject(value.fileProvenance) && {
			// SAFETY: isJsonObject proves object shape; per-entry provenance fields
			// are trusted like `files` above — this file is written exclusively by
			// this codebase's own writers (see parse docstring).
			fileProvenance: value.fileProvenance as Record<string, MeasurementProvenance>,
		}),
	};
}

// A short-lived `loadManifestStaleOk` (5-min stale-tolerant reader) bridged
// the 2026-08-16 daemon-killer window between diagnosing the per-Stop ~1.7GB
// manifest parse and landing the survivors-index sidecar
// (./survivors-index.ts). The sidecar removed every advisory consumer from
// this module, so the bridge was deleted the same day — advisory readers use
// the sidecar; only blocking gates load the manifest, and only off the hot
// path. History: repair-followups.txt #25.
/** Review 2026-08-28 item 4: "no manifest" and "a manifest I cannot read" are
 *  different facts. Collapsing both to null let a corrupt manifest flow into
 *  `emptyManifest(...)` at the production gate, where the next successful run
 *  ADOPTED a fresh floor over the damaged history — resetting the ratchet.
 *  Only `missing` may start adoption; `corrupt` must read as not-measured and
 *  leave the file in place for recovery. */
export type ManifestLoadState =
	| { kind: "missing" }
	| { kind: "valid"; manifest: MutationManifest }
	| { kind: "corrupt"; detail: string };

export function loadManifestState(dir: string): ManifestLoadState {
	const path = mutationManifestPath(dir);
	if (!existsSync(path)) return { kind: "missing" };
	try {
		const stat = statSync(path);
		const hit = cachedManifest(path, stat.mtimeMs, stat.size);
		if (hit) return { kind: "valid", manifest: hit };
		const shell = parseManifestShell(JSON.parse(readFileSync(path, "utf-8")));
		if (shell === null) {
			return { kind: "corrupt", detail: "manifest JSON parsed but does not match the manifest schema" };
		}
		// Repo root = the parent of the `.interlinked` dir this manifest lives in
		// (every caller passes `resolve(cwd, ".interlinked")` as `dir` — see
		// `normalizeManifestKey`'s docstring).
		const manifest: MutationManifest = { ...shell, files: healManifestFiles(shell.files, dirname(dir)) };
		manifestCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, manifest };
		return { kind: "valid", manifest };
	} catch (err) {
		return { kind: "corrupt", detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Legacy view: valid → manifest, anything else → null. Callers that must NOT
 *  treat corrupt as a fresh start (the production gate) use `loadManifestState`. */
export function loadManifest(dir: string): MutationManifest | null {
	const state = loadManifestState(dir);
	return state.kind === "valid" ? state.manifest : null;
}

/** Reader-side wording (Grok 2026-08-28 issue 19): "no manifest — measure
 *  first" is the WRONG steer when the file exists but is damaged — the record
 *  command now refuses over corrupt history, so the user needs the truth. */
export function corruptManifestMessage(dir: string, detail: string): string {
	return `Mutation manifest at ${join(dir, "mutation-manifest.json")} is CORRUPT (${detail}) — not "missing". The file is preserved for recovery; repair or remove it deliberately before measuring again.`;
}

/**
 * Stamp the conditions one file's records were measured under.
 *
 * Pure — returns a new manifest. Keyed through `normalizeManifestKey` like
 * every other manifest read/write, so an absolute path and a repo-relative one
 * stamp the SAME entry rather than two.
 */
export function stampProvenance(args: {
	manifest: MutationManifest;
	file: string;
	provenance: MeasurementProvenance;
	cwd?: string | undefined;
}): MutationManifest {
	const key = normalizeManifestKey(args.file, args.cwd ?? process.cwd());
	return {
		...args.manifest,
		fileProvenance: { ...(args.manifest.fileProvenance ?? {}), [key]: args.provenance },
	};
}

/** The conditions a file's records were measured under, or null when nothing
 *  recorded them — which is NOT the same as "measured under today's rules". */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for manifest path helpers (see manifest-key.ts); branded ManifestKey refactor is tracked work
export function provenanceOf(
	manifest: MutationManifest,
	file: string,
	cwd?: string,
): MeasurementProvenance | null {
	const key = normalizeManifestKey(file, cwd ?? process.cwd());
	return manifest.fileProvenance?.[key] ?? null;
}

export function saveManifest(dir: string, manifest: MutationManifest): void {
	const path = mutationManifestPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	// Compact on purpose: at manifest scale (46MB pretty / ~28MB compact for 730
	// files) the indent alone costs tens of MB of string churn on EVERY
	// measured-clean persist, and nobody reads this file by eye.
	writeFileSync(path, `${JSON.stringify(manifest)}\n`, "utf-8");
	// Prime the read cache with the object just written: without this every
	// persist invalidates the cache and the NEXT edit re-parses the whole file —
	// the cache would self-defeat under exactly the traffic it exists for.
	const stat = statSync(path);
	manifestCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, manifest };
}

// Read-side survivor-diff helpers moved to manifest-diff.ts (2026-08-25, line
// cap); re-exported so `from "./manifest.js"` importers are untouched.
export {
	acceptedSurvivors,
	changedSymbols,
	computeNewSurvivors,
	hasFileBaseline,
	missingUnchangedMutants,
	type MeasuredMutant,
	priorStatuses,
	quarantinedSymbols,
	type SurvivorDiffSets,
	toMutantRecord,
} from "./manifest-diff.js";
import { fileRecords, type MeasuredMutant, toMutantRecord } from "./manifest-diff.js";

// ============================================================
// Measured-run refresh + receipt persistence (spec §4/§12)
// ============================================================

/** Consecutive stable runs required before a quarantined symbol's identity is
 *  trusted (BLOCK-capable) again. Mirrors the coverage index's quarantine model. */
const QUARANTINE_STABILITY_THRESHOLD = 3;

interface RefreshSymbolArgs {
	prev: SymbolRecord | undefined;
	symbolId: StableId;
	entry: SymbolHashEntry;
	ms: MeasuredMutant[];
	at: string;
	threshold: number;
	/** The run measured a LINE RANGE, not the whole file (MeasuredRunArgs.partial). */
	partial?: boolean;
}

/** The symbol's next mutant map. A PARTIAL run's measured set is a floor, not
 *  a census (Stryker only emits mutants whose whole span fits the range), so
 *  under `partial` the prior records are retained and measured statuses win
 *  per mutantId — absent ids are never deleted. A full run replaces. */
// interlinked: defer function_arg_count -- private helper with one call site;
// the four params are distinct types readable at a glance, and an options
// object would only restate the RefreshSymbolArgs it was extracted from.
function nextMutantMap(
	prev: SymbolRecord | undefined,
	ms: MeasuredMutant[],
	at: string,
	partial: boolean,
): Record<StableId, MutantRecord> {
	const mutants: Record<StableId, MutantRecord> = partial && prev ? { ...prev.mutants } : {};
	for (const m of ms) {
		const firstSeen = prev?.mutants[m.identity.mutantId]?.firstSeen ?? at;
		mutants[m.identity.mutantId] = toMutantRecord(m.identity, m.status, firstSeen);
	}
	return mutants;
}

function refreshSymbol(args: RefreshSymbolArgs): SymbolRecord {
	const { prev, symbolId, entry, ms, at, threshold, partial } = args;
	// Differential runs skip unchanged symbols: no fresh measurements + same hash
	// → carry the prior record forward verbatim (don't discard knowledge).
	if (ms.length === 0 && prev && prev.symbolHash === entry.symbolHash) return prev;
	// PARTIAL-SCOPE LAUNDERING GUARD (external review 2026-08-23, third pass,
	// finding 1 — independently reproduced: prev knew m1+m2, a ranged run
	// emitted only m1, and this function dropped m2 while advancing the
	// generation). A CHANGED symbol under a partial run keeps its prior record
	// verbatim — only a full-scope run may replace it; with no prior record the
	// measured floor is adopted (all we know beats nothing).
	if (partial === true && prev !== undefined && prev.symbolHash !== entry.symbolHash) return prev;
	const mutants = nextMutantMap(prev, ms, at, partial === true);
	// Identity churn only counts against an UNCHANGED hash — a changed symbol is
	// EXPECTED to mint new mutant ids (spec §6 of the identity spec).
	const churned =
		prev !== undefined &&
		prev.symbolHash === entry.symbolHash &&
		mutantIdsChurned(prev, new Set(Object.keys(mutants)));
	const instability = updateInstability(prev?.instability ?? freshInstability(), { churned, at, threshold });
	return { symbolId, qualifiedName: entry.qualifiedName, symbolHash: entry.symbolHash, mutants, instability };
}

export interface MeasuredRunArgs {
	base: MutationManifest;
	file: string;
	overlayHashes: Map<StableId, SymbolHashEntry>;
	measured: MeasuredMutant[];
	at: string;
	/** Stable runs to clear a quarantine; defaults to {@link QUARANTINE_STABILITY_THRESHOLD}. */
	stabilityThreshold?: number;
	/** Repo root `file` resolves against when absolute. Defaults to `process.cwd()`
	 *  inside {@link normalizeManifestKey} — pass the daemon's actual `ctx.cwd`
	 *  when it can diverge from the process cwd (e.g. an explicit `--cwd`). */
	cwd?: string;
	/** True when the run measured a LINE RANGE rather than the whole file. A
	 *  partial run may only ADD knowledge (merge; changed symbols keep their
	 *  prior record) — it must never replace a symbol's complete record. */
	partial?: boolean;
}

/**
 * Fold a measured-clean run into the next manifest snapshot: fresh statuses +
 * hashes for every symbol in the overlay, `firstSeen` preserved across runs,
 * instability updated (churn under an unchanged hash → quarantine), symbols no
 * longer present dropped, generation bumped. Pure — the caller persists it, and
 * ONLY on a measured-clean allow (a dirty run must not launder the manifest).
 *
 * THE choke point (spec of this fix): `args.file` is normalized to the
 * canonical manifest key exactly once, here, via `normalizeManifestKey` — so
 * every real writer (the per-edit gate's `evaluateMutation` and the
 * brownfield-adoption `seedFileBaseline`) keys the SAME file identically
 * regardless of what shape of path it was handed. A resolved key that names a
 * test/spec file throws {@link MutationManifestTestTargetError} rather than
 * silently writing — see that class's docstring for why throw-and-catch (not
 * silent, not an uncaught crash) is the deliberate choice.
 */
export function applyMeasuredRun(args: MeasuredRunArgs): MutationManifest {
	const { base, overlayHashes, measured, at } = args;
	const file = normalizeManifestKey(args.file, args.cwd);
	if (isTestPath(file)) throw new MutationManifestTestTargetError(file);
	const threshold = args.stabilityThreshold ?? QUARANTINE_STABILITY_THRESHOLD;
	const prevFile = base.files[file] ?? {};
	const bySymbol = new Map<StableId, MeasuredMutant[]>();
	for (const m of measured) {
		const list = bySymbol.get(m.identity.symbolId) ?? [];
		list.push(m);
		bySymbol.set(m.identity.symbolId, list);
	}
	const nextFile: Record<StableId, SymbolRecord> = {};
	for (const [symbolId, entry] of overlayHashes) {
		nextFile[symbolId] = refreshSymbol({
			prev: prevFile[symbolId],
			symbolId,
			entry,
			ms: bySymbol.get(symbolId) ?? [],
			at,
			threshold,
			partial: args.partial === true,
		});
	}
	return { ...base, generation: base.generation + 1, authoritativeAt: at, files: { ...base.files, [file]: nextFile } };
}

export function mutationReceiptsPath(dir: string): string {
	return join(dir, "mutation-receipts.jsonl");
}

/** Append one receipt line. Two outcomes reach persistence — measured-clean
 *  passes AND first-sighting adoptions (spec §9/§12; 2026-08-28) — and the
 *  receipt's own `outcome` field says which. Findings/not-measured never do. */
export function appendReceipt(dir: string, receipt: MutationReceipt): void {
	const path = mutationReceiptsPath(dir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf-8");
}

/** fs persister for a persisting outcome (measured-clean or adoption):
 *  manifest snapshot + receipt line — in that order, with NO transaction
 *  (MUT-AC-11): a crash between the two leaves a manifest without its
 *  receipt, which is why the gate's failure wording says "PARTIAL". */
export function makeManifestPersister(
	dir: string,
): (manifest: MutationManifest, receipt: MutationReceipt) => void {
	return (manifest, receipt) => {
		saveManifest(dir, manifest);
		appendReceipt(dir, receipt);
	};
}
