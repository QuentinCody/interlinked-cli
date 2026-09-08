// test-contract: boundary — protocol-v3 overlay capture never trusts dirty worktree bytes.

import { nonNull } from "../../lib/non-null.js";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Malformed-fixture seam for the git/tar plumbing the SUT shells out to.
 * `captureMutationOverlaySource` never reads proposed bytes from the
 * worktree, so several of its defensive parse/verify branches (a corrupted
 * `ls-tree` record, a `tar` extraction failure, an archived target that
 * vanished or changed) cannot be produced by any real git/tar behavior on
 * this platform — real git canonicalizes every tree-entry mode to one of
 * 100644/100755/120000/160000 (verified empirically: `git hash-object
 * --literally -w -t tree` fed a raw 100664 entry still round-trips through
 * `ls-tree` as 100644). `vi.mock` + `vi.hoisted` intercepts one named
 * git/tar invocation at a time, matched on argv — never the module under
 * test; every other call, including this file's own `git()`/`archiveFile()`
 * helpers, passes straight through to the real binary.
 */
const execOverrides = vi.hoisted((): {
	repoRootBytes: Buffer | null;
	headBytes: Buffer | null;
	lsTreeBytes: Buffer | null;
	tarExtractThrows: boolean;
	tamperAfterExtract: { relPath: string; kind: "delete" | "replace-with-dir" | "corrupt-content"; bytes?: Buffer } | null;
} => ({
	/** Bytes to return instead of running `git rev-parse --show-toplevel`. */
	repoRootBytes: null,
	/** Bytes to return instead of running the FIRST `rev-parse --verify HEAD^{commit}`. */
	headBytes: null,
	/** Bytes to return instead of running `git ls-tree …`. */
	lsTreeBytes: null,
	/** Throw instead of running the `tar -x` extraction. */
	tarExtractThrows: false,
	/** After a REAL `tar -x` extraction, tamper with one archived file. */
	tamperAfterExtract: null,
}));

// Mirrors MUTATION_ONBOARDING_ARCHIVE_PREFIX minus its trailing slash (asserted
// directly below at "interlinked-source-v1/"); a plain literal so the mock
// factory has no load-order dependency on the local module import.
const ARCHIVE_PREFIX_DIR = "interlinked-source-v1";

// The SUT's own `git()` helper always prepends ["-C", root, ...] ahead of the
// subcommand, so these match by membership rather than position.
function isRevParseShowToplevel(file: string, args: readonly string[]): boolean {
	return file === "git" && args.includes("rev-parse") && args.includes("--show-toplevel");
}

function isRevParseHead(file: string, args: readonly string[]): boolean {
	return file === "git" && args.includes("rev-parse") && args.includes("HEAD^{commit}");
}

function isLsTree(file: string, args: readonly string[]): boolean {
	return file === "git" && args.includes("ls-tree");
}

function isTarExtract(file: string, args: readonly string[]): boolean {
	return file === "tar" && args[0] === "-x";
}

/** Mutate one file inside a just-extracted archive so the SUT's post-extraction
 *  verification (missing / non-regular / content-mismatch) sees real fs state. */
function tamperExtractedFile(
	args: readonly string[],
	spec: NonNullable<(typeof execOverrides)["tamperAfterExtract"]>,
): void {
	const destIndex = args.indexOf("-C");
	const dest = nonNull(args[destIndex + 1]);
	const target = join(dest, ARCHIVE_PREFIX_DIR, spec.relPath);
	if (spec.kind === "delete") {
		rmSync(target, { force: true });
		return;
	}
	if (spec.kind === "replace-with-dir") {
		rmSync(target, { force: true });
		mkdirSync(target, { recursive: true });
		return;
	}
	writeFileSync(target, spec.bytes ?? Buffer.alloc(0));
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();

	return {
		...actual,
		execFileSync: (
			file: string,
			args: readonly string[] = [],
			options?: ExecFileSyncOptions,
		) => {
			if (isRevParseShowToplevel(file, args) && execOverrides.repoRootBytes !== null) {
				return execOverrides.repoRootBytes;
			}
			if (isRevParseHead(file, args) && execOverrides.headBytes !== null) {
				const bytes = execOverrides.headBytes;
				execOverrides.headBytes = null; // only the first HEAD read is overridden
				return bytes;
			}
			if (isLsTree(file, args) && execOverrides.lsTreeBytes !== null) {
				return execOverrides.lsTreeBytes;
			}
			if (isTarExtract(file, args) && execOverrides.tarExtractThrows) {
				throw new Error("simulated tar extraction failure");
			}
			const result = actual.execFileSync(file, args, options);
			if (isTarExtract(file, args) && execOverrides.tamperAfterExtract !== null) {
				tamperExtractedFile(args, execOverrides.tamperAfterExtract);
			}
			return result;
		},
	};
});

import {
	captureMutationOverlaySource,
	type CapturedMutationOverlaySource,
} from "./mutation-cloud-v3-overlay-source.js";
import { MUTATION_ONBOARDING_ARCHIVE_PREFIX } from "./mutation-cloud-v3-onboarding-source.js";
import { MAX_TARGET_SOURCE_BYTES } from "./protocol-v3/field-checks.js";

const BASE_TARGET = "export const value = 'base';\n";
const PROPOSED_TARGET = Buffer.from("export const value = 'proposed';\n", "utf8");
const FIXED_GIT_ENV = {
	...process.env,
	GIT_AUTHOR_DATE: "946684800 +0000",
	GIT_COMMITTER_DATE: "946684800 +0000",
};
const repositories: string[] = [];

function git(root: string, args: readonly string[], input?: Uint8Array): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "buffer",
		env: FIXED_GIT_ENV,
		...(input === undefined ? {} : { input: Buffer.from(input) }),
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
}

function write(root: string, path: string, contents: string | Uint8Array): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function commit(root: string, message: string): void {
	git(root, ["add", "--all"]);
	git(root, ["commit", "--quiet", "-m", message]);
}

function repository(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "interlinked-overlay-test-"));
	repositories.push(root);
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.name", "Interlinked Test"]);
	git(root, ["config", "user.email", "test@interlinked.invalid"]);
	const initial = Object.keys(files).length > 0
		? files
		: {
			"src/target.ts": BASE_TARGET,
			"src/target.test.ts": "import { value } from './target.js';\nvoid value;\n",
			"src/unrelated.ts": "export const unrelated = 'head';\n",
		};
	for (const [path, contents] of Object.entries(initial)) write(root, path, contents);
	commit(root, "base");
	return root;
}

function capture(
	root: string,
	targetFile = "src/target.ts",
	proposedBytes: Uint8Array = PROPOSED_TARGET,
	selectTests: NonNullable<Parameters<typeof captureMutationOverlaySource>[1]>["selectTests"] = () => ({
		tests: ["src/target.test.ts"],
	}),
): CapturedMutationOverlaySource {
	return captureMutationOverlaySource(
		{ root, repository: "github.com/interlinked/test", targetFile, proposedBytes },
		{ selectTests },
	);
}

function archiveFile(captured: CapturedMutationOverlaySource, path: string): Buffer {
	return execFileSync(
		"tar",
		["-xOf", "-", `${MUTATION_ONBOARDING_ARCHIVE_PREFIX}${path}`],
		{ encoding: "buffer", input: Buffer.from(captured.sourceArtifactBytes) },
	);
}

function archiveEntries(captured: CapturedMutationOverlaySource): string[] {
	return execFileSync("tar", ["-tf", "-"], {
		encoding: "utf8",
		input: Buffer.from(captured.sourceArtifactBytes),
	}).trim().split("\n");
}

afterEach(() => {
	for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
	execOverrides.repoRootBytes = null;
	execOverrides.headBytes = null;
	execOverrides.lsTreeBytes = null;
	execOverrides.tarExtractThrows = false;
	execOverrides.tamperAfterExtract = null;
});

describe("captureMutationOverlaySource", () => {
	it("captures HEAD plus exactly the proposed target while excluding every dirty worktree byte", () => {
		const root = repository();
		write(root, "src/target.ts", "export const value = 'dirty target';\n");
		write(root, "src/unrelated.ts", "export const unrelated = 'dirty';\n");
		write(root, "src/untracked.ts", "export const untracked = true;\n");
		const statusBefore = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		const objectCensusBefore = git(root, ["count-objects", "-v"]);
		const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
			.toString("utf8").trim();
		const indexBefore = readFileSync(indexPath);

		const captured = capture(root, "src/target.ts", PROPOSED_TARGET, ({ projectRoot }) => {
			expect(readFileSync(join(projectRoot, "src/target.ts"))).toEqual(PROPOSED_TARGET);
			expect(readFileSync(join(projectRoot, "src/unrelated.ts"), "utf8")).toContain("'head'");
			expect(() => readFileSync(join(projectRoot, "src/untracked.ts"))).toThrow();
			return { tests: ["src/target.test.ts"] };
		});

		expect(archiveFile(captured, "src/target.ts")).toEqual(PROPOSED_TARGET);
		expect(archiveFile(captured, "src/unrelated.ts").toString("utf8")).toContain("'head'");
		expect(archiveEntries(captured)).not.toContain(`${MUTATION_ONBOARDING_ARCHIVE_PREFIX}src/untracked.ts`);
		expect(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toEqual(statusBefore);
		expect(git(root, ["count-objects", "-v"])).toEqual(objectCensusBefore);
		expect(readFileSync(indexPath)).toEqual(indexBefore);
	});

	it("returns request-ready bindings and embeds the synthetic request commit in the tar", () => {
		const root = repository();
		const captured = capture(root);
		const embedded = git(root, ["get-tar-commit-id"], captured.sourceArtifactBytes)
			.toString("utf8").trim();
		expect(captured).toMatchObject({
			format: "git-archive-tar-v1",
			archivePrefix: "interlinked-source-v1/",
			repository: "github.com/interlinked/test",
			commit: embedded,
			targetFile: "src/target.ts",
			scopeMode: "import_graph",
			testFiles: ["src/target.test.ts"],
			changesetTarget: {
				path: "src/target.ts",
				content_hash: captured.targetSha256,
			},
		});
		expect(captured.commit).not.toBe(captured.baseCommit);
		expect(captured.sourceArtifactId).toBe(`src_git_archive_v1_${captured.sourceArtifactSha256}`);
		expect(Buffer.from(captured.targetBytes)).toEqual(PROPOSED_TARGET);
	});

	it("supports a new regular target without adding it to the source worktree or index", () => {
		const root = repository();
		const sourceIndex = readFileSync(
			git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString("utf8").trim(),
		);
		const proposed = Buffer.from("export const newlyAdded = true;\n", "utf8");
		const captured = capture(root, "src/new-file.ts", proposed, ({ projectRoot }) => {
			expect(readFileSync(join(projectRoot, "src/new-file.ts"))).toEqual(proposed);
			return { tests: null, reason: "no_affected_tests" };
		});
		expect(archiveFile(captured, "src/new-file.ts")).toEqual(proposed);
		expect(() => readFileSync(join(root, "src/new-file.ts"))).toThrow();
		expect(() => git(root, ["ls-files", "--error-unmatch", "src/new-file.ts"])).toThrow();
		expect(readFileSync(
			git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).toString("utf8").trim(),
		)).toEqual(sourceIndex);
	});

	it("is byte-deterministic for the same HEAD and proposal", () => {
		const root = repository();
		const first = capture(root);
		const second = capture(root);
		expect(second.commit).toBe(first.commit);
		expect(second.sourceArtifactSha256).toBe(first.sourceArtifactSha256);
		expect(Buffer.from(second.sourceArtifactBytes)).toEqual(Buffer.from(first.sourceArtifactBytes));
	});

	it("changes both synthetic commit and artifact identity when proposed content changes", () => {
		const root = repository();
		const first = capture(root, "src/target.ts", Buffer.from("export const value = 1;\n"));
		const second = capture(root, "src/target.ts", Buffer.from("export const value = 2;\n"));
		expect(second.commit).not.toBe(first.commit);
		expect(second.targetSha256).not.toBe(first.targetSha256);
		expect(second.sourceArtifactSha256).not.toBe(first.sourceArtifactSha256);
	});

	it("rejects any symlink in immutable HEAD before constructing an archive", () => {
		const root = repository();
		symlinkSync("target.ts", join(root, "src/link.ts"));
		commit(root, "add symlink");
		expect(() => capture(root)).toThrow("HEAD contains a symlink: src/link.ts");
	});

	it("rejects any submodule entry in immutable HEAD", () => {
		const root = repository();
		const head = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
		git(root, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`]);
		git(root, ["commit", "--quiet", "-m", "add gitlink"]);
		expect(() => capture(root)).toThrow("HEAD contains a submodule: vendor/module");
	});

	it.each([
		"../escape.ts",
		"/absolute.ts",
		"src//double.ts",
		"src/./dot.ts",
		"src\\windows.ts",
		".git/config",
		"src/line\nbreak.ts",
	])("rejects unsafe proposed target path %j", (targetFile) => {
		const root = repository();
		expect(() => capture(root, targetFile)).toThrow(/normalized|unsafe/);
	});

	it("rejects a new target whose path collides with a tracked regular file", () => {
		const root = repository({ "src": "tracked file named src\n" });
		expect(() => capture(root, "src/new.ts")).toThrow("conflicts with tracked path: src");
	});

	it("rejects oversized target and source artifacts", () => {
		const root = repository();
		expect(() => capture(root, "src/target.ts", Buffer.alloc(MAX_TARGET_SOURCE_BYTES + 1))).toThrow(
			`exceeds the ${MAX_TARGET_SOURCE_BYTES}-byte limit`,
		);
		expect(() => captureMutationOverlaySource(
			{
				root,
				repository: "github.com/interlinked/test",
				targetFile: "src/target.ts",
				proposedBytes: PROPOSED_TARGET,
			},
			{ sourceArtifactByteLimit: 512, selectTests: () => ({ tests: [] }) },
		)).toThrow(/synthetic archive failed|archive must contain/);
	});

	it("refuses a capture when HEAD changes while the materialized archive is being scoped", () => {
		const root = repository();
		expect(() => capture(root, "src/target.ts", PROPOSED_TARGET, () => {
			write(root, "README.md", "racing commit\n");
			commit(root, "race");
			return { tests: [] };
		})).toThrow("repository HEAD changed during capture");
	});

	it("falls back to the target's own companion kill-test scope when the graph declines the full set", () => {
		const root = repository();
		const captured = capture(root, "src/target.ts", PROPOSED_TARGET, () => ({
			tests: null,
			reason: "over_cap",
			uncappedCount: 500,
			companionScope: ["src/target.mutation-kill.test.ts", "src/target.test.ts"],
		}));
		expect(captured.scopeMode).toBe("companion_fallback");
		expect(captured.testFiles).toEqual(["src/target.mutation-kill.test.ts", "src/target.test.ts"]);
	});

	it("rejects a non-positive maxTestScope before any git or filesystem access", () => {
		expect(() => captureMutationOverlaySource({
			root: "/does-not-exist-and-is-never-touched",
			repository: "github.com/interlinked/test",
			targetFile: "src/target.ts",
			proposedBytes: PROPOSED_TARGET,
			maxTestScope: 0,
		})).toThrow("mutation overlay maxTestScope must be a positive safe integer");
	});

	it("rejects a non-positive sourceArtifactByteLimit override", () => {
		const root = repository();
		expect(() => captureMutationOverlaySource(
			{ root, repository: "github.com/interlinked/test", targetFile: "src/target.ts", proposedBytes: PROPOSED_TARGET },
			{ selectTests: () => ({ tests: ["src/target.test.ts"] }), sourceArtifactByteLimit: 0 },
		)).toThrow("mutation overlay sourceArtifactByteLimit must be a positive safe integer");
	});

	it("rejects an archive whose real size exceeds a lowered byte limit even though extraction succeeded", () => {
		const root = repository();
		const baseline = capture(root);
		const realSize = baseline.sourceArtifactBytes.byteLength;
		expect(() => captureMutationOverlaySource(
			{ root, repository: "github.com/interlinked/test", targetFile: "src/target.ts", proposedBytes: PROPOSED_TARGET },
			{ selectTests: () => ({ tests: ["src/target.test.ts"] }), sourceArtifactByteLimit: realSize - 1 },
		)).toThrow(`mutation overlay archive must contain 1..${realSize - 1} bytes`);
	});

	it("rejects a repository-root reading that is not valid UTF-8", () => {
		const root = repository();
		execOverrides.repoRootBytes = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
		expect(() => capture(root)).toThrow("mutation overlay repository root is not valid UTF-8");
	});

	it("rejects a HEAD reading containing an embedded newline", () => {
		const root = repository();
		execOverrides.headBytes = Buffer.from("abc\ndef\n", "utf8");
		expect(() => capture(root)).toThrow("mutation overlay HEAD is malformed");
	});

	it("rejects a HEAD tree listing that is not valid UTF-8", () => {
		const root = repository();
		execOverrides.lsTreeBytes = Buffer.from([0xff, 0xfe, 0x00]);
		expect(() => capture(root)).toThrow("mutation overlay HEAD tree is not valid UTF-8");
	});

	it("rejects a HEAD tree record with no tab-separated path", () => {
		const root = repository();
		execOverrides.lsTreeBytes = Buffer.from("not-a-real-tree-record\0", "utf8");
		expect(() => capture(root)).toThrow("mutation overlay HEAD tree contains a malformed entry");
	});

	it("rejects a HEAD tree entry whose mode is not a recognized regular-file mode", () => {
		const root = repository();
		const oid = "a".repeat(40);
		execOverrides.lsTreeBytes = Buffer.from(`100664 blob ${oid}\tsrc/odd.ts\0`, "utf8");
		expect(() => capture(root)).toThrow("mutation overlay HEAD contains a non-regular entry: src/odd.ts");
	});

	it("wraps a tar extraction failure as an overlay materialization error", () => {
		const root = repository();
		execOverrides.tarExtractThrows = true;
		expect(() => capture(root)).toThrow("mutation overlay archive could not be materialized");
	});

	it("rejects an archive whose extraction is missing the proposed target", () => {
		const root = repository();
		execOverrides.tamperAfterExtract = { relPath: "src/target.ts", kind: "delete" };
		expect(() => capture(root)).toThrow("mutation overlay archive is missing the proposed target");
	});

	it("rejects an archived target that extraction produced as a directory instead of a file", () => {
		const root = repository();
		execOverrides.tamperAfterExtract = { relPath: "src/target.ts", kind: "replace-with-dir" };
		expect(() => capture(root)).toThrow("mutation overlay archive target is not a regular file");
	});

	it("rejects an archived target whose bytes differ from the proposed content", () => {
		const root = repository();
		execOverrides.tamperAfterExtract = {
			relPath: "src/target.ts",
			kind: "corrupt-content",
			bytes: Buffer.from("export const value = 'tampered';\n", "utf8"),
		};
		expect(() => capture(root)).toThrow("mutation overlay archive target differs from the proposed bytes");
	});
});
