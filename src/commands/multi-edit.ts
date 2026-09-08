import { nonNull } from "../lib/non-null.js";
// ===========================================
// interlinked multi-edit — Coordinated edits across one or more files
// ===========================================
//
// Applies N `old_string → new_string` pairs per file as an in-memory buffer
// transform, runs the content-quality gate ONCE on the final content per
// file, then commits under the shared project lock if the gate passes and
// target snapshots still match. Failed commits attempt guarded rollback;
// concurrent external writes can prevent restoration. Each rename is atomic,
// but the filesystem does not provide a crash-atomic multi-file commit.
//
// This exists because the Edit tool applies one replacement at a time, and
// the tsc/biome diff-overlays check each intermediate state. Coordinated
// changes that cross multiple sites in one file (e.g. "add an import AND a
// use site", "widen a signature AND update callers") deadlock under serial
// Edits because one half of the change is invalid without the other.
//
// The content gate and transaction implementation are shared with
// `interlinked write`; this command adds ordered substring-edit semantics.
//
// Related docs:
//   cli/docs/design/multi-edit-atomic-coordinated-edits.md
//   cli/docs/design/bash-writes-through-content-gates.md

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { c } from "../lib/formatter.js";
import { captureGatedWriteBaseline, commitGatedWrites } from "../lib/gated-file-transaction.js";
import type { JsonObject } from "../lib/json-types.js";
import {
	applyEditsToBuffer,
	type EditBatch,
	gateProposedContentInline,
	MULTI_EDIT_ERROR_CODES,
	transactionFailurePath,
	type MultiEditResult,
} from "./multi-edit-apply.js";
import { normalizeManifest } from "./multi-edit-manifest.js";

// ───────────────────────────────────────────────
// Re-exports — preserve the public surface after the split.
// ───────────────────────────────────────────────

export type {
	CheckResult,
	EditBatch,
	EditPair,
	GateFailure,
	MultiEditErrorCode,
	MultiEditResult,
	MultiFileManifest,
	NormalizeResult,
	SingleFileManifest,
} from "./multi-edit-apply.js";
export {
	applyEditsToBuffer,
	atomicBatchWrite,
	countOccurrences,
	gateProposedContentInline,
	isTscFindingBlocking,
	MULTI_EDIT_ERROR_CODES,
} from "./multi-edit-apply.js";
export { normalizeManifest } from "./multi-edit-manifest.js";

// ───────────────────────────────────────────────
// Top-level orchestrator (pure: returns a result, doesn't print)
// ───────────────────────────────────────────────

/** One successfully read-and-applied batch, ready for gating/writing. */
type AppliedBatch = { path: string; content: string; priorContent: string };

/**
 * Read a batch's file and apply its edits in order. Returns the resulting
 * buffer entry, or the `MultiEditResult` failure to return immediately
 * (read error, ambiguous match, or missing match) — extracted so
 * `runMultiEdit`'s per-batch loop is a single guard clause.
 */
function readAndApplyBatch(
	batch: EditBatch,
): { ok: true; entry: AppliedBatch } | { ok: false; result: MultiEditResult } {
	const absPath = isAbsolute(batch.path) ? batch.path : resolve(process.cwd(), batch.path);
	let prior: string;
	try {
		prior = readFileSync(absPath, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			result: {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: absPath, message: msg },
			},
		};
	}
	const applied = applyEditsToBuffer(prior, batch.edits);
	if (!applied.ok) {
		const isAmbiguous = applied.code === MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING;
		return {
			ok: false,
			result: {
				ok: false,
				error_code: applied.code,
				file_changes_applied: [],
				error_detail: {
					path: absPath,
					edit_index: applied.index,
					match_count: applied.matches,
					message: isAmbiguous
						? `Edit ${applied.index}: old_string matches ${applied.matches} locations in the current buffer; require exactly one match (ambiguity evaluated AFTER prior edits in this manifest).`
						: `Edit ${applied.index}: old_string not found in the current buffer.`,
				},
			},
		};
	}
	return { ok: true, entry: { path: absPath, content: applied.content, priorContent: prior } };
}

/**
 * Orchestrate the full multi-edit flow. Returns a `MultiEditResult` so
 * callers (CLI command, tests) can print / assert on the outcome uniformly.
 *
 * Flow:
 *   1. Read pre-edit content for every file.
 *   2. Apply edits in order to each buffer, surfacing ambiguity/missing-match.
 *   3. Capture target snapshots and gate the final contents.
 *   4. Compare snapshots under the shared lock, then commit with guarded rollback.
 *
 * Public API — exported so tests can drive the pipeline directly without
 * going through the commander action handler and its stdin plumbing.
 */
export function runMultiEdit(
	batches: EditBatch[],
	opts: { projectRoot?: string } = {},
): MultiEditResult {
	// Steps 1–2 — read pre-edit content and apply edits, per batch.
	const finals: AppliedBatch[] = [];
	for (const batch of batches) {
		const outcome = readAndApplyBatch(batch);
		if (!outcome.ok) return outcome.result;
		finals.push(outcome.entry);
	}

	// Step 3 — gate. A manifest whose every edit composes to a no-op has
	// nothing to judge or write. Otherwise EVERY member is validated — an
	// unchanged member is judged against the changed ones, since their types
	// can break it with its own bytes untouched (session review r5, finding 2)
	// — and only the changed members are written.
	const changedOnly = finals.filter((f) => f.content !== f.priorContent);
	if (changedOnly.length === 0) {
		return { ok: true, file_changes_applied: [] };
	}
	return gateAndCommitBatches(finals, changedOnly, opts);
}

/** Snapshot before verification, then compare all members under the shared commit lock. */
function gateAndCommitBatches(
	finals: AppliedBatch[],
	changedOnly: AppliedBatch[],
	opts: { projectRoot?: string },
): MultiEditResult {
	const root = opts.projectRoot ?? process.cwd();
	try {
		const transaction = captureGatedWriteBaseline(root, finals.map((entry) => ({
			path: entry.path, content: entry.content, expectedContent: entry.priorContent,
		})));
		const gateFailures = gateProposedContentInline(
			finals.map((f) => ({ path: f.path, content: f.content })), opts,
		);
		if (gateFailures.length > 0) {
			return {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.GATE_REJECTED,
				file_changes_applied: [],
				gate_failures: gateFailures,
			};
		}
		commitGatedWrites(transaction);
		return {
			ok: true,
			file_changes_applied: changedOnly.map((f) => f.path),
		};
	} catch (error) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.WRITE_FAILED,
			file_changes_applied: [],
			error_detail: {
				path: transactionFailurePath(error) ?? finals[0]?.path ?? root,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

// ───────────────────────────────────────────────
// CLI entry point
// ───────────────────────────────────────────────

export interface MultiEditOpts {
	stdin?: boolean;
	manifest?: string;
	json?: boolean;
}

/**
 * Read stdin to completion as a UTF-8 string. Used when `--stdin` is set.
 */
async function readStdin(): Promise<string> {
	return await new Promise((resolveP, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolveP(data));
		process.stdin.on("error", reject);
	});
}

/**
 * Commander action handler for `interlinked multi-edit`.
 *
 * Supports three invocation shapes. Stdin is the preferred one for BOTH
 * single- and multi-file work — it needs no temp file, which matters because
 * the whole point of this command is to unblock coordinated edits, and making
 * the agent stage a manifest on disk first just relocates the friction:
 *   interlinked multi-edit --stdin
 *       Multi-file manifest ({ version: 1, batches: [{ path, edits }] }) on
 *       stdin. No positional path. THE default for coordinated cross-file edits.
 *   interlinked multi-edit <path> --stdin
 *       Single-file manifest ({ version: 1, edits: [...] }) on stdin.
 *   interlinked multi-edit --manifest <path>
 *       Either shape, read from a manifest already on disk.
 */
export async function multiEditCommand(
	path: string | undefined,
	opts: MultiEditOpts,
): Promise<void> {
	const json = !!opts.json;

	// Mutually-exclusive input modes: must supply exactly one.
	const hasStdin = !!opts.stdin;
	const hasManifest = !!opts.manifest;
	const modeError = inputModeError(hasStdin, hasManifest, path);
	if (modeError) {
		emit(json, modeError);
		process.exitCode = 1;
		return;
	}

	// Read the raw manifest JSON.
	const rawResult = await readManifestRaw(hasStdin, opts);
	if (!rawResult.ok) {
		emit(json, rawResult.result);
		process.exitCode = 1;
		return;
	}

	// Parse + normalize.
	const parseResult = parseManifestJson(rawResult.raw, path);
	if (!parseResult.ok) {
		emit(json, parseResult.result);
		process.exitCode = 1;
		return;
	}

	const normalized = normalizeManifest(parseResult.parsed, path);
	if (!normalized.ok) {
		emit(json, {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: { path: path || "<manifest>", message: normalized.message },
		});
		process.exitCode = 1;
		return;
	}

	// Run the pipeline.
	const result = runMultiEdit(normalized.batches);
	emit(json, result);
	if (!result.ok) {
		process.exitCode = 1;
	}
}

/**
 * Validate the mutually-exclusive `--stdin` / `--manifest` input modes.
 * Returns the failure result to emit, or `null` when exactly one is set.
 */
function inputModeError(
	hasStdin: boolean,
	hasManifest: boolean,
	path: string | undefined,
): MultiEditResult | null {
	if (hasStdin && hasManifest) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: {
				path: path || "",
				message: "--stdin and --manifest are mutually exclusive.",
			},
		};
	}
	if (!hasStdin && !hasManifest) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: {
				path: path || "",
				message:
					"Must supply --stdin or --manifest. Preferred (no temp file): pipe {version:1,batches:[{path,edits}]} to `interlinked multi-edit --stdin` for any number of files, or {version:1,edits:[...]} with a <path> for one file. `--manifest <file>` reads the same shapes from disk.",
			},
		};
	}
	return null;
}

/**
 * Read the raw manifest JSON from stdin or a `--manifest` file. Assumes
 * exactly one of the two is set (enforced by `inputModeError` upstream).
 */
async function readManifestRaw(
	hasStdin: boolean,
	opts: MultiEditOpts,
): Promise<{ ok: true; raw: string } | { ok: false; result: MultiEditResult }> {
	if (hasStdin) {
		try {
			return { ok: true, raw: await readStdin() };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				result: {
					ok: false,
					error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
					file_changes_applied: [],
					error_detail: { path: "<stdin>", message: msg },
				},
			};
		}
	}
	// opts.manifest is guaranteed set by the mutex check above.
	const manifestPath = nonNull(opts.manifest);
	try {
		return { ok: true, raw: readFileSync(manifestPath, "utf-8") };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			result: {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: manifestPath, message: msg },
			},
		};
	}
}

/**
 * Parse the raw manifest string as JSON, wrapping a parse failure into the
 * same `MultiEditResult` shape the rest of the pipeline uses.
 */
function parseManifestJson(
	raw: string,
	path: string | undefined,
): { ok: true; parsed: unknown } | { ok: false; result: MultiEditResult } {
	try {
		return { ok: true, parsed: JSON.parse(raw) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			result: {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
				file_changes_applied: [],
				error_detail: { path: path || "<manifest>", message: `JSON parse error: ${msg}` },
			},
		};
	}
}

// ───────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────

/**
 * Emit the design doc's --json shape. Omits empty fields for tidiness.
 */
function emitJson(result: MultiEditResult): void {
	const payload: JsonObject = {
		ok: result.ok,
		file_changes_applied: result.file_changes_applied,
	};
	if (result.error_code) payload.error_code = result.error_code;
	if (result.error_detail) payload.error_detail = result.error_detail;
	if (result.gate_failures) payload.gate_failures = result.gate_failures;
	console.log(JSON.stringify(payload, null, 2));
}

function emit(json: boolean, result: MultiEditResult): void {
	if (json) {
		emitJson(result);
		return;
	}
	if (result.ok) {
		const n = result.file_changes_applied.length;
		if (n === 0) {
			console.log(c.dim("multi-edit: no-op (edits composed to identical content)."));
		} else {
			console.log(c.green(`multi-edit: ${n} file(s) updated`));
			for (const p of result.file_changes_applied) {
				console.log(`  ${p}`);
			}
		}
		return;
	}
	// Failure — human-readable.
	console.error(c.red(`multi-edit failed: ${result.error_code}`));
	if (result.error_detail) {
		const d = result.error_detail;
		const where = d.edit_index !== undefined ? ` (edit ${d.edit_index})` : "";
		console.error(`  ${d.path}${where}`);
		console.error(`  ${d.message}`);
	}
	if (result.gate_failures && result.gate_failures.length > 0) {
		console.error(c.dim(`  ${result.gate_failures.length} gate failure(s):`));
		for (const f of result.gate_failures) {
			console.error(`    ${f.path}: ${f.tool} [${f.code}] L${f.line} — ${f.message}`);
		}
	}
	console.error(c.dim("  No files changed."));
}
