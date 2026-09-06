// Companion unit test for git-session-scope-gate.ts targeting coverage gaps
// not exercised by the broader integration test
// (__tests__/git-session-scope-gate.integration.test.ts). Same strategy:
// real git repos in tmpdir(), real execFileSync calls.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	evaluateGitScopeGateSync,
	parseGitVerb,
} from "./git-session-scope-gate.js";
import * as gitScopeResolutionHelpers from "./git-session-scope-gate-resolution-helpers.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";

let repo: string;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function writeFile(rel: string, content: string): void {
	const full = join(repo, rel);
	mkdirSync(join(repo, rel, ".."), { recursive: true });
	writeFileSync(full, content);
}

function initRepo(): void {
	repo = mkdtempSync(join(tmpdir(), "git-scope-unit-"));
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["commit", "--allow-empty", "-q", "-m", "initial"]);
}

beforeEach(() => {
	initRepo();
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeSession(opts?: {
	written?: string[];
	baselineModified?: string[];
	baselineStaged?: string[];
	noBaseline?: boolean;
}): SessionTrajectory {
	const tracker = new SessionTracker();
	const event: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		cwd: repo,
	};
	const session = tracker.recordEvent(event);
	if (opts?.noBaseline) {
		session.git_session_baseline = undefined;
	} else {
		session.git_session_baseline = {
			head_sha: "abc",
			modified: new Set(opts?.baselineModified ?? []),
			staged: new Set(opts?.baselineStaged ?? []),
			untracked: new Set(),
		};
	}
	for (const f of opts?.written ?? []) session.files_written.add(f);
	return session;
}

// ============================================================
// evaluateGitScopeGateSync — early exits (line 106)
// ============================================================

describe("evaluateGitScopeGateSync — non-git command short-circuit", () => {
	it("returns null immediately for a non-git bash command", () => {
		const session = makeSession();
		expect(evaluateGitScopeGateSync("ls -la", session, repo)).toBeNull();
	});
});

// ============================================================
// evaluateGitScopeGateSync — missing baseline (line 147 false branch)
// ============================================================

describe("evaluateGitScopeGateSync — no git_session_baseline captured", () => {
	it("still asks about an unauthorized file with no baseline set", () => {
		writeFile("src/unknown.ts", "1");
		const session = makeSession({ written: [], noBaseline: true });
		expect(session.git_session_baseline).toBeUndefined();
		const v = evaluateGitScopeGateSync("git add src/unknown.ts", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.baseline_files).toEqual([]);
		expect(v?.unauthorized_files).toEqual(["src/unknown.ts"]);
	});
});

// ============================================================
// parseGitVerb — empty token list after split (line 225)
// ============================================================

describe("parseGitVerb — empty first segment", () => {
	it("returns null when the command starts with a compound separator", () => {
		// firstSegment splits to "" before the "&&", tokens end up empty.
		expect(parseGitVerb("&&git add x")).toBeNull();
	});
});

// ============================================================
// parseGitVerb — first-token git-likeness check (line 232)
// ============================================================

describe("parseGitVerb — first token is not git-like", () => {
	it("returns null when 'git' appears later but not as the first token", () => {
		expect(parseGitVerb("npm run git add x")).toBeNull();
	});

	it("accepts an absolute path ending in /git as the first token", () => {
		const p = parseGitVerb("/usr/bin/git add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// skipGitGlobalOptions — --git-dir= / --work-tree= / other flags
// (lines 268-270, 272-275)
// ============================================================

describe("parseGitVerb — global option skipping", () => {
	it("skips a --git-dir=<path> style flag", () => {
		const p = parseGitVerb("git --git-dir=/tmp/x.git add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("skips a --work-tree=<path> style flag", () => {
		const p = parseGitVerb("git --work-tree=/tmp/x add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("skips an unrecognized single-dash global flag", () => {
		const p = parseGitVerb("git -p add foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// shellSplit — escapes, quotes, whitespace collapsing
// (lines 295-298, 300-302, 309, 317)
// ============================================================

describe("parseGitVerb — shell-aware tokenizing", () => {
	it("keeps a backslash-escaped space as part of one token", () => {
		const p = parseGitVerb("git add foo\\ bar.ts");
		expect(p?.args).toEqual(["foo bar.ts"]);
	});

	it("keeps a single-quoted path with a space as one token", () => {
		const p = parseGitVerb("git add 'foo bar.ts'");
		expect(p?.args).toEqual(["foo bar.ts"]);
	});

	it("collapses repeated whitespace between tokens", () => {
		const p = parseGitVerb("git  add   foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["foo.ts"]);
	});

	it("ignores trailing whitespace at the end of the command", () => {
		const p = parseGitVerb("git add foo.ts ");
		expect(p?.args).toEqual(["foo.ts"]);
	});
});

// ============================================================
// resolvePushOpFiles — success path with a real upstream configured
// (lines 416-420, 446, formatReason "hasn't written" branch)
// ============================================================

describe("evaluateGitScopeGateSync — git push with a configured upstream", () => {
	it("resolves the commits ahead of upstream and asks about an unwritten file", () => {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		// A second local branch acts as the upstream baseline.
		git(["branch", "upstream-track"]);
		git(["branch", `--set-upstream-to=upstream-track`, branch]);

		writeFile("src/ahead.ts", "export const a = 1;");
		git(["add", "src/ahead.ts"]);
		git(["commit", "-q", "-m", "ahead of upstream"]);

		const session = makeSession({ written: [] });
		const v = evaluateGitScopeGateSync("git push", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.resolved_files).toEqual(["src/ahead.ts"]);
		expect(v?.reason).toMatch(/push/);
		expect(v?.reason).toMatch(/hasn't written/);
	});
});

// ============================================================
// formatReason — REASON_FILE_LIMIT overflow (">, …" truncation)
// (branches 455, 459)
// ============================================================

describe("evaluateGitScopeGateSync — reason truncation past REASON_FILE_LIMIT", () => {
	it("appends an ellipsis when more than 5 unauthorized files are unknown", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const n of names) writeFile(n, "x");
		const session = makeSession({ written: [] });
		const v = evaluateGitScopeGateSync("git add -A", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.unauthorized_files.length).toBe(6);
		expect(v?.reason).toMatch(/, …/);
	});

	it("appends an ellipsis when more than 5 baseline files are pre-existing", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const n of names) {
			writeFile(n, "1");
		}
		git(["add", ...names]);
		git(["commit", "-q", "-m", "add all"]);
		for (const n of names) writeFile(n, "2");
		const session = makeSession({ written: [], baselineModified: names });
		const v = evaluateGitScopeGateSync("git commit -am wip", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.baseline_files.length).toBe(6);
		expect(v?.reason).toMatch(/, …/);
		expect(v?.reason).toMatch(/before this session started/);
	});
});

// ============================================================
// Mutation hardening — parser boundaries and force-push delegation
// ============================================================

describe("parseGitVerb — mutation-sensitive command boundaries", () => {
	it("rejects a command whose first token merely contains git", () => {
		expect(parseGitVerb("npm add git x.ts")).toBeNull();
	});

	it("accepts the plain git executable and rejects a git-suffixed executable", () => {
		expect(parseGitVerb("git add x.ts")).toEqual({
			verb: "add",
			args: ["x.ts"],
			deferToForcePush: false,
		});
		expect(parseGitVerb("/usr/bin/git-wrapper add x.ts")).toBeNull();
	});

	it("skips both separate and equals-form global options", () => {
		expect(parseGitVerb("git --git-dir /tmp/repo add x.ts")?.args).toEqual(["x.ts"]);
		expect(parseGitVerb("git --work-tree /tmp/repo add x.ts")?.args).toEqual(["x.ts"]);
		expect(parseGitVerb("git --git-dir=/tmp/repo add x.ts")?.args).toEqual(["x.ts"]);
		expect(parseGitVerb("git --work-tree=/tmp/repo add x.ts")?.args).toEqual(["x.ts"]);
	});

	it("does not let an add or commit flag trigger force-push deferral", () => {
		expect(parseGitVerb("git add --force x.ts")?.verb).toBe("add");
		expect(parseGitVerb("git commit --force -m msg")?.verb).toBe("commit");
	});

	it("defers every force-push spelling, but not an embedded --force token", () => {
		expect(parseGitVerb("git push --force")).toMatchObject({ deferToForcePush: true });
		expect(parseGitVerb("git push -f")).toMatchObject({ deferToForcePush: true });
		expect(parseGitVerb("git push --force-with-lease")).toMatchObject({ deferToForcePush: true });
		expect(parseGitVerb("git push --force-if-includes")).toMatchObject({
			deferToForcePush: true,
		});
		expect(parseGitVerb("git push origin--force")).toMatchObject({
			verb: "push",
			deferToForcePush: false,
		});
	});

	it("preserves a trailing backslash rather than dropping the final character", () => {
		expect(parseGitVerb("git add trailing\\")?.args).toEqual(["trailing\\"]);
	});
});

// ============================================================
// Mutation hardening — git add resolution
// ============================================================

describe("evaluateGitScopeGateSync — git add all-form detection", () => {
	it("keeps a targeted pathspec narrow", () => {
		writeFile("src/target.ts", "target");
		writeFile("src/other.ts", "other");
		const v = evaluateGitScopeGateSync("git add src/target.ts", makeSession(), repo);
		expect(v?.resolved_files).toEqual(["src/target.ts"]);
	});

	it.each(["-A", "--all", "-u", "--update"])(
		"treats %s as an all-form even with a pathspec",
		(flag) => {
			writeFile("src/target.ts", "target");
			writeFile("src/other.ts", "other");
			const v = evaluateGitScopeGateSync(
				`git add ${flag} src/target.ts`,
				makeSession(),
				repo,
			);
			expect(new Set(v?.resolved_files)).toEqual(new Set(["src/target.ts", "src/other.ts"]));
		},
	);

	it("treats dot and no pathspec as all-form", () => {
		writeFile("src/target.ts", "target");
		writeFile("src/other.ts", "other");
		for (const command of ["git add .", "git add"]) {
			const v = evaluateGitScopeGateSync(command, makeSession(), repo);
			expect(new Set(v?.resolved_files)).toEqual(new Set(["src/target.ts", "src/other.ts"]));
		}
	});
});

// ============================================================
// Mutation hardening — commit/push resolution and receipts
// ============================================================

describe("evaluateGitScopeGateSync — commit and push file sets", () => {
	it("bare commit considers staged files only, not every tracked modification", () => {
		writeFile("staged.ts", "v1");
		writeFile("unstaged.ts", "v1");
		git(["add", "staged.ts", "unstaged.ts"]);
		git(["commit", "-q", "-m", "seed"]);
		writeFile("staged.ts", "v2");
		writeFile("unstaged.ts", "v2");
		git(["add", "staged.ts"]);

		const v = evaluateGitScopeGateSync("git commit -m wip", makeSession(), repo);
		expect(v?.resolved_files).toEqual(["staged.ts"]);
	});

	it("allows a push without an upstream and reports empty file arrays", () => {
		const v = evaluateGitScopeGateSync("git push", makeSession(), repo);
		expect(v).toMatchObject({
			decision: "allow",
			reason: "no upstream — push will set it; gate skipped.",
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		});
	});
});

// ============================================================
// Mutation hardening — reason contents, truncation, and verb labels
// ============================================================

describe("evaluateGitScopeGateSync — exact ask-reason contract", () => {
	it("uses the add label and exact separator/suffix for one unknown file", () => {
		writeFile("src/one.ts", "one");
		const v = evaluateGitScopeGateSync("git add src/one.ts", makeSession(), repo);
		expect(v?.reason).toBe(
			"This git add would include 1 file(s) this session hasn't written (src/one.ts). Confirm intent.",
		);
	});

	it("does not add an ellipsis at the five-file boundary", () => {
		const names = ["a", "b", "c", "d", "e"].map((n) => `src/${n}.ts`);
		for (const name of names) writeFile(name, "x");
		const v = evaluateGitScopeGateSync("git add -A", makeSession(), repo);
		expect(v?.reason).toContain(names.join(", "));
		expect(v?.reason).not.toContain("…");
	});

	it("truncates the displayed unknown list while retaining the full count", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
		for (const name of names) writeFile(name, "x");
		const v = evaluateGitScopeGateSync("git add -A", makeSession(), repo);
		expect(v?.reason).toContain("6 file(s)");
		expect(v?.reason).toContain("src/e.ts, …");
		expect(v?.reason).not.toContain("src/f.ts");
	});

	it("uses the commit label and baseline-specific wording", () => {
		writeFile("src/commit.ts", "v1");
		git(["add", "src/commit.ts"]);
		git(["commit", "-q", "-m", "seed"]);
		writeFile("src/commit.ts", "v2");
		const v = evaluateGitScopeGateSync(
			"git commit -am wip",
			makeSession({ baselineModified: ["src/commit.ts"] }),
			repo,
		);
		expect(v?.reason).toBe(
			"This git commit would include 1 file(s) that existed in the working tree before this session started (src/commit.ts). " +
			"These weren't written by this session's agent or its subagents — confirm before proceeding.",
		);
	});
});

// ============================================================
// resolveOpFiles throwing (git plumbing genuinely unusable)
// ============================================================
//
// Every real git shell-out this gate makes already catches its own failures
// (non-git cwd, missing `git` binary, no upstream) and degrades to an empty
// file list — so the resolver itself never throws through any bashCommand
// this parser can produce. The outer catch this describe block targets is a
// defensive backstop for a resolver-level failure (e.g. the underlying git
// primitive raising something its own try/catch didn't anticipate). We
// reach it by making the collaborator throw directly, the same class of
// injected failure as spying a throwing node:fs method on a different gate.
describe("evaluateGitScopeGateSync — resolveOpFiles throws", () => {
	it("degrades to allow with the 'git unavailable' note instead of propagating the error", () => {
		vi.spyOn(gitScopeResolutionHelpers, "statusPaths").mockImplementationOnce(() => {
			throw new Error("simulated git-status failure");
		});
		const v = evaluateGitScopeGateSync("git add -A", makeSession(), repo);
		expect(v).toEqual({
			decision: "allow",
			reason: "git unavailable; gate degraded to allow.",
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		});
	});
});
