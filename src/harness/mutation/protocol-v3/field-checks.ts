// ===========================================
// Protocol v3 — primitive field validators
// ===========================================
// Every check returns `null` (valid) or a specific reason. The parser
// composes these; nothing here decides policy. Bounded by construction —
// review 2026-08-31 second pass: the first cut accepted arbitrary hash
// formats, invalid timestamps, unbounded strings, traversal paths, and
// unknown NESTED keys.

import { isWellFormedString } from "./canonical.js";
import { SOURCE_ARTIFACT_FORMAT } from "./types.js";

export type Reason = string | null;

/** General string bound — no field in the envelope legitimately needs more. */
const MAX_STRING = 512;
export const MAX_TEST_FILES = 4096;
export const MAX_MUTANT_ROWS = 65536;
/** Product guardrail for the pinned source bundle fetched by the cloud
 *  runner. The artifact lives out of band; this is its signed byte length.
 *  Sixty-four MiB is the MVP ceiling because a Worker must be able to stream
 *  it through a 128 MiB isolate without ever materializing a second copy. */
export const MAX_SOURCE_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** A report is parsed locally after download, so its signed pointer must cap
 *  allocation before any body is read. Single-file mutation jobs that exceed
 *  this bound terminalize as not measured rather than risking host OOM. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** Exact source text retained in the SQLite journal for local evaluation. */
export const MAX_TARGET_SOURCE_BYTES = 2 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const POLICY_ID_RE = /^policy-[a-z0-9][a-z0-9-]{1,62}$/;
const SOURCE_ARTIFACT_ID_RE = /^src_[A-Za-z0-9][A-Za-z0-9_-]{2,124}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkBoundedString(value: unknown, where: string): Reason {
	if (typeof value !== "string" || value.length === 0) {
		return `${where} must be a non-empty string`;
	}
	if (value.length > MAX_STRING) return `${where} exceeds ${MAX_STRING} characters`;
	// Lone surrogates would break the canonical (JCS-profile) serializer —
	// reject them at the schema boundary (review 2026-08-31 fifth pass).
	return isWellFormedString(value) ? null : `${where} must be well-formed Unicode (no lone surrogates)`;
}

/** Bounded well-formed text that MAY be empty (mutation lexemes can be
 *  the empty string — e.g. a statement-removal replacement). */
export function checkBoundedText(value: unknown, where: string): Reason {
	if (typeof value !== "string") return `${where} must be a string`;
	if (value.length > MAX_STRING) return `${where} exceeds ${MAX_STRING} characters`;
	return isWellFormedString(value) ? null : `${where} must be well-formed Unicode (no lone surrogates)`;
}

export function checkSha256Hex(value: unknown, where: string): Reason {
	return typeof value === "string" && SHA256_RE.test(value)
		? null
		: `${where} must be a lowercase 64-hex sha-256`;
}

/** A pinned GitHub/Git commit, never a branch, tag, or short SHA. */
export function checkFullGitCommitSha(value: unknown, where: string): Reason {
	return typeof value === "string" && FULL_GIT_SHA_RE.test(value)
		? null
		: `${where} must be a full lowercase 40-hex commit SHA`;
}

/** Opaque server-resolved source artifact id. Slashes and dots are excluded
 *  deliberately: this is not an R2 key or user-controlled path. */
function checkSourceArtifactId(value: unknown, where: string): Reason {
	return typeof value === "string" && SOURCE_ARTIFACT_ID_RE.test(value)
		? null
		: `${where} must be an opaque source artifact id (src_<3..125 safe characters>)`;
}

function checkSourceArtifactBytes(value: unknown, where: string): Reason {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SOURCE_ARTIFACT_BYTES
		? null
		: `${where} must be an integer from 1 through ${MAX_SOURCE_ARTIFACT_BYTES}`;
}

export function checkReportBytes(value: unknown, where: string): Reason {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REPORT_BYTES
		? null
		: `${where} must be an integer from 1 through ${MAX_REPORT_BYTES}`;
}

export function checkSourceArtifactBinding(value: unknown, where: string): Reason {
	if (!isRecord(value)) return `${where} must be an object`;
	return firstReason([
		unknownKeysIn(value, ["format", "artifact_id", "sha256", "bytes"], where),
		value.format === SOURCE_ARTIFACT_FORMAT
			? null
			: `${where}.format must be exactly "${SOURCE_ARTIFACT_FORMAT}"`,
		checkSourceArtifactId(value.artifact_id, `${where}.artifact_id`),
		checkSha256Hex(value.sha256, `${where}.sha256`),
		checkSourceArtifactBytes(value.bytes, `${where}.bytes`),
	]);
}

export function checkImageDigest(value: unknown, where: string): Reason {
	return typeof value === "string" && IMAGE_DIGEST_RE.test(value)
		? null
		: `${where} must be an image digest of the form sha256:<64-hex>`;
}

export function checkRfc3339(value: unknown, where: string): Reason {
	if (typeof value !== "string" || !RFC3339_RE.test(value) || !Number.isFinite(Date.parse(value))) {
		return `${where} must be an RFC3339 timestamp`;
	}
	return null;
}

export function checkPolicyId(value: unknown, where: string): Reason {
	return typeof value === "string" && POLICY_ID_RE.test(value)
		? null
		: `${where} must be a controlled policy id (policy-<slug>)`;
}

/** Normalized repo-relative POSIX path: no leading /, no .., no \\, no //. */
export function checkRepoRelativePath(value: unknown, where: string): Reason {
	const bounded = checkBoundedString(value, where);
	if (bounded !== null) return bounded;
	const path = value as string;
	const segments = path.split("/");
	const bad =
		path.startsWith("/") ||
		path.includes("\\") ||
		segments.some((s) => s.length === 0 || s === ".." || s === ".");
	return bad ? `${where} must be a normalized repo-relative POSIX path` : null;
}

export function checkSafeNonNegInt(value: unknown, where: string): Reason {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? null
		: `${where} must be a non-negative safe integer`;
}

export function checkBool(value: unknown, where: string): Reason {
	return typeof value === "boolean" ? null : `${where} must be a boolean`;
}

/** Reject unknown keys INSIDE a block — strictness is recursive, not
 *  top-level-only. */
export function unknownKeysIn(
	block: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
): Reason {
	const set = new Set(allowed);
	for (const key of Object.keys(block)) {
		if (!set.has(key)) return `${where}: unknown key "${key}"`;
	}
	return null;
}

export function firstReason(reasons: Array<Reason>): Reason {
	return reasons.find((r) => r !== null) ?? null;
}
