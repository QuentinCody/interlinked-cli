// ===============================================================
// Mutation cloud v3 — immutable HEAD plus one proposed target
// ===============================================================
// This is the source-capture primitive for a future per-edit v3 job. It does
// not read proposed bytes from the worktree and does not update the source
// repository's index, objects, refs, or working files. Synthetic Git objects
// and the synthetic index live in a disposable directory; the source object
// database is read through Git's alternates mechanism.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMutationTestScopeForRepo, type MutationTestScopeResult } from "./test-scope.js";
import {
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
} from "./mutation-cloud-v3-onboarding-source.js";
import {
	checkBoundedString,
	checkRepoRelativePath,
	MAX_SOURCE_ARTIFACT_BYTES,
	MAX_TARGET_SOURCE_BYTES,
} from "./protocol-v3/field-checks.js";

const GIT_TIMEOUT_MS = 60_000;
const TAR_TIMEOUT_MS = 60_000;
const MAX_GIT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_TAR_DIAGNOSTIC_BYTES = 64 * 1024;
const SYNTHETIC_COMMIT_MESSAGE = "Interlinked protocol-v3 proposed overlay\n";
const SYNTHETIC_GIT_DATE = "946684800 +0000";
const GIT_METADATA_DIRECTORY = ".git";
const GIT_SUBMODULE_MODE = "160000";
const GIT_SYMLINK_MODE = "120000";
const REGULAR_MODES = new Set(["100644", "100755"]);

interface CaptureMutationOverlaySourceInput {
	root: string;
	repository: string;
	targetFile: string;
	proposedBytes: Uint8Array;
	maxTestScope?: number;
}

interface MutationOverlaySourceDependencies {
	selectTests?: (args: {
		editedRelPath: string;
		projectRoot: string;
		maxScope?: number;
	}) => MutationTestScopeResult;
	realpath?: (path: string) => string;
	/** A caller may lower, but never raise, the protocol artifact ceiling. */
	sourceArtifactByteLimit?: number;
}

export interface CapturedMutationOverlaySource {
	format: typeof MUTATION_ONBOARDING_SOURCE_FORMAT;
	archivePrefix: typeof MUTATION_ONBOARDING_ARCHIVE_PREFIX;
	repository: string;
	baseCommit: string;
	/** Synthetic commit embedded in the Git tar and used by request.job.commit. */
	commit: string;
	targetFile: string;
	targetBytes: Uint8Array;
	targetSha256: string;
	sourceArtifactId: string;
	sourceArtifactBytes: Uint8Array;
	sourceArtifactSha256: string;
	scopeMode: "import_graph" | "companion_fallback" | "glob_fallback";
	testFiles: string[];
	changesetTarget: { path: string; content_hash: string };
}

interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

interface GitInvocation {
	env?: NodeJS.ProcessEnv;
	input?: Uint8Array;
	maxBytes?: number;
	label: string;
}

function exactBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, args: readonly string[], invocation: GitInvocation): Uint8Array {
	try {
		const output = execFileSync("git", ["-C", root, ...args], {
			encoding: "buffer",
			env: invocation.env,
			input: invocation.input === undefined ? undefined : exactBuffer(invocation.input),
			maxBuffer: invocation.maxBytes ?? MAX_GIT_TEXT_BYTES,
			stdio: [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return Uint8Array.from(output);
	} catch (error) {
		throw new Error(`mutation overlay ${invocation.label} failed or exceeded its bounded output`, {
			cause: error,
		});
	}
}

function decodeLine(bytes: Uint8Array, label: string): string {
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "");
	} catch (error) {
		throw new Error(`mutation overlay ${label} is not valid UTF-8`, { cause: error });
	}
	if (value.length === 0 || /[\r\n\0]/.test(value)) {
		throw new Error(`mutation overlay ${label} is malformed`);
	}
	return value;
}

function safePath(path: string, where: string): void {
	const failure = checkRepoRelativePath(path, where);
	if (failure !== null) throw new Error(`mutation overlay ${failure}`);
	if (
		/[\0\r\n]/.test(path) ||
		path.split("/").some((segment) => segment.toLowerCase() === GIT_METADATA_DIRECTORY)
	) {
		throw new Error(`mutation overlay ${where} is unsafe for archive materialization`);
	}
}

function parseTree(bytes: Uint8Array): TreeEntry[] {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error("mutation overlay HEAD tree is not valid UTF-8", { cause: error });
	}
	const records = text.split("\0");
	if (records.at(-1) !== "") throw new Error("mutation overlay HEAD tree is not NUL terminated");
	return records.slice(0, -1).map((record) => {
		const tab = record.indexOf("\t");
		const [mode = "", type = "", oid = ""] = tab < 0 ? [] : record.slice(0, tab).split(" ");
		const path = tab < 0 ? "" : record.slice(tab + 1);
		if (!/^[0-7]{6}$/.test(mode) || !/^[a-f0-9]{40}$/.test(oid) || path.length === 0) {
			throw new Error("mutation overlay HEAD tree contains a malformed entry");
		}
		safePath(path, "HEAD path");
		if (mode === GIT_SYMLINK_MODE) throw new Error(`mutation overlay HEAD contains a symlink: ${path}`);
		if (mode === GIT_SUBMODULE_MODE) throw new Error(`mutation overlay HEAD contains a submodule: ${path}`);
		if (type !== "blob" || !REGULAR_MODES.has(mode)) {
			throw new Error(`mutation overlay HEAD contains a non-regular entry: ${path}`);
		}
		return { mode, type, oid, path };
	});
}

function checkTargetCollision(entries: readonly TreeEntry[], targetFile: string): TreeEntry | undefined {
	const existing = entries.find((entry) => entry.path === targetFile);
	if (existing !== undefined) return existing;
	const collision = entries.find(
		(entry) => targetFile.startsWith(`${entry.path}/`) || entry.path.startsWith(`${targetFile}/`),
	);
	if (collision !== undefined) {
		throw new Error(`mutation overlay new target conflicts with tracked path: ${collision.path}`);
	}
	return undefined;
}

function scopeProjection(scope: MutationTestScopeResult): Pick<
	CapturedMutationOverlaySource,
	"scopeMode" | "testFiles"
> {
	if (scope.tests !== null) return { scopeMode: "import_graph", testFiles: [...scope.tests].sort() };
	if (scope.companionScope !== undefined && scope.companionScope.length > 0) {
		return { scopeMode: "companion_fallback", testFiles: [...scope.companionScope].sort() };
	}
	return { scopeMode: "glob_fallback", testFiles: [] };
}

function isolatedEnvironment(tempRoot: string, sourceObjects: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
		GIT_AUTHOR_DATE: SYNTHETIC_GIT_DATE,
		GIT_AUTHOR_EMAIL: "mutation@interlinked.invalid",
		GIT_AUTHOR_NAME: "Interlinked Mutation",
		GIT_COMMITTER_DATE: SYNTHETIC_GIT_DATE,
		GIT_COMMITTER_EMAIL: "mutation@interlinked.invalid",
		GIT_COMMITTER_NAME: "Interlinked Mutation",
		GIT_INDEX_FILE: join(tempRoot, "index"),
		GIT_OBJECT_DIRECTORY: join(tempRoot, "objects"),
		GIT_OPTIONAL_LOCKS: "0",
	};
}

function materializeArchive(archiveBytes: Uint8Array): { container: string; root: string } {
	const container = mkdtempSync(join(tmpdir(), "interlinked-overlay-materialized-"));
	try {
		execFileSync("tar", ["-x", "-f", "-", "-C", container], {
			encoding: "buffer",
			input: exactBuffer(archiveBytes),
			maxBuffer: MAX_TAR_DIAGNOSTIC_BYTES,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: TAR_TIMEOUT_MS,
		});
		const root = join(container, MUTATION_ONBOARDING_ARCHIVE_PREFIX.slice(0, -1));
		if (!lstatSync(root).isDirectory()) throw new Error("versioned archive root is missing");
		return { container, root: realpathSync(root) };
	} catch (error) {
		rmSync(container, { recursive: true, force: true });
		throw new Error("mutation overlay archive could not be materialized", { cause: error });
	}
}

function readExactTarget(root: string, targetFile: string, proposedBytes: Uint8Array): void {
	const targetPath = join(root, targetFile);
	let status: ReturnType<typeof lstatSync>;
	try {
		status = lstatSync(targetPath);
	} catch (error) {
		throw new Error("mutation overlay archive is missing the proposed target", { cause: error });
	}
	if (!status.isFile() || status.isSymbolicLink()) {
		throw new Error("mutation overlay archive target is not a regular file");
	}
	const actual = readFileSync(targetPath);
	if (!actual.equals(exactBuffer(proposedBytes))) {
		throw new Error("mutation overlay archive target differs from the proposed bytes");
	}
}

function validateInput(input: CaptureMutationOverlaySourceInput): Uint8Array {
	const repositoryFailure = checkBoundedString(input.repository, "repository");
	if (repositoryFailure !== null) throw new Error(`mutation overlay ${repositoryFailure}`);
	safePath(input.targetFile, "target");
	if (input.maxTestScope !== undefined && (!Number.isSafeInteger(input.maxTestScope) || input.maxTestScope < 1)) {
		throw new Error("mutation overlay maxTestScope must be a positive safe integer");
	}
	const proposedBytes = Uint8Array.from(input.proposedBytes);
	if (proposedBytes.byteLength > MAX_TARGET_SOURCE_BYTES) {
		throw new Error(`mutation overlay target exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`);
	}
	return proposedBytes;
}

/**
 * Public protocol-v3 capture primitive for the future per-edit adapter.
 * Capture immutable HEAD plus exactly one proposed regular-file target.
 */
export function captureMutationOverlaySource(
	input: CaptureMutationOverlaySourceInput,
	dependencies: MutationOverlaySourceDependencies = {},
): CapturedMutationOverlaySource {
	const proposedBytes = validateInput(input);
	const resolveRealpath = dependencies.realpath ?? realpathSync;
	const root = resolveRealpath(input.root);
	const top = decodeLine(git(root, ["rev-parse", "--show-toplevel"], { label: "repository root" }), "repository root");
	if (resolveRealpath(top) !== root) throw new Error("mutation overlay cwd is not the repository root");
	const baseCommit = decodeLine(
		git(root, ["rev-parse", "--verify", "HEAD^{commit}"], { label: "HEAD" }),
		"HEAD",
	);
	if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("mutation overlay HEAD is not a full SHA-1 commit");
	const entries = parseTree(git(root, ["ls-tree", "-rz", "--full-tree", baseCommit], { label: "HEAD tree" }));
	const existing = checkTargetCollision(entries, input.targetFile);
	const sourceObjects = decodeLine(
		git(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], { label: "object path" }),
		"object path",
	);
	const tempRoot = mkdtempSync(join(tmpdir(), "interlinked-overlay-git-"));
	mkdirSync(join(tempRoot, "objects"));
	let materialized: { container: string; root: string } | null = null;
	try {
		const env = isolatedEnvironment(tempRoot, sourceObjects);
		git(root, ["read-tree", baseCommit], { env, label: "temporary read-tree" });
		const blob = decodeLine(
			git(root, ["hash-object", "-w", "--stdin"], { env, input: proposedBytes, label: "temporary blob" }),
			"proposed blob id",
		);
		const mode = existing?.mode ?? "100644";
		git(root, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${input.targetFile}`], {
			env,
			label: "temporary index update",
		});
		const tree = decodeLine(git(root, ["write-tree"], { env, label: "temporary tree" }), "synthetic tree id");
		const commit = decodeLine(
			git(root, ["commit-tree", tree, "-p", baseCommit], {
				env,
				input: Buffer.from(SYNTHETIC_COMMIT_MESSAGE, "utf8"),
				label: "synthetic commit",
			}),
			"synthetic commit id",
		);
		const requestedLimit = dependencies.sourceArtifactByteLimit ?? MAX_SOURCE_ARTIFACT_BYTES;
		const artifactLimit = Math.min(MAX_SOURCE_ARTIFACT_BYTES, requestedLimit);
		if (!Number.isSafeInteger(artifactLimit) || artifactLimit < 1) {
			throw new Error("mutation overlay sourceArtifactByteLimit must be a positive safe integer");
		}
		const sourceArtifactBytes = git(
			root,
			["archive", "--format=tar", `--prefix=${MUTATION_ONBOARDING_ARCHIVE_PREFIX}`, commit],
			{ env, maxBytes: artifactLimit + 1, label: "synthetic archive" },
		);
		if (sourceArtifactBytes.byteLength < 1 || sourceArtifactBytes.byteLength > artifactLimit) {
			throw new Error(`mutation overlay archive must contain 1..${artifactLimit} bytes`);
		}
		const embeddedCommit = decodeLine(
			git(root, ["get-tar-commit-id"], {
				env,
				input: sourceArtifactBytes,
				label: "archive commit verification",
			}),
			"archive commit id",
		);
		if (embeddedCommit !== commit) throw new Error("mutation overlay archive commit id disagrees with the request commit");
		materialized = materializeArchive(sourceArtifactBytes);
		readExactTarget(materialized.root, input.targetFile, proposedBytes);
		const scope = (dependencies.selectTests ?? computeMutationTestScopeForRepo)({
			editedRelPath: input.targetFile,
			projectRoot: materialized.root,
			...(input.maxTestScope === undefined ? {} : { maxScope: input.maxTestScope }),
		});
		const finalHead = decodeLine(
			git(root, ["rev-parse", "--verify", "HEAD^{commit}"], { label: "final HEAD" }),
			"final HEAD",
		);
		if (finalHead !== baseCommit) throw new Error("mutation overlay repository HEAD changed during capture");
		const targetSha256 = sha256(proposedBytes);
		const sourceArtifactSha256 = sha256(sourceArtifactBytes);
		return {
			format: MUTATION_ONBOARDING_SOURCE_FORMAT,
			archivePrefix: MUTATION_ONBOARDING_ARCHIVE_PREFIX,
			repository: input.repository,
			baseCommit,
			commit,
			targetFile: input.targetFile,
			targetBytes: Uint8Array.from(proposedBytes),
			targetSha256,
			sourceArtifactId: `src_git_archive_v1_${sourceArtifactSha256}`,
			sourceArtifactBytes: Uint8Array.from(sourceArtifactBytes),
			sourceArtifactSha256,
			...scopeProjection(scope),
			changesetTarget: { path: input.targetFile, content_hash: targetSha256 },
		};
	} finally {
		if (materialized !== null) rmSync(materialized.container, { recursive: true, force: true });
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
