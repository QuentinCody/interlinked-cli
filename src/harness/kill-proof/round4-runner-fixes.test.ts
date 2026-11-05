// Kill proof — pins for the round-4 RUNNER fixes (docs/reviews/kill-proof-review-round4-runner.md,
// Resolution table). The review's own red cases live in review-regressions-round4-runner.test.ts;
// these pin the MECHANISM each fix relies on so a later refactor cannot remove it silently.
// Real-vitest fixtures are throwaway git repos; `node_modules` is a REAL directory of links to
// this checkout's entries, so anything a run writes under node_modules shows up in the fixture.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PRIVATE_VITEST_ARGS, runVitestDetailed } from "../fail-before-fix/index.js";

const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const NODE_MODULES = join(CHECKOUT, "node_modules");
const REAL_RUN_MS = 120_000;
const roots: string[] = [];

function makeRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4fix-")));
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
	// A real directory of links: a cache written to `<fixture>/node_modules/.vite` is visible HERE, not hidden in the checkout.
	mkdirSync(join(root, "node_modules"));
	for (const entry of readdirSync(NODE_MODULES)) symlinkSync(join(NODE_MODULES, entry), join(root, "node_modules", entry));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M2 — every vitest run is private: no results cache, a fresh tmpdir per run", () => {
	it("P1: the run passes --no-cache, points os.tmpdir() at a directory that is gone afterwards, and writes nothing under node_modules", async () => {
		const probe = 'import { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { writeFileSync("seen-tmpdir.txt", tmpdir()); expect(add(1, 2)).toBe(3); });\n';
		const root = makeRepo({ "test/probe.test.ts": probe });
		expect(PRIVATE_VITEST_ARGS).toContain("--no-cache");
		const before = readdirSync(join(root, "node_modules")).sort();
		const run = await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		expect(run.error).toBeUndefined();
		expect(run.cases.map(row => [row.name, row.status])).toEqual([["adds", "passed"]]);
		const seen = readFileSync(join(root, "seen-tmpdir.txt"), "utf8");
		expect(seen).not.toBe(tmpdir());
		expect(seen.startsWith(root)).toBe(false); // outside the project: a test asserting "tmp is not in-tree" still holds
		expect(existsSync(seen)).toBe(false); // removed with the run — nothing survives to the next one
		expect(readdirSync(join(root, "node_modules")).sort()).toEqual(before); // no `.vite` appeared
	}, REAL_RUN_MS);

	it("P2: two consecutive runs see two different tmpdirs (period-2 state through os.tmpdir() cannot line up with the mutant run)", async () => {
		const probe = 'import { appendFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { expect, it } from "vitest";\nit("records", () => { appendFileSync("tmpdirs.txt", tmpdir() + "\\n"); expect(1).toBe(1); });\n';
		const root = makeRepo({ "test/probe.test.ts": probe });
		await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		await runVitestDetailed(root, ["test/probe.test.ts"], 60_000);
		const lines = readFileSync(join(root, "tmpdirs.txt"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toBe(lines[1]);
	}, REAL_RUN_MS);
});
