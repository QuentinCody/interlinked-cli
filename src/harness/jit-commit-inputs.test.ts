import { describe, expect, it } from "vitest";
import {
	countHunks,
	deriveJitInputs,
	extractCommitMessage,
	type HistoryCommit,
	parseNumstatLog,
} from "./jit-commit-inputs.js";

const DAY = 86_400;
const NOW = 1_800_000_000;

const LOG = [
	"COMMIT\taaa\tAlice\t1799990000\tfix(gate): NaN guard",
	"10\t2\tsrc/a.ts",
	"3\t0\tsrc/b.ts",
	"",
	"COMMIT\tbbb\tBob\t1799900000\tfeat: thing",
	"-\t-\tassets/logo.png",
	"40\t5\tsrc/a.ts",
	"",
	`COMMIT\tccc\tAlice\t${NOW - 200 * DAY}\tdocs: old`,
	"1\t1\tdocs/x.md",
	"",
].join("\n");

describe("parseNumstatLog", () => {
	it("P1: parses commits with author, time, subject and per-file churn; binary rows count 0", () => {
		const commits = parseNumstatLog(LOG);
		expect(commits.map((c) => c.sha)).toEqual(["aaa", "bbb", "ccc"]);
		expect(commits[0]).toMatchObject({ author: "Alice", subject: "fix(gate): NaN guard" });
		expect(commits[0]?.files).toEqual([
			{ file: "src/a.ts", added: 10, deleted: 2 },
			{ file: "src/b.ts", added: 3, deleted: 0 },
		]);
		expect(commits[1]?.files[0]).toEqual({ file: "assets/logo.png", added: 0, deleted: 0 });
	});
	it("N1: empty or header-less text yields no commits", () => {
		expect(parseNumstatLog("")).toEqual([]);
		expect(parseNumstatLog("5\t5\tsrc/a.ts\n")).toEqual([]);
	});
});

describe("countHunks", () => {
	it("P1: counts @@ headers only", () => {
		expect(countHunks("@@ -1,2 +1,3 @@\n+x\n@@ -9 +10 @@\n-y\n")).toBe(2);
	});
	it("N1: a line containing @@ mid-text is not a hunk", () => {
		expect(countHunks("+const s = '@@ -1 +1 @@';\n")).toBe(0);
	});
});

describe("extractCommitMessage", () => {
	it("P1: reads -m with double, single and =-joined forms and joins several -m", () => {
		expect(extractCommitMessage('git commit -m "fix: a && b"')).toBe("fix: a && b");
		expect(extractCommitMessage("git commit -am 'feat: x'")).toBe("feat: x");
		expect(extractCommitMessage('git commit --message="docs: y"')).toBe("docs: y");
		expect(extractCommitMessage('git commit -m "one" -m "two"')).toBe("one\n\ntwo");
	});
	it("N1: no -m yields an empty string", () => {
		expect(extractCommitMessage("git commit")).toBe("");
		expect(extractCommitMessage("git commit -F msg.txt")).toBe("");
	});
});

describe("deriveJitInputs", () => {
	const history: HistoryCommit[] = parseNumstatLog(LOG);
	const subject = {
		sha: "new",
		author: "Alice",
		timestamp: NOW,
		subject: "fix: thing",
		files: [
			{ file: "src/a.ts", added: 20, deleted: 20 },
			{ file: "src/harness/z.ts", added: 20, deleted: 0 },
			{ file: "docs/x.md", added: 0, deleted: 20 },
		],
	};

	it("P1: size, diffusion, history and experience all derive from the record", () => {
		const i = deriveJitInputs({ subject, hunks: 7, history, now: NOW, recentDays: 90, maxCommitFiles: 30 });
		expect(i).toMatchObject({ linesAdded: 40, linesDeleted: 40, filesTouched: 3, hunks: 7, subsystems: 2, directories: 3 });
		expect(i.changeEntropy).toBeCloseTo(1.5, 10); // churn 40/20/20 → H(½,¼,¼) = 1.5 bits
		expect(i.priorChanges).toBe(3); // a.ts in aaa+bbb, x.md in ccc
		expect(i.priorAuthors).toBe(2);
		expect(i.priorFixes).toBe(1); // aaa is a fix
		expect(i.authorCommitsLong).toBe(2); // Alice: aaa, ccc
		expect(i.authorCommitsRecent).toBe(1); // ccc is 200 days old
		expect(i.purpose).toEqual({ isFix: true, isSecurityFix: false, isRevert: false });
	});

	it("N1: the subject's own sha, later commits and bulk commits are excluded from priors", () => {
		const bulk: HistoryCommit = {
			sha: "bulk",
			author: "Zed",
			timestamp: NOW - DAY,
			subject: "chore: reformat",
			files: Array.from({ length: 40 }, (_, k) => ({ file: `src/f${k}.ts`, added: 1, deleted: 1 })),
		};
		const self: HistoryCommit = { ...subject, files: [{ file: "src/a.ts", added: 1, deleted: 1 }] };
		const future: HistoryCommit = { ...subject, sha: "future", timestamp: NOW + DAY, author: "Alice" };
		const i = deriveJitInputs({ subject, hunks: 1, history: [bulk, self, future, ...history], now: NOW, recentDays: 90, maxCommitFiles: 30 });
		expect(i.priorChanges).toBe(3);
		expect(i.priorAuthors).toBe(2);
		expect(i.authorCommitsLong).toBe(2);
	});

	it("N2: a commit touching one file in one directory has zero diffusion inputs", () => {
		const i = deriveJitInputs({
			subject: { ...subject, files: [{ file: "src/a.ts", added: 5, deleted: 0 }] },
			hunks: 1, history: [], now: NOW, recentDays: 90, maxCommitFiles: 30,
		});
		expect(i).toMatchObject({ subsystems: 1, directories: 1, changeEntropy: 0, priorChanges: 0, authorCommitsLong: 0 });
	});
});
