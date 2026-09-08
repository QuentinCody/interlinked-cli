// test-contract: unit — onboarding captures one clean immutable HEAD only.
//
// Two fixture layers. The injected layer (`gitFixture` + injected
// materialize/readMaterializedTarget) pins the argv, parse, and ordering
// contract without touching the disk. The real layer (`initGitRepo`,
// `tempDir`, hand-built tar bytes) exercises the DEFAULT dependencies the
// injected layer replaces — `defaultGitRunner` (execFileSync git),
// `defaultMaterialize` (execFileSync tar into a mkdtemp container), and
// `defaultReadMaterializedTarget` (lstat + readFile). Every temp root the
// TEST makes is registered in `tempRoots` and removed in `afterEach`; the
// mkdtemp container `defaultMaterialize` makes is owned by the module, so
// the real layer observes its lifecycle with `existsSync` instead (the
// injected `selectTests` records the snapshot root while it is still alive).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureMutationOnboardingSource,
	type CapturedMutationOnboardingSource,
	MUTATION_ONBOARDING_ARCHIVE_FORMAT_CONTRACT,
	MUTATION_ONBOARDING_ARCHIVE_PREFIX,
	MUTATION_ONBOARDING_SOURCE_FORMAT,
	type MutationOnboardingGitRunner,
} from "./mutation-cloud-v3-onboarding-source.js";
import { MAX_SOURCE_ARTIFACT_BYTES, MAX_TARGET_SOURCE_BYTES } from "./protocol-v3/field-checks.js";
import type { MutationTestScopeResult } from "./test-scope.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT_HEAD = "1123456789abcdef0123456789abcdef01234567";
const TARGET_OID = "a".repeat(40);
const TARGET = Buffer.from("export const answer = 42;\n", "utf8");
const ARCHIVE = Buffer.from("exact deterministic tar fixture", "utf8");

function bytes(value: string): Uint8Array {
	return Buffer.from(value, "utf8");
}

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempRoots.push(dir);
	return dir;
}

function captureError(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		// SAFETY: every throw site in the module under test constructs `new Error(...)`.
		return error as Error;
	}
	throw new Error("expected captureMutationOnboardingSource to throw");
}

/** A throwaway repository whose single commit tracks exactly `src/answer.ts`. */
function initGitRepo(): string {
	const root = tempDir("interlinked-onboard-repo-");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "answer.ts"), TARGET);
	const argvs = [
		["init", "-q"],
		["config", "user.email", "onboarding@example.com"],
		["config", "user.name", "Onboarding Test"],
		["add", "."],
		["commit", "-q", "-m", "immutable head"],
	];
	for (const argv of argvs) execFileSync("git", argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
	return root;
}

/** Real tar bytes whose single member is a FILE named like the versioned root. */
function tarWithFileAtVersionedRoot(): Uint8Array {
	const staging = tempDir("interlinked-onboard-stage-");
	const member = MUTATION_ONBOARDING_ARCHIVE_PREFIX.slice(0, -1);
	writeFileSync(join(staging, member), "not a directory");
	return Uint8Array.from(
		execFileSync("tar", ["-c", "-f", "-", "-C", staging, member], {
			encoding: "buffer",
			maxBuffer: 1024 * 1024,
		}),
	);
}

/** Drive capture with the DEFAULT `readMaterializedTarget` over a root we own. */
function captureReadingMaterializedRoot(materializedRoot: string): Error {
	const git = gitFixture();
	return captureError(() =>
		captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				runGit: git.runGit,
				realpath: (path) => path,
				materialize: () => ({ root: materializedRoot, cleanup: vi.fn() }),
				selectTests: () => ({ tests: [] }),
			},
		),
	);
}

function captureWithScope(scope: MutationTestScopeResult, maxTestScope?: number): CapturedMutationOnboardingSource {
	const git = gitFixture();
	return captureMutationOnboardingSource(
		{
			root: "/repo",
			repository: "github.com/example/repo",
			targetFile: "src/answer.ts",
			...(maxTestScope === undefined ? {} : { maxTestScope }),
		},
		{
			runGit: git.runGit,
			realpath: (path) => path,
			materialize: () => ({ root: "/materialized-head", cleanup: vi.fn() }),
			readMaterializedTarget: () => TARGET,
			selectTests: () => scope,
		},
	);
}

function missingMaterializedTarget(): never {
	throw new Error("missing");
}

function foreignMaterializedTarget(): Uint8Array {
	return bytes("foreign target");
}

function regularTree(path = "src/answer.ts"): string {
	return `100644 blob ${TARGET_OID}\t${path}\0`;
}

interface GitFixtureOptions {
	top?: string;
	statuses?: Uint8Array[];
	heads?: string[];
	tree?: string;
	targetSize?: string;
	targetBytes?: Uint8Array;
	archiveBytes?: Uint8Array;
}

function gitFixture(options: GitFixtureOptions = {}): {
	runGit: MutationOnboardingGitRunner;
	calls: Array<{ args: string[]; maxBytes: number }>;
} {
	const calls: Array<{ args: string[]; maxBytes: number }> = [];
	const statuses = [...(options.statuses ?? [new Uint8Array(), new Uint8Array()])];
	const heads = [...(options.heads ?? [HEAD, HEAD])];
	const runGit: MutationOnboardingGitRunner = (_root, rawArgs, maxBytes) => {
		const args = [...rawArgs];
		calls.push({ args, maxBytes });
		if (args.join(" ") === "rev-parse --show-toplevel") return bytes(`${options.top ?? "/repo"}\n`);
		if (args[0] === "status") return statuses.shift() ?? new Uint8Array();
		if (args.join(" ") === "rev-parse --verify HEAD^{commit}") {
			return bytes(`${heads.shift() ?? HEAD}\n`);
		}
		if (args[0] === "ls-tree") return bytes(options.tree ?? regularTree());
		if (args[0] === "cat-file" && args[1] === "-s") {
			return bytes(`${options.targetSize ?? String((options.targetBytes ?? TARGET).byteLength)}\n`);
		}
		if (args[0] === "cat-file" && args[1] === "blob") {
			return Uint8Array.from(options.targetBytes ?? TARGET);
		}
		if (args[0] === "archive") return Uint8Array.from(options.archiveBytes ?? ARCHIVE);
		throw new Error(`unexpected git argv: ${args.join(" ")}`);
	};
	return { runGit, calls };
}

function captureWith(options: GitFixtureOptions = {}) {
	const git = gitFixture(options);
	const cleanup = vi.fn();
	const readMaterializedTarget = vi.fn(() => TARGET);
	const selectTests = vi.fn(() => ({ tests: ["src/z.test.ts", "src/a.test.ts"] }));
	const captured = captureMutationOnboardingSource(
		{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
		{
			runGit: git.runGit,
			realpath: (path) => path,
			materialize: (archiveBytes) => {
				expect(Buffer.from(archiveBytes)).toEqual(ARCHIVE);
				return { root: "/materialized-head", cleanup };
			},
			readMaterializedTarget,
			selectTests,
		},
	);
	return { captured, calls: git.calls, cleanup, readMaterializedTarget, selectTests };
}

describe("captureMutationOnboardingSource", () => {
	it("captures exact HEAD bytes under the explicit versioned archive contract", () => {
		const { captured, calls, cleanup, readMaterializedTarget, selectTests } = captureWith();
		expect(captured).toMatchObject({
			format: "git-archive-tar-v1",
			archivePrefix: "interlinked-source-v1/",
			repository: "github.com/example/repo",
			commit: HEAD,
			targetFile: "src/answer.ts",
			targetSha256: digest(TARGET),
			sourceArtifactId: `src_git_archive_v1_${digest(ARCHIVE)}`,
			sourceArtifactSha256: digest(ARCHIVE),
			scopeMode: "import_graph",
			testFiles: ["src/a.test.ts", "src/z.test.ts"],
		});
		expect(Buffer.from(captured.targetBytes)).toEqual(TARGET);
		expect(Buffer.from(captured.sourceArtifactBytes)).toEqual(ARCHIVE);
		expect(selectTests).toHaveBeenCalledWith({
			editedRelPath: "src/answer.ts",
			projectRoot: "/materialized-head",
		});
		expect(selectTests).not.toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/repo" }));
		expect(readMaterializedTarget).toHaveBeenCalledWith("/materialized-head", "src/answer.ts");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(calls.map(({ args }) => args)).toEqual([
			["rev-parse", "--show-toplevel"],
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			["rev-parse", "--verify", "HEAD^{commit}"],
			["ls-tree", "-rz", "--full-tree", HEAD],
			["cat-file", "-s", TARGET_OID],
			["cat-file", "blob", TARGET_OID],
			["archive", "--format=tar", `--prefix=${MUTATION_ONBOARDING_ARCHIVE_PREFIX}`, HEAD],
			["rev-parse", "--verify", "HEAD^{commit}"],
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		]);
		expect(calls.find(({ args }) => args[0] === "archive")?.maxBytes).toBe(MAX_SOURCE_ARTIFACT_BYTES);
		expect(MUTATION_ONBOARDING_SOURCE_FORMAT).toBe("git-archive-tar-v1");
		expect(MUTATION_ONBOARDING_ARCHIVE_FORMAT_CONTRACT).toEqual({
			format: "git-archive-tar-v1",
			command: "git archive --format=tar --prefix=interlinked-source-v1/ <full-HEAD>",
			prefix: "interlinked-source-v1/",
			compression: "none",
		});
	});

	it.each([
		["staged", "M  src/answer.ts\0"],
		["unstaged", " M src/answer.ts\0"],
		["untracked", "?? scratch.ts\0"],
	])("rejects a %s worktree before reading HEAD or artifact bytes", (_kind, status) => {
		const git = gitFixture({ statuses: [bytes(status)] });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("requires a clean staged, unstaged, and untracked worktree");
		expect(git.calls.map(({ args }) => args[0])).toEqual(["rev-parse", "status"]);
	});

	it("rejects a target absent from immutable HEAD", () => {
		const git = gitFixture({ tree: regularTree("src/other.ts") });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("not a tracked file at immutable HEAD");
	});

	it.each([
		["symlink", `120000 blob ${TARGET_OID}\tsrc/answer.ts\0`],
		["submodule", `160000 commit ${TARGET_OID}\tsrc/answer.ts\0`],
		["non-regular", `100600 blob ${TARGET_OID}\tsrc/answer.ts\0`],
	])("rejects a %s entry before materialization", (kind, tree) => {
		const git = gitFixture({ tree });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow(kind);
		expect(git.calls.some(({ args }) => args[0] === "archive")).toBe(false);
	});

	it("rejects an oversized target before reading its blob", () => {
		const git = gitFixture({ targetSize: String(MAX_TARGET_SOURCE_BYTES + 1) });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow(`exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`);
		expect(git.calls.some(({ args }) => args[0] === "archive")).toBe(false);
	});

	it("rejects a foreign repository root before inspecting status", () => {
		const git = gitFixture({ top: "/other-repo" });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("not the root of the captured Git repository");
		expect(git.calls).toHaveLength(1);
	});

	it.each([
		["HEAD", { heads: [HEAD, NEXT_HEAD] }],
		["status", { statuses: [new Uint8Array(), bytes("?? raced.ts\0")] }],
	] satisfies Array<[string, GitFixtureOptions]>)
		("rejects a %s race after materialized-snapshot test selection", (_kind, options) => {
			expect.hasAssertions();
			const git = gitFixture(options);
			const cleanup = vi.fn();
			expect(() => captureMutationOnboardingSource(
				{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
				{
					runGit: git.runGit,
					realpath: (path) => path,
					materialize: () => ({ root: "/materialized-head", cleanup }),
					readMaterializedTarget: () => TARGET,
					selectTests: () => ({ tests: [] }),
				},
			)).toThrow("HEAD or status changed");
			expect(cleanup).toHaveBeenCalledOnce();
	});

	it.each([
		["missing", missingMaterializedTarget, "missing"],
		["foreign", foreignMaterializedTarget, "differs"],
	] as const)("rejects a %s target in the materialized archive", (_kind, readTarget, reason) => {
		expect.hasAssertions();
		const git = gitFixture();
		const cleanup = vi.fn();
		const selectTests = vi.fn(() => ({ tests: [] }));
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				runGit: git.runGit,
				realpath: (path) => path,
				materialize: () => ({ root: "/materialized-head", cleanup }),
				readMaterializedTarget: readTarget,
				selectTests,
			},
		)).toThrow(reason);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(selectTests).not.toHaveBeenCalled();
	});

	it("cleans the materialized snapshot when test selection fails", () => {
		const git = gitFixture();
		const cleanup = vi.fn();
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				runGit: git.runGit,
				realpath: (path) => path,
				materialize: () => ({ root: "/materialized-head", cleanup }),
				readMaterializedTarget: () => TARGET,
				selectTests: () => {
					throw new Error("snapshot graph failed");
				},
			},
		)).toThrow("snapshot graph failed");
		expect(cleanup).toHaveBeenCalledOnce();
		expect(git.calls.filter(({ args }) => args[0] === "status")).toHaveLength(1);
	});

	it("rejects a maxTestScope below one before running any Git command", () => {
		const git = gitFixture();
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts", maxTestScope: 0 },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding maxTestScope must be a positive safe integer");
		expect(git.calls).toHaveLength(0);
	});

	it("rejects a repository root Git did not emit as valid UTF-8", () => {
		const runGit: MutationOnboardingGitRunner = () => Uint8Array.from([0x2f, 0xff, 0xfe, 0x0a]);
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding repository root is not valid UTF-8");
	});

	it("rejects an empty repository root line", () => {
		const git = gitFixture({ top: "" });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding repository root is malformed");
	});

	it("rejects a tree record that carries no tab-separated path", () => {
		const git = gitFixture({ tree: `100644 blob ${TARGET_OID} src/answer.ts\0` });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding git tree contains a malformed entry");
	});

	it("rejects a tree entry whose object id is not a full SHA", () => {
		const git = gitFixture({ tree: `100644 blob ${"z".repeat(40)}\tsrc/answer.ts\0` });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding git tree contains a malformed identity");
	});

	it("rejects blob bytes that disagree with the declared Git object size", () => {
		const git = gitFixture({ targetSize: String(TARGET.byteLength - 1) });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow("mutation onboarding immutable target bytes differ from the Git object size");
		expect(git.calls.some(({ args }) => args[0] === "archive")).toBe(false);
	});

	it("rejects an empty archive before materializing anything", () => {
		const git = gitFixture({ archiveBytes: new Uint8Array() });
		expect(() => captureMutationOnboardingSource(
			{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ runGit: git.runGit, realpath: (path) => path },
		)).toThrow(`mutation onboarding archive must contain 1..${MAX_SOURCE_ARTIFACT_BYTES} bytes`);
	});

	it("reports a companion fallback scope when the graph declines but names companions", () => {
		const captured = captureWithScope(
			{ tests: null, reason: "over_cap", companionScope: ["src/z.test.ts", "src/a.mutation-kill.test.ts"] },
			5,
		);
		expect(captured.scopeMode).toBe("companion_fallback");
		expect(captured.testFiles).toEqual(["src/a.mutation-kill.test.ts", "src/z.test.ts"]);
	});

	it("reports a glob fallback scope when the graph declines with no companions", () => {
		const captured = captureWithScope({ tests: null, reason: "no_affected_tests" });
		expect(captured.scopeMode).toBe("glob_fallback");
		expect(captured.testFiles).toEqual([]);
	});

	it("reports a glob fallback scope when the companion list is present but empty", () => {
		const captured = captureWithScope({ tests: null, reason: "over_cap", companionScope: [] });
		expect(captured.scopeMode).toBe("glob_fallback");
		expect(captured.testFiles).toEqual([]);
	});
});

describe("captureMutationOnboardingSource default system dependencies", () => {
	it("captures a real repository through the default git, tar, and read paths", () => {
		const root = initGitRepo();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const captured = captureMutationOnboardingSource(
			{ root, repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ selectTests: () => ({ tests: ["src/answer.test.ts"] }) },
		);
		expect(captured.commit).toBe(head);
		expect(Buffer.from(captured.targetBytes)).toEqual(TARGET);
		expect(captured.targetSha256).toBe(digest(TARGET));
		expect(captured.sourceArtifactId).toBe(`src_git_archive_v1_${digest(captured.sourceArtifactBytes)}`);
		expect(captured.testFiles).toEqual(["src/answer.test.ts"]);
	});

	it("deletes the mkdtemp container once test selection has read the snapshot", () => {
		let snapshotRoot = "";
		let targetVisibleDuringScope: boolean | null = null;
		captureMutationOnboardingSource(
			{ root: initGitRepo(), repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{
				selectTests: ({ projectRoot }) => {
					snapshotRoot = projectRoot;
					targetVisibleDuringScope = existsSync(join(projectRoot, "src", "answer.ts"));
					return { tests: [] };
				},
			},
		);
		expect(targetVisibleDuringScope).toBe(true);
		expect(snapshotRoot.endsWith(MUTATION_ONBOARDING_ARCHIVE_PREFIX.slice(0, -1))).toBe(true);
		expect(existsSync(snapshotRoot)).toBe(false);
		expect(existsSync(dirname(snapshotRoot))).toBe(false);
	});

	it("emits real git-archive tar bytes carrying the prefixed target member", () => {
		const captured = captureMutationOnboardingSource(
			{ root: initGitRepo(), repository: "github.com/example/repo", targetFile: "src/answer.ts" },
			{ selectTests: () => ({ tests: [] }) },
		);
		const archive = Buffer.from(captured.sourceArtifactBytes);
		expect(archive.includes(`${MUTATION_ONBOARDING_ARCHIVE_PREFIX}src/answer.ts`)).toBe(true);
		expect(archive.byteLength % 512).toBe(0);
	});

	it("names the failing git subcommand when the default runner cannot run it", () => {
		const notARepository = tempDir("interlinked-onboard-not-a-repo-");
		const error = captureError(() =>
			captureMutationOnboardingSource({
				root: notARepository,
				repository: "github.com/example/repo",
				targetFile: "src/answer.ts",
			}),
		);
		expect(error.message).toBe("mutation onboarding git rev-parse failed or exceeded its bounded output");
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("rejects archive bytes that tar cannot extract", () => {
		const git = gitFixture({ archiveBytes: bytes("this is not a tar archive") });
		const error = captureError(() =>
			captureMutationOnboardingSource(
				{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
				{ runGit: git.runGit, realpath: (path) => path, selectTests: () => ({ tests: [] }) },
			),
		);
		expect(error.message).toBe("mutation onboarding git archive could not be materialized");
	});

	it("rejects an archive whose versioned root materializes as a file", () => {
		const git = gitFixture({ archiveBytes: tarWithFileAtVersionedRoot() });
		const error = captureError(() =>
			captureMutationOnboardingSource(
				{ root: "/repo", repository: "github.com/example/repo", targetFile: "src/answer.ts" },
				{ runGit: git.runGit, realpath: (path) => path, selectTests: () => ({ tests: [] }) },
			),
		);
		expect(error.message).toBe("mutation onboarding git archive could not be materialized");
		expect(error.cause).toMatchObject({ message: "mutation onboarding archive did not materialize its versioned root" });
	});

	it("rejects a materialized snapshot that is missing the target", () => {
		const error = captureReadingMaterializedRoot(tempDir("interlinked-onboard-empty-"));
		expect(error.message).toBe("mutation onboarding archive is missing its immutable target");
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("rejects a materialized target that is a symlink", () => {
		const root = tempDir("interlinked-onboard-symlink-");
		mkdirSync(join(root, "src"));
		symlinkSync(join(root, "elsewhere.ts"), join(root, "src", "answer.ts"));
		expect(captureReadingMaterializedRoot(root).message).toBe(
			"mutation onboarding archive materialized its target as a symlink",
		);
	});

	it("rejects a materialized target that is a directory", () => {
		const root = tempDir("interlinked-onboard-dir-");
		mkdirSync(join(root, "src", "answer.ts"), { recursive: true });
		expect(captureReadingMaterializedRoot(root).message).toBe(
			"mutation onboarding archive materialized a non-regular target",
		);
	});

	it("rejects a materialized target larger than the target byte limit", () => {
		const root = tempDir("interlinked-onboard-oversized-");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "answer.ts"), Buffer.alloc(MAX_TARGET_SOURCE_BYTES + 1));
		expect(captureReadingMaterializedRoot(root).message).toBe(
			`mutation onboarding archive target exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`,
		);
	});
});
