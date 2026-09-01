// Behavioral tests for the PreToolUse short-circuit guard phases.
//
// Each guard inspects a HarnessEvent (+ tool name/input, rules, session) and
// returns a `HarnessDecision` to short-circuit the orchestrator or `null` to
// continue. These tests drive both branches of every guard with real
// filesystem fixtures (unique mkdtemp dirs) and real git repos where the gate
// shells out — no mocking, matching the sibling guard tests.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addToAllowlist } from "../package-allowlist.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import { SessionTracker } from "../session-state.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	evaluateBaselineIntegrityGate,
	evaluateConfigLooseningGate,
	evaluateEditOldStringGuard,
	evaluateGitScopeGate,
	evaluateManifestEditGuard,
	evaluateMetaTestWrapper,
	evaluatePackageInstallGuard,
	evaluateProtectedFilesGuard,
	evaluateRepoConfinementGuard,
	evaluateSupermodelShardGuard,
	evaluateTddGate,
	evaluateWebFetchGuard,
} from "./pre-tool-guards.js";

// ============================================================
// Fixtures
// ============================================================

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pre-tool-guards-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
});

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: workspace,
		...overrides,
	};
}

/** Minimal trajectory built through the real tracker, then mutated for the
 *  specific scenario. The cast covers fields the guards never read. */
function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const tracker = new SessionTracker();
	const session = tracker.recordEvent(makeEvent());
	return Object.assign(session, overrides);
}

/**
 * A genuinely complete GuardRulesConfig, honest about the fields
 * `loadRules()` always populates in production — `quality_checks`,
 * `structural_checks`, `taint_tracking`, and `output_scanning` are honestly
 * required (see CLAUDE.md's "GuardRulesConfig sections"), so a partial cast
 * here would lie about a shape the real evaluator never sees. Those four
 * required sections are pulled from the same builtin `DEFAULT_CONFIG`
 * `loadRules()` falls back to; everything else (e.g. `per_edit_coverage`,
 * `git_session_scope_gate`) stays absent unless a test opts in via
 * `overrides` — pulling the FULL default config would silently switch on
 * unrelated production features (coverage debt tracking, etc.) that these
 * isolated guard tests never intended to exercise. `overrides` replaces
 * top-level sections wholesale except `structural_checks` and
 * `quality_checks`, which merge onto the required defaults so a test
 * overriding one field (e.g. `test_first_mode`) doesn't silently drop a
 * sibling default (e.g. `characterize_mode`) that other guards in the same
 * call path read.
 */
type RulesOverrides = Omit<Partial<GuardRulesConfig>, "structural_checks" | "quality_checks"> & {
	structural_checks?: Partial<GuardRulesConfig["structural_checks"]>;
	quality_checks?: GuardRulesConfig["quality_checks"];
};

function makeRules(overrides: RulesOverrides = {}): GuardRulesConfig {
	const { structural_checks, quality_checks, ...rest } = overrides;
	return {
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: DEFAULT_CONFIG.curl_mcp_detection,
		error_memory: DEFAULT_CONFIG.error_memory,
		taint_tracking: DEFAULT_CONFIG.taint_tracking,
		output_scanning: DEFAULT_CONFIG.output_scanning,
		repo_confinement_allowlist: [],
		linked_projects: [],
		...rest,
		structural_checks: { ...DEFAULT_CONFIG.structural_checks, ...structural_checks },
		quality_checks: { ...DEFAULT_CONFIG.quality_checks, ...quality_checks },
	};
}

function git(args: string[], cwd: string): string {
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

function initRepo(cwd: string): void {
	git(["init", "-q"], cwd);
	git(["config", "user.email", "test@example.com"], cwd);
	git(["config", "user.name", "Test"], cwd);
	git(["commit", "--allow-empty", "-q", "-m", "initial"], cwd);
}

// ============================================================
// evaluateMetaTestWrapper
// ============================================================

describe("evaluateMetaTestWrapper", () => {
	it("allows the `interlinked harness test` wrapper command (Bash)", () => {
		const d = evaluateMetaTestWrapper("Bash", {
			command: 'interlinked harness test "rm -rf /"',
		});
		expect(d).toEqual({ decision: "allow" });
	});

	it("matches with leading whitespace and the Shell tool name", () => {
		const d = evaluateMetaTestWrapper("Shell", {
			command: '   interlinked harness test "DROP TABLE users"',
		});
		expect(d).toEqual({ decision: "allow" });
	});

	it("matches under the run_command tool name", () => {
		const d = evaluateMetaTestWrapper("run_command", {
			command: "interlinked harness test echo",
		});
		expect(d).toEqual({ decision: "allow" });
	});

	it("returns null for a non-wrapper Bash command", () => {
		expect(evaluateMetaTestWrapper("Bash", { command: "ls -la" })).toBeNull();
	});

	it("returns null when the command field is missing/non-string", () => {
		expect(evaluateMetaTestWrapper("Bash", {})).toBeNull();
		expect(
			evaluateMetaTestWrapper("Bash", { command: 123 as unknown as string }),
		).toBeNull();
	});

	it("returns null for a non-shell tool name even with matching text", () => {
		expect(
			evaluateMetaTestWrapper("Write", {
				command: "interlinked harness test x",
			}),
		).toBeNull();
	});

	it("does not match `interlinked harness` without `test`", () => {
		expect(
			evaluateMetaTestWrapper("Bash", { command: "interlinked harness status" }),
		).toBeNull();
	});

	// Hardened 2026-06-12: the prefix-only test blanket-allowed any command
	// that merely STARTED with the wrapper, letting a chained tail run
	// unguarded. These pin the tail guard (see inspection-wrapper.ts).
	it("does NOT allow a chained destructive tail (the bypass it used to permit)", () => {
		expect(
			evaluateMetaTestWrapper("Bash", {
				command: 'interlinked harness test "x" && rm -rf /',
			}),
		).toBeNull();
	});

	it("does NOT allow a redirect tail", () => {
		expect(
			evaluateMetaTestWrapper("Bash", {
				command: "interlinked harness test 'x' > /etc/passwd",
			}),
		).toBeNull();
	});

	it("does NOT allow a command-substitution argument", () => {
		expect(
			evaluateMetaTestWrapper("Bash", {
				command: 'interlinked harness test "$(rm -rf /)"',
			}),
		).toBeNull();
	});
});

// ============================================================
// evaluateSupermodelShardGuard
// ============================================================

describe("evaluateSupermodelShardGuard", () => {
	it("blocks a Write whose file_path is a .graph shard", () => {
		const d = evaluateSupermodelShardGuard(
			makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "codebase.graph.json", content: "x" },
			}),
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("builtin-supermodel-graph-write-blocked-applypatch");
		expect(d?.severity).toBe("high");
		expect(d?.category).toBe("filesystem");
		expect(d?.reason).toMatch(/codebase\.graph\.json/);
	});

	it("blocks an apply_patch that targets a .graph shard inside the patch body", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: model.graph",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		const d = evaluateSupermodelShardGuard(
			makeEvent({
				tool_name: "apply_patch",
				tool_input: { patch },
			}),
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/model\.graph/);
	});

	it("returns null for a normal source write", () => {
		expect(
			evaluateSupermodelShardGuard(
				makeEvent({
					tool_name: "Write",
					tool_input: { file_path: "src/foo.ts", content: "x" },
				}),
			),
		).toBeNull();
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateSupermodelShardGuard(
				makeEvent({ tool_name: "Bash", tool_input: { command: "ls" } }),
			),
		).toBeNull();
	});
});

// ============================================================
// evaluatePackageInstallGuard
// ============================================================

describe("evaluatePackageInstallGuard", () => {
	it("blocks installing an unapproved npm package", () => {
		const d = evaluatePackageInstallGuard(
			makeEvent(),
			"Bash",
			{ command: "npm install some-unapproved-pkg-v6" },
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/some-unapproved-pkg-v6/);
	});

	it("allows installs when the package guard is disabled via env", () => {
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		expect(
			evaluatePackageInstallGuard(makeEvent(), "Bash", {
				command: "npm install some-unapproved-pkg-v6",
			}),
		).toBeNull();
	});

	it("package-install guard returns null for a non-Bash tool", () => {
		expect(
			evaluatePackageInstallGuard(makeEvent(), "Write", {
				command: "npm install evil",
			}),
		).toBeNull();
	});

	it("package-install guard returns null for an empty command", () => {
		expect(
			evaluatePackageInstallGuard(makeEvent(), "Bash", { command: "" }),
		).toBeNull();
	});

	it("returns null when the command is not a package install", () => {
		expect(
			evaluatePackageInstallGuard(makeEvent(), "Bash", {
				command: "echo hello",
			}),
		).toBeNull();
	});

	it("falls back to process.cwd() when event.cwd is absent (no block for non-install)", () => {
		const ev = makeEvent();
		delete ev.cwd;
		expect(
			evaluatePackageInstallGuard(ev, "Bash", { command: "ls -la" }),
		).toBeNull();
	});

	it("uses process.cwd() for an install command when event.cwd is absent", () => {
		// event.cwd deleted → the guard falls back to process.cwd() (the repo
		// root) to load the allowlist. An unapproved synthetic package is not on
		// it, so this still blocks — exercising the `event.cwd || process.cwd()`
		// fallback branch deterministically.
		const ev = makeEvent();
		delete ev.cwd;
		const d = evaluatePackageInstallGuard(ev, "Bash", {
			command: "npm install another-unapproved-pkg-v7",
		});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/another-unapproved-pkg-v7/);
	});

	it("returns null when the install resolves to an allowed (non-block) decision", () => {
		// Approve the package in the workspace allowlist so evaluatePackageInstall
		// returns {decision:"allow"} — the guard's `decision === "block"` check is
		// false and it falls through to null. The spec is exactly pinned so the
		// (independent) exact-pin gate also passes; an unpinned install would
		// block on the pin gate regardless of allowlist status.
		addToAllowlist(workspace, "npm", "approved-pkg-v8", { approved_by: "tester" });
		expect(
			evaluatePackageInstallGuard(makeEvent(), "Bash", {
				command: "npm install approved-pkg-v8@1.2.3",
			}),
		).toBeNull();
	});
});

// ============================================================
// evaluateGitScopeGate
// ============================================================

describe("evaluateGitScopeGate", () => {
	function gateRules(mode: "ask" | "block" | "off"): GuardRulesConfig {
		return makeRules({
			git_session_scope_gate: { enabled: true, mode },
		});
	}

	it("asks before staging a file the session did not write (mode=ask)", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "untouched.ts"), "export const x = 1;\n");
		// session wrote nothing → staging untouched.ts is unauthorized
		const session = makeSession();
		const d = evaluateGitScopeGate(
			makeEvent(),
			gateRules("ask"),
			session,
			"Bash",
			{ command: "git add untouched.ts" },
			[],
		);
		expect(d?.decision).toBe("ask");
		expect(d?.rule_id).toBe("git-session-scope-gate");
		expect(d?.severity).toBe("medium");
		expect(d?.category).toBe("git-scope");
	});

	it("maps the verdict to block when mode=block", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "untouched.ts"), "export const x = 1;\n");
		const session = makeSession();
		const d = evaluateGitScopeGate(
			makeEvent(),
			gateRules("block"),
			session,
			"Bash",
			{ command: "git add untouched.ts" },
			[],
		);
		expect(d?.decision).toBe("block");
	});

	it("passes the shared warnings array through on an ask", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "untouched.ts"), "export const x = 1;\n");
		const session = makeSession();
		const warnings = ["pre-existing warning"];
		const d = evaluateGitScopeGate(
			makeEvent(),
			gateRules("ask"),
			session,
			"Bash",
			{ command: "git add untouched.ts" },
			warnings,
		);
		expect(d?.warnings).toEqual(["pre-existing warning"]);
	});

	it("returns null when the gate is disabled", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "untouched.ts"), "export const x = 1;\n");
		const session = makeSession();
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				makeRules({ git_session_scope_gate: { enabled: false, mode: "ask" } }),
				session,
				"Bash",
				{ command: "git add untouched.ts" },
				[],
			),
		).toBeNull();
	});

	it("returns null when mode is off even if enabled", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "untouched.ts"), "export const x = 1;\n");
		const session = makeSession();
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				gateRules("off"),
				session,
				"Bash",
				{ command: "git add untouched.ts" },
				[],
			),
		).toBeNull();
	});

	it("returns null when there is no session", () => {
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				gateRules("ask"),
				undefined,
				"Bash",
				{ command: "git add x.ts" },
				[],
			),
		).toBeNull();
	});

	it("git-scope gate returns null for a non-Bash tool", () => {
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				gateRules("ask"),
				makeSession(),
				"Write",
				{ command: "git add x.ts" },
				[],
			),
		).toBeNull();
	});

	it("git-scope gate returns null for an empty command", () => {
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				gateRules("ask"),
				makeSession(),
				"Bash",
				{ command: "" },
				[],
			),
		).toBeNull();
	});

	it("returns null when the verdict is allow (file was session-written)", () => {
		initRepo(workspace);
		writeFileSync(join(workspace, "mine.ts"), "export const x = 1;\n");
		const session = makeSession();
		session.files_written.add("mine.ts");
		expect(
			evaluateGitScopeGate(
				makeEvent(),
				gateRules("ask"),
				session,
				"Bash",
				{ command: "git add mine.ts" },
				[],
			),
		).toBeNull();
	});

	it("falls back to process.cwd() when event.cwd is absent", () => {
		// Drive the `event.cwd || process.cwd()` fallback deterministically by
		// stubbing `process.cwd()` itself rather than actually chdir-ing the
		// process: `process.chdir()` throws `TypeError: process.chdir() is not
		// supported in workers` under vitest's `pool: "threads"` — which
		// Stryker's own vitest-runner forces unconditionally for every
		// mutation dry run (@stryker-mutator/vitest-runner's
		// VitestTestRunner.init hardcodes `pool: "threads"`), so a real chdir
		// here poisoned every mutation run whose graph-selected test scope
		// happened to include this file. `vi.spyOn` changes only what THIS
		// test observes, with none of the process-global side effects a real
		// chdir needs and none of the worker-thread incompatibility. The added
		// file is session-written, so the verdict is allow and the guard
		// returns null — no dependence on the real repo's git state.
		const repoRoot = realpathSync(workspace);
		initRepo(repoRoot);
		writeFileSync(join(repoRoot, "mine.ts"), "export const x = 1;\n");
		const session = makeSession();
		session.files_written.add("mine.ts");
		const ev = makeEvent();
		delete ev.cwd;
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
		try {
			expect(
				evaluateGitScopeGate(
					ev,
					gateRules("ask"),
					session,
					"Bash",
					{ command: "git add mine.ts" },
					[],
				),
			).toBeNull();
		} finally {
			cwdSpy.mockRestore();
		}
	});
});

// ============================================================
// evaluateProtectedFilesGuard
// ============================================================

describe("evaluateProtectedFilesGuard", () => {
	const protectedRules = (
		check?: string,
	): GuardRulesConfig =>
		makeRules({
			protected_files: [
				{
					glob: "**/*.secret",
					operations: ["Write", "Edit"],
					reason: "secret files are read-only",
					...(check ? { check } : {}),
				} as unknown as GuardRulesConfig["protected_files"][number],
			],
		});

	it("blocks a write to a protected glob (blanket block)", () => {
		const d = evaluateProtectedFilesGuard(
			"Write",
			{ file_path: "config/app.secret", content: "data" },
			protectedRules(),
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/read-only/);
		expect(d?.warnings).toEqual(["w"]);
	});

	// Regression (BUG 2, security): the guard gated on `isFileOperation`
	// alone, which OMITS MultiEdit / NotebookEdit, so those two write-family
	// tools slipped a write to a protected path past the blanket block. The
	// gate now unions `isFileWrite` in (it adds exactly those two), so the
	// write reaches `evaluateProtectedFiles`. `normalizeToolToOp` maps
	// MultiEdit → "Edit" and NotebookEdit → "Write", both in the rule's
	// `operations: ["Write", "Edit"]`.
	it("blocks a MultiEdit to a protected glob (was skipped under isFileOperation)", () => {
		const d = evaluateProtectedFilesGuard(
			"MultiEdit",
			{
				file_path: "config/app.secret",
				edits: [{ old_string: "a", new_string: "b" }],
			},
			protectedRules(),
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/read-only/);
		expect(d?.warnings).toEqual(["w"]);
	});

	it("blocks a NotebookEdit to a protected glob (was skipped under isFileOperation)", () => {
		const d = evaluateProtectedFilesGuard(
			"NotebookEdit",
			{ file_path: "notebooks/keys.secret", new_source: "secret = 1" },
			protectedRules(),
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/read-only/);
		expect(d?.warnings).toEqual(["w"]);
	});

	it("does NOT block a Read when the rule's operations exclude Read", () => {
		// `operations: ["Write","Edit"]` does not list "Read", so a Read of a
		// matching path falls through to null. (The gate admits the Read; the
		// per-rule operations list — via normalizeToolToOp — declines it.)
		expect(
			evaluateProtectedFilesGuard(
				"Read",
				{ file_path: "config/app.secret" },
				protectedRules(),
				[],
			),
		).toBeNull();
	});

	it("STILL blocks a Read when the rule's operations include Read (no read-protection regression)", () => {
		// The default config protects **/*.pem / **/*.key with
		// operations:["Write","Edit","Read"] to stop private-key exfiltration.
		// Switching the gate to write-only would silently drop this; the union
		// gate preserves it. A read-listed rule must keep blocking reads.
		const readProtected = makeRules({
			protected_files: [
				{
					glob: "**/*.pem",
					operations: ["Write", "Edit", "Read"],
					reason: "Private key files should not be accessed by agents",
				} as unknown as GuardRulesConfig["protected_files"][number],
			],
		});
		const d = evaluateProtectedFilesGuard(
			"Read",
			{ file_path: "certs/server.pem" },
			readProtected,
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/Private key/);
		expect(d?.warnings).toEqual(["w"]);
	});

	it("returns null for a non-file-operation tool", () => {
		expect(
			evaluateProtectedFilesGuard(
				"Bash",
				{ command: "ls" },
				protectedRules(),
				[],
			),
		).toBeNull();
	});

	it("returns null when no file path is present", () => {
		expect(
			evaluateProtectedFilesGuard("Write", {}, protectedRules(), []),
		).toBeNull();
	});

	it("returns null when the path does not match any protected glob", () => {
		expect(
			evaluateProtectedFilesGuard(
				"Write",
				{ file_path: "src/index.ts", content: "x" },
				protectedRules(),
				[],
			),
		).toBeNull();
	});

	it("reads content from new_string when content is absent", () => {
		const d = evaluateProtectedFilesGuard(
			"Edit",
			{ file_path: "a.secret", new_string: "data" },
			protectedRules(),
			[],
		);
		expect(d?.decision).toBe("block");
	});

	it("reads file path from `path` when `file_path` is absent", () => {
		const d = evaluateProtectedFilesGuard(
			"Write",
			{ path: "a.secret", content: "x" },
			protectedRules(),
			[],
		);
		expect(d?.decision).toBe("block");
	});

	it("blanket-blocks even when neither content nor new_string is present", () => {
		// Exercises the `content || new_string || ""` empty-string fallback —
		// a blanket-block rule (no `check`) fires regardless of content.
		const d = evaluateProtectedFilesGuard(
			"Write",
			{ file_path: "vault.secret" },
			protectedRules(),
			[],
		);
		expect(d?.decision).toBe("block");
	});
});

// ============================================================
// evaluateRepoConfinementGuard
// ============================================================

describe("evaluateRepoConfinementGuard", () => {
	it("blocks a write outside the repo root", () => {
		const outside = join(tmpdir(), "definitely-outside-the-repo-xyz", "f.ts");
		const d = evaluateRepoConfinementGuard(
			makeEvent(),
			"Write",
			{ file_path: outside, content: "x" },
			makeRules(),
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("builtin-repo-confinement");
		expect(d?.warnings).toEqual(["w"]);
	});

	it("allows a write inside the repo root", () => {
		const inside = join(workspace, "src", "f.ts");
		expect(
			evaluateRepoConfinementGuard(
				makeEvent(),
				"Write",
				{ file_path: inside, content: "x" },
				makeRules(),
				[],
			),
		).toBeNull();
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateRepoConfinementGuard(
				makeEvent(),
				"Bash",
				{ command: "ls" },
				makeRules(),
				[],
			),
		).toBeNull();
	});

	it("returns null when event.cwd is absent", () => {
		const ev = makeEvent();
		delete ev.cwd;
		expect(
			evaluateRepoConfinementGuard(
				ev,
				"Write",
				{ file_path: "/anywhere/f.ts", content: "x" },
				makeRules(),
				[],
			),
		).toBeNull();
	});

	it("returns null when no path is present", () => {
		expect(
			evaluateRepoConfinementGuard(
				makeEvent(),
				"Write",
				{ content: "x" },
				makeRules(),
				[],
			),
		).toBeNull();
	});

	it("allows an outside write covered by the confinement allowlist", () => {
		const allowedRoot = mkdtempSync(join(tmpdir(), "allowed-root-"));
		try {
			const target = join(allowedRoot, "f.ts");
			expect(
				evaluateRepoConfinementGuard(
					makeEvent(),
					"Write",
					{ file_path: target, content: "x" },
					makeRules({ repo_confinement_allowlist: [allowedRoot] }),
					[],
				),
			).toBeNull();
		} finally {
			rmSync(allowedRoot, { recursive: true, force: true });
		}
	});

	it("defaults allowlist + linkedProjects to [] when both keys are absent", () => {
		// Rules object omitting repo_confinement_allowlist and linked_projects —
		// exercises both `|| []` fallbacks. An outside write still blocks.
		const bareRules = {
			protected_files: [],
		} as unknown as GuardRulesConfig;
		const outside = join(tmpdir(), "outside-bare-rules-xyz", "f.ts");
		const d = evaluateRepoConfinementGuard(
			makeEvent(),
			"Write",
			{ file_path: outside, content: "x" },
			bareRules,
			[],
		);
		expect(d?.decision).toBe("block");
	});
});

// ============================================================
// evaluateTddGate
// ============================================================

describe("evaluateTddGate", () => {
	function enforceRules(): GuardRulesConfig {
		return makeRules({
			structural_checks: { test_first_mode: "enforce" },
		});
	}

	// The gate is repo-profile-aware (2026-07-06): a repo with NO tests at all
	// demotes enforce → warn (it never opted into TDD). These integration
	// fixtures therefore seed one colocated test so the workspace reads as a
	// TDD-shaped (colocated) repo, and reset the per-root profile memo both
	// ways so no other suite's cache leaks in.
	beforeEach(() => {
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "existing.test.ts"), "it('x', () => {});\n", "utf-8");
		resetRepoProfileCache();
	});
	afterEach(() => {
		resetRepoProfileCache();
	});

	it("blocks a new source file with no companion test (enforce mode)", () => {
		const target = join(workspace, "src", "feature.ts");
		const d = evaluateTddGate(
			makeEvent({
				tool_name: "Write",
				tool_input: { file_path: target, content: "export const x = 1;\n" },
			}),
			enforceRules(),
			makeSession(),
			"Write",
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("tdd_new_file_gate");
		expect(d?.warnings).toEqual(["w"]);
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateTddGate(
				makeEvent({ tool_name: "Bash", tool_input: { command: "ls" } }),
				enforceRules(),
				makeSession(),
				"Bash",
				[],
			),
		).toBeNull();
	});

	it("returns null when test_first_mode is not enforce", () => {
		const target = join(workspace, "src", "feature.ts");
		expect(
			evaluateTddGate(
				makeEvent({
					tool_name: "Write",
					tool_input: { file_path: target, content: "export const x = 1;\n" },
				}),
				// The builtin default is "enforce" (DEFAULT_STRUCTURAL_CHECKS) —
				// explicitly dial it down so this test exercises the branch its
				// name describes instead of accidentally inheriting enforce.
				// "nudge" is below the gate's floor entirely (unlike "warn",
				// which still returns an advisory allow decision) — see
				// tdd-new-file-gate.test.ts's "below the gate's floor" case.
				makeRules({ structural_checks: { test_first_mode: "nudge" } }),
				makeSession(),
				"Write",
				[],
			),
		).toBeNull();
	});

	it("returns null when a companion test already exists on disk", () => {
		mkdirSync(join(workspace, "src", "__tests__"), { recursive: true });
		writeFileSync(
			join(workspace, "src", "__tests__", "feature.test.ts"),
			"it('x', () => {});\n",
		);
		const target = join(workspace, "src", "feature.ts");
		expect(
			evaluateTddGate(
				makeEvent({
					tool_name: "Write",
					tool_input: { file_path: target, content: "export const x = 1;\n" },
				}),
				enforceRules(),
				makeSession(),
				"Write",
				[],
			),
		).toBeNull();
	});
});

// ============================================================
// evaluateConfigLooseningGate
// ============================================================

describe("evaluateConfigLooseningGate", () => {
	it("asks when a Write to tsconfig.json loosens strict from true to false", () => {
		// The gate compares the proposed content against the HEAD-committed
		// version, so the strict=true baseline must be committed in a real repo.
		// On macOS, git resolves --show-toplevel to the realpath of the temp
		// dir (/private/var/...), so we must hand the gate the realpath form or
		// the HEAD lookup computes a "../" relative path and bails.
		const repoRoot = realpathSync(workspace);
		initRepo(repoRoot);
		const target = join(repoRoot, "tsconfig.json");
		writeFileSync(
			target,
			JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
		);
		git(["add", "tsconfig.json"], repoRoot);
		git(["commit", "-q", "-m", "add tsconfig"], repoRoot);
		const d = evaluateConfigLooseningGate(
			makeEvent({
				cwd: repoRoot,
				tool_name: "Write",
				tool_input: {
					file_path: target,
					content: JSON.stringify(
						{ compilerOptions: { strict: false } },
						null,
						2,
					),
				},
			}),
			"Write",
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("config_loosening_gate");
		expect(d?.warnings).toEqual(["w"]);
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateConfigLooseningGate(
				makeEvent({ tool_name: "Bash", tool_input: { command: "ls" } }),
				"Bash",
				[],
			),
		).toBeNull();
	});

	it("returns null when the edited file is not a config file", () => {
		const target = join(workspace, "src", "index.ts");
		expect(
			evaluateConfigLooseningGate(
				makeEvent({
					tool_name: "Write",
					tool_input: { file_path: target, content: "export const x = 1;" },
				}),
				"Write",
				[],
			),
		).toBeNull();
	});

	it("returns null when the config edit does not loosen anything", () => {
		const target = join(workspace, "tsconfig.json");
		expect(
			evaluateConfigLooseningGate(
				makeEvent({
					tool_name: "Write",
					tool_input: {
						file_path: target,
						content: JSON.stringify(
							{ compilerOptions: { strict: true } },
							null,
							2,
						),
					},
				}),
				"Write",
				[],
			),
		).toBeNull();
	});
});

// ============================================================
// evaluateBaselineIntegrityGate
// ============================================================

describe("evaluateBaselineIntegrityGate", () => {
	it("blocks a Write that lowers a committed coverage baseline", () => {
		const repoRoot = realpathSync(workspace);
		initRepo(repoRoot);
		mkdirSync(join(repoRoot, ".interlinked"), { recursive: true });
		const target = join(repoRoot, ".interlinked", "coverage-baseline.json");
		writeFileSync(
			target,
			JSON.stringify({ version: 1, files: { "src/a.ts": { lines_pct: 90 } } }, null, 2),
		);
		git(["add", "-f", ".interlinked/coverage-baseline.json"], repoRoot);
		git(["commit", "-q", "-m", "add baseline"], repoRoot);
		const d = evaluateBaselineIntegrityGate(
			makeEvent({
				cwd: repoRoot,
				tool_name: "Write",
				tool_input: {
					file_path: target,
					content: JSON.stringify(
						{ version: 1, files: { "src/a.ts": { lines_pct: 10 } } },
						null,
						2,
					),
				},
			}),
			"Write",
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
		expect(d?.warnings).toEqual(["w"]);
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateBaselineIntegrityGate(
				makeEvent({ tool_name: "Bash", tool_input: { command: "ls" } }),
				"Bash",
				[],
			),
		).toBeNull();
	});

	it("returns null when a baseline edit raises (tightens) coverage", () => {
		const repoRoot = realpathSync(workspace);
		initRepo(repoRoot);
		mkdirSync(join(repoRoot, ".interlinked"), { recursive: true });
		const target = join(repoRoot, ".interlinked", "coverage-baseline.json");
		writeFileSync(
			target,
			JSON.stringify({ version: 1, files: { "src/a.ts": { lines_pct: 90 } } }, null, 2),
		);
		git(["add", "-f", ".interlinked/coverage-baseline.json"], repoRoot);
		git(["commit", "-q", "-m", "add baseline"], repoRoot);
		expect(
			evaluateBaselineIntegrityGate(
				makeEvent({
					cwd: repoRoot,
					tool_name: "Write",
					tool_input: {
						file_path: target,
						content: JSON.stringify(
							{ version: 1, files: { "src/a.ts": { lines_pct: 99 } } },
							null,
							2,
						),
					},
				}),
				"Write",
				[],
			),
		).toBeNull();
	});
});

// ============================================================
// evaluateEditOldStringGuard
// ============================================================

describe("evaluateEditOldStringGuard", () => {
	it("blocks an Edit whose old_string is not in the file", () => {
		const target = join(workspace, "f.ts");
		writeFileSync(target, "export const present = 1;\n");
		const d = evaluateEditOldStringGuard(
			"Edit",
			{ file_path: target, old_string: "this text is absent", new_string: "y" },
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/old_string not found/);
		expect(d?.warnings).toEqual(["w"]);
	});

	it("includes the near-miss span verbatim so the retry needs no re-read", () => {
		const target = join(workspace, "f.ts");
		writeFileSync(
			target,
			"export const value = computeSomething(alpha, beta);\n",
		);
		const d = evaluateEditOldStringGuard(
			"Edit",
			{
				file_path: target,
				old_string: "export const value = computeSomething(alpha, gamma);",
				new_string: "y",
			},
			[],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/Closest match — line 1/);
		expect(d?.reason).toContain("export const value = computeSomething(alpha, beta);");
	});

	it("blocks a doomed MultiEdit entry with per-entry accounting", () => {
		const target = join(workspace, "f.ts");
		writeFileSync(target, "const a = 1;\nconst b = 2;\n");
		const d = evaluateEditOldStringGuard(
			"MultiEdit",
			{
				file_path: target,
				edits: [
					{ old_string: "const a = 1;", new_string: "const a = 10;" },
					{ old_string: "const c = 3;", new_string: "const c = 30;" },
				],
			},
			[],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/entry 2 of 2/);
		expect(d?.reason).toMatch(/MultiEdit is atomic/);
	});

	it("pushes an apply_patch context-mismatch warning and does not block", () => {
		const target = join(workspace, "patched.ts");
		writeFileSync(target, "line one\nline two\n");
		const warnings: string[] = [];
		const d = evaluateEditOldStringGuard(
			"apply_patch",
			{
				command: [
					"*** Begin Patch",
					`*** Update File: ${target}`,
					" line NOPE",
					"-line two",
					"+line 2",
					"*** End Patch",
				].join("\n"),
			},
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("apply-patch-doom"))).toBe(true);
	});

	it("returns null when old_string IS present in the file", () => {
		const target = join(workspace, "f.ts");
		writeFileSync(target, "export const present = 1;\n");
		expect(
			evaluateEditOldStringGuard(
				"Edit",
				{ file_path: target, old_string: "export const present = 1;", new_string: "y" },
				[],
			),
		).toBeNull();
	});

	it("returns null when the file does not exist on disk", () => {
		expect(
			evaluateEditOldStringGuard(
				"Edit",
				{
					file_path: join(workspace, "missing.ts"),
					old_string: "anything",
					new_string: "y",
				},
				[],
			),
		).toBeNull();
	});

	it("returns null for a non-Edit tool", () => {
		expect(
			evaluateEditOldStringGuard(
				"Write",
				{ file_path: "f.ts", old_string: "x", new_string: "y" } as ToolInput,
				[],
			),
		).toBeNull();
	});

	it("returns null when old_string is missing", () => {
		expect(
			evaluateEditOldStringGuard("Edit", { file_path: "f.ts" }, []),
		).toBeNull();
	});

	it("swallows read errors (path is a directory) and returns null", () => {
		// readFileSync on a directory throws EISDIR; the guard catches it.
		mkdirSync(join(workspace, "adir"), { recursive: true });
		expect(
			evaluateEditOldStringGuard(
				"Edit",
				{
					file_path: join(workspace, "adir"),
					old_string: "x",
					new_string: "y",
				},
				[],
			),
		).toBeNull();
	});
});

// ============================================================
// evaluateWebFetchGuard
// ============================================================

describe("evaluateWebFetchGuard", () => {
	it("blocks a WebFetch to a file:// URL", () => {
		const d = evaluateWebFetchGuard(
			"WebFetch",
			{ url: "file:///etc/passwd" },
			["w"],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/file:\/\/ protocol/);
		expect(d?.warnings).toEqual(["w"]);
	});

	it("blocks under the web_fetch tool name alias", () => {
		expect(
			evaluateWebFetchGuard("web_fetch", { url: "file:///x" }, [])?.decision,
		).toBe("block");
	});

	it("blocks under the WebSearch tool name", () => {
		expect(
			evaluateWebFetchGuard("WebSearch", { url: "file:///x" }, [])?.decision,
		).toBe("block");
	});

	it("returns null for an http(s) URL", () => {
		expect(
			evaluateWebFetchGuard("WebFetch", { url: "https://example.com" }, []),
		).toBeNull();
	});

	it("returns null when no URL is present", () => {
		expect(evaluateWebFetchGuard("WebFetch", {}, [])).toBeNull();
	});

	it("returns null for an unrelated tool name", () => {
		expect(
			evaluateWebFetchGuard("Bash", { url: "file:///x" }, []),
		).toBeNull();
	});
});

// ============================================================
// evaluateManifestEditGuard
// ============================================================

describe("evaluateManifestEditGuard", () => {
	it("blocks a Write to package.json that adds a new unapproved dep", () => {
		const target = join(workspace, "package.json");
		writeFileSync(
			target,
			JSON.stringify({ name: "x", dependencies: { existing: "1.0.0" } }, null, 2),
		);
		const d = evaluateManifestEditGuard(
			makeEvent(),
			"Write",
			{
				file_path: target,
				content: JSON.stringify(
					{ name: "x", dependencies: { existing: "1.0.0", evil: "9.9.9" } },
					null,
					2,
				),
			},
			[],
		);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/evil/);
	});

	it("resolves a relative manifest path against event.cwd", () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ name: "x", dependencies: {} }, null, 2),
		);
		const d = evaluateManifestEditGuard(
			makeEvent(),
			"Write",
			{
				file_path: "package.json",
				content: JSON.stringify(
					{ name: "x", dependencies: { evil: "9.9.9" } },
					null,
					2,
				),
			},
			[],
		);
		expect(d?.decision).toBe("block");
	});

	it("returns null when the guard is disabled via env", () => {
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		const target = join(workspace, "package.json");
		writeFileSync(
			target,
			JSON.stringify({ name: "x", dependencies: {} }, null, 2),
		);
		expect(
			evaluateManifestEditGuard(
				makeEvent(),
				"Write",
				{
					file_path: target,
					content: JSON.stringify(
						{ name: "x", dependencies: { evil: "1.0.0" } },
						null,
						2,
					),
				},
				[],
			),
		).toBeNull();
	});

	it("returns null for a non-file-write tool", () => {
		expect(
			evaluateManifestEditGuard(makeEvent(), "Bash", { command: "npm i evil" }, []),
		).toBeNull();
	});

	it("returns null when no manifest path is present", () => {
		expect(
			evaluateManifestEditGuard(makeEvent(), "Write", { content: "{}" }, []),
		).toBeNull();
	});

	it("returns null when computeFullNewContent cannot resolve content (apply_patch-shaped)", () => {
		// No `content`, no old/new string, no edits array → computeFullNewContent
		// returns null and the manifest check is skipped.
		expect(
			evaluateManifestEditGuard(
				makeEvent(),
				"Write",
				{ file_path: join(workspace, "package.json") },
				[],
			),
		).toBeNull();
	});

	it("returns null for a normal manifest edit that adds no new dep", () => {
		const target = join(workspace, "package.json");
		writeFileSync(
			target,
			JSON.stringify({ name: "x", dependencies: { existing: "1.0.0" } }, null, 2),
		);
		expect(
			evaluateManifestEditGuard(
				makeEvent(),
				"Write",
				{
					file_path: target,
					content: JSON.stringify(
						{ name: "x", dependencies: { existing: "1.0.1" } },
						null,
						2,
					),
				},
				[],
			),
		).toBeNull();
	});

	it("falls back to process.cwd() when event.cwd is absent (absolute path still checked)", () => {
		const target = join(workspace, "package.json");
		writeFileSync(
			target,
			JSON.stringify({ name: "x", dependencies: {} }, null, 2),
		);
		const ev = makeEvent();
		delete ev.cwd;
		const d = evaluateManifestEditGuard(
			ev,
			"Write",
			{
				file_path: target,
				content: JSON.stringify(
					{ name: "x", dependencies: { evil: "9.9.9" } },
					null,
					2,
				),
			},
			[],
		);
		expect(d?.decision).toBe("block");
	});
});
