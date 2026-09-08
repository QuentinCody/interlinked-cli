// interlinked-tdd: exempt
// ===========================================
// interlinked multi-edit — apply/gate primitives + shared types
// ===========================================
//
// Extracted from `multi-edit.ts` to keep the command file under the per-file
// line cap. Holds the foundational types (error codes, manifest/result
// shapes) plus the pure buffer-transform, gate, and transactional-write
// helpers. This module has NO import from `multi-edit.ts` — the dependency
// direction is one-way (apply ← manifest ← command) so there is no cycle.

import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { CheckResult } from "../harness/check-engine/types.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
	TSC_CHECKER_UNAVAILABLE_CODE,
} from "../harness/diff-overlay.js";
import { findProjectRoot } from "../harness/quality-checks/project-root.js";
import { nonNull } from "../lib/non-null.js";

// ───────────────────────────────────────────────
// Error codes (const-object pattern so they read as intent in conditionals)
// ───────────────────────────────────────────────

/** Error codes per the design doc. Emit these literal strings in `--json`. */
export const MULTI_EDIT_ERROR_CODES = {
	OLD_STRING_NOT_FOUND: "OLD_STRING_NOT_FOUND",
	AMBIGUOUS_OLD_STRING: "AMBIGUOUS_OLD_STRING",
	GATE_REJECTED: "GATE_REJECTED",
	READ_FAILED: "READ_FAILED",
	WRITE_FAILED: "WRITE_FAILED",
	INVALID_MANIFEST: "INVALID_MANIFEST",
} as const;

export type MultiEditErrorCode =
	(typeof MULTI_EDIT_ERROR_CODES)[keyof typeof MULTI_EDIT_ERROR_CODES];

// ───────────────────────────────────────────────
// Public shape — manifest + result types
// ───────────────────────────────────────────────

export interface EditPair {
	old_string: string;
	new_string: string;
}

export interface EditBatch {
	path: string;
	edits: EditPair[];
}

/** Single-file manifest shape (read from stdin when `--stdin` is set). */
export interface SingleFileManifest {
	version: number;
	edits: EditPair[];
}

/** Multi-file manifest shape (read from `--manifest <file>`). */
export interface MultiFileManifest {
	version: number;
	batches: EditBatch[];
}

export interface GateFailure {
	path: string;
	tool: string;
	code: string;
	line: number;
	message: string;
}

export interface MultiEditResult {
	ok: boolean;
	error_code?: MultiEditErrorCode;
	/** Paths whose on-disk content changed. Populated only on success. */
	file_changes_applied: string[];
	/** Populated on AMBIGUOUS_OLD_STRING / OLD_STRING_NOT_FOUND / READ_FAILED / WRITE_FAILED. */
	error_detail?: {
		path: string;
		edit_index?: number;
		/** Number of matches for `old_string` after prior edits. */
		match_count?: number;
		message: string;
	};
	/** Populated on GATE_REJECTED. Same shape as Edit diff-overlay diagnostics. */
	gate_failures?: GateFailure[];
}

/** Result envelope for any function that returns `{ok} | {error}`. Named so
 *  the `normalizeManifest` return type is self-describing to cold readers. */
export type NormalizeResult = { ok: true; batches: EditBatch[] } | { ok: false; message: string };

type ApplyEditsResult =
	| { ok: true; content: string }
	| { ok: false; code: MultiEditErrorCode; index: number; matches: number };

// ───────────────────────────────────────────────
// Core — apply edits to a single buffer
// ───────────────────────────────────────────────

/**
 * Count occurrences of `needle` in `haystack`. Used for the ambiguity rule:
 * each `old_string` must appear exactly once in the buffer after prior
 * edits in the manifest have been applied.
 *
 * Public API — unit-tested directly and part of the documented surface so
 * the `interlinked write` sibling can reuse it if it wants the same
 * ambiguity semantics.
 */
export function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count += 1;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

/**
 * Apply an ordered list of edits to a starting buffer.
 *
 * Ambiguity rule (per the design doc):
 *   Each `old_string` must be unique in the CURRENT buffer (i.e. after all
 *   prior edits in this manifest have been applied), NOT in the original
 *   pristine content. This lets later edits target text produced by
 *   earlier ones.
 *
 * Returns the transformed buffer on success, or a structured error.
 *
 * Public API — exported so callers can reuse the same ambiguity semantics
 * without duplicating the loop.
 */
export function applyEditsToBuffer(original: string, edits: EditPair[]): ApplyEditsResult {
	let buf = original;
	for (let i = 0; i < edits.length; i += 1) {
		const { old_string, new_string } = nonNull(edits[i]);
		// An empty old_string is nonsensical — treat as not-found so the
		// manifest fails loudly rather than silently applying identity.
		const matches = countOccurrences(buf, old_string);
		if (matches === 0) {
			return {
				ok: false,
				code: MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND,
				index: i,
				matches: 0,
			};
		}
		if (matches > 1) {
			return {
				ok: false,
				code: MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING,
				index: i,
				matches,
			};
		}
		// Single match — safe to replace via indexOf + slice (avoids regex
		// escaping footguns in `old_string`).
		const at = buf.indexOf(old_string);
		buf = buf.slice(0, at) + new_string + buf.slice(at + old_string.length);
	}
	return { ok: true, content: buf };
}

// ───────────────────────────────────────────────
// Gate — call diff-overlay against proposed content
// ───────────────────────────────────────────────

/**
 * Thin wrapper around the existing diff-overlay entry points. This is the
 * exact pipeline `evaluator/write-content-guards.ts` runs for single-Edit
 * writes, minus the registry/security checks that are out of scope here
 * (merge-conflict markers, binary-file guard, path traversal — we apply
 * path validation in the command itself).
 *
 * Returns a list of failures in the same shape as the design doc's `--json`
 * output. Empty list means the gate passed.
 *
 * Keep the existing exported name for consumers of the multi-edit API.
 */
export function gateProposedContentInline(
	batch: Array<{ path: string; content: string }>,
	opts?: { projectRoot?: string },
): GateFailure[] {
	const failures: GateFailure[] = [];
	for (const { path, content } of batch) {
		// Resolve the project root per-file (monorepos with per-package
		// tsconfig.json work correctly this way).
		const projectRoot =
			opts?.projectRoot || findProjectRoot(path, process.cwd()) || process.cwd();

		// Biome diff-overlay
		const biome = evaluateBiomeDiffOverlay(path, content, projectRoot);
		for (const f of biome.newFindings) {
			failures.push({
				path,
				tool: "biome",
				code: f.ruleId ?? "biome",
				line: f.line,
				message: f.message,
			});
		}

		// Tsc diff-overlay — only blocking findings count (warn-only codes
		// like TS6133 "unused" are intentionally non-blocking; the design
		// doc's whole point is to permit transient unused-import-style
		// intermediate states, and here the state is post-composition, so
		// genuine unused imports will still surface as warnings via the
		// harness PostToolUse path).
		// Overlay every OTHER file in the batch so a transactional multi-file
		// edit's cross-file references (new exports, shared types, added props)
		// resolve against the proposed combined state instead of stale disk —
		// the fix that lets multi-edit actually land coordinated refactors.
		const siblings = batch
			.filter((b) => b.path !== path)
			.map((b) => ({ filePath: b.path, content: b.content }));
		const tsc = evaluateTscDiffOverlay(path, content, projectRoot, siblings);
		// Unavailable is NOT clean: multi-edit is a transaction, and an empty
		// newFindings array from a checker that never ran (sidecar spawn
		// failure / timeout / cooldown) must abort it, never land it. The
		// caller treats any failure row as GATE_REJECTED — files unchanged.
		if (tsc.checkerUnavailable !== undefined) {
			failures.push({
				path,
				tool: "tsc",
				code: TSC_CHECKER_UNAVAILABLE_CODE,
				line: 0,
				message:
					`type checker unavailable (${tsc.checkerUnavailable}) — ` +
					"this file was NOT type-checked; transaction aborted because unavailable is not clean",
			});
			continue;
		}
		const blocking = tsc.newFindings.filter(isTscFindingBlocking);
		for (const f of blocking) {
			failures.push({
				path,
				tool: "tsc",
				code: f.ruleId ?? "tsc",
				line: f.line,
				message: f.message,
			});
		}
	}
	return failures;
}

/** Public API — the CheckResult row shape surfaced by diff-overlay. */
export type { CheckResult };
/** Public API — re-exported for tests and downstream consumers so they can
 *  use the same finding-blocking classifier the command uses internally. */
export { isTscFindingBlocking };

// ───────────────────────────────────────────────
// Transactional write
// ───────────────────────────────────────────────

/**
 * Best-effort cleanup of a leftover `.tmp` file after a failed write/rename.
 * Failure here is secondary — the primary write error is what the caller
 * surfaces — so we only log, never throw.
 */
function cleanupTmpFile(tmp: string): void {
	try {
		if (existsSync(tmp)) unlinkSync(tmp);
	} catch (cleanupErr) {
		const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
		console.error(`[multi-edit] warning: failed to clean up ${tmp}: ${cleanupMsg}`);
	}
}

/**
 * Restore every already-written file back to its prior on-disk content.
 * Best-effort per file — if one rollback fails we still attempt the rest,
 * logging each failure since there's no way to recover from it here.
 */
function rollbackWrittenFiles(
	written: string[],
	finals: Array<{ path: string; content: string; priorContent: string }>,
): void {
	for (const rollbackPath of written) {
		const prior = finals.find((f) => f.path === rollbackPath)?.priorContent;
		if (prior === undefined) continue;
		try {
			writeFileSync(rollbackPath, prior, "utf-8");
		} catch (rollbackErr) {
			const rollbackMsg =
				rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
			console.error(
				`[multi-edit] CRITICAL: rollback of ${rollbackPath} failed: ${rollbackMsg}`,
			);
		}
	}
}

/**
 * Write a batch of (path, content) pairs atomically.
 *
 * "Atomic across the batch" means: if we can't complete all writes, we roll
 * back any writes we already made to their original on-disk content. The
 * individual file writes themselves use the standard temp+rename pattern
 * (which is atomic within a single file on POSIX). The rollback is
 * best-effort — if the process is killed mid-write we may leave a
 * partially-written batch, but that's the same failure mode git has.
 */
export function atomicBatchWrite(
	finals: Array<{ path: string; content: string; priorContent: string }>,
): { ok: true } | { ok: false; failedPath: string; message: string } {
	const written: string[] = [];
	for (const { path, content } of finals) {
		const tmp = `${path}.interlinked-multi-edit.tmp`;
		try {
			writeFileSync(tmp, content, "utf-8");
			renameSync(tmp, path);
			written.push(path);
		} catch (err) {
			// Rollback: clean up the leftover .tmp, then restore everything
			// we already wrote back to its prior content.
			cleanupTmpFile(tmp);
			rollbackWrittenFiles(written, finals);
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, failedPath: path, message: msg };
		}
	}
	return { ok: true };
}
