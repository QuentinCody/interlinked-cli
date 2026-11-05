// Kill proof — round-4 layouts fixes (docs/reviews/kill-proof-review-round4-layouts.md, Resolution table).
// The red cases live in review-regressions-round4-layouts.test.ts; this file pins each fix from the other side:
// the behaviour the fix introduced (positive) and the refusal it must keep (negative). Scripted runners exercise
// resolution and binding without vitest; `nearestVitestBin` and the hoisted copy use real directories only.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderKillProofs } from "../../commands/tests-prove-kill.js";
import { parseVitestSuiteFailures } from "../fail-before-fix/classify.js";
import { nearestVitestBin, STDERR_HEAD_BYTES, stderrHead, type VitestRun } from "../fail-before-fix/index.js";
import { createProjectCopyAsync } from "../fail-before-fix/snapshot.js";
import { bindVitestConfig } from "./config-binding.js";
import { verifyKillProof } from "./receipt-freshness.js";
import { captureEnvironment, parseKillProof, resolveVitestConfig } from "./receipt.js";
import { explicitVitestConfig, hoistLayout, missingVitest, mutantParses, vitestHome } from "./proof-preconditions.js";
import { proveKill, type ProveKillOptions } from "./run.js";

const roots: string[] = [];
function makeRepo(files: Record<string, string>, dirs: readonly string[] = []): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4fix-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	writeFileSync(join(root, ".gitignore"), "node_modules\n.interlinked\n");
	for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MATH = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const MATH_TEST = 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n';
const MINUS = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
const okRun = (cases: VitestRun["cases"]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
/** Answers by the copy's source: unmutated → pass, the minus mutant (or the canary) → the assertion fails. */
const killing: NonNullable<ProveKillOptions["runner"]> = async dir => okRun([{ file: "test/math.test.ts", name: "adds", title: "adds", status: readFileSync(join(dir, "src/math.ts"), "utf8") === MATH ? "passed" : "failed", message: "AssertionError: expected -1 to be 3" }]);
const basic = { "package.json": '{"name":"fx","type":"module"}\n', "src/math.ts": MATH, "test/math.test.ts": MATH_TEST };

describe("M1 — JSX refusal is introduced-only", () => {
	it("P1: a mutant that INTRODUCES JSX into a JSX-free .js file is still refused as a compile error", () => {
		const verdict = mutantParses("src/a.js", "export const x = <b>1</b>;\n", "export const x = 1;\n");
		expect(verdict && !verdict.ok && verdict.reason).toMatch(/introduces JSX/);
	});
	it("P2: a mutant inside a .js file that already held JSX parses (the original decides, not the mutant)", () => {
		const original = 'export const Badge = () => <span class="badge">x</span>;\n';
		expect(mutantParses("src/Badge.js", original.replace("badge", "chip"), original)).toEqual({ ok: true });
	});
	it("N1: without the original (legacy callers) JSX in a .ts file is refused as before", () => {
		const verdict = mutantParses("src/a.ts", "export const x = <b>1</b>;\n");
		expect(verdict && !verdict.ok).toBe(true);
	});
});

describe("M7 / A4 / A6 — --vitest-config resolution", () => {
	it("P1: a path relative to the invoking cwd resolves when it is inside the project, and spells repo-relative", () => {
		const root = makeRepo({ ...basic, "configs/vitest.unit.mts": "export default {};\n" });
		expect(explicitVitestConfig(root, "./configs/vitest.unit.mts", root)).toBe("configs/vitest.unit.mts");
		expect(explicitVitestConfig(root, "vitest.unit.mts", join(root, "configs"))).toBe("configs/vitest.unit.mts");
		expect(explicitVitestConfig(root, "configs/vitest.unit.mts", "/")).toBe("configs/vitest.unit.mts");
	});
	it("P2: the root-relative spelling wins over a cwd-relative file that lies outside the project", () => {
		const root = makeRepo({ ...basic, "vitest.config.ts": "export default {};\n" });
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4fix-cwd-")));
		roots.push(elsewhere);
		writeFileSync(join(elsewhere, "vitest.config.ts"), "export default {};\n");
		expect(explicitVitestConfig(root, "vitest.config.ts", elsewhere)).toBe("vitest.config.ts");
	});
	it("N1: a config outside the project is refused up front (A4), with the resolved path", () => {
		const root = makeRepo(basic);
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4fix-out-")));
		roots.push(elsewhere);
		writeFileSync(join(elsewhere, "vite.config.ts"), "export default {};\n");
		const verdict = explicitVitestConfig(root, join(elsewhere, "vite.config.ts"), root);
		expect(typeof verdict === "object" && verdict.reason).toMatch(/resolves outside the project/);
	});
	it("N2: a config that exists nowhere is 'does not exist'", () => {
		const root = makeRepo(basic);
		expect(explicitVitestConfig(root, "nope.config.ts", root)).toEqual({ reason: "--vitest-config nope.config.ts does not exist" });
	});
	it("P3: scripts.test `-c ./configs/x` and the flag spelling `configs/x` record ONE path (A6)", () => {
		const root = makeRepo({ ...basic, "package.json": '{"name":"fx","type":"module","scripts":{"test":"vitest run -c ./configs/vitest.unit.mts"}}\n', "configs/vitest.unit.mts": "export default {};\n" });
		expect(resolveVitestConfig(root)).toBe("configs/vitest.unit.mts");
		expect(resolveVitestConfig(root, "./configs/vitest.unit.mts")).toBe("configs/vitest.unit.mts");
	});
	it("P4: discovery order is vitest.config.* before vite.config.*", () => {
		const root = makeRepo({ ...basic, "vite.config.ts": "export default {};\n", "vitest.config.mjs": "export default {};\n" });
		expect(resolveVitestConfig(root)).toBe("vitest.config.mjs");
	});
});

describe("M2 / M3 / M4 — config binding", () => {
	const SETUP = "(globalThis as any).__KP_SETUP__ = 1;\n";
	it("P1: test.projects globs bind each project's config, its setup files (resolved against the project directory) and a negation is honoured", () => {
		const root = makeRepo({
			...basic,
			"vitest.config.ts": 'export default { test: { projects: ["packages/*", "!packages/skip", "packages/c/vite.config.mts"] } };\n',
			"packages/a/vitest.config.ts": 'export default { test: { setupFiles: ["./test/setup.ts"] } };\n',
			"packages/a/test/setup.ts": SETUP,
			"packages/skip/vitest.config.ts": 'export default { test: { setupFiles: ["./setup.ts"] } };\n',
			"packages/skip/setup.ts": SETUP,
			"packages/c/vite.config.mts": 'export default { test: { globalSetup: "./global.ts" } };\n',
			"packages/c/global.ts": "export default () => {};\n",
		});
		const binding = bindVitestConfig(root, "vitest.config.ts");
		expect(binding.configFiles).toEqual(["packages/a/vitest.config.ts", "packages/c/vite.config.mts"]);
		expect(binding.setupFiles).toEqual(["packages/a/test/setup.ts", "packages/c/global.ts"]);
		expect(binding.unresolvable).toEqual([]);
	});
	it("P2: the config's static import closure is bound and the helper's declarations are read (M3)", () => {
		const root = makeRepo({
			...basic,
			"vite.config.ts": 'import { testOptions } from "./config/test-options";\nexport default { test: testOptions };\n',
			"config/test-options.ts": 'import { SETUP } from "./paths";\nexport const testOptions = { setupFiles: [SETUP, "./test/setup.ts"] };\n',
			"config/paths.ts": 'export const SETUP = "./test/other.ts";\n',
			"test/setup.ts": SETUP,
			"test/other.ts": SETUP,
		});
		const binding = bindVitestConfig(root, "vite.config.ts");
		expect(binding.configFiles).toEqual(["config/test-options.ts", "config/paths.ts"]);
		expect(binding.setupFiles).toEqual(["test/setup.ts"]);
		// `SETUP` is an identifier: computed, so recorded — never silently dropped.
		expect(binding.unresolvable).toEqual(["config/test-options.ts: setupFiles[0] is computed (Identifier)"]);
	});
	it("P3: a computed setupFiles (spread, call, template with an expression) is `unresolvable` on the receipt and a --verify LIMIT line", async () => {
		const root = makeRepo({ ...basic, "vitest.config.ts": 'const extra = ["./test/setup.ts"];\nexport default { test: { setupFiles: [...extra, `./test/${"x"}.ts`], globalSetup: extra.concat() } };\n', "test/setup.ts": SETUP });
		const result = await proveKill({ root, spec: MINUS, tests: ["test/math.test.ts"], budgetMs: 1000, runner: killing, persist: false });
		if (!result.ok) throw new Error(result.reasons.join("; "));
		expect(result.receipt.environment.setupFiles).toEqual([]);
		expect(result.receipt.environment.unresolvable).toEqual([
			"vitest.config.ts: setupFiles[0] is computed (SpreadElement)",
			"vitest.config.ts: setupFiles[1] is computed (TemplateExpression)",
			"vitest.config.ts: globalSetup is computed (CallExpression)",
		]);
		expect(parseKillProof(JSON.parse(JSON.stringify(result.receipt)))).toEqual(result.receipt);
		const listing = renderKillProofs([{ id: result.receipt.id, verdict: "killed", provedAt: result.receipt.provedAt, mutant: "m", tests: ["test/math.test.ts"], killedTests: ["test/math.test.ts"], freshness: "fresh", limits: result.receipt.environment.unresolvable }]);
		expect(listing).toContain("LIMIT (not bound): vitest.config.ts: setupFiles[0] is computed (SpreadElement)");
	});
	it("P4: a setup path that resolves to no project file is a recorded limit, a bare package specifier is not", () => {
		const root = makeRepo({ ...basic, "vitest.config.ts": 'export default { test: { setupFiles: ["./test/missing.ts", "dotenv/config"] } };\n' });
		const binding = bindVitestConfig(root, "vitest.config.ts");
		expect(binding.setupFiles).toEqual([]);
		expect(binding.unresolvable).toEqual(['vitest.config.ts: setup file "./test/missing.ts" is not a project file (resolved against .)']);
	});
	it("P5: a declared test.root re-bases setup paths; a subdirectory config without one resolves against the project root (M4)", () => {
		const root = makeRepo({ ...basic, "configs/vitest.unit.mts": 'export default { test: { root: "./app", setupFiles: ["./test/setup.ts"] } };\n', "app/test/setup.ts": SETUP, "test/setup.ts": SETUP });
		expect(bindVitestConfig(root, "configs/vitest.unit.mts").setupFiles).toEqual(["app/test/setup.ts"]);
		const plain = makeRepo({ ...basic, "configs/vitest.unit.mts": 'export default { test: { setupFiles: ["./test/setup.ts"] } };\n', "test/setup.ts": SETUP, "configs/test/setup.ts": SETUP });
		expect(bindVitestConfig(plain, "configs/vitest.unit.mts").setupFiles).toEqual(["test/setup.ts"]);
	});
	it("P6: editing a project config's setup file, or the project config, stales the receipt; a sibling project added later is 'loaded since the proof'", async () => {
		const root = makeRepo({ ...basic, "vitest.config.ts": 'export default { test: { projects: ["packages/*"] } };\n', "packages/a/vitest.config.ts": 'export default { test: { setupFiles: ["./setup.ts"] } };\n', "packages/a/setup.ts": SETUP });
		const result = await proveKill({ root, spec: MINUS, tests: ["test/math.test.ts"], budgetMs: 1000, runner: killing, persist: false });
		if (!result.ok) throw new Error(result.reasons.join("; "));
		expect(result.receipt.environment.configFiles.map(file => file.path)).toEqual(["packages/a/vitest.config.ts"]);
		expect(verifyKillProof(root, result.receipt)).toEqual({ fresh: true });
		writeFileSync(join(root, "packages/a/setup.ts"), "// changed\n");
		expect(verifyKillProof(root, result.receipt)).toEqual({ fresh: false, reasons: ["setup file packages/a/setup.ts changed since the proof"] });
		writeFileSync(join(root, "packages/a/setup.ts"), SETUP);
		mkdirSync(join(root, "packages/b"));
		writeFileSync(join(root, "packages/b/vitest.config.ts"), "export default {};\n");
		expect(verifyKillProof(root, result.receipt)).toEqual({ fresh: false, reasons: ["config file packages/b/vitest.config.ts is loaded by the config since the proof"] });
	});
	it("N1: no config ⇒ nothing bound, nothing unresolvable", () => {
		const root = makeRepo(basic);
		expect(bindVitestConfig(root, null)).toEqual({ configFiles: [], setupFiles: [], unresolvable: [] });
		expect(captureEnvironment(root).configFiles).toEqual([]);
	});
});

describe("M5 — hoisted vitest", () => {
	const NODE_MODULES = realpathSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)));
	it("P1: vitestHome walks up to the workspace root (never past the git root); hoistLayout names the package prefix", () => {
		const root = makeRepo({ ...basic, "packages/a/package.json": "{}\n" });
		symlinkSync(NODE_MODULES, join(root, "node_modules"));
		expect(vitestHome(join(root, "packages/a"))).toBe(root);
		expect(hoistLayout(join(root, "packages/a"))).toEqual({ prefix: "packages/a", hoistedModules: join(root, "node_modules") });
		expect(hoistLayout(root)).toBeUndefined();
		expect(missingVitest(join(root, "packages/a"))).toBeNull();
	});
	it("N1: a package below a git root WITHOUT vitest is still 'not installed' — the walk never reaches this checkout's node_modules", () => {
		const root = makeRepo({ ...basic, "packages/a/package.json": "{}\n" });
		expect(vitestHome(join(root, "packages/a"))).toBeNull();
		expect(missingVitest(join(root, "packages/a"))).toMatch(/vitest is not installed in this project/);
	});
	it("P2: the hoisted copy places the package under <copy>/<prefix> with the workspace node_modules linked above it", async () => {
		const root = makeRepo({ ...basic, "packages/a/package.json": "{}\n", "packages/a/src/x.ts": "export {};\n" });
		symlinkSync(NODE_MODULES, join(root, "node_modules"));
		const copy = await createProjectCopyAsync(join(root, "packages/a"), ["package.json", "src/x.ts"], new Map(), { prefix: "packages/a", hoistedModules: join(root, "node_modules") });
		try {
			expect(copy.dir.endsWith("/packages/a")).toBe(true);
			expect(existsSync(join(copy.dir, "src/x.ts"))).toBe(true);
			const top = join(copy.dir, "../..");
			expect(readlinkSync(join(top, "node_modules"))).toBe(join(root, "node_modules"));
			expect(nearestVitestBin(copy.dir)).toBe(join(top, "node_modules/.bin/vitest"));
		} finally {
			await copy.cleanup();
		}
		expect(existsSync(join(copy.dir, "../.."))).toBe(false);
	});
	it("P3: nearestVitestBin prefers the directory's own node_modules and returns null beyond a .git boundary", () => {
		const root = makeRepo({ ...basic, "packages/a/package.json": "{}\n" }, ["packages/a/node_modules/.bin"]);
		writeFileSync(join(root, "packages/a/node_modules/.bin/vitest"), "#!/bin/sh\n");
		expect(nearestVitestBin(join(root, "packages/a"))).toBe(join(root, "packages/a/node_modules/.bin/vitest"));
		expect(nearestVitestBin(join(root, "packages"))).toBeNull();
	});
});

describe("M6 — startup and load failures carry vitest's words", () => {
	it("P1: stderrHead strips ANSI, keeps the first 2 KB and marks the cut", () => {
		expect(stderrHead("\u001b[31mfailed to load config\u001b[0m from x\n")).toBe("failed to load config from x");
		expect(stderrHead("   \n")).toBeUndefined();
		const long = stderrHead("x".repeat(STDERR_HEAD_BYTES + 100));
		expect(long?.length).toBe(STDERR_HEAD_BYTES);
		expect(long?.endsWith("…")).toBe(true);
	});
	it("P2: parseVitestSuiteFailures keeps the file-level message of a file with no cases, keyed repo-relative", () => {
		const report = JSON.stringify({ testResults: [
			{ name: "/r/test/a.test.ts", status: "failed", message: "Error: Failed to load url ./does-not-exist.js (resolved id: ./does-not-exist.js) in /r/src/math.ts. Does the file exist?\n at x\n at y\n at z", assertionResults: [] },
			{ name: "/r/test/b.test.ts", status: "passed", message: "", assertionResults: [] },
			{ name: "/r/test/c.test.ts", status: "failed", message: "ignored: it has cases", assertionResults: [{ fullName: "c", status: "failed" }] },
		] });
		const failures = parseVitestSuiteFailures(report, "/r");
		expect([...failures.keys()]).toEqual(["test/a.test.ts"]);
		expect(failures.get("test/a.test.ts")).toMatch(/^Error: Failed to load url \.\/does-not-exist\.js/);
		expect(failures.get("test/a.test.ts")?.split("\n")).toHaveLength(3);
	});
	it("N1: not a report ⇒ no failures", () => {
		expect(parseVitestSuiteFailures("not json", "/r").size).toBe(0);
		expect(parseVitestSuiteFailures("{}", "/r").size).toBe(0);
	});
	it("P3: a silent baseline file names its load error; a no-report run names vitest's stderr", async () => {
		const root = makeRepo({ ...basic, "vitest.config.ts": "export default {};\n" });
		const loadError: NonNullable<ProveKillOptions["runner"]> = async () => ({ ...okRun([]), suiteFailures: { "test/math.test.ts": "Error: Failed to load url ./nope.js" } });
		const silent = await proveKill({ root, spec: MINUS, tests: ["test/math.test.ts"], budgetMs: 1000, runner: loadError, persist: false });
		expect(!silent.ok && silent.reasons[0]).toBe("test/math.test.ts ran no test case in the isolated copy — the file failed to load: Error: Failed to load url ./nope.js");
		const noReport: NonNullable<ProveKillOptions["runner"]> = async () => ({ cases: [], timedOut: false, exitCode: 1, durationMs: 5, error: "vitest wrote no JSON report", stderrHead: "failed to load config from /x/vitest.config.ts" });
		const startup = await proveKill({ root, spec: MINUS, tests: ["test/math.test.ts"], budgetMs: 1000, runner: noReport, persist: false });
		expect(!startup.ok && startup.reasons).toEqual(["baseline run failed: vitest wrote no JSON report", `vitest stderr (first ${STDERR_HEAD_BYTES} bytes):\nfailed to load config from /x/vitest.config.ts`]);
	});
});

describe("A3 — a manual mock is not product code", () => {
	it("P1: a __mocks__ twin is refused as a target", async () => {
		const root = makeRepo({ ...basic, "src/__mocks__/math.ts": MATH });
		const result = await proveKill({ root, spec: { ...MINUS, file: "src/__mocks__/math.ts" }, tests: ["test/math.test.ts"], budgetMs: 1000, runner: killing, persist: false });
		expect(!result.ok && result.reasons[0]).toMatch(/is a manual mock \(under __mocks__\)/);
	});
});
