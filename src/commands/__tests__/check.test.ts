import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks for checkCommand integration tests -----------------------------
// checkCommand's own logic (plan resolution, dispatch, scanner wiring) is the
// thing under test here — ProjectGraph and CheckEngine are heavy, real-fs/
// real-process modules that check.ts merely calls through, so they're
// replaced with fully-controllable fakes. `node:fs` is likewise replaced so
// existsSync/readFileSync answer from an in-memory fixture instead of the
// real filesystem.

const graphState = vi.hoisted(() => ({
	data: {
		files: [] as string[],
		deps: {} as Record<string, unknown[]>,
		exportsMap: {} as Record<string, unknown[]>,
		dependents: {} as Record<string, string[]>,
		boundary: {} as Record<string, string>,
		cycles: {} as Record<string, string[][]>,
		fileCount: 0,
	},
	constructions: 0,
}));

const engineState = vi.hoisted(() => ({
	calls: [] as Array<{ cwd: string; scope: unknown; options: unknown }>,
	report: {
		results: [] as unknown[],
		toolsRun: [{ id: "mock-engine-tool", available: true }] as unknown[],
		toolsSkipped: [] as unknown[],
		skipped: [] as unknown[],
		elapsedMs: 0,
		metrics: [] as unknown[],
		deduplicatedCount: 0,
	},
	formatToolReportResult: "mock-tool-report",
}));

const fsState = vi.hoisted(() => ({
	existing: new Set<string>(),
	contents: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (p: unknown) => fsState.existing.has(String(p)),
		readFileSync: (p: unknown, encoding?: unknown) => {
			if (encoding !== "utf-8") {
				throw new Error(`mock readFileSync: unsupported encoding ${String(encoding)}`);
			}
			const content = fsState.contents.get(String(p));
			if (content === undefined) {
				const err = new Error(`ENOENT: no such file, open '${String(p)}'`) as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return content;
		},
	};
});

vi.mock("../../harness/project-graph.js", () => {
	class FakeProjectGraph {
		constructor(_cwd: string) {
			graphState.constructions++;
		}
		initialize(): void {}
		get fileCount(): number {
			return graphState.data.fileCount;
		}
		allFiles(): string[] {
			return graphState.data.files;
		}
		toRelative(f: string): string {
			return f.replace(/^\/proj\//, "");
		}
		getDependencies(f: string): unknown[] {
			return graphState.data.deps[f] ?? [];
		}
		getExports(f: string): unknown[] {
			return graphState.data.exportsMap[f] ?? [];
		}
		getDependents(f: string): string[] {
			return graphState.data.dependents[f] ?? [];
		}
		getProjectBoundary(f: string): string {
			return graphState.data.boundary[f] ?? "/proj";
		}
		findCyclesThrough(f: string): string[][] {
			return graphState.data.cycles[f] ?? [];
		}
	}
	return { ProjectGraph: FakeProjectGraph };
});

vi.mock("../../harness/check-engine/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../harness/check-engine/index.js")>();
	class FakeCheckEngine {
		cwd: string;
		constructor(cwd: string) {
			this.cwd = cwd;
		}
		formatToolReport(): string {
			return engineState.formatToolReportResult;
		}
		runChecks(scope: unknown, options: unknown): unknown {
			engineState.calls.push({ cwd: this.cwd, scope, options });
			return engineState.report;
		}
	}
	return { ...actual, CheckEngine: FakeCheckEngine };
});

import { checkCommand, extractBindings, findDeadImports } from "../check.js";

function resetFixtures(): void {
	graphState.data = {
		files: [],
		deps: {},
		exportsMap: {},
		dependents: {},
		boundary: {},
		cycles: {},
		fileCount: 0,
	};
	graphState.constructions = 0;
	engineState.calls = [];
	fsState.existing = new Set();
	fsState.contents = new Map();
}

function captureStdout(): { get: () => string } {
	let out = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out += String(chunk);
		return true;
	});
	return { get: () => out };
}

function captureStderr(): { get: () => string } {
	let out = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		out += String(chunk);
		return true;
	});
	return { get: () => out };
}

beforeEach(() => {
	resetFixtures();
	vi.restoreAllMocks();
});

describe("findDeadImports", () => {
	it("returns unused binding names", () => {
		const content = `import { foo } from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual(["foo"]);
	});

	it("returns empty array when binding is used", () => {
		const content = `import { foo } from './bar';\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("skips namespace imports", () => {
		const content = `import * as ns from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("skips side-effect imports", () => {
		const content = `import './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("does not confuse import in string literals", () => {
		const content = `import { foo } from './bar';\nconst x = "import { bar } from './baz'";\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("does not confuse identifiers starting with import", () => {
		const content = `import { Foo } from './bar';\nimportant(Foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});

	it("handles shebang lines before imports", () => {
		const content = `#!/usr/bin/env node\nimport { foo } from './bar';\nconst x = 1;`;
		expect(findDeadImports(content)).toEqual(["foo"]);
	});

	it("detects used import after shebang", () => {
		const content = `#!/usr/bin/env bun\nimport { foo } from './bar';\nconsole.log(foo);`;
		expect(findDeadImports(content)).toEqual([]);
	});
});

describe("extractBindings", () => {
	it("extracts named imports", () => {
		const bindings: string[] = [];
		extractBindings(`import { foo, bar } from './baz'`, bindings);
		expect(bindings).toEqual(["foo", "bar"]);
	});

	it("extracts default imports", () => {
		const bindings: string[] = [];
		extractBindings(`import Foo from './bar'`, bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	it("strips inline type keyword", () => {
		const bindings: string[] = [];
		extractBindings(`import { type Foo, Bar } from './baz'`, bindings);
		expect(bindings).toEqual(["Foo", "Bar"]);
	});

	it("uses alias from as keyword", () => {
		const bindings: string[] = [];
		extractBindings(`import { foo as bar } from './baz'`, bindings);
		expect(bindings).toEqual(["bar"]);
	});

	it("skips comment lines", () => {
		const bindings: string[] = [];
		extractBindings(`// import { foo } from './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("skips side-effect imports", () => {
		const bindings: string[] = [];
		extractBindings(`import './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("skips namespace imports", () => {
		const bindings: string[] = [];
		extractBindings(`import * as ns from './bar'`, bindings);
		expect(bindings).toEqual([]);
	});

	it("extracts type imports", () => {
		const bindings: string[] = [];
		extractBindings(`import type { Foo } from './bar'`, bindings);
		expect(bindings).toEqual(["Foo"]);
	});
});

// Runs checkCommand in --json mode against the fixture graph and returns the
// parsed payload. Structural-only run (no --tools/--report), so CheckEngine
// is never constructed.
async function runStructuralJson(only?: string): Promise<Record<string, { count: number; files: string[] }>> {
	const stdout = captureStdout();
	captureStderr();
	await checkCommand({ cwd: "/proj", json: true, ...(only ? { only } : {}) });
	return JSON.parse(stdout.get());
}

describe("checkCommand — scanBrokenImports", () => {
	it("skips an edge with no resolved target file", async () => {
		graphState.data.files = ["/proj/a.ts"];
		graphState.data.deps["/proj/a.ts"] = [
			{ toFile: "", specifier: "some-pkg", symbols: [], isTypeOnly: false },
		];
		const json = await runStructuralJson("broken-imports");
		expect(json["broken-imports"]).toEqual({ count: 0, files: [] });
	});

	it("skips a .json specifier even when the resolved target is missing", async () => {
		graphState.data.files = ["/proj/a.ts"];
		graphState.data.deps["/proj/a.ts"] = [
			{ toFile: "/proj/data.json", specifier: "./data.json", symbols: [], isTypeOnly: false },
		];
		const json = await runStructuralJson("broken-imports");
		expect(json["broken-imports"]).toEqual({ count: 0, files: [] });
	});

	it("skips a node_modules target even when unresolved on disk", async () => {
		graphState.data.files = ["/proj/a.ts"];
		graphState.data.deps["/proj/a.ts"] = [
			{
				toFile: "/proj/node_modules/pkg/index.js",
				specifier: "pkg",
				symbols: [],
				isTypeOnly: false,
			},
		];
		const json = await runStructuralJson("broken-imports");
		expect(json["broken-imports"]).toEqual({ count: 0, files: [] });
	});

	it("flags a file whose resolved target does not exist on disk", async () => {
		graphState.data.files = ["/proj/a.ts"];
		graphState.data.deps["/proj/a.ts"] = [
			{ toFile: "/proj/missing.ts", specifier: "./missing", symbols: [], isTypeOnly: false },
		];
		const json = await runStructuralJson("broken-imports");
		expect(json["broken-imports"]).toEqual({ count: 1, files: ["a.ts"] });
	});
});

describe("checkCommand — scanCycles", () => {
	it("does not re-expand an already-visited file's own cycles", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.cycles["/proj/a.ts"] = [["/proj/a.ts", "/proj/b.ts"]];
		graphState.data.cycles["/proj/b.ts"] = [["/proj/b.ts", "/proj/c.ts"]];
		const json = await runStructuralJson("cycles");
		expect(json.cycles).toEqual({ count: 2, files: ["a.ts", "b.ts"] });
	});
});

describe("checkCommand — scanDuplicates", () => {
	function exp(name: string, kind = "const", isTypeOnly = false): unknown {
		return { name, kind, isTypeOnly, line: 1 };
	}

	it("excludes default exports from duplicate detection", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.exportsMap["/proj/a.ts"] = [exp("default"), exp("UniqueA")];
		graphState.data.exportsMap["/proj/b.ts"] = [exp("default"), exp("UniqueB")];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("duplicates");
		expect(json.duplicates).toEqual({ count: 0, files: [] });
	});

	it("excludes namespace (*) exports from duplicate detection", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.exportsMap["/proj/a.ts"] = [exp("*", "namespace"), exp("UniqueA")];
		graphState.data.exportsMap["/proj/b.ts"] = [exp("*", "namespace"), exp("UniqueB")];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("duplicates");
		expect(json.duplicates).toEqual({ count: 0, files: [] });
	});

	it("excludes type-only exports from duplicate detection", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.exportsMap["/proj/a.ts"] = [exp("Bar", "type", true), exp("UniqueA")];
		graphState.data.exportsMap["/proj/b.ts"] = [exp("Bar", "type", true), exp("UniqueB")];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("duplicates");
		expect(json.duplicates).toEqual({ count: 0, files: [] });
	});

	it("excludes re-export kind from duplicate detection", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.exportsMap["/proj/a.ts"] = [exp("Foo")];
		graphState.data.exportsMap["/proj/b.ts"] = [exp("Foo", "re-export")];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("duplicates");
		expect(json.duplicates).toEqual({ count: 0, files: [] });
	});

	it("flags a named export declared in two files under the same boundary", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.exportsMap["/proj/a.ts"] = [exp("Foo")];
		graphState.data.exportsMap["/proj/b.ts"] = [exp("Foo")];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("duplicates");
		expect(json.duplicates).toEqual({ count: 2, files: ["a.ts", "b.ts"] });
	});
});

describe("checkCommand — scanMissingTests", () => {
	it("exempts a .d.js declaration file via the base-suffix check (not the .d.ts check)", async () => {
		graphState.data.files = ["/proj/foo.d.js"];
		const json = await runStructuralJson("missing-tests");
		expect(json["missing-tests"]).toEqual({ count: 0, files: [] });
	});

	it("finds a same-directory .test sibling as satisfying the test requirement", async () => {
		graphState.data.files = ["/proj/foo.ts"];
		fsState.existing.add("/proj/foo.test.ts");
		const json = await runStructuralJson("missing-tests");
		expect(json["missing-tests"]).toEqual({ count: 0, files: [] });
	});

	it("finds a same-directory .spec sibling as satisfying the test requirement", async () => {
		graphState.data.files = ["/proj/foo.ts"];
		fsState.existing.add("/proj/foo.spec.ts");
		const json = await runStructuralJson("missing-tests");
		expect(json["missing-tests"]).toEqual({ count: 0, files: [] });
	});

	it("finds a __tests__/*.spec sibling as satisfying the test requirement", async () => {
		graphState.data.files = ["/proj/foo.ts"];
		fsState.existing.add("/proj/__tests__/foo.spec.ts");
		const json = await runStructuralJson("missing-tests");
		expect(json["missing-tests"]).toEqual({ count: 0, files: [] });
	});

	it("flags .ts, .tsx and .js source files with no matching test file", async () => {
		graphState.data.files = ["/proj/foo.ts", "/proj/bar.tsx", "/proj/baz.js"];
		const json = await runStructuralJson("missing-tests");
		expect(json["missing-tests"]).toEqual({
			count: 3,
			files: ["bar.tsx", "baz.js", "foo.ts"],
		});
	});
});

describe("checkCommand — scanSecrets / scanAnyTypes (scanFileContent)", () => {
	const SECRET = `const key = 'AKIAIOSFODNN7EXAMPLE';`;
	const ANY_TYPE = `let x: any;`;

	it("does not scan an extension outside the allowed list", async () => {
		graphState.data.files = ["/proj/readme.md"];
		fsState.contents.set("/proj/readme.md", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 0, files: [] });
	});

	it("scans a .tsx file for the any-types scan", async () => {
		graphState.data.files = ["/proj/foo.tsx"];
		fsState.contents.set("/proj/foo.tsx", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 1, files: ["foo.tsx"] });
	});

	it("skips a .d.ts declaration file for the any-types scan (skipDecl: true)", async () => {
		graphState.data.files = ["/proj/types.d.ts"];
		fsState.contents.set("/proj/types.d.ts", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 0, files: [] });
	});

	it("scans a .d.ts declaration file for the secrets scan (skipDecl: false)", async () => {
		graphState.data.files = ["/proj/creds.d.ts"];
		fsState.contents.set("/proj/creds.d.ts", SECRET);
		const json = await runStructuralJson("secrets");
		expect(json.secrets).toEqual({ count: 1, files: ["creds.d.ts"] });
	});

	it("skips a *.test file", async () => {
		graphState.data.files = ["/proj/foo.test.ts"];
		fsState.contents.set("/proj/foo.test.ts", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 0, files: [] });
	});

	it("skips a *.spec file", async () => {
		graphState.data.files = ["/proj/foo.spec.ts"];
		fsState.contents.set("/proj/foo.spec.ts", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 0, files: [] });
	});

	it("does not exclude __tests__ content for any-types (skipTestDirs: false)", async () => {
		graphState.data.files = ["/proj/__tests__/foo.ts"];
		fsState.contents.set("/proj/__tests__/foo.ts", ANY_TYPE);
		const json = await runStructuralJson("any-types");
		expect(json["any-types"]).toEqual({ count: 1, files: ["__tests__/foo.ts"] });
	});

	it("excludes __tests__ content for secrets (skipTestDirs: true)", async () => {
		graphState.data.files = ["/proj/__tests__/foo.ts"];
		fsState.contents.set("/proj/__tests__/foo.ts", SECRET);
		const json = await runStructuralJson("secrets");
		expect(json.secrets).toEqual({ count: 0, files: [] });
	});

	it("excludes /test/ directory content for secrets", async () => {
		graphState.data.files = ["/proj/test/foo.ts"];
		fsState.contents.set("/proj/test/foo.ts", SECRET);
		const json = await runStructuralJson("secrets");
		expect(json.secrets).toEqual({ count: 0, files: [] });
	});

	it("scans every allowed extension for secrets", async () => {
		const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
		graphState.data.files = exts.map((ext) => `/proj/leak${ext}`);
		for (const ext of exts) {
			fsState.contents.set(`/proj/leak${ext}`, SECRET);
		}
		const json = await runStructuralJson("secrets");
		expect(json.secrets).toEqual({
			count: 5,
			files: exts.map((ext) => `leak${ext}`).sort(),
		});
	});

	it("only reads content with utf-8 encoding (secrets)", async () => {
		graphState.data.files = ["/proj/leak.ts"];
		fsState.contents.set("/proj/leak.ts", SECRET);
		const json = await runStructuralJson("secrets");
		expect(json.secrets).toEqual({ count: 1, files: ["leak.ts"] });
	});
});

describe("checkCommand — scanDeadImports", () => {
	const DEAD = `import { foo } from './bar';\nconst x = 1;`;

	it("does not scan an extension outside the allowed list", async () => {
		graphState.data.files = ["/proj/dead.md"];
		fsState.contents.set("/proj/dead.md", DEAD);
		const json = await runStructuralJson("dead-imports");
		expect(json["dead-imports"]).toEqual({ count: 0, files: [] });
	});

	it("scans every allowed extension for dead imports", async () => {
		const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
		graphState.data.files = exts.map((ext) => `/proj/dead${ext}`);
		for (const ext of exts) {
			fsState.contents.set(`/proj/dead${ext}`, DEAD);
		}
		const json = await runStructuralJson("dead-imports");
		expect(json["dead-imports"]).toEqual({
			count: 5,
			files: exts.map((ext) => `dead${ext}`).sort(),
		});
	});

	it("only reads content with utf-8 encoding (dead-imports)", async () => {
		graphState.data.files = ["/proj/dead.ts"];
		fsState.contents.set("/proj/dead.ts", DEAD);
		const json = await runStructuralJson("dead-imports");
		expect(json["dead-imports"]).toEqual({ count: 1, files: ["dead.ts"] });
	});
});

describe("checkCommand — --only rejection paths", () => {
	it("rejects an unknown check name with the exact available-checks list", async () => {
		const stderr = captureStderr();
		await checkCommand({ cwd: "/proj", only: "totally-fake-check" });
		expect(stderr.get()).toBe(
			'Unknown check: "totally-fake-check". Available: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports, tsc, biome, eslint, oxlint, knip, semgrep, gitleaks, dep-audit, mypy, ruff, ruff-format, cargo-check, cargo-clippy, rustfmt, go-build, golangci-lint, go-test, c-compile, clang-tidy, shellcheck, actionlint, hadolint, taplo, swiftlint, swift-build, lizard, docs-check\n',
		);
		expect(process.exitCode).toBe(1);
	});

	it("rejects a discovery-only engine tool (dep-audit) with exit code 1", async () => {
		const stderr = captureStderr();
		await checkCommand({ cwd: "/proj", only: "dep-audit" });
		expect(stderr.get()).toContain("discovery-only");
		expect(process.exitCode).toBe(1);
	});

	it("does not build the project graph or contact the engine for a rejected --only", async () => {
		captureStderr();
		graphState.data.files = ["/proj/should-not-be-scanned.ts"];
		await checkCommand({ cwd: "/proj", only: "docs-check" });
		expect(engineState.calls).toEqual([]);
	});
});

describe("checkCommand — --tools discovery-only drop warning", () => {
	it("warns with the exact dropped-tool message and still runs the remaining tools", async () => {
		const stderr = captureStderr();
		captureStdout();
		await checkCommand({ cwd: "/proj", tools: "dep-audit,tsc", json: true });
		expect(stderr.get()).toBe(
			"Skipping discovery-only tool(s) dep-audit from --tools — no interlinked check runner; run interlinked verify instead.\n  running external tools...\n",
		);
		expect(engineState.calls).toHaveLength(1);
		expect(engineState.calls[0]?.options).toEqual({ tools: ["tsc"], timeoutMs: 30_000 });
	});

	it("drops an empty entry produced by a trailing/double comma in --tools", async () => {
		captureStderr();
		captureStdout();
		await checkCommand({ cwd: "/proj", tools: "tsc,,", json: true });
		expect(engineState.calls[0]?.options).toEqual({ tools: ["tsc"], timeoutMs: 30_000 });
	});

	it("comma-joins multiple dropped discovery-only tool names in the warning", async () => {
		const stderr = captureStderr();
		captureStdout();
		await checkCommand({ cwd: "/proj", tools: "dep-audit,docs-check,tsc", json: true });
		expect(stderr.get()).toBe(
			"Skipping discovery-only tool(s) dep-audit, docs-check from --tools — no interlinked check runner; run interlinked verify instead.\n  running external tools...\n",
		);
	});

	it("trims whitespace around comma-separated tool names before dropping", async () => {
		const stderr = captureStderr();
		captureStdout();
		await checkCommand({ cwd: "/proj", tools: " dep-audit , tsc ", json: true });
		expect(engineState.calls[0]?.options).toEqual({ tools: ["tsc"], timeoutMs: 30_000 });
		expect(stderr.get()).toBe(
			"Skipping discovery-only tool(s) dep-audit from --tools — no interlinked check runner; run interlinked verify instead.\n  running external tools...\n",
		);
	});
});

describe("checkCommand — engine wiring (runEngineChecks)", () => {
	it("never constructs the engine when neither --tools, --report nor an engine --only is given", async () => {
		captureStdout();
		captureStderr();
		const json = await runStructuralJson();
		expect(engineState.calls).toEqual([]);
		expect(json["mock-engine-tool"]).toBeUndefined();
	});

	it("passes the exact project scope to the engine", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ cwd: "/proj", tools: "tsc", json: true });
		expect(engineState.calls[0]?.scope).toEqual({ projectRoot: "/proj", mode: "project" });
	});

	it("omits the tools key entirely (not tools: undefined) when no --tools/--only filter applies", async () => {
		captureStdout();
		captureStderr();
		graphState.data.files = [];
		// --report + a structural --only reaches runEngineChecks (runEngine is
		// true because opts.report is set) while leaving engineToolFilter
		// undefined (only an engine-only --only or --tools sets it).
		await checkCommand({ cwd: "/proj", report: true, only: "cycles" });
		expect(engineState.calls).toHaveLength(1);
		const options = engineState.calls[0]?.options as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(options, "tools")).toBe(false);
	});

	it("passes a single-element tools filter for an engine-only --only", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ cwd: "/proj", only: "tsc", json: true });
		expect(engineState.calls[0]?.options).toEqual({ tools: ["tsc"], timeoutMs: 30_000 });
	});
});

describe("checkCommand — --only structural dispatch does not disable itself as engine-only", () => {
	it("still runs the structural scanner for a known structural --only name", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.cycles["/proj/a.ts"] = [["/proj/a.ts", "/proj/b.ts"]];
		const stderr = captureStderr();
		const stdout = captureStdout();
		await checkCommand({ cwd: "/proj", only: "cycles" });
		expect(stdout.get()).toBe("a.ts\nb.ts\n");
		expect(stderr.get()).toBe("\n2 files\n");
	});
});

describe("checkCommand — cwd resolution", () => {
	it("uses opts.cwd when provided instead of process.cwd()", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ cwd: "/proj", tools: "tsc", json: true });
		expect(engineState.calls[0]?.cwd).toBe("/proj");
	});

	it("falls back to process.cwd() when opts.cwd is omitted", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ tools: "tsc", json: true });
		expect(engineState.calls[0]?.cwd).toBe(process.cwd());
	});
});

describe("checkCommand — --only restricts runStructuralChecks to exactly one scanner", () => {
	it("does not include an unrequested structural check's results in --only output", async () => {
		graphState.data.files = ["/proj/a.ts", "/proj/b.ts"];
		graphState.data.cycles["/proj/a.ts"] = [["/proj/a.ts", "/proj/b.ts"]];
		graphState.data.exportsMap["/proj/a.ts"] = [{ name: "Foo", kind: "const", isTypeOnly: false, line: 1 }];
		graphState.data.exportsMap["/proj/b.ts"] = [{ name: "Foo", kind: "const", isTypeOnly: false, line: 1 }];
		graphState.data.boundary["/proj/a.ts"] = "/proj";
		graphState.data.boundary["/proj/b.ts"] = "/proj";
		const json = await runStructuralJson("cycles");
		expect(Object.keys(json)).toEqual(["cycles"]);
	});
});

describe("checkCommand — --tools with nothing to drop prints no warning", () => {
	it("does not print the discovery-only warning when the filter has no dropped ids", async () => {
		const stderr = captureStderr();
		captureStdout();
		await checkCommand({ cwd: "/proj", tools: "tsc", json: true });
		expect(stderr.get()).toBe("  running external tools...\n");
	});
});

describe("checkCommand — project graph construction", () => {
	it("does not construct the project graph for an engine-only --only", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ cwd: "/proj", only: "tsc", json: true });
		expect(graphState.constructions).toBe(0);
	});

	it("constructs the project graph for a structural run", async () => {
		captureStdout();
		captureStderr();
		await checkCommand({ cwd: "/proj", only: "cycles", json: true });
		expect(graphState.constructions).toBe(1);
	});
});

describe("checkCommand — engine-only --only text dispatch (emitEngineOnly)", () => {
	it("prints matching engine findings to stdout and the count to stderr", async () => {
		engineState.report.results = [
			{ tool: "tsc", file: "b.ts", line: 2, severity: "error", message: "boom", ruleId: "TS1" },
			{ tool: "tsc", file: "a.ts", line: 1, severity: "error", message: "bang", ruleId: "TS2" },
		];
		const stdout = captureStdout();
		const stderr = captureStderr();
		await checkCommand({ cwd: "/proj", only: "tsc" });
		expect(stdout.get()).toBe("a.ts:1: bang\nb.ts:2: boom\n");
		expect(stderr.get()).toContain("2 findings");
	});
});
