// =========================================================
// Mutation cloud v3 — immutable-HEAD onboarding source capture
// =========================================================
// The artifact encoding is intentionally explicit even before it crosses the
// protocol boundary. A consumer must never infer an archive format from its
// id, hash, prefix, or contents.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMutationTestScopeForRepo, type MutationTestScopeResult } from "./test-scope.js";
import {
	checkBoundedString,
	checkRepoRelativePath,
	MAX_SOURCE_ARTIFACT_BYTES,
	MAX_TARGET_SOURCE_BYTES,
} from "./protocol-v3/field-checks.js";

export const MUTATION_ONBOARDING_SOURCE_FORMAT = "git-archive-tar-v1" as const;
export const MUTATION_ONBOARDING_ARCHIVE_PREFIX = "interlinked-source-v1/";
export const MUTATION_ONBOARDING_ARCHIVE_FORMAT_CONTRACT = Object.freeze({
	format: MUTATION_ONBOARDING_SOURCE_FORMAT,
	command: "git archive --format=tar --prefix=interlinked-source-v1/ <full-HEAD>",
	prefix: MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	compression: "none",
});

const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_ROOT_BYTES = 4 * 1024;
const MAX_SHA_LINE_BYTES = 128;
const MAX_TAR_DIAGNOSTIC_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const TAR_TIMEOUT_MS = 60_000;
const TREE_HEADER_FIELDS = 3;
const GIT_SYMLINK_MODE = "120000";
const GIT_SUBMODULE_MODE = "160000";

export type MutationOnboardingGitRunner = (
	root: string,
	args: readonly string[],
	maxBytes: number,
) => Uint8Array;

interface MaterializedHeadSnapshot {
	root: string;
	cleanup(): void;
}

interface MutationOnboardingSourceDependencies {
	runGit?: MutationOnboardingGitRunner;
	materialize?: (archiveBytes: Uint8Array) => MaterializedHeadSnapshot;
	readMaterializedTarget?: (root: string, targetFile: string) => Uint8Array;
	selectTests?: (args: {
		editedRelPath: string;
		projectRoot: string;
		maxScope?: number;
	}) => MutationTestScopeResult;
	realpath?: (path: string) => string;
}

interface CaptureMutationOnboardingSourceInput {
	root: string;
	repository: string;
	targetFile: string;
	maxTestScope?: number;
}

export interface CapturedMutationOnboardingSource {
	format: typeof MUTATION_ONBOARDING_SOURCE_FORMAT;
	archivePrefix: typeof MUTATION_ONBOARDING_ARCHIVE_PREFIX;
	repository: string;
	commit: string;
	targetFile: string;
	targetBytes: Uint8Array;
	targetSha256: string;
	sourceArtifactId: string;
	sourceArtifactBytes: Uint8Array;
	sourceArtifactSha256: string;
	scopeMode: "import_graph" | "companion_fallback" | "glob_fallback";
	testFiles: string[];
}

interface GitTreeEntry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function exactBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function defaultGitRunner(root: string, args: readonly string[], maxBytes: number): Uint8Array {
	try {
		const output = execFileSync("git", ["-C", root, ...args], {
			encoding: "buffer",
			maxBuffer: maxBytes,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return Uint8Array.from(output);
	} catch (error) {
		const operation = args[0] ?? "command";
		throw new Error(`mutation onboarding git ${operation} failed or exceeded its bounded output`, {
			cause: error,
		});
	}
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`mutation onboarding ${label} is not valid UTF-8`, { cause: error });
	}
}

function oneLine(bytes: Uint8Array, label: string): string {
	const value = decodeUtf8(bytes, label).replace(/\r?\n$/, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
		throw new Error(`mutation onboarding ${label} is malformed`);
	}
	return value;
}

function parseTreeEntry(record: string): GitTreeEntry {
	const tab = record.indexOf("\t");
	const header = tab < 0 ? [] : record.slice(0, tab).split(" ");
	const path = tab < 0 ? "" : record.slice(tab + 1);
	if (header.length !== TREE_HEADER_FIELDS || path.length === 0) {
		throw new Error("mutation onboarding git tree contains a malformed entry");
	}
	const [mode = "", type = "", oid = ""] = header;
	if (!/^[0-7]{6}$/.test(mode) || !/^[a-f0-9]{40}$/.test(oid)) {
		throw new Error("mutation onboarding git tree contains a malformed identity");
	}
	return { mode, type, oid, path };
}

function parseRegularTree(bytes: Uint8Array): GitTreeEntry[] {
	const text = decodeUtf8(bytes, "git tree");
	const records = text.split("\0");
	if (records.at(-1) !== "") throw new Error("mutation onboarding git tree is not NUL terminated");
	const entries = records.slice(0, -1).map(parseTreeEntry);
	for (const entry of entries) {
		if (entry.mode === GIT_SYMLINK_MODE) {
			throw new Error(`mutation onboarding source tree contains a symlink: ${entry.path}`);
		}
		if (entry.mode === GIT_SUBMODULE_MODE) {
			throw new Error(`mutation onboarding source tree contains a submodule: ${entry.path}`);
		}
		if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
			throw new Error(`mutation onboarding source tree contains a non-regular entry: ${entry.path}`);
		}
	}
	return entries;
}

function selectTarget(entries: readonly GitTreeEntry[], targetFile: string): GitTreeEntry {
	const target = entries.find((entry) => entry.path === targetFile);
	if (target === undefined) {
		throw new Error(`mutation onboarding target is not a tracked file at immutable HEAD: ${targetFile}`);
	}
	return target;
}

function parseTargetSize(bytes: Uint8Array): number {
	const value = oneLine(bytes, "target size");
	if (!/^\d+$/.test(value)) throw new Error("mutation onboarding target size is malformed");
	const size = Number(value);
	if (!Number.isFinite(size) || !Number.isSafeInteger(size) || size > MAX_TARGET_SOURCE_BYTES) {
		throw new Error(`mutation onboarding target exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`);
	}
	return size;
}

function defaultMaterialize(archiveBytes: Uint8Array): MaterializedHeadSnapshot {
	const container = mkdtempSync(join(tmpdir(), "interlinked-onboard-head-"));
	try {
		execFileSync("tar", ["-x", "-f", "-", "-C", container], {
			encoding: "buffer",
			input: exactBuffer(archiveBytes),
			maxBuffer: MAX_TAR_DIAGNOSTIC_BYTES,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: TAR_TIMEOUT_MS,
		});
		const snapshotRoot = join(container, MUTATION_ONBOARDING_ARCHIVE_PREFIX.slice(0, -1));
		if (!lstatSync(snapshotRoot).isDirectory()) {
			throw new Error("mutation onboarding archive did not materialize its versioned root");
		}
		return {
			root: realpathSync(snapshotRoot),
			cleanup: () => rmSync(container, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(container, { recursive: true, force: true });
		throw new Error("mutation onboarding git archive could not be materialized", { cause: error });
	}
}

function defaultReadMaterializedTarget(root: string, targetFile: string): Uint8Array {
	const path = join(root, targetFile);
	let status: ReturnType<typeof lstatSync>;
	try {
		status = lstatSync(path);
	} catch (error) {
		throw new Error("mutation onboarding archive is missing its immutable target", { cause: error });
	}
	if (status.isSymbolicLink()) {
		throw new Error("mutation onboarding archive materialized its target as a symlink");
	}
	if (!status.isFile()) {
		throw new Error("mutation onboarding archive materialized a non-regular target");
	}
	if (status.size > MAX_TARGET_SOURCE_BYTES) {
		throw new Error(`mutation onboarding archive target exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`);
	}
	return readFileSync(path);
}

function scopeProjection(scope: MutationTestScopeResult): Pick<
	CapturedMutationOnboardingSource,
	"scopeMode" | "testFiles"
> {
	if (scope.tests !== null) {
		return { scopeMode: "import_graph", testFiles: [...scope.tests].sort() };
	}
	if (scope.companionScope !== undefined && scope.companionScope.length > 0) {
		return { scopeMode: "companion_fallback", testFiles: [...scope.companionScope].sort() };
	}
	return { scopeMode: "glob_fallback", testFiles: [] };
}

function validateCaptureInput(input: CaptureMutationOnboardingSourceInput): void {
	const repositoryFailure = checkBoundedString(input.repository, "repository");
	if (repositoryFailure !== null) throw new Error(`mutation onboarding ${repositoryFailure}`);
	const targetFailure = checkRepoRelativePath(input.targetFile, "target");
	if (targetFailure !== null) throw new Error(`mutation onboarding ${targetFailure}`);
	if (input.maxTestScope !== undefined && (!Number.isSafeInteger(input.maxTestScope) || input.maxTestScope < 1)) {
		throw new Error("mutation onboarding maxTestScope must be a positive safe integer");
	}
}

function assertStableRepository(args: {
	runGit: MutationOnboardingGitRunner;
	root: string;
	head: string;
	initialStatus: Uint8Array;
}): void {
	const finalHead = oneLine(
		args.runGit(args.root, ["rev-parse", "--verify", "HEAD^{commit}"], MAX_SHA_LINE_BYTES),
		"final HEAD",
	);
	const finalStatus = args.runGit(
		args.root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		MAX_GIT_METADATA_BYTES,
	);
	if (finalHead !== args.head || !Buffer.from(finalStatus).equals(exactBuffer(args.initialStatus))) {
		throw new Error("mutation onboarding repository HEAD or status changed during immutable capture");
	}
}

/** Capture one clean, immutable HEAD. All Git calls use argv arrays; no shell
 * command is constructed. Test selection runs only inside the materialized
 * bytes produced by the versioned archive contract. */
export function captureMutationOnboardingSource(
	input: CaptureMutationOnboardingSourceInput,
	dependencies: MutationOnboardingSourceDependencies = {},
): CapturedMutationOnboardingSource {
	validateCaptureInput(input);
	const runGit = dependencies.runGit ?? defaultGitRunner;
	const resolveRealpath = dependencies.realpath ?? realpathSync;
	const root = resolveRealpath(input.root);
	const top = oneLine(
		runGit(root, ["rev-parse", "--show-toplevel"], MAX_REPOSITORY_ROOT_BYTES),
		"repository root",
	);
	if (resolveRealpath(top) !== root) {
		throw new Error("mutation onboarding cwd is not the root of the captured Git repository");
	}
	const initialStatus = runGit(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		MAX_GIT_METADATA_BYTES,
	);
	if (initialStatus.byteLength !== 0) {
		throw new Error("mutation onboarding requires a clean staged, unstaged, and untracked worktree");
	}
	const head = oneLine(
		runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], MAX_SHA_LINE_BYTES),
		"HEAD",
	);
	if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("mutation onboarding HEAD is not a full commit SHA");
	const entries = parseRegularTree(runGit(
		root,
		["ls-tree", "-rz", "--full-tree", head],
		MAX_GIT_METADATA_BYTES,
	));
	const target = selectTarget(entries, input.targetFile);
	const targetSize = parseTargetSize(runGit(root, ["cat-file", "-s", target.oid], 64));
	const targetBytes = runGit(root, ["cat-file", "blob", target.oid], MAX_TARGET_SOURCE_BYTES + 1);
	if (targetBytes.byteLength !== targetSize) {
		throw new Error("mutation onboarding immutable target bytes differ from the Git object size");
	}
	const sourceArtifactBytes = runGit(
		root,
		[
			"archive",
			"--format=tar",
			`--prefix=${MUTATION_ONBOARDING_ARCHIVE_PREFIX}`,
			head,
		],
		MAX_SOURCE_ARTIFACT_BYTES,
	);
	if (sourceArtifactBytes.byteLength < 1 || sourceArtifactBytes.byteLength > MAX_SOURCE_ARTIFACT_BYTES) {
		throw new Error(`mutation onboarding archive must contain 1..${MAX_SOURCE_ARTIFACT_BYTES} bytes`);
	}
	const materialized = (dependencies.materialize ?? defaultMaterialize)(sourceArtifactBytes);
	let scope: MutationTestScopeResult;
	try {
		const materializedTarget = (dependencies.readMaterializedTarget ?? defaultReadMaterializedTarget)(
			materialized.root,
			input.targetFile,
		);
		if (!exactBuffer(materializedTarget).equals(exactBuffer(targetBytes))) {
			throw new Error("mutation onboarding archive target differs from the immutable Git blob");
		}
		scope = (dependencies.selectTests ?? computeMutationTestScopeForRepo)({
			editedRelPath: input.targetFile,
			projectRoot: materialized.root,
			...(input.maxTestScope === undefined ? {} : { maxScope: input.maxTestScope }),
		});
	} finally {
		materialized.cleanup();
	}
	assertStableRepository({ runGit, root, head, initialStatus });
	const sourceArtifactSha256 = sha256(sourceArtifactBytes);
	return {
		format: MUTATION_ONBOARDING_SOURCE_FORMAT,
		archivePrefix: MUTATION_ONBOARDING_ARCHIVE_PREFIX,
		repository: input.repository,
		commit: head,
		targetFile: input.targetFile,
		targetBytes: Uint8Array.from(targetBytes),
		targetSha256: sha256(targetBytes),
		sourceArtifactId: `src_git_archive_v1_${sourceArtifactSha256}`,
		sourceArtifactBytes: Uint8Array.from(sourceArtifactBytes),
		sourceArtifactSha256,
		...scopeProjection(scope),
	};
}
