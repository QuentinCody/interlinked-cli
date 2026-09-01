// ===========================================
// Coverage index — validity hashing + invalidation
// ===========================================
// Section 11 of docs/design/incremental-per-edit-coverage-crap-ratchet.md:
// the index is evidence, and evidence is only block-authoritative while every
// input that could change coverage still matches what was indexed. Three
// granularities, all content-hash based (timestamps are never validity
// proofs):
//
//   - WHOLE INDEX  — runner/engine versions, coverage + discovery config,
//     environment fingerprint, shard boundary, dependency-graph version
//     ({@link manifestValidity}). Any mismatch ⇒ the entire runner subtree is
//     stale; rebuild or full-run fallback.
//   - PER SHARD    — every recorded test-content and dependency hash still
//     matches the file on disk ({@link staleShards}); section 7 condition 3.
//   - PER EDIT     — which shards a proposed edit touches and therefore
//     invalidates ({@link shardsTouchedByPaths}); the scoped-selection input.
//
// Runner adapters own the LISTS (which config files feed coverageConfigHash,
// which env vars are coverage-relevant); this module owns the hashing and
// comparison so every adapter invalidates identically.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageIndexManifest } from "./types.js";

/** The current values of every whole-index validity input (section 8.2 manifest fields). */
export interface IndexValidityInputs {
	runnerId: string;
	runnerVersion: string;
	coverageEngine: string;
	coverageConfigHash: string;
	testDiscoveryHash: string;
	dependencyGraphVersion: string;
	environmentHash: string;
	shardBoundary: "file" | "group" | "run";
}

/** Whole-index validity verdict; `reasons` names each mismatched field. */
interface ValidityVerdict {
	valid: boolean;
	reasons: string[];
}

/** The manifest fields compared for whole-index validity, in report order. */
const VALIDITY_FIELDS: readonly (keyof IndexValidityInputs)[] = [
	"runnerId",
	"runnerVersion",
	"coverageEngine",
	"coverageConfigHash",
	"testDiscoveryHash",
	"dependencyGraphVersion",
	"environmentHash",
	"shardBoundary",
];

/**
 * Compare an accepted manifest against the CURRENT validity inputs. Any
 * mismatch invalidates the whole runner index (section 11's "invalidate the
 * whole runner index" scope) — the verdict lists every changed field so logs
 * and telemetry can say WHY a rebuild happened.
 */
export function manifestValidity(
	manifest: CoverageIndexManifest,
	current: IndexValidityInputs,
): ValidityVerdict {
	const reasons: string[] = [];
	for (const field of VALIDITY_FIELDS) {
		if (manifest[field] !== current[field]) {
			reasons.push(`${field} changed (${String(manifest[field])} → ${String(current[field])})`);
		}
	}
	return { valid: reasons.length === 0, reasons };
}

/** sha256 hex of a file's content, or null when missing/unreadable. */
export function hashFileSha256(absPath: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(absPath)).digest("hex");
	} catch {
		return null;
	}
}

/** Marker hashed in place of content for an absent file — presence is signal. */
const MISSING_MARKER = "<missing>";

/**
 * One stable hash over a SET of repo-relative paths: per-path content hashes
 * (sorted by path, so ordering never matters) with absent files folded in as
 * an explicit missing-marker — a config file appearing or disappearing must
 * change the hash exactly like an edit. This is how runner adapters compute
 * `coverageConfigHash` / `testDiscoveryHash` from their config-file lists.
 */
export function hashPathSet(projectRoot: string, relPaths: readonly string[]): string {
	const hash = createHash("sha256");
	for (const relPath of [...relPaths].sort()) {
		const content = hashFileSha256(join(projectRoot, relPath)) ?? MISSING_MARKER;
		hash.update(`${relPath}\0${content}\0`);
	}
	return hash.digest("hex");
}

/**
 * The environment fingerprint over DECLARED coverage-relevant variables only
 * (section 11: "environment variables declared coverage-relevant"). Sorted by
 * name; an unset variable hashes differently from an empty string. Undeclared
 * variables never influence the fingerprint — hashing the whole environment
 * would invalidate the index on every shell-session quirk.
 */
export function hashEnvironment(
	varNames: readonly string[],
	env: Record<string, string | undefined>,
): string {
	const hash = createHash("sha256");
	for (const name of [...varNames].sort()) {
		const value = env[name];
		hash.update(`${name}\0${value === undefined ? "<unset>" : `=${value}`}\0`);
	}
	return hash.digest("hex");
}

/** One stale shard plus the first reason it went stale. */
interface ShardStaleness {
	shardId: string;
	reason: string;
}

/**
 * Every shard whose recorded validity hashes no longer match the files on
 * disk (section 7 condition 3: "unchanged shards still match their
 * source/test/config/dependency validity hashes"). A stale shard's stored
 * contribution must not participate in a block-authoritative aggregate; it is
 * selected for rerun or the decision degrades to full-run fallback. Reports
 * the FIRST divergent path per shard — one reason is enough to require a
 * rerun, and short-circuiting keeps the check cheap on big manifests.
 */
export function staleShards(
	manifest: CoverageIndexManifest,
	projectRoot: string,
): ShardStaleness[] {
	const stale: ShardStaleness[] = [];
	for (const entry of Object.values(manifest.shards)) {
		const recorded = [
			...Object.entries(entry.testContentHashes),
			...Object.entries(entry.dependencyHashes),
		];
		for (const [relPath, recordedHash] of recorded) {
			const currentHash = hashFileSha256(join(projectRoot, relPath));
			if (currentHash === recordedHash) continue;
			stale.push({
				shardId: entry.shardId,
				reason:
					currentHash === null
						? `${relPath} missing (was ${recordedHash.slice(0, 8)}…)`
						: `${relPath} content changed`,
			});
			break;
		}
	}
	return stale;
}

/**
 * The shards a set of edited repo-relative paths invalidates: any shard whose
 * test files or recorded dependencies include one of the paths (section 11's
 * scoped invalidation — "edited source: invalidate dependent and historically
 * covering shards; edited test: invalidate its shard"). An empty result for a
 * path the manifest has never seen is NOT "no coverage" — the caller routes
 * unknown paths to the full-suite fallback (section 8.3).
 */
export function shardsTouchedByPaths(
	manifest: CoverageIndexManifest,
	editedRelPaths: readonly string[],
): Set<string> {
	const edited = new Set(editedRelPaths);
	const touched = new Set<string>();
	for (const entry of Object.values(manifest.shards)) {
		const touchesTest = entry.testPaths.some((p) => edited.has(p));
		const touchesDep =
			Object.keys(entry.dependencyHashes).some((p) => edited.has(p)) ||
			Object.keys(entry.testContentHashes).some((p) => edited.has(p));
		if (touchesTest || touchesDep) touched.add(entry.shardId);
	}
	return touched;
}
