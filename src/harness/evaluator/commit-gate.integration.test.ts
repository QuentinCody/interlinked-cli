import { makeGuardRules } from "./__tests__/fixtures.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import { writeSuiteBaseline } from "../suite-baseline.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	COMMIT_RUN_TIMEOUT_MS,
	type CommitGateDeps,
	checkCommitGate,
	defaultGitChangedFiles,
	defaultResolveRepoRoot,
	parseGitCommit,
} from "./commit-gate.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-commit-gate-"));
	mkdirSync(join(root, "src"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		per_edit_coverage: { ...({ enabled: false, mode: "block", budget_ms: 25_000, languages: [] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>),
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			// Mirror the shipped default (rules/default-config.ts): both flags ON.
			// The opt-out tests override these to false explicitly (finding 2026-06:
			// the gate must HONOR them, so the fixture must state them).
			block_on_test_failure: true,
			block_on_crap: true,
			...overrides,
		},
	} satisfies GuardRulesConfig);
}

function commitEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

/** Write a real source file to disk so `isCappableFile` + readFile see content. */
function writeSource(relPath: string, content: string): void {
	const abs = join(root, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/** A GREEN coverage result with the given per-function rows for one file. */
function coverageResult(
	relPath: string,
	functions: PerFileCoverage["functions"],
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, { filePath: relPath, mtime: 0, functions });
	return { suiteMs: 1000, perFile, ok: true, testsPassed: true, ...overrides };
}

/** A per-file coverage result carrying PER-LINE data (the coverage.py shape). */
function pyResult(relPath: string, covered: number[], uncovered: number[]): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, {
		filePath: relPath,
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	});
	return { suiteMs: 1000, perFile, ok: true, testsPassed: true };
}

/** A stub runner that records whether/with-what-timeout it ran. */
function stubRunner(result: CoverageRunResult): {
	runner: CoverageRunner;
	ran: () => boolean;
	lastTimeout: () => number | undefined;
} {
	let called = false;
	let timeout: number | undefined;
	const runner: CoverageRunner = {
		run: async (opts) => {
			called = true;
			timeout = opts.timeoutMs;
			return result;
		},
	};
	return { runner, ran: () => called, lastTimeout: () => timeout };
}

/** Deps with a fixed runner, fixed changed-files list, and (optionally) a
 *  fixed cyclomatic analyzer. Default analyzer returns "no functions" so it can
 *  never block by accident; pass `entries` to drive CRAP / cyclomatic. */
function deps(
	runner: CoverageRunner,
	changed: string[] | null,
	entries: FunctionComplexityEntry[] | null = [],
): CommitGateDeps {
	return {
		runnerFor: () => runner,
		gitChangedFiles: () => changed,
		cyclomaticFor: () => () => entries,
		clock: () => 0,
		readFile: (abs: string): string | null => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
	};
}

/** Build a per-function complexity entry from an options object (avoids a
 *  same-typed positional param clump the harness flags). */
function fn(opts: {
	name: string;
	line: number;
	endLine: number;
	cyclomatic: number;
	language?: FunctionComplexityEntry["language"];
}): FunctionComplexityEntry {
	return {
		name: opts.name,
		line: opts.line,
		endLine: opts.endLine,
		cyclomatic: opts.cyclomatic,
		language: opts.language ?? "js_ts",
	};
}

const JS_SRC = "export function f() {\n  return 1;\n}\n";

// ---------------------------------------------------------------------------
// parseGitCommit — re-export smoke test (full coverage lives in
// commit-parse.test.ts; this only proves the gate module re-exports it).
// ---------------------------------------------------------------------------

describe("parseGitCommit (re-export)", () => {
	it("detects a commit and flags --no-verify through the gate-module re-export", () => {
		expect(parseGitCommit('git commit -m "fix"')).toEqual({ isCommit: true, noVerify: false });
		expect(parseGitCommit("git commit -m x --no-verify")?.noVerify).toBe(true);
		expect(parseGitCommit("git status")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Parser → executor: the gate must evaluate the repo the commit actually runs
// in, honoring a `cd <dir>` / `git -C <dir>` redirect (finding 4). Without this,
// a monorepo `cd packages/x && git commit` gated the PARENT cwd — the wrong repo.
// ---------------------------------------------------------------------------

/** Deps that CAPTURE the projectRoot the gate hands to git-diff and the runner. */
function capturingRootDeps(coverage: CoverageRunResult): {
	deps: CommitGateDeps;
	gitRoot: () => string | undefined;
	suiteRoot: () => string | undefined;
} {
	let gitRoot: string | undefined;
	let suiteRoot: string | undefined;
	const deps: CommitGateDeps = {
		runnerFor: () => ({
			run: async (opts) => {
				suiteRoot = opts.projectRoot;
				return coverage;
			},
		}),
		gitChangedFiles: (projectRoot) => {
			gitRoot = projectRoot;
			return ["src/m.ts"]; // diff paths are relative to the (sub)repo root
		},
		cyclomaticFor: () => () => [],
		clock: () => 0,
		readFile: (abs) => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
	};
	return { deps, gitRoot: () => gitRoot, suiteRoot: () => suiteRoot };
}

describe("checkCommitGate — honors a cd / git -C redirect (finding 4)", () => {
	it("runs git-diff AND the suite in the redirected subrepo, not the parent cwd", async () => {
		// A nested repo at packages/api with one changed source file on disk.
		writeSource("packages/api/src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot, suiteRoot } = capturingRootDeps(green);
		// event.cwd is the PARENT (root); the command cd's into packages/api.
		const decision = await checkCommitGate(
			commitEvent("cd packages/api && git commit -m x"),
			rules(),
			capDeps,
		);
		const expected = join(root, "packages/api");
		expect(gitRoot()).toBe(expected);
		expect(suiteRoot()).toBe(expected);
		expect(decision).toBeNull(); // green subrepo → allow
	});

	it("equally honors `git -C <dir> commit`", async () => {
		writeSource("packages/api/src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot } = capturingRootDeps(green);
		await checkCommitGate(commitEvent("git -C packages/api commit -m x"), rules(), capDeps);
		expect(gitRoot()).toBe(join(root, "packages/api"));
	});

	it("falls back to event.cwd when the command carries no redirect", async () => {
		writeSource("src/m.ts", JS_SRC);
		const green = coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
		]);
		const { deps: capDeps, gitRoot } = capturingRootDeps(green);
		await checkCommitGate(commitEvent("git commit -m x"), rules(), capDeps);
		expect(gitRoot()).toBe(root);
	});
});

// ---------------------------------------------------------------------------
// Staged-snapshot evaluation (finding 3): a plain commit must be judged against
// the INDEX (the would-be commit), not the dirty working tree. The materializer
// is stubbed here (its real git behavior is covered in staged-snapshot.test.ts);
// these tests pin the GATE's routing: which root the suite runs in per mode.
// ---------------------------------------------------------------------------

/** Deps that record the suite root + the `stagedOnly` flag, with an injectable
 *  index materializer (null ⇒ the worktree fallback). */
function capturingSuiteDeps(materialize: CommitGateDeps["materializeIndexSnapshot"]): {
	deps: CommitGateDeps;
	suiteRoot: () => string | undefined;
	stagedOnly: () => boolean | undefined;
} {
	let suiteRoot: string | undefined;
	let stagedOnly: boolean | undefined;
	const deps: CommitGateDeps = {
		runnerFor: () => ({
			run: async (opts) => {
				suiteRoot = opts.projectRoot;
				return coverageResult("src/m.ts", [
					{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 },
				]);
			},
		}),
		gitChangedFiles: (_projectRoot, staged) => {
			stagedOnly = staged;
			return ["src/m.ts"];
		},
		cyclomaticFor: () => () => [],
		clock: () => 0,
		readFile: (abs) => {
			try {
				return readFileSync(abs, "utf-8");
			} catch {
				return null;
			}
		},
		...(materialize ? { materializeIndexSnapshot: materialize } : {}),
	};
	return { deps, suiteRoot: () => suiteRoot, stagedOnly: () => stagedOnly };
}

describe("checkCommitGate — staged-snapshot evaluation (finding 3)", () => {
	it("runs the suite in the materialized index snapshot for a plain commit", async () => {
		const snapRoot = join(root, ".interlinked", ".commit-snapshot-fixture");
		mkdirSync(join(snapRoot, "src"), { recursive: true });
		writeFileSync(join(snapRoot, "src/m.ts"), JS_SRC, "utf-8"); // staged content
		let cleaned = false;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps(() => ({
			root: snapRoot,
			cleanup: () => {
				cleaned = true;
			},
		}));
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(stagedOnly()).toBe(true); // plain commit → staged-only changed files
		expect(suiteRoot()).toBe(snapRoot); // evaluated the INDEX snapshot, not the worktree
		expect(cleaned).toBe(true); // snapshot cleaned up afterward
		expect(decision).toBeNull(); // green snapshot → allow
	});

	it("materializes the -a snapshot (index + tracked worktree, no untracked), not the raw worktree", async () => {
		writeSource("src/m.ts", JS_SRC);
		const snapRoot = join(root, ".interlinked", ".commit-snapshot-a");
		mkdirSync(join(snapRoot, "src"), { recursive: true });
		writeFileSync(join(snapRoot, "src/m.ts"), JS_SRC, "utf-8");
		let includeTracked: boolean | undefined;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps((_pr, inc) => {
			includeTracked = inc;
			return { root: snapRoot, cleanup: () => {} };
		});
		await checkCommitGate(commitEvent("git commit -am x"), rules(), deps);
		expect(stagedOnly()).toBe(false); // -a → working-tree tracked changed-files query
		expect(suiteRoot()).toBe(snapRoot); // the -a snapshot, NOT the raw worktree (no untracked)
		expect(includeTracked).toBe(true); // materialized WITH tracked worktree mods
	});

	it("falls back to the working tree when materialization fails (never worse than before)", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, suiteRoot } = capturingSuiteDeps(() => null); // materialization unavailable
		await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(suiteRoot()).toBe(root); // fell back to the worktree
	});

	// NARROW constructed commits evaluate the INDEX + only the named paths — the
	// actual snapshot the command produces. The raw worktree let an unrelated
	// UNTRACKED test cover the staged source, approving a commit whose real tree
	// stays uncovered (finding 2026-06).
	it("a NARROW `git add <path> && git commit` evaluates the index+path snapshot, not the worktree", async () => {
		const snapRoot = join(root, ".interlinked", ".commit-snapshot-narrow");
		mkdirSync(join(snapRoot, "src"), { recursive: true });
		writeFileSync(join(snapRoot, "src/m.ts"), JS_SRC, "utf-8"); // index + named path
		let constructedArg: string[] | undefined;
		let includeTracked: boolean | undefined;
		const { deps, suiteRoot } = capturingSuiteDeps((_pr, inc, constructed) => {
			includeTracked = inc;
			constructedArg = constructed;
			return { root: snapRoot, cleanup: () => {} };
		});
		const decision = await checkCommitGate(
			commitEvent('git add src/m.ts && git commit -m "x"'),
			rules(),
			deps,
		);
		expect(constructedArg).toEqual(["src/m.ts"]); // snapshot = index + ONLY this path
		expect(includeTracked).toBe(false); // never the -a tracked-worktree overlay
		expect(suiteRoot()).toBe(snapRoot); // the suite ran in the SNAPSHOT
		expect(decision).toBeNull();
	});

	it("a BROAD constructed commit (`git add -A && git commit`) keeps the raw worktree", async () => {
		writeSource("src/m.ts", JS_SRC);
		const materialize = vi.fn(() => null);
		const { deps, suiteRoot } = capturingSuiteDeps(materialize);
		await checkCommitGate(commitEvent('git add -A && git commit -m "x"'), rules(), deps);
		// A broad add stages untracked files too — the worktree IS the snapshot.
		expect(suiteRoot()).toBe(root);
		expect(materialize).not.toHaveBeenCalled();
	});

	it("falls back to the worktree when the NARROW snapshot cannot materialize", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, suiteRoot } = capturingSuiteDeps(() => null);
		await checkCommitGate(commitEvent('git add src/m.ts && git commit -m "x"'), rules(), deps);
		expect(suiteRoot()).toBe(root);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — gating / no-op
// ---------------------------------------------------------------------------

describe("checkCommitGate — gating", () => {
	it("is a pure no-op when per_edit_coverage is disabled (runner + git never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const gitDiff = vi.fn(() => ["src/a.ts"]);
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules({ enabled: false }), {
			runnerFor: () => runner,
			gitChangedFiles: gitDiff,
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(gitDiff).not.toHaveBeenCalled();
	});

	it("is a no-op when per_edit_coverage config is entirely absent", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			({ ...makeGuardRules(), } satisfies GuardRulesConfig),
			deps(runner, ["src/a.ts"]),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for `git status` (not a commit; runner + git never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const gitDiff = vi.fn(() => ["src/a.ts"]);
		const decision = await checkCommitGate(commitEvent("git status"), rules(), {
			runnerFor: () => runner,
			gitChangedFiles: gitDiff,
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(gitDiff).not.toHaveBeenCalled();
	});

	it("is a no-op for `git log` (not a commit)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent("git log --oneline -n 5"),
			rules(),
			deps(runner, ["src/a.ts"]),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("allows (no-op) when only NON-CODE files changed (docs / config)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, ["README.md", "docs/notes.md", "package.json"]),
		);
		expect(decision).toBeNull();
		// No gated-language file at all → the suite is never run.
		expect(ran()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — test-only commits run the red-bar suite (finding 2026-06:
// the non-cappable skip left suiteLanguages empty, so a FAILING test edit
// could be committed straight through the default-on gate)
// ---------------------------------------------------------------------------

describe("checkCommitGate — test-only commits", () => {
	it("BLOCKS a test-only commit whose suite comes back RED", async () => {
		writeSource("src/a.test.ts", "it('x', () => { throw new Error('red'); });\n");
		const { runner, ran } = stubRunner(
			coverageResult("src/other.ts", [], { testsPassed: false, failingTests: ["x"] }),
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, ["src/a.test.ts"]),
		);
		expect(ran()).toBe(true); // pre-fix: the suite never ran for a test-only commit
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
	});

	it("ALLOWS a test-only commit whose suite stays GREEN (red-bar only, nothing scanned)", async () => {
		writeSource("src/a.test.ts", "it('x', () => {});\n");
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, ["src/a.test.ts"]),
		);
		expect(ran()).toBe(true);
		expect(decision).toBeNull();
	});

	it("spends NO suite on a test-only commit when block_on_test_failure is off (no decidable axis)", async () => {
		writeSource("src/a.test.ts", "it('x', () => {});\n");
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ block_on_test_failure: false }),
			deps(runner, ["src/a.test.ts"]),
		);
		expect(ran()).toBe(false);
		expect(decision).toBeNull();
	});

	it("a declaration-only .d.ts commit spends no suite (no runtime behavior to observe)", async () => {
		writeSource("src/types.d.ts", "export declare const x: number;\n");
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, ["src/types.d.ts"]),
		);
		expect(ran()).toBe(false);
		expect(decision).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — block decisions
// ---------------------------------------------------------------------------

describe("checkCommitGate — block decisions", () => {
	it("BLOCKS when the full suite is RED, naming the failing test", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			{ testsPassed: false, failingTests: ["adds two numbers", "handles empty"] },
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/adds two numbers/);
		expect(decision?.rule_id).toBe("commit-gate");
	});

	it("BLOCKS when a changed file has an uncovered executable line (per-function), naming it", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/`f`/);
	});

	it("BLOCKS when a changed function's CRAP is over threshold, naming it", async () => {
		writeSource("src/a.ts", JS_SRC);
		// cyclomatic 10 @ 20% coverage → CRAP ≈ 61 (≥30). Partially covered so the
		// uncovered-line check passes and CRAP is what fires.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "big", line: 1, endLine: 3, cyclomatic: 10 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
	});

	it("BLOCKS when a changed function's cyclomatic is over the cap (>25)", async () => {
		writeSource("src/a.ts", JS_SRC);
		// Fully covered (coverage gate + CRAP pass) but cyclomatic 30 > 25 → block.
		const result = coverageResult("src/a.ts", [
			{ name: "branchy", line: 1, endLine: 3, hits: 9, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "branchy", line: 1, endLine: 3, cyclomatic: 30 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/cyclomatic complexity 30/);
		expect(decision?.reason).toMatch(/`branchy`/);
	});

	it("RED bar wins over coverage / CRAP when both would fire", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "big", line: 1, endLine: 3, cyclomatic: 30 })]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — allow decisions
// ---------------------------------------------------------------------------

describe("checkCommitGate — allow decisions", () => {
	it("ALLOWS a clean tree: tests pass, covered, under CRAP + cyclomatic", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision).toBeNull();
	});

	it("runs the suite with the generous commit timeout (no per-edit cap)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const stub = stubRunner(result);
		await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stub.runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(stub.ran()).toBe(true);
		expect(stub.lastTimeout()).toBe(COMMIT_RUN_TIMEOUT_MS);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — fail-open
// ---------------------------------------------------------------------------

describe("checkCommitGate — fail-open", () => {
	it("fail-open ALLOW (loud-degrade) when the runner is unavailable (ok:false)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(failing, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("(boom)"));
		errSpy.mockRestore();
	});

	it("fail-open ALLOW when the runner factory returns null (no runner for language)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), {
			runnerFor: () => null,
			gitChangedFiles: () => ["src/a.ts"],
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		});
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("(no coverage runner for ts)"));
		errSpy.mockRestore();
	});

	it("fail-open ALLOW when git diff is unavailable (returns null)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(runner, null),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("(git diff unavailable"));
		errSpy.mockRestore();
	});

	it("never throws — a throwing git-diff fn is contained (loud-degrade allow)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { runner } = stubRunner(coverageResult("src/a.ts", []));
		const throwingDeps: CommitGateDeps = {
			runnerFor: () => runner,
			gitChangedFiles: () => {
				throw new Error("git exploded");
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), throwingDeps);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("(git exploded)"));
		errSpy.mockRestore();
	});

	it("CRAP / cyclomatic checks fail-open when the analyzer is unavailable (null), coverage still enforced", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		writeSource("src/a.ts", JS_SRC);
		// Covered function ⇒ coverage allows; analyzer null ⇒ no CRAP / cyclomatic block.
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], null),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("(no cyclomatic analysis for src/a.ts — CRAP / cyclomatic checks skipped)"),
		);
		errSpy.mockRestore();
	});

	it("stringifies a thrown non-Error value instead of using its (absent) .message", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const throwingDeps: CommitGateDeps = {
			runnerFor: () => stubRunner(coverageResult("src/a.ts", [])).runner,
			gitChangedFiles: () => {
				// Intentionally throwing a non-Error to exercise the String(err) fallback.
				throw "git exploded (not an Error)";
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: () => JS_SRC,
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), throwingDeps);
		expect(decision).toBeNull();
		const written = errSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("git exploded (not an Error)");
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — no-op edge inputs (falsy command, missing cwd)
// ---------------------------------------------------------------------------

describe("checkCommitGate — falsy/missing event fields", () => {
	it("treats a missing tool_input.command as empty (not a commit; no-op)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			{
				hook_event: "PreToolUse",
				session_id: "sess-no-command",
				agent_source: "claude",
				tool_name: "Bash",
				tool_input: {},
				timestamp: "2026-06-07T00:00:00.000Z",
				cwd: root,
			},
			rules(),
			deps(runner, ["src/a.ts"]),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("falls back to process.cwd() for commandCwd/projectRoot when the event carries no cwd", async () => {
		const capturedRoots: (string | undefined)[] = [];
		const { runner } = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const customDeps: CommitGateDeps = {
			runnerFor: () => runner,
			gitChangedFiles: (pr) => {
				capturedRoots.push(pr);
				return ["src/a.ts"];
			},
			cyclomaticFor: () => () => [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })],
			clock: () => 0,
			readFile: () => JS_SRC,
		};
		const decision = await checkCommitGate(
			{
				hook_event: "PreToolUse",
				session_id: "sess-no-cwd",
				agent_source: "claude",
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "x"' },
				timestamp: "2026-06-07T00:00:00.000Z",
				// cwd intentionally omitted
			},
			rules(),
			customDeps,
		);
		expect(capturedRoots).toEqual([process.cwd()]);
		expect(decision).toBeNull();
	});

	it("falls back to Date.now() for the discharge timestamp when the event's timestamp is empty", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const discharges: Array<{ file: string; sessionId: string; ts: string }> = [];
		const customDeps: CommitGateDeps = {
			runnerFor: () => stubRunner(result).runner,
			gitChangedFiles: () => ["src/a.ts"],
			cyclomaticFor: () => () => [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
			recordDischarge: (_root, file, sessionId, ts) => {
				discharges.push({ file, sessionId, ts });
			},
		};
		const decision = await checkCommitGate(
			{
				hook_event: "PreToolUse",
				session_id: "sess-no-ts",
				agent_source: "claude",
				tool_name: "Bash",
				tool_input: { command: 'git commit -m "x"' },
				timestamp: "",
				cwd: root,
			},
			rules(),
			customDeps,
		);
		expect(decision).toBeNull();
		expect(discharges).toHaveLength(1);
		expect(discharges[0]?.sessionId).toBe("sess-no-ts");
		// No eventTs was spread onto the context, so runSuiteAndScan fell back to
		// `new Date().toISOString()` — still a real ISO timestamp, not "" or undefined.
		expect(discharges[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — --no-verify note
// ---------------------------------------------------------------------------

describe("checkCommitGate — --no-verify note", () => {
	it("warns that --no-verify bypasses git hooks while still allowing a clean tree", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x" --no-verify'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "f", line: 1, endLine: 3, cyclomatic: 3 })]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.some((w: string) => /--no-verify/.test(w))).toBe(true);
	});

	it("attaches the --no-verify note to a block decision too", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -am "x" --no-verify'),
			rules(),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings?.some((w: string) => /--no-verify/.test(w))).toBe(true);
	});

	const NO_VERIFY_WARNING =
		"[interlinked:commit-gate] NOTE: `--no-verify` was passed — it bypasses git's own " +
		"commit hooks. The interlinked commit-time quality gate still evaluated this commit.";

	it("attaches the --no-verify note even when nothing gated changed at all (no-decidable-axis, no source)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x" --no-verify'),
			rules(),
			deps(runner, ["README.md"]),
		);
		expect(ran()).toBe(false); // no gated-language file → suite never spent
		expect(decision).toEqual({ decision: "allow", warnings: [NO_VERIFY_WARNING] });
	});

	it("attaches the --no-verify note on the block_on_test_failure-off no-decidable-axis path too", async () => {
		writeSource("src/a.test.ts", "it('x', () => {});\n");
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x" --no-verify'),
			rules({ block_on_test_failure: false }),
			deps(runner, ["src/a.test.ts"]),
		);
		expect(ran()).toBe(false);
		expect(decision).toEqual({ decision: "allow", warnings: [NO_VERIFY_WARNING] });
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — Python per-line path
// ---------------------------------------------------------------------------

describe("checkCommitGate — Python per-line path (coverage.py shape)", () => {
	const PY_SRC = "def added():\n    x = 1\n    y = 2\n    return x + y\n";

	it("BLOCKS when an added .py line is uncovered (missing_lines), naming the line", async () => {
		writeSource("src/a.py", PY_SRC);
		const result = pyResult("src/a.py", [1, 2, 4], [3]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner, ["src/a.py"], [
				fn({ name: "added", line: 1, endLine: 4, cyclomatic: 1, language: "python" }),
			]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/line 3/);
		expect(decision?.reason).toMatch(/uncovered/i);
	});

	it("ALLOWS when every executable .py line is covered", async () => {
		writeSource("src/a.py", PY_SRC);
		const result = pyResult("src/a.py", [1, 2, 3, 4], []);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner, ["src/a.py"], [
				fn({ name: "added", line: 1, endLine: 4, cyclomatic: 2, language: "python" }),
			]),
		);
		expect(decision).toBeNull();
	});

	it("evaluates the WORKTREE for a constructed-content commit (`git add -A && git commit`)", async () => {
		// At PreToolUse the `git add -A` has NOT run, so the index is stale. The gate
		// must evaluate the worktree (the inclusive superset) — never the empty index
		// — so content the command will stage is not left unevaluated (finding 4).
		writeSource("src/m.ts", JS_SRC);
		let materializeCalled = false;
		const { deps, suiteRoot, stagedOnly } = capturingSuiteDeps(() => {
			materializeCalled = true;
			return { root: join(root, ".interlinked", ".snap"), cleanup: () => {} };
		});
		await checkCommitGate(commitEvent("git add -A && git commit -m x"), rules(), deps);
		expect(suiteRoot()).toBe(root); // the worktree, not a (stale-index) snapshot
		expect(materializeCalled).toBe(false); // worktree mode never materializes
		expect(stagedOnly()).toBe(false); // broad changed-files query, not staged-only
	});

	// ZERO-FALSE-POSITIVE CONTRACT (finding 6). A NARROW `git add <path> && git commit`
	// stages only that path; an unrelated dirty worktree file must NOT be evaluated
	// (the round-3 worktree-everything approach blocked on it). The stub is
	// staged-aware: nothing is PRE-staged here, so the includesIndex union (the
	// staged-bypass fix) adds nothing — b.ts is merely worktree-dirty.
	it("a narrow `git add <path> && git commit` evaluates ONLY that path, not unrelated dirty files", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/b.ts", JS_SRC); // unrelated dirty file — must be ignored
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			// BOTH dirty in the worktree, NOTHING pre-staged (stagedOnly → []).
			gitChangedFiles: (_root, stagedOnly) => (stagedOnly ? [] : ["src/a.ts", "src/b.ts"]),
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git add src/a.ts && git commit -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true); // staged path evaluated
		expect(readPaths.some((p) => p.endsWith("src/b.ts"))).toBe(false); // unrelated file skipped
	});

	// STAGED-BYPASS CONTRACT (finding 2026-06). `git add p && git commit` commits the
	// WHOLE index — pre-existing staged files included. Filtering to the constructed
	// paths alone let an already-staged file's violations skip evaluation entirely.
	it("a `git add <path> && git commit` ALSO evaluates pre-existing STAGED files (includesIndex union)", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/staged.ts", JS_SRC); // staged BEFORE this command ran
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			// staged.ts is in the index; b-style dirty files absent here for focus.
			gitChangedFiles: (_root, stagedOnly) =>
				stagedOnly ? ["src/staged.ts"] : ["src/a.ts", "src/staged.ts"],
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git add src/a.ts && git commit -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true); // the added path
		expect(readPaths.some((p) => p.endsWith("src/staged.ts"))).toBe(true); // the pre-staged file too
	});

	// GIT --only SEMANTICS (finding 2026-06). `git commit <path>` (no --include)
	// commits ONLY the named path — neither the pre-staged index nor a preceding
	// add's other paths. Evaluating them would false-block on content this commit
	// does not capture.
	it("a pathspec commit WITHOUT --include does not evaluate pre-staged files (git --only default)", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/staged.ts", JS_SRC);
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (_root, stagedOnly) =>
				stagedOnly ? ["src/staged.ts"] : ["src/a.ts", "src/staged.ts"],
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git commit src/a.ts -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true);
		expect(readPaths.some((p) => p.endsWith("src/staged.ts"))).toBe(false); // --only: not committed
	});

	it("a pathspec commit WITH --include evaluates the named path AND the staged set", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/staged.ts", JS_SRC);
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (_root, stagedOnly) =>
				stagedOnly ? ["src/staged.ts"] : ["src/a.ts", "src/staged.ts"],
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git commit --include src/a.ts -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true);
		expect(readPaths.some((p) => p.endsWith("src/staged.ts"))).toBe(true); // --include captures the index
	});

	it("falls back to the FULL changed set when the staged set cannot be read (fail toward MORE)", async () => {
		writeSource("src/a.ts", JS_SRC);
		writeSource("src/b.ts", JS_SRC);
		const readPaths: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			// The staged-only query FAILS (null) while the broad query works: the
			// includesIndex union must widen to everything rather than silently narrow.
			gitChangedFiles: (_root, stagedOnly) => (stagedOnly ? null : ["src/a.ts", "src/b.ts"]),
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				readPaths.push(abs);
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		await checkCommitGate(commitEvent("git add src/a.ts && git commit -m x"), rules(), deps);
		expect(readPaths.some((p) => p.endsWith("src/a.ts"))).toBe(true);
		expect(readPaths.some((p) => p.endsWith("src/b.ts"))).toBe(true); // widened, not narrowed
	});

	// MISSING-COVERAGE CONTRACT (finding 4). A changed source absent from the coverage
	// report after a full run was silently skipped — so a brand-new untested file passed.
	it("BLOCKS a changed source absent from the coverage report but with executable code", async () => {
		writeSource("src/new.ts", JS_SRC);
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				// The report does NOT include src/new.ts — no test loaded it.
				run: async () => coverageResult("src/other.ts", []),
			}),
			gitChangedFiles: () => ["src/new.ts"],
			cyclomaticFor: () => () => [{ name: "f", line: 1, endLine: 3, cyclomatic: 2, language: "js_ts" }],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/untested|absent from the coverage report/i);
	});

	it("does NOT block a changed source absent from the report that has NO executable code (type-only)", async () => {
		writeSource("src/types.ts", "export interface T { a: number }\n");
		const deps: CommitGateDeps = {
			runnerFor: () => ({ run: async () => coverageResult("src/other.ts", []) }),
			gitChangedFiles: () => ["src/types.ts"],
			cyclomaticFor: () => () => [], // no functions → nothing to cover
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		expect(await checkCommitGate(commitEvent("git commit -m x"), rules(), deps)).toBeNull();
	});

	// FUNCTION-LESS EXECUTABLE MODULES (finding 2026-06). The type-only exemption was
	// "the analyzer found no functions" — letting a module of top-level statements
	// (console.log, an initializing call) pass untested AND discharging its obligation.
	it("BLOCKS a function-less module with executable top-level statements absent from coverage", async () => {
		writeSource("src/boot.ts", 'console.log("side effect");\nstartServer();\n');
		const deps: CommitGateDeps = {
			runnerFor: () => ({ run: async () => coverageResult("src/other.ts", []) }),
			gitChangedFiles: () => ["src/boot.ts"],
			cyclomaticFor: () => () => [], // analyzer sees NO functions — the old exemption
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		const decision = await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/untested|absent from the coverage report/i);
	});
});

describe("checkCommitGate — changed-file query flags by mode (findings 2026-06)", () => {
	type QueryFlags = [boolean | undefined, boolean | undefined];

	function flagCapturingDeps(): { deps: CommitGateDeps; calls: () => QueryFlags[] } {
		const calls: QueryFlags[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (_root, stagedOnly, includeUntracked) => {
				calls.push([stagedOnly, includeUntracked]);
				return ["src/m.ts"];
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
		};
		return { deps, calls: () => calls };
	}

	it("a CONSTRUCTED commit (`git add … && git commit`) requests UNTRACKED files too", async () => {
		// The add stages new files at run time; `git diff` never lists them — without
		// includeUntracked a brand-new uncovered source bypassed the gate entirely.
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git add -A && git commit -m x"), rules(), deps);
		expect(calls()).toEqual([[false, true]]); // broad query + untracked
	});

	it("`-a` requests tracked-only (NO untracked — `-a` never stages them)", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git commit -am x"), rules(), deps);
		expect(calls()).toEqual([[false, false]]);
	});

	it("a plain commit requests staged-only", async () => {
		writeSource("src/m.ts", JS_SRC);
		const { deps, calls } = flagCapturingDeps();
		await checkCommitGate(commitEvent("git commit -m x"), rules(), deps);
		expect(calls()).toEqual([[true, false]]);
	});

	it("anchors evaluation at the git TOPLEVEL when the commit runs from a subdirectory", async () => {
		// `cd src && git commit -a`: git emits toplevel-relative paths (src/a.ts), so
		// resolving them against /repo/src would double-prefix and skip every source.
		writeSource("src/m.ts", JS_SRC);
		mkdirSync(join(root, "sub"), { recursive: true });
		const rootsQueried: string[] = [];
		const deps: CommitGateDeps = {
			runnerFor: () => ({
				run: async () =>
					coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 3, statement_pct: 100 }]),
			}),
			gitChangedFiles: (queriedRoot) => {
				rootsQueried.push(queriedRoot);
				return ["src/m.ts"];
			},
			cyclomaticFor: () => () => [],
			clock: () => 0,
			readFile: (abs) => {
				try {
					return readFileSync(abs, "utf-8");
				} catch {
					return null;
				}
			},
			resolveRepoRoot: () => root, // the repo toplevel, NOT root/sub
		};
		await checkCommitGate(commitEvent("cd sub && git commit -am x"), rules(), deps);
		expect(rootsQueried).toEqual([root]); // anchored at the toplevel
	});
});

describe("checkCommitGate — DEFAULT_DEPS wiring (production dependencies, no injected stubs)", () => {
	let repo: string;

	function git(...args: string[]): void {
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	}

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "commit-gate-default-deps-")));
		git("init", "-q");
		git("config", "user.email", "t@t.test");
		git("config", "user.name", "t");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n", "utf-8");
		git("add", "src/a.ts");
		git("commit", "-qm", "init");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("is a real no-op through the production readFile wiring for a staged declaration-only file (no deps injected)", async () => {
		writeFileSync(join(repo, "src/types.d.ts"), "export declare const x: number;\n", "utf-8");
		git("add", "src/types.d.ts");
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-default-deps",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "x"' },
			timestamp: "2026-06-07T00:00:00.000Z",
			cwd: repo,
		};
		// No third argument — this exercises DEFAULT_DEPS end to end: the real
		// defaultGitChangedFiles/defaultResolveRepoRoot (git plumbing), the real
		// materializeIndexSnapshot, and — the line this test targets — the real
		// readFile closure (existsSync ? readFileSync : null / try-catch). A
		// declaration-only staged file means suiteLanguages/sources both stay
		// empty, so the gate returns before ever invoking the real coverage
		// runner or cyclomatic analyzer (never spawns a test suite).
		const decision = await checkCommitGate(event, rules());
		expect(decision).toBeNull();
	});
});

describe("defaultGitChangedFiles / defaultResolveRepoRoot — real git (findings 2026-06)", () => {
	let repo: string;

	function git(...args: string[]): void {
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	}

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "commit-gate-git-")));
		git("init", "-q");
		git("config", "user.email", "t@t.test");
		git("config", "user.name", "t");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n", "utf-8");
		git("add", "src/a.ts");
		git("commit", "-qm", "init");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("includeUntracked=true lists a brand-new file; false (the -a path) does not", () => {
		writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n", "utf-8"); // tracked mod
		writeFileSync(join(repo, "src/new.ts"), "export const n = 1;\n", "utf-8"); // untracked
		expect(defaultGitChangedFiles(repo, false, true)).toEqual(
			expect.arrayContaining(["src/a.ts", "src/new.ts"]),
		);
		expect(defaultGitChangedFiles(repo, false, false)).not.toContain("src/new.ts");
		expect(defaultGitChangedFiles(repo, true)).toEqual([]); // staged-only: nothing staged
	});

	it("resolves a subdirectory to the repository toplevel (and non-repos to null)", () => {
		expect(defaultResolveRepoRoot(join(repo, "src"))).toBe(repo);
		const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(defaultResolveRepoRoot(notRepo)).toBeNull();
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});
});

// DELETE-ONLY COMMITS (finding 2026-06). A commit whose only gated change is a
// DELETION has nothing to scan, but the deletion can break every importer — the
// suite must still run (red-bar), instead of `sources.length === 0` skipping
// enforcement entirely.
describe("checkCommitGate — delete-only commits still run the suite", () => {
	it("BLOCKS a delete-only commit whose suite comes back RED", async () => {
		// src/gone.ts is reported changed but does NOT exist on disk → a deletion.
		const red = coverageResult("src/other.ts", [], {
			testsPassed: false,
			failingTests: ["imports gone.ts"],
		});
		const { runner, ran } = stubRunner(red);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "drop module"'),
			rules(),
			deps(runner, ["src/gone.ts"]),
		);
		expect(ran()).toBe(true); // the suite RAN for the deletion's language
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
	});

	it("ALLOWS a delete-only commit whose suite is GREEN", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "drop module"'),
			rules(),
			deps(runner, ["src/gone.ts"]),
		);
		expect(ran()).toBe(true);
		expect(decision).toBeNull();
	});

	it("does NOT run the suite when only a non-gated file is deleted", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "drop docs"'),
			rules(),
			deps(runner, ["README.md"]),
		);
		expect(ran()).toBe(false); // nothing gated changed or was deleted
		expect(decision).toBeNull();
	});

	it("a mixed edit+delete commit scans the edit AND runs the suite once", async () => {
		writeSource("src/kept.ts", "export function f() {\n\treturn 1;\n}\n");
		const { runner, ran } = stubRunner(
			coverageResult("src/kept.ts", [{ name: "f", line: 1, endLine: 3, hits: 2, statement_pct: 100 }]),
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "edit + delete"'),
			rules(),
			deps(runner, ["src/kept.ts", "src/gone.ts"]),
		);
		expect(ran()).toBe(true);
		expect(decision).toBeNull(); // kept.ts covered, suite green → clean
	});

	it("a deleted PYTHON source runs the python suite even with no scannable sources", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/other.py", []));
		const decision = await checkCommitGate(
			commitEvent('git commit -m "drop py module"'),
			rules({ languages: ["js", "ts", "python"] }),
			deps(runner, ["pkg/gone.py"]),
		);
		expect(ran()).toBe(true);
		expect(decision).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — constructed pathspecs are rebased onto the repo toplevel,
// and file-mediated pathspecs are broad (findings 2026-06, round 3)
// ---------------------------------------------------------------------------

describe("checkCommitGate — command-cwd pathspec rebase + file-mediated pathspecs", () => {
	/** Changed-files stub modeling the PreToolUse reality for `git add … && git
	 *  commit`: nothing is staged YET (the add runs later), the worktree holds the
	 *  changes. The toplevel-relative frame is what real git emits. */
	function stagedAware(worktree: string[]): CommitGateDeps["gitChangedFiles"] {
		return (_root, stagedOnly) => (stagedOnly ? [] : worktree);
	}

	it("`cd <subdir> && git add <path> && git commit` rebases the spec — the staged file cannot bypass", async () => {
		writeSource("packages/app/src/a.ts", JS_SRC);
		// Uncovered → the ONLY way this blocks is the rebased path being evaluated.
		const result = coverageResult("packages/app/src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, null),
			gitChangedFiles: stagedAware(["packages/app/src/a.ts"]),
			resolveRepoRoot: () => root, // the command cwd is packages/app; the toplevel is root
		};
		const decision = await checkCommitGate(
			commitEvent('cd packages/app && git add src/a.ts && git commit -m "x"'),
			rules(),
			d,
		);
		// Pre-fix: the raw spec `src/a.ts` matched no toplevel-relative changed path,
		// nothing was staged yet, and the commit sailed through unevaluated.
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
	});

	it("rebasing keeps the narrow filter narrow: an unrelated dirty file at the toplevel does not block", async () => {
		writeSource("packages/app/src/a.ts", JS_SRC);
		writeSource("src/unrelated.ts", JS_SRC); // dirty at the toplevel, NOT committed
		// Only the committed file appears in the report, fully covered. If the
		// unrelated file were evaluated, its missing report entry would block.
		const result = coverageResult("packages/app/src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, null),
			gitChangedFiles: stagedAware(["packages/app/src/a.ts", "src/unrelated.ts"]),
			resolveRepoRoot: () => root,
		};
		const decision = await checkCommitGate(
			commitEvent('cd packages/app && git commit src/a.ts -m "x"'),
			rules(),
			d,
		);
		expect(decision).toBeNull();
	});

	it("`git commit .` at the toplevel degrades to BROAD (evaluates every changed file)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, null),
			gitChangedFiles: stagedAware(["src/a.ts"]),
			resolveRepoRoot: () => root,
		};
		const decision = await checkCommitGate(commitEvent('git commit . -m "x"'), rules(), d);
		// Pre-fix the literal spec "." matched nothing → no source evaluated → allow.
		expect(decision?.decision).toBe("block");
	});

	it("`git add --pathspec-from-file <file> && git commit` evaluates ALL changed files", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, null),
			gitChangedFiles: stagedAware(["src/a.ts"]),
		};
		const decision = await checkCommitGate(
			commitEvent('git add --pathspec-from-file files.txt && git commit -m "x"'),
			rules(),
			d,
		);
		// Pre-fix the LIST FILE (files.txt) was the narrow path set, src/a.ts matched
		// nothing, and its uncovered code bypassed the gate.
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — honors the documented per_edit_coverage opt-outs (finding
// 2026-06, round 3: only `enabled` was checked, so `mode: "warn"`,
// `block_on_test_failure: false`, and `block_on_crap: false` went ineffective
// exactly when per-edit checks deferred to commit time)
// ---------------------------------------------------------------------------

describe("checkCommitGate — config opt-outs honored at commit time", () => {
	it("is a pure no-op when mode is 'warn' (runner + git never called)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const stub = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 }]),
		);
		let gitCalled = false;
		const d: CommitGateDeps = {
			...deps(stub.runner, ["src/a.ts"]),
			gitChangedFiles: () => {
				gitCalled = true;
				return ["src/a.ts"];
			},
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules({ mode: "warn" }), d);
		expect(decision).toBeNull();
		expect(stub.ran()).toBe(false);
		expect(gitCalled).toBe(false);
	});

	it("does NOT block a RED suite when block_on_test_failure is false — warns and withholds the discharge", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const discharged: string[] = [];
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, ["src/a.ts"]),
			recordDischarge: (_root, file) => {
				discharged.push(file);
			},
		};
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ block_on_test_failure: false }),
			d,
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.join("\n")).toMatch(/block_on_test_failure is off/);
		expect(discharged).toEqual([]); // a red bar must never discharge a deferred obligation
	});

	it("with block_on_test_failure off, the RED run's coverage still enforces (uncovered line blocks)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ block_on_test_failure: false }),
			deps(stubRunner(result).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
	});

	it("does NOT score CRAP when block_on_crap is false (same fixture that blocks with it on)", async () => {
		writeSource("src/a.ts", JS_SRC);
		// Identical fixture to the "CRAP over threshold" block test above.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules({ block_on_crap: false }),
			deps(stubRunner(result).runner, ["src/a.ts"], [fn({ name: "big", line: 1, endLine: 3, cyclomatic: 10 })]),
		);
		expect(decision).toBeNull();
	});

	it("discharges deferred obligations on a measured GREEN clean pass (the relief path stays real)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const discharged: string[] = [];
		const d: CommitGateDeps = {
			...deps(stubRunner(result).runner, ["src/a.ts"]),
			recordDischarge: (_root, file) => {
				discharged.push(file);
			},
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), d);
		expect(decision).toBeNull();
		expect(discharged).toEqual(["src/a.ts"]);
	});

	it("discharges a DELETED path's obligation on a clean pass (no report can ever measure it)", async () => {
		// A budget-deferred delete-only edit records an obligation for the deleted
		// path; the green commit-gate suite IS the verification of that deletion —
		// without this discharge the Stop warning stayed open forever (finding 2026-06).
		const discharged: string[] = [];
		const d: CommitGateDeps = {
			...deps(stubRunner(coverageResult("src/other.ts", [])).runner, ["src/gone.ts"]),
			recordDischarge: (_root, file) => {
				discharged.push(file);
			},
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "drop"'), rules(), d);
		expect(decision).toBeNull();
		expect(discharged).toEqual(["src/gone.ts"]);
	});
});

// ---------------------------------------------------------------------------
// checkCommitGate — suite-baseline-aware red bar (foreign repos arrive with a
// pre-existing red suite; only NEW failures beyond the recorded baseline block)
// ---------------------------------------------------------------------------

describe("checkCommitGate — pre-existing red tolerated via the suite baseline", () => {
	/** A red run over a fully-covered changed file, so ONLY the red-bar axis decides. */
	function redResult(failing: string[]): CoverageRunResult {
		return coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			{ testsPassed: false, failingTests: failing },
		);
	}

	function recordBaseline(green: boolean, failing: string[]): void {
		writeSuiteBaseline(root, {
			recorded_at: "2026-07-01T00:00:00.000Z",
			language: "typescript",
			green,
			failing_tests: failing,
		});
	}

	it("ALLOWS a red suite whose failures exactly match the recorded red baseline (warning, no discharge)", async () => {
		writeSource("src/a.ts", JS_SRC);
		recordBaseline(false, ["old flake"]);
		const discharged: string[] = [];
		const d: CommitGateDeps = {
			...deps(stubRunner(redResult(["old flake"])).runner, ["src/a.ts"]),
			recordDischarge: (_root, file) => {
				discharged.push(file);
			},
		};
		const decision = await checkCommitGate(commitEvent('git commit -m "x"'), rules(), d);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.join("\n")).toMatch(/pre-existing per the recorded suite baseline/);
		expect(discharged).toEqual([]); // a red bar must never discharge a deferred obligation
	});

	it("ALLOWS when the baseline's failing set is a SUPERSET of the current failures", async () => {
		writeSource("src/a.ts", JS_SRC);
		recordBaseline(false, ["a fails", "b fails", "c fails"]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult(["b fails"])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.join("\n")).toMatch(/not blocking on the red bar/);
	});

	it("BLOCKS on one NEW failure, naming exactly it — with the tolerated count + re-record reminder", async () => {
		writeSource("src/a.ts", JS_SRC);
		recordBaseline(false, ["old flake"]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult(["old flake", "brand new regression"])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/failing test\(s\): brand new regression/);
		expect(decision?.reason).not.toMatch(/old flake/); // the inherited failure is NOT named as new
		expect(decision?.reason).toMatch(/1 pre-existing failure\(s\) were tolerated/);
		expect(decision?.reason).toMatch(/interlinked adopt --suite-baseline/);
		expect(decision?.rule_id).toBe("commit-gate");
	});

	it("BLOCKS a red suite when the recorded baseline is GREEN (historical behavior unchanged)", async () => {
		writeSource("src/a.ts", JS_SRC);
		recordBaseline(true, []);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult(["boom"])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/a commit must not capture a red bar/);
		expect(decision?.reason).not.toMatch(/pre-existing/);
	});

	it("BLOCKS a red suite when NO baseline is recorded (historical behavior unchanged)", async () => {
		writeSource("src/a.ts", JS_SRC);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult(["boom"])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/a commit must not capture a red bar/);
	});

	it("BLOCKS a red suite when the baseline file is malformed (fails toward the historical block)", async () => {
		writeSource("src/a.ts", JS_SRC);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "suite-baseline.json"), '{"green": "nope"}', "utf-8");
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult(["boom"])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/a commit must not capture a red bar/);
	});

	it("BLOCKS an UNNAMED red (no failing-test names) even under a red baseline — unmatchable", async () => {
		writeSource("src/a.ts", JS_SRC);
		recordBaseline(false, ["old flake"]);
		const decision = await checkCommitGate(
			commitEvent('git commit -m "x"'),
			rules(),
			deps(stubRunner(redResult([])).runner, ["src/a.ts"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/a commit must not capture a red bar/);
	});
});
