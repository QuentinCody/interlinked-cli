// `metrics coupling`: set-aside files (lockfiles, generated, minified) and code pairs listed apart from data pairs.
// A real throwaway git repository; no mocks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { metricsCouplingCommand } from "./metrics-coupling.js";

const BUNDLE = `${"var f=function(a,b){return a+b},x=f(1,2),y=f(x,3);".repeat(600)}\n`;
let repo = "";
const priorConfig = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };

function git(args: string[], atMs: number): void {
	const stamp = new Date(atMs).toISOString();
	execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
}
function put(rel: string, contents: string): void {
	const abs = join(repo, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, contents);
}

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	const now = Date.now();
	repo = mkdtempSync(join(tmpdir(), "metrics-coupling-sets-"));
	git(["init", "-q"], now);
	// Five commits that each change the same six files: two code files, two locale files, a lockfile and a minified bundle.
	for (let i = 1; i <= 5; i++) {
		put("src/a.ts", `export const a = ${i};\n`);
		put("src/b.ts", `export const b = ${i};\n`);
		put("i18n/de.json", `{"k": ${i}}\n`);
		put("i18n/fr.json", `{"k": ${i}}\n`);
		put("pnpm-lock.yaml", `lockfileVersion: ${i}\n`);
		put("site/app.js", BUNDLE.replace("f(1,2)", `f(${i},2)`));
		git(["add", "-A"], now);
		git(["commit", "-q", "-m", `c${i}`], now - (10 - i) * 86_400_000);
	}
});
afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
	if (priorConfig.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = priorConfig.global;
	if (priorConfig.system === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = priorConfig.system;
});

interface Pair { a: string; b: string; kind: string; relation: string; percentile: number; }
async function runJson(): Promise<{ pairs: Pair[]; data_pairs: Pair[]; set_aside: { files: number; by_reason: { reason: string; files: number }[]; pairs: number }; commits_scanned: number }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await metricsCouplingCommand({ cwd: repo, json: true });
		return JSON.parse(log.mock.calls.map(call => String(call[0])).join("\n"));
	} finally { log.mockRestore(); }
}

describe("metrics coupling sets lockfiles and bundles aside and lists data pairs apart", () => {
	it("keeps code and mixed pairs in `pairs` and data-only pairs in `data_pairs`", async () => {
		const report = await runJson();
		expect(report.commits_scanned).toBe(5);
		const names = (rows: Pair[]) => rows.map(row => `${row.a}|${row.b}|${row.kind}`).sort();
		expect(names(report.pairs)).toEqual([
			"i18n/de.json|src/a.ts|mixed", "i18n/de.json|src/b.ts|mixed", "i18n/fr.json|src/a.ts|mixed", "i18n/fr.json|src/b.ts|mixed", "src/a.ts|src/b.ts|code",
		]);
		expect(names(report.data_pairs)).toEqual(["i18n/de.json|i18n/fr.json|data"]);
		expect(report.data_pairs[0]?.relation).toBe("data");
	});
	it("states what it set aside: the files by reason and the pairs that involved them", async () => {
		const report = await runJson();
		expect(report.set_aside.files).toBe(2);
		expect(report.set_aside.by_reason).toEqual([{ reason: "generated (shape)", files: 1 }, { reason: "lockfile", files: 1 }]);
		// 6 files give 15 pairs; the 6 files minus the 2 set-aside give 6; every other pair involves a set-aside file.
		expect(report.set_aside.pairs).toBe(9);
	});
	it("ranks each list on its own", async () => {
		const report = await runJson();
		expect(report.data_pairs.map(row => row.percentile)).toEqual([0]);
		expect(Math.max(...report.pairs.map(row => row.percentile))).toBeGreaterThanOrEqual(0);
	});
});
