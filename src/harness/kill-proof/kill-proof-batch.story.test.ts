// Product story for `interlinked tests prove-kill --all-survivors`, driven through
// the CLI from source against a throwaway git repository with the REAL vitest
// runner and a manifest produced the way a real one is: a real Stryker run over
// the throwaway's own source, converted through the repo adapter (`emptyManifest`
// → `seedFileBaseline` → `saveManifest`, docs/reviews/kill-proof-manifest-route.md
// §1). Nothing in the manifest is hand-written. The unit tests in batch.test.ts
// use a fake runner.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import { seedFileBaseline } from "../mutation/adopt.js";
import { emptyManifest, saveManifest } from "../mutation/manifest.js";
import { writeSurvivorsIndex } from "../mutation/survivors-index.js";
import type { ProveKillBatchResult } from "./batch.js";
import { listFileSurvivors } from "./batch.js";

const WORKTREE = resolve(import.meta.dirname, "../../..");
const CLI = join(WORKTREE, "src/index.ts");
const TSX = join(WORKTREE, "node_modules/.bin/tsx");
const STRYKER = join(WORKTREE, "node_modules/.bin/stryker");
const SHARED_MODULES = realpathSync(join(WORKTREE, "node_modules"));
const PROOFS = ".interlinked/test-runs/kill-proofs";
const SOURCE_FILE = "src/sign.ts";
const STORY_TEST = "src/sign.mutation-kill.test.ts";
const SLOW = 180_000;

// Chosen so that no Stryker mutant is equivalent under a complete test: every
// condition, literal and return is observable from sign(5), sign(-5) and sign(0).
const SOURCE = [
	"export function sign(n: number): number {",
	"\tif (n > 0) return 1;",
	"\tif (n < 0) return -1;",
	"\treturn 0;",
	"}",
	"",
].join("\n");
const WEAK_TEST = 'import { expect, it } from "vitest";\nimport { sign } from "./sign.js";\nit("returns a number", () => { expect(typeof sign(5)).toBe("number"); });\n';
const STRONG_TEST = [
	'import { expect, it } from "vitest";',
	'import { sign } from "./sign.js";',
	'it("positive is 1", () => { expect(sign(5)).toBe(1); expect(sign(0.5)).toBe(1); });',
	'it("negative is -1", () => { expect(sign(-5)).toBe(-1); expect(sign(-0.5)).toBe(-1); });',
	'it("zero is 0", () => { expect(sign(0)).toBe(0); });',
	"",
].join("\n");

let root = "";

interface CliRun { status: number; stdout: string; json: unknown; }

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("VITEST") && key !== "NODE_ENV") env[key] = value;
	return env;
}

function cli(args: string[]): CliRun {
	let status = 0, stdout = "";
	try {
		stdout = execFileSync(TSX, [CLI, ...args, "--cwd", root], { cwd: root, env: childEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const failed = error as { status?: number | null; stdout?: string };
		status = failed.status ?? -1;
		stdout = failed.stdout ?? "";
	}
	let json: unknown = null;
	try { json = JSON.parse(stdout); } catch { json = null; }
	return { status, stdout, json };
}

const BATCH = ["tests", "prove-kill", "--file", SOURCE_FILE, "--test", STORY_TEST, "--all-survivors"];
const batchJson = (extra: string[] = []): CliRun => cli([...BATCH, ...extra, "--json"]);
const asBatch = (run: CliRun): ProveKillBatchResult => run.json as ProveKillBatchResult;

function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

function receiptIds(): string[] {
	const dir = join(root, PROOFS);
	return existsSync(dir) ? readdirSync(dir).filter(name => /^[0-9a-f]{16}\.json$/.test(name)).sort() : [];
}

/** §1 of the manifest-route report: real Stryker over the throwaway, then the repo adapter. */
function buildManifestWithStryker(): { survivors: number; mutants: number } {
	write("stryker.conf.json", `${JSON.stringify({
		testRunner: "vitest", vitest: { configFile: "vitest.config.ts" }, mutate: [SOURCE_FILE], reporters: ["json"],
		jsonReporter: { fileName: "reports/mutation/mutation.json" }, coverageAnalysis: "perTest", incremental: false,
		ignorePatterns: ["/.interlinked", "/reports"], logLevel: "warn", tempDirName: ".stryker-tmp",
	})}\n`);
	execFileSync(STRYKER, ["run"], { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 150_000 });
	const report: unknown = JSON.parse(readFileSync(join(root, "reports/mutation/mutation.json"), "utf8"));
	const at = new Date().toISOString();
	const base = emptyManifest({ engine: "stryker", engineVersion: "9.6.1", dependencyGraphVersion: "0", environmentHash: "story", authoritativeAt: at });
	const manifest = seedFileBaseline({ base, file: SOURCE_FILE, content: SOURCE, report, at, cwd: root });
	if (manifest === null) throw new Error("seedFileBaseline refused the Stryker report");
	saveManifest(join(root, ".interlinked"), manifest);
	const index = writeSurvivorsIndex(join(root, ".interlinked"), manifest);
	const entry = index.files[SOURCE_FILE];
	if (entry === undefined) throw new Error("the sidecar has no entry for the source");
	return { survivors: entry.survivors.length, mutants: entry.mutantCount };
}

let measured = { survivors: 0, mutants: 0 };

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-batch-story-")));
	write("package.json", `${JSON.stringify({ name: "batch-story", type: "module", private: true })}\n`);
	write(".gitignore", "node_modules\n.interlinked\nreports\n.stryker-tmp\n");
	write("vitest.config.ts", "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"src/**/*.test.ts\"] } });\n");
	write(SOURCE_FILE, SOURCE);
	write(STORY_TEST, WEAK_TEST);
	symlinkSync(SHARED_MODULES, join(root, "node_modules"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["-c", "user.email=s@example.invalid", "-c", "user.name=s", "commit", "-qm", "story"], { cwd: root });
	measured = buildManifestWithStryker();
}, SLOW);

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("prove-kill --all-survivors story: weak test → every survivor stands → strong test → every survivor killed", () => {
	it("P0: the real Stryker run left survivors under the weak test, and the batch lists exactly the manifest's open survivors", () => {
		expect(measured.mutants).toBeGreaterThan(3);
		expect(measured.survivors).toBeGreaterThan(1);
		const listed = listFileSurvivors(root, SOURCE_FILE);
		expect(listed.ok && listed.mutantIds.length).toBe(measured.survivors);
		// The nudge now points at the batch form: the sidecar knows several survivors of the companion source.
		expect(killProofNudge({ root, relPath: STORY_TEST })).toContain(`interlinked tests prove-kill --file ${SOURCE_FILE} --test ${STORY_TEST} --all-survivors`);
	});

	it("P1: under the weak test every survivor SURVIVES in one command (exit 1), with one receipt per mutant and one shared baseline", { timeout: SLOW }, () => {
		const run = batchJson();
		expect(run.status).toBe(1);
		const batch = asBatch(run);
		expect(batch.file).toBe(SOURCE_FILE);
		expect(batch.tests).toEqual([STORY_TEST]);
		expect(batch.results).toHaveLength(measured.survivors);
		expect(batch.summary.survived).toBe(measured.survivors);
		expect(batch.summary.total).toBe(measured.survivors);
		expect(receiptIds()).toHaveLength(measured.survivors);
		const baselines = new Set(batch.results.map(row => (row.ok ? row.receipt.baseline.durationMs : -1)));
		expect(baselines.size).toBe(1); // one baseline run, its duration recorded on every receipt
		const human = cli(BATCH);
		expect(human.status).toBe(1);
		expect(human.stdout).toContain(`summary: 0 killed / ${measured.survivors} survived / 0 inconclusive / 0 unavailable of ${measured.survivors}`);
		expect(human.stdout).toContain("still pass these tests");
	});

	it("P2: --max 1 runs one survivor and says how many were skipped", { timeout: SLOW }, () => {
		const batch = asBatch(batchJson(["--max", "1"]));
		expect(batch.results).toHaveLength(1);
		expect(batch.skipped).toBe(measured.survivors - 1);
		expect(batch.max).toBe(1);
	});

	it("P3: under the strong test every survivor is KILLED (exit 0); each receipt names the killing case and --verify reads them", { timeout: SLOW }, () => {
		write(STORY_TEST, STRONG_TEST);
		const run = batchJson();
		const batch = asBatch(run);
		const verdicts = batch.results.map(row => (row.ok ? `${row.receipt.mutant.line}:${row.receipt.mutant.originalLexeme}→${row.receipt.mutant.replacement}=${row.receipt.verdict}` : row.verdict));
		expect(verdicts.filter(v => !v.endsWith("=killed"))).toEqual([]);
		expect(run.status).toBe(0);
		expect(batch.summary).toMatchObject({ killed: measured.survivors, survived: 0, total: measured.survivors });
		expect(batch.results.every(row => row.ok && row.receipt.killedTests.includes(STORY_TEST))).toBe(true);
		const verify = cli(["tests", "kill-proofs", "--verify", "--json"]).json as { receipts: { verdict: string; freshness?: string }[] };
		expect(verify.receipts.filter(row => row.verdict === "killed")).toHaveLength(measured.survivors);
		expect(killProofNudge({ root, relPath: STORY_TEST })).toBeNull();
	});

	it("N1: a file the manifest never measured is exit 2 with the measure command, and no receipt", { timeout: SLOW }, () => {
		write("src/other.ts", "export const other = 1;\n");
		const before = receiptIds();
		const run = cli(["tests", "prove-kill", "--file", "src/other.ts", "--test", STORY_TEST, "--all-survivors", "--json"]);
		expect(run.status).toBe(2);
		expect(asBatch(run).reasons?.[0]).toMatch(/is not in the mutation manifest/);
		expect(receiptIds()).toEqual(before);
	});

	it("N2: --all-survivors with --mutant is a usage error (exit 2)", () => {
		const run = cli([...BATCH, "--mutant", "0123456789abcdef"]);
		expect(run.status).toBe(2);
	});
});
