// ===========================================
// structure unit tests (behavioral, mock-driven)
// ===========================================
// Every sibling structure module is mocked so the data flowing through
// buildStructureDataImpl is fully controlled. We then assert the *real*
// formatting / counting / exit-code logic in structure.ts against that data.
//
// Branches covered:
//   buildStructureJsonSection: success / exit-2 invalid-config (all 3 conjuncts)
//     / exit-1 deterministic-failure / adoption-gate (?? fallback + below-threshold)
//     / exit-3 catch.
//   runStructureVerify: exit-2 invalid-config (json + text branches) / json output
//     / text output (details present+absent, required_updates loop, all 3 adoption
//     color tiers) / exit-1 deterministic / adoption-gate (json-silent vs text)
//     / exit-3 catch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ArtifactEdge,
	ArtifactNode,
	StructureConfig,
	StructureFinding,
	StructureVerifyOutput,
} from "../../harness/structure/types.js";

// --- mock module-scoped state (hoisted-safe handles) -------------------------
const m = {
	loadResult: undefined as
		| { config: StructureConfig | null; errors: string[]; implicit: boolean }
		| undefined,
	findings: [] as StructureFinding[],
	baseline: { schema_version: 1 as const, entries: [] as never[] },
	isBaselinedFn: vi.fn((_f: StructureFinding) => false),
	adoption: {} as Record<string, number>,
	output: undefined as StructureVerifyOutput | undefined,
	cacheStale: false,
	nodes: [] as ArtifactNode[],
	edges: [] as ArtifactEdge[],
	throwIn: null as null | string, // module name to throw from (for catch coverage)
};

vi.mock("../../harness/structure/adoption.js", () => ({
	calculateAdoption: () => {
		if (m.throwIn === "adoption") throw new Error("adoption boom");
		return m.adoption;
	},
}));

vi.mock("../../harness/structure/artifact-graph.js", () => ({
	ArtifactGraph: class {
		addNode() {}
		addEdge() {}
		toNodesJson() {
			return { schema_version: 1, nodes: m.nodes };
		}
	},
}));

vi.mock("../../harness/structure/baseline.js", () => ({
	isBaselined: (f: StructureFinding) => m.isBaselinedFn(f),
}));

vi.mock("../../harness/structure/cache-manager.js", () => ({
	computeManifestHash: () => "hash",
	isCacheStale: () => m.cacheStale,
	readBaseline: () => m.baseline,
}));

vi.mock("../../harness/structure/extractors/index.js", () => ({
	runAllExtractors: () => ({ nodes: m.nodes, edges: m.edges }),
}));

vi.mock("../../harness/structure/rules/index.js", () => ({
	evaluateStructureRules: () => {
		if (m.throwIn === "rules") throw new Error("rules boom");
		return m.findings;
	},
}));

vi.mock("../../harness/structure/structure-checks.js", () => ({
	layerDeclaredArtifacts: () => {},
}));

vi.mock("../../harness/structure/structure-formatter.js", () => ({
	formatStructureVerifyOutput: () => m.output,
}));

vi.mock("../../harness/structure/structure-loader.js", () => ({
	loadStructureConfig: () => {
		if (m.throwIn === "loader") throw new Error("loader boom");
		return m.loadResult;
	},
	getImplicitConfig: () => makeConfig(),
}));

import { buildStructureJsonSection, runStructureVerify } from "./structure.js";

// --- builders ----------------------------------------------------------------

function makeConfig(over: Partial<StructureConfig> = {}): StructureConfig {
	return {
		version: 1,
		mode: "standard",
		artifacts: {},
		verify: {
			fail_on_deterministic: false,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: {
			emit_deterministic: true,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 10,
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
		...over,
	};
}

function makeFinding(over: Partial<StructureFinding> = {}): StructureFinding {
	return {
		name: "public_symbol_companions",
		severity: "warning",
		message: "missing companion",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		provenance: "extracted",
		artifact_kind: "module",
		artifact_id: "module:foo",
		required_updates: [],
		confidence: 1,
		...over,
	};
}

function makeNode(over: Partial<ArtifactNode> = {}): ArtifactNode {
	return {
		id: "module:foo",
		kind: "module",
		label: "foo",
		file: "src/foo.ts",
		provenance: "extracted",
		determinism_ceiling: "fully_deterministic",
		...over,
	};
}

function makeEdge(over: Partial<ArtifactEdge> = {}): ArtifactEdge {
	return {
		id: "edge:module:foo->module:bar",
		kind: "imports",
		from: "module:foo",
		to: "module:bar",
		provenance: "extracted",
		confidence: 1,
		...over,
	};
}

function makeOutput(over: Partial<StructureVerifyOutput> = {}): StructureVerifyOutput {
	return {
		mode: "standard",
		catalog_fresh: true,
		invalid_files: [],
		adoption: {} as StructureVerifyOutput["adoption"],
		findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
		details: [],
		...over,
	};
}

// adoption maps with arbitrary keys (to exercise color tiers cleanly)
function adoptionMap(rec: Record<string, number>): StructureVerifyOutput["adoption"] {
	return rec as unknown as StructureVerifyOutput["adoption"];
}

// --- capture / reset ---------------------------------------------------------

let stdoutChunks: string[];
let stderrChunks: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;
let origExitCode: number | string | undefined;

beforeEach(() => {
	// default happy state
	m.loadResult = { config: makeConfig(), errors: [], implicit: false };
	m.findings = [];
	m.baseline = { schema_version: 1, entries: [] };
	m.isBaselinedFn = vi.fn(() => false);
	m.adoption = {};
	m.output = makeOutput();
	m.cacheStale = false;
	m.nodes = [];
	m.edges = [];
	m.throwIn = null;

	stdoutChunks = [];
	stderrChunks = [];
	origOut = process.stdout.write;
	origErr = process.stderr.write;
	process.stdout.write = ((c: string) => {
		stdoutChunks.push(c);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((c: string) => {
		stderrChunks.push(c);
		return true;
	}) as typeof process.stderr.write;
	origExitCode = process.exitCode;
	process.exitCode = undefined;
});

afterEach(() => {
	process.stdout.write = origOut;
	process.stderr.write = origErr;
	process.exitCode = origExitCode;
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

// =============================================================================
// buildStructureJsonSection
// =============================================================================

describe("buildStructureJsonSection", () => {
	it("returns the formatted output object on the happy path (no exit code set)", () => {
		m.output = makeOutput({ mode: "minimal" });
		const out = buildStructureJsonSection("/repo", {});
		expect(out).toEqual({ ...makeOutput({ mode: "minimal" }) });
		// spread clone, not the same reference
		expect(out).not.toBe(m.output);
		expect(process.exitCode).toBeUndefined();
	});

	it("filters baselined findings out before counting (isBaselined true drops them)", () => {
		m.findings = [makeFinding(), makeFinding({ name: "other" })];
		m.isBaselinedFn = vi.fn(() => true);
		buildStructureJsonSection("/repo", {});
		// every finding considered, then filtered → none reach deterministic gate
		expect(m.isBaselinedFn).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBeUndefined();
	});

	it("sets exit 2 when loadErrors + non-implicit + fail_on_invalid_structure all hold", () => {
		m.loadResult = {
			config: makeConfig({ verify: { ...makeConfig().verify, fail_on_invalid_structure: true } }),
			errors: ["interlinked/structure.json: bad key"],
			implicit: false,
		};
		const out = buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBe(2);
		expect(out).toEqual({ ...makeOutput() });
	});

	it("does NOT set exit 2 when implicit is true (second conjunct false)", () => {
		m.loadResult = { config: makeConfig(), errors: ["e"], implicit: true };
		buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBeUndefined();
	});

	it("does NOT set exit 2 when fail_on_invalid_structure is false (third conjunct false)", () => {
		m.loadResult = {
			config: makeConfig({ verify: { ...makeConfig().verify, fail_on_invalid_structure: false } }),
			errors: ["e"],
			implicit: false,
		};
		buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBeUndefined();
	});

	it("sets exit 1 on deterministic failures when fail_on_deterministic is true", () => {
		m.loadResult = {
			config: makeConfig({ verify: { ...makeConfig().verify, fail_on_deterministic: true } }),
			errors: [],
			implicit: false,
		};
		m.findings = [makeFinding({ determinism: "fully_deterministic" })];
		buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBe(1);
	});

	it("does NOT set exit 1 when findings exist but fail_on_deterministic is false", () => {
		m.findings = [makeFinding({ determinism: "fully_deterministic" })];
		buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBeUndefined();
	});

	it("does NOT set exit 1 when only non-deterministic findings exist", () => {
		m.loadResult = {
			config: makeConfig({ verify: { ...makeConfig().verify, fail_on_deterministic: true } }),
			errors: [],
			implicit: false,
		};
		m.findings = [makeFinding({ determinism: "heuristic" })];
		buildStructureJsonSection("/repo", {});
		expect(process.exitCode).toBeUndefined();
	});

	it("adoptionGate sets exit 1 when a category is below its threshold", () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.9 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = { docs: 0.5 };
		buildStructureJsonSection("/repo", { adoptionGate: true });
		expect(process.exitCode).toBe(1);
	});

	it("adoptionGate uses ?? 0 fallback for an absent category (below positive threshold)", () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.3 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = {}; // docs missing → 0 < 0.3
		buildStructureJsonSection("/repo", { adoptionGate: true });
		expect(process.exitCode).toBe(1);
	});

	it("adoptionGate does NOT fail when all categories meet thresholds", () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.3 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = { docs: 0.9 };
		buildStructureJsonSection("/repo", { adoptionGate: true });
		expect(process.exitCode).toBeUndefined();
	});

	it("returns the error object and sets exit 3 when building throws", () => {
		m.throwIn = "rules";
		const out = buildStructureJsonSection("/repo", {});
		expect(out).toEqual({ error: "Structure verification failed" });
		expect(process.exitCode).toBe(3);
	});
});

// =============================================================================
// buildStructureData internals (graph build / file collection / implicit config)
// =============================================================================

describe("buildStructureData internals", () => {
	it("feeds extractor nodes+edges into the graph and survives the happy path", () => {
		// drives the `for (... ) graph.addNode/addEdge` loops (L43-44)
		m.nodes = [makeNode(), makeNode({ id: "module:bar", file: "src/bar.ts" })];
		m.edges = [makeEdge()];
		const out = buildStructureJsonSection("/repo", {});
		expect(out).toEqual({ ...makeOutput() });
		expect(process.exitCode).toBeUndefined();
	});

	it("collects + dedupes node file paths, filtering out falsy entries (filter(Boolean))", () => {
		// toNodesJson().nodes drives .map(n => n.file).filter(Boolean) (L52-55):
		//   - two nodes share src/foo.ts (Set dedupe)
		//   - one node has an empty file string (filtered out by Boolean)
		m.nodes = [
			makeNode({ file: "src/foo.ts" }),
			makeNode({ id: "module:dup", file: "src/foo.ts" }),
			makeNode({ id: "module:empty", file: "" }),
		];
		const out = buildStructureJsonSection("/repo", {});
		expect(out).toEqual({ ...makeOutput() });
		expect(process.exitCode).toBeUndefined();
	});

	it("falls back to getImplicitConfig when loaded config is null (?? branch)", () => {
		// config null + implicit true → resolvedConfig = getImplicitConfig() (L46 RHS)
		m.loadResult = { config: null, errors: [], implicit: true };
		const out = buildStructureJsonSection("/repo", {});
		expect(out).toEqual({ ...makeOutput() });
		expect(process.exitCode).toBeUndefined();
	});
});

// =============================================================================
// runStructureVerify
// =============================================================================

describe("runStructureVerify — invalid-config (exit 2)", () => {
	beforeEach(() => {
		m.loadResult = {
			config: makeConfig({ mode: "strict" }),
			errors: ["interlinked/structure.json: bad", "second error"],
			implicit: false,
		};
		m.output = makeOutput({ mode: "strict", invalid_files: ["interlinked/structure.json: bad"] });
	});

	it("writes JSON invalid-config payload to stdout and exits 2", async () => {
		await runStructureVerify("/repo", { json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.structure.mode).toBe("strict");
		expect(parsed.structure.error).toBe("Invalid structure configuration");
		// invalid_files is the spread of loadErrors (buildStructureData.invalidFiles), not m.output
		expect(parsed.structure.invalid_files).toEqual([
			"interlinked/structure.json: bad",
			"second error",
		]);
		expect(process.exitCode).toBe(2);
		expect(stderr()).toBe("");
	});

	it("writes each loadError to stderr in text mode and exits 2", async () => {
		await runStructureVerify("/repo", {});
		const err = stderr();
		expect(err).toContain("Invalid structure configuration");
		expect(err).toContain("interlinked/structure.json: bad");
		expect(err).toContain("second error");
		expect(process.exitCode).toBe(2);
		expect(stdout()).toBe("");
	});
});

describe("runStructureVerify — JSON output", () => {
	it("writes the {structure: output} payload to stdout", async () => {
		m.output = makeOutput({
			mode: "standard",
			findings: { fully_deterministic: 2, partially_deterministic: 1, heuristic: 3 },
		});
		await runStructureVerify("/repo", { json: true });
		const parsed = JSON.parse(stdout());
		expect(parsed.structure.mode).toBe("standard");
		expect(parsed.structure.findings).toEqual({
			fully_deterministic: 2,
			partially_deterministic: 1,
			heuristic: 3,
		});
	});
});

describe("runStructureVerify — text output", () => {
	it("renders mode, finding counts, and adoption with no details", async () => {
		m.output = makeOutput({
			mode: "standard",
			findings: { fully_deterministic: 1, partially_deterministic: 2, heuristic: 3 },
			details: [],
			adoption: adoptionMap({ docs: 0.5 }),
		});
		m.adoption = { docs: 0.5 };
		await runStructureVerify("/repo", {});
		const err = stderr();
		expect(err).toContain("interlinked verify --structure");
		expect(err).toContain("mode: standard");
		expect(err).toContain("findings: 1 deterministic, 2 partial, 3 heuristic");
		expect(err).toContain("adoption:");
		// no detail lines emitted
		expect(err).not.toContain("artifact:");
	});

	it("renders detail blocks including the required_updates loop", async () => {
		m.output = makeOutput({
			details: [
				{
					name: "public_symbol_companions",
					determinism: "fully_deterministic",
					provenance: "extracted",
					file: "src/foo.ts",
					artifact_id: "module:foo",
					required_updates: [
						{ file: "src/foo.test.ts", kind: "test", reason: "r" },
						{ file: "docs/foo.md", kind: "docs", reason: "r" },
					],
				},
			],
		});
		await runStructureVerify("/repo", {});
		const err = stderr();
		expect(err).toContain("public_symbol_companions");
		expect(err).toContain("src/foo.ts");
		expect(err).toContain("artifact: module:foo (fully_deterministic)");
		expect(err).toContain("→ src/foo.test.ts (test)");
		expect(err).toContain("→ docs/foo.md (docs)");
	});

	it("colors adoption green for strong (>=0.8), yellow for acceptable (>=0.5), red below", async () => {
		m.output = makeOutput({
			adoption: adoptionMap({ strong: 0.85, mid: 0.6, weak: 0.2 }),
		});
		await runStructureVerify("/repo", {});
		const err = stderr();
		expect(err).toContain("strong: \x1b[32m85%\x1b[0m"); // green
		expect(err).toContain("mid: \x1b[33m60%\x1b[0m"); // yellow
		expect(err).toContain("weak: \x1b[31m20%\x1b[0m"); // red
	});

	it("colors a boundary value of exactly 0.8 green and exactly 0.5 yellow", async () => {
		m.output = makeOutput({
			adoption: adoptionMap({ eighty: 0.8, fifty: 0.5 }),
		});
		await runStructureVerify("/repo", {});
		const err = stderr();
		expect(err).toContain("eighty: \x1b[32m80%\x1b[0m");
		expect(err).toContain("fifty: \x1b[33m50%\x1b[0m");
	});
});

describe("runStructureVerify — deterministic exit (exit 1)", () => {
	it("sets exit 1 when deterministic findings exist and fail_on_deterministic is true", async () => {
		m.loadResult = {
			config: makeConfig({ verify: { ...makeConfig().verify, fail_on_deterministic: true } }),
			errors: [],
			implicit: false,
		};
		m.findings = [makeFinding({ determinism: "fully_deterministic" })];
		await runStructureVerify("/repo", {});
		expect(process.exitCode).toBe(1);
	});

	it("does not set exit 1 when fail_on_deterministic is false", async () => {
		m.findings = [makeFinding({ determinism: "fully_deterministic" })];
		await runStructureVerify("/repo", {});
		expect(process.exitCode).toBeUndefined();
	});
});

describe("runStructureVerify — adoption gate", () => {
	it("text mode writes the adoption-gate failure line and exits 1", async () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.9 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = { docs: 0.4 };
		await runStructureVerify("/repo", { adoptionGate: true });
		const err = stderr();
		expect(err).toContain("adoption gate failed:");
		expect(err).toContain("docs at 40% (threshold: 90%)");
		expect(process.exitCode).toBe(1);
	});

	it("json mode exits 1 on gate failure but writes NO stderr gate line", async () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.9 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = { docs: 0.4 };
		await runStructureVerify("/repo", { json: true, adoptionGate: true });
		expect(process.exitCode).toBe(1);
		expect(stderr()).not.toContain("adoption gate failed:");
	});

	it("uses ?? 0 fallback for an absent adoption category", async () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.3 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = {}; // docs missing → 0 < 0.3
		await runStructureVerify("/repo", { adoptionGate: true });
		expect(stderr()).toContain("docs at 0% (threshold: 30%)");
		expect(process.exitCode).toBe(1);
	});

	it("does not fail the gate when the category meets the threshold", async () => {
		m.loadResult = {
			config: makeConfig({
				adoption: {
					coverage_thresholds: { ...makeConfig().adoption.coverage_thresholds, docs: 0.3 },
				},
			}),
			errors: [],
			implicit: false,
		};
		m.adoption = { docs: 0.9 };
		await runStructureVerify("/repo", { adoptionGate: true });
		expect(stderr()).not.toContain("adoption gate failed:");
		expect(process.exitCode).toBeUndefined();
	});
});

describe("runStructureVerify — catch (exit 3)", () => {
	it("writes the failure message to stderr and exits 3 when building throws", async () => {
		m.throwIn = "rules";
		await runStructureVerify("/repo", {});
		expect(stderr()).toContain("Structure verification failed:");
		expect(stderr()).toContain("rules boom");
		expect(process.exitCode).toBe(3);
	});

	it("surfaces a loader throw through the same catch path", async () => {
		m.throwIn = "loader";
		await runStructureVerify("/repo", { json: true });
		expect(stderr()).toContain("loader boom");
		expect(process.exitCode).toBe(3);
	});
});
