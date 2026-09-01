// ===========================================
// file-checks unit tests
// ===========================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINES } from "../../harness/large-file-policy.js";
import { resetUntestedFilesBaselineCache } from "../../harness/tested-file-policy.js";
import { nonNull } from "../../lib/non-null.js";
import { resetUntestedCoverageCache, runPerFileChecks } from "./file-checks.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

describe("runPerFileChecks", () => {
	it("reports JSON parse errors for invalid JSON files", () => {
		// Every bucket on CodeQualityResults is a required array (the type
		// contract runPerFileChecks documents), so the fixture must build a
		// genuinely complete result via emptyResults() rather than a partial
		// object — a partial cast here is the lie the type checker can't see.
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/foo.json",
			content: "{not json",
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.jsonValidity.length).toBeGreaterThan(0);
	});

	it("does not report on valid JSON files", () => {
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/foo.json",
			content: '{"x": 1}',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.jsonValidity.length).toBe(0);
	});

	it("skips .d.ts files without running other checks", () => {
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/foo.d.ts",
			content: "export const x: any;",
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.strongTyping.length).toBe(0);
	});

	it("dispatches silent_promise_catch through the default-warning pipeline (post-promotion regression guard)", () => {
		// Every bucket on CodeQualityResults is a required array, so every
		// fixture in this file builds a genuinely complete result via
		// emptyResults() — a partial object was never an honest stand-in.
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/swallow.ts",
			content: 'fetch("/api").catch(() => {});\n',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.silentPromiseSwallow.length).toBeGreaterThan(0);
	});

	it("dispatches lossy_error_rethrow through the default-warning pipeline", () => {
		const r = emptyResults();
		runPerFileChecks({
			file: "/tmp/lossy.ts",
			content: 'try { foo(); } catch (e) { throw new Error("wrapped"); }\n',
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.lossyErrorRethrow.length).toBeGreaterThan(0);
	});
});

describe("runPerFileChecks — inline-ignore on the default gate", () => {
	const run = (file: string, content: string): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	// A hardcoded literal-ms wait inside a test body is a deterministic
	// inline-check finding (`hardcoded_timeout_in_tests`). It is the vehicle
	// for proving the default gate honors `// interlinked-ignore`.
	const withoutIgnore = [
		'it("waits", async () => {',
		"  await new Promise((r) => setTimeout(r, 50));",
		"});",
		"",
	].join("\n");
	const withIgnore = [
		'it("waits", async () => {',
		"  // interlinked-ignore: hardcoded_timeout_in_tests — simulated task duration",
		"  await new Promise((r) => setTimeout(r, 50));",
		"});",
		"",
	].join("\n");

	it("reports the inline finding when there is no ignore comment", () => {
		const r = run("/tmp/foo.test.ts", withoutIgnore);
		expect(r.hardcodedTimeoutInTests).toHaveLength(1);
		expect(nonNull(r.hardcodedTimeoutInTests[0]).check).toBe("hardcoded_timeout_in_tests");
	});

	it("drops the inline finding when a matching // interlinked-ignore is present", () => {
		const r = run("/tmp/foo.test.ts", withIgnore);
		expect(r.hardcodedTimeoutInTests).toHaveLength(0);
	});

	it("matches the check name case-insensitively", () => {
		const upperCased = withIgnore.replace(
			"hardcoded_timeout_in_tests",
			"HARDCODED_TIMEOUT_IN_TESTS",
		);
		const r = run("/tmp/foo.test.ts", upperCased);
		expect(r.hardcodedTimeoutInTests).toHaveLength(0);
	});

	it("does not drop a finding when the ignore names a different check", () => {
		const wrongCheck = withIgnore.replace(
			"hardcoded_timeout_in_tests",
			"some_other_check",
		);
		const r = run("/tmp/foo.test.ts", wrongCheck);
		expect(r.hardcodedTimeoutInTests).toHaveLength(1);
	});
});

describe("runPerFileChecks — large_files cap", () => {
	// Relative to THE canonical cap (no baseline at /tmp → the default applies).
	const overCap = Array.from({ length: DEFAULT_MAX_LINES + 600 }, () => "const x = 1;").join("\n");
	const underCap = Array.from({ length: DEFAULT_MAX_LINES - 100 }, () => "const x = 1;").join("\n");
	const run = (file: string, content: string): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("flags a hand-written code file over the cap", () => {
		const r = run("/tmp/huge.ts", overCap);
		expect(r.largeFiles).toHaveLength(1);
		expect(nonNull(r.largeFiles[0]).check).toBe("large_files");
	});

	it("does not flag a file under the cap", () => {
		expect(run("/tmp/small.ts", underCap).largeFiles).toHaveLength(0);
	});

	it("does not flag an over-cap test file (exempt)", () => {
		expect(run("/tmp/huge.test.ts", overCap).largeFiles).toHaveLength(0);
	});

	it("does not flag an over-cap generated file (exempt)", () => {
		expect(run("/tmp/huge.ts", `// @generated\n${overCap}`).largeFiles).toHaveLength(0);
	});
});

describe("runPerFileChecks — function-token cap", () => {
	const run = (file: string, content: string): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("reports an exact over-cap implementation with symbol, count, and tokenizer", () => {
		const statements = Array.from({ length: 130 }, (_, index) => `let value${index} = ${index};`).join("\n");
		const result = run("/tmp/huge-function.ts", `export function huge() {\n${statements}\n}\n`);
		const finding = result.complexity.find((issue) => issue.check === "function_tokens");
		expect(finding?.line).toBe(1);
		expect(finding?.message).toMatch(/huge has \d+ canonical code tokens \(cap 500, tokenizer interlinked-code-v1\)/);
	});

	it("keeps test functions advisory by excluding them from the default verify gate", () => {
		const statements = Array.from({ length: 130 }, (_, index) => `let value${index} = ${index};`).join("\n");
		const result = run("/tmp/huge-function.test.ts", `function huge() {\n${statements}\n}\n`);
		expect(result.complexity.some((issue) => issue.check === "function_tokens")).toBe(false);
	});
});

describe("runPerFileChecks — untested_files ratchet", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-fc-untested-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		// No coverage/ dir and no baseline file here → coverage is null and there
		// is no grandfathering, so a companion-less testable source file is
		// untested. Reset both per-cwd memos so this fresh tmp cwd is read clean.
		resetUntestedFilesBaselineCache();
		resetUntestedCoverageCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUntestedFilesBaselineCache();
		resetUntestedCoverageCache();
	});

	// Real runtime logic — `export const x = 1` alone is now a DATA-only module
	// (exempt from the every-file-tested gate), so the fixture must carry a
	// function for the ratchet path to apply.
	const FIXTURE = "export function f(n: number): number {\n\tif (n > 0) return n;\n\treturn 0;\n}\n";
	const run = (relFile: string): CodeQualityResults => {
		const abs = join(dir, relFile);
		writeFileSync(abs, FIXTURE);
		const r = emptyResults();
		runPerFileChecks({
			file: abs,
			content: FIXTURE,
			cwd: dir,
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("flags a non-grandfathered uncovered source file with no companion", () => {
		const r = run("src/lonely.ts");
		expect(r.untestedFiles).toHaveLength(1);
		expect(nonNull(r.untestedFiles[0]).check).toBe("untested_files");
		expect(nonNull(r.untestedFiles[0]).file).toContain("lonely.ts");
	});

	it("does NOT flag a grandfathered file listed in the baseline", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, min_coverage_pct: 60, files: ["src/lonely.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		expect(run("src/lonely.ts").untestedFiles).toHaveLength(0);
	});

	it("does NOT flag a file that has a companion test", () => {
		// Pre-create the sibling test so the companion axis passes.
		writeFileSync(join(dir, "src", "withtest.test.ts"), "import './withtest.js';\n");
		expect(run("src/withtest.ts").untestedFiles).toHaveLength(0);
	});

	it("does NOT flag a test file itself (exempt extension/path)", () => {
		expect(run("src/foo.test.ts").untestedFiles).toHaveLength(0);
	});

	it("does NOT flag a DATA-only module (no runtime logic to test)", () => {
		const abs = join(dir, "src", "rules.ts");
		const dataOnly =
			"export const RULES = [{ id: 'a', sev: 'high' }, { id: 'b', sev: 'low' }];\n" +
			"export type Sev = 'low' | 'high';\n";
		writeFileSync(abs, dataOnly);
		const r = emptyResults();
		runPerFileChecks({
			file: abs,
			content: dataOnly,
			cwd: dir,
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.untestedFiles).toHaveLength(0);
	});
});

describe("runPerFileChecks — strong_typing (any vs unknown)", () => {
	const run = (file: string, content: string): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("flags an explicit `: any` annotation in a non-test .ts file", () => {
		const r = run("/tmp/svc.ts", "export const a: any = 1;\n");
		expect(r.strongTyping).toHaveLength(1);
		expect(nonNull(r.strongTyping[0]).check).toBe("strong_typing");
		expect(nonNull(r.strongTyping[0]).line).toBe(1);
	});

	it("skips `as unknown` (kind !== 'any') but still flags the `: any` on the next line", () => {
		// findAnyTypes returns one `unknown` match and one `any` match; the
		// detector's `if (m.kind !== ANY_KIND) continue` must drop the unknown
		// one and keep only the `any`.
		const content = ["const cast = value as unknown as Target;", "const loose: any = cast;", ""].join(
			"\n",
		);
		const r = run("/tmp/svc.ts", content);
		expect(r.strongTyping).toHaveLength(1);
		expect(nonNull(r.strongTyping[0]).line).toBe(2);
	});

	it("does not run strong_typing on a .test.ts file (test exemption)", () => {
		expect(run("/tmp/svc.test.ts", "const a: any = 1;\n").strongTyping).toHaveLength(0);
	});

	it("does not run strong_typing on a file under __tests__/ (path exemption)", () => {
		expect(run("/tmp/__tests__/svc.ts", "const a: any = 1;\n").strongTyping).toHaveLength(0);
	});

	it("does not run strong_typing on a .spec.ts file (spec exemption)", () => {
		expect(run("/tmp/svc.spec.ts", "const a: any = 1;\n").strongTyping).toHaveLength(0);
	});

	it("does not run strong_typing on a generated file (generated exemption)", () => {
		expect(run("/tmp/svc.ts", "// @generated\nconst a: any = 1;\n").strongTyping).toHaveLength(0);
	});

	it("does not run strong_typing on a non-TS extension (.js)", () => {
		// .js is not TS_EXT/TSX_EXT, so the strong-typing detector is skipped
		// (the console/silent-catch checks still run on .js, but strongTyping
		// stays empty).
		expect(run("/tmp/svc.js", "const a: any = 1;\n").strongTyping).toHaveLength(0);
	});
});

describe("runPerFileChecks — phantom_imports", () => {
	const run = (file: string, content: string): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("flags a relative import that does not resolve to any file", () => {
		// The importing file lives in a directory that does not exist, so the
		// relative specifier cannot resolve — a phantom import.
		const dir = "/tmp/interlinked-fc-phantom-nonexistent-xyz";
		const r = run(join(dir, "x.ts"), 'import { y } from "./definitely-missing.js";\n');
		expect(r.phantomImports).toHaveLength(1);
		expect(nonNull(r.phantomImports[0]).check).toBe("phantom_imports");
		expect(nonNull(r.phantomImports[0]).message).toContain("./definitely-missing.js");
	});

	it("ignores bare (node_modules) specifiers — neither '.' nor '/' prefixed", () => {
		const dir = "/tmp/interlinked-fc-phantom-bare-xyz";
		expect(run(join(dir, "x.ts"), 'import os from "node:os";\n').phantomImports).toHaveLength(0);
	});

	it("ignores relative .json imports (the .json skip branch)", () => {
		const dir = "/tmp/interlinked-fc-phantom-json-xyz";
		// Resolves to nothing, but the `.json` extension short-circuits before
		// the resolve check, so no phantom finding is produced.
		expect(run(join(dir, "x.ts"), 'import data from "./missing.json";\n').phantomImports).toHaveLength(
			0,
		);
	});

	it("treats an absolute ('/') specifier that does not resolve as phantom", () => {
		const r = run(
			"/tmp/interlinked-fc-phantom-abs-xyz/x.ts",
			'import { z } from "/nonexistent-abs-interlinked-fc/mod.js";\n',
		);
		expect(r.phantomImports).toHaveLength(1);
		expect(nonNull(r.phantomImports[0]).message).toContain("/nonexistent-abs-interlinked-fc/mod.js");
	});

	it("does not run phantom_imports on a non-JS/TS extension", () => {
		// A .py file is not in JS_TS_EXTS, so the phantom-import pass is skipped
		// entirely even though the specifier would not resolve.
		expect(
			run("/tmp/interlinked-fc-phantom-py-xyz/x.py", 'import { y } from "./missing.js";\n')
				.phantomImports,
		).toHaveLength(0);
	});
});

describe("runPerFileChecks — test regressions and env-ref accumulation", () => {
	const run = (
		file: string,
		content: string,
		allEnvRefs: Map<string, Array<{ file: string; line: number }>>,
	): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file,
			content,
			cwd: "/tmp",
			r,
			moduleExportsCache: new Map(),
			allEnvRefs,
			piiOpts: {},
		});
		return r;
	};

	it("records skipped tests via test_regressions", () => {
		const r = run("/tmp/foo.test.ts", 'describe.skip("later", () => {});\n', new Map());
		expect(r.testRegressions.length).toBeGreaterThan(0);
		expect(nonNull(r.testRegressions[0]).check).toBe("test_regressions");
	});

	it("does not push test_regressions when there are no skipped tests", () => {
		const r = run("/tmp/foo.test.ts", 'it("runs", () => { expect(1).toBe(1); });\n', new Map());
		expect(r.testRegressions).toHaveLength(0);
	});

	it("accumulates env references into the shared map (first ref creates the entry)", () => {
		const allEnvRefs = new Map<string, Array<{ file: string; line: number }>>();
		run("/tmp/svc.ts", "const t = process.env.MY_SECRET_TOKEN;\n", allEnvRefs);
		const entry = allEnvRefs.get("MY_SECRET_TOKEN");
		expect(entry).toBeDefined();
		expect(entry).toHaveLength(1);
		expect(entry?.[0]).toMatchObject({ file: "svc.ts", line: 1 });
	});

	it("appends to an existing env-ref entry across two files (the `|| []` reuse path)", () => {
		const allEnvRefs = new Map<string, Array<{ file: string; line: number }>>();
		// Pre-seed the map so the second occurrence hits the existing-array
		// branch of `allEnvRefs.get(ref.name) || []`.
		run("/tmp/a.ts", "const x = process.env.SHARED_ENV_KEY;\n", allEnvRefs);
		run("/tmp/b.ts", "const y = process.env.SHARED_ENV_KEY;\n", allEnvRefs);
		const entry = allEnvRefs.get("SHARED_ENV_KEY");
		expect(entry).toHaveLength(2);
		expect(entry?.map((e) => e.file)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("runPerFileChecks — mock_drift against cached module exports", () => {
	let dir: string;
	let realModule: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-fc-mockdrift-"));
		realModule = join(dir, "real-module.ts");
		// The real module exports `present` but NOT `ghost`.
		writeFileSync(realModule, "export function present() {}\n", "utf-8");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const runMock = (
		content: string,
		moduleExportsCache: Map<string, string[]>,
	): CodeQualityResults => {
		const r = emptyResults();
		runPerFileChecks({
			file: join(dir, "subject.test.ts"),
			content,
			cwd: dir,
			r,
			moduleExportsCache,
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		return r;
	};

	it("flags a mocked name that the resolved module does not export", () => {
		const cache = new Map<string, string[]>([[realModule, ["present"]]]);
		const content = 'vi.mock("./real-module.js", () => ({ ghost: vi.fn() }));\n';
		const r = runMock(content, cache);
		expect(r.mockDrift).toHaveLength(1);
		expect(nonNull(r.mockDrift[0]).check).toBe("mock_drift");
		expect(nonNull(r.mockDrift[0]).message).toContain('mock references "ghost"');
		expect(nonNull(r.mockDrift[0]).message).toContain("real-module.ts");
	});

	it("does not flag when every mocked name is a real export", () => {
		const cache = new Map<string, string[]>([[realModule, ["present"]]]);
		const content = 'vi.mock("./real-module.js", () => ({ present: vi.fn() }));\n';
		expect(runMock(content, cache).mockDrift).toHaveLength(0);
	});

	it("skips mocks whose module path does not resolve to any file", () => {
		const cache = new Map<string, string[]>([[realModule, ["present"]]]);
		const content = 'vi.mock("./does-not-exist.js", () => ({ ghost: vi.fn() }));\n';
		expect(runMock(content, cache).mockDrift).toHaveLength(0);
	});

	it("skips mocks whose resolved module is absent from the export cache", () => {
		// Resolves to a real file, but the cache has no entry for it → the
		// `if (!cachedExports) continue` branch fires.
		const content = 'vi.mock("./real-module.js", () => ({ ghost: vi.fn() }));\n';
		expect(runMock(content, new Map()).mockDrift).toHaveLength(0);
	});

	it("does not flag a relative import that DOES resolve as phantom (resolve-continue path)", () => {
		// `subject.ts` sits next to the on-disk `real-module.ts`, so the
		// `.js`→`.ts` specifier resolves and the phantom-import loop hits its
		// `if (resolveImportPath(...)) continue` branch — no phantom finding,
		// while a sibling unresolved import on the next line still fires.
		const r = emptyResults();
		runPerFileChecks({
			file: join(dir, "subject.ts"),
			content: [
				'import { present } from "./real-module.js";',
				'import { gone } from "./not-here.js";',
				"export const used = present;",
				"",
			].join("\n"),
			cwd: dir,
			r,
			moduleExportsCache: new Map(),
			allEnvRefs: new Map(),
			piiOpts: {},
		});
		expect(r.phantomImports).toHaveLength(1);
		expect(nonNull(r.phantomImports[0]).message).toContain("./not-here.js");
		expect(r.phantomImports.some((p) => p.message.includes("./real-module.js"))).toBe(false);
	});
});
