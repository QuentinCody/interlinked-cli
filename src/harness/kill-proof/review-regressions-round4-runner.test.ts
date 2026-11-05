// Kill proof — adversarial review round 4, runner and copy semantics
// (docs/reviews/kill-proof-review-round4-runner.md). Every case was REPRODUCED against
// `mutation-proof` at 6f470b5 with the real `tests prove-kill` path and is expected to
// FAIL until the product code is fixed: a red test is the deliverable. N<n> = the proof
// must not report this verdict / must not have this side effect. Real-vitest fixtures
// are throwaway git repos whose node_modules links to this checkout's.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { proveKill } from "./run.js";

const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const NODE_MODULES = join(CHECKOUT, "node_modules");
const REAL_RUN_MS = 120_000;
const roots: string[] = [];
const strays: string[] = [];

/** Unique per test run: vitest's results cache is keyed by the project-relative path (review M2). */
const uniq = (): string => `${process.pid}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

function makeRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	const all: Record<string, string> = {
		".gitignore": "node_modules\n.interlinked\n",
		"package.json": '{"name":"fx","type":"module"}\n',
		"vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n',
		"src/math.ts": "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text.replaceAll("<ROOT>", root));
	}
	symlinkSync(NODE_MODULES, join(root, "node_modules"));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const path of strays.splice(0)) rmSync(path, { force: true });
});

const COMMENT_FAULT = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: "// helper: add 2 numbers" } as const;
const MINUS_FAULT = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
const ISOLATE_OFF = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], isolate: false, fileParallelism: false } });\n';
const tmpState = (name: string) => [
	'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
	'import { tmpdir } from "node:os";',
	'import { join } from "node:path";',
	'import { expect, it } from "vitest";',
	'import { add } from "../src/math";',
	`const STATE = join(tmpdir(), ${JSON.stringify(name)});`,
].join("\n");

describe("kill proof round 4 (runner) — negative (must not report / must not leave)", () => {
	it("N1: a test that fails only on its SECOND run does not turn a comment-only mutant into a kill", async () => {
		// review M1 — the repeat baseline is run 3; state that flips once (run 2 only) passes it
		const name = `kp-r4-count-${uniq()}`;
		strays.push(join(tmpdir(), name));
		const test = `${tmpState(name)}\nit("adds", () => {\n\tconst n = existsSync(STATE) ? Number(readFileSync(STATE, "utf8")) : 0;\n\twriteFileSync(STATE, String(n + 1));\n\texpect(add(1, 2)).toBe(3);\n\texpect(n).not.toBe(1);\n});\n`;
		const root = makeRepo({ "test/once.test.ts": test });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/once.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N2: a marker the first run creates and the second run deletes does not turn a comment-only mutant into a kill", async () => {
		// review M1 — period-2 state: create (pass), find + delete (fail), create (pass) = baseline/mutant/repeat
		const name = `kp-r4-toggle-${uniq()}`;
		strays.push(join(tmpdir(), name));
		const test = `${tmpState(name)}\nit("adds", () => {\n\tconst had = existsSync(STATE);\n\tif (had) rmSync(STATE); else writeFileSync(STATE, "x");\n\texpect(add(1, 2)).toBe(3);\n\texpect(had).toBe(false);\n});\n`;
		const root = makeRepo({ "test/toggle.test.ts": test });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/toggle.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N3: vitest's results cache in the SHARED node_modules does not reorder files into a kill of a comment-only mutant", async () => {
		// review M2 — run 1 orders by size, run 2 by cached duration, run 3 failed-first: order flips only for the mutant run
		const u = uniq();
		const padding = Array.from({ length: 200 }, (_, i) => `// padding ${i}: this file is the larger one`).join("\n");
		const x = `import { expect, it } from "vitest";\nimport { add } from "../src/math";\n${padding}\nit("runs before the slow file", () => { expect(add(1, 2)).toBe(3); expect((globalThis as Record<string, unknown>).__slowRan).toBeUndefined(); });\n`;
		const y = 'import { expect, it } from "vitest";\nit("slow sets shared state", async () => { await new Promise(r => setTimeout(r, 300)); (globalThis as Record<string, unknown>).__slowRan = true; expect(1).toBe(1); });\n';
		const root = makeRepo({ "vitest.config.ts": ISOLATE_OFF, [`test/x${u}.test.ts`]: x, [`test/y${u}.test.ts`]: y });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: [`test/x${u}.test.ts`, `test/y${u}.test.ts`], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N4: a proof does not write vitest's results cache into the live tree's node_modules", async () => {
		// review M2 (contract) — "the live tree is only read"; every copy's run lands in <root>/node_modules/.vite/vitest
		const u = uniq();
		const root = makeRepo({ [`test/c${u}.test.ts`]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n' });
		await proveKill({ root, spec: MINUS_FAULT, tests: [`test/c${u}.test.ts`], budgetMs: 60_000, persist: false });
		const cache = join(NODE_MODULES, ".vite", "vitest");
		const hits = existsSync(cache) ? readdirSync(cache).filter(dir => {
			const file = join(cache, dir, "results.json");
			return existsSync(file) && readFileSync(file, "utf8").includes(`c${u}.test.ts`);
		}) : [];
		expect(hits).toEqual([]);
	}, REAL_RUN_MS);

	it("N5: a setup file that loads the copy does not make the canary accept a test that reads the LIVE file", async () => {
		// review M3 — the canary asks "did any case break", not "did the tests load the mutated file"
		const root = makeRepo({
			"vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] } });\n',
			"test/setup.ts": 'import "../src/math";\n',
			"test/abs.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "<ROOT>/src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n',
		});
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/abs.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);

	it("N6: a canary run that TIMES OUT is not evidence that the tests loaded the copy", async () => {
		// review M4 — `canary.timedOut` falls through to "survived"; the same test without the delay is `unavailable`
		const name = `kp-r4-slow-${uniq()}`;
		strays.push(join(tmpdir(), name));
		const test = [
			'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
			'import { expect, it } from "vitest";',
			'import { add } from "<ROOT>/src/math";',
			`const STATE = ${JSON.stringify(join(tmpdir(), name))};`,
			'it("adds", async () => {',
			'\tconst n = existsSync(STATE) ? Number(readFileSync(STATE, "utf8")) : 0;',
			'\twriteFileSync(STATE, String(n + 1));',
			'\tif (n === 2) await new Promise(r => setTimeout(r, 30000)); // only the third run (the canary) outlives the budget',
			'\texpect(add(1, 2)).toBe(3);',
			'}, 60000);',
			'',
		].join("\n");
		const root = makeRepo({ "test/slow.test.ts": test });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/slow.test.ts"], budgetMs: 10_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);

	it("N7: two cases with the same full name are judged separately (a real kill is not reported SURVIVED)", async () => {
		// review M5 — judgeCases keys `file › name` into a Map, so the last duplicate hides the first one's failure
		const root = makeRepo({ "test/dup.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\nit("adds", () => { expect(typeof add).toBe("function"); });\n' });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/dup.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);

	it("N8: a run that hits --run-timeout leaves no vitest worker running test code after the proof returns", async () => {
		// review M6 — overlay-command-runner kills the direct child only; the forks worker outlives it and keeps writing
		const marker = join(tmpdir(), `kp-r4-orphan-${uniq()}`);
		strays.push(marker);
		const test = `import { writeFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("slow", async () => { await new Promise(r => setTimeout(r, 6000)); writeFileSync(${JSON.stringify(marker)}, process.cwd()); expect(add(1, 2)).toBe(3); }, 20000);\n`;
		const root = makeRepo({ "test/slow.test.ts": test });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/slow.test.ts"], budgetMs: 2_000, persist: false });
		expect(result.ok).toBe(false); // precondition: the baseline timed out
		await new Promise(r => setTimeout(r, 7_000));
		expect(existsSync(marker)).toBe(false);
	}, REAL_RUN_MS);

	it("N9: the documented whole-command `--timeout` is accepted by prove-kill (not a usage error that exits 1 = survived)", () => {
		// review M7 — the supervisor reads --timeout, then commander rejects it: `error: unknown option '--timeout'`, exit 1
		const root = makeRepo({ "test/t.test.ts": 'import { it } from "vitest";\nit("x", () => {});\n' });
		const run = spawnSync(process.execPath, [join(NODE_MODULES, "tsx", "dist", "cli.mjs"), join(CHECKOUT, "src", "index.ts"), "tests", "prove-kill", "--cwd", root, "--test", "test/missing.test.ts", "--file", "src/math.ts", "--find", "return a + b;", "--replace", "return a - b;", "--json", "--timeout", "600000"], { encoding: "utf8", timeout: 90_000 });
		expect(run.stderr).not.toContain("unknown option '--timeout'");
		expect(run.status).not.toBe(1);
	}, REAL_RUN_MS);
});
