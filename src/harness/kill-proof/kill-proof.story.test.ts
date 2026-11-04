// Product story for `interlinked tests prove-kill` / `tests kill-proofs`, driven
// through the CLI from source against a throwaway git repository with the REAL
// vitest runner (the unit tests in kill-proof.test.ts use a fake runner).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import { readKillProofIndex } from "./receipt.js";

const WORKTREE = resolve(import.meta.dirname, "../../..");
const CLI = join(WORKTREE, "src/index.ts");
const TSX = join(WORKTREE, "node_modules/.bin/tsx");
const SHARED_MODULES = realpathSync(join(WORKTREE, "node_modules"));
const PROOFS = ".interlinked/test-runs/kill-proofs";
const STORY_TEST = "src/clamp.mutation-kill.test.ts";
const SLOW = 60_000;

const SOURCE = [
	"export function clamp(n: number, max: number): number {",
	"\treturn n > max ? max : n;",
	"}",
	"export function double(n: number): number {",
	"\treturn n * 2;",
	"}",
	"",
].join("\n");

let root = "";

interface CliRun { status: number; stdout: string; json: unknown; }

/** The child env without the outer vitest's markers, so the inner vitest starts clean. */
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
	try {
		json = JSON.parse(stdout);
	} catch {
		json = null;
	}
	return { status, stdout, json };
}

// `n > max` → `n >= max` is an EQUIVALENT mutant for clamp (at n === max both
// branches return the same value), so no assertion can kill it: the engine
// correctly reports it `survived`. The story uses a non-equivalent fault.
const FAULT = ["--file", "src/clamp.ts", "--find", "n > max", "--replace", "n < max"];
const proveJson = (test: string, fault: string[] = FAULT): CliRun => cli(["tests", "prove-kill", "--test", test, ...fault, "--json"]);

function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

function receiptIds(): string[] {
	const dir = join(root, PROOFS);
	return existsSync(dir) ? readdirSync(dir).filter(name => /^[0-9a-f]{16}\.json$/.test(name)).sort() : [];
}

interface ReceiptJson { ok: boolean; verdict?: string; reasons?: string[]; receiptPath?: string; receipt?: { id: string; verdict: string; reasons: string[]; underMutant: { cases: { test: string; verdict: string; reason?: string }[] } } }
const asResult = (run: CliRun): ReceiptJson => run.json as ReceiptJson;

interface VerifyRow { id: string; verdict: string; freshness?: string; reasons?: string[] }
function verifyRows(): VerifyRow[] {
	return (cli(["tests", "kill-proofs", "--verify", "--json"]).json as { receipts: VerifyRow[] }).receipts;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-story-")));
	write("package.json", `${JSON.stringify({ name: "story", type: "module", private: true })}\n`);
	write(".gitignore", "node_modules\n.interlinked\n");
	write("vitest.config.ts", "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"src/**/*.test.ts\"] } });\n");
	write("src/clamp.ts", SOURCE);
	symlinkSync(SHARED_MODULES, join(root, "node_modules"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("prove-kill story: weak test → strengthened test → stale proof", () => {
	it("P1: a typeof-only assertion survives the fault; a receipt is written and the agent is told to strengthen it", { timeout: SLOW }, () => {
		write(STORY_TEST, "import { expect, it } from \"vitest\";\nimport { clamp } from \"./clamp.js\";\nit(\"caps\", () => { expect(typeof clamp(5, 3) === \"number\").toBe(true); });\n");
		const run = proveJson(STORY_TEST);
		expect(run.status).toBe(1);
		const result = asResult(run);
		expect(result.ok).toBe(true);
		expect(result.receipt?.verdict).toBe("survived");
		expect(result.receiptPath && existsSync(result.receiptPath)).toBe(true);
		const human = cli(["tests", "prove-kill", "--test", STORY_TEST, ...FAULT]);
		expect(human.status).toBe(1);
		expect(human.stdout).toContain("Strengthen the assertion");
	});

	it("P2: an exact-value assertion kills the fault; the receipt names the case, kill-proofs --verify says FRESH, the nudge goes quiet", { timeout: SLOW }, () => {
		write(STORY_TEST, "import { expect, it } from \"vitest\";\nimport { clamp } from \"./clamp.js\";\nit(\"caps at max\", () => { expect(clamp(5, 3)).toBe(3); expect(clamp(3, 3)).toBe(3); });\n");
		const run = proveJson(STORY_TEST);
		expect(run.status).toBe(0);
		const result = asResult(run);
		expect(result.receipt?.verdict).toBe("killed");
		const onDisk = JSON.parse(readFileSync(result.receiptPath ?? "", "utf8")) as NonNullable<ReceiptJson["receipt"]>;
		expect(onDisk.verdict).toBe("killed");
		expect(onDisk.underMutant.cases).toContainEqual({ test: `${STORY_TEST} › caps at max`, verdict: "killed" });
		// Only a KILLED receipt carries evidence, so --verify exits 1 only for a stale
		// killed receipt. P1's `survived` receipt names the old test bytes: listed as
		// STALE, but it does not fail the check while the kill itself is FRESH.
		const rows = verifyRows();
		expect(rows.find(row => row.id === onDisk.id)).toMatchObject({ verdict: "killed", freshness: "fresh" });
		expect(rows.find(row => row.verdict === "survived")).toMatchObject({ freshness: "stale" });
		const verify = cli(["tests", "kill-proofs", "--verify"]);
		expect(verify.status).toBe(0);
		expect(verify.stdout).toContain("FRESH");
		expect(killProofNudge({ root, relPath: STORY_TEST })).toBeNull();
		// Only the killed receipt left: still exit 0.
		for (const row of rows) if (row.id !== onDisk.id) rmSync(join(root, PROOFS, `${row.id}.json`));
		expect(cli(["tests", "kill-proofs", "--verify"]).status).toBe(0);
	});

	it("N7: re-proving unchanged bytes yields the same receipt id and no duplicate index row", { timeout: SLOW }, () => {
		const before = readKillProofIndex(root).receipts.find(row => row.verdict === "killed");
		const run = proveJson(STORY_TEST);
		expect(run.status).toBe(0);
		expect(asResult(run).receipt?.id).toBe(before?.id);
		const ids = readKillProofIndex(root).receipts.map(row => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter(id => id === before?.id)).toHaveLength(1);
	});

	it("P3: editing the source makes the proof stale for --verify (exit 1) and for the PostToolUse nudge", { timeout: SLOW }, () => {
		writeFileSync(join(root, "src/clamp.ts"), `${SOURCE}// touched\n`);
		const verify = cli(["tests", "kill-proofs", "--verify"]);
		expect(verify.status).toBe(1);
		expect(verify.stdout).toContain("changed since the proof");
		expect(killProofNudge({ root, relPath: STORY_TEST })).toContain("went stale");
		writeFileSync(join(root, "src/clamp.ts"), SOURCE);
	});
});

describe("prove-kill refusals (real runner)", () => {
	it("N1: an unknown mutant id is unavailable (exit 2) and writes no receipt", { timeout: SLOW }, () => {
		const before = receiptIds();
		const run = cli(["tests", "prove-kill", "--test", STORY_TEST, "--mutant", "deadbeefdeadbeef", "--json"]);
		expect(run.status).toBe(2);
		expect(asResult(run)).toMatchObject({ ok: false, verdict: "unavailable" });
		expect(receiptIds()).toEqual(before);
	});

	it("N2: a named test that fails live is not-passing-now (exit 1) and writes no receipt", { timeout: SLOW }, () => {
		write("src/clamp.wrong.test.ts", "import { expect, it } from \"vitest\";\nimport { clamp } from \"./clamp.js\";\nit(\"wrong\", () => { expect(clamp(5, 3)).toBe(4); });\n");
		const before = receiptIds();
		const run = cli(["tests", "prove-kill", "--test", "src/clamp.wrong.test.ts", ...FAULT]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("NOT-PASSING-NOW");
		expect(receiptIds()).toEqual(before);
	});

	it("N3: a test that mocks the implementation away survives the fault (exit 1)", { timeout: SLOW }, () => {
		write("src/clamp.mocked.test.ts", "import { expect, it, vi } from \"vitest\";\nvi.mock(\"./clamp.js\", () => ({ clamp: () => 3 }));\nimport { clamp } from \"./clamp.js\";\nit(\"mocked\", () => { expect(clamp(5, 3)).toBe(3); });\n");
		const run = proveJson("src/clamp.mocked.test.ts");
		expect(run.status).toBe(1);
		expect(asResult(run).receipt?.verdict).toBe("survived");
	});

	it("N4: an assertion on the unmutated function survives the fault", { timeout: SLOW }, () => {
		write("src/clamp.other.test.ts", "import { expect, it } from \"vitest\";\nimport { double } from \"./clamp.js\";\nit(\"doubles\", () => { expect(double(2)).toBe(4); });\n");
		const run = proveJson("src/clamp.other.test.ts");
		expect(run.status).toBe(1);
		expect(asResult(run).receipt?.verdict).toBe("survived");
	});

	it("N5: a fault that throws at module load is inconclusive (exit 2), never a kill", { timeout: SLOW }, () => {
		const loadFault = ["--file", "src/clamp.ts", "--find", "export function clamp", "--replace", "throw new Error(\"boom\");\nexport function clamp"];
		const run = proveJson(STORY_TEST, loadFault);
		expect(run.status).toBe(2);
		const receipt = asResult(run).receipt;
		expect(receipt?.verdict).toBe("inconclusive");
		expect(receipt?.underMutant.cases.every(row => row.verdict === "inconclusive")).toBe(true);
		expect(receipt?.reasons.join("\n")).toMatch(/no result under the mutant|boom|failed|skipped/);
	});

	// Flakiness limitation: one baseline run plus one mutant run cannot detect a
	// flaky test. A test that fails at random may be reported `not-passing-now`
	// or, worse, `killed`. The engine does not detect flakiness by itself; this
	// case only pins that an assertion independent of the code under test (here,
	// a random value that always satisfies the bound) is not a kill.
	it("N6: a random-valued assertion that always passes survives the fault (flakiness is not detected by one run)", { timeout: SLOW }, () => {
		write("src/clamp.random.test.ts", "import { expect, it } from \"vitest\";\nimport { clamp } from \"./clamp.js\";\nit(\"random\", () => { clamp(5, 3); expect(Math.random()).toBeLessThan(2); });\n");
		const run = proveJson("src/clamp.random.test.ts");
		expect(run.status).toBe(1);
		expect(asResult(run).receipt?.verdict).toBe("survived");
	});

	it("N8: naming the mutated source as a test is unavailable (exit 2)", { timeout: SLOW }, () => {
		const run = proveJson("src/clamp.ts");
		expect(run.status).toBe(2);
		expect(asResult(run)).toMatchObject({ ok: false, verdict: "unavailable" });
	});
});
