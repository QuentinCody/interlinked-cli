// ===========================================
// Coverage index — persistent store
// ===========================================
// The on-disk side of the shard index
// (docs/design/incremental-per-edit-coverage-crap-ratchet.md section 8.2):
// one subtree per runner under `.interlinked/coverage-index/<runner-id>/`,
// holding the generation-stamped manifest plus one compressed contribution
// blob per shard. Machine-local runtime evidence — covered by the existing
// `.interlinked/*` gitignore, never committed.
//
// Atomicity contract (design doc section 12): every write goes through a temp
// file + atomic rename, so a crash can leave garbage temp files but never a
// torn accepted file; torn/corrupted data READS as absent (null) rather than
// throwing — "can't read" degrades to "no index" and the gate falls back to
// the full-run path. Manifest promotion is compare-and-swap on the accepted
// generation. The CAS is read-check-rename (no OS lock): one daemon per repo
// makes contention rare, and PostToolUse hash verification — not this file —
// is the integrity backstop that keeps a lost race from corrupting decisions.
// Multi-process hardening (O_EXCL generation files) can land later without
// changing callers.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JsonObject } from "../../lib/json-types.js";
import type {
	CanonicalCoverageElementSet,
	CoverageIndexManifest,
	InstabilityEvent,
	ShardInstability,
	ShardManifestEntry,
	ShardCoverageContribution,
} from "./types.js";

/**
 * Narrow ONCE at the boundary; every parser below reads a `JsonObject`, never
 * a bare `Record<string, unknown>`, and never re-derives this check.
 */
function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The per-runner store directory: `.interlinked/coverage-index/<runner-id>/`. */
export function storeDirFor(projectRoot: string, runnerId: string): string {
	return join(projectRoot, ".interlinked", "coverage-index", runnerId);
}

// ===========================================
// Contribution serialization (Map ↔ JSON)
// ===========================================

/** JSON shape of one file's element set — Maps flattened to entry arrays. */
interface SerializedElementSet {
	lines: [number, number][];
	branches: [string, number][];
	functions: [string, number][];
	statements?: [string, number][];
}

/** JSON shape of one shard contribution blob (before compression). */
interface SerializedContribution {
	version: 1;
	shardId: string;
	files: [string, SerializedElementSet][];
}

/** Flatten a contribution's Maps into the JSON-serializable blob shape. */
export function contributionToJson(
	contribution: ShardCoverageContribution,
): SerializedContribution {
	const files: [string, SerializedElementSet][] = [];
	for (const [file, set] of contribution.files) {
		const serialized: SerializedElementSet = {
			lines: [...set.lines],
			branches: [...set.branches],
			functions: [...set.functions],
		};
		if (set.statements) serialized.statements = [...set.statements];
		files.push([file, serialized]);
	}
	return { version: 1, shardId: contribution.shardId, files };
}

/** A `[key, hits]` entry array with numeric keys, or null when malformed. */
function numberKeyMap(raw: unknown): Map<number, number> | null {
	if (!Array.isArray(raw)) return null;
	const out = new Map<number, number>();
	for (const pair of raw) {
		if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "number") {
			return null;
		}
		out.set(pair[0], pair[1]);
	}
	return out;
}

/** A `[key, hits]` entry array with string keys, or null when malformed. */
function stringKeyMap(raw: unknown): Map<string, number> | null {
	if (!Array.isArray(raw)) return null;
	const out = new Map<string, number>();
	for (const pair of raw) {
		if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "number") {
			return null;
		}
		out.set(pair[0], pair[1]);
	}
	return out;
}

/** Revive one serialized element set, or null when any dimension is malformed. */
function elementSetFromJson(raw: unknown): CanonicalCoverageElementSet | null {
	if (!isPlainObject(raw)) return null;
	const lines = numberKeyMap(raw.lines);
	const branches = stringKeyMap(raw.branches);
	const functions = stringKeyMap(raw.functions);
	if (!lines || !branches || !functions) return null;
	const set: CanonicalCoverageElementSet = { lines, branches, functions };
	if (raw.statements !== undefined) {
		const statements = stringKeyMap(raw.statements);
		if (!statements) return null;
		set.statements = statements;
	}
	return set;
}

/**
 * Revive a contribution from its parsed JSON blob. Total / never throws:
 * any structural mismatch — wrong version, missing shard id, malformed entry
 * arrays — reads as null, and the caller treats the blob as absent.
 */
export function contributionFromJson(raw: unknown): ShardCoverageContribution | null {
	if (!isPlainObject(raw)) return null;
	if (raw.version !== 1 || typeof raw.shardId !== "string") return null;
	if (!Array.isArray(raw.files)) return null;
	const files = new Map<string, CanonicalCoverageElementSet>();
	for (const pair of raw.files) {
		if (!Array.isArray(pair) || typeof pair[0] !== "string") return null;
		const set = elementSetFromJson(pair[1]);
		if (!set) return null;
		files.set(pair[0], set);
	}
	return { shardId: raw.shardId, files };
}

// ===========================================
// Atomic file plumbing
// ===========================================

let tmpCounter = 0;

/** Write via temp file + atomic rename; throws on failure (callers catch). */
function atomicWrite(absPath: string, data: Buffer | string): void {
	mkdirSync(dirname(absPath), { recursive: true });
	const tmp = `${absPath}.tmp-${process.pid}-${tmpCounter++}`;
	try {
		writeFileSync(tmp, data);
		renameSync(tmp, absPath);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

// ===========================================
// Contribution blobs
// ===========================================

/** Locator + integrity pair for one stored contribution blob. */
interface ContributionBlobEntry {
	/** Store-relative POSIX path of the blob (`shards/<hash>.json.gz`). */
	contributionPath: string;
	/** sha256 hex of the compressed bytes — torn-write detection on read. */
	contributionChecksum: string;
}

/** Filesystem-safe blob name for a shard id (ids are test paths with slashes). */
function shardBlobName(shardId: string): string {
	return `${createHash("sha256").update(shardId).digest("hex").slice(0, 32)}.json.gz`;
}

/**
 * Serialize, compress, and atomically write one shard's contribution blob.
 * Returns the manifest-ready locator + checksum, or null on any write failure
 * (the store is bookkeeping — it must never crash the harness).
 */
export function writeContributionBlob(
	storeDir: string,
	contribution: ShardCoverageContribution,
): ContributionBlobEntry | null {
	try {
		const json = JSON.stringify(contributionToJson(contribution));
		const compressed = gzipSync(Buffer.from(json, "utf-8"));
		const relPath = `shards/${shardBlobName(contribution.shardId)}`;
		atomicWrite(join(storeDir, relPath), compressed);
		return { contributionPath: relPath, contributionChecksum: sha256Hex(compressed) };
	} catch {
		return null;
	}
}

/**
 * Read one contribution blob back through its checksum. Null on a missing
 * file, checksum mismatch (torn/corrupted blob), failed decompression, or a
 * malformed payload — every failure mode degrades to "no stored evidence",
 * which routes the caller to the full-run fallback (never a guessed block).
 */
export function readContributionBlob(
	storeDir: string,
	entry: ContributionBlobEntry,
): ShardCoverageContribution | null {
	let compressed: Buffer;
	try {
		compressed = readFileSync(join(storeDir, entry.contributionPath));
	} catch {
		return null;
	}
	if (sha256Hex(compressed) !== entry.contributionChecksum) return null;
	try {
		const parsed: unknown = JSON.parse(gunzipSync(compressed).toString("utf-8"));
		return contributionFromJson(parsed);
	} catch {
		return null;
	}
}

// ===========================================
// Manifest read + CAS promotion
// ===========================================

const MANIFEST_FILE = "manifest.json";

/** A string value, or null when `v` is not a string (kept distinct from "" being falsy). */
function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

/** `v` is a valid `Record<string, string>`, constructed fresh (never the input object). */
function parseStringRecord(v: unknown): Record<string, string> | null {
	if (!isPlainObject(v)) return null;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(v)) {
		if (typeof value !== "string") return null;
		out[key] = value;
	}
	return out;
}

/** `v` is a valid `string[]`. */
function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x): x is string => typeof x === "string");
}

/** `v` is one of the manifest's declared shard-boundary literals. */
function isShardBoundary(v: unknown): v is CoverageIndexManifest["shardBoundary"] {
	return v === "file" || v === "group" || v === "run";
}

/** Revive one instability event, or null when its shape is malformed. */
function parseInstabilityEvent(v: unknown): InstabilityEvent | null {
	if (!isPlainObject(v)) return null;
	const at = str(v.at);
	if (at === null) return null;
	if (v.kind !== "contribution_churn" && v.kind !== "pass_fail_flip") return null;
	return { at, kind: v.kind };
}

/**
 * Revive a shard's stability bookkeeping. Loose by design: an instability
 * block that is a plain object but omits its own fields (the pre-parser
 * contract only required "is an object" here) reads as "never observed
 * instability" rather than rejecting the whole shard entry — `staleShards`
 * and friends never read this field, so there is nothing to protect by
 * being stricter than the historical contract.
 */
function parseInstability(v: unknown): ShardInstability | null {
	if (!isPlainObject(v)) return null;
	const eventsRaw = Array.isArray(v.events) ? v.events : [];
	const events: InstabilityEvent[] = [];
	for (const raw of eventsRaw) {
		const event = parseInstabilityEvent(raw);
		if (!event) return null;
		events.push(event);
	}
	return {
		events,
		consecutiveStableRuns: typeof v.consecutiveStableRuns === "number" ? v.consecutiveStableRuns : 0,
		quarantined: v.quarantined === true,
	};
}

/**
 * Validate + construct ONE shard entry. The manifest's `shards` is a
 * `Record<string, ShardManifestEntry>`; verifying the field is an object was
 * NOT enough — `{shards:{bad:null}}` passed, was returned as authoritative,
 * and the first consumer to iterate it (`staleShards` → `Object.entries(null)`)
 * threw instead of degrading to the documented full-run fallback (finding
 * 2026-06, round 7). Each consumed field is type-checked here at the read
 * boundary so a corrupt entry rejects the whole manifest.
 */
function parseShardEntry(v: unknown): ShardManifestEntry | null {
	if (!isPlainObject(v)) return null;
	const shardId = str(v.shardId);
	if (shardId === null) return null;
	if (!isStringArray(v.testPaths)) return null;
	const testContentHashes = parseStringRecord(v.testContentHashes);
	if (!testContentHashes) return null;
	const dependencyHashes = parseStringRecord(v.dependencyHashes);
	if (!dependencyHashes) return null;
	if (typeof v.lastDurationMs !== "number") return null;
	const contributionPath = str(v.contributionPath);
	const contributionChecksum = str(v.contributionChecksum);
	if (contributionPath === null || contributionChecksum === null) return null;
	if (v.passed !== null && typeof v.passed !== "boolean") return null;
	const instability = parseInstability(v.instability);
	if (!instability) return null;
	return {
		shardId,
		testPaths: v.testPaths,
		testContentHashes,
		dependencyHashes,
		lastDurationMs: v.lastDurationMs,
		contributionPath,
		contributionChecksum,
		passed: v.passed,
		instability,
	};
}

/** Every shard entry, constructed and validated, or null if any one entry is corrupt. */
function parseShardMap(v: unknown): Record<string, ShardManifestEntry> | null {
	if (!isPlainObject(v)) return null;
	const shards: Record<string, ShardManifestEntry> = {};
	for (const [key, value] of Object.entries(v)) {
		const entry = parseShardEntry(value);
		if (!entry) return null;
		shards[key] = entry;
	}
	return shards;
}

/** The manifest's required string-valued fields, or null if any is missing/non-string. */
function parseRequiredManifestStrings(v: JsonObject): Omit<
	CoverageIndexManifest,
	"version" | "generation" | "shardBoundary" | "shards" | "sourceRevision"
> | null {
	const authoritativeAt = str(v.authoritativeAt);
	if (authoritativeAt === null) return null;
	const runnerId = str(v.runnerId);
	if (runnerId === null) return null;
	const runnerVersion = str(v.runnerVersion);
	if (runnerVersion === null) return null;
	const coverageEngine = str(v.coverageEngine);
	if (coverageEngine === null) return null;
	const coverageConfigHash = str(v.coverageConfigHash);
	if (coverageConfigHash === null) return null;
	const testDiscoveryHash = str(v.testDiscoveryHash);
	if (testDiscoveryHash === null) return null;
	const dependencyGraphVersion = str(v.dependencyGraphVersion);
	if (dependencyGraphVersion === null) return null;
	const environmentHash = str(v.environmentHash);
	if (environmentHash === null) return null;
	return {
		authoritativeAt,
		runnerId,
		runnerVersion,
		coverageEngine,
		coverageConfigHash,
		testDiscoveryHash,
		dependencyGraphVersion,
		environmentHash,
	};
}

/**
 * Validate + construct the manifest from its parsed JSON, or null when
 * absent/torn — a malformed manifest degrades to "no index" (full-run
 * fallback + eventual re-initialization), never an exception. Validation
 * extends to EACH shard entry, not just the top-level shape: a single
 * corrupt entry rejects the whole manifest, because consumers iterate
 * entries assuming the typed shape (finding 2026-06, round 7).
 */
function parseManifest(raw: unknown): CoverageIndexManifest | null {
	if (!isPlainObject(raw)) return null;
	if (raw.version !== 1) return null;
	if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation)) return null;
	const strings = parseRequiredManifestStrings(raw);
	if (!strings) return null;
	if (!isShardBoundary(raw.shardBoundary)) return null;
	if (raw.sourceRevision !== undefined && typeof raw.sourceRevision !== "string") return null;
	const shards = parseShardMap(raw.shards);
	if (!shards) return null;
	const base: CoverageIndexManifest = {
		version: 1,
		generation: raw.generation,
		...strings,
		shardBoundary: raw.shardBoundary,
		shards,
	};
	return raw.sourceRevision === undefined ? base : { ...base, sourceRevision: raw.sourceRevision };
}

/**
 * The accepted manifest for a runner's store, or null when absent/torn/
 * malformed — see {@link parseManifest} for the validation contract.
 */
export function readAcceptedManifest(storeDir: string): CoverageIndexManifest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(storeDir, MANIFEST_FILE), "utf-8"));
	} catch {
		return null;
	}
	return parseManifest(raw);
}

/**
 * Compare-and-swap manifest promotion (design doc section 12). Succeeds only
 * when the CURRENT accepted generation equals `expectedGeneration` (null =
 * "no manifest yet", including a torn one) AND the candidate's generation is
 * exactly the successor — a staged result computed against a parent that has
 * since advanced must rebase or discard, never overwrite. Returns false on a
 * lost race or write failure; the accepted manifest is untouched either way.
 */
export function promoteManifest(
	storeDir: string,
	next: CoverageIndexManifest,
	expectedGeneration: number | null,
): boolean {
	const current = readAcceptedManifest(storeDir);
	const currentGeneration = current?.generation ?? null;
	if (currentGeneration !== expectedGeneration) return false;
	if (next.generation !== (expectedGeneration ?? 0) + 1) return false;
	try {
		atomicWrite(join(storeDir, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}
