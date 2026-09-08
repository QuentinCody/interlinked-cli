// ===========================================
// Protocol v3 — canonical job request + admission derivation
// ===========================================
// Seventh pass P0-3 / eighth pass P0-2: `request_hash` and
// `changeset_hash` have ONE canonical cross-repository derivation, and
// admission can ONLY be derived from a request that passed the
// CONSTRUCTING parser below — so the caller-side implementation can never
// hash a request the schema rejects. Mirrored by
// protocol/mutation-v3/schema/request.schema.json and the shared
// cross-runtime vectors in fixtures/request-vectors.json:
//
//   changeset_hash = sha256( canonicalJson(
//     { changeset_version: "1", entries: <entries sorted by path> } ) )
//   request_hash   = sha256( canonicalJson(
//     { ...request, changeset: <entries sorted by path> } ) )
//
// Canonical ordering: change-set entries sorted by `path`, and
// `test_files` REQUIRED already sorted — both by lexicographic UTF-16
// code-unit comparison; paths and test files UNIQUE. The CLI derives
// ExpectedAdmission from ITS OWN parsed request at submission time and
// holds it for verification; nothing is ever derived from the response.

import { createHash } from "node:crypto";
import { canonicalJson, deepFreeze, type DeepReadonly, safeStructuredClone } from "./canonical.js";
import {
	checkBoundedString,
	checkFullGitCommitSha,
	checkRepoRelativePath,
	checkSha256Hex,
	checkSourceArtifactBinding,
	firstReason,
	isRecord,
	type Reason,
	unknownKeysIn,
} from "./field-checks.js";
import {
	PROTOCOL_V3_VERSION,
	type V3JobBinding,
	type V3SourceArtifactBinding,
} from "./types.js";
import type { ExpectedAdmission } from "./verify.js";

export interface V3ChangesetEntry {
	/** Normalized repo-relative POSIX path. */
	path: string;
	/** sha-256 of the entry's exact proposed content. */
	content_hash: string;
}

/** The canonical mutation job request — what the CLI submits and what
 *  the acceptance receipt's request_hash must bind. */
export interface MutationJobRequestV3 {
	request_version: "1";
	/** The protocol the request binds to — participates in request_hash
	 *  (tenth pass P1-4 / plan 27: protocol version is part of request
	 *  identity). */
	protocol_version: typeof PROTOCOL_V3_VERSION;
	/** Caller EXPECTATION for the result binding, not authorization. The cloud
	 *  must independently derive tenant/project authority from authenticated
	 *  server context and compare it before accepting or persisting a job. */
	job: V3JobBinding;
	/** Pinned full-repository snapshot + proposed overlay. Only this opaque
	 *  binding enters the request; artifact bytes are uploaded/fetched out of
	 *  band and independently hash/length checked before Sandbox execution. */
	source_artifact: V3SourceArtifactBinding;
	scope_mode: "import_graph" | "companion_fallback" | "glob_fallback";
	test_files: string[];
	changeset: V3ChangesetEntry[];
}

declare const VALID_REQUEST: unique symbol;
/** Branded: only parseMutationJobRequestV3 mints one — deriveAdmission
 *  accepts nothing else (eighth pass P0-2). */
export type ValidMutationJobRequest = DeepReadonly<MutationJobRequestV3> & { readonly [VALID_REQUEST]: true };

export type RequestOutcome =
	| { ok: true; request: ValidMutationJobRequest }
	| { ok: false; reason: string };

/** MUST equal maxItems in schema/request.schema.json. */
const MAX_REQUEST_LIST = 4096;
const SCOPE_MODES = ["import_graph", "companion_fallback", "glob_fallback"];

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function checkRequestJob(raw: Record<string, unknown>): Reason {
	const job = raw.job;
	if (!isRecord(job)) return "request.job must be an object";
	return firstReason([
		unknownKeysIn(job, ["tenant", "project", "repository", "commit", "target_file", "target_content_hash", "job_key"], "request.job"),
		checkBoundedString(job.tenant, "request.job.tenant"),
		checkBoundedString(job.project, "request.job.project"),
		checkBoundedString(job.repository, "request.job.repository"),
		checkFullGitCommitSha(job.commit, "request.job.commit"),
		checkRepoRelativePath(job.target_file, "request.job.target_file"),
		checkSha256Hex(job.target_content_hash, "request.job.target_content_hash"),
		checkBoundedString(job.job_key, "request.job.job_key"),
	]);
}

function checkSourceArtifact(raw: Record<string, unknown>): Reason {
	return checkSourceArtifactBinding(raw.source_artifact, "request.source_artifact");
}

/** Sorted-unique path list check (code-unit order). */
function checkPathList(value: unknown, where: string, requireSorted: boolean): Reason {
	if (!Array.isArray(value) || value.length > MAX_REQUEST_LIST) {
		return `${where} must be an array of at most ${MAX_REQUEST_LIST} paths`;
	}
	const seen = new Set<string>();
	let previous: string | null = null;
	for (const item of value) {
		const path = checkRepoRelativePath(item, `${where}[]`);
		if (path !== null) return path;
		// SAFETY: checkRepoRelativePath proved item is a string.
		const current = item as string;
		if (seen.has(current)) return `${where} must not contain duplicates`;
		seen.add(current);
		if (requireSorted && previous !== null && current < previous) {
			return `${where} must be sorted ascending (code-unit order) — canonical requests have one byte form`;
		}
		previous = current;
	}
	return null;
}

function checkChangeset(raw: Record<string, unknown>): Reason {
	const changeset = raw.changeset;
	if (!Array.isArray(changeset) || changeset.length === 0 || changeset.length > MAX_REQUEST_LIST) {
		return `request.changeset must carry 1..${MAX_REQUEST_LIST} entries`;
	}
	const paths = new Set<string>();
	for (const entry of changeset) {
		if (!isRecord(entry)) return "request.changeset entries must be objects";
		const bad = firstReason([
			unknownKeysIn(entry, ["path", "content_hash"], "request.changeset[]"),
			checkRepoRelativePath(entry.path, "request.changeset[].path"),
			checkSha256Hex(entry.content_hash, "request.changeset[].content_hash"),
		]);
		if (bad !== null) return bad;
		if (typeof entry.path !== "string") return "request.changeset[].path must be a string";
		if (paths.has(entry.path)) {
			return `request.changeset has a duplicate path "${String(entry.path)}" — ambiguous identity refused`;
		}
		paths.add(entry.path);
	}
	return null;
}

/** Target binding: the target file appears EXACTLY once in the change
 *  set, and its entry's content hash equals the job's target hash. */
function checkTargetBinding(job: V3JobBinding, changeset: V3ChangesetEntry[]): Reason {
	const entries = changeset.filter((entry) => entry.path === job.target_file);
	if (entries.length !== 1) {
		return `request.changeset must contain the target "${job.target_file}" exactly once (found ${entries.length})`;
	}
	if (entries[0]?.content_hash !== job.target_content_hash) {
		return "request.changeset target content_hash disagrees with job.target_content_hash";
	}
	return null;
}

/** The CONSTRUCTING parser — the only mint of ValidMutationJobRequest. */
export function parseMutationJobRequestV3(rawInput: unknown): RequestOutcome {
	// Tenth pass P0-3: SNAPSHOT FIRST — every field is read exactly once
	// (getters cannot return one value to validation and another to the
	// copy), then the SNAPSHOT is validated, frozen, and branded.
	const raw = safeStructuredClone(rawInput);
	if (raw === null || !isRecord(raw)) return { ok: false, reason: "request must be a plain JSON object" };
	const shape = firstReason([
		unknownKeysIn(
			raw,
			["request_version", "protocol_version", "job", "source_artifact", "scope_mode", "test_files", "changeset"],
			"request",
		),
		raw.request_version === "1" ? null : 'request.request_version must be "1"',
		raw.protocol_version === PROTOCOL_V3_VERSION
			? null
			: `request.protocol_version must be exactly "${PROTOCOL_V3_VERSION}"`,
		checkRequestJob(raw),
		checkSourceArtifact(raw),
		typeof raw.scope_mode === "string" && SCOPE_MODES.includes(raw.scope_mode)
			? null
			: `request.scope_mode must be one of ${SCOPE_MODES.join("|")}`,
		checkPathList(raw.test_files, "request.test_files", true),
		checkChangeset(raw),
	]);
	if (shape !== null) return { ok: false, reason: shape };
	// SAFETY: every field and bound was validated just above.
	const request = raw as unknown as MutationJobRequestV3;
	const target = checkTargetBinding(request.job, request.changeset);
	if (target !== null) return { ok: false, reason: target };
	// The snapshot was cloned BEFORE validation (own data, single-read),
	// so freezing it preserves exactly the validated state.
	deepFreeze(request);
	// SAFETY: the one mint site of the ValidMutationJobRequest brand — a
	// frozen pre-validation clone owned by the parser, not the caller.
	return { ok: true, request: request as unknown as ValidMutationJobRequest };
}

/** Entries sorted by path (code-unit lexicographic), unique paths. */
function canonicalEntries(entries: readonly V3ChangesetEntry[]): V3ChangesetEntry[] {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (paths.has(entry.path)) {
			throw new Error(`changeset has a duplicate path "${entry.path}" — ambiguous identity refused`);
		}
		paths.add(entry.path);
	}
	return [...entries].sort((a, b) => {
		if (a.path < b.path) return -1;
		return a.path > b.path ? 1 : 0;
	});
}

export function canonicalChangesetHash(entries: readonly V3ChangesetEntry[]): string {
	return sha256Hex(canonicalJson({ changeset_version: "1", entries: canonicalEntries(entries) }));
}

export function canonicalRequestHash(request: DeepReadonly<MutationJobRequestV3>): string {
	return sha256Hex(canonicalJson({ ...request, changeset: canonicalEntries(request.changeset) }));
}

/** The caller-side admission identity handed to verifyEnvelope — accepts
 *  ONLY a parser-minted request. */
export function deriveAdmission(request: ValidMutationJobRequest): ExpectedAdmission {
	return {
		request_hash: canonicalRequestHash(request),
		changeset_hash: canonicalChangesetHash(request.changeset),
		source_artifact: request.source_artifact,
	};
}
