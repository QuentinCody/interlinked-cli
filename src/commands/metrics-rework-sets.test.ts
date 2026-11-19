// `metrics rework`: what it sets aside (lockfiles, generated files, minified bundles, migration snapshots), the code/data split,
// and the old-side parse of a deleted SQL comment line. Real throwaway git repositories; no mocks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { metricsReworkCommand, parseUnifiedZeroHunks } from "./metrics-rework.js";

const DAY_MS = 86_400_000;
const BUNDLE = `${"var f=function(a,b){return a+b},x=f(1,2),y=f(x,3);".repeat(600)}\n`;
let repo = "";
const priorConfig = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };

function git(cwd: string, args: string[], atMs: number): void {
	const stamp = new Date(atMs).toISOString();
	execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
}
function put(rel: string, contents: string): void {
	const abs = join(repo, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, contents);
}
function commit(message: string, atMs: number): void {
	git(repo, ["add", "-A"], atMs);
	git(repo, ["commit", "-q", "-m", message], atMs);
}

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	const now = Date.now();
	repo = mkdtempSync(join(tmpdir(), "metrics-rework-sets-"));
	git(repo, ["init", "-q"], now);
	put("src/a.ts", "l1\nl2\nl3\n");
	put("pnpm-lock.yaml", "a\nb\nc\nd\n");
	put("i18n/de.json", "d1\nd2\nd3\n");
	put("db/0001.sql", "-- 7. Add cohort_id\nselect 1;\nselect 2;\nselect 3;\nselect 4;\n");
	put("db/migrations/meta/0001_snapshot.json", "s1\ns2\n");
	put("site/app.js", BUNDLE);
	commit("seed", now - 10 * DAY_MS);
	put("src/a.ts", "x1\nx2\nl3\n");
	put("pnpm-lock.yaml", "A\nB\nC\nD\n");
	put("i18n/de.json", "D1\nD2\nd3\n");
	put("db/0001.sql", "select 1;\nselect 2;\nselect 3;\nselect 4 changed;\n");
	put("db/migrations/meta/0001_snapshot.json", "S1\nS2\n");
	put("site/app.js", BUNDLE.replace("f(1,2)", "f(3,4)"));
	commit("rewrite everything", now - 5 * DAY_MS);
});
afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
	if (priorConfig.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = priorConfig.global;
	if (priorConfig.system === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = priorConfig.system;
});

async function runJson(): Promise<Record<string, any>> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await metricsReworkCommand({ cwd: repo, json: true });
		return JSON.parse(log.mock.calls.map(call => String(call[0])).join("\n"));
	} finally { log.mockRestore(); }
}

describe("parseUnifiedZeroHunks: a deleted SQL comment line is a body line, not a file header", () => {
	it("keeps the second hunk of the real file", () => {
		const diff = ["diff --git a/m.sql b/m.sql", "--- a/m.sql", "+++ b/m.sql", "@@ -1 +0,0 @@", "--- 7. Add cohort_id", "@@ -5 +4 @@", "-select 4;", "+select 5;"].join("\n");
		expect(parseUnifiedZeroHunks(diff)).toEqual([{ file: "m.sql", ranges: [{ start: 1, lines: 1 }, { start: 5, lines: 1 }] }]);
	});
	it("still reads the next file's header after a hunk is complete", () => {
		const diff = ["--- a/one.sql", "+++ b/one.sql", "@@ -1 +0,0 @@", "--- c", "--- a/two.ts", "+++ b/two.ts", "@@ -2,2 +2 @@", "-x", "-y", "+z"].join("\n");
		expect(parseUnifiedZeroHunks(diff).map(file => file.file)).toEqual(["one.sql", "two.ts"]);
	});
});

describe("metrics rework sets lockfiles, generated files and snapshots aside and splits code from data", () => {
	it("reports the numbers with and without the set-aside files", async () => {
		const report = await runJson();
		expect(report.skipped_blame_files).toBe(0);
		expect(report.overall).toEqual({ rework: 6, total: 6, pct: 100 });
		expect(report.by_kind.code).toEqual({ rework: 4, total: 4, pct: 100 });
		expect(report.by_kind.data).toEqual({ rework: 2, total: 2, pct: 100 });
		expect(report.set_aside.files).toBe(3);
		expect(report.set_aside).toMatchObject({ rework: 7, total: 7 });
		expect(report.set_aside.by_reason.map((row: { reason: string }) => row.reason)).toEqual(["generated (shape)", "lockfile", "migration snapshot"]);
		expect(report.with_set_aside).toEqual({ rework: 13, total: 13, pct: 100 });
		expect(report.top_files.map((row: { file: string }) => row.file).sort()).toEqual(["db/0001.sql", "i18n/de.json", "src/a.ts"]);
		expect(report.set_aside.top.map((row: { file: string }) => row.file).sort()).toEqual(["db/migrations/meta/0001_snapshot.json", "pnpm-lock.yaml", "site/app.js"]);
	});
	it("states the set-aside share in the text report", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await metricsReworkCommand({ cwd: repo });
			const text = log.mock.calls.map(call => String(call[0])).join("\n");
			expect(text).toMatch(/Set aside 3 files \(7 of 13 changed lines\): generated \(shape\) 1, lockfile 1, migration snapshot 1/);
		} finally { log.mockRestore(); }
	});
});
