// ===========================================
// Findings — provenance identity + dedup keys
// ===========================================
// Pure functions (no I/O) that compute the deterministic identity of a single
// review sighting and the structural dedup key a Finding folds on. Kept
// separate from corpus.ts so the storage layer stays under the line cap and so
// these can be unit-tested in isolation.
//
// Determinism note: every value here is a hash of populated fields — NEVER an
// LLM judgement (see CLAUDE.md "determinism boundary"). `provenance_completeness`
// in particular is COMPUTED from which anchor fields are present, so the corpus
// can honestly report trust level without any model in the loop.

import { createHash } from "node:crypto";

/** Anchor strength of a single sighting — computed, never judged. Drives the
 *  "block is earned" rule (phase 2): only `anchored_sha` auto-qualifies a rule
 *  to block. In the warn-only spike it's surfaced in `finding list` as a trust
 *  signal only. */
export type ProvenanceCompleteness =
	| "anchored_sha" // path + line + commit sha (exact reviewed code is pullable)
	| "anchored_line" // path + line (code may have drifted since)
	| "anchored_file" // path only
	| "unanchored"; // prose / quote only — no file locator

/** Granularity the dedup key was computed at. Surfaced in `finding list`. */
export type ProvenanceTier = "site" | "file" | "class";

const HASH_HEX_LENGTH = 16;
const NUL = " ";

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Normalize a file path for dedup/identity: forward slashes, strip a leading
 * `./`. Absolute→relative conversion is the corpus layer's job (it owns `cwd`);
 * this stays pure so the same string always hashes the same way.
 */
export function normalizeFindingPath(file: string): string {
	return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Fields that participate in a sighting's identity. Prose sightings carry
 *  `raw_sha256` (content hash of the captured blob) when they lack a locator. */
interface ProvenanceIdInput {
	source_runner: string;
	repo?: string | undefined;
	pr?: number | undefined;
	comment_node_id?: string | undefined;
	commit_sha?: string | undefined;
	file?: string | undefined;
	lines?: [number, number] | undefined;
	raw_sha256?: string | undefined;
}

/**
 * Stable identity hash for ONE sighting. Re-harvesting the same review comment
 * yields the same id, so `times_observed` (a fold over distinct provenance_id)
 * stays an honest distinct count and re-sync is a no-op on counts.
 */
export function computeProvenanceId(input: ProvenanceIdInput): string {
	const identity = [
		input.source_runner,
		input.repo ?? "",
		input.pr != null ? String(input.pr) : "",
		input.comment_node_id ?? "",
		input.commit_sha ?? "",
		input.file ? normalizeFindingPath(input.file) : "",
		input.lines ? `${input.lines[0]}-${input.lines[1]}` : "",
		input.raw_sha256 ?? "",
	].join(NUL);
	return sha256(identity).slice(0, HASH_HEX_LENGTH);
}

interface CompletenessInput {
	file?: string |undefined;
	lines?: [number, number] | undefined;
	line?: number | undefined;
	commit_sha?: string | undefined;
}

/** Deterministically derive anchor strength from which fields are populated. */
export function computeCompleteness(input: CompletenessInput): ProvenanceCompleteness {
	const hasFile = Boolean(input.file);
	const hasLine = input.lines != null || (input.line != null && input.line > 0);
	const hasSha = Boolean(input.commit_sha);
	if (hasFile && hasLine && hasSha) return "anchored_sha";
	if (hasFile && hasLine) return "anchored_line";
	if (hasFile) return "anchored_file";
	return "unanchored";
}

interface DedupKeyInput {
	/** Already repo-relative, already normalized by the corpus layer. */
	file?: string | undefined;
	line?: number | undefined;
	repo?: string | undefined;
}

/**
 * Tiered STRUCTURAL dedup key. The sha is deliberately NOT an input: two
 * reviewers flagging the same bug at different commits is the canonical
 * multi-provenance case we want to KEEP, not split. The message is also not an
 * input (verified unstable). `class` tier never auto-merges — a human attaches
 * it to a bug_class. `repo` is the first component, so a dedup_key is per-repo
 * by construction; cross-repo unification is bug_class's job, not the key's.
 */
export function computeDedupKey(input: DedupKeyInput): { tier: ProvenanceTier; key: string } {
	const repo = input.repo ?? "";
	const file = input.file ? normalizeFindingPath(input.file) : "";
	const line = input.line != null && input.line > 0 ? input.line : undefined;
	if (file && line != null) return { tier: "site", key: sha256(`${repo}|${file}|${line}`) };
	if (file) return { tier: "file", key: sha256(`${repo}|${file}`) };
	return { tier: "class", key: "" };
}

/** Content hash for a captured prose blob — used as the prose sighting's anchor
 *  in `computeProvenanceId` and stored as `raw_sha256` for audit/replay. */
export function hashRawBlob(blob: string): string {
	return sha256(blob).slice(0, HASH_HEX_LENGTH);
}
