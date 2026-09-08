// Behavioral unit tests for the export-surface structural checks.
//
// Four pure-ish entry points under test:
//   - checkExportSurface          (graph-only; no IO)
//   - checkExportRippleCompilation(graph + CheckEngine via getOrCreateEngine)
//   - checkRippleTests            (graph + spawnSync(vitest) + findTestFileForSource)
//   - findTestFileForSource       (existsSync only)
//
// We mock the three IO boundaries the module touches so the tests are fully
// deterministic (no real subprocess / fs / time):
//   - node:child_process.spawnSync          -> controllable result
//   - node:fs.existsSync                    -> controllable predicate
//   - ../check-engine/index.js getOrCreateEngine -> stub engine
//
// Graph fixtures implement the methods consumed by these checks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, ImportEdge } from "../types/graph.js";

// --- mocks (declared before importing the SUT) -------------------------------

// existsSync is the only fs primitive findTestFileForSource uses. Default: no
// test file exists; individual tests override via existsImpl.
let existsImpl: (p: string) => boolean = () => false;
vi.mock("node:fs", () => ({
	existsSync: (p: string) => existsImpl(p),
}));

// spawnSync drives checkRippleTests; default is a clean pass. Individual tests
// override via spawnImpl.
type SpawnResult = {
	status: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException | null;
};
let spawnImpl: () => SpawnResult = () => ({
	status: 0,
	stdout: "",
	stderr: "",
	error: null,
});
const spawnSyncMock = vi.fn((..._args: unknown[]) => spawnImpl());
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// getOrCreateEngine drives checkExportRippleCompilation. We hand back a stub
// engine whose discoverTools / runChecks are programmable per test.
type EngineStub = {
	projectRoot: string;
	discoverTools: () => Array<{ id: string; available: boolean }>;
	runChecks: (...args: unknown[]) => {
		results: Array<{ severity: string; ruleId?: string }>;
	};
};
let engineStub: EngineStub;
vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: (root: string) => {
		engineStub.projectRoot = engineStub.projectRoot || root;
		return engineStub;
	},
}));

import { nonNull } from "../../lib/non-null.js";
// Import the SUT *after* the mocks are registered.
import {
	checkExportRippleCompilation,
	checkExportSurface,
	checkRippleTests,
	findTestFileForSource,
} from "./export-surface.js";

// --- fixture helpers ---------------------------------------------------------

function exp(name: string, kind: ExportedSymbol["kind"] = "function"): ExportedSymbol {
	return { name, kind, isTypeOnly: false, line: 1 };
}

function edge(symbols: string[], fromFile: string): ImportEdge {
	return {
		fromFile,
		toFile: "/proj/target.ts",
		specifier: "./target",
		symbols,
		isTypeOnly: false,
	};
}

/** Stub graph exposing only the methods the SUT consumes. */
function makeGraph(opts: {
	exports?: ExportedSymbol[];
	dependents?: string[];
	importers?: ImportEdge[];
	role?: "leaf" | "internal" | "hub" | "root";
	projectBoundary?: string;
} = {}): Pick<ProjectGraph, "getExports" | "getDependents" | "getImporters" | "classifyModule" | "getProjectBoundary" | "toRelative"> {
	const boundary = opts.projectBoundary ?? "/proj";
	return {
		getExports: vi.fn().mockReturnValue(opts.exports ?? []),
		getDependents: vi.fn().mockReturnValue(opts.dependents ?? []),
		getImporters: vi.fn().mockReturnValue(opts.importers ?? []),
		classifyModule: vi.fn().mockReturnValue(opts.role ?? "leaf"),
		getProjectBoundary: vi.fn().mockReturnValue(boundary),
		toRelative: vi.fn((f: string) => f.replace(`${boundary}/`, "")),
	};
}

const FILE = "/proj/target.ts";
const REL = "target.ts";

beforeEach(() => {
	existsImpl = () => false;
	spawnImpl = () => ({ status: 0, stdout: "", stderr: "", error: null });
	spawnSyncMock.mockClear();
	engineStub = {
		projectRoot: "/proj",
		discoverTools: () => [{ id: "tsc", available: true }],
		runChecks: vi.fn(() => ({ results: [] })),
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

// =============================================================================
// checkExportSurface
// =============================================================================

describe("checkExportSurface", () => {
	it("returns [] when the export surface did not change (L33)", () => {
		const sym = [exp("foo")];
		// old === new (same name/kind/isTypeOnly) => exportSurfaceChanged false.
		const graph = makeGraph({ exports: sym });
		expect(checkExportSurface(FILE, REL, sym, graph)).toEqual([]);
	});

	it("returns [] when exports were added, not removed (L41-44)", () => {
		// old: [foo]; new: [foo, bar] => surface changed but nothing removed.
		const graph = makeGraph({ exports: [exp("foo"), exp("bar")] });
		expect(checkExportSurface(FILE, REL, [exp("foo")], graph)).toEqual([]);
	});

	it('ignores a removed "*" wildcard export (L39)', () => {
		// old has "*" + foo; new keeps foo. "*" is filtered out of removedExports,
		// so removedExports is empty => returns [].
		const graph = makeGraph({ exports: [exp("foo")] });
		const old = [exp("foo"), exp("*", "namespace")];
		expect(checkExportSurface(FILE, REL, old, graph)).toEqual([]);
	});

	it("returns [] when there are removed exports but no dependents (L46-47)", () => {
		const graph = makeGraph({ exports: [], dependents: [] });
		expect(checkExportSurface(FILE, REL, [exp("foo")], graph)).toEqual([]);
	});

	it("returns [] when dependents exist but none import the removed symbol (L60)", () => {
		// dependent imports `bar`, which was not removed (only `foo` was).
		const graph = makeGraph({
			exports: [exp("bar")],
			dependents: ["/proj/a.ts"],
			importers: [edge(["bar"], "/proj/a.ts")],
		});
		expect(checkExportSurface(FILE, REL, [exp("foo"), exp("bar")], graph)).toEqual([]);
	});

	it("flags an importer that uses the removed symbol (usesRemoved branch)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [edge(["foo"], "/proj/a.ts")],
			role: "leaf",
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "export_surface",
			severity: "error",
			file: FILE,
			affectedFiles: ["/proj/a.ts"],
		});
		expect(nonNull(out[0]).message).toContain("Removed export(s) `foo`");
		expect(nonNull(out[0]).message).toContain("a.ts");
		expect(nonNull(out[0]).message).toContain("Update or remove the stale imports.");
		// non-hub => no "(hub module)" annotation
		expect(nonNull(out[0]).message).not.toContain("hub module");
	});

	it("flags a namespace/wildcard importer (empty symbols => always affected, L54)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/ns.ts"],
			importers: [edge([], "/proj/ns.ts")],
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).affectedFiles).toEqual(["/proj/ns.ts"]);
	});

	it("annotates hub modules in the message (role === hub, L72/L74)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [edge(["foo"], "/proj/a.ts")],
			role: "hub",
		});
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).severity).toBe("error");
		expect(nonNull(out[0]).message).toContain("(hub module)");
	});

	it("joins multiple removed names with comma (L62)", () => {
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [edge(["foo", "bar"], "/proj/a.ts")],
		});
		const out = checkExportSurface(FILE, REL, [exp("foo"), exp("bar")], graph);
		expect(nonNull(out[0]).message).toContain("`foo, bar`");
	});

	it('truncates the file list to 6 and appends "and N more" (L63-67)', () => {
		const importers: ImportEdge[] = [];
		const dependents: string[] = [];
		for (let i = 0; i < 8; i++) {
			const f = `/proj/imp${i}.ts`;
			importers.push(edge(["foo"], f));
			dependents.push(f);
		}
		const graph = makeGraph({ exports: [], dependents, importers });
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).affectedFiles).toHaveLength(8);
		// 8 - 6 = 2 more
		expect(nonNull(out[0]).message).toContain("and 2 more");
		// the 7th/8th files are not in the listed prefix
		expect(nonNull(out[0]).message).toContain("imp0.ts");
		expect(nonNull(out[0]).message).not.toContain("imp7.ts, ");
	});

	it("does not append 'more' when affected files == 6 (boundary, no L67 suffix)", () => {
		const importers: ImportEdge[] = [];
		const dependents: string[] = [];
		for (let i = 0; i < 6; i++) {
			const f = `/proj/imp${i}.ts`;
			importers.push(edge(["foo"], f));
			dependents.push(f);
		}
		const graph = makeGraph({ exports: [], dependents, importers });
		const out = checkExportSurface(FILE, REL, [exp("foo")], graph);
		expect(nonNull(out[0]).affectedFiles).toHaveLength(6);
		expect(nonNull(out[0]).message).not.toContain("more");
	});

	it("returns [] when dependents exist but importers list is empty (affectedFiles empty, L60 false)", () => {
		// getDependents is non-empty so we pass L47, but getImporters yields no
		// edges => affectedFiles stays [] => the L60 block is skipped.
		const graph = makeGraph({
			exports: [],
			dependents: ["/proj/a.ts"],
			importers: [],
		});
		expect(checkExportSurface(FILE, REL, [exp("foo")], graph)).toEqual([]);
	});
});

// =============================================================================
// checkExportRippleCompilation
// =============================================================================

describe("checkExportRippleCompilation", () => {
	it("returns [] when affectedFiles is empty (L96)", () => {
		const graph = makeGraph();
		expect(checkExportRippleCompilation(FILE, REL, [], graph)).toEqual([]);
	});

	it("returns [] when tsc is not available (L109)", () => {
		engineStub.discoverTools = () => [{ id: "tsc", available: false }];
		const graph = makeGraph();
		expect(checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph)).toEqual([]);
	});

	it("returns [] when tsc tool is entirely absent (find -> undefined, L109)", () => {
		engineStub.discoverTools = () => [{ id: "biome", available: true }];
		const graph = makeGraph();
		expect(checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph)).toEqual([]);
	});

	it("returns [] when affected files compile cleanly (no error results, L126 false)", () => {
		engineStub.runChecks = () => ({ results: [{ severity: "warning" }] });
		const graph = makeGraph();
		expect(checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph)).toEqual([]);
	});

	it("reports broken importers with per-file error counts (L126-148)", () => {
		engineStub.runChecks = () => ({
			results: [{ severity: "error" }, { severity: "error" }, { severity: "warning" }],
		});
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "export_ripple_compilation",
			severity: "warning",
			file: FILE,
		});
		expect(nonNull(out[0]).message).toContain("broke 1 importer(s)");
		expect(nonNull(out[0]).detail).toContain("a.ts: 2 error(s)");
		expect(nonNull(out[0]).affectedFiles).toEqual(["/proj/a.ts"]);
		// only one affected file, under RIPPLE_MAX_FILES => no skipped suffix
		expect(nonNull(out[0]).detail).not.toContain("not checked");
	});

	it("caps checked files at RIPPLE_MAX_FILES and notes the skipped remainder (L101, L135-138)", () => {
		// 7 affected files; only the first 5 are checked.
		engineStub.runChecks = vi.fn(() => ({ results: [{ severity: "error" }] }));
		const affected = Array.from({ length: 7 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, affected, graph);
		expect(out).toHaveLength(1);
		// runChecks invoked exactly RIPPLE_MAX_FILES (5) times
		expect(engineStub.runChecks).toHaveBeenCalledTimes(5);
		expect(nonNull(out[0]).message).toContain("broke 5 importer(s)");
		// 7 - 5 = 2 more not checked
		expect(nonNull(out[0]).detail).toContain("(2 more file(s) not checked)");
	});

	it("passes a file-scoped, tsc-only check request to the engine (L115-123)", () => {
		const runChecks = vi.fn(() => ({ results: [] }));
		engineStub.runChecks = runChecks;
		const graph = makeGraph();
		checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(runChecks).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRoot: engineStub.projectRoot,
				mode: "file",
				targetFile: "/proj/a.ts",
				filterToFile: true,
			}),
			expect.objectContaining({ tools: ["tsc"] }),
		);
	});

	it("reports an honest deferral when the tsc runner says it was unavailable", () => {
		engineStub.runChecks = vi.fn(() => ({
			results: [{ severity: "warning", ruleId: "tsc-unavailable" }],
		}));
		const graph = makeGraph();
		const out = checkExportRippleCompilation(FILE, REL, ["/proj/a.ts"], graph);
		expect(out).toEqual([
			expect.objectContaining({
				check: "export_ripple_compilation_deferred",
				severity: "info",
				file: FILE,
				affectedFiles: ["/proj/a.ts"],
			}),
		]);
		expect(engineStub.runChecks).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// checkRippleTests
// =============================================================================

describe("checkRippleTests", () => {
	it("returns [] when no test file exists for the source (L165-166)", () => {
		existsImpl = () => false; // findTestFileForSource -> null
		const graph = makeGraph();
		expect(checkRippleTests(FILE, REL, graph)).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns [] when vitest is not installed (ENOENT, L181-184)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({
			status: null,
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		});
		const graph = makeGraph();
		expect(checkRippleTests(FILE, REL, graph)).toEqual([]);
	});

	it("returns [] when tests pass (status 0, L186 false)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: 0, stdout: "ok", stderr: "", error: null });
		const graph = makeGraph();
		expect(checkRippleTests(FILE, REL, graph)).toEqual([]);
	});

	it("returns [] when status is null without ENOENT (e.g. timeout signal, L186 false)", () => {
		// status === null (process killed/timed out) is explicitly NOT treated as
		// a test failure by the L186 guard.
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: null, stdout: "", stderr: "", error: null });
		const graph = makeGraph();
		expect(checkRippleTests(FILE, REL, graph)).toEqual([]);
	});

	it("reports a warning with the last 8 stdout lines on test failure (L186-199)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		const lines = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
		spawnImpl = () => ({ status: 1, stdout: lines, stderr: "", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "export_ripple_tests",
			severity: "warning",
			file: FILE,
		});
		expect(nonNull(out[0]).message).toContain("Tests failed for target.ts");
		expect(nonNull(out[0]).affectedFiles).toEqual(["/proj/target.test.ts"]);
		// last 8 lines: line4..line11 kept, line0..line3 dropped
		expect(nonNull(out[0]).detail).toContain("line11");
		expect(nonNull(out[0]).detail).toContain("line4");
		expect(nonNull(out[0]).detail).not.toContain("line3\n");
	});

	it("falls back to stderr when stdout is empty (L187)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({ status: 1, stdout: "", stderr: "boom on stderr", error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(nonNull(out[0]).detail).toContain("boom on stderr");
	});

	it("handles undefined stdout/stderr gracefully (L187 `|| \"\"`)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		// neither stdout nor stderr present
		spawnImpl = () => ({ status: 1, error: null });
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(out).toHaveLength(1);
		// empty output => detail is the empty-string split, i.e. ""
		expect(nonNull(out[0]).detail).toBe("");
	});

	it("spawns vitest run on the test path scoped to the project root (L173-179)", () => {
		existsImpl = (p) => p.endsWith("target.test.ts");
		const graph = makeGraph({ projectBoundary: "/proj" });
		checkRippleTests(FILE, REL, graph);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"npx",
			["vitest", "run", "target.test.ts", "--reporter=verbose"],
			expect.objectContaining({ shell: false, cwd: "/proj" }),
		);
	});

	it("treats a non-ENOENT spawn error as a real run (proceeds past L181)", () => {
		// error present but code !== ENOENT => the early-return guard is skipped,
		// and status 1 then produces a failure warning.
		existsImpl = (p) => p.endsWith("target.test.ts");
		spawnImpl = () => ({
			status: 1,
			stdout: "failed",
			stderr: "",
			error: Object.assign(new Error("other"), { code: "EPERM" }),
		});
		const graph = makeGraph();
		const out = checkRippleTests(FILE, REL, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).check).toBe("export_ripple_tests");
	});
});

// =============================================================================
// findTestFileForSource
// =============================================================================

describe("findTestFileForSource", () => {
	it("returns null when the file itself is a .test file (L217)", () => {
		expect(findTestFileForSource("/proj/foo.test.ts")).toBeNull();
	});

	it("returns null when the file itself is a .spec file (L217)", () => {
		expect(findTestFileForSource("/proj/foo.spec.ts")).toBeNull();
	});

	it("returns the sibling `${base}.test${ext}` candidate (L220)", () => {
		existsImpl = (p) => p === "/proj/foo.test.ts";
		expect(findTestFileForSource("/proj/foo.ts")).toBe("/proj/foo.test.ts");
	});

	it("returns the sibling `${base}.spec${ext}` candidate (L221)", () => {
		existsImpl = (p) => p === "/proj/foo.spec.ts";
		expect(findTestFileForSource("/proj/foo.ts")).toBe("/proj/foo.spec.ts");
	});

	it("returns the __tests__/<name>.test candidate (L222)", () => {
		existsImpl = (p) => p === "/proj/__tests__/foo.test.ts";
		expect(findTestFileForSource("/proj/foo.ts")).toBe("/proj/__tests__/foo.test.ts");
	});

	it("returns the __tests__/<name>.spec candidate (L223)", () => {
		existsImpl = (p) => p === "/proj/__tests__/foo.spec.ts";
		expect(findTestFileForSource("/proj/foo.ts")).toBe("/proj/__tests__/foo.spec.ts");
	});

	it("returns null when none of the candidates exist (L226)", () => {
		existsImpl = () => false;
		expect(findTestFileForSource("/proj/foo.ts")).toBeNull();
	});

	it("works for non-.ts extensions, preserving the original ext (L211-212)", () => {
		existsImpl = (p) => p === "/proj/foo.test.tsx";
		expect(findTestFileForSource("/proj/foo.tsx")).toBe("/proj/foo.test.tsx");
	});
});
