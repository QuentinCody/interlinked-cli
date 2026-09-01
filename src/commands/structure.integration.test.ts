// ===========================================
// interlinked structure — behavioral coverage
// ===========================================
// Drives every branch of the six exported `structure*Command` handlers in
// ./structure.ts. The module lazy-imports every harness/structure/* helper
// (dynamic `await import(...)`) to keep startup fast; vi.mock intercepts those
// specifiers the same as static imports, so each harness boundary is scripted
// deterministically with zero real I/O:
//   - ../lib/formatter        → identity `c.*` (assert raw substrings, no ANSI)
//   - node:fs                 → virtual filesystem (existsSync/readFileSync/
//                               writeFileSync/mkdirSync/rmSync)
//   - node:child_process      → execSync (git rev-parse stub / throw path)
//   - ../harness/structure/*  → loader, cache-manager, artifact-graph,
//                               extractors, structure-checks, schema-validator,
//                               rules — each a vi.fn we set per-test
// We assert real emitted strings (console.log / console.error), the JSON shape
// under --json, written-file side-effects, process.exitCode on the error/fatal
// paths, and EVERY branch (subcommands, dry-run vs --write, incremental vs full,
// ternaries, &&/||/?? short-circuits, catch handlers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AdoptionReport,
	ArtifactNode,
	BaselineFile,
	CatalogMeta,
	CategoryCatalog,
	StructureConfig,
	StructureFinding,
} from "../harness/structure/types.js";

// ---- ../lib/formatter mock: identity pass-through ----------------------
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
	},
}));

// ---- node:fs mock: virtual filesystem ---------------------------------
// fsFiles maps absolute path -> contents. existsSync = key present. writes
// mutate fsFiles; mkdirSync records dirs; rmSync deletes; fsReadThrows forces
// a read failure (parse/IO path).
let fsFiles: Record<string, string>;
let fsReadThrows: Set<string>;
let mkdirCalls: string[];
let mkdirThrows: string | null;
let writeCalls: Array<{ path: string; data: string }>;
let rmCalls: string[];

vi.mock("node:fs", () => ({
	existsSync: (p: string) => p in fsFiles,
	readFileSync: (p: string) => {
		if (fsReadThrows.has(p)) throw new Error(`EACCES ${p}`);
		if (!(p in fsFiles)) throw new Error(`ENOENT ${p}`);
		return fsFiles[p];
	},
	writeFileSync: (p: string, data: string) => {
		fsFiles[p] = data;
		writeCalls.push({ path: p, data });
	},
	mkdirSync: (p: string) => {
		if (mkdirThrows) throw new Error(mkdirThrows);
		mkdirCalls.push(p);
	},
	rmSync: (p: string) => {
		rmCalls.push(p);
		delete fsFiles[p];
	},
}));

// ---- node:child_process mock: git rev-parse ---------------------------
const execSyncMock = vi.fn<(cmd: string, opts?: unknown) => string>();
vi.mock("node:child_process", () => ({
	execSync: (cmd: string, opts?: unknown) => execSyncMock(cmd, opts),
}));

// ---- ../harness/structure/* mocks -------------------------------------
// Each scripted helper is a vi.fn the tests set per-case.
const loadStructureConfig = vi.fn();
const getImplicitConfig = vi.fn();
const loadArtifactFile = vi.fn();
vi.mock("../harness/structure/structure-loader.js", () => ({
	loadStructureConfig: (...a: unknown[]) => loadStructureConfig(...a),
	getImplicitConfig: () => getImplicitConfig(),
	loadArtifactFile: (...a: unknown[]) => loadArtifactFile(...a),
}));

const readCatalogMeta = vi.fn();
const readAdoptionReport = vi.fn();
const isCacheStale = vi.fn();
const computeManifestHash = vi.fn();
const ensureCacheDir = vi.fn();
const writeCatalogMeta = vi.fn();
const writeCategoryCache = vi.fn();
const writeAdoptionReport = vi.fn();
const readCategoryCache = vi.fn();
const readBaseline = vi.fn();
const writeBaseline = vi.fn();
vi.mock("../harness/structure/cache-manager.js", () => ({
	readCatalogMeta: (...a: unknown[]) => readCatalogMeta(...a),
	readAdoptionReport: (...a: unknown[]) => readAdoptionReport(...a),
	isCacheStale: (...a: unknown[]) => isCacheStale(...a),
	computeManifestHash: (...a: unknown[]) => computeManifestHash(...a),
	ensureCacheDir: (...a: unknown[]) => ensureCacheDir(...a),
	writeCatalogMeta: (...a: unknown[]) => writeCatalogMeta(...a),
	writeCategoryCache: (...a: unknown[]) => writeCategoryCache(...a),
	writeAdoptionReport: (...a: unknown[]) => writeAdoptionReport(...a),
	readCategoryCache: (...a: unknown[]) => readCategoryCache(...a),
	readBaseline: (...a: unknown[]) => readBaseline(...a),
	writeBaseline: (...a: unknown[]) => writeBaseline(...a),
}));

// A tiny in-memory ArtifactGraph stand-in. The handlers only use addNode,
// addEdge, getNodesByKind, toNodesJson, toEdgesJson, nodeCount, edgeCount.
class FakeGraph {
	nodes: ArtifactNode[] = [];
	edges: Array<{ id: string; provenance: string }> = [];
	addNode(n: ArtifactNode): void {
		this.nodes.push(n);
	}
	addEdge(e: { id: string; provenance: string }): void {
		this.edges.push(e);
	}
	getNodesByKind(kind: string): ArtifactNode[] {
		return this.nodes.filter((n) => n.kind === kind);
	}
	toNodesJson(): { nodes: ArtifactNode[] } {
		return { nodes: this.nodes };
	}
	toEdgesJson(): { edges: Array<{ id: string; provenance: string }> } {
		return { edges: this.edges };
	}
	get nodeCount(): number {
		return this.nodes.length;
	}
	get edgeCount(): number {
		return this.edges.length;
	}
}
vi.mock("../harness/structure/artifact-graph.js", () => ({
	ArtifactGraph: FakeGraph,
}));

const runAllExtractors = vi.fn();
vi.mock("../harness/structure/extractors/index.js", () => ({
	runAllExtractors: (...a: unknown[]) => runAllExtractors(...a),
}));

const layerDeclaredArtifacts = vi.fn();
vi.mock("../harness/structure/structure-checks.js", () => ({
	layerDeclaredArtifacts: (...a: unknown[]) => layerDeclaredArtifacts(...a),
}));

const validateStructureJson = vi.fn();
vi.mock("../harness/structure/schema-validator.js", () => ({
	validateStructureJson: (...a: unknown[]) => validateStructureJson(...a),
}));

const evaluateStructureRules = vi.fn();
vi.mock("../harness/structure/rules/index.js", () => ({
	evaluateStructureRules: (...a: unknown[]) => evaluateStructureRules(...a),
}));

import { nonNull } from "../lib/non-null.js";
import {
	structureAcceptCommand,
	structureBaselineCommand,
	structureDoctorCommand,
	structureInitCommand,
	structureScanCommand,
	structureStatusCommand,
} from "./structure.js";

// --- console capture ---------------------------------------------------
let logged: string[];
let errored: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function stdout(): string {
	return logged.join("\n");
}
function stderr(): string {
	return errored.join("\n");
}

const CWD = "/proj";

// --- fixtures ----------------------------------------------------------
function fullConfig(over: Partial<StructureConfig> = {}): StructureConfig {
	return {
		version: 1,
		mode: "standard",
		artifacts: {},
		verify: {
			fail_on_deterministic: true,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 5,
		},
		adoption: {
			coverage_thresholds: {
				public_api: 0,
				env: 0,
				config: 0,
				tests: 0,
				docs: 0,
				examples: 0,
				glossary: 0,
				layers: 0,
				packages: 0,
			},
		},
		builtins: {
			public_symbol_companions: true,
			env_key_companions: true,
			config_key_companions: true,
			layer_boundary_violations: true,
			glossary_residue: true,
			package_boundary_violations: true,
		},
		...over,
	};
}

function meta(over: Partial<CatalogMeta> = {}): CatalogMeta {
	return {
		schema_version: 1,
		cli_version: "0.0.0",
		built_at: "2026-01-01T00:00:00.000Z",
		repo_root: CWD,
		last_scanned_commit: "abc",
		manifest_hash: "hash",
		extractor_versions: {},
		...over,
	};
}

function node(over: Partial<ArtifactNode> = {}): ArtifactNode {
	return {
		id: "module:m",
		kind: "module",
		label: "m",
		file: "src/m.ts",
		provenance: "extracted",
		determinism_ceiling: "fully_deterministic",
		...over,
	};
}

function catalog(items: CategoryCatalog["items"]): CategoryCatalog {
	return { schema_version: 1, items };
}

beforeEach(() => {
	fsFiles = {};
	fsReadThrows = new Set();
	mkdirCalls = [];
	mkdirThrows = null;
	writeCalls = [];
	rmCalls = [];
	logged = [];
	errored = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errored.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});

	// Reset every scripted helper + neutral defaults.
	for (const fn of [
		loadStructureConfig,
		getImplicitConfig,
		loadArtifactFile,
		readCatalogMeta,
		readAdoptionReport,
		isCacheStale,
		computeManifestHash,
		ensureCacheDir,
		writeCatalogMeta,
		writeCategoryCache,
		writeAdoptionReport,
		readCategoryCache,
		readBaseline,
		writeBaseline,
		runAllExtractors,
		layerDeclaredArtifacts,
		validateStructureJson,
		evaluateStructureRules,
		execSyncMock,
	])
		fn.mockReset();

	getImplicitConfig.mockReturnValue(fullConfig({ mode: "minimal" }));
	loadStructureConfig.mockReturnValue({ config: null, errors: [], implicit: true });
	computeManifestHash.mockReturnValue("hash");
	execSyncMock.mockReturnValue("deadbeef\n");
	vi.spyOn(process, "cwd").mockReturnValue(CWD);

	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ===========================================
// 1. structure init
// ===========================================

describe("structureInitCommand", () => {
	it("dry-run (no --write) lists files with create/overwrite tags and the --write hint", async () => {
		await structureInitCommand({});
		const o = stdout();
		expect(o).toContain("Structure init (dry-run)");
		expect(o).toContain("Mode: standard");
		expect(o).toContain("Categories: (none)");
		// structure.json does not exist -> "create" tag
		expect(o).toContain("create  interlinked/structure.json");
		expect(o).toContain("Run with --write to create files.");
		// dry-run never writes
		expect(writeCalls).toHaveLength(0);
	});

	it("dry-run marks an existing target as 'overwrite'", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{}";
		await structureInitCommand({});
		expect(stdout()).toContain("overwrite  interlinked/structure.json");
	});

	it("dry-run --json emits the planned shape", async () => {
		await structureInitCommand({ json: true, with: "env, docs" });
		const parsed = JSON.parse(stdout());
		expect(parsed).toEqual({
			dry_run: true,
			mode: "standard",
			categories: ["env", "docs"],
			files: [
				"interlinked/structure.json",
				"interlinked/artifacts/env.json",
				"interlinked/artifacts/docs.json",
			],
		});
	});

	it("--write creates structure.json + scaffolds and prints next-step hint", async () => {
		await structureInitCommand({ write: true, mode: "strict", with: "public_api" });
		const o = stdout();
		expect(o).toContain("Structure initialized.");
		expect(o).toContain("Mode: strict");
		expect(o).toContain("Artifacts: public_api");
		expect(o).toContain("interlinked structure scan");
		// structure.json carries mode + artifacts map; scaffold file written too
		const cfgWrite = writeCalls.find((w) => w.path === `${CWD}/interlinked/structure.json`);
		expect(cfgWrite).toBeDefined();
		expect(JSON.parse((cfgWrite as { data: string }).data)).toEqual({
			version: 1,
			mode: "strict",
			artifacts: { public_api: "artifacts/public-api.json" },
		});
		expect(
			writeCalls.some((w) => w.path === `${CWD}/interlinked/artifacts/public-api.json`),
		).toBe(true);
	});

	it("--write with no categories omits the artifacts key and the Artifacts line", async () => {
		await structureInitCommand({ write: true });
		const cfgWrite = writeCalls.find((w) => w.path === `${CWD}/interlinked/structure.json`);
		expect(JSON.parse((cfgWrite as { data: string }).data)).toEqual({ version: 1, mode: "standard" });
		expect(stdout()).not.toContain("Artifacts:");
	});

	it("--write --json reports created:true", async () => {
		await structureInitCommand({ write: true, json: true });
		expect(JSON.parse(stdout())).toEqual({
			created: true,
			mode: "standard",
			categories: [],
			files: ["interlinked/structure.json"],
		});
	});

	it("rejects an invalid mode via fatal (exitCode 1, no throw escaping)", async () => {
		await structureInitCommand({ mode: "bogus" });
		expect(stderr()).toContain('Invalid mode "bogus"');
		expect(stderr()).toContain("minimal, standard, strict");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an unknown category via fatal", async () => {
		await structureInitCommand({ with: "nope" });
		expect(stderr()).toContain('Unknown category "nope"');
		expect(process.exitCode).toBe(1);
	});

	it("catch path: a non-fatal throw is reported and sets exitCode 1", async () => {
		// Force writeJson -> writeFileSync to throw on the --write branch.
		const boom = `${CWD}/interlinked/structure.json`;
		const realWrite = writeCalls;
		void realWrite;
		// Make the FS write throw by replacing fsFiles with a trapped proxy isn't
		// straightforward; instead drive a throw from VALID_MODES import path is
		// impossible. Use execSync? Not in init. Simplest: make mkdirSync throw.
		mkdirCalls = new Proxy([], {
			get() {
				throw new Error("disk full");
			},
		}) as unknown as string[];
		await structureInitCommand({ write: true });
		expect(stderr()).toContain("structure init failed: disk full");
		expect(process.exitCode).toBe(1);
		void boom;
	});
});

// ===========================================
// 2. structure scan
// ===========================================

describe("structureScanCommand", () => {
	function primeExtractors(nodes: ArtifactNode[] = [node()]): void {
		runAllExtractors.mockReturnValue({ nodes, edges: [{ id: "e1", provenance: "extracted" }] });
	}

	it("full scan (no cache) writes caches, adoption, meta and prints summary", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		const o = stdout();
		expect(o).toContain("Scan complete.");
		expect(o).toContain("full scan");
		expect(o).toContain("Nodes:   1");
		expect(o).toContain("Edges:   1");
		expect(ensureCacheDir).toHaveBeenCalledWith(CWD);
		expect(writeCatalogMeta).toHaveBeenCalledTimes(1);
		expect(writeAdoptionReport).toHaveBeenCalledTimes(1);
		expect(layerDeclaredArtifacts).toHaveBeenCalledTimes(1);
		// git commit captured from execSync
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta.last_scanned_commit).toBe("deadbeef");
	});

	it("incremental default kicks in when a cache exists", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(meta());
		await structureScanCommand({});
		expect(stdout()).toContain("incremental scan");
	});

	it("--full forces a full scan even when a cache exists", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(meta());
		await structureScanCommand({ full: true });
		expect(stdout()).toContain("full scan");
	});

	it("--incremental with no cache prints the fallback notice", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({ incremental: true });
		expect(stdout()).toContain("No cache found. Running full scan.");
		// incremental requested but reported as incremental mode (opts.incremental wins)
		expect(stdout()).toContain("incremental scan");
	});

	it("surfaces loader errors as warnings and uses the loaded config mode", async () => {
		primeExtractors();
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "strict" }),
			errors: ["bad-thing"],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).toContain("Warning: bad-thing");
		expect(stdout()).toContain("Config:  strict");
	});

	it("git unavailable: execSync throws, last_scanned_commit stays empty", async () => {
		primeExtractors();
		readCatalogMeta.mockReturnValue(null);
		execSyncMock.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		await structureScanCommand({});
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta.last_scanned_commit).toBe("");
		expect(stdout()).toContain("Scan complete.");
	});

	it("--json emits the summary object", async () => {
		primeExtractors([node(), node({ id: "module:m2", label: "m2" })]);
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.mode).toBe("full");
		expect(parsed.nodes).toBe(2);
		expect(parsed.config_mode).toBe("minimal");
		expect(typeof parsed.elapsed_ms).toBe("number");
	});

	it("adoption: declared nodes contribute a non-zero ratio per category", async () => {
		// Two public_symbol nodes, one declared -> 0.5 adoption for public_api.
		runAllExtractors.mockReturnValue({
			nodes: [
				node({ id: "public_symbol:a#x", kind: "public_symbol", provenance: "declared" }),
				node({ id: "public_symbol:a#y", kind: "public_symbol", provenance: "extracted" }),
			],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		const report = (writeAdoptionReport.mock.calls[0] as unknown[])[1] as AdoptionReport;
		expect(report.categories.public_api).toBe(0.5);
		// a category with no nodes is 0
		expect(report.categories.docs).toBe(0);
	});

	it("node id without a ':' keeps its full id as the local_id (extractLocalId else)", async () => {
		runAllExtractors.mockReturnValue({
			nodes: [node({ id: "noColon", kind: "module", label: "noColon" })],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		// the artifact-nodes cache write carries local_id === full id (no prefix stripped)
		const nodesWrite = writeCategoryCache.mock.calls.find(
			(call) => (call as unknown[])[1] === "artifact-nodes",
		);
		const payload = (nodesWrite as unknown[])[2] as CategoryCatalog;
		expect(nonNull(payload.items[0]).local_id).toBe("noColon");
		expect(nonNull(payload.items[0]).global_ref).toBe("noColon");
	});

	it("catch path: extractor throwing sets exitCode 1 + structured error", async () => {
		runAllExtractors.mockImplementation(() => {
			throw new Error("extractor boom");
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).toContain("structure scan failed: extractor boom");
		expect(process.exitCode).toBe(1);
	});

	it("catch path: a throw with exitCode already 1 returns silently (no double-report)", async () => {
		// Simulate a downstream helper that set exitCode=1 (a fatal-style signal)
		// before throwing: the scan catch's `if (process.exitCode === 1) return`
		// must swallow it without emitting a second "scan failed" line.
		runAllExtractors.mockImplementation(() => {
			process.exitCode = 1;
			throw new Error("already-handled");
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stderr()).not.toContain("structure scan failed");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 3. structure status
// ===========================================

describe("structureStatusCommand", () => {
	it("implicit, no cache: prints not-built + implicit tag", async () => {
		readCatalogMeta.mockReturnValue(null);
		readAdoptionReport.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Structure Status");
		expect(o).toContain("Mode:     minimal (implicit, no structure.json)");
		expect(o).toContain("Cache:    not built");
	});

	it("fresh cache: Cache fresh + Built line + adoption table", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "standard" }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta({ built_at: "2026-02-02T00:00:00.000Z" }));
		isCacheStale.mockReturnValue(false);
		// 0.9 -> green (>=80), 0.6 -> yellow (>=50), 0.1 -> red (<50): all three
		// pctColor arms exercised in one render.
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { public_api: 0.9, env: 0.6, docs: 0.1 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Cache:    fresh");
		expect(o).toContain("Built:    2026-02-02T00:00:00.000Z");
		expect(o).toContain("Adoption:");
		expect(o).toContain("public_api");
		expect(o).toContain("90%");
		expect(o).toContain("60%");
		expect(o).toContain("10%");
		// not implicit -> no implicit tag
		expect(o).not.toContain("(implicit");
	});

	it("stale cache: Cache stale", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({});
		expect(stdout()).toContain("Cache:    stale");
	});

	it("invalid manifest references + loader errors are listed", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json" } }),
			errors: ["loader-err"],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		// env.json does NOT exist in fsFiles -> flagged invalid
		await structureStatusCommand({});
		const o = stdout();
		expect(o).toContain("Invalid manifest references:");
		expect(o).toContain("missing  env: interlinked/artifacts/env.json");
		expect(o).toContain("error  loader-err");
	});

	it("a declared artifact that exists on disk is NOT flagged invalid", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/env.json`] = "{}";
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({});
		expect(stdout()).not.toContain("Invalid manifest references:");
	});

	it("--json returns the full data object and emits no human text", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { docs: 0.5 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.config_mode).toBe("minimal");
		expect(parsed.implicit).toBe(true);
		expect(parsed.cache_exists).toBe(true);
		expect(parsed.cache_stale).toBe(false);
		expect(parsed.cache_built_at).toBe("2026-01-01T00:00:00.000Z");
		expect(parsed.adoption).toEqual({ docs: 0.5 });
		expect(parsed.invalid_files).toEqual([]);
	});

	it("--json with no cache reports cache_built_at null + adoption null", async () => {
		readCatalogMeta.mockReturnValue(null);
		isCacheStale.mockReturnValue(true);
		readAdoptionReport.mockReturnValue(null);
		await structureStatusCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.cache_built_at).toBeNull();
		expect(parsed.adoption).toBeNull();
		expect(parsed.cache_stale).toBe(true);
	});

	it("catch path: loader throwing sets exitCode 1", async () => {
		loadStructureConfig.mockImplementation(() => {
			throw new Error("status boom");
		});
		await structureStatusCommand({});
		expect(stderr()).toContain("structure status failed: status boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 4. structure accept
// ===========================================

describe("structureAcceptCommand", () => {
	it("nothing cached: prints the 'Nothing to accept' hint", async () => {
		readCategoryCache.mockReturnValue(null);
		await structureAcceptCommand({});
		expect(stdout()).toContain("Nothing to accept. Run `interlinked structure scan` first.");
	});

	it("accepts new public symbols into a fresh public-api file", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg-index#createClient",
							global_ref: "public_symbol:pkg-index#createClient",
							file: "src/index.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("Structure Accept");
		expect(o).toContain("accepted  public_api: 1 items");
		// public-api.json written with the new module/symbol
		const w = writeCalls.find((x) => x.path.endsWith("artifacts/public-api.json"));
		expect(w).toBeDefined();
		const file = JSON.parse((w as { data: string }).data);
		expect(file.modules[0].id).toBe("pkg-index");
		expect(file.modules[0].symbols[0].name).toBe("createClient");
	});

	it("skips a symbol already declared (dedup) and reports the skip", async () => {
		// Pre-existing public-api.json already declares pkg#x.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = JSON.stringify({
			version: 1,
			modules: [{ id: "pkg", file: "src/pkg.ts", symbols: [{ name: "x" }] }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg#x",
							global_ref: "public_symbol:pkg#x",
							file: "src/pkg.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("Skipped (already declared):");
		expect(o).toContain("skip  public_api/pkg#x: already declared");
		// nothing new accepted -> file not rewritten
		expect(writeCalls.some((x) => x.path === apiPath)).toBe(false);
	});

	it("symbol local_id without a '#' becomes its own module id and symbol", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "bareName",
							global_ref: "public_symbol:bareName",
							file: "src/bare.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const w = writeCalls.find((x) => x.path.endsWith("artifacts/public-api.json"));
		const file = JSON.parse((w as { data: string }).data);
		expect(file.modules[0].id).toBe("bareName");
		expect(file.modules[0].symbols[0].name).toBe("bareName");
	});

	it("accepts new env keys and skips existing ones", async () => {
		const envPath = `${CWD}/interlinked/artifacts/env.json`;
		fsFiles[envPath] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "OLD_KEY" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "env-keys"
				? catalog([
						{
							local_id: "NEW_KEY",
							global_ref: "env_key:NEW_KEY",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
						{
							local_id: "OLD_KEY",
							global_ref: "env_key:OLD_KEY",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const o = stdout();
		expect(o).toContain("accepted  env: 1 items");
		expect(o).toContain("skip  env/OLD_KEY: already declared");
		const w = writeCalls.find((x) => x.path === envPath);
		const file = JSON.parse((w as { data: string }).data);
		expect(file.keys.map((k: { name: string }) => k.name)).toEqual(["OLD_KEY", "NEW_KEY"]);
	});

	it("uses the configured artifact paths when structure.json declares them", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { public_api: "custom/api.json" } }),
			errors: [],
			implicit: false,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(writeCalls.some((x) => x.path === `${CWD}/interlinked/custom/api.json`)).toBe(true);
	});

	it("truncates the skip list past 10 and prints '... and N more'", async () => {
		// 12 already-declared symbols -> all skipped, list truncated at 10.
		const mods = Array.from({ length: 12 }, (_, i) => ({
			id: `m${i}`,
			file: "src/x.ts",
			symbols: [{ name: "s" }],
		}));
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: mods,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog(
						Array.from({ length: 12 }, (_, i) => ({
							local_id: `m${i}#s`,
							global_ref: `public_symbol:m${i}#s`,
							file: "src/x.ts",
							provenance: "extracted" as const,
							determinism_ceiling: "fully_deterministic" as const,
						})),
					)
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("... and 2 more");
	});

	it("--json emits accepted + skipped arrays", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.accepted).toEqual([{ category: "public_api", count: 1 }]);
		expect(parsed.skipped).toEqual([]);
	});

	it("env cache present but with all keys already declared: nothing accepted, file untouched (n===0)", async () => {
		const envPath = `${CWD}/interlinked/artifacts/env.json`;
		fsFiles[envPath] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "EXISTING" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "env-keys"
				? catalog([
						{
							local_id: "EXISTING",
							global_ref: "env_key:EXISTING",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		// all skipped -> n===0 -> env.json NOT rewritten
		expect(writeCalls.some((x) => x.path === envPath)).toBe(false);
		expect(stdout()).toContain("skip  env/EXISTING: already declared");
	});

	it("empty caches (present but zero items) accept nothing (length>0 guards both false)", async () => {
		// public-symbols and env-keys both present but with empty item lists ->
		// neither `*.items.length > 0` guard fires; result is the empty-accept hint.
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols" || name === "env-keys" ? catalog([]) : null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("Nothing to accept. Run `interlinked structure scan` first.");
		expect(writeCalls).toHaveLength(0);
	});

	it("adds a new symbol to an already-present module (exercises the module .find hit)", async () => {
		// public-api.json already has module "pkg" with symbol "x"; the catalog
		// brings a SECOND symbol "y" on the SAME module -> the file.modules.find
		// callback must match the existing module and append to it.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = JSON.stringify({
			version: 1,
			modules: [{ id: "pkg", file: "src/pkg.ts", symbols: [{ name: "x" }] }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "pkg#y",
							global_ref: "public_symbol:pkg#y",
							file: "src/pkg.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		const w = writeCalls.find((x) => x.path === apiPath);
		const file = JSON.parse((w as { data: string }).data);
		// Still one module, now two symbols.
		expect(file.modules).toHaveLength(1);
		expect(file.modules[0].symbols.map((s: { name: string }) => s.name)).toEqual(["x", "y"]);
	});

	it("corrupt artifact JSON falls back to an empty file (readJson catch)", async () => {
		// public-api.json exists but is unparseable -> readJson swallows + returns
		// the {version,modules:[]} fallback, so the symbol is accepted fresh.
		const apiPath = `${CWD}/interlinked/artifacts/public-api.json`;
		fsFiles[apiPath] = "{ this is not json";
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toContain("accepted  public_api: 1 items");
		const w = writeCalls.find((x) => x.path === apiPath);
		expect(JSON.parse((w as { data: string }).data).modules).toHaveLength(1);
	});

	it("catch path: cache read throwing sets exitCode 1", async () => {
		readCategoryCache.mockImplementation(() => {
			throw new Error("accept boom");
		});
		await structureAcceptCommand({});
		expect(stderr()).toContain("structure accept failed: accept boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 5. structure doctor
// ===========================================

describe("structureDoctorCommand", () => {
	it("clean repo (no structure.json, fresh cache): no issues", async () => {
		// structure.json absent -> info issue suppressed? No: doctorValidateConfig
		// returns an info issue when absent. So expect that info, plus a cache check.
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		loadArtifactFile.mockReturnValue({ data: null, errors: [] });
		await structureDoctorCommand({});
		const o = stdout();
		// the only issue is the implicit-mode info note
		expect(o).toContain("Structure Doctor: 1 issue(s)");
		expect(o).toContain("INFO  No interlinked/structure.json found (implicit minimal mode)");
	});

	it("reports invalid JSON in structure.json as an error and exits 1", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{ not json";
		fsReadThrows = new Set();
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("ERROR");
		expect(o).toContain("structure.json: invalid JSON");
		expect(process.exitCode).toBe(1);
	});

	it("reports schema-validation errors from a present, parseable structure.json", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1 });
		validateStructureJson.mockReturnValue({
			valid: false,
			errors: [{ path: ".mode", message: "required" }],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		expect(stdout()).toContain("structure.json .mode: required");
		expect(process.exitCode).toBe(1);
	});

	it("valid structure.json with no findings yields no config-validation error", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		loadArtifactFile.mockReturnValue({ data: null, errors: [] });
		await structureDoctorCommand({});
		expect(stdout()).toContain("Structure doctor: no issues found.");
		expect(process.exitCode).toBeUndefined();
	});

	it("missing artifact file => error; bad artifact-file errors => error", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { env: "artifacts/env.json", docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		// env.json missing on disk -> "Artifact file missing"
		// docs.json present but loadArtifactFile reports errors
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		loadArtifactFile.mockImplementation((_cwd: string, key: string) =>
			key === "docs" ? { data: null, errors: ["schema mismatch"] } : { data: null, errors: [] },
		);
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("Artifact file missing: interlinked/artifacts/env.json");
		expect(o).toContain("docs (artifacts/docs.json): schema mismatch");
		expect(process.exitCode).toBe(1);
	});

	it("warns on declared paths that do not exist on disk", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// docs file loads with a declared path that is missing from disk
		loadArtifactFile.mockReturnValue({
			data: { docs: [{ file: "docs/missing.md" }, { root: "also/gone" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("WARN");
		expect(o).toContain("declared path not found: docs/missing.md");
		expect(o).toContain("declared path not found: also/gone");
		// warnings only -> no error exit
		expect(process.exitCode).toBeUndefined();
	});

	it("skips artifact entries whose declared path is falsy (empty string)", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			// env: "" is falsy -> both doctorCheckFiles and doctorCheckPaths `continue`.
			config: fullConfig({ artifacts: { env: "" } }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		// the falsy entry produced no file/path issues
		expect(o).not.toContain("Artifact file missing");
		expect(o).not.toContain("declared path not found");
		// loadArtifactFile never consulted for the empty entry
		expect(loadArtifactFile).not.toHaveBeenCalled();
	});

	it("a declared path that exists on disk produces no warning (existsSync true arm)", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// the declared doc path DOES exist on disk -> existsSync true -> no warning
		fsFiles[`${CWD}/docs/present.md`] = "# present";
		loadArtifactFile.mockReturnValue({
			data: { docs: [{ file: "docs/present.md" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		expect(stdout()).not.toContain("declared path not found");
		expect(stdout()).toContain("Structure doctor: no issues found.");
	});

	it("ignores non-object items inside a declared path array", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1, mode: "standard" });
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ artifacts: { docs: "artifacts/docs.json" } }),
			errors: [],
			implicit: false,
		});
		fsFiles[`${CWD}/interlinked/artifacts/docs.json`] = "{}";
		// docs array mixes a string and null (non-objects -> skipped) with one
		// real record whose file is missing on disk (-> the only warning).
		loadArtifactFile.mockReturnValue({
			data: { docs: ["just-a-string", null, { file: "docs/real-missing.md" }] },
			errors: [],
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(false);
		await structureDoctorCommand({});
		const o = stdout();
		expect(o).toContain("declared path not found: docs/real-missing.md");
		// exactly one path-not-found warning (the non-objects contributed none)
		expect(o.match(/declared path not found/g)).toHaveLength(1);
	});

	it("warns when there is no scan cache", async () => {
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({});
		expect(stdout()).toContain("No scan cache. Run `interlinked structure scan`.");
	});

	it("warns when the scan cache is stale", async () => {
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(true);
		await structureDoctorCommand({});
		expect(stdout()).toContain("Scan cache is stale. Re-run `interlinked structure scan`.");
	});

	it("--json emits issues + total", async () => {
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.total).toBe(parsed.issues.length);
		expect(parsed.issues.some((i: { message: string }) => i.message.includes("No scan cache"))).toBe(
			true,
		);
	});

	it("catch path: schema-validator throwing sets exitCode 1", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = JSON.stringify({ version: 1 });
		validateStructureJson.mockImplementation(() => {
			throw new Error("doctor boom");
		});
		await structureDoctorCommand({});
		expect(stderr()).toContain("structure doctor failed: doctor boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// 6. structure baseline
// ===========================================

describe("structureBaselineCommand", () => {
	function finding(over: Partial<StructureFinding> = {}): StructureFinding {
		return {
			name: "public_symbol_companions",
			severity: "warning",
			message: "missing companion",
			file: "src/m.ts",
			determinism: "fully_deterministic",
			provenance: "extracted",
			artifact_kind: "public_symbol",
			artifact_id: "m#s",
			required_updates: [{ file: "docs/m.md", kind: "doc", reason: "doc it" }],
			confidence: 1,
			...over,
		};
	}

	it("save: builds a baseline from rule findings and writes it", async () => {
		readCategoryCache.mockReturnValue(
			catalog([
				{
					local_id: "m#s",
					global_ref: "public_symbol:m#s",
					file: "src/m.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
		);
		evaluateStructureRules.mockReturnValue([finding(), finding({ name: "env_key_companions" })]);
		await structureBaselineCommand("save", {});
		const o = stdout();
		expect(o).toContain("Baseline saved.");
		expect(o).toContain("2 findings baselined.");
		expect(writeBaseline).toHaveBeenCalledTimes(1);
		const bl = (writeBaseline.mock.calls[0] as unknown[])[1] as BaselineFile;
		expect(bl.entries).toHaveLength(2);
		expect(bl.entries[0]).toMatchObject({
			finding_name: "public_symbol_companions",
			artifact_ref: "m#s",
			source_file: "src/m.ts",
			required_companion_files: ["docs/m.md"],
		});
	});

	it("save --json reports saved + entry_count", async () => {
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([]);
		await structureBaselineCommand("save", { json: true });
		expect(JSON.parse(stdout())).toEqual({ saved: true, entry_count: 0 });
	});

	it("save with no scan cache => fatal exitCode 1", async () => {
		readCategoryCache.mockReturnValue(null);
		await structureBaselineCommand("save", {});
		expect(stderr()).toContain("No scan cache. Run `interlinked structure scan` first.");
		expect(process.exitCode).toBe(1);
		expect(writeBaseline).not.toHaveBeenCalled();
	});

	it("save: catalogToNode handles a global_ref with no ':' (kind defaults to module)", async () => {
		readCategoryCache.mockReturnValue(
			catalog([
				{
					local_id: "loose",
					global_ref: "loose",
					file: "src/loose.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
		);
		// Capture the graph passed to the rule evaluator to assert the node kind.
		let seenKind: string | undefined;
		evaluateStructureRules.mockImplementation((graph: FakeGraph) => {
			seenKind = graph.nodes[0]?.kind;
			return [];
		});
		await structureBaselineCommand("save", {});
		expect(seenKind).toBe("module");
	});

	it("clear: removes an existing baseline file", async () => {
		const p = `${CWD}/.interlinked/structure-cache/baseline.json`;
		fsFiles[p] = "{}";
		await structureBaselineCommand("clear", {});
		expect(rmCalls).toContain(p);
		expect(stdout()).toContain("Baseline cleared.");
	});

	it("clear when no baseline exists: reports nothing to clear", async () => {
		await structureBaselineCommand("clear", {});
		expect(rmCalls).toHaveLength(0);
		expect(stdout()).toContain("No baseline to clear.");
	});

	it("clear --json (present) emits cleared:true", async () => {
		fsFiles[`${CWD}/.interlinked/structure-cache/baseline.json`] = "{}";
		await structureBaselineCommand("clear", { json: true });
		expect(JSON.parse(stdout())).toEqual({ cleared: true });
	});

	it("clear --json (absent) emits cleared:false with reason", async () => {
		await structureBaselineCommand("clear", { json: true });
		expect(JSON.parse(stdout())).toEqual({ cleared: false, reason: "no baseline" });
	});

	it("status: empty baseline reports none saved", async () => {
		readBaseline.mockReturnValue({ schema_version: 1, entries: [] });
		await structureBaselineCommand("status", {});
		expect(stdout()).toContain("No baseline saved.");
	});

	it("status: groups entries by finding name", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{ finding_name: "a", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
				{ finding_name: "a", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
				{ finding_name: "b", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
			],
		} as BaselineFile);
		await structureBaselineCommand("status", {});
		const o = stdout();
		expect(o).toContain("Baseline: 3 entries");
		expect(o).toMatch(/a\s+2/);
		expect(o).toMatch(/b\s+1/);
	});

	it("status --json (non-empty) emits by_finding map", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{ finding_name: "x", artifact_ref: "", source_file: "", determinism: "fully_deterministic", required_companion_files: [], context_hash: "" },
			],
		} as BaselineFile);
		await structureBaselineCommand("status", { json: true });
		expect(JSON.parse(stdout())).toEqual({ exists: true, entry_count: 1, by_finding: { x: 1 } });
	});

	it("status --json (empty) emits exists:false", async () => {
		readBaseline.mockReturnValue({ schema_version: 1, entries: [] });
		await structureBaselineCommand("status", { json: true });
		expect(JSON.parse(stdout())).toEqual({ exists: false, entry_count: 0 });
	});

	it("unknown subcommand => fatal exitCode 1", async () => {
		await structureBaselineCommand("frobnicate", {});
		expect(stderr()).toContain('Unknown baseline subcommand "frobnicate"');
		expect(process.exitCode).toBe(1);
	});

	it("catch path (non-fatal): readBaseline throwing sets exitCode 1 with structured error", async () => {
		readBaseline.mockImplementation(() => {
			throw new Error("baseline boom");
		});
		await structureBaselineCommand("status", {});
		expect(stderr()).toContain("structure baseline failed: baseline boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// mutation survivor precision
// ===========================================
// These cases intentionally assert complete command contracts (rather than
// substrings) and use boundary-shaped fixtures.  The command suite above
// covers the branches; these assertions ensure a changed literal/operator
// cannot still produce an apparently valid result.

describe("structure.ts mutation survivors", () => {
	it("init dry-run preserves category separators and its complete human output", async () => {
		await structureInitCommand({ with: "env,docs" });
		expect(stdout()).toBe(
			"Structure init (dry-run)\n\n" +
			"  Mode: standard\n" +
			"  Categories: env, docs\n\n" +
			"Files that would be created:\n" +
			"  create  interlinked/structure.json\n" +
			"  create  interlinked/artifacts/env.json\n" +
			"  create  interlinked/artifacts/docs.json\n\n" +
			"Run with --write to create files.",
		);
	});

	it("init write preserves the artifacts separator and every human output line", async () => {
		await structureInitCommand({ write: true, mode: "strict", with: "env,docs" });
		expect(stdout()).toBe(
			"Structure initialized.\n\n" +
			"  Mode: strict\n" +
			"  Config: interlinked/structure.json\n" +
			"  Artifacts: env, docs\n\n" +
			"Next: run `interlinked structure scan` to build the artifact catalog.",
		);
	});

	it("scan passes exact git metadata options and writes complete node/edge caches", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1015);
		runAllExtractors.mockReturnValue({
			nodes: [
				node({
					id: ":root",
					kind: "module",
					label: "root",
					provenance: "declared",
				}),
			],
			edges: [{ id: "edge-1", provenance: "extracted" }],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});

		expect(execSyncMock).toHaveBeenCalledWith("git rev-parse HEAD", {
			cwd: CWD,
			encoding: "utf-8",
		});
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta).toMatchObject({
			schema_version: 1,
			cli_version: "0.0.0",
			repo_root: CWD,
			last_scanned_commit: "deadbeef",
			manifest_hash: "hash",
		});
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"artifact-nodes",
			{
				schema_version: 1,
				items: [
					{
						local_id: "root",
						global_ref: ":root",
						file: "src/m.ts",
						provenance: "declared",
						determinism_ceiling: "fully_deterministic",
					},
				],
			},
		]);
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"artifact-edges",
			{
				schema_version: 1,
				items: [
					{
						local_id: "edge-1",
						global_ref: "edge-1",
						file: "",
						provenance: "extracted",
						determinism_ceiling: "fully_deterministic",
					},
				],
			},
		]);
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"modules",
			{
				schema_version: 1,
				items: [
					{
						local_id: "root",
						global_ref: ":root",
						file: "src/m.ts",
						provenance: "declared",
						determinism_ceiling: "fully_deterministic",
					},
				],
			},
		]);
		expect(stdout()).toContain("Time:    15ms");
	});

	it("scan distinguishes a colon at index zero and counts declared adoption", async () => {
		runAllExtractors.mockReturnValue({
			nodes: [
				node({ id: "public_symbol:a#one", kind: "public_symbol", provenance: "declared" }),
				node({ id: "public_symbol:a#two", kind: "public_symbol", provenance: "declared" }),
				node({ id: "public_symbol:a#three", kind: "public_symbol", provenance: "extracted" }),
			],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		const nodesWrite = writeCategoryCache.mock.calls.find(
			(call) => (call as unknown[])[1] === "artifact-nodes",
		);
		const payload = (nodesWrite as unknown[])[2] as CategoryCatalog;
		expect(payload.items.map((item) => item.local_id)).toEqual(["a#one", "a#two", "a#three"]);
		const report = (writeAdoptionReport.mock.calls[0] as unknown[])[1] as AdoptionReport;
		expect(report.categories.public_api).toBeCloseTo(2 / 3);
	});

	it("scan human output preserves every summary line and newline separator", async () => {
		runAllExtractors.mockReturnValue({ nodes: [], edges: [] });
		readCatalogMeta.mockReturnValue(null);
		await structureScanCommand({});
		expect(stdout()).toMatch(
			/^Scan complete\.\n\n  Mode:    full scan\n  Config:  minimal\n  Nodes:   0\n  Edges:   0\n  Time:    \d+ms$/,
		);
	});

	it("status renders exact adoption values and separators", async () => {
		loadStructureConfig.mockReturnValue({ config: fullConfig({ mode: "standard" }), errors: [], implicit: false });
		readCatalogMeta.mockReturnValue(meta({ built_at: "2026-02-02T00:00:00.000Z" }));
		isCacheStale.mockReturnValue(false);
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { public_api: 0.9, env: 0.6, docs: 0.1 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({});
		expect(stdout()).toBe(
			"Structure Status\n\n" +
			"  Mode:     standard\n" +
			"  Cache:    fresh\n" +
			"  Built:    2026-02-02T00:00:00.000Z\n\n" +
			"  Adoption:\n" +
			"    public_api   90%\n" +
			"    env          60%\n" +
			"    docs         10%",
		);
	});

	it("accept preserves optional artifact configuration and exact empty skip results", async () => {
		loadStructureConfig.mockReturnValue({
			// `artifacts: {}` — not `undefined` — is the real "no artifacts
			// declared" state: both getImplicitConfig() and
			// resolveStructureConfig() always default this field to an empty
			// object, never leave it absent (StructureConfig.artifacts is a
			// required field honestly, per those two construction paths).
			config: { ...fullConfig(), artifacts: {} },
			errors: [],
			implicit: false,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: name === "env-keys"
					? catalog([
								{
									local_id: "OLD",
									global_ref: "env_key:OLD",
									file: ".env",
									provenance: "extracted",
									determinism_ceiling: "fully_deterministic",
								},
							])
						: null,
		);
		fsFiles[`${CWD}/interlinked/artifacts/env.json`] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "OLD" }],
		});
		await structureAcceptCommand({ json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.accepted).toEqual([{ category: "public_api", count: 1 }]);
		expect(parsed.skipped).toEqual([{ category: "env", item: "OLD", reason: "already declared" }]);
	});

	it("accept human output has no skipped section for a clean accepted batch", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toBe("Structure Accept\n  accepted  public_api: 1 items");
	});

	it("accept reports no zero-count batches when every symbol and key is skipped", async () => {
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: [{ id: "m", symbols: [{ name: "s" }] }],
		});
		fsFiles[`${CWD}/interlinked/artifacts/env.json`] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "OLD" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: name === "env-keys"
					? catalog([
								{
									local_id: "OLD",
									global_ref: "env_key:OLD",
									file: ".env",
									provenance: "extracted",
									determinism_ceiling: "fully_deterministic",
								},
							])
						: null,
		);
		await structureAcceptCommand({ json: true });
		expect(JSON.parse(stdout())).toEqual({
			accepted: [],
			skipped: [
				{ category: "public_api", item: "m#s", reason: "already declared" },
				{ category: "env", item: "OLD", reason: "already declared" },
			],
		});
	});

	it("accept truncates exactly ten skips and does not render the eleventh", async () => {
		const mods = Array.from({ length: 11 }, (_, i) => ({
			id: `m${i}`,
			file: "src/x.ts",
			symbols: [{ name: "s" }],
		}));
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({ version: 1, modules: mods });
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog(
						Array.from({ length: 11 }, (_, i) => ({
							local_id: `m${i}#s`,
							global_ref: `public_symbol:m${i}#s`,
							file: "src/x.ts",
							provenance: "extracted" as const,
							determinism_ceiling: "fully_deterministic" as const,
						})),
					)
				: null,
		);
		await structureAcceptCommand({});
		const lines = stdout().split("\n");
		expect(lines).toHaveLength(14);
		expect(stdout()).toContain("    skip  public_api/m0#s: already declared");
		expect(stdout()).toContain("    skip  public_api/m9#s: already declared");
		expect(stdout()).not.toContain("m10#s");
		expect(stdout()).toContain("    ... and 1 more");
	});

	it("doctor exits on any error even when warnings are also present", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{}";
		validateStructureJson.mockReturnValue({ valid: false, errors: [{ path: ".mode", message: "required" }] });
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({});
		expect(process.exitCode).toBe(1);
		expect(stdout()).toBe(
			"Structure Doctor: 2 issue(s)\n\n" +
			"  ERROR  structure.json .mode: required\n" +
			"  WARN  No scan cache. Run `interlinked structure scan`.",
		);
	});

	it("baseline save passes the loaded config, empty rule context, and exact entry shape", async () => {
		const loadedConfig = fullConfig({ mode: "strict" });
		loadStructureConfig.mockReturnValue({ config: loadedConfig, errors: [], implicit: false });
		getImplicitConfig.mockReturnValue(fullConfig({ mode: "minimal" }));
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([
			{
				name: "rule",
				severity: "warning",
				message: "missing",
				file: "src/m.ts",
				determinism: "fully_deterministic",
				provenance: "extracted",
				artifact_kind: "module",
				artifact_id: "module:m",
				required_updates: [{ file: "docs/m.md", kind: "doc", reason: "document" }],
				confidence: 1,
			},
		]);
		await structureBaselineCommand("save", {});
		expect(readCategoryCache).toHaveBeenCalledWith(CWD, "artifact-nodes");
		expect(evaluateStructureRules).toHaveBeenCalledWith(expect.any(FakeGraph), loadedConfig, [], CWD);
		expect(writeBaseline).toHaveBeenCalledWith(CWD, {
			schema_version: 1,
			entries: [
				{
					finding_name: "rule",
					artifact_ref: "module:m",
					source_file: "src/m.ts",
					determinism: "fully_deterministic",
					required_companion_files: ["docs/m.md"],
					context_hash: "",
				},
			],
		});
	});

	it("baseline catch does not double-report a fatal save error", async () => {
		readCategoryCache.mockReturnValue(null);
		await structureBaselineCommand("save", {});
		expect(stderr()).toBe("Error: No scan cache. Run `interlinked structure scan` first.");
	});

	it("baseline status preserves complete human output and newline separators", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{
					finding_name: "rule-a",
					artifact_ref: "m",
					source_file: "src/m.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
				{
					finding_name: "rule-a",
					artifact_ref: "n",
					source_file: "src/n.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
				{
					finding_name: "rule-b",
					artifact_ref: "o",
					source_file: "src/o.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
			],
		});
		await structureBaselineCommand("status", {});
		expect(stdout()).toBe("Baseline: 3 entries\n\n  rule-a                         2\n  rule-b                         1");
	});
});

// ===========================================
// structure.ts mutation survivors — pass1_w12 residue
// ===========================================
// Targets the 77 survivors reported by
// `npx tsx src/index.ts mutation survivors --file src/commands/structure.ts`
// at generation 1649. Four StringLiteral "" mutants sit behind a call of the
// shape `out(true, data, "")` (or `out(opts.json, data, "")` guarded by
// `if (opts.json) return ...`) — since `out`'s text argument is only read
// when its json argument is falsy, and every one of these call sites passes
// a literal `true` (or an already-true-checked opts.json), the text is
// never evaluated: 373786bfaf027c7a (status), 2db975e6bcadb678 (accept),
// c406789516f06984 (doctor), 17598dd0150b16b2 (blStatus) are therefore
// suspected_equivalent, not tested here. Four more
// (552ed0711b8c2b72/5d57b87da012d77b guarding acceptSymbols,
// b0c969663fcb9426/b1a4a29ba645ec81 guarding acceptEnv) force a
// length>0/>=0 guard true on an empty catalog; acceptSymbols/acceptEnv are
// no-ops on an empty items array (the for-loop never runs, returns
// {accepted:0,skipped:[]}, no writeJson call) so forcing the call through
// produces byte-identical output — also suspected_equivalent. And
// 47ffcfeb668cecb9 forces extractLocalId's `idx>=0` ternary condition true
// unconditionally: idx is always either -1 (String.indexOf "not found") or
// >=0, and `.slice(idx+1)` at idx=-1 is `.slice(0)`, which is the identity
// operation on a string — so the forced-true branch is byte-identical to
// the untouched false branch at the only input where they could diverge.
// This is a mathematical proof over the full input domain, not a search
// gap.
describe("structure.ts mutation survivors — pass1_w12 (residue)", () => {
	// --- relTo ---------------------------------------------------------
	// test-contract: boundary — relTo must strip an exact `${cwd}/` prefix;
	// a cwd that already ends in "/" must not be treated as matching via an
	// accidental doubled slash in the raw template.
	it("relTo does not treat a trailing-slash cwd as a matching prefix", async () => {
		vi.spyOn(process, "cwd").mockReturnValue("/proj/");
		await structureInitCommand({});
		expect(stdout()).toBe(
			"Structure init (dry-run)\n\n" +
				"  Mode: standard\n" +
				"  Categories: (none)\n\n" +
				"Files that would be created:\n" +
				"  create  /proj/interlinked/structure.json\n\n" +
				"Run with --write to create files.",
		);
	});

	// --- structureInitCommand -------------------------------------------
	// test-contract: invariant — dry-run output is the CLI's documented
	// preview: every joined line and the ", " category separator.
	it("init dry-run separates categories, headings, and the trailing hint on every joined line", async () => {
		await structureInitCommand({ with: "config, tests" });
		expect(stdout()).toBe(
			"Structure init (dry-run)\n\n" +
				"  Mode: standard\n" +
				"  Categories: config, tests\n\n" +
				"Files that would be created:\n" +
				"  create  interlinked/structure.json\n" +
				"  create  interlinked/artifacts/config.json\n" +
				"  create  interlinked/artifacts/tests.json\n\n" +
				"Run with --write to create files.",
		);
	});

	// test-contract: invariant — --write output is the CLI's documented
	// confirmation: every joined line and the Artifacts separator.
	it("init write separates artifacts, keeps the config line literal, and joins every line", async () => {
		await structureInitCommand({ write: true, mode: "minimal", with: "config, tests" });
		expect(stdout()).toBe(
			"Structure initialized.\n\n" +
				"  Mode: minimal\n" +
				"  Config: interlinked/structure.json\n" +
				"  Artifacts: config, tests\n\n" +
				"Next: run `interlinked structure scan` to build the artifact catalog.",
		);
	});

	// test-contract: invariant — an unknown category's fatal message must
	// list every available category comma-separated, and the catch handler
	// must not print a second "structure init failed" line once fatal()
	// already reported the error and set exitCode.
	it("init rejects an unknown category with the full available list and no duplicate error line", async () => {
		await structureInitCommand({ with: "bogus" });
		expect(stderr()).toBe(
			'Error: Unknown category "bogus". Available: public_api, env, config, tests, docs, examples, glossary, layers, packages',
		);
		expect(process.exitCode).toBe(1);
	});

	// --- structureScanCommand + extractLocalId + its edges-map callback -
	// test-contract: invariant — the artifact-nodes cache local_id strips
	// exactly the kind-prefix before the first ":" (boundary at index 0, a
	// long multi-segment prefix, and a globalRef with no colon at all), and
	// the per-kind cache / git metadata / adoption fraction are the on-disk
	// contract other commands (accept, baseline) read back.
	it("scan strips local_id at the colon boundary and writes exact meta, exec, and adoption values", async () => {
		runAllExtractors.mockReturnValue({
			nodes: [
				node({ id: ":root", kind: "public_symbol", label: "root", provenance: "declared" }),
				node({
					id: "public_symbol:pkg#sym",
					kind: "public_symbol",
					label: "sym",
					provenance: "declared",
				}),
				node({ id: "nocolonhere", kind: "public_symbol", label: "x", provenance: "extracted" }),
			],
			edges: [],
		});
		readCatalogMeta.mockReturnValue(null);
		execSyncMock.mockReturnValue("cafef00d\n");
		await structureScanCommand({});

		expect(execSyncMock).toHaveBeenCalledWith("git rev-parse HEAD", {
			cwd: CWD,
			encoding: "utf-8",
		});
		const writtenMeta = (writeCatalogMeta.mock.calls[0] as unknown[])[1] as CatalogMeta;
		expect(writtenMeta.cli_version).toBe("0.0.0");
		expect(writtenMeta.last_scanned_commit).toBe("cafef00d");

		const expectedItems = [
			{
				local_id: "root",
				global_ref: ":root",
				file: "src/m.ts",
				provenance: "declared",
				determinism_ceiling: "fully_deterministic",
			},
			{
				local_id: "pkg#sym",
				global_ref: "public_symbol:pkg#sym",
				file: "src/m.ts",
				provenance: "declared",
				determinism_ceiling: "fully_deterministic",
			},
			{
				local_id: "nocolonhere",
				global_ref: "nocolonhere",
				file: "src/m.ts",
				provenance: "extracted",
				determinism_ceiling: "fully_deterministic",
			},
		];
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"artifact-nodes",
			{ schema_version: 1, items: expectedItems },
		]);
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"public-symbols",
			{ schema_version: 1, items: expectedItems },
		]);

		const report = (writeAdoptionReport.mock.calls[0] as unknown[])[1] as AdoptionReport;
		expect(report.categories.public_api).toBeCloseTo(2 / 3);
	});

	// test-contract: invariant — the artifact-edges cache item shape
	// (local_id straight from the edge id, an always-empty file, and the
	// fixed "fully_deterministic" ceiling) is produced by the inline map
	// callback, not derived elsewhere.
	it("scan writes the exact artifact-edges cache shape from the edges-map callback", async () => {
		runAllExtractors.mockReturnValue({
			nodes: [],
			edges: [{ id: "edge-x", provenance: "extracted" }],
		});
		await structureScanCommand({});
		expect(writeCategoryCache.mock.calls).toContainEqual([
			CWD,
			"artifact-edges",
			{
				schema_version: 1,
				items: [
					{
						local_id: "edge-x",
						global_ref: "edge-x",
						file: "",
						provenance: "extracted",
						determinism_ceiling: "fully_deterministic",
					},
				],
			},
		]);
	});

	// test-contract: invariant — the "Scan complete." summary keeps its
	// blank line before "Mode:" and every line joined by a real newline;
	// elapsed_ms is Date.now() MINUS the start mark, not plus.
	it("scan summary keeps the blank separator, newline joins, and a subtracted elapsed time", async () => {
		runAllExtractors.mockReturnValue({ nodes: [], edges: [] });
		readCatalogMeta.mockReturnValue(meta());
		vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(107);
		await structureScanCommand({});
		expect(stdout()).toBe(
			"Scan complete.\n\n" +
				"  Mode:    incremental scan\n" +
				"  Config:  minimal\n" +
				"  Nodes:   0\n" +
				"  Edges:   0\n" +
				"  Time:    7ms",
		);
	});

	// --- structureStatusCommand -----------------------------------------
	// test-contract: invariant — status output preserves every blank-line
	// section separator, the newline join, and score*100 (not score/100)
	// in the rendered percentage.
	it("status keeps every section's blank separator and a multiplied (not divided) percentage", async () => {
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "standard", artifacts: { public_api: "missing.json" } }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta({ built_at: "2026-03-03T00:00:00.000Z" }));
		isCacheStale.mockReturnValue(false);
		readAdoptionReport.mockReturnValue({
			schema_version: 1,
			categories: { public_api: 0.876 },
		} as unknown as AdoptionReport);
		await structureStatusCommand({});
		expect(stdout()).toBe(
			"Structure Status\n\n" +
				"  Mode:     standard\n" +
				"  Cache:    fresh\n" +
				"  Built:    2026-03-03T00:00:00.000Z\n\n" +
				"  Adoption:\n" +
				"    public_api   88%\n\n" +
				"  Invalid manifest references:\n" +
				"    missing  public_api: interlinked/missing.json",
		);
	});

	// --- structureAcceptCommand -------------------------------------------
	// test-contract: invariant — a real (nonzero) accepted count is the
	// only thing that may add an entry to the accepted-batch summary; a
	// batch that accepted nothing for a category must not appear at all.
	it("accept omits a zero-count push for either category when everything is already declared", async () => {
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: [{ id: "p", file: "src/p.ts", symbols: [{ name: "q" }] }],
		});
		fsFiles[`${CWD}/interlinked/artifacts/env.json`] = JSON.stringify({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "TOKEN" }],
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "p#q",
							global_ref: "public_symbol:p#q",
							file: "src/p.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: name === "env-keys"
					? catalog([
							{
								local_id: "TOKEN",
								global_ref: "env_key:TOKEN",
								file: ".env",
								provenance: "extracted",
								determinism_ceiling: "fully_deterministic",
							},
						])
					: null,
		);
		await structureAcceptCommand({ json: true });
		expect(JSON.parse(stdout())).toEqual({
			accepted: [],
			skipped: [
				{ category: "public_api", item: "p#q", reason: "already declared" },
				{ category: "env", item: "TOKEN", reason: "already declared" },
			],
		});
	});

	// test-contract: invariant — config.artifacts may legitimately be an
	// empty object (no structure.json artifacts map declared); reading its
	// public_api/env keys must default safely and never throw.
	it("accept defaults both artifact paths safely when config.artifacts is empty", async () => {
		loadStructureConfig.mockReturnValue({
			// `artifacts: {}` — not `undefined` — is the real "no artifacts
			// declared" state: both getImplicitConfig() and
			// resolveStructureConfig() always default this field to an empty
			// object, never leave it absent (StructureConfig.artifacts is a
			// required field honestly, per those two construction paths).
			config: { ...fullConfig(), artifacts: {} },
			errors: [],
			implicit: false,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog([
						{
							local_id: "m#s",
							global_ref: "public_symbol:m#s",
							file: "src/m.ts",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: name === "env-keys"
					? catalog([
							{
								local_id: "NEW",
								global_ref: "env_key:NEW",
								file: ".env",
								provenance: "extracted",
								determinism_ceiling: "fully_deterministic",
							},
						])
					: null,
		);
		await structureAcceptCommand({ json: true });
		expect(errored).toEqual([]);
		expect(JSON.parse(stdout())).toEqual({
			accepted: [
				{ category: "public_api", count: 1 },
				{ category: "env", count: 1 },
			],
			skipped: [],
		});
	});

	// test-contract: invariant — the "Skipped (already declared):" section
	// must not render at all when nothing was skipped.
	it("accept renders no skipped section when nothing is skipped", async () => {
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "env-keys"
				? catalog([
						{
							local_id: "FRESH",
							global_ref: "env_key:FRESH",
							file: ".env",
							provenance: "extracted",
							determinism_ceiling: "fully_deterministic",
						},
					])
				: null,
		);
		await structureAcceptCommand({});
		expect(stdout()).toBe("Structure Accept\n  accepted  env: 1 items");
	});

	// test-contract: boundary — exactly ten skips must render all ten with
	// NO truncation notice (the notice fires only past ten, not at ten).
	it("accept shows all ten skips with no truncation notice at the exact boundary", async () => {
		const mods = Array.from({ length: 10 }, (_, i) => ({
			id: `m${i}`,
			file: "src/x.ts",
			symbols: [{ name: "s" }],
		}));
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: mods,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog(
						Array.from({ length: 10 }, (_, i) => ({
							local_id: `m${i}#s`,
							global_ref: `public_symbol:m${i}#s`,
							file: "src/x.ts",
							provenance: "extracted" as const,
							determinism_ceiling: "fully_deterministic" as const,
						})),
					)
				: null,
		);
		await structureAcceptCommand({});
		const lines = stdout().split("\n");
		expect(lines).toHaveLength(13);
		expect(stdout()).toContain(
			"Structure Accept\n\n  Skipped (already declared):\n    skip  public_api/m0#s: already declared",
		);
		expect(stdout()).toContain("    skip  public_api/m9#s: already declared");
		expect(stdout()).not.toContain("more");
	});

	// test-contract: boundary — the skip list is sliced at exactly ten even
	// when far more than eleven exist; items past the tenth are summarized,
	// never individually rendered.
	it("accept slices the skip list at exactly ten regardless of how many more exist", async () => {
		const mods = Array.from({ length: 15 }, (_, i) => ({
			id: `k${i}`,
			file: "src/k.ts",
			symbols: [{ name: "z" }],
		}));
		fsFiles[`${CWD}/interlinked/artifacts/public-api.json`] = JSON.stringify({
			version: 1,
			modules: mods,
		});
		readCategoryCache.mockImplementation((_cwd: string, name: string) =>
			name === "public-symbols"
				? catalog(
						Array.from({ length: 15 }, (_, i) => ({
							local_id: `k${i}#z`,
							global_ref: `public_symbol:k${i}#z`,
							file: "src/k.ts",
							provenance: "extracted" as const,
							determinism_ceiling: "fully_deterministic" as const,
						})),
					)
				: null,
		);
		await structureAcceptCommand({});
		const lines = stdout().split("\n");
		expect(lines).toHaveLength(14);
		expect(stdout()).toContain("    skip  public_api/k9#z: already declared");
		expect(stdout()).not.toContain("k10#z");
		expect(stdout()).toContain("... and 5 more");
	});

	// --- structureDoctorCommand -------------------------------------------
	// test-contract: invariant — badge(severity) renders "WARN" only for
	// the literal "warning" severity on the missing-cache issue, and the
	// join separator/blank line are real newlines.
	it("doctor renders WARN for a missing-cache issue with the blank separator and newline joins", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{}";
		validateStructureJson.mockReturnValue({ valid: true, errors: [] });
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "standard" }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(null);
		await structureDoctorCommand({});
		expect(stdout()).toBe(
			"Structure Doctor: 1 issue(s)\n\n  WARN  No scan cache. Run `interlinked structure scan`.",
		);
		expect(process.exitCode).toBeUndefined();
	});

	// test-contract: invariant — badge(severity) renders "WARN" for a
	// stale-cache issue too, and issues.some(error) — not .every(error) —
	// decides exitCode: a mix of one error and one warning must still
	// exit 1.
	it("doctor renders WARN for a stale cache and still exits 1 on a mixed error+warning batch", async () => {
		fsFiles[`${CWD}/interlinked/structure.json`] = "{}";
		validateStructureJson.mockReturnValue({
			valid: false,
			errors: [{ path: ".mode", message: "required" }],
		});
		loadStructureConfig.mockReturnValue({
			config: fullConfig({ mode: "standard" }),
			errors: [],
			implicit: false,
		});
		readCatalogMeta.mockReturnValue(meta());
		isCacheStale.mockReturnValue(true);
		await structureDoctorCommand({});
		expect(process.exitCode).toBe(1);
		expect(stdout()).toBe(
			"Structure Doctor: 2 issue(s)\n\n" +
				"  ERROR  structure.json .mode: required\n" +
				"  WARN  Scan cache is stale. Re-run `interlinked structure scan`.",
		);
	});

	// --- blSave ------------------------------------------------------------
	// test-contract: invariant — loadStructureConfig's own config, when
	// falsy, must fall back to getImplicitConfig(); "artifact-nodes" and an
	// empty rule-context array are the exact arguments passed downstream.
	it("baseline save falls back to the implicit config only when the loaded config is falsy", async () => {
		loadStructureConfig.mockReturnValue({ config: null, errors: [], implicit: true });
		const implicit = fullConfig({ mode: "minimal" });
		getImplicitConfig.mockReturnValue(implicit);
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([]);
		await structureBaselineCommand("save", {});
		expect(readCategoryCache).toHaveBeenCalledWith(CWD, "artifact-nodes");
		expect(evaluateStructureRules).toHaveBeenCalledWith(expect.any(FakeGraph), implicit, [], CWD);
	});

	// test-contract: invariant — a present loaded config must be used
	// directly and never OR'd away by an && swap into the unrelated
	// implicit fallback.
	it("baseline save uses the loaded config directly when present, never the implicit fallback", async () => {
		const loaded = fullConfig({ mode: "strict" });
		loadStructureConfig.mockReturnValue({ config: loaded, errors: [], implicit: false });
		getImplicitConfig.mockReturnValue(fullConfig({ mode: "minimal" }));
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([]);
		await structureBaselineCommand("save", {});
		expect(evaluateStructureRules).toHaveBeenCalledWith(expect.any(FakeGraph), loaded, [], CWD);
	});

	// test-contract: invariant — every baselined finding carries a literal
	// empty context_hash placeholder (hashing is a later phase, not this
	// one).
	it("baseline save always writes an empty context_hash placeholder per finding", async () => {
		loadStructureConfig.mockReturnValue({ config: fullConfig(), errors: [], implicit: false });
		readCategoryCache.mockReturnValue(catalog([]));
		evaluateStructureRules.mockReturnValue([
			{
				name: "rule-x",
				severity: "warning",
				message: "m",
				file: "src/f.ts",
				determinism: "fully_deterministic",
				provenance: "extracted",
				artifact_kind: "module",
				artifact_id: "module:f",
				required_updates: [],
				confidence: 1,
			},
		]);
		await structureBaselineCommand("save", {});
		expect(writeBaseline).toHaveBeenCalledWith(CWD, {
			schema_version: 1,
			entries: [
				{
					finding_name: "rule-x",
					artifact_ref: "module:f",
					source_file: "src/f.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
			],
		});
	});

	// --- blStatus ------------------------------------------------------------
	// test-contract: invariant — grouped baseline counts keep the blank
	// separator and newline join between the header and the rows.
	it("baseline status renders exact grouped counts with a blank separator and newline joins", async () => {
		readBaseline.mockReturnValue({
			schema_version: 1,
			entries: [
				{
					finding_name: "rule-a",
					artifact_ref: "x",
					source_file: "src/x.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
				{
					finding_name: "rule-a",
					artifact_ref: "y",
					source_file: "src/y.ts",
					determinism: "fully_deterministic",
					required_companion_files: [],
					context_hash: "",
				},
			],
		});
		await structureBaselineCommand("status", {});
		expect(stdout()).toBe("Baseline: 2 entries\n\n  rule-a                         2");
	});

	// --- structureBaselineCommand ---------------------------------------
	// test-contract: invariant — the catch guard must swallow a fatal
	// error (exitCode already 1) without appending a second "...failed"
	// line.
	it("baseline catch guard swallows a fatal error without a duplicate message", async () => {
		await structureBaselineCommand("bogus-sub", {});
		expect(stderr()).toBe('Error: Unknown baseline subcommand "bogus-sub". Use: save, clear, status');
	});
});
