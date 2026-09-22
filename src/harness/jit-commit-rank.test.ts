// Real ephemeral git repo: the ranker shells to git, so a mocked history would
// only test the mock. Modeled on commit-registry-parity-gate.test.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibrationScores, rankRefCommit, rankStagedCommit } from "./jit-commit-rank.js";
import type { HistoryCommit } from "./jit-commit-inputs.js";

let root: string;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

function write(rel: string, content: string): void {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), content, "utf-8");
}

function commit(msg: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) write(rel, content);
	git("add", "-A");
	git("commit", "-q", "-m", msg);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jit-rank-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "Tester");
	git("config", "commit.gpgsign", "false");
	commit("feat: seed", { "src/a.ts": "export const a = 1;\n", "docs/x.md": "# x\n" });
	commit("fix: a", { "src/a.ts": "export const a = 2;\n" });
	commit("feat: b", { "src/b.ts": "export const b = 1;\n" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("rankRefCommit", () => {
	it("P1: scores HEAD with a percentile against the repo's own history", () => {
		const r = rankRefCommit(root, "HEAD", { calibrate: 10 });
		expect(r).not.toBeNull();
		expect(r?.score).toBeGreaterThan(0);
		expect(r?.inputs.filesTouched).toBe(1);
		expect(r?.population).toBe(3);
		expect(r?.percentile).toBeGreaterThanOrEqual(0);
	});

	it("P2: a wide fix commit ranks above a one-line feature", () => {
		commit("fix: wide regression", {
			"src/a.ts": "export const a = 3;\nexport const aa = 4;\n",
			"src/b.ts": "export const b = 2;\n",
			"docs/x.md": "# x\nmore\n",
			"lib/c.ts": "export const c = 1;\n",
		});
		const wide = rankRefCommit(root, "HEAD", { calibrate: 10 });
		const narrow = rankRefCommit(root, "HEAD~1", { calibrate: 10 });
		expect(wide?.score ?? 0).toBeGreaterThan(narrow?.score ?? 0);
		expect(wide?.inputs.purpose.isFix).toBe(true);
	});

	it("N1: an unknown ref yields null, not a throw", () => {
		expect(rankRefCommit(root, "no-such-ref", { calibrate: 10 })).toBeNull();
	});
});

describe("rankStagedCommit", () => {
	it("P1: scores the staged diff with the given message", () => {
		write("src/a.ts", "export const a = 9;\nexport const z = 0;\n");
		git("add", "-A");
		const r = rankStagedCommit(root, "fix: staged", { calibrate: 10 });
		expect(r?.inputs.linesAdded).toBe(2);
		expect(r?.inputs.priorChanges).toBe(2); // a.ts touched by seed + fix
		expect(r?.inputs.purpose.isFix).toBe(true);
	});
	it("N1: nothing staged yields null", () => {
		expect(rankStagedCommit(root, "chore: nothing", { calibrate: 10 })).toBeNull();
	});
});

describe("calibrationScores", () => {
	const mk = (sha: string, ts: number, files: number): HistoryCommit => ({
		sha, author: "A", timestamp: ts, subject: "feat", files: Array.from({ length: files }, (_, k) => ({ file: `src/f${k}.ts`, added: 3, deleted: 1 })),
	});
	it("P1: scores the newest n commits, each against only the history before it", () => {
		const history = [mk("c", 300, 4), mk("b", 200, 2), mk("a", 100, 1)];
		const hunks = new Map([["c", 4], ["b", 2], ["a", 1]]);
		const scores = calibrationScores(history, hunks, { n: 2, now: 400, recentDays: 90, maxCommitFiles: 30 });
		expect(scores).toHaveLength(2);
		expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
	});
	it("N1: an empty history yields an empty population", () => {
		expect(calibrationScores([], new Map(), { n: 5, now: 0, recentDays: 90, maxCommitFiles: 30 })).toEqual([]);
	});
});
