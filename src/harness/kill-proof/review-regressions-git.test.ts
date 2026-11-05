// Review regressions: `tests prove-kill` / `tests kill-proofs` under real git and
// platform conditions (cloud/git-edge-cases, 2026-11-05). Each N<n> case drives the
// REAL command (tsx + src/index.ts, real vitest) against a throwaway git repository
// and states the CORRECT behaviour. Every case here FAILED on landing: the product
// code is deliberately not fixed on this branch. Write-up and causes:
// docs/reviews/kill-proof-git-edge-cases.md.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WORKTREE = resolve(import.meta.dirname, "../../..");
const CLI = join(WORKTREE, "src/index.ts");
const TSX = join(WORKTREE, "node_modules/.bin/tsx");
const SHARED_MODULES = realpathSync(join(WORKTREE, "node_modules"));
const SLOW = 90_000;

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const FAULT = ["--find", "n > max", "--replace", "n < max"];
const strongTest = (from: string): string =>
	`import { expect, it } from "vitest";\nimport { clamp } from "${from}";\nit("caps at max", () => { expect(clamp(5, 3)).toBe(3); expect(clamp(2, 3)).toBe(2); });\n`;
const CONFIG = (extra = "", test = 'include: ["src/**/*.test.ts"]'): string =>
	`import { defineConfig } from "vitest/config";\nexport default defineConfig({ ${extra}test: { ${test} } });\n`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.email=r@example.invalid", "-c", "user.name=r", ...args], { cwd: root, stdio: "ignore" });
}

function put(root: string, path: string, text: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

/** A committed repo: package.json, .gitignore (node_modules, .interlinked + extra), node_modules linked. */
function repo(files: Record<string, string>, ignore: string[] = []): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-git-")));
	roots.push(root);
	put(root, "package.json", `${JSON.stringify({ name: "edge", type: "module", private: true })}\n`);
	put(root, ".gitignore", ["node_modules", ".interlinked", ...ignore, ""].join("\n"));
	for (const [path, text] of Object.entries(files)) put(root, path, text.replaceAll("$ROOT", root));
	symlinkSync(SHARED_MODULES, join(root, "node_modules"));
	git(root, "init", "-q");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	return root;
}

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("VITEST") && key !== "NODE_ENV") env[key] = value;
	return env;
}

interface Run { status: number; json: { ok?: boolean; verdict?: string; reasons?: string[]; receipt?: { verdict: string } } & { receipts?: { verdict: string; freshness?: string; reasons?: string[] }[] }; }

function cli(root: string, args: string[]): Run {
	let status = 0, stdout = "";
	try {
		stdout = execFileSync(TSX, [CLI, ...args, "--cwd", root, "--json"], { cwd: root, env: childEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		const failed = error as { status?: number | null; stdout?: string };
		status = failed.status ?? -1;
		stdout = failed.stdout ?? "";
	}
	return { status, json: JSON.parse(stdout) as Run["json"] };
}

const prove = (root: string, test: string, file = "src/clamp.ts"): Run => cli(root, ["tests", "prove-kill", "--test", test, "--file", file, ...FAULT]);
/** The verdict a result reports, whether it carries a receipt or not. */
const verdictOf = (run: Run): string | undefined => run.json.receipt?.verdict ?? run.json.verdict;

describe("prove-kill under git/platform edge cases — negative (must not report a false verdict)", () => {
	// Scenario 1d: the imported source path is an ABSOLUTE symlink into the same repo; the copy keeps the link verbatim,
	// so the tests load the LIVE target and never see the mutant written into the copy's lib/clamp.ts.
	it("N1: an absolute in-repo source symlink does not turn a real kill into SURVIVED", { timeout: SLOW }, () => {
		const root = repo({ "lib/clamp.ts": SOURCE, "src/clamp.test.ts": strongTest("./clamp.js"), "vitest.config.ts": CONFIG() });
		symlinkSync(join(root, "lib/clamp.ts"), join(root, "src/clamp.ts"));
		git(root, "add", "-A");
		const run = prove(root, "src/clamp.test.ts", "lib/clamp.ts");
		expect(verdictOf(run)).not.toBe("survived");
		expect(run.status).not.toBe(1);
	});

	// Scenario 2d: the named TEST file is an absolute symlink into the same repo; in the copy it resolves to the live
	// test, whose relative import reaches the LIVE source.
	it("N2: an absolute in-repo test symlink does not turn a real kill into SURVIVED", { timeout: SLOW }, () => {
		const root = repo({ "src/clamp.ts": SOURCE, "tests/real.ts": strongTest("../src/clamp.js"), "vitest.config.ts": CONFIG() });
		symlinkSync(join(root, "tests/real.ts"), join(root, "src/clamp.test.ts"));
		git(root, "add", "-A");
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("survived");
		expect(run.status).not.toBe(1);
	});

	// Scenario 5d: an IGNORED fixture the test reads is not in the git-visible copy, so the baseline fails there — and is
	// reported as NOT-PASSING-NOW ("fails on the live tree", exit 1) although the test passes on the live tree.
	it("N3: an ignored fixture missing from the copy is not reported as the test failing on the live tree", { timeout: SLOW }, () => {
		const test = 'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nimport { clamp } from "./clamp.js";\nit("table", () => { for (const [n, m, want] of JSON.parse(readFileSync("fixtures/cases.json", "utf8"))) expect(clamp(n, m)).toBe(want); });\n';
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": test, "vitest.config.ts": CONFIG(), "fixtures/cases.json": "[[5,3,3],[2,3,2]]\n" }, ["fixtures/"]);
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("not-passing-now");
		expect(run.status).toBe(2);
	});

	// Scenario 5e: the same ignored fixture read optionally (`existsSync ? … : []`): in the copy the table is empty, the
	// case passes vacuously on both sides, and the run reports SURVIVED for a test that kills the fault on the live tree.
	// KNOWN GAP, documented in docs/mutation-grounded-test-proof.md "Limits": ignored data is never copied, so a test that
	// reads it optionally passes vacuously in the copy. Neither copy nor a live baseline can tell; kept as a todo.
	it.todo("N4 (known gap): an ignored optional fixture does not produce a vacuous SURVIVED", { timeout: SLOW }, () => {
		const test = 'import { existsSync, readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nimport { clamp } from "./clamp.js";\nconst rows = existsSync("fixtures/cases.json") ? JSON.parse(readFileSync("fixtures/cases.json", "utf8")) : [];\nit("table", () => { for (const [n, m, want] of rows) expect(clamp(n, m)).toBe(want); });\n';
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": test, "vitest.config.ts": CONFIG(), "fixtures/cases.json": "[[5,3,3],[2,3,2]]\n" }, ["fixtures/"]);
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("survived");
	});

	// Scenario 9f: the project's tests run under a non-default config (`vitest --config vitest.unit.config.ts`, which
	// declares a setupFile). prove-kill has no --config and runs vitest's default discovery, so the baseline fails in the
	// copy and is reported NOT-PASSING-NOW although `npm test` passes.
	it("N5: a project-declared non-default vitest config is honoured (or the run is unavailable, not NOT-PASSING-NOW)", { timeout: SLOW }, () => {
		const test = 'import { expect, it } from "vitest";\nimport { clamp } from "./clamp.js";\nit("caps at max", () => { expect(clamp(5, (globalThis as { LIMIT?: number }).LIMIT ?? 0)).toBe(3); });\n';
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": test, "vitest.unit.config.ts": CONFIG("", 'include: ["src/**/*.test.ts"], setupFiles: ["./setup.ts"]'), "setup.ts": "(globalThis as { LIMIT?: number }).LIMIT = 3;\n" });
		put(root, "package.json", `${JSON.stringify({ name: "edge", type: "module", private: true, scripts: { test: "vitest --config vitest.unit.config.ts" } })}\n`);
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("not-passing-now");
	});

	// Scenario 10b: a vi.mock factory returns the module by its ABSOLUTE live path; the copy's mutated file is never
	// loaded, and the run reports SURVIVED.
	it("N6: a vi.mock factory that imports the live source by absolute path does not yield SURVIVED", { timeout: SLOW }, () => {
		const test = 'import { expect, it, vi } from "vitest";\nimport { clamp } from "./clamp.js";\nvi.mock("./clamp.js", async () => await import("$ROOT/src/clamp.ts"));\nit("caps at max", () => { expect(clamp(5, 3)).toBe(3); expect(clamp(2, 3)).toBe(2); });\n';
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": test, "vitest.config.ts": CONFIG() });
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("survived");
	});

	// Scenario 10c: `resolve.alias` hardcoded to the live tree's absolute src/; the copy's tests import the live source.
	it("N7: an absolute resolve.alias into the live tree does not yield SURVIVED", { timeout: SLOW }, () => {
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": strongTest("@src/clamp.js"), "vitest.config.ts": CONFIG('resolve: { alias: { "@src": "$ROOT/src" } }, ') });
		const run = prove(root, "src/clamp.test.ts");
		expect(verdictOf(run)).not.toBe("survived");
	});
});

describe("kill-proofs --verify under git edge cases — negative (must not report FRESH for bytes it did not certify)", () => {
	// Scenario 7: the index holds a WEAK test (typeof only), the work tree a strong one. The proof certifies the work
	// tree; after the weak staged version is committed, --verify still says FRESH and exits 0 — a commit-time reader
	// is told the committed test kills a fault it survives.
	it("N8: a receipt whose test differs between index and work tree is not FRESH without saying so", { timeout: SLOW }, () => {
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": strongTest("./clamp.js"), "vitest.config.ts": CONFIG() });
		put(root, "src/clamp.test.ts", 'import { expect, it } from "vitest";\nimport { clamp } from "./clamp.js";\nit("caps at max", () => { expect(typeof clamp(5, 3)).toBe("number"); });\n');
		git(root, "add", "src/clamp.test.ts");
		put(root, "src/clamp.test.ts", strongTest("./clamp.js"));
		expect(verdictOf(prove(root, "src/clamp.test.ts"))).toBe("killed");
		git(root, "commit", "-qm", "commit the weak staged test");
		const verify = cli(root, ["tests", "kill-proofs", "--verify"]);
		const row = verify.json.receipts?.find(item => item.verdict === "killed");
		expect(row?.freshness).not.toBe("fresh");
	});

	// Scenario 9d: the bound vitest config names a setupFile; editing it after the proof makes the test FAIL on the live
	// tree, yet --verify reports FRESH (the config's bytes are bound, the files it declares are not).
	it("N9: editing a config-declared setupFile stales the receipt", { timeout: SLOW }, () => {
		const test = 'import { expect, it } from "vitest";\nimport { clamp } from "./clamp.js";\nit("caps at max", () => { expect(clamp(5, (globalThis as { LIMIT?: number }).LIMIT ?? 0)).toBe(3); });\n';
		const root = repo({ "src/clamp.ts": SOURCE, "src/clamp.test.ts": test, "vitest.config.ts": CONFIG("", 'include: ["src/**/*.test.ts"], setupFiles: ["./setup.ts"]'), "setup.ts": "(globalThis as { LIMIT?: number }).LIMIT = 3;\n" });
		expect(verdictOf(prove(root, "src/clamp.test.ts"))).toBe("killed");
		put(root, "setup.ts", "(globalThis as { LIMIT?: number }).LIMIT = 99;\n");
		const verify = cli(root, ["tests", "kill-proofs", "--verify"]);
		expect(verify.json.receipts?.find(item => item.verdict === "killed")?.freshness).toBe("stale");
		expect(verify.status).toBe(1);
	});
});
