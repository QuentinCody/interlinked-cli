// ===========================================
// structure-helpers — direct unit coverage (mutation hardening)
// ===========================================
// structure.integration.test.ts already exercises these helpers indirectly
// through the six structure* command handlers in ./structure.ts. This file
// adds DIRECT unit tests against structure-helpers.ts itself: exact call
// arguments on a mocked node:fs (encoding strings, mkdir options), boundary
// values (hashIdx===0, pct===80/50), and full-shape equality checks on the
// exported catalog constants — precision the looser command-level
// assertions don't pin down.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CatalogItem,
	CategoryCatalog,
	EnvFile,
	PublicApiFile,
	StructureConfig,
} from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";

// ---- node:fs mock: virtual filesystem, call-arg-inspectable -----------
let fsFiles: Record<string, string>;
let mkdirCalls: Array<{ path: string; opts: unknown }>;
let writeCalls: Array<{ path: string; data: string; encoding: unknown }>;
let readCalls: Array<{ path: string; encoding: unknown }>;

vi.mock("node:fs", () => ({
	existsSync: (p: string) => p in fsFiles,
	readFileSync: (p: string, enc?: unknown) => {
		readCalls.push({ path: p, encoding: enc });
		if (!(p in fsFiles)) throw new Error(`ENOENT: ${p}`);
		return fsFiles[p];
	},
	writeFileSync: (p: string, data: string, enc?: unknown) => {
		fsFiles[p] = data;
		writeCalls.push({ path: p, data, encoding: enc });
	},
	mkdirSync: (p: string, opts?: unknown) => {
		mkdirCalls.push({ path: p, opts });
	},
}));

import {
	acceptEnv,
	acceptSymbols,
	catalogToNode,
	doctorCheckFiles,
	doctorCheckPaths,
	doctorValidateConfig,
	KEY_TO_KIND,
	KIND_TO_CAT,
	pctColor,
	readJson,
	SCAFFOLDS,
	writeJson,
} from "./structure-helpers.js";

beforeEach(() => {
	fsFiles = {};
	mkdirCalls = [];
	writeCalls = [];
	readCalls = [];
});

afterEach(() => {
	vi.restoreAllMocks();
});

function catalog(items: CategoryCatalog["items"]): CategoryCatalog {
	return { schema_version: 1, items };
}

// Matches doctorCheckFiles / doctorCheckPaths's `load` parameter exactly, so
// a loader literal assigned to this type gets contextual typing for its
// `data`/`errors` fields instead of needing per-field `as` casts.
type Loader = (
	cwd: string,
	key: string,
	rel: string,
) => { data: JsonObject | null; errors: string[] };

function writtenJson<T>(path: string): T {
	const call = writeCalls.find((w) => w.path === path);
	if (!call) throw new Error(`no write recorded for ${path}`);
	// SAFETY: the caller names the artifact-file type it just had writeJson
	// serialize (PublicApiFile / EnvFile); we are reading back our own fixture.
	return JSON.parse(call.data) as T;
}

function baseConfig(artifacts: StructureConfig["artifacts"]): StructureConfig {
	return {
		version: 1,
		mode: "standard",
		artifacts,
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
			public_symbol_test_case: true,
			env_key_companions: true,
			config_key_companions: true,
			layer_boundary_violations: true,
			glossary_residue: true,
			package_boundary_violations: true,
		},
	};
}

// ===========================================
// catalog constants
// ===========================================

describe("catalog constants", () => {
	it("KEY_TO_KIND maps every artifact category key to its ArtifactKind", () => {
		expect(KEY_TO_KIND).toEqual({
			public_api: "public_symbol",
			env: "env_key",
			config: "config_key",
			tests: "test",
			docs: "doc",
			examples: "example",
			glossary: "term",
			layers: "layer",
			packages: "package",
		});
	});

	it("KIND_TO_CAT maps every ArtifactKind to its plural artifact directory name", () => {
		expect(KIND_TO_CAT).toEqual({
			module: "modules",
			public_symbol: "public-symbols",
			package: "packages",
			env_key: "env-keys",
			config_key: "config-keys",
			test: "tests",
			doc: "docs",
			example: "examples",
			term: "glossary",
			layer: "layers",
		});
	});

	it("SCAFFOLDS declares the exact starter file path + content for every category", () => {
		expect(SCAFFOLDS).toEqual({
			public_api: { file: "artifacts/public-api.json", content: { version: 1, modules: [] } },
			env: {
				file: "artifacts/env.json",
				content: { version: 1, sources: { declarations: [], defaults: [] }, keys: [] },
			},
			config: { file: "artifacts/config.json", content: { version: 1, roots: [], keys: [] } },
			tests: { file: "artifacts/tests.json", content: { version: 1, tests: [] } },
			docs: { file: "artifacts/docs.json", content: { version: 1, docs: [] } },
			examples: { file: "artifacts/examples.json", content: { version: 1, examples: [] } },
			glossary: { file: "artifacts/glossary.json", content: { version: 1, terms: [] } },
			layers: { file: "artifacts/layers.json", content: { version: 1, layers: [], rules: [] } },
			packages: { file: "artifacts/packages.json", content: { version: 1, packages: [] } },
		});
	});
});

// ===========================================
// readJson / writeJson
// ===========================================

describe("readJson", () => {
	it("returns the fallback WITHOUT reading the file when it does not exist", () => {
		const fallback = { seen: false };
		const result = readJson("/proj/nope.json", fallback);
		expect(result).toBe(fallback);
		expect(readCalls).toEqual([]);
	});

	it("parses the file's content when it exists", () => {
		fsFiles["/proj/exists.json"] = JSON.stringify({ seen: true });
		const result = readJson("/proj/exists.json", { seen: false });
		expect(result).toEqual({ seen: true });
	});
});

describe("writeJson", () => {
	it("creates the parent directory recursively and writes UTF-8 JSON with a trailing newline", () => {
		const path = "/proj/interlinked/artifacts/thing.json";
		writeJson(path, { a: 1 });
		expect(mkdirCalls).toEqual([{ path: "/proj/interlinked/artifacts", opts: { recursive: true } }]);
		expect(writeCalls).toEqual([
			{ path, data: `${JSON.stringify({ a: 1 }, null, 2)}\n`, encoding: "utf-8" },
		]);
	});
});

// ===========================================
// pctColor
// ===========================================

describe("pctColor", () => {
	it("is green at and above the 80 boundary, yellow just below it", () => {
		expect(pctColor(100)).toBe(c.green);
		expect(pctColor(80)).toBe(c.green);
		expect(pctColor(79)).toBe(c.yellow);
	});

	it("is yellow at and above the 50 boundary, red just below it", () => {
		expect(pctColor(50)).toBe(c.yellow);
		expect(pctColor(49)).toBe(c.red);
		expect(pctColor(0)).toBe(c.red);
	});
});

// ===========================================
// catalogToNode
// ===========================================

describe("catalogToNode", () => {
	it("splits kind from the local id at the first colon in global_ref", () => {
		const item: CatalogItem = {
			local_id: "createClient",
			global_ref: "public_symbol:pkg-index#createClient",
			file: "src/index.ts",
			provenance: "extracted",
			determinism_ceiling: "fully_deterministic",
		};
		const node = catalogToNode(item);
		expect(node.kind).toBe("public_symbol");
		expect(node.id).toBe("public_symbol:pkg-index#createClient");
		expect(node.label).toBe("createClient");
	});

	it("defaults kind to 'module' when global_ref has no colon", () => {
		const item: CatalogItem = {
			local_id: "loose",
			global_ref: "loose",
			file: "src/loose.ts",
			provenance: "extracted",
			determinism_ceiling: "fully_deterministic",
		};
		expect(catalogToNode(item).kind).toBe("module");
	});
});

// ===========================================
// acceptSymbols
// ===========================================

describe("acceptSymbols", () => {
	const path = "/proj/interlinked/artifacts/public-api.json";

	it("splits module id / symbol name at '#', including the hashIdx===0 boundary", () => {
		const result = acceptSymbols(
			catalog([
				{
					local_id: "#onlySymbol",
					global_ref: "public_symbol:#onlySymbol",
					file: "src/x.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
			path,
		);
		expect(result.accepted).toBe(1);
		const written = writtenJson<PublicApiFile>(path);
		expect(written.modules[0]?.id).toBe("");
		expect(written.modules[0]?.symbols[0]?.name).toBe("onlySymbol");
	});

	it("writes the full symbol shape: kind, stability, and empty docs/tests/examples", () => {
		acceptSymbols(
			catalog([
				{
					local_id: "pkg#sym",
					global_ref: "public_symbol:pkg#sym",
					file: "src/pkg.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
			path,
		);
		const written = writtenJson<PublicApiFile>(path);
		expect(written.modules[0]?.symbols[0]).toEqual({
			name: "sym",
			kind: "function",
			stability: "public",
			docs: [],
			tests: [],
			examples: [],
		});
	});

	it("finds the existing module by id (not just the first module) before creating a new one", () => {
		fsFiles[path] = JSON.stringify({
			version: 1,
			modules: [{ id: "moduleA", file: "src/a.ts", symbols: [] }],
		});
		acceptSymbols(
			catalog([
				{
					local_id: "moduleB#newSym",
					global_ref: "public_symbol:moduleB#newSym",
					file: "src/b.ts",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
			path,
		);
		const written = writtenJson<PublicApiFile>(path);
		expect(written.modules).toHaveLength(2);
		const moduleA = written.modules.find((m) => m.id === "moduleA");
		const moduleB = written.modules.find((m) => m.id === "moduleB");
		expect(moduleA?.symbols).toHaveLength(0);
		expect(moduleB?.symbols).toHaveLength(1);
	});
});

// ===========================================
// acceptEnv
// ===========================================

describe("acceptEnv", () => {
	const path = "/proj/interlinked/artifacts/env.json";

	it("on a fresh file: writes the exact default shape and returns an empty skipped list", () => {
		const result = acceptEnv(
			catalog([
				{
					local_id: "NEW_KEY",
					global_ref: "env_key:NEW_KEY",
					file: ".env",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
			path,
		);
		expect(result).toEqual({ accepted: 1, skipped: [] });
		expect(writtenJson(path)).toEqual({
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [
				{
					name: "NEW_KEY",
					required: false,
					docs: [],
					tests: [],
					examples: [],
					default_sources: [],
				},
			],
		});
	});

	it("dedups an already-declared key: reports the skip, leaves the file unwritten", () => {
		const existing: EnvFile = {
			version: 1,
			sources: { declarations: [], defaults: [] },
			keys: [{ name: "OLD", required: false, docs: [], tests: [], examples: [], default_sources: [] }],
		};
		fsFiles[path] = JSON.stringify(existing);
		const result = acceptEnv(
			catalog([
				{
					local_id: "OLD",
					global_ref: "env_key:OLD",
					file: ".env",
					provenance: "extracted",
					determinism_ceiling: "fully_deterministic",
				},
			]),
			path,
		);
		expect(result).toEqual({
			accepted: 0,
			skipped: [{ category: "env", item: "OLD", reason: "already declared" }],
		});
		expect(writeCalls.some((w) => w.path === path)).toBe(false);
	});
});

// ===========================================
// doctorValidateConfig
// ===========================================

describe("doctorValidateConfig", () => {
	const path = "/proj/interlinked/structure.json";
	const okValidate = () => ({ valid: true, errors: [] });

	it("reports an 'info' issue (not a blank severity) when structure.json is absent", () => {
		const result = doctorValidateConfig(path, okValidate);
		expect(result).toEqual([
			{ severity: "info", message: "No interlinked/structure.json found (implicit minimal mode)" },
		]);
	});

	it("reads an existing file with utf-8 encoding", () => {
		fsFiles[path] = JSON.stringify({ version: 1, mode: "standard" });
		doctorValidateConfig(path, okValidate);
		expect(readCalls).toContainEqual({ path, encoding: "utf-8" });
	});
});

// ===========================================
// doctorCheckFiles
// ===========================================

describe("doctorCheckFiles", () => {
	it("tags both a missing artifact file and a load error as severity 'error'", () => {
		fsFiles["/proj/interlinked/artifacts/docs.json"] = "{}"; // docs present; env missing
		const config = baseConfig({ env: "artifacts/env.json", docs: "artifacts/docs.json" });
		const load = (_cwd: string, key: string) =>
			key === "docs" ? { data: null, errors: ["schema mismatch"] } : { data: null, errors: [] };
		const issues = doctorCheckFiles(config, "/proj", load);
		expect(issues).toEqual([
			{ severity: "error", message: "Artifact file missing: interlinked/artifacts/env.json" },
			{ severity: "error", message: "docs (artifacts/docs.json): schema mismatch" },
		]);
	});
});

// ===========================================
// doctorCheckPaths (covers the private extractPathsFromData helper)
// ===========================================

describe("doctorCheckPaths", () => {
	it("scans the modules/tests/examples/packages columns for declared paths ('docs' already covered elsewhere)", () => {
		const config = baseConfig({ public_api: "artifacts/combo.json" });
		const load: Loader = () => ({
			data: {
				modules: [{ file: "src/mod-missing.ts" }],
				tests: [{ file: "test/test-missing.ts" }],
				examples: [{ file: "examples/ex-missing.ts" }],
				packages: [{ file: "packages/pkg-missing" }],
			},
			errors: [],
		});
		const issues = doctorCheckPaths(config, "/proj", load);
		expect(issues).toEqual([
			{ severity: "warning", message: "public_api: declared path not found: src/mod-missing.ts" },
			{ severity: "warning", message: "public_api: declared path not found: test/test-missing.ts" },
			{ severity: "warning", message: "public_api: declared path not found: examples/ex-missing.ts" },
			{ severity: "warning", message: "public_api: declared path not found: packages/pkg-missing" },
		]);
	});

	it("skips a non-object (undefined) array entry instead of throwing on property access", () => {
		fsFiles["/proj/src/present.ts"] = "ok"; // exists -> the valid entry produces no warning
		const config = baseConfig({ config: "artifacts/config.json" });
		const load: Loader = () => ({
			data: { modules: [undefined, { file: "src/present.ts" }] },
			errors: [],
		});
		let issues: unknown[] = [];
		expect(() => {
			issues = doctorCheckPaths(config, "/proj", load);
		}).not.toThrow();
		expect(issues).toEqual([]);
	});
});
