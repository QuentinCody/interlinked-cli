// Regression pins for the 2026-10-21 red-team review of commit_baseline_integrity_gate
// (scratch/2026-10-21-red-team/result.json, surface "commit_baseline_integrity_gate").
// Each positive case replays one CONFIRMED bypass against the real gate function
// in a throwaway git repository; the negatives keep honest commits allowed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeServerRuntime } from "../server/__tests__/fixtures.js";
import { runCommitGate } from "../server/pre-tool-coverage-gates.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { baselineBashWriteRefusal } from "./baseline-bash-guard.js";
import { checkCommitBaselineGate } from "./commit-baseline-gate.js";
import { committedFiles } from "./commit-file-set.js";
import { listGitInvocations, parseGitCommit } from "./commit-parse.js";

const CAPS = ".interlinked/metric-caps.json";
const LARGE = ".interlinked/large-files-baseline.json";
const TIGHT_CAPS = { version: 1, max_cyclomatic: 16, max_cognitive: 15, crap_threshold: 25, min_coverage: 0.9 };
const LOOSE_CAPS = { version: 1, max_cyclomatic: 40, max_cognitive: 60, crap_threshold: 200, min_coverage: 0.1 };
const PLUMBING =
	'T=$(git write-tree) && C=$(git commit-tree "$T" -p HEAD -m "chore: housekeeping") && git update-ref refs/heads/main "$C"';
/** The "Plumbing-verb commit" record's concreteInput, verbatim. */
const PLUMBING_RECORD = [
	"# loosened baseline already written to working tree, then:",
	"git add .interlinked/large-files-baseline.json",
	"T=$(git write-tree)",
	'C=$(git commit-tree "$T" -p HEAD -m "chore: housekeeping")',
	'git update-ref refs/heads/main "$C"',
	"# branch now points at a commit whose tree carries a loosened large-files-baseline.json;",
	"# no segment ever contained the token `commit`, so parseGitCommit returns isCommit=false.",
].join("\n");
/** The "HEAD-reset via delete-then-readd" record's two commands, verbatim. */
const HEAD_RESET_RECORD = [
	'git rm .interlinked/metric-caps.json && git commit -m "chore: drop stale caps file"',
	[
		"cat > .interlinked/metric-caps.json <<'EOF'",
		'{"max_cyclomatic":40,"max_cognitive":60,"min_coverage":0.1,"crap_threshold":200}',
		"EOF",
		'           git add .interlinked/metric-caps.json && git commit -m "chore: restore caps file"',
	].join("\n"),
] as const;

let root: string;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function write(rel: string, obj: unknown): void {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}

function event(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "red-team",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: root,
	} satisfies HarnessEvent;
}

const gate = (command: string) => checkCommitBaselineGate(event(command));

/** Commit the deletion of `rel` so HEAD no longer carries it (the attack's first commit). */
function commitDeletion(rel: string): void {
	git("rm", "-q", rel);
	git("commit", "-q", "-m", "chore: drop stale file");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "red-team-commit-gate-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	write(CAPS, TIGHT_CAPS);
	write(LARGE, { max_lines: 500, files: {} });
	git("add", "-f", CAPS, LARGE);
	git("commit", "-q", "-m", "tight baselines");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("commit_baseline_integrity_gate red-team 2026-10-21 — positive (must block)", () => {
	it("P1: HEAD-reset via delete-then-readd — a bare commit with the deletion staged blocks", () => {
		git("rm", "-q", CAPS);
		const d = gate('git commit -m "chore: drop stale caps file"');
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("commit_baseline_integrity_gate");
		expect(d?.reason).toContain(`[deleted] ${CAPS}`);
	});

	it("P1: HEAD-reset via delete-then-readd — `git rm X && git commit` in one command blocks before the rm runs", () => {
		const d = gate(`git rm ${CAPS} && git commit -m "chore: drop stale caps file"`);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain(`[deleted] ${CAPS}`);
	});

	it("P1: HEAD-reset via delete-then-readd — the loosened re-add is compared against the last committed version", () => {
		commitDeletion(CAPS);
		expect(git("ls-tree", "HEAD", CAPS)).toBe(""); // HEAD really lacks the file
		write(CAPS, LOOSE_CAPS);
		git("add", "-f", CAPS);
		const d = gate('git commit -m "chore: restore caps file"');
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("max_cyclomatic");
		expect(d?.reason).toContain("min_coverage");
		expect(d?.reason).toContain("last committed version");
	});

	it("P1: HEAD-reset via delete-then-readd — a worktree deletion staged by `commit -a` or `add -A` blocks", () => {
		unlinkSync(join(root, LARGE));
		expect(gate('git commit -am "cleanup"')?.reason).toContain(`[deleted] ${LARGE}`);
		expect(gate('git add -A && git commit -m "cleanup"')?.reason).toContain(`[deleted] ${LARGE}`);
		expect(gate(`git commit -m "cleanup" ${LARGE}`)?.reason).toContain(`[deleted] ${LARGE}`);
	});

	it("P2: Plumbing-verb commit — write-tree/commit-tree/update-ref of a loosened staged baseline blocks", () => {
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
		expect(parseGitCommit(PLUMBING)).toBeNull(); // the porcelain parser still sees no commit…
		expect(listGitInvocations(PLUMBING).map((i) => i.verb)).toEqual(["write-tree", "commit-tree", "update-ref"]);
		const d = gate(PLUMBING);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("commit_baseline_integrity_gate");
		expect(d?.reason).toContain("max_lines");
	});

	it("P2: Plumbing-verb commit — each ref/tree-writing verb alone is judged as a commit of the index", () => {
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
		for (const cmd of [
			"git update-ref refs/heads/main $C",
			"git write-tree",
			"git commit-tree $T -p HEAD -m x",
			"git -C . update-ref refs/heads/main $C",
			"`git write-tree`",
		]) {
			expect(gate(cmd)?.decision, cmd).toBe("block");
		}
	});

	it("P2: Plumbing-verb commit — `update-index` stages the loosened WORKTREE copy, so it blocks before staging", () => {
		write(LARGE, { max_lines: 1000, files: {} }); // loosened on disk, NOT staged
		expect(git("diff", "--cached", "--name-only")).toBe("");
		const d = gate(`git update-index --add ${LARGE} && git write-tree`);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("max_lines");
	});
});

// Round 2: the round-1 fix pinned an `&&`-joined plumbing string, but the record's
// input is newline-separated and starts with a `# …` line. The splitter did not treat
// a newline as a separator, so that one comment hid every following command —
// including a porcelain `git commit` from EVERY commit gate (parseGitCommit).
describe("commit_baseline_integrity_gate red-team 2026-10-21 round 2 — positive (must block)", () => {
	const LOOSE_LARGE = { max_lines: 1000, files: {} };

	it("P3: the record's exact newline + comment plumbing input blocks, staged or not", () => {
		write(LARGE, LOOSE_LARGE); // "loosened baseline already written to working tree"
		expect(listGitInvocations(PLUMBING_RECORD).map((i) => i.verb)).toEqual(["add", "write-tree", "commit-tree", "update-ref"]);
		expect(gate(PLUMBING_RECORD)?.reason).toContain("max_lines"); // the `git add` line stages the worktree copy
		git("add", "-f", LARGE);
		expect(gate(PLUMBING_RECORD)?.reason).toContain("max_lines");
	});

	it("P4: a porcelain commit after a comment line reaches the commit gates as a commit", () => {
		write(LARGE, LOOSE_LARGE);
		git("add", "-f", LARGE);
		expect(parseGitCommit("# note\ngit commit -m x")?.isCommit).toBe(true);
		expect(gate("# note\ngit commit -m x")?.decision).toBe("block");
	});

	it("P5: a commit after a heredoc, a non-first bare update-ref line, and a backslash-continued commit block", () => {
		write(LARGE, LOOSE_LARGE);
		git("add", "-f", LARGE);
		const heredoc = "cat > notes.txt <<'EOF'\nnothing to see\nEOF\ngit commit -m x";
		expect(parseGitCommit(heredoc)?.isCommit).toBe(true);
		for (const cmd of [heredoc, "echo staged\ngit update-ref refs/heads/main $C", "git \\\n  commit \\\n  -m x"]) {
			expect(gate(cmd)?.decision, cmd).toBe("block");
		}
	});

	it("P6: git through wrappers — absolute path, env/command/VAR= prefixes, -C and -c — blocks", () => {
		write(LARGE, LOOSE_LARGE);
		git("add", "-f", LARGE);
		for (const cmd of [
			"/usr/bin/git commit -m x",
			"env -i GIT_TRACE=0 git commit -m x",
			"command git commit -m x",
			"GIT_AUTHOR_NAME=x git commit -m x",
			"git -C . -c user.name=x commit -m x",
			"git --git-dir .git commit -m x",
		]) {
			expect(parseGitCommit(cmd)?.isCommit, cmd).toBe(true);
			expect(gate(cmd)?.decision, cmd).toBe("block");
		}
	});

	it("P7: class variants — inline programs, substitutions, subshells, and a mid-line comment before a newline", () => {
		write(LARGE, LOOSE_LARGE);
		git("add", "-f", LARGE);
		for (const cmd of [
			"bash -c 'git commit -m x'",
			"sh -lc \"git write-tree\"",
			'echo "$(git commit -m x)"',
			"(cd . && git commit -m x)",
			"true # note\ngit commit -m x",
			"bash <<'EOF'\ngit commit -m x\nEOF",
			"eval git update-ref refs/heads/main $C",
		]) {
			expect(gate(cmd)?.decision, cmd).toBe("block");
		}
	});

	it("P8: delete-then-readd across two commits, with the record's exact text, blocks at both commits", () => {
		const [commit1, commit2] = HEAD_RESET_RECORD;
		expect(gate(commit1)?.reason).toContain(`[deleted] ${CAPS}`); // commit 1 refused before `git rm` runs
		commitDeletion(CAPS); // suppose commit 1 lands anyway (outside the hook)
		// Commit 2 writes the loosened copy from a heredoc in the same command: the
		// bash arm refuses the shell write to the water-line before it runs …
		expect(baselineBashWriteRefusal(commit2, root)).toContain("water-line metric-caps.json");
		// … and the commit after the heredoc is still seen as a commit.
		expect(parseGitCommit(commit2)?.isCommit).toBe(true);
		// Once the loosened bytes are on disk (any route), the same command blocks at
		// commit time against the last committed version, although HEAD lacks the file.
		writeFileSync(join(root, CAPS), '{"max_cyclomatic":40,"max_cognitive":60,"min_coverage":0.1,"crap_threshold":200}\n');
		const d = gate(commit2);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("last committed version");
		expect(d?.reason).toContain("min_coverage");
	});
});

describe("commit_baseline_integrity_gate red-team 2026-10-21 round 2 — negative (must not block)", () => {
	beforeEach(() => {
		// A loosened baseline IS staged, so each command below would block if the
		// parser read it as a commit: the negatives prove it is data, not a commit.
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
	});

	it("N6: a commit only inside a comment is not a commit", () => {
		for (const cmd of ["# git commit -m x", "echo hi # git commit -m x", "echo hi\n  # git update-ref refs/heads/main x"]) {
			expect(parseGitCommit(cmd), cmd).toBeNull();
			expect(gate(cmd), cmd).toBeNull();
		}
	});

	it("N7: a commit only inside quotes is not a commit", () => {
		for (const cmd of ["echo 'git commit -m x'", 'echo "git commit -m x"', "printf '%s\\n' 'git write-tree'"]) {
			expect(parseGitCommit(cmd), cmd).toBeNull();
			expect(gate(cmd), cmd).toBeNull();
		}
	});

	it("N8: a heredoc body that contains the text git commit is data", () => {
		for (const cmd of [
			"cat > notes.md <<'EOF'\ngit commit -m x\ngit update-ref refs/heads/main x\nEOF",
			"cat <<-EOF\n\tgit commit -m x\n\tEOF\necho done",
			"git status <<EOF\ngit commit -m x\nEOF",
		]) {
			expect(parseGitCommit(cmd), cmd).toBeNull();
			expect(gate(cmd), cmd).toBeNull();
		}
	});
});

// Round 3: the blessed splitSegments (shell-structure.ts, commit-file-set.ts) had kept
// the newline/comment gap after round 2 fixed the git parsers. It is now the same
// shell scan as shellUnits, so a leading `# note` line hides no command from any
// consumer. These cases drive the SERVER's commit-gate entry (runCommitGate →
// checkCommitGate) with its production deps against the throwaway repository.
describe("commit gate red-team 2026-10-21 round 3 — positive (must reach the gate as a commit)", () => {
	const coverageRules = (): GuardRulesConfig => ({
		...makeGuardRules(),
		per_edit_coverage: { enabled: true, mode: "block", budget_ms: 25_000, languages: ["js", "ts"] },
	});
	const runGate = (command: string) =>
		runCommitGate(makeServerRuntime({ cwd: root, rules: coverageRules() }), event(command), { decision: "allow" });

	it("P9: `# note\\ngit commit` is evaluated by the commit gate (its --no-verify note proves it ran)", async () => {
		for (const cmd of ["# note\ngit commit --no-verify -m x", "# a\n# b\n\ngit commit -n -m x", "true # c\ngit commit --no-verify -m x"]) {
			const d = await runGate(cmd);
			expect(d?.decision, cmd).toBe("allow");
			expect(d?.warnings?.join("\n"), cmd).toContain("`--no-verify` was passed");
		}
	});

	it("P10: commit-file-set reads `# note\\ngit commit` as one plain commit of the index", () => {
		const scope = committedFiles("# note\ngit commit -m x", root, {
			resolveRepoRoot: () => root,
			gitChangedFiles: (_root, stagedOnly) => (stagedOnly ? ["staged.ts"] : ["staged.ts", "dirty.ts"]),
		});
		expect(scope?.root).toBe(root);
		expect([...(scope?.files ?? [])]).toEqual([join(root, "staged.ts")]);
	});
});

describe("commit gate red-team 2026-10-21 round 3 — negative (must not reach the gate as a commit)", () => {
	const deps = { resolveRepoRoot: () => root, gitChangedFiles: () => ["a.ts"] };

	it("N9: a commented, quoted or heredoc-body commit never reaches the commit gate", async () => {
		const rules: GuardRulesConfig = {
			...makeGuardRules(),
			per_edit_coverage: { enabled: true, mode: "block", budget_ms: 25_000, languages: ["js", "ts"] },
		};
		for (const cmd of [
			"# git commit --no-verify -m x",
			"echo 'a\ngit commit --no-verify -m x'",
			"cat <<'EOF'\ngit commit --no-verify -m x\nEOF",
		]) {
			expect(await runCommitGate(makeServerRuntime({ cwd: root, rules }), event(cmd), { decision: "allow" }), cmd).toBeNull();
		}
	});

	it("N10: commit-file-set keeps the scope unknown when a newline joins another command to the commit", () => {
		expect(committedFiles("git add b.ts\ngit commit -m x", root, deps)).toBeNull();
		expect(committedFiles("git commit -m x\ngit add b.ts", root, deps)).toBeNull();
		expect(committedFiles("# git commit -m x", root, deps)).toBeNull();
	});
});

describe("commit_baseline_integrity_gate red-team 2026-10-21 — negative (must not block)", () => {
	it("hashing without -w does not publish a dirty baseline", () => {
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
		expect(gate(`git hash-object ${LARGE}`)).toBeNull();
		expect(gate(`git hash-object -w ${LARGE}`)?.decision).toBe("block");
	});

	it("a path-only commit excludes an unrelated loosened staged baseline", () => {
		writeFileSync(join(root, "note.txt"), "before\n");
		git("add", "note.txt");
		git("commit", "-q", "-m", "note");
		writeFileSync(join(root, "note.txt"), "after\n");
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
		expect(gate("git commit --only -m note -- note.txt")).toBeNull();
		expect(gate("git commit --include -m note -- note.txt")?.decision).toBe("block");
	});

	it("a removal after the commit does not describe its committed tree", () => {
		expect(gate(`git commit --allow-empty -m note && git rm ${CAPS}`)).toBeNull();
	});

	it("a removal in a subdirectory does not delete the root baseline", () => {
		write(`sub/${CAPS}`, TIGHT_CAPS);
		git("add", "-f", `sub/${CAPS}`);
		git("commit", "-q", "-m", "nested fixture");
		expect(gate(`git -C sub rm ${CAPS} && git commit -m note`)).toBeNull();
	});

	it("N1: an honest tightened baseline committed through plumbing still passes", () => {
		write(LARGE, { max_lines: 300, files: {} });
		git("add", "-f", LARGE);
		expect(gate(PLUMBING)).toBeNull();
		expect(gate('git commit -m "tighten"')).toBeNull();
	});

	it("N2: re-adding a TIGHTER copy after a deletion commit passes (history comparison, tightening direction)", () => {
		commitDeletion(CAPS);
		write(CAPS, { ...TIGHT_CAPS, max_cyclomatic: 12 });
		git("add", "-f", CAPS);
		expect(gate('git commit -m "restore caps, tighter"')).toBeNull();
	});

	it("N3: a baseline that never existed in history is a new baseline, not a loosening", () => {
		write(".interlinked/untested-files-baseline.json", { min_coverage_pct: 80, files: [] });
		git("add", "-f", ".interlinked/untested-files-baseline.json");
		expect(gate('git commit -m "add untested floor"')).toBeNull();
		expect(gate(PLUMBING)).toBeNull();
	});

	it("N4: plumbing and porcelain commits with no baseline change pass, and `git rm` of an unrelated file passes", () => {
		writeFileSync(join(root, "note.txt"), "x\n");
		git("add", "note.txt");
		git("commit", "-q", "-m", "note");
		expect(gate(PLUMBING)).toBeNull();
		expect(gate("git update-index --refresh")).toBeNull();
		expect(gate('git rm note.txt && git commit -m "drop note"')).toBeNull();
		expect(gate('git commit -am "nothing"')).toBeNull();
	});

	it("N5: a commented or quoted plumbing verb is not a commit", () => {
		write(LARGE, { max_lines: 1000, files: {} });
		git("add", "-f", LARGE);
		expect(gate("# git update-ref refs/heads/main x")).toBeNull();
		expect(gate('echo "git write-tree"')).toBeNull();
		expect(gate("git status")).toBeNull();
	});
});
