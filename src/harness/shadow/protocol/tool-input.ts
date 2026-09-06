// ===========================================
// Shadow protocol v1 — tool-input normalization + input_hash (memo §8.0)
// ===========================================
// "Tool input on the wire is `NormalizedToolInputV1` — the daemon normalizes
// runner-specific payloads (Codex `command` / `patch` / `_raw_patch` /
// `content`, the precedence in `apply-patch-content.ts`) into the closed union
// and records `raw_source_field`; the RAW hook payload is scanned before
// normalization."
//
// Three properties this module owns:
//  1. The v0 SCOPE is exactly four shapes — claude-code Write / Edit /
//     MultiEdit and codex apply_patch. Everything else (Bash, NotebookEdit, an
//     unknown client) is `unsupported_capability`; the normalizer never invents
//     a projection for a shape the protocol cannot execute.
//  2. `file_path` becomes a `CanonicalPath`: an absolute path under the repo
//     root is relativized, and anything that escapes the root is a `projection`
//     failure. Escape is decided AFTER lexical normalization, so `root/a/../..`
//     cannot slip through as a prefix match.
//  3. `input_hash` is `H(canonical(NORMALIZED))`, never of the raw payload —
//     the raw payload carries runner-specific keys whose presence must not
//     change content identity, while `replace_all` (which changes what the edit
//     produces) must.
//
// Extra runner keys are PROJECTED AWAY rather than rejected: this is a
// normalizer over a foreign payload, not a wire parser (the strict
// unknown-key rejection belongs to `parse-*.ts`, which reads the normalized
// form back off the wire).

import { posix } from "node:path";
import { canonicalDigest } from "./canonical.js";
import {
	checkArray,
	checkBool,
	checkBoundedText,
	checkSafeNonNegInt,
	isRecord,
	type Reason,
} from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import { asCanonicalPath, checkCanonicalPath } from "./path-rules.js";
import { measureToolInputBytes } from "./tool-input-bytes.js";
import type {
	ApplyPatchSourceField,
	CanonicalPath,
	MultiEditEntryV1,
	NormalizedToolInputV1,
	ToolInputHash,
	ToolInputSchema,
} from "./types-core.js";

const SCHEMA: ToolInputSchema = "shadow-tool-input-v1";

/** The Codex/Copilot apply_patch field precedence. SOURCE OF TRUTH:
 *  `extractApplyPatchRaw` in `src/harness/apply-patch-content.ts` — replicated
 *  here (not imported) because the normalizer needs the WINNING FIELD NAME for
 *  `raw_source_field`, which that function does not return. Its empty-string
 *  fall-through is mirrored exactly, and `tool-input.test.ts` pins the two
 *  implementations against each other. */
export const APPLY_PATCH_SOURCE_PRECEDENCE: readonly ApplyPatchSourceField[] = [
	"command",
	"patch",
	"_raw_patch",
	"content",
];

export interface NormalizeToolInputRequest {
	/** Runner id as the hook reported it. */
	client: string;
	/** Tool name as the hook reported it. */
	tool: string;
	/** The RAW hook payload — already scanned by the caller. */
	input: unknown;
	/** Absolute POSIX path of the repo root the paths are projected into. */
	repo_root: string;
	/** Byte length of the RAW payload as the hook received it, when the caller
	 *  knows it.
	 *
	 *  PROVENANCE IS PART OF THE CONTRACT: this number may come ONLY from the
	 *  raw hook TRANSPORT — the byte length of the buffer the daemon read off
	 *  stdin — and NEVER from a field inside the payload, which the agent
	 *  controls. A payload-supplied length is a self-reported size, and a size
	 *  gate that trusts one is not a gate.
	 *
	 *  It never REPLACES the walk. The walk always runs, and this value is
	 *  checked as a FLOOR: transport framing can only make the payload cost
	 *  MORE than its measured JSON form, so a caller may overstate (whitespace,
	 *  an envelope) but never understate. A `serialized_bytes` below the
	 *  measured bytes is a `projection` failure. */
	serialized_bytes?: number;
}

/** Public API: the failure arm of `NormalizeToolInputResult`, named so callers
 *  can switch on it. */
export type NormalizeFailureReason = "unsupported_capability" | "limits" | "projection";
export type NormalizeToolInputResult =
	| { ok: true; normalized: NormalizedToolInputV1 }
	| { ok: false; reason: NormalizeFailureReason; detail: string };

type Payload = Record<string, unknown>;
type Accepted = { ok: true; normalized: NormalizedToolInputV1 };
type Rejected = { ok: false; reason: NormalizeFailureReason; detail: string };

function fail(reason: NormalizeFailureReason, detail: string): Rejected {
	return { ok: false, reason, detail };
}

function accept(normalized: NormalizedToolInputV1): Accepted {
	return { ok: true, normalized };
}

// ── bytes: the aggregate limit, applied BEFORE any allocation ──────────────

/** The `command_stdin_toolinput_bytes` gate. Returns the rejection, or null
 *  when the payload is within the cap.
 *
 *  The WALK ALWAYS RUNS. `measureToolInputBytes` counts the payload's exact
 *  `JSON.stringify` bytes ITERATIVELY under depth and node bounds — the walk
 *  is itself attacker-facing, so it may reject but must never throw (review
 *  2026-09-04: the recursive string-only counter under-counted a boolean-heavy
 *  payload past the cap and died of RangeError on a deep one; its "safe lower
 *  bound" successor let 1.2 MiB of newlines through a 1 MiB cap).
 *
 *  `serialized_bytes` is then a FLOOR on that measurement, never a substitute
 *  for it: a caller that reads the payload off stdin knows the transport cost,
 *  which framing can only push ABOVE the JSON form. Understating it is a
 *  `projection` failure — otherwise "declare a small number" is the whole
 *  bypass. */
function checkToolInputBytes(request: NormalizeToolInputRequest, cap: number): Rejected | null {
	const measured = measureToolInputBytes(request.input, cap);
	if (!measured.ok) {
		if (measured.reason === "projection") return fail("projection", measured.detail);
		return fail("limits", `${measured.detail} — command_stdin_toolinput_bytes is ${cap}`);
	}
	return checkDeclaredBytes(request.serialized_bytes, measured.bytes, cap);
}

/** The declared transport length, checked against the measured JSON bytes and
 *  the cap. Absent is fine — the walk already decided. */
function checkDeclaredBytes(declared: number | undefined, measured: number, cap: number): Rejected | null {
	if (declared === undefined) return null;
	const reason = checkSafeNonNegInt(declared, "serialized_bytes");
	if (reason !== null) return fail("projection", reason);
	if (declared < measured) {
		return fail(
			"projection",
			`serialized_bytes (${declared}) is under the ${measured} bytes the payload measures — a caller cannot understate the transport cost`,
		);
	}
	if (declared > cap) return fail("limits", `tool input is ${declared} bytes, over command_stdin_toolinput_bytes (${cap})`);
	return null;
}

// ── paths ──────────────────────────────────────────────────────────────────

function normalizeRepoRoot(root: string): string {
	const normalized = posix.normalize(root);
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** The repo-relative remainder of an absolute path under `root`. Returns null
 *  for the root itself and for any path whose lexically normalized form does
 *  not sit beneath it. */
function underRoot(absolute: string, root: string): string | null {
	const normalized = posix.normalize(absolute);
	const prefix = `${root}/`;
	return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

type PathResult = { ok: true; path: CanonicalPath } | { ok: false; detail: string };

function canonicalizePath(value: unknown, root: string): PathResult {
	if (typeof value !== "string" || value.length === 0) return { ok: false, detail: "file_path must be a non-empty string" };
	const relative = value.startsWith("/") ? underRoot(value, root) : posix.normalize(value);
	if (relative === null) return { ok: false, detail: `file_path is outside the repo root: ${value}` };
	const reason = checkCanonicalPath(relative, "file_path");
	if (reason !== null) return { ok: false, detail: reason };
	return { ok: true, path: asCanonicalPath(relative) };
}

// ── field readers ──────────────────────────────────────────────────────────

type TextResult = { ok: true; text: string } | { ok: false; detail: string };

function textField(value: unknown, where: string): TextResult {
	const reason = checkBoundedText(value, where);
	if (reason !== null) return { ok: false, detail: reason };
	// SAFETY: checkBoundedText returns null only when `value` is a string.
	return { ok: true, text: value as string };
}

/** An absent `replace_all` normalizes to false; a present non-boolean is a
 *  malformed payload, never a silent false. */
function replaceAllOf(value: unknown, where: string): { ok: true; on: boolean } | { ok: false; detail: string } {
	if (value === undefined) return { ok: true, on: false };
	const reason: Reason = checkBool(value, where);
	if (reason !== null) return { ok: false, detail: reason };
	return { ok: true, on: value === true };
}

// ── the four supported shapes ──────────────────────────────────────────────

function normalizeWrite(input: Payload, root: string): NormalizeToolInputResult {
	const path = canonicalizePath(input.file_path, root);
	if (!path.ok) return fail("projection", path.detail);
	const content = textField(input.content, "content");
	if (!content.ok) return fail("projection", content.detail);
	return accept({
		schema: SCHEMA,
		client: "claude-code",
		tool: "Write",
		semantics_version: 1,
		file_path: path.path,
		content: content.text,
	});
}

function normalizeEdit(input: Payload, root: string): NormalizeToolInputResult {
	const path = canonicalizePath(input.file_path, root);
	if (!path.ok) return fail("projection", path.detail);
	const entry = normalizeEditEntry(input, "edit");
	if (!entry.ok) return fail("projection", entry.detail);
	return accept({
		schema: SCHEMA,
		client: "claude-code",
		tool: "Edit",
		semantics_version: 1,
		file_path: path.path,
		old_string: entry.entry.old_string,
		new_string: entry.entry.new_string,
		replace_all: entry.entry.replace_all,
	});
}

type EntryResult = { ok: true; entry: MultiEditEntryV1 } | { ok: false; detail: string };

function normalizeEditEntry(value: unknown, where: string): EntryResult {
	if (!isRecord(value)) return { ok: false, detail: `${where} must be an object` };
	const oldString = textField(value.old_string, `${where}.old_string`);
	if (!oldString.ok) return oldString;
	const newString = textField(value.new_string, `${where}.new_string`);
	if (!newString.ok) return newString;
	const replaceAll = replaceAllOf(value.replace_all, `${where}.replace_all`);
	if (!replaceAll.ok) return replaceAll;
	return {
		ok: true,
		entry: { old_string: oldString.text, new_string: newString.text, replace_all: replaceAll.on },
	};
}

function normalizeMultiEdit(input: Payload, root: string): NormalizeToolInputResult {
	const path = canonicalizePath(input.file_path, root);
	if (!path.ok) return fail("projection", path.detail);
	const shape = checkArray(input.edits, "edits", SHADOW_LIMITS_V1.entries);
	if (shape !== null) return fail("projection", shape);
	// SAFETY: checkArray returns null only for an array value.
	const raw = input.edits as readonly unknown[];
	if (raw.length === 0) return fail("projection", "edits must not be empty");
	const edits: MultiEditEntryV1[] = [];
	for (const [index, value] of raw.entries()) {
		const entry = normalizeEditEntry(value, `edits[${index}]`);
		if (!entry.ok) return fail("projection", entry.detail);
		edits.push(entry.entry);
	}
	return accept({
		schema: SCHEMA,
		client: "claude-code",
		tool: "MultiEdit",
		semantics_version: 1,
		file_path: path.path,
		edits,
	});
}

function normalizeApplyPatch(input: Payload): NormalizeToolInputResult {
	for (const field of APPLY_PATCH_SOURCE_PRECEDENCE) {
		const value = input[field];
		if (typeof value !== "string" || value.length === 0) continue; // mirrors extractApplyPatchRaw's fall-through
		const patch = textField(value, field);
		if (!patch.ok) return fail("projection", patch.detail);
		return accept({
			schema: SCHEMA,
			client: "codex",
			tool: "apply_patch",
			semantics_version: 1,
			patch: patch.text,
			raw_source_field: field,
		});
	}
	return fail("projection", `apply_patch carries no patch in any of: ${APPLY_PATCH_SOURCE_PRECEDENCE.join(", ")}`);
}

function normalizeClaudeCode(tool: string, input: Payload, root: string): NormalizeToolInputResult {
	if (tool === "Write") return normalizeWrite(input, root);
	if (tool === "Edit") return normalizeEdit(input, root);
	if (tool === "MultiEdit") return normalizeMultiEdit(input, root);
	return fail("unsupported_capability", `claude-code ${tool} is outside the v0 shadow scope`);
}

// ── entry points ───────────────────────────────────────────────────────────

/** Normalize a runner-specific hook payload into the closed union, or say
 *  precisely why it cannot be. */
export function normalizeToolInput(request: NormalizeToolInputRequest): NormalizeToolInputResult {
	if (!isRecord(request.input)) return fail("projection", "tool input must be an object");
	if (!request.repo_root.startsWith("/")) return fail("projection", "repo_root must be an absolute POSIX path");
	const overLimit = checkToolInputBytes(request, SHADOW_LIMITS_V1.command_stdin_toolinput_bytes);
	if (overLimit !== null) return overLimit;
	const root = normalizeRepoRoot(request.repo_root);
	if (request.client === "claude-code") return normalizeClaudeCode(request.tool, request.input, root);
	if (request.client === "codex" && request.tool === "apply_patch") return normalizeApplyPatch(request.input);
	return fail("unsupported_capability", `${request.client} ${request.tool} is outside the v0 shadow scope`);
}

/** `input_hash = H(canonical(NormalizedToolInputV1))` — of the NORMALIZED
 *  form, never the raw hook payload (memo §8.0). */
export function toolInputHash(normalized: NormalizedToolInputV1): ToolInputHash {
	return canonicalDigest<"tool-input">(normalized);
}
