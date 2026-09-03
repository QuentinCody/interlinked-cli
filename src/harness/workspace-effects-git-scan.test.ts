import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fallbackVisiblePaths,
	FALLBACK_SKIP_DIRS,
	gitStandaloneIgnoredPaths,
	gitVisiblePaths,
	isInside,
	MAX_FILES,
} from "./workspace-effects-git-scan.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-git-scan-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("isInside", () => {
	it("P1: reports a nested path as inside its root", () => {
		expect(isInside("/a/b", "/a/b/c.ts")).toBe(true);
		expect(isInside("/a/b", "/a/b")).toBe(true);
	});

	it("N1: reports a sibling path as outside the root", () => {
		expect(isInside("/a/b", "/a/bc.ts")).toBe(false);
		expect(isInside("/a/b", "/a/c/d.ts")).toBe(false);
	});
});

describe("MAX_FILES / FALLBACK_SKIP_DIRS", () => {
	it("P1: exposes a positive file cap and the well-known noisy directories", () => {
		expect(MAX_FILES).toBeGreaterThan(0);
		expect(FALLBACK_SKIP_DIRS.has("node_modules")).toBe(true);
		expect(FALLBACK_SKIP_DIRS.has(".git")).toBe(true);
	});
});

describe("gitVisiblePaths", () => {
	it("P1: lists tracked and untracked files under a git repo", () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, "tracked.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "tracked.ts"], { cwd: root });
		writeFileSync(join(root, "untracked.ts"), "export const b = 2;\n");
		const paths = gitVisiblePaths(root);
		expect(paths).not.toBeNull();
		expect(paths).toEqual(expect.arrayContaining(["tracked.ts", "untracked.ts"]));
	});

	it("N1: returns null when the directory is not a git repo", () => {
		expect(gitVisiblePaths(root)).toBeNull();
	});
});

describe("gitStandaloneIgnoredPaths", () => {
	it("P1: reports a standalone ignored file with a concrete path", () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "ignored.env\nscratch/\n");
		execFileSync("git", ["add", ".gitignore"], { cwd: root });
		writeFileSync(join(root, "ignored.env"), "SECRET=1\n");
		mkdirSync(join(root, "scratch"));
		writeFileSync(join(root, "scratch", "a.txt"), "x");
		const { paths, complete } = gitStandaloneIgnoredPaths(root);
		expect(paths).toContain("ignored.env");
		expect(paths).not.toContain("scratch/");
		expect(complete).toBe(false);
	});

	it("N1: returns empty/incomplete when the directory is not a git repo", () => {
		const { paths, complete } = gitStandaloneIgnoredPaths(root);
		expect(paths).toEqual([]);
		expect(complete).toBe(false);
	});
});

describe("fallbackVisiblePaths", () => {
	it("P1: walks the directory tree and skips noisy directories", () => {
		writeFileSync(join(root, "a.ts"), "x");
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", "b.ts"), "x");
		const { paths, complete } = fallbackVisiblePaths(root);
		expect(paths).toContain("a.ts");
		expect(paths).not.toContain(join("node_modules", "b.ts"));
		expect(complete).toBe(true);
	});

	it("N1: marks the walk incomplete when a directory cannot be read", () => {
		const { complete } = fallbackVisiblePaths(join(root, "does-not-exist"));
		expect(complete).toBe(false);
	});
});
