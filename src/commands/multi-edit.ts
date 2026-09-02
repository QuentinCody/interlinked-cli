// ===========================================
// interlinked multi-edit — Atomic coordinated edits across one or more files
// ===========================================
//
// Applies N `old_string → new_string` pairs per file as an in-memory buffer
// transform, runs the content-quality gate ONCE on the final content per
// file, and writes all files atomically if the gate passes. Any failure
// (ambiguous match, missing match, gate reject, read/write I/O) is
// transactional: either all files change or none do.
//
// This exists because the Edit tool applies one replacement at a time, and
// the tsc/biome diff-overlays check each intermediate state. Coordinated
// changes that cross multiple sites in one file (e.g. "add an import AND a
// use site", "widen a signature AND update callers") deadlock under serial
// Edits because one half of the change is invalid without the other.
//
// Eventually this command should call a shared `gateProposedContent()`
// helper that the `interlinked write` subcommand also consumes — the
// sibling design doc owns that shared API. Until it lands, we inline the
// gate by calling the existing diff-overlay entry points directly. The
// gate check path mirrors what `evaluator/write-content-guards.ts` already
// does for single-Edit writes.
//
// Related docs:
//   cli/docs/design/multi-edit-atomic-coordinated-edits.md
//   cli/docs/design/bash-writes-through-content-gates.md

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import {
	applyEditsToBuffer,
	atomicBatchWrite,
	type EditBatch,
	gateProposedContentInline,
	MULTI_EDIT_ERROR_CODES,
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

/**
 * Orchestrate the full multi-edit flow. Returns a `MultiEditResult` so
 * callers (CLI command, tests) can print / assert on the outcome uniformly.
 *
 * Flow:
 *   1. Read pre-edit content for every file.
 *   2. Apply edits in order to each buffer, surfacing ambiguity/missing-match.
 *   3. Gate the final contents via the diff-overlay pipeline.
 *   4. Write all files atomically (temp+rename + rollback).
 *
 * Public API — exported so tests can drive the pipeline directly without
 * going through the commander action handler and its stdin plumbing.
 */
export function runMultiEdit(
	batches: EditBatch[],
	opts: { projectRoot?: string } = {},
): MultiEditResult {
	// Step 1 — read pre-edit content.
	const finals: Array<{ path: string; content: string; priorContent: string }> = [];
	for (const batch of batches) {
		const absPath = isAbsolute(batch.path) ? batch.path : resolve(process.cwd(), batch.path);
		let prior: string;
		try {
			prior = readFileSync(absPath, "utf-8");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: absPath, message: msg },
			};
		}
		// Step 2 — apply edits.
		const applied = applyEditsToBuffer(prior, batch.edits);
		if (!applied.ok) {
			const isAmbiguous = applied.code === MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING;
			return {
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
			};
		}
		finals.push({ path: absPath, content: applied.content, priorContent: prior });
	}

	// Step 3 — gate. If the final content is identical to on-disk (no-op
	// edits after composition), skip the gate AND the write for that file.
	const changedOnly = finals.filter((f) => f.content !== f.priorContent);
	if (changedOnly.length === 0) {
		// Nothing to do — all edits composed to a no-op. Successful trivially.
		return { ok: true, file_changes_applied: [] };
	}

	const gateFailures = gateProposedContentInline(
		changedOnly.map((f) => ({ path: f.path, content: f.content })),
		opts,
	);
	if (gateFailures.length > 0) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.GATE_REJECTED,
			file_changes_applied: [],
			gate_failures: gateFailures,
		};
	}

	// Step 4 — atomic batch write.
	const wrote = atomicBatchWrite(changedOnly);
	if (!wrote.ok) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.WRITE_FAILED,
			file_changes_applied: [],
			error_detail: { path: wrote.failedPath, message: wrote.message },
		};
	}
	return {
		ok: true,
		file_changes_applied: changedOnly.map((f) => f.path),
	};
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
	const manifestPath = opts.manifest as string;
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

function emit(json: boolean, result: MultiEditResult): void {
	if (json) {
		// The design doc's --json shape. Omit empty fields for tidiness.
		const payload: JsonObject = {
			ok: result.ok,
			file_changes_applied: result.file_changes_applied,
		};
		if (result.error_code) payload.error_code = result.error_code;
		if (result.error_detail) payload.error_detail = result.error_detail;
		if (result.gate_failures) payload.gate_failures = result.gate_failures;
		console.log(JSON.stringify(payload, null, 2));
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
