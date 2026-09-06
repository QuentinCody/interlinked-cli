import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositoryIdentity, resolveReviewScope } from "./simplify-scope.js";

let fixture: string;

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: fixture,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function write(rel: string, content: string): void {
	const path = join(fixture, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function commit(message: string): string {
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@invalid.local",
		"commit",
		"-q",
		"-m",
		message,
	]);
	return git(["rev-parse", "HEAD"]);
}

beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "interlinked-simplify-scope-"));
	git(["init", "-q"]);
	write("src/a.ts", "export const a = 1;\n");
	write("src/b.ts", "export const b = 1;\n");
	commit("initial");
});

afterEach(() => {
	rmSync(fixture, { recursive: true, force: true });
});

describe("resolveReviewScope", () => {
	// test-contract: public-api — changed scope includes both tracked edits and
	// untracked files without relying on shell parsing
	it("discovers changed and untracked paths", () => {
		write("src/a.ts", "export const a = 2;\n");
		write("src/new.ts", "export const fresh = true;\n");
		const scope = resolveReviewScope({ cwd: fixture, kind: "changed" });
		expect(scope.kind).toBe("changed");
		expect(scope.selected_paths).toEqual(["src/a.ts", "src/new.ts"]);
	});

	// test-contract: boundary — staged scope excludes an unstaged-only path
	it("isolates staged paths", () => {
		write("src/a.ts", "export const a = 2;\n");
		git(["add", "src/a.ts"]);
		write("src/b.ts", "export const b = 2;\n");
		const scope = resolveReviewScope({ cwd: fixture, kind: "staged" });
		expect(scope.selected_paths).toEqual(["src/a.ts"]);
	});

	it("refuses staged selection when selected bytes have unstaged drift", () => {
		write("src/a.ts", "export const a = 2;\n");
		git(["add", "src/a.ts"]);
		write("src/a.ts", "export const a = 3;\n");
		expect(() => resolveReviewScope({ cwd: fixture, kind: "staged" })).toThrow(
			/staged index selected path content differs/,
		);
	});

	// test-contract: public-api — an explicit two-dot range resolves both
	// endpoint commits and reports only paths in that range
	it("validates and resolves an explicit commit range", () => {
		const base = git(["rev-parse", "HEAD"]);
		write("src/b.ts", "export const b = 3;\n");
		const head = commit("change b");
		const scope = resolveReviewScope({ cwd: fixture, kind: "range", range: `${base}..${head}` });
		expect(scope.selected_paths).toEqual(["src/b.ts"]);
		expect(scope.base_sha).toBe(base);
		expect(scope.head_sha).toBe(head);
	});

	it("refuses a range when a selected path has drifted from its resolved head", () => {
		const base = git(["rev-parse", "HEAD"]);
		write("src/b.ts", "export const b = 3;\n");
		const head = commit("change b");
		write("src/b.ts", "export const b = 4;\n");
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "range", range: `${base}..${head}` }),
		).toThrow(/range head .* selected path content differs/);
	});

	// test-contract: security — ambiguous or option-shaped range text is
	// rejected before being passed to git
	it("rejects a non-explicit range", () => {
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "range", range: "--output=/tmp/x" }),
		).toThrow("--range must be an explicit");
	});

	// test-contract: error-path — a required git call that throws is wrapped
	// with the caller's own diagnostic message, not the raw git error
	it("wraps a failed required git call with the staged-discovery message", () => {
		const failingGit = () => {
			throw new Error("git executable not found");
		};
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "staged", git: failingGit }),
		).toThrow("staged-file discovery requires a readable git index");
	});

	// test-contract: error-path — every optional git probe failing (no git,
	// no worktree) surfaces one readable-worktree error instead of a crash
	it("reports an unreadable worktree when every changed-path probe fails", () => {
		const failingGit = () => {
			throw new Error("not a git repository");
		};
		expect(() =>
			resolveReviewScope({ cwd: fixture, kind: "changed", git: failingGit }),
		).toThrow("changed-file discovery requires a readable git worktree");
	});

	// test-contract: boundary — the range kind requires an explicit --range
	it("requires --range for the range scope", () => {
		expect(() => resolveReviewScope({ cwd: fixture, kind: "range" })).toThrow(
			"review range scope requires --range <base>..<head>",
		);
	});
});

describe("repositoryIdentity", () => {
	// test-contract: invariant — committed identity stays fixed while the
	// current-content hash changes for an unstaged worktree edit
	it("separates HEAD tree identity from current worktree content", () => {
		const files = [join(fixture, "src/a.ts"), join(fixture, "src/b.ts")];
		const before = repositoryIdentity({ cwd: fixture, files });
		write("src/a.ts", "export const a = 99;\n");
		const after = repositoryIdentity({ cwd: fixture, files });
		expect(after.head_sha).toBe(before.head_sha);
		expect(after.tree_sha).toBe(before.tree_sha);
		expect(after.working_tree_sha256).not.toBe(before.working_tree_sha256);
	});

	// test-contract: error-path — a listed file that cannot be read hashes to
	// a stable placeholder instead of throwing, so a deleted/missing file
	// still yields a deterministic identity
	it("hashes a missing file to the documented unreadable placeholder", () => {
		const missing = join(fixture, "src/missing.ts");
		const identity = repositoryIdentity({ cwd: fixture, files: [missing] });
		expect(identity.working_tree_sha256).toBe(
			"ebc4932b57b83e431136bfca9278fe4ae1cb85f6d78d2f4f4eb5b723cf7e1be4",
		);
	});

	// test-contract: normalization — an SSH remote and an HTTPS remote for the
	// same host/org/repo collapse to the same repository_id
	it("normalizes ssh and https remote URLs to the same repository id", () => {
		git(["remote", "add", "origin", "git@github.com:Acme/Widget.git"]);
		const sshIdentity = repositoryIdentity({ cwd: fixture, files: [] });
		expect(sshIdentity.repository_id).toBe("repo-eabda43ba8a9435f506282ba");

		const httpsFixture = mkdtempSync(join(tmpdir(), "interlinked-simplify-scope-https-"));
		execFileSync("git", ["init", "-q"], { cwd: httpsFixture, stdio: ["pipe", "pipe", "pipe"] });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://github.com/Acme/Widget"],
			{ cwd: httpsFixture, stdio: ["pipe", "pipe", "pipe"] },
		);
		const httpsIdentity = repositoryIdentity({ cwd: httpsFixture, files: [] });
		rmSync(httpsFixture, { recursive: true, force: true });

		expect(httpsIdentity.repository_id).toBe(sshIdentity.repository_id);
	});

	// test-contract: fallback — with no remote and no root commit, the id
	// falls back to the local directory name, tolerating a missing
	// package.json rather than throwing
	it("falls back to the working-directory name when there is no remote or commit", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "interlinked-simplify-scope-empty-"));
		execFileSync("git", ["init", "-q"], { cwd: emptyDir, stdio: ["pipe", "pipe", "pipe"] });
		const identity = repositoryIdentity({ cwd: emptyDir, files: [] });
		rmSync(emptyDir, { recursive: true, force: true });

		const expected = `repo-${createHash("sha256")
			.update(`local\0${basename(emptyDir)}`)
			.digest("hex")
			.slice(0, 24)}`;
		expect(identity.repository_id).toBe(expected);
		expect(identity.head_sha).toBeNull();
	});
});
