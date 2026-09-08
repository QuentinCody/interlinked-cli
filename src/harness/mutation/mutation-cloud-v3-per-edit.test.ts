import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	prepareMutationCloudV3PerEdit,
	type MutationCloudV3PerEditAuthority,
} from "./mutation-cloud-v3-per-edit.js";
import {
	captureMutationOverlaySource,
	type CapturedMutationOverlaySource,
} from "./mutation-cloud-v3-overlay-source.js";
import { canonicalRequestHash } from "./protocol-v3/request.js";

const AUTHORITY: MutationCloudV3PerEditAuthority = {
	tenant: "tenant-test",
	project: "project-test",
	repository: "github.com/interlinked/test",
};
const TARGET = "src/target.ts";
const PROPOSED = Buffer.from("export const value = 'proposed';\n", "utf8");
const temporaryRepositories: string[] = [];

function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fakeCapture(
	proposedBytes: Uint8Array = PROPOSED,
	overrides: Partial<CapturedMutationOverlaySource> = {},
): CapturedMutationOverlaySource {
	const targetBytes = Uint8Array.from(proposedBytes);
	const targetSha256 = digest(targetBytes);
	const artifactBytes = Buffer.concat([Buffer.from("archive:"), Buffer.from(targetBytes)]);
	const sourceArtifactSha256 = digest(artifactBytes);
	const commit = createHash("sha1").update(targetBytes).digest("hex");
	return {
		format: "git-archive-tar-v1",
		archivePrefix: "interlinked-source-v1/",
		repository: AUTHORITY.repository,
		baseCommit: "1".repeat(40),
		commit,
		targetFile: TARGET,
		targetBytes,
		targetSha256,
		sourceArtifactId: `src_git_archive_v1_${sourceArtifactSha256}`,
		sourceArtifactBytes: artifactBytes,
		sourceArtifactSha256,
		scopeMode: "import_graph",
		testFiles: ["src/z.test.ts", "src/a.test.ts"],
		changesetTarget: { path: TARGET, content_hash: targetSha256 },
		...overrides,
	};
}

function prepare(
	proposedBytes: Uint8Array = PROPOSED,
	capture: CapturedMutationOverlaySource = fakeCapture(proposedBytes),
) {
	return prepareMutationCloudV3PerEdit(
		{ root: "/repo", targetFile: TARGET, proposedBytes, authority: AUTHORITY },
		{ captureSource: () => capture },
	);
}

function git(root: string, args: readonly string[]): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "buffer",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "946684800 +0000",
			GIT_COMMITTER_DATE: "946684800 +0000",
		},
	});
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-per-edit-test-"));
	temporaryRepositories.push(root);
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.name", "Interlinked Test"]);
	git(root, ["config", "user.email", "test@interlinked.invalid"]);
	write(root, TARGET, "export const value = 'base';\n");
	write(root, "src/a.test.ts", "export const testA = true;\n");
	write(root, "src/z.test.ts", "export const testZ = true;\n");
	write(root, "src/unrelated.ts", "export const unrelated = 'head';\n");
	git(root, ["add", "--all"]);
	git(root, ["commit", "--quiet", "-m", "base"]);
	return root;
}

afterEach(() => {
	for (const root of temporaryRepositories.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("prepareMutationCloudV3PerEdit", () => {
	it("binds one whole target, canonical tests, synthetic commit, and exact artifact bytes", () => {
		const captured = fakeCapture();
		const prepared = prepare(PROPOSED, captured);

		expect(prepared.request.job).toEqual({
			...AUTHORITY,
			commit: captured.commit,
			target_file: TARGET,
			target_content_hash: captured.targetSha256,
			job_key: expect.stringMatching(/^job_edit_v3_[0-9a-f]{64}$/),
		});
		expect(prepared.request.source_artifact).toEqual({
			format: captured.format,
			artifact_id: captured.sourceArtifactId,
			sha256: captured.sourceArtifactSha256,
			bytes: captured.sourceArtifactBytes.byteLength,
		});
		expect(prepared.request.scope_mode).toBe("import_graph");
		expect(prepared.request.test_files).toEqual(["src/a.test.ts", "src/z.test.ts"]);
		expect(prepared.request.changeset).toEqual([
			{ path: TARGET, content_hash: captured.targetSha256 },
		]);
		expect(Buffer.from(prepared.sourceArtifactBytes)).toEqual(Buffer.from(captured.sourceArtifactBytes));
		expect(Buffer.from(prepared.targetBytes)).toEqual(PROPOSED);
	});

	it("mints deterministic idempotency only from immutable overlay and caller authority", () => {
		const first = prepare();
		const replay = prepare();
		const changedBytes = Buffer.from("export const value = 'changed';\n", "utf8");
		const changed = prepare(changedBytes);

		expect(replay.request.job.job_key).toBe(first.request.job.job_key);
		expect(canonicalRequestHash(replay.request)).toBe(canonicalRequestHash(first.request));
		expect(changed.request.job.job_key).not.toBe(first.request.job.job_key);
		expect(canonicalRequestHash(changed.request)).not.toBe(canonicalRequestHash(first.request));
	});

	it("emits the protocol request fields", () => {
		expect(Object.keys(prepare().request)).toEqual([
			"request_version",
			"protocol_version",
			"job",
			"source_artifact",
			"scope_mode",
			"test_files",
			"changeset",
		]);
	});

	it("rejects duplicate tests instead of silently changing test identity", () => {
		const captured = fakeCapture(PROPOSED, {
			testFiles: ["src/a.test.ts", "src/a.test.ts"],
		});
		expect(() => prepare(PROPOSED, captured)).toThrow("duplicate test files");
	});

	it.each([
		["repository", { repository: "github.com/foreign/repo" }, "foreign repository"],
		["target", { targetFile: "src/foreign.ts" }, "foreign target"],
		["artifact id", { sourceArtifactId: "src_foreign_artifact" }, "foreign source artifact identity"],
		["artifact hash", { sourceArtifactSha256: "0".repeat(64) }, "artifact hash disagrees"],
	])("rejects a %s supplied by a foreign or malformed capture", (_label, overrides, reason) => {
		const captured = fakeCapture(PROPOSED, overrides);
		expect(() => prepare(PROPOSED, captured)).toThrow(reason);
	});

	it("rejects captured target bytes that are not the caller's proposed edit", () => {
		const captured = fakeCapture(Buffer.from("foreign bytes", "utf8"));
		expect(() => prepare(PROPOSED, captured)).toThrow("differ from the proposed edit");
	});

	it("rejects a targetSha256 that disagrees with the actual target bytes", () => {
		// targetBytes still equals the caller's proposed bytes (equalBytes
		// passes), so only the sha256(targetBytes) !== targetSha256 check fires.
		const captured = fakeCapture(PROPOSED, { targetSha256: "0".repeat(64) });
		expect(() => prepare(PROPOSED, captured)).toThrow(
			"mutation per-edit capture target hash disagrees with its bytes",
		);
	});

	it("rejects a changeset target whose path/hash disagree with the bound target", () => {
		// Every prior binding (repository/target/bytes/hashes/artifact id)
		// matches; only the final changesetTarget.content_hash comparison fires.
		const captured = fakeCapture(PROPOSED, {
			changesetTarget: { path: TARGET, content_hash: "0".repeat(64) },
		});
		expect(() => prepare(PROPOSED, captured)).toThrow(
			"mutation per-edit capture changeset disagrees with its target binding",
		);
	});

	it("uses the HEAD-only overlay primitive so unrelated dirty worktree bytes never enter identity", () => {
		const root = repository();
		write(root, TARGET, "export const value = 'dirty worktree';\n");
		write(root, "src/unrelated.ts", "export const unrelated = 'dirty';\n");
		write(root, "src/untracked.ts", "export const untracked = true;\n");
		const statusBefore = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		const prepared = prepareMutationCloudV3PerEdit(
			{ root, targetFile: TARGET, proposedBytes: PROPOSED, authority: AUTHORITY },
			{
				captureSource: (input) => captureMutationOverlaySource(input, {
					selectTests: ({ projectRoot }) => {
						expect(readFileSync(join(projectRoot, TARGET))).toEqual(PROPOSED);
						expect(readFileSync(join(projectRoot, "src/unrelated.ts"), "utf8")).toContain("'head'");
						expect(() => readFileSync(join(projectRoot, "src/untracked.ts"))).toThrow();
						return { tests: ["src/z.test.ts", "src/a.test.ts"] };
					},
				}),
			},
		);

		expect(prepared.request.test_files).toEqual(["src/a.test.ts", "src/z.test.ts"]);
		expect(prepared.request.job.target_content_hash).toBe(digest(PROPOSED));
		expect(Buffer.from(prepared.targetBytes)).toEqual(PROPOSED);
		expect(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toEqual(statusBefore);
	});
});
