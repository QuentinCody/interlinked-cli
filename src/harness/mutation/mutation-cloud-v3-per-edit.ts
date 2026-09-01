// =========================================================
// Mutation cloud v3 — proposed per-edit request preparation
// =========================================================
// This boundary prepares exact bytes for MutationCloudV3Runtime.submit. It
// performs no network I/O and never adopts a baseline: ordinary proposed edits
// are always evaluated with the journal's require_established semantics.

import { createHash } from "node:crypto";
import {
	captureMutationOverlaySource,
	type CapturedMutationOverlaySource,
} from "./mutation-cloud-v3-overlay-source.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { checkBoundedString } from "./protocol-v3/field-checks.js";
import {
	parseMutationJobRequestV3,
	type ValidMutationJobRequest,
} from "./protocol-v3/request.js";
import { PROTOCOL_V3_VERSION } from "./protocol-v3/types.js";

const PER_EDIT_KEY_VERSION = "mutation-per-edit-key/1";

export interface MutationCloudV3PerEditAuthority {
	tenant: string;
	project: string;
	repository: string;
}

interface PrepareMutationCloudV3PerEditInput {
	root: string;
	targetFile: string;
	proposedBytes: Uint8Array;
	authority: MutationCloudV3PerEditAuthority;
	maxTestScope?: number;
}

interface MutationCloudV3PerEditDependencies {
	captureSource?:typeof captureMutationOverlaySource;
}

interface PreparedMutationCloudV3PerEdit {
	request: ValidMutationJobRequest;
	sourceArtifactBytes: Uint8Array;
	targetBytes: Uint8Array;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function validateAuthority(authority: MutationCloudV3PerEditAuthority): void {
	for (const field of ["tenant", "project", "repository"] as const) {
		const failure = checkBoundedString(authority[field], `per-edit authority.${field}`);
		if (failure !== null) throw new Error(failure);
	}
}

function canonicalTestFiles(captured: CapturedMutationOverlaySource): string[] {
	if (!Array.isArray(captured.testFiles)) {
		throw new Error("mutation per-edit capture testFiles must be an array");
	}
	const sorted = [...captured.testFiles].sort();
	if (new Set(sorted).size !== sorted.length) {
		throw new Error("mutation per-edit capture contains duplicate test files");
	}
	return sorted;
}

function assertCaptureBindings(args: {
	captured: CapturedMutationOverlaySource;
	authority: MutationCloudV3PerEditAuthority;
	targetFile: string;
	proposedBytes: Uint8Array;
}): void {
	const { captured } = args;
	if (!(captured.targetBytes instanceof Uint8Array) || !(captured.sourceArtifactBytes instanceof Uint8Array)) {
		throw new Error("mutation per-edit capture bytes must be Uint8Array values");
	}
	if (captured.repository !== args.authority.repository) {
		throw new Error("mutation per-edit capture has a foreign repository identity");
	}
	if (captured.targetFile !== args.targetFile) {
		throw new Error("mutation per-edit capture has a foreign target identity");
	}
	if (!equalBytes(captured.targetBytes, args.proposedBytes)) {
		throw new Error("mutation per-edit capture target bytes differ from the proposed edit");
	}
	if (sha256(captured.targetBytes) !== captured.targetSha256) {
		throw new Error("mutation per-edit capture target hash disagrees with its bytes");
	}
	if (sha256(captured.sourceArtifactBytes) !== captured.sourceArtifactSha256) {
		throw new Error("mutation per-edit capture artifact hash disagrees with its bytes");
	}
	if (captured.sourceArtifactId !== `src_git_archive_v1_${captured.sourceArtifactSha256}`) {
		throw new Error("mutation per-edit capture has a foreign source artifact identity");
	}
	if (
		captured.changesetTarget.path !== captured.targetFile ||
		captured.changesetTarget.content_hash !== captured.targetSha256
	) {
		throw new Error("mutation per-edit capture changeset disagrees with its target binding");
	}
}

function deterministicJobKey(args: {
	authority: MutationCloudV3PerEditAuthority;
	captured: CapturedMutationOverlaySource;
	testFiles: readonly string[];
}): string {
	const { authority, captured } = args;
	const identity = canonicalJson({
		key_version: PER_EDIT_KEY_VERSION,
		protocol_version: PROTOCOL_V3_VERSION,
		authority,
		commit: captured.commit,
		target_file: captured.targetFile,
		target_content_hash: captured.targetSha256,
		source_artifact: {
			format: captured.format,
			artifact_id: captured.sourceArtifactId,
			sha256: captured.sourceArtifactSha256,
			bytes: captured.sourceArtifactBytes.byteLength,
		},
		scope_mode: captured.scopeMode,
		test_files: args.testFiles,
		changeset: [captured.changesetTarget],
	});
	return `job_edit_v3_${sha256(identity)}`;
}

function buildRequest(args: {
	authority: MutationCloudV3PerEditAuthority;
	captured: CapturedMutationOverlaySource;
	testFiles: string[];
}): ValidMutationJobRequest {
	const { authority, captured } = args;
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: PROTOCOL_V3_VERSION,
		job: {
			...authority,
			commit: captured.commit,
			target_file: captured.targetFile,
			target_content_hash: captured.targetSha256,
			job_key: deterministicJobKey(args),
		},
		source_artifact: {
			format: captured.format,
			artifact_id: captured.sourceArtifactId,
			sha256: captured.sourceArtifactSha256,
			bytes: captured.sourceArtifactBytes.byteLength,
		},
		scope_mode: captured.scopeMode,
		test_files: args.testFiles,
		changeset: [{ ...captured.changesetTarget }],
	});
	if (!parsed.ok) {
		throw new Error(`mutation per-edit capture generated an invalid request: ${parsed.reason}`);
	}
	return parsed.request;
}

/**
 * Capture immutable HEAD plus exactly one proposed target and return the
 * parser-minted request plus the exact out-of-band bytes expected by
 * MutationCloudV3Runtime.submit.
 *
 * The job key is a conservative idempotency key: retrying the same authority,
 * synthetic commit, target, artifact, and selected-test set reuses one key;
 * changing any of those immutable inputs mints a new key. No response field or
 * baseline state participates, and the downstream journal must use
 * `require_established` for this proposed-edit path.
 */
export function prepareMutationCloudV3PerEdit(
	input: PrepareMutationCloudV3PerEditInput,
	dependencies: MutationCloudV3PerEditDependencies = {},
): PreparedMutationCloudV3PerEdit {
	const authority: MutationCloudV3PerEditAuthority = {
		tenant: input.authority.tenant,
		project: input.authority.project,
		repository: input.authority.repository,
	};
	validateAuthority(authority);
	const proposedBytes = Uint8Array.from(input.proposedBytes);
	const captureSource = dependencies.captureSource ?? captureMutationOverlaySource;
	const captured = captureSource({
		root: input.root,
		repository: authority.repository,
		targetFile: input.targetFile,
		proposedBytes,
		...(input.maxTestScope === undefined ? {} : { maxTestScope: input.maxTestScope }),
	});
	assertCaptureBindings({
		captured,
		authority,
		targetFile: input.targetFile,
		proposedBytes,
	});
	const testFiles = canonicalTestFiles(captured);
	return {
		request: buildRequest({ authority, captured, testFiles }),
		sourceArtifactBytes: Uint8Array.from(captured.sourceArtifactBytes),
		targetBytes: Uint8Array.from(captured.targetBytes),
	};
}
