// Kill proof — adversarial review round 2 (docs/reviews/kill-proof-review-round2.md).
// Every case here was REPRODUCED against the real `tests prove-kill` command and is
// expected to FAIL until the product code is fixed: a red test is the deliverable.
// N<n> = the system must NOT report a kill / must NOT be discharged; P<n> = a real
// situation must NOT be misreported. Real-vitest cases build a throwaway git repo
// whose node_modules links to this checkout's.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { detectMutationKillEvidenceGaps } from "../mutation-kill-evidence-stop-check.js";
import { killProofsDir, readKillProof, rebuildKillProofIndex } from "./receipt.js";
import { freshKillsForTest, verifyKillProof } from "./receipt-freshness.js";
import { proveKill } from "./run.js";

const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const REAL_RUN_MS = 90_000;
const roots: string[] = [];

function makeRepo(files: Record<string, string>, opts: { linkModules?: boolean } = {}): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r2-")));
	roots.push(root);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	git("init", "-q");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	if (opts.linkModules) symlinkSync(NODE_MODULES, join(root, "node_modules"));
	git("add", ".");
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MATH = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const CONFIG = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n';
const realRepo = (tests: Record<string, string>, extra: Record<string, string> = {}) =>
	makeRepo({ ".gitignore": "node_modules\n.interlinked\n", "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": CONFIG, "src/math.ts": MATH, ...tests, ...extra }, { linkModules: true });

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const pass = (file: string, name: string): Case => ({ file, name, title: name, status: "passed" });
const fail = (file: string, name: string): Case => ({ file, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" });
/** Answers by what the copy holds: unmutated → baseline (also the repeat baseline after a kill), mutated → mutated,
 *  the reachability canary → every case fails (the tests DID load the file). */
function scripted(baseline: VitestRun, mutated: VitestRun) {
	const loaded: VitestRun = okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: interlinked kill-proof canary" })));
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		if (source.includes("kill-proof canary")) return loaded;
		return source === UNIT_SOURCE ? baseline : mutated;
	};
}

const UNIT_SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const UNIT_SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;
const WEAK = "src/clamp.mutation-kill.test.ts";

/** A real SURVIVED receipt on disk for WEAK (the test asserts nothing the mutant changes). The test imports the
 *  source by a relative path: since round 4 (M3) a survivor is attributable only when the tests themselves load the
 *  copy's file, and a scripted canary break with no import at all reads as a setup-file break. */
async function survivedReceipt(): Promise<{ root: string; id: string }> {
	const root = makeRepo({ "src/clamp.ts": UNIT_SOURCE, [WEAK]: "import { clamp } from './clamp.js';\nit('weak', () => { expect(clamp).toBeDefined(); });\n" });

	const runner = scripted(okRun([pass(WEAK, "weak")]), okRun([pass(WEAK, "weak")]));
	const result = await proveKill({ root, spec: UNIT_SPEC, tests: [WEAK], budgetMs: 1000, runner });
	if (!result.ok || result.receipt.verdict !== "survived") throw new Error("fixture: expected a survived receipt");
	return { root, id: result.receipt.id };
}

describe("kill proof round 2 — negative (must not report a kill)", () => {
	it("N1: a test that fails on its second run (state left by the baseline in the shared copy) does not kill a comment-only mutant", async () => {
		// review K1 — run.ts runs baseline and mutant in ONE copy; leftover state reads as a kill
		const root = realRepo({
			"test/state.test.ts": [
				'import { existsSync, writeFileSync } from "node:fs";',
				'import { join } from "node:path";',
				'import { expect, it } from "vitest";',
				'import { add } from "../src/math";',
				'it("adds once", () => {',
				'\tconst marker = join(__dirname, ".ran");',
				"\tconst first = !existsSync(marker);",
				'\twriteFileSync(marker, "x");',
				"\texpect(add(1, 2)).toBe(3);",
				"\texpect(first).toBe(true);",
				"});",
				"",
			].join("\n"),
		});
		const spec = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: "// helper: add 2 numbers" } as const;
		const result = await proveKill({ root, spec, tests: ["test/state.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N2: a forged index row (verdict killed, killedTests naming the file) over a SURVIVED receipt does not silence the nudge or the Stop count", async () => {
		// review K2 — freshKillsForTest / killProofNudge trust the row's verdict and killedTests, not the receipt's
		const { root, id } = await survivedReceipt();
		const indexPath = join(killProofsDir(root), "index.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8"));
		index.receipts = index.receipts.map((row: { id: string }) => (row.id === id ? { ...row, verdict: "killed", killedTests: [WEAK] } : row));
		writeFileSync(indexPath, JSON.stringify(index));
		expect(freshKillsForTest(root, WEAK)).toHaveLength(0);
		expect(killProofNudge({ root, relPath: WEAK })).not.toBeNull();
	});

	it("N3: a SURVIVED receipt edited consistently (cases, verdict, killedTests) is not FRESH evidence", async () => {
		// review K3 — receiptId binds no outcome field, so the edit keeps a valid id
		const { root, id } = await survivedReceipt();
		const path = join(killProofsDir(root), `${id}.json`);
		const receipt = JSON.parse(readFileSync(path, "utf8"));
		receipt.verdict = "killed";
		receipt.underMutant.cases[0].verdict = "killed";
		receipt.killedTests = [WEAK];
		writeFileSync(path, JSON.stringify(receipt));
		writeFileSync(join(killProofsDir(root), "index.json"), JSON.stringify(rebuildKillProofIndex(root)));
		const forged = readKillProof(root, id);
		expect(forged).not.toBeNull();
		if (forged === null) return;
		expect(verifyKillProof(root, forged).fresh).toBe(false);
		expect(freshKillsForTest(root, WEAK)).toHaveLength(0);
	});

	it("N4: a kill by an OLD case does not discharge the Stop gap for a NEW case that kills nothing", async () => {
		// review K4 — the Stop check counts any fresh killed receipt naming the file, whichever case killed
		const oldCase = "// test-contract: bug — caps at max\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
		const newCase = "// test-contract: bug — kills the boundary mutant\nit('kills boundary', () => { expect(typeof clamp).toBe('function'); });\n";
		const root = makeRepo({ "src/clamp.ts": UNIT_SOURCE, [WEAK]: oldCase + newCase });
		const runner = scripted(okRun([pass(WEAK, "caps"), pass(WEAK, "kills boundary")]), okRun([fail(WEAK, "caps"), pass(WEAK, "kills boundary")]));
		const result = await proveKill({ root, spec: UNIT_SPEC, tests: [WEAK], budgetMs: 1000, runner });
		expect(result.ok && result.receipt.verdict).toBe("killed");
		const abs = join(root, WEAK);
		const gaps = (freshKillProofs?: () => number) => detectMutationKillEvidenceGaps({
			filesWritten: new Set([abs]),
			fileWriteTimes: new Map([[abs, new Date().toISOString()]]),
			gitHeadSha: "deadbeef",
			cwd: root,
			gitShow: () => oldCase,
			readFile: file => readFileSync(file, "utf8"),
			loadMutationManifest: () => null,
			...(freshKillProofs ? { freshKillProofs } : {}),
		});
		expect(gaps(() => 0)[0]?.staleMeasurement).toBe(true); // precondition: without a receipt the gap fires
		expect(gaps()[0]?.staleMeasurement).toBe(true);
	});

	it("N5: a syntax-invalid replacement caught by a try/catch import check is not a kill", async () => {
		// review K5 — a load failure the test turns into an assertion is a compile error, not a killed mutant
		const root = realRepo({
			"test/catch.test.ts": [
				'import { expect, it } from "vitest";',
				'it("module is importable", async () => {',
				"\tlet loaded = true;",
				'\ttry { await import("../src/math"); } catch { loaded = false; }',
				"\texpect(loaded).toBe(true);",
				"});",
				"",
			].join("\n"),
		});
		const spec = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a + ;" } as const;
		const result = await proveKill({ root, spec, tests: ["test/catch.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);
});

describe("kill proof round 2 — positive (a real situation must not be misreported)", () => {
	it("P1: a test that passes live but needs an ignored fixture is not reported NOT-PASSING-NOW", async () => {
		// review K6 — the baseline runs in the copy, which lacks ignored files; the verdict blames the test
		const root = realRepo(
			{
				"test/fixture.test.ts": [
					'import { readFileSync } from "node:fs";',
					'import { join } from "node:path";',
					'import { expect, it } from "vitest";',
					'import { add } from "../src/math";',
					'it("matches fixture", () => {',
					'\tconst c = JSON.parse(readFileSync(join(__dirname, "fixtures/case.json"), "utf8"));',
					"\texpect(add(c.a, c.b)).toBe(c.sum);",
					"});",
					"",
				].join("\n"),
			},
			{ ".gitignore": "node_modules\n.interlinked\ntest/fixtures/\n", "test/fixtures/case.json": '{"a":1,"b":2,"sum":3}\n' },
		);
		const spec = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
		const result = await proveKill({ root, spec, tests: ["test/fixture.test.ts"], budgetMs: 60_000, persist: false });
		expect(!result.ok && result.verdict).not.toBe("not-passing-now");
	}, REAL_RUN_MS);

	it("P2: a named test that resolves to code outside the copy is not reported SURVIVED", async () => {
		// review K11 — a symlinked test importing the live source runs against unmutated code
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r2-out-")));
		roots.push(outside);
		const root = realRepo({});
		writeFileSync(
			join(outside, "ext.test.ts"),
			`import { expect, it } from "vitest";\nimport { add } from ${JSON.stringify(join(root, "src/math"))};\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n`,
		);
		mkdirSync(join(root, "test"), { recursive: true });
		symlinkSync(join(outside, "ext.test.ts"), join(root, "test/ext.test.ts"));
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const spec = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
		const result = await proveKill({ root, spec, tests: ["test/ext.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);
});
