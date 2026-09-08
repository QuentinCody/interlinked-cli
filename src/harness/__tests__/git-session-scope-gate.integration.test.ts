import { makeGuardRules as completeGuardRulesConfigFixture } from "../evaluator/__tests__/fixtures.js";
// Tests for the PreToolUse git-session-scope gate.
//
// Strategy: spin up real git repos in tmpdir(), stage/commit files, run the
// gate's sync entry point against the resulting state. The synchronous
// `execFileSync` calls inside the gate hit the actual git binary so the
// behaviour stays close to production. Each test scopes its own tmp repo.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import {
	evaluateGitScopeGate,
	evaluateGitScopeGateSync,
	parseGitVerb,
} from "../evaluator/git-session-scope-gate.js";
import { evaluatePreToolUse } from "../evaluator/pre-tool.js";
import { ReservationManager } from "../reservations.js";
import { captureGitBaseline, SessionTracker } from "../session-state.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";

// ============================================================
// Repo fixture helpers
// ============================================================

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
	repo = mkdtempSync(join(tmpdir(), "git-scope-test-"));
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
});

function makeSession(opts?: {
	written?: string[];
	baselineModified?: string[];
	baselineStaged?: string[];
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
	// Replace the auto-captured baseline with a deterministic one so tests
	// can exercise specific permutations.
	session.git_session_baseline = {
		head_sha: "abc",
		modified: new Set(opts?.baselineModified ?? []),
		staged: new Set(opts?.baselineStaged ?? []),
		untracked: new Set(),
	};
	for (const f of opts?.written ?? []) session.files_written.add(f);
	return session;
}

// ============================================================
// parseGitVerb
// ============================================================

describe("parseGitVerb", () => {
	it("returns null for non-git commands", () => {
		expect(parseGitVerb("ls -la")).toBeNull();
		expect(parseGitVerb("npm install")).toBeNull();
		expect(parseGitVerb("")).toBeNull();
	});

	it("returns null for unrelated git subcommands", () => {
		expect(parseGitVerb("git status")).toBeNull();
		expect(parseGitVerb("git diff")).toBeNull();
		expect(parseGitVerb("git log")).toBeNull();
	});

	it("parses `git add`", () => {
		const p = parseGitVerb("git add src/foo.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["src/foo.ts"]);
	});

	it("parses `git commit -m \"msg\"`", () => {
		const p = parseGitVerb('git commit -m "hello world"');
		expect(p?.verb).toBe("commit");
		expect(p?.args).toEqual(["-m", "hello world"]);
	});

	it("defers force-push variants", () => {
		expect(parseGitVerb("git push --force")?.deferToForcePush).toBe(true);
		expect(parseGitVerb("git push -f origin main")?.deferToForcePush).toBe(true);
		expect(parseGitVerb("git push --force-with-lease")?.deferToForcePush).toBe(true);
	});

	it("does NOT defer plain push", () => {
		expect(parseGitVerb("git push")?.deferToForcePush).toBe(false);
		expect(parseGitVerb("git push origin main")?.deferToForcePush).toBe(false);
	});

	it("ignores global git flags before the subcommand", () => {
		const p = parseGitVerb("git -C /tmp -c user.name=foo add bar.ts");
		expect(p?.verb).toBe("add");
		expect(p?.args).toEqual(["bar.ts"]);
	});
});

// ============================================================
// Core gate scenarios
// ============================================================

describe("evaluateGitScopeGate — git add", () => {
	it("allows when adding a single session-written file", () => {
		writeFile("src/foo.ts", "export const x = 1;");
		const session = makeSession({ written: ["src/foo.ts"] });
		const v = evaluateGitScopeGateSync("git add src/foo.ts", session, repo);
		expect(v?.decision).toBe("allow");
	});

	it("asks when adding a pre-existing dirty file (in baseline)", () => {
		// Commit a file then re-modify it, mark it as baseline-modified.
		writeFile("src/legacy.ts", "export const a = 1;");
		git(["add", "src/legacy.ts"]);
		git(["commit", "-m", "add legacy", "-q"]);
		writeFile("src/legacy.ts", "export const a = 2;");
		const session = makeSession({
			written: [],
			baselineModified: ["src/legacy.ts"],
		});
		const v = evaluateGitScopeGateSync("git add src/legacy.ts", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.reason).toMatch(/pre-existing|before this session/i);
		expect(v?.baseline_files).toContain("src/legacy.ts");
	});

	it("asks when adding an unknown file (neither baseline nor written)", () => {
		writeFile("src/random.ts", "export const r = 1;");
		const session = makeSession({ written: ["src/other.ts"] });
		const v = evaluateGitScopeGateSync("git add src/random.ts", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.unauthorized_files).toContain("src/random.ts");
	});

	it("allows `git add -A` when all dirty files are session-written", () => {
		writeFile("src/a.ts", "1");
		writeFile("src/b.ts", "2");
		const session = makeSession({ written: ["src/a.ts", "src/b.ts"] });
		const v = evaluateGitScopeGateSync("git add -A", session, repo);
		expect(v?.decision).toBe("allow");
	});

	it("asks `git add -A` when one of many is unknown", () => {
		writeFile("src/a.ts", "1");
		writeFile("src/b.ts", "2");
		writeFile("src/sneaky.ts", "3");
		const session = makeSession({ written: ["src/a.ts", "src/b.ts"] });
		const v = evaluateGitScopeGateSync("git add -A", session, repo);
		expect(v?.decision).toBe("ask");
		expect(v?.unauthorized_files).toContain("src/sneaky.ts");
	});

	it("allows `git add .` when all paths are session-written", () => {
		writeFile("src/only.ts", "x");
		const session = makeSession({ written: ["src/only.ts"] });
		const v = evaluateGitScopeGateSync("git add .", session, repo);
		expect(v?.decision).toBe("allow");
	});
});

describe("evaluateGitScopeGate — git commit", () => {
	it("asks `git commit -a` when one pre-existing file is included", () => {
		writeFile("src/known.ts", "export const a = 1;");
		git(["add", "src/known.ts"]);
		git(["commit", "-m", "add known", "-q"]);
		// Pre-existing modification to known.ts (NOT touched by this session).
		writeFile("src/known.ts", "export const a = 2;");
		const session = makeSession({
			written: [],
			baselineModified: ["src/known.ts"],
		});
		const v = evaluateGitScopeGateSync(
			'git commit -am "wip"',
			session,
			repo,
		);
		expect(v?.decision).toBe("ask");
		expect(v?.baseline_files).toContain("src/known.ts");
	});

	it("`git commit` (no positional) uses staged-only as op_files", () => {
		// Stage a file we did write and a file we didn't.
		writeFile("src/mine.ts", "1");
		writeFile("src/theirs.ts", "2");
		git(["add", "src/mine.ts", "src/theirs.ts"]);
		const session = makeSession({ written: ["src/mine.ts"] });
		const v = evaluateGitScopeGateSync("git commit -m wip", session, repo);
		expect(v?.decision).toBe("ask");
		// Only the staged set should be considered.
		expect(v?.resolved_files.sort()).toEqual(["src/mine.ts", "src/theirs.ts"]);
		expect(v?.unauthorized_files).toContain("src/theirs.ts");
		expect(v?.unauthorized_files).not.toContain("src/mine.ts");
	});

	it("parses positional files after `--`", () => {
		writeFile("src/a.ts", "1");
		writeFile("src/b.ts", "2");
		const session = makeSession({ written: ["src/a.ts"] });
		const v = evaluateGitScopeGateSync(
			'git commit -m "msg" -- src/a.ts src/b.ts',
			session,
			repo,
		);
		expect(v?.decision).toBe("ask");
		expect(v?.unauthorized_files).toContain("src/b.ts");
	});

	it("allows commit when every staged file was session-written", () => {
		writeFile("src/mine.ts", "1");
		git(["add", "src/mine.ts"]);
		const session = makeSession({ written: ["src/mine.ts"] });
		const v = evaluateGitScopeGateSync("git commit -m ok", session, repo);
		expect(v?.decision).toBe("allow");
	});
});

describe("evaluateGitScopeGate — git push", () => {
	it("returns null on `git push --force` (defer to force-push rule)", () => {
		const session = makeSession();
		const v = evaluateGitScopeGateSync("git push --force", session, repo);
		expect(v).toBeNull();
	});

	it("allows with note when no upstream is configured", () => {
		const session = makeSession();
		const v = evaluateGitScopeGateSync("git push", session, repo);
		expect(v?.decision).toBe("allow");
		expect(v?.reason).toMatch(/upstream/i);
	});
});

describe("evaluateGitScopeGate — async wrapper", () => {
	it("async wrapper returns the same verdict as the sync entry", async () => {
		writeFile("src/foo.ts", "x");
		const session = makeSession({ written: ["src/foo.ts"] });
		const verdict = await evaluateGitScopeGate(
			"git add src/foo.ts",
			session,
			repo,
		);
		expect(verdict?.decision).toBe("allow");
	});
});

// ============================================================
// Subagent rollup integration
// ============================================================

describe("subagent rollup integration", () => {
	it("after rollUpFileTracking, parent can commit a file the subagent wrote", () => {
		writeFile("src/fileA.ts", "export const a = 1;");
		const tracker = new SessionTracker();
		const parentEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "parent",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			cwd: repo,
		};
		const childEvent: HarnessEvent = {
			...parentEvent,
			session_id: "child",
			agent_name: "child-agent",
		};
		const parent = tracker.recordEvent(parentEvent);
		const child = tracker.recordEvent(childEvent);
		child.files_written.add("src/fileA.ts");

		expect(tracker.rollUpFileTracking("child", "parent")).toBe(true);
		expect(parent.files_written.has("src/fileA.ts")).toBe(true);

		const v = evaluateGitScopeGateSync(
			"git add src/fileA.ts",
			parent,
			repo,
		);
		expect(v?.decision).toBe("allow");
	});
});

// ============================================================
// Feature flag + degraded-mode integration via evaluatePreToolUse
// ============================================================

function makeRules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	return { ...completeGuardRulesConfigFixture(), ...overrides };
}

function buildBashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "wiring-test",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		tool_name: "Bash",
		tool_input: { command },
		cwd: repo,
	};
}

describe("gate wiring in evaluatePreToolUse", () => {
	it("when disabled, gate is bypassed (no ask emitted)", () => {
		writeFile("src/unknown.ts", "1");
		const tracker = new SessionTracker();
		tracker.recordEvent({
			hook_event: "PreToolUse",
			session_id: "wiring-test",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			cwd: repo,
		});

		const rules = makeRules({
			git_session_scope_gate: { enabled: false, mode: "ask" },
		});
		const event = buildBashEvent("git add src/unknown.ts");
		const dec = evaluatePreToolUse(
			event,
			rules,
			tracker.get("wiring-test"),
			new ReservationManager(),
			new CohortManager(),
			undefined,
			tracker,
		);
		expect(dec.decision).not.toBe("ask");
		expect(dec.decision).not.toBe("block");
	});

	it("when enabled in ask mode, unknown-file `git add` returns ask", () => {
		writeFile("src/unknown.ts", "1");
		const tracker = new SessionTracker();
		tracker.recordEvent({
			hook_event: "PreToolUse",
			session_id: "wiring-test",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			cwd: repo,
		});
		// Clear baseline to force unknown classification.
		const sess = tracker.get("wiring-test");
		if (sess) {
			sess.git_session_baseline = {
				head_sha: "x",
				modified: new Set(),
				staged: new Set(),
				untracked: new Set(),
			};
		}

		const rules = makeRules({
			git_session_scope_gate: { enabled: true, mode: "ask" },
		});
		const event = buildBashEvent("git add src/unknown.ts");
		const dec = evaluatePreToolUse(
			event,
			rules,
			tracker.get("wiring-test"),
			new ReservationManager(),
			new CohortManager(),
			undefined,
			tracker,
		);
		expect(dec.decision).toBe("ask");
		expect(dec.rule_id).toBe("git-session-scope-gate");
	});

	it("when mode=block, returns block instead of ask", () => {
		writeFile("src/unknown.ts", "1");
		const tracker = new SessionTracker();
		tracker.recordEvent({
			hook_event: "PreToolUse",
			session_id: "wiring-test",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			cwd: repo,
		});
		const sess = tracker.get("wiring-test");
		if (sess) {
			sess.git_session_baseline = {
				head_sha: "x",
				modified: new Set(),
				staged: new Set(),
				untracked: new Set(),
			};
		}

		const rules = makeRules({
			git_session_scope_gate: { enabled: true, mode: "block" },
		});
		const event = buildBashEvent("git add src/unknown.ts");
		const dec = evaluatePreToolUse(
			event,
			rules,
			tracker.get("wiring-test"),
			new ReservationManager(),
			new CohortManager(),
			undefined,
			tracker,
		);
		expect(dec.decision).toBe("block");
	});
});

// ============================================================
// Baseline capture — non-git repo handling
// ============================================================

describe("captureGitBaseline (non-git cwd)", () => {
	it("returns empty baseline for a non-git directory", () => {
		const nonGit = mkdtempSync(join(tmpdir(), "non-git-"));
		try {
			const b = captureGitBaseline(nonGit);
			expect(b.head_sha).toBe("");
			expect(b.modified.size).toBe(0);
			expect(b.staged.size).toBe(0);
			expect(b.untracked.size).toBe(0);
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	it("populates head_sha and untracked for a real repo with new files", () => {
		writeFile("src/new.ts", "x");
		const b = captureGitBaseline(repo);
		expect(b.head_sha.length).toBeGreaterThan(0);
		expect(b.untracked.has("src/new.ts")).toBe(true);
	});

	it("gate degrades to allow-with-warning on a non-git cwd", () => {
		const nonGit = mkdtempSync(join(tmpdir(), "non-git-gate-"));
		try {
			const tracker = new SessionTracker();
			tracker.recordEvent({
				hook_event: "PreToolUse",
				session_id: "ng",
				agent_source: "claude",
				timestamp: "2026-05-27T00:00:00.000Z",
				cwd: nonGit,
			});
			const session = tracker.get("ng");
			expect(session).toBeDefined();
			if (!session) return;
			// A bare `git push` outside a repo: gate should return null
			// or allow-with-note (not block / ask).
			const v = evaluateGitScopeGateSync("git push", session, nonGit);
			expect(v?.decision !== "ask").toBe(true);
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});
});
