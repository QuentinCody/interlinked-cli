// ===========================================
// CI-vs-pre-push pipeline parity
// ===========================================
//
// Locks in the invariant the user articulated after the docs:check
// red-CI incident (commit 5452fac → c2eef67): "the interlinked-cli
// tool is supposed to check everything that could go wrong BEFORE
// it's written to disk, and certainly before it's committed and
// pushed." The pre-push hook is the local mirror of CI; this test
// guarantees no new CI step can ship without either being wired
// into the hook or being explicitly opted out with a rationale.
//
// How it works:
//   1. Parse `.github/workflows/ci.yml` and extract every `- name:`
//      step from the matrix job (one entry per step).
//   2. Compare against the `CI_STEPS` allowlist below. If CI adds
//      a step, the test fails with the new step's name — the
//      change-author must update this file (either wire it into
//      the pre-push hook OR add a skip + rationale).
//   3. For each `mirror: "pre-push"` entry, assert the listed
//      `command` substring appears in `scripts/git-hooks/pre-push`
//      so a hook drift (someone removes a check) also breaks here.
//
// Maintenance contract: when you add or remove a CI step in
// .github/workflows/ci.yml, update `CI_STEPS` in lockstep. If your
// new step is a real correctness gate, default to `mirror: "pre-push"`
// and add it to the hook script. Use `mirror: "skip"` only for
// release-time / package-shape checks that don't gate the coding
// loop, and always attach a one-line `reason`.

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");
const PRE_PUSH_HOOK = resolve(REPO_ROOT, "scripts", "git-hooks", "pre-push");

type CiStep = {
	/** Exact `name:` value in ci.yml. */
	name: string;
} & (
	| { mirror: "pre-push"; command: string }
	| { mirror: "skip"; reason: string }
);

const CI_STEPS: readonly CiStep[] = [
	{ name: "Checkout", mirror: "skip", reason: "git checkout — runner setup, not a check" },
	{
		name: "Setup Node.js 22",
		mirror: "skip",
		reason: "Node toolchain provision — runner setup, not a check",
	},
	{
		name: "Install dependencies",
		mirror: "skip",
		reason: "npm ci — pre-push runs against the existing dev install",
	},
	{
		name: "Install ripgrep (CI/dev environment parity)",
		mirror: "skip",
		reason:
			"environment provision, not a check — runners ship no ripgrep, so without it the rg-gated tests skip on CI while passing on every dev machine (finding 2026-06: that divergence shipped a red run); locally rg is already the grep-accelerator's own dependency",
	},
	{ name: "Typecheck", mirror: "pre-push", command: "npm run typecheck:stable" },
	{
		name: "Doc accuracy (landing + README vs source)",
		mirror: "pre-push",
		command: "npm run docs:check",
	},
	// The CI test run is split into two parallel lanes (unit / integration) so
	// neither exceeds the job timeout. The pre-push hook runs `npm test` — the
	// full suite, which is the superset of both lanes — so it mirrors each. See
	// ci.yml + vitest.{unit,integration}.config.ts.
	// The unit lane is SHARDED in CI (3 matrix jobs — parallel wall-clock,
	// and blast-radius isolation: a hanging file times out one shard, not
	// the lane; see ci.yml for the /proc-probe history). The pre-push mirror
	// is still the unsharded full suite — a superset of every shard.
	{ name: "Test (unit lane, shard ${{ matrix.shard }})", mirror: "pre-push", command: "npm test" },
	{ name: "Test (integration lane)", mirror: "pre-push", command: "npm test" },
	{
		name: "Build",
		mirror: "skip",
		reason: "build artifact — typecheck already covers source correctness; build itself is release-shape",
	},
	{
		name: "Lint package with publint",
		mirror: "skip",
		reason: "publint — package.json shape check; release-time only",
	},
	{
		name: "Check types with arethetypeswrong",
		mirror: "skip",
		reason: "attw — types-publish surface check; release-time only",
	},
	{
		name: "Pack dry-run",
		mirror: "skip",
		reason: "npm pack --dry-run — release-time tarball smoke",
	},
	{
		name: "Tarball install smoke test",
		mirror: "skip",
		reason: "full install-from-tarball walkthrough — too slow for pre-push (~minute)",
	},
	{
		name: "Onboarding smoke test (git-clone install path)",
		mirror: "skip",
		reason: "git-clone install walkthrough — too slow for pre-push (~minute)",
	},
];

/** Extract every `- name: <step>` from the matrix job. Strips the
 *  leading `- name:` and any trailing whitespace. Doesn't try to
 *  parse YAML structure (no dependency), just lexical extraction
 *  of step names — the ordering and uniqueness of `- name:` lines
 *  inside the steps block is the only thing we need to match. */
function extractCiStepNames(yaml: string): string[] {
	const names: string[] = [];
	const stepRe = /^\s{6}- name:\s*(.+?)\s*$/gm;
	let m: RegExpExecArray | null = stepRe.exec(yaml);
	while (m !== null) {
		names.push(nonNull(m[1]));
		m = stepRe.exec(yaml);
	}
	return names;
}

describe("CI ↔ pre-push pipeline parity", () => {
	const yaml = readFileSync(CI_WORKFLOW, "utf-8");
	const hook = readFileSync(PRE_PUSH_HOOK, "utf-8");
	const ciStepNamesInYaml = extractCiStepNames(yaml);

	it("extracts at least one step from ci.yml (regex sanity check)", () => {
		expect(ciStepNamesInYaml.length).toBeGreaterThan(0);
	});

	it("declared CI steps match the workflow step names", () => {
		expect(new Set(ciStepNamesInYaml)).toEqual(new Set(CI_STEPS.map((step) => step.name)));
	});

	it("CI_STEPS has no duplicate step names", () => {
		expect(new Set(CI_STEPS.map((step) => step.name)).size).toBe(CI_STEPS.length);
	});

	describe("mirror: 'pre-push' entries appear in the hook script", () => {
		for (const step of CI_STEPS) {
			if (step.mirror !== "pre-push") continue;
			it(`hook contains the command for "${step.name}"`, () => {
				expect(step.command).toBeTruthy();
				expect(hook).toContain(step.command);
			});
		}
	});

	describe("mirror: 'skip' entries carry a rationale", () => {
		for (const step of CI_STEPS) {
			if (step.mirror !== "skip") continue;
			it(`"${step.name}" has a non-empty reason`, () => {
				expect(step.reason).toBeTruthy();
				expect(step.reason.trim().length).toBeGreaterThan(0);
			});
		}
	});
});

// ===========================================
// pre-push hook — exit-status behavior
// ===========================================
//
// Regression coverage for the bug where `git push` failed with a bare
// "failed to push some refs" even though typecheck + tests passed.
//
// Root cause: the hook stashes the working tree and installs an EXIT
// trap to restore it. The trap handler inherited `set -e` from the
// gate region; once the repo had accumulated enough stashes, the
// `git stash list | awk` pipeline inside the handler took SIGPIPE and
// reported failure, which under `set -e` aborted the handler — and a
// `set -e` abort inside an EXIT trap *overrides* the script's pending
// `exit 0` with a non-zero status. git then rejected the push.
//
// These tests run the real hook against a throwaway repo with a
// `file://` remote (no network, no flakiness) and stub the three slow
// gates so the suite stays fast. The stash list is preloaded with many
// entries — that is the condition that triggered the original bug, so
// a regression here would resurface it.
describe("pre-push hook exit-status behavior", () => {
	let tmp: string;
	let work: string;
	let bare: string;

	// Minimum stash count that reliably outlives `awk`'s early exit and
	// makes the upstream `git stash list` take SIGPIPE. The real repo
	// hit this naturally because every buggy run orphaned one stash.
	const PRELOADED_STASHES = 40;

	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

	/** Build a package.json whose three gate scripts behave as given. */
	const writePackageJson = (
		dir: string,
		gates: { typecheck: string; docs: string; test: string },
	): void => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "pre-push-fixture",
				version: "1.0.0",
				scripts: {
					"typecheck:stable": gates.typecheck,
					"docs:check": gates.docs,
					test: gates.test,
				},
			}),
		);
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-prepush-"));
		work = join(tmp, "work");
		bare = join(tmp, "remote.git");

		execFileSync("git", ["init", "--bare", "-q", bare]);
		execFileSync("git", ["init", "-q", work]);
		git(work, "config", "user.email", "test@example.com");
		git(work, "config", "user.name", "Test");
		git(work, "config", "core.hooksPath", "scripts/git-hooks");
		git(work, "remote", "add", "origin", `file://${bare}`);

		// Install the real hook verbatim.
		execFileSync("mkdir", ["-p", join(work, "scripts", "git-hooks")]);
		copyFileSync(PRE_PUSH_HOOK, join(work, "scripts", "git-hooks", "pre-push"));
		chmodSync(join(work, "scripts", "git-hooks", "pre-push"), 0o755);

		// Initial commit, seeded to the remote with --no-verify so the
		// hook only runs on the push under test.
		writePackageJson(work, { typecheck: "true", docs: "true", test: "true" });
		writeFileSync(join(work, "file.txt"), "base\n");
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", "initial");
		git(work, "push", "-q", "--no-verify", "origin", "HEAD:refs/heads/main");

		// Preload the stash stack — the bug-triggering condition.
		for (let i = 0; i < PRELOADED_STASHES; i++) {
			writeFileSync(join(work, "file.txt"), `stash-fill-${i}\n`);
			git(work, "stash", "push", "-q", "-m", `preload-${i}`);
		}
		// This hook spawns ~45 real git subprocesses (init/commit/push + 40
		// stashes). At ~3s in isolation it fits the 30s default easily, but under
		// full-suite parallel load the subprocesses starve and blow the hook
		// timeout — a flaky red that is purely scheduling, not logic. Give it
		// generous headroom so it stays green on slow/loaded CI runners too.
	}, 120_000);

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** Stage a new commit (so there is something to push) and leave a
	 *  dirty working-tree edit (so the hook's stash path triggers). */
	const stageCommitAndDirty = (): void => {
		writeFileSync(join(work, "file.txt"), "committed change\n");
		git(work, "add", "file.txt");
		git(work, "commit", "-q", "-m", "change to push");
		writeFileSync(join(work, "file.txt"), "committed change\nworking-tree edit\n");
	};

	const push = (): { status: number; output: string } => {
		const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
			cwd: work,
			encoding: "utf-8",
		});
		return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
	};

	it("a passing gate allows the push (exit 0) despite a long stash list", () => {
		// The exact original bug: gates pass, hook prints the success
		// line, yet `git push` previously exited non-zero.
		stageCommitAndDirty();
		const before = git(work, "rev-parse", "HEAD");

		const { status, output } = push();

		expect(output).toContain("typecheck + tests pass");
		expect(status).toBe(0);
		// Push actually landed.
		expect(git(work, "rev-parse", "origin/main")).toBe(before);
	});

	it("the stashed working-tree edit is restored after a passing push", () => {
		stageCommitAndDirty();

		expect(push().status).toBe(0);

		// The dirty edit is back in the working tree, not orphaned.
		expect(readFileSync(join(work, "file.txt"), "utf-8")).toContain("working-tree edit");
		// The hook's own stash was popped — no net new stash entry.
		const stashCount = git(work, "stash", "list").split("\n").filter(Boolean).length;
		expect(stashCount).toBe(PRELOADED_STASHES);
	});

	it("a failing test gate still blocks the push (non-zero exit)", () => {
		writePackageJson(work, {
			typecheck: "true",
			docs: "true",
			test: "echo gate-failure; exit 1",
		});
		git(work, "add", "package.json");
		git(work, "commit", "-q", "-m", "failing test gate");
		writeFileSync(join(work, "file.txt"), "dirty\n");
		const before = git(work, "rev-parse", "origin/main");

		const { status, output } = push();

		expect(status).not.toBe(0);
		expect(output).toContain("tests failed");
		// Push was rejected — origin/main did not move.
		expect(git(work, "rev-parse", "origin/main")).toBe(before);
		// Working tree still restored even on the failure path.
		expect(readFileSync(join(work, "file.txt"), "utf-8")).toBe("dirty\n");
	});

	it("a failing typecheck gate still blocks the push (non-zero exit)", () => {
		writePackageJson(work, {
			typecheck: "echo type-error; exit 2",
			docs: "true",
			test: "true",
		});
		git(work, "add", "package.json");
		git(work, "commit", "-q", "-m", "failing typecheck gate");
		writeFileSync(join(work, "file.txt"), "dirty\n");
		const before = git(work, "rev-parse", "origin/main");

		const { status, output } = push();

		expect(status).not.toBe(0);
		expect(output).toContain("typecheck:stable failed");
		expect(git(work, "rev-parse", "origin/main")).toBe(before);
	});
});
