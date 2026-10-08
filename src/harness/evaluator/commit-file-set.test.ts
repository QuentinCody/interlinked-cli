// The set of files a `git commit` command will capture, so commit-time
// session checks judge the commit and not every file the session touched
// (found 2026-10-05: a two-file commit drew `prod_delta_no_test_delta`,
// `tpp_leapfrog` and `reintroduces_removed_code` warnings about unstaged
// files in the same worktree).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionTrajectory } from "../types.js";
import { type CommitFileSetDeps, committedFiles, scopeToCommit, sessionForCommit } from "./commit-file-set.js";

const ROOT = "/repo";
function deps(staged: string[], worktree: string[] = []): CommitFileSetDeps {
	return {
		resolveRepoRoot: () => ROOT,
		gitChangedFiles: (_root, stagedOnly) => (stagedOnly ? staged : [...new Set([...staged, ...worktree])]),
	};
}

describe("committedFiles — positive (must fire)", () => {
	const filesOf = (command: string, d: CommitFileSetDeps): string[] => [...(committedFiles(command, ROOT, d)?.files ?? [])].sort();

	it("P1: a plain commit captures the staged files only", () => {
		expect(filesOf("git commit -m 'x'", deps(["src/a.ts"], ["src/b.ts"]))).toEqual(["/repo/src/a.ts"]);
		expect(committedFiles("git commit -m 'x'", ROOT, deps(["src/a.ts"]))?.root).toBe(ROOT);
	});

	it("P2: `-a` adds tracked worktree edits", () => {
		expect(filesOf("git commit -am 'x'", deps(["src/a.ts"], ["src/b.ts"]))).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
	});

	it("P3: listed flags and short clusters keep the plain form (`-qam`, `--no-verify`, `--author=`)", () => {
		const both = ["/repo/src/a.ts", "/repo/src/b.ts"];
		expect(filesOf('git commit -qam "a b"', deps(["src/a.ts"], ["src/b.ts"]))).toEqual(both);
		expect(filesOf("git commit --no-verify --author=x -m y", deps(["src/a.ts"], ["src/b.ts"]))).toEqual(["/repo/src/a.ts"]);
	});

});

describe("committedFiles — negative (must not fire)", () => {
	it("N1: a command that is not a commit has no commit set", () => {
		expect(committedFiles("git status", ROOT, deps(["src/a.ts"]))).toBeNull();
	});

	// Each command below builds its commit at run time; a modeled scope dropped a committed file's warning
	// in review rounds 1–4 (2026-10-05/06), so the scope is unknown and every finding is kept.
	it.each([
		["a pathspec commit", "git commit -m x -- src/b.ts"],
		["a preceding `git add`", "git add src && git commit -m x"],
		["`git add -u`", "git add -u src && git commit -m x"],
		["a force-added ignored file", "git add -f src/ignored.ts && git commit -m x"],
		["a `cd` between the add and the commit", "git add src/a.ts && cd src && git commit -m x"],
		["a `-C` directory", "git -C sub commit -m x"],
		["two commits in one command", "git commit -m a && git commit -m b"],
		["another index mutation first", "git apply --cached change.patch && git commit -m fix"],
		["an environment override", "GIT_INDEX_FILE=x git commit -m x"],
		["a git config override", "git -c core.hooksPath=x commit -m x"],
		["`--amend` (the previous commit's files)", "git commit --amend -m x"],
		["`-p` (hunks chosen at run time)", "git commit -p -m x"],
		["a heredoc message (not in the supported grammar)", "git commit -q -F - <<'EOF'\nsubject\nEOF"],
		["a command substitution in a flag value", 'git commit -m "$(git add src/b.ts; echo fix)"'],
		["a backtick substitution in a flag value", "git commit -m \"`git add src/b.ts`\""],
		["a process substitution", "git commit -F <(git add src/b.ts; echo fix)"],
		["a parameter expansion that can split into flags (`MESSAGE='fix --all'`)", "git commit -m $MESSAGE"],
		["a braced parameter expansion", 'git commit -m "${MESSAGE}"'],
		["a glob that can expand into paths", "git commit -m fix*"],
	])("N-unknown: %s has no certain scope", (_label, command) => {
		expect(committedFiles(command, ROOT, deps(["src/a.ts"], ["src/b.ts"]))).toBeNull();
	});

	it("N3: a staged non-ASCII path is read unquoted from real git (core.quotePath default)", () => {
		const repo = mkdtempSync(join(tmpdir(), "commit-file-set-"));
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
			git("init", "-q");
			mkdirSync(join(repo, "src"));
			writeFileSync(join(repo, "src", "café.ts"), "export {};\n");
			git("add", "src/café.ts");
			const root = realpathSync(repo);
			expect([...(committedFiles("git commit -m x", repo)?.files ?? [])]).toEqual([join(root, "src", "café.ts")]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("N4: a checkout reached through a symlink keeps findings for committed files, deleted ones included", () => {
		const base = mkdtempSync(join(tmpdir(), "commit-file-set-link-"));
		try {
			const repo = join(base, "repo");
			const link = join(base, "link");
			mkdirSync(join(repo, "src"), { recursive: true });
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
			git("init", "-q");
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
			writeFileSync(join(repo, "src", "gone.ts"), "export const g = 1;\n");
			git("add", ".");
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "files");
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
			git("rm", "-q", "src/gone.ts");
			symlinkSync(repo, link);
			const scope = committedFiles("git commit -am fix", link);
			const results = [
				{ name: "prod_delta_no_test_delta", file: join(link, "src", "a.ts"), severity: "warning" },
				{ name: "prod_delta_no_test_delta", file: join(link, "src", "gone.ts"), severity: "warning" },
				{ name: "prod_delta_no_test_delta", file: join(link, "src", "other.ts"), severity: "warning" },
			];
			expect(scopeToCommit(results, scope).map((r) => r.file)).toEqual([join(link, "src", "a.ts"), join(link, "src", "gone.ts")]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("N5: a staged symlink entry is not its target; the target's unstaged edits stay out", () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "commit-file-set-alias-")));
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
			git("init", "-q");
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
			git("add", ".");
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a");
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
			symlinkSync("src/a.ts", join(repo, "alias.ts"));
			git("add", "alias.ts");
			const results = [
				{ name: "prod_delta_no_test_delta", file: join(repo, "alias.ts"), severity: "warning" },
				{ name: "prod_delta_no_test_delta", file: join(repo, "src", "a.ts"), severity: "warning" },
			];
			expect(scopeToCommit(results, committedFiles("git commit -m alias", repo)).map((r) => r.file)).toEqual([join(repo, "alias.ts")]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("N2: an unreadable git state has no commit set (callers keep every result)", () => {
		const broken: CommitFileSetDeps = { resolveRepoRoot: () => ROOT, gitChangedFiles: () => null };
		expect(committedFiles("git commit -m 'x'", ROOT, broken)).toBeNull();
	});
});

describe("scopeToCommit — positive (must fire)", () => {
	it("P1: a file-level result for a file outside the commit is dropped", () => {
		const results = [{ name: "prod_delta_no_test_delta", file: "/repo/src/b.ts" }, { name: "x", file: "/repo/src/a.ts" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.ts"]) }).map((r) => r.file)).toEqual(["/repo/src/a.ts"]);
	});

	it("P2: a relative file path is resolved against the repo root", () => {
		expect(scopeToCommit([{ name: "tpp_leapfrog", file: "src/b.ts" }], { root: ROOT, files: new Set(["/repo/src/a.ts"]) })).toEqual([]);
	});

	it("P3: `reintroduces_removed_code` outside the commit is dropped", () => {
		const results = [{ name: "reintroduces_removed_code", file: "/repo/src/b.ts", severity: "warning" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.ts"]) })).toEqual([]);
	});
});

describe("scopeToCommit — negative (must not fire)", () => {
	it("N1: session-level results (no file) are kept", () => {
		const sessionLevel: Array<{ name: string; file?: string }> = [{ name: "done_without_verify" }];
		expect(scopeToCommit(sessionLevel, { root: ROOT, files: new Set<string>() })).toEqual(sessionLevel);
	});

	it("N3: the `<session>` sentinel is a session-level result, not a path", () => {
		const results = [{ name: "prod_test_loc_ratio", file: "<session>", severity: "warning" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.ts"]) })).toEqual(results);
	});

	it("N4: an error outside the commit is kept (a TDD block names the cycle's source; the commit may hold only its test)", () => {
		const results = [{ name: "tdd_commit_gate", file: "/repo/src/a.ts", severity: "error" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.test.ts"]) })).toEqual(results);
	});

	it("N5: a TDD cycle warning (warn mode) for a source outside a test-only commit is kept", () => {
		const results = [{ name: "tdd_commit_gate", file: "/repo/src/a.ts", severity: "warning" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.test.ts"]) })).toEqual(results);
	});

	it("N6: an aggregate assertion-loss finding is kept even when its example file is outside the commit", () => {
		const results = [{ name: "assertion_count_regression", file: "/repo/src/unstaged.test.ts", severity: "warning" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/staged.test.ts"]) })).toEqual(results);
	});

	it("N7: a check not on the file-evidence allowlist is kept even outside the commit", () => {
		const results = [{ name: "assertion_value_swap", file: "/repo/src/unstaged.test.ts", severity: "warning" }];
		expect(scopeToCommit(results, { root: ROOT, files: new Set(["/repo/src/a.ts"]) })).toEqual(results);
	});

	it("N2: with no commit set every result is kept", () => {
		const results = [{ name: "x", file: "/repo/src/b.ts" }];
		expect(scopeToCommit(results, null)).toEqual(results);
	});
});

describe("sessionForCommit (capped detectors see committed files only)", () => {
	// SAFETY: sessionForCommit reads and replaces only `files_written`; the other fields are spread through untouched.
	const session = (files: string[]) => ({ files_written: new Set(files) }) as unknown as SessionTrajectory;

	it("P1: unstaged files are removed from the detector's input", () => {
		const scoped = sessionForCommit(session(["/repo/src/u1.ts", "/repo/src/u2.ts", "/repo/src/a.ts"]), { root: ROOT, files: new Set(["/repo/src/a.ts"]) });
		expect([...scoped.files_written]).toEqual(["/repo/src/a.ts"]);
	});

	it("N1: an unknown scope returns the session unchanged", () => {
		const whole = session(["/repo/src/u1.ts", "/repo/src/a.ts"]);
		expect(sessionForCommit(whole, null)).toBe(whole);
	});
});
