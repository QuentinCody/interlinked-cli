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

import type { CheckResult } from "../harness/check-engine/types.js";
import { GATE_SEVERITY_ERROR, gateProposedContent } from "../harness/content-gate.js";
import { isTscFindingBlocking } from "../harness/diff-overlay.js";
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
 * Adapt the shared pre_block, Biome and TypeScript content gate to the
 * multi-edit result shape. The transaction layer validates physical paths;
 * operation-level guards remain the responsibility of the caller's hooks.
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
	// Converged on the SHARED gate (session review r4, finding 4): this
	// command used to run only biome + tsc, so the identical edit was refused
	// by `interlinked write --batch` and accepted here, and the pre_block
	// registry (self_import among them) never saw the batch nor the proposed
	// view that lets a sibling created in the same batch resolve. The shared
	// gate runs every phase under the batch's proposed tree; multi-edit keeps
	// its transactional stance by demanding that an UNAVAILABLE type checker
	// be an error (unavailable is not clean) and by treating only error-severity
	// rows as gate failures — non-blocking tsc findings (TS6133 "unused") and
	// pre-existing pre_block instances stay warnings, exactly as before.
	const shared = gateProposedContent(batch, {
		...(opts?.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
		tscUnavailableSeverity: GATE_SEVERITY_ERROR,
	});
	return shared.failures
		.filter((failure) => failure.severity === GATE_SEVERITY_ERROR)
		.map(({ path, tool, code, line, message }) => ({ path, tool, code, line, message }));
}

/** Public API — the CheckResult row shape surfaced by diff-overlay. */
export type { CheckResult };
/** Public API — re-exported for tests and downstream consumers so they can
 *  use the same finding-blocking classifier the command uses internally. */
export { isTscFindingBlocking };

// ───────────────────────────────────────────────
// Transactional write
// ───────────────────────────────────────────────

/** Read the original target path preserved by transaction and rollback errors. */
export function transactionFailurePath(error: unknown): string | undefined {
    if (!(error instanceof Error) || !("path" in error)) return undefined;
    return typeof error.path === "string" ? error.path : undefined;
}
