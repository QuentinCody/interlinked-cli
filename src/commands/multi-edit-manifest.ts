// interlinked-tdd: exempt
// ===========================================
// interlinked multi-edit — manifest parsing (shape guards + dispatchers)
// ===========================================
//
// Extracted from `multi-edit.ts` to keep the command file under the per-file
// line cap. Accepts either the single-file ({ edits }) or multi-file
// ({ batches }) manifest shape and normalizes both to a list of EditBatch.
// Imports its shared types from the apply module — the dependency direction
// is one-way (apply ← manifest ← command), so there is no cycle.

import type { JsonObject } from "../lib/json-types.js";
import type { EditBatch, EditPair, NormalizeResult } from "./multi-edit-apply.js";

/** Schema-version number the manifest must declare. */
const EXPECTED_MANIFEST_VERSION = 1;

/** Expected runtime type of a parsed manifest. */
const MANIFEST_ROOT_TYPE = "object" as const;

/** Field types inside a manifest. */
const FIELD_TYPE_STRING = "string" as const;

type EditsValidation = { ok: true; edits: EditPair[] } | { ok: false; message: string };

/** Shape guard: root must be a plain JSON object with the right version. */
function validateManifestRoot(
	raw: unknown,
): { ok: true; obj: JsonObject } | { ok: false; message: string } {
	const isObject = !!raw && typeof raw === MANIFEST_ROOT_TYPE;
	if (!isObject) {
		return { ok: false, message: "Manifest must be a JSON object." };
	}
	const obj = raw as JsonObject;
	if (obj.version !== EXPECTED_MANIFEST_VERSION) {
		return {
			ok: false,
			message: `Manifest version must be ${EXPECTED_MANIFEST_VERSION} (got ${JSON.stringify(obj.version)}).`,
		};
	}
	return { ok: true, obj };
}

/** Normalize a multi-file manifest (`{ batches: [...] }`). */
function normalizeMultiFileManifest(
	batchesRaw: unknown[],
	singleFilePath: string | undefined,
): NormalizeResult {
	if (singleFilePath) {
		return {
			ok: false,
			message:
				"Cannot pass a positional path with a multi-file manifest (use either path+--stdin OR --manifest).",
		};
	}
	const batches: EditBatch[] = [];
	for (let i = 0; i < batchesRaw.length; i += 1) {
		const shaped = shapeBatch(batchesRaw[i]);
		if (!shaped.ok) {
			return { ok: false, message: `Batch ${i} must have { path: string, edits: [...] }.` };
		}
		const editsResult = validateEdits(shaped.batch.edits);
		if (!editsResult.ok) {
			return {
				ok: false,
				message: `Batch ${i} (${shaped.batch.path}): ${editsResult.message}`,
			};
		}
		batches.push({ path: shaped.batch.path, edits: editsResult.edits });
	}
	return { ok: true, batches };
}

/**
 * Narrow an unknown value to `{ path: string; edits: unknown[] }`. Using a
 * dedicated predicate is the only way to preserve the narrowing across a
 * `Record<string, unknown>` field read — TypeScript won't propagate the
 * `typeof === "string"` check on `b.path` back to `b.path` itself (indexed
 * reads always return `unknown`). Returning the narrowed view directly
 * sidesteps the issue and keeps the call site free of casts.
 *
 * Note: the bare literal `"string"` is used with `typeof` because TS only
 * narrows against the literal form. `FIELD_TYPE_STRING` documents intent
 * elsewhere in the file; here narrowing trumps the style guideline.
 */
function shapeBatch(
	raw: unknown,
): { ok: true; batch: { path: string; edits: unknown[] } } | { ok: false } {
	if (!raw || typeof raw !== "object") return { ok: false };
	const r = raw as { path?: unknown; edits?: unknown };
	if (typeof r.path !== "string" || !Array.isArray(r.edits)) return { ok: false };
	return { ok: true, batch: { path: r.path, edits: r.edits } };
}

/** Normalize a single-file manifest (`{ edits: [...] }`). */
function normalizeSingleFileManifest(
	editsRaw: unknown[],
	singleFilePath: string | undefined,
): NormalizeResult {
	if (!singleFilePath) {
		return {
			ok: false,
			message:
				"Single-file manifest (with `edits`) requires a path argument on the command line.",
		};
	}
	const editsResult = validateEdits(editsRaw);
	if (!editsResult.ok) {
		return { ok: false, message: editsResult.message };
	}
	return { ok: true, batches: [{ path: singleFilePath, edits: editsResult.edits }] };
}

/**
 * Validate and normalize a manifest parsed from JSON. Accepts either the
 * single-file shape ({ edits }) or the multi-file shape ({ batches }).
 * For the single-file shape, the caller must supply the `path` separately
 * (it's the positional argument on the command line).
 *
 * Public API — unit-tested directly and consumed by the command entry
 * point. Exported so callers that want to sanity-check a manifest before
 * handing it to `runMultiEdit` can do so without re-implementing the
 * parser.
 */
export function normalizeManifest(raw: unknown, singleFilePath?: string): NormalizeResult {
	const rootCheck = validateManifestRoot(raw);
	if (!rootCheck.ok) return rootCheck;
	const obj = rootCheck.obj;

	if (Array.isArray(obj.batches)) {
		return normalizeMultiFileManifest(obj.batches, singleFilePath);
	}
	if (Array.isArray(obj.edits)) {
		return normalizeSingleFileManifest(obj.edits, singleFilePath);
	}
	return {
		ok: false,
		message: "Manifest must have either `edits` (single-file) or `batches` (multi-file).",
	};
}

function validateEdits(raw: unknown[]): EditsValidation {
	if (raw.length === 0) {
		return { ok: false, message: "At least one edit is required." };
	}
	const edits: EditPair[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		// `raw` is a JSON.parse'd array, so an entry can genuinely be `null` or a
		// non-object at runtime — `JsonObject | null` (not a bare `JsonObject`
		// cast) keeps that honest and lets the `!e ||` guard below narrow.
		const e = raw[i] as JsonObject | null;
		if (
			!e ||
			typeof e.old_string !== FIELD_TYPE_STRING ||
			typeof e.new_string !== FIELD_TYPE_STRING
		) {
			return {
				ok: false,
				message: `Edit ${i} must have { old_string: string, new_string: string }.`,
			};
		}
		const oldStr = e.old_string as string;
		const newStr = e.new_string as string;
		if (oldStr.length === 0) {
			return { ok: false, message: `Edit ${i}: old_string must not be empty.` };
		}
		if (oldStr === newStr) {
			return {
				ok: false,
				message: `Edit ${i}: old_string and new_string are identical (no-op edit).`,
			};
		}
		edits.push({ old_string: oldStr, new_string: newStr });
	}
	return { ok: true, edits };
}
