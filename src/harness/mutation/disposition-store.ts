// ===========================================
// Per-edit mutation — the durable disposition sidecar ledger (plan 18 M0)
// ===========================================
// A typed disposition (dead_code / unresolved / …) used to live on the manifest's
// `MutantRecord.disposition`. Two probe-proven findings force it OFF the manifest
// and into this sidecar (spec docs/plans/18-mutation-disposition-registration.md):
//
//   §1.3  a re-measure DESTROYS every manifest-stored disposition. `applyMeasuredRun`
//         rebuilds each MutantRecord from identity+status and copies neither
//         `disposition` nor `accepted_reason`, so an acceptance the manifest held
//         with an UNCHANGED symbol hash silently reverted on the next sweep. The
//         half-life of a manifest-written judgment was minutes to hours.
//   §1.4  the manifest's `disposition` field is an open GAMING surface — the
//         baseline gate only compared the accepted-survivor SET, so a hand-added
//         disposition on an existing survivor left that set byte-identical and
//         removed the survivor from the work-list with zero blocks.
//
// So dispositions live here, in `.interlinked/mutation-dispositions.json`: a
// committed sidecar the measurement pipeline does not own (immune to §1.3 by
// construction) and monotonic under baseline_integrity_gate (immune to §1.4 —
// see disposition-ledger-gate.ts). The manifest field stays as a legacy read
// path (`dispositionOf`); this ledger is the system of record.
//
// Pure functions apart from load/save. No model, no clock of its own (the caller
// injects `now`). Absent-by-default: a repo with no mutation runner sees an empty
// ledger and every consumer renders an honest empty state.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { parseDisposition, type SurvivorDisposition, type SurvivorDispositionKind } from "./disposition.js";
import type { MutationManifest, StableId, SymbolRecord } from "./types.js";

/** One adjudication, bound to the exact code state it was made against. */
export interface DispositionRecord {
	/** Canonical manifest key of the mutated file. */
	file: string;
	/** Enclosing symbol id — half of the storage key, and the invalidation anchor. */
	symbolId: StableId;
	/** The mutant this judgment answers. */
	mutantId: StableId;
	/**
	 * THE invalidation key: the enclosing symbol's normalized-source hash when the
	 * judgment was made. A record whose hash no longer matches the manifest is
	 * STALE — retained as history, never applied (see {@link isLive}).
	 */
	symbolHash: string;
	/** Denormalized for human review only. Never an identity input. */
	qualifiedName: string;
	mutator: string;
	disposition: SurvivorDisposition;
	/**
	 * Cyclomatic points that REMOVING the mutated code would save — the
	 * weak-model-legibility gain of deleting a `dead_code` survivor, so the
	 * removal-candidate list can sort by terraforming payoff (Goal 4 / agent
	 * terraforming; docs/design/agent-terraforming-checks.md). Null in M0; M1
	 * computes it via computeCyclomaticComplexity (src/harness/checks/cyclomatic.ts).
	 */
	complexity_delta: number | null;
	/** ISO timestamp the caller injected. */
	recordedAt: string;
	/** Who wrote it: agent name, session id, or `cli:<command>`. Provenance, not authority. */
	recordedBy: string;
}

export interface DispositionLedger {
	version: 1;
	/** Human-facing policy note, mirroring check-corpus.json's. */
	note: string;
	/** Fingerprint of the manifest these records were adjudicated against. */
	environmentHash: string;
	dependencyGraphVersion: string;
	/** Sorted by (file, symbolId, mutantId) so the committed diff is stable. */
	records: DispositionRecord[];
}

/** How much nagging a kind removes. THE gaming-relevant axis — not epistemics. */
export type SuppressionLevel = 0 | 1 | 2;

const LEDGER_NOTE =
	"Mutation adjudication ledger (plan 18). The durable record of WHY a survivor is not a defect. " +
	"Monotonic under baseline_integrity_gate: records may be removed or weakened by hand, never added or strengthened.";

const LEDGER_BASENAME = "mutation-dispositions.json";

// ===========================================
// Suppression level — the one axis the gate ratchets on
// ===========================================

// Keyed by kind so adding a member without deciding its suppression fails to
// compile — the same discipline `EQUIVALENCE_REFUSALS` uses in disposition.ts.
//
//  0  unresolved: records evidence, suppresses nothing. Honours disposition.ts
//     §188-189 ("recording must not silence the gate"). A level-0 record is NEVER
//     applied to the manifest by withDispositions, so an evidence-carrying
//     `unresolved` survivor STAYS in the work-list.
//  1  dead_code / duplicate / accepted_risk / outside_contract / proved_unreachable:
//     removed from the default work-list; status untouched; the per-edit gate
//     still blocks (the resolution is a source change, not an annotation).
//  2  proved_equivalent: reaches status "equivalent" and the gate's accepted
//     floor. Unreachable via this store (refused until M5 — see refuseRecord).
const SUPPRESSION_LEVELS: Record<SurvivorDispositionKind, SuppressionLevel> = {
	killed: 0,
	unresolved: 0,
	dead_code: 1,
	duplicate: 1,
	accepted_risk: 1,
	outside_contract: 1,
	proved_unreachable: 1,
	proved_equivalent: 2,
};

export function suppressionLevel(d: SurvivorDisposition): SuppressionLevel {
	return SUPPRESSION_LEVELS[d.kind];
}

// ===========================================
// Refusal — store-level rules, each closing a §1 hole
// ===========================================

/** Refusal text for a record the store will not accept, or null when it may. */
export function refuseRecord(record: DispositionRecord): string | null {
	const d = record.disposition;
	if (d.kind === "killed") {
		return "a killed mutant is not a judgment — nothing is being recorded (disposition.ts:176).";
	}
	if (d.kind === "proved_equivalent") {
		return "proved_equivalent must go through `mutation accept` (a verifier-issued certificate), and its durable status side does not exist yet — refused in M0.";
	}
	if (d.kind === "unresolved" && d.evidence === undefined) {
		return "a bare `unresolved` records no judgment — attach counterexample-search evidence (--strategy/--runs) or record nothing. The absence of a judgment is not a record.";
	}
	return null;
}

// ===========================================
// Invalidation — one predicate, one place
// ===========================================

/** Is this record still bound to the manifest's current state? Live iff the
 *  manifest's `files[file][symbolId].symbolHash` equals the record's. A changed
 *  hash, an absent symbol, or an absent file all read as STALE — retained, never
 *  applied (spec §3.4). Strictly stricter than the manifest's own carry-forward,
 *  which §1.3 showed drops a disposition even when the hash is unchanged. */
export function isLive(record: DispositionRecord, manifest: MutationManifest): boolean {
	const symbol = manifest.files[record.file]?.[record.symbolId];
	if (!symbol) return false;
	return symbol.symbolHash === record.symbolHash;
}

// ===========================================
// Record construction — the invalidation key comes from the manifest, never a flag
// ===========================================

/** Repo-relative, forward-slash, no leading "./". A dependency-light echo of
 *  manifest.ts's `normalizeManifestKey` for the common (repo-relative) input —
 *  the CLI's `findMutantRecord` existence check runs the full normalizer first,
 *  so an exotic (absolute) path is rejected there before this is reached. */
function lightNormalize(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

interface LocatedMutant {
	fileKey: string;
	symbolId: StableId;
	symbol: SymbolRecord;
	mutator: string;
}

/** Find the mutant in the manifest, returning the CANONICAL file key it lives
 *  under (so a record's `file` is always a real manifest key). File-scoped like
 *  accept.ts's `locate`, matched on the normalized path. */
function locateMutant(manifest: MutationManifest, file: string, mutantId: string): LocatedMutant | null {
	const want = lightNormalize(file);
	for (const [fileKey, symbolMap] of Object.entries(manifest.files)) {
		if (lightNormalize(fileKey) !== want) continue;
		for (const [symbolId, symbol] of Object.entries(symbolMap)) {
			const mutant = symbol.mutants[mutantId];
			if (mutant) return { fileKey, symbolId, symbol, mutator: mutant.mutator };
		}
	}
	return null;
}

export interface MakeRecordArgs {
	manifest: MutationManifest;
	/** File as the caller spelled it; resolved to the canonical manifest key here. */
	file: string;
	mutantId: string;
	disposition: SurvivorDisposition;
	/** Provenance, not authority. */
	recordedBy: string;
	/** Injected clock — the store keeps none of its own. */
	now: () => string;
}

/**
 * Build a record from the disposition + the manifest-resolved invalidation key,
 * or null when the manifest holds no such mutant (a disposition for a mutant
 * nobody measured is a typo). `symbolId` / `symbolHash` / `qualifiedName` /
 * `mutator` come from the manifest at write time — the CLI must NOT accept them
 * from a flag, or the invalidation key could be forged. `complexity_delta` is
 * null in M0.
 */
export function makeRecord(args: MakeRecordArgs): DispositionRecord | null {
	const found = locateMutant(args.manifest, args.file, args.mutantId);
	if (!found) return null;
	return {
		file: found.fileKey,
		symbolId: found.symbolId,
		mutantId: args.mutantId,
		symbolHash: found.symbol.symbolHash,
		qualifiedName: found.symbol.qualifiedName,
		mutator: found.mutator,
		disposition: args.disposition,
		complexity_delta: null,
		recordedAt: args.now(),
		recordedBy: args.recordedBy,
	};
}

// ===========================================
// Upsert — pure, keyed by (file, symbolId, mutantId), refusal-gated
// ===========================================

/** A JSON-array storage key: unambiguous and printable regardless of what a path
 *  or id contains. (A raw separator char is a trap — one was once corrupted into a
 *  NUL byte, which flags the file binary and defeats rg; never reintroduce one.) */
function recordKey(file: string, symbolId: string, mutantId: string): string {
	return JSON.stringify([file, symbolId, mutantId]);
}

function sortRecords(records: DispositionRecord[]): DispositionRecord[] {
	return [...records].sort((a, b) =>
		recordKey(a.file, a.symbolId, a.mutantId).localeCompare(recordKey(b.file, b.symbolId, b.mutantId)),
	);
}

export interface UpsertArgs {
	ledger: DispositionLedger;
	record: DispositionRecord;
}

/** Insert or replace by (file, symbolId, mutantId). Pure. Null when the record is
 *  refused ({@link refuseRecord}). Records stay sorted for a stable diff. */
export function upsertRecord(args: UpsertArgs): DispositionLedger | null {
	if (refuseRecord(args.record) !== null) return null;
	const key = recordKey(args.record.file, args.record.symbolId, args.record.mutantId);
	const kept = args.ledger.records.filter(
		(r) => recordKey(r.file, r.symbolId, r.mutantId) !== key,
	);
	return { ...args.ledger, records: sortRecords([...kept, args.record]) };
}

// ===========================================
// Read-join — apply live, suppressing records onto a manifest COPY
// ===========================================

/**
 * A copy of `manifest` with every LIVE, SUPPRESSING (level >= 1) record's
 * disposition written onto its `MutantRecord`, so the existing survivors read
 * path (`dispositionOf` → `isOpenSurvivor`) drops it from the work-list with NO
 * edit to survivors.ts. Level-0 (`unresolved`) records are deliberately NOT
 * applied — that is what keeps an evidence-carrying survivor visible (closes the
 * §1.5.1 bug where a bare `unresolved` silenced the gate). Pure: the on-disk
 * manifest is never rewritten, and the shared cached manifest object is never
 * mutated (copy-on-write, touched paths only). Short-circuits to the same object
 * when nothing applies — no 37MB copy on the common empty-ledger path.
 */
export function withDispositions(manifest: MutationManifest, ledger: DispositionLedger): MutationManifest {
	const applicable = ledger.records.filter(
		(r) => suppressionLevel(r.disposition) >= 1 && isLive(r, manifest),
	);
	if (applicable.length === 0) return manifest;
	const files: Record<string, Record<StableId, SymbolRecord>> = { ...manifest.files };
	for (const r of applicable) {
		const symbolMap = files[r.file];
		const symbol = symbolMap?.[r.symbolId];
		const mutant = symbol?.mutants[r.mutantId];
		if (!symbolMap || !symbol || !mutant) continue;
		files[r.file] = {
			...symbolMap,
			[r.symbolId]: {
				...symbol,
				mutants: { ...symbol.mutants, [r.mutantId]: { ...mutant, disposition: r.disposition } },
			},
		};
	}
	return { ...manifest, files };
}

// ===========================================
// Persistence — I/O boundary; untrusted JSON on read
// ===========================================

function dispositionLedgerPath(configDir: string): string {
	return join(configDir, LEDGER_BASENAME);
}

function emptyLedger(): DispositionLedger {
	return { version: 1, note: LEDGER_NOTE, environmentHash: "", dependencyGraphVersion: "", records: [] };
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Parse ONE untrusted record; null (dropped on load) for anything malformed. The
 *  edit-time gate catches a hand-ADDED record from the raw JSON before it ever
 *  reaches this loader, so dropping garbage here is safe, not a blind spot. */
function parseRecord(value: unknown): DispositionRecord | null {
	if (!isJsonObject(value)) return null;
	const file = str(value.file);
	const symbolId = str(value.symbolId);
	const mutantId = str(value.mutantId);
	const symbolHash = str(value.symbolHash);
	if (!file || !symbolId || !mutantId || !symbolHash) return null;
	const disposition = parseDisposition(value.disposition);
	if (!disposition) return null;
	return {
		file,
		symbolId,
		mutantId,
		symbolHash,
		qualifiedName: str(value.qualifiedName) ?? "",
		mutator: str(value.mutator) ?? "",
		disposition,
		complexity_delta: typeof value.complexity_delta === "number" ? value.complexity_delta : null,
		recordedAt: str(value.recordedAt) ?? "",
		recordedBy: str(value.recordedBy) ?? "",
	};
}

/** The ledger on disk, or an honest empty one when absent / unparseable. */
export function loadLedger(configDir: string): DispositionLedger {
	const path = dispositionLedgerPath(configDir);
	if (!existsSync(path)) return emptyLedger();
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isJsonObject(raw)) return emptyLedger();
		const records = Array.isArray(raw.records)
			? raw.records.map(parseRecord).filter((r): r is DispositionRecord => r !== null)
			: [];
		return {
			version: 1,
			note: str(raw.note) ?? LEDGER_NOTE,
			environmentHash: str(raw.environmentHash) ?? "",
			dependencyGraphVersion: str(raw.dependencyGraphVersion) ?? "",
			records: sortRecords(records),
		};
	} catch {
		return emptyLedger();
	}
}

/** Persist the ledger. Pretty-printed (small + human-reviewed, unlike the compact
 *  manifest) so the committed diff is legible. This is an INTERNAL fs write — it
 *  never touches the Write/Edit tools, so it never reaches the baseline gate, the
 *  same exemption every ratchet raise relies on. */
export function saveLedger(configDir: string, ledger: DispositionLedger): void {
	const path = dispositionLedgerPath(configDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...ledger, records: sortRecords(ledger.records) }, null, 2)}\n`, "utf-8");
}
