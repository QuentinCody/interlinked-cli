// Kill proof — adversarial review round 4, module systems and vitest layouts
// (docs/reviews/kill-proof-review-round4-layouts.md).
// Every case here was REPRODUCED against this branch through the real
// `tests prove-kill` command on a throwaway repository and is expected to FAIL
// until the product code is fixed: a red test is the deliverable. N<n> = the
// system must NOT report this verdict / must NOT leave this input unbound.
// Scripted-runner cases exercise the binding and resolution logic without
// vitest; real-vitest cases link this checkout's node_modules into the fixture.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { verifyKillProof } from "./receipt.js";
import { proveKill, type ProveKillOptions } from "./run.js";

const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const REAL_RUN_MS = 120_000;
const roots: string[] = [];

/** A git repository under the OS temp dir; `linkModulesAt` names the directories that get a node_modules link. */
function makeRepo(files: Record<string, string>, linkModulesAt: readonly string[] = []): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	writeFileSync(join(root, ".gitignore"), "node_modules\n.interlinked\n");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	for (const dir of linkModulesAt) symlinkSync(NODE_MODULES, join(root, dir, "node_modules"));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MATH = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const MATH_TEST = 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n';
const SETUP = "(globalThis as any).__KP_SETUP__ = 1;\n";
const MINUS = { kind: "explicit", find: "return a + b;", replace: "return a - b;" } as const;

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const pass = (file: string, name: string): Case => ({ file, name, title: name, status: "passed" });
const fail = (file: string, name: string): Case => ({ file, name, title: name, status: "failed", message: "AssertionError: expected -1 to be 3" });
/** Answers by what the copy holds: unmutated → pass, mutated → the assertion fails, canary → every case fails (the file was loaded). */
function scripted(source: string, test: string): NonNullable<ProveKillOptions["runner"]> {
	return async (dir: string): Promise<VitestRun> => {
		const text = readFileSync(join(dir, source), "utf8");
		if (text.includes("kill-proof canary")) return okRun([{ ...pass(test, "adds"), status: "failed", message: "Error: kill-proof canary" }]);
		return okRun([text === MATH ? pass(test, "adds") : fail(test, "adds")]);
	};
}
const scriptedProof = (root: string, source: string, test: string, vitestConfig?: string) =>
	proveKill({ root, spec: { ...MINUS, file: source }, tests: [test], budgetMs: 1000, runner: scripted(source, test), persist: false, ...(vitestConfig !== undefined ? { vitestConfig } : {}) });

const setupPaths = (result: Awaited<ReturnType<typeof proveKill>>): string[] => (result.ok ? result.receipt.environment.setupFiles.map(file => file.path) : []);

// ---- (1) a .js file that already holds JSX, in a project whose vitest transforms it ----

const JS_AS_JSX_CONFIG = [
	'import { defineConfig } from "vitest/config";',
	'import { transformWithOxc } from "vite";',
	"const jsAsJsx = {",
	'\tname: "js-as-jsx", enforce: "pre" as const,',
	"\tasync transform(code: string, id: string) {",
	"\t\tif (!/\\/src\\/.*\\.js$/.test(id)) return null;",
	'\t\treturn transformWithOxc(code, id, { lang: "jsx", jsx: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" } });',
	"\t},",
	"};",
	'export default defineConfig({ plugins: [jsAsJsx], test: { include: ["test/**/*.test.js"] } });',
	"",
].join("\n");
const H_JS = 'export function h(tag, props, ...children) {\n\tconst attrs = props ? Object.entries(props).filter(([k]) => !k.startsWith("__")).map(([k, v]) => ` ${k}="${String(v)}"`).join("") : "";\n\treturn `<${tag}${attrs}>${children.flat().join("")}</${tag}>`;\n}\n';
const BADGE_JS = 'import { h } from "./h.js";\n// legacy layout: JSX inside a .js file\nexport function Badge({ label }) {\n\treturn <span class="badge">{label}</span>;\n}\n';
const BADGE_TEST = 'import { expect, it } from "vitest";\nimport { Badge } from "../src/Badge.js";\nit("renders", () => { expect(Badge({ label: "x" })).toBe(\'<span class="badge">x</span>\'); });\n';
const jsxRepo = () => makeRepo({ "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": JS_AS_JSX_CONFIG, "src/h.js": H_JS, "src/Badge.js": BADGE_JS, "test/badge.test.js": BADGE_TEST }, ["."]);

describe("kill proof round 4 — negative (must not misreport a layout the project's own vitest runs)", () => {
	it("N1: a comment-only mutant in a .js file that already holds JSX is SURVIVED, not a compile error", async () => {
		// review M1 — `mutantParses` refuses any JSX in a .js file, even when the unmutated file held it and the baseline ran
		const root = jsxRepo();
		const spec = { kind: "explicit", file: "src/Badge.js", find: "// legacy layout: JSX inside a .js file", replace: "// legacy layout" } as const;
		const result = await proveKill({ root, spec, tests: ["test/badge.test.js"], budgetMs: 60_000, persist: false });
		expect(result.ok ? result.receipt.verdict : result.verdict).toBe("survived");
	}, REAL_RUN_MS);

	it("N2: an attribute mutant inside the JSX of a .js file the project transforms is KILLED", async () => {
		// review M1 — the project's vitest runs the mutant and the assertion catches it; the proof never gets that far
		const root = jsxRepo();
		const spec = { kind: "explicit", file: "src/Badge.js", find: 'class="badge"', replace: 'class="chip"' } as const;
		const result = await proveKill({ root, spec, tests: ["test/badge.test.js"], budgetMs: 60_000, persist: false });
		expect(result.ok ? result.receipt.verdict : result.verdict).toBe("killed");
	}, REAL_RUN_MS);

	// ---- (2) test.projects: the project-level config and its setup files are what ran ----

	const MONO = {
		"package.json": '{"name":"mono","type":"module","private":true,"workspaces":["packages/*"]}\n',
		"vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { projects: ["packages/*"] } });\n',
		"packages/a/package.json": '{"name":"@mono/a","type":"module"}\n',
		"packages/a/vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { name: "a", include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] } });\n',
		"packages/a/test/setup.ts": SETUP,
		"packages/a/src/math.ts": MATH,
		"packages/a/test/math.test.ts": MATH_TEST,
	};

	it("N3: under test.projects the receipt binds the project's setupFiles, not only the root config", async () => {
		// review M2 — `captureEnvironment` reads the root vitest.config.ts; packages/a/vitest.config.ts declared the setup file that ran
		const root = makeRepo(MONO);
		const result = await scriptedProof(root, "packages/a/src/math.ts", "packages/a/test/math.test.ts");
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(setupPaths(result)).toContain("packages/a/test/setup.ts");
	});

	it("N4: editing the project-level vitest.config.ts after the proof makes the receipt STALE", async () => {
		// review M2 — only the root config's sha256 is bound, so the config that actually selected and set up the tests is free to change
		const root = makeRepo(MONO);
		const result = await scriptedProof(root, "packages/a/src/math.ts", "packages/a/test/math.test.ts");
		if (!result.ok) throw new Error(`fixture: ${result.reasons.join("; ")}`);
		writeFileSync(join(root, "packages/a/vitest.config.ts"), `${MONO["packages/a/vitest.config.ts"]}// changed after the proof\n`);
		expect(verifyKillProof(root, result.receipt).fresh).toBe(false);
	});

	// ---- (3) config resolution: setupFiles declared through a helper, or relative to the project root ----

	it("N5: setupFiles declared in a module the config imports are bound by the receipt", async () => {
		// review M3 — `configDeclaredInputs` is a regex over the config file's own text; `test: testOptions` hides the array in ./config/test-options.ts
		const root = makeRepo({
			"package.json": '{"name":"fx","type":"module"}\n',
			"vite.config.ts": 'import { defineConfig } from "vitest/config";\nimport { testOptions } from "./config/test-options";\nexport default defineConfig({ test: testOptions });\n',
			"config/test-options.ts": 'export const testOptions = { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] };\n',
			"test/setup.ts": SETUP,
			"src/math.ts": MATH,
			"test/math.test.ts": MATH_TEST,
		});
		const result = await scriptedProof(root, "src/math.ts", "test/math.test.ts");
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(setupPaths(result)).toContain("test/setup.ts");
	});

	it("N6: editing the helper module the config imports after the proof makes the receipt STALE", async () => {
		// review M3 — the helper decides include/setupFiles; it is neither the bound config nor a bound setup file
		const root = makeRepo({
			"package.json": '{"name":"fx","type":"module"}\n',
			"vite.config.ts": 'import { defineConfig } from "vitest/config";\nimport { testOptions } from "./config/test-options";\nexport default defineConfig({ test: testOptions });\n',
			"config/test-options.ts": 'export const testOptions = { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] };\n',
			"test/setup.ts": SETUP,
			"src/math.ts": MATH,
			"test/math.test.ts": MATH_TEST,
		});
		const result = await scriptedProof(root, "src/math.ts", "test/math.test.ts");
		if (!result.ok) throw new Error(`fixture: ${result.reasons.join("; ")}`);
		writeFileSync(join(root, "config/test-options.ts"), 'export const testOptions = { include: ["test/**/*.test.ts"], setupFiles: [] };\n');
		expect(verifyKillProof(root, result.receipt).fresh).toBe(false);
	});

	it("N7: a config in a subdirectory resolves setupFiles against the project root, as vitest does", async () => {
		// review M4 — the receipt resolves `./test/setup.ts` against configs/ (nonexistent, dropped); vitest ran <root>/test/setup.ts
		const root = makeRepo({
			"package.json": '{"name":"fx","type":"module","scripts":{"test":"vitest run -c ./configs/vitest.unit.mts"}}\n',
			"configs/vitest.unit.mts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] } });\n',
			"test/setup.ts": SETUP,
			"src/math.ts": MATH,
			"test/math.test.ts": MATH_TEST,
		});
		const result = await scriptedProof(root, "src/math.ts", "test/math.test.ts");
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(result.ok ? result.receipt.environment.config?.path : "").toMatch(/configs\/vitest\.unit\.mts$/);
		expect(setupPaths(result)).toContain("test/setup.ts");
	});

	it("N8: `--vitest-config` given as an absolute path inside the project is accepted", async () => {
		// review M7 — `join(root, options.vitestConfig)` turns an absolute path into a nonexistent one
		const root = makeRepo({ "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": 'export default { test: { include: ["test/**/*.test.ts"] } };\n', "src/math.ts": MATH, "test/math.test.ts": MATH_TEST });
		const result = await scriptedProof(root, "src/math.ts", "test/math.test.ts", join(root, "vitest.config.ts"));
		expect(result.ok ? result.receipt.verdict : `${result.verdict}: ${result.reasons.join("; ")}`).toBe("killed");
	});

	// ---- (4) workspaces: hoisted vitest, and a package config that reaches above the package ----

	it("N9: `--cwd <package>` works when vitest is hoisted to the workspace root's node_modules", async () => {
		// review M5 — the guide's own advice for monorepos; `missingVitest` and the copy only look at <root>/node_modules
		const root = makeRepo({ ...MONO, "packages/a/package.json": '{"name":"@mono/a","type":"module"}\n' }, ["."]);
		const result = await proveKill({ root: join(root, "packages/a"), spec: { ...MINUS, file: "src/math.ts" }, tests: ["test/math.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok ? result.receipt.verdict : `${result.verdict}: ${result.reasons.join("; ")}`).toBe("killed");
	}, REAL_RUN_MS);

	it("N10: a package copy whose config imports a file above the package names that file in the reason", async () => {
		// review M6 — vitest's startup error ("failed to load config … Could not resolve '../../vitest.shared'") is discarded; the user reads "vitest wrote no JSON report"
		const root = makeRepo({
			"package.json": '{"name":"mono","type":"module","private":true}\n',
			"vitest.shared.ts": 'export const shared = { include: ["test/**/*.test.ts"] };\n',
			"packages/a/package.json": '{"name":"@mono/a","type":"module"}\n',
			"packages/a/vitest.config.ts": 'import { defineConfig } from "vitest/config";\nimport { shared } from "../../vitest.shared";\nexport default defineConfig({ test: { name: "a", ...shared } });\n',
			"packages/a/src/math.ts": MATH,
			"packages/a/test/math.test.ts": MATH_TEST,
		}, ["packages/a"]);
		const result = await proveKill({ root: join(root, "packages/a"), spec: { ...MINUS, file: "src/math.ts" }, tests: ["test/math.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reasons.join("\n")).toMatch(/vitest\.shared|failed to load config/);
	}, REAL_RUN_MS);

	// ---- (5) a load failure under the mutant carries vitest's own message ----

	it("N11: a mutant that fails to load reports the load error, not 'no result under the mutant'", async () => {
		// review M6 — the suite-level `message` in vitest's JSON report is dropped by `parseVitestReport`, so every load failure is anonymous
		const root = makeRepo({ "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": 'export default { test: { include: ["test/**/*.test.ts"] } };\n', "src/math.ts": MATH, "test/math.test.ts": MATH_TEST }, ["."]);
		const spec = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: 'import "./does-not-exist.js";' } as const;
		const result = await proveKill({ root, spec, tests: ["test/math.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).toBe("inconclusive");
		const reasons = result.ok ? result.receipt.underMutant.cases.map(row => row.reason ?? "") : [];
		expect(reasons.join("\n")).toMatch(/does-not-exist/);
	}, REAL_RUN_MS);
});
