import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStructureConfig } from "../../harness/structure/schema-validator.js";
import type { ArtifactFileKey, Determinism, StructureConfig, StructureFinding } from "../../harness/structure/types.js";

const nodesJsonHolder = vi.hoisted((): { value: { nodes: Array<{ file: string | null }> } } => ({ value: { nodes: [] } }));

// ---------------------------------------------------------------------------
// Mocks for every dependency of src/commands/verify/structure.ts. Each test
// configures return values, then calls the real exported functions and
// inspects either the mocked formatStructureVerifyOutput call args, the
// mocked evaluateStructureRules call args, process.exitCode, or captured
// process.stderr writes.
// ---------------------------------------------------------------------------

vi.mock("../../harness/structure/adoption.js", () => ({
	calculateAdoption: vi.fn(),
}));

vi.mock("../../harness/structure/artifact-graph.js", () => {
	class MockArtifactGraph {
		addNode() {}
		addEdge() {}
		toNodesJson() {
			return nodesJsonHolder.value;
		}
	}
	return { ArtifactGraph: MockArtifactGraph };
});

vi.mock("../../harness/structure/baseline.js", () => ({
	isBaselined: vi.fn(() => false),
}));

vi.mock("../../harness/structure/cache-manager.js", () => ({
	computeManifestHash: vi.fn(() => "hash"),
	isCacheStale: vi.fn(() => false),
	readBaseline: vi.fn(() => ({})),
}));

vi.mock("../../harness/structure/extractors/index.js", () => ({
	runAllExtractors: vi.fn(() => ({ nodes: [], edges: [], truncated: false })),
}));

vi.mock("../../harness/structure/rules/index.js", () => ({
	evaluateStructureRules: vi.fn(() => []),
}));

vi.mock("../../harness/structure/structure-checks.js", () => ({
	layerDeclaredArtifacts: vi.fn(),
}));

vi.mock("../../harness/structure/structure-formatter.js", () => ({
	formatStructureVerifyOutput: vi.fn(() => ({
		mode: "standard",
 catalog_fresh: true,
 invalid_files: [],
		findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
		details: [],
		adoption: adoption(),
	})),
}));

vi.mock("../../harness/structure/structure-loader.js", () => ({
	getImplicitConfig: vi.fn(() => ({})),
	loadStructureConfig: vi.fn(),
}));

import { isCacheStale } from "../../harness/structure/cache-manager.js";
import { runAllExtractors } from "../../harness/structure/extractors/index.js";
import { evaluateStructureRules } from "../../harness/structure/rules/index.js";
import { formatStructureVerifyOutput } from "../../harness/structure/structure-formatter.js";
import { loadStructureConfig } from "../../harness/structure/structure-loader.js";
import { calculateAdoption } from "../../harness/structure/adoption.js";
import { buildStructureJsonSection, runStructureVerify } from "./structure.js";

function adoption(overrides: Partial<Record<ArtifactFileKey, number>> = {}): Record<ArtifactFileKey, number> {
 return { public_api: 0, env: 0, config: 0, tests: 0, docs: 0, examples: 0, glossary: 0, layers: 0, packages: 0, ...overrides };
}

function finding(determinism: Determinism): StructureFinding {
 return { name: "test-finding", severity: "warning", message: "Companion update required", file: "src/a.ts", determinism, provenance: "declared", artifact_kind: "module", artifact_id: "a", required_updates: [], confidence: 1 };
}

function baseConfig(overrides: { verify?: Partial<StructureConfig["verify"]>; adoption?: { coverage_thresholds: Partial<Record<ArtifactFileKey, number>> } } = {}): StructureConfig {
 const base = resolveStructureConfig({ version: 1, mode: "standard" });
 return { ...base, verify: { ...base.verify, fail_on_invalid_structure: false, fail_on_deterministic: false, ...overrides.verify }, adoption: { coverage_thresholds: adoption(overrides.adoption?.coverage_thresholds) } };
}

function setLoadStructureConfig(opts: {
	config?: StructureConfig | null;
	errors?: string[];
	implicit?: boolean;
}) {
	(vi.mocked(loadStructureConfig)).mockReturnValue({
		config: opts.config ?? baseConfig(),
		errors: opts.errors ?? [],
		implicit: opts.implicit ?? false,
	});
}

describe("buildStructureJsonSection / runStructureVerify — mutation kill (w62)", () => {
	let stderrWrites: string[];
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.exitCode = undefined;
		nodesJsonHolder.value = { nodes: [] };
		stderrWrites = [];
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		});
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		(vi.mocked(evaluateStructureRules)).mockReset().mockReturnValue([]);
		(vi.mocked(formatStructureVerifyOutput)).mockReset().mockReturnValue({
			mode: "standard",
 catalog_fresh: true,
 invalid_files: [],
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [],
			adoption: adoption(),
		});
		(vi.mocked(calculateAdoption)).mockReset().mockReturnValue(adoption());
		(vi.mocked(isCacheStale)).mockReset().mockReturnValue(false);
		(vi.mocked(runAllExtractors)).mockReset().mockReturnValue({ nodes: [], edges: [], truncated: false });
		setLoadStructureConfig({});
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		stdoutSpy.mockRestore();
		process.exitCode = undefined;
	});

	// -- kills 591d56af80dcd164, 1eaba6433b2bcb23, 58089bd57f69d361 --------
	it("invalidFiles stays empty when config is implicit, even with load errors", () => {
		setLoadStructureConfig({ config: baseConfig(), errors: ["boom"], implicit: true });

		buildStructureJsonSection("/fake/cwd", {});

		const calls = (vi.mocked(formatStructureVerifyOutput)).mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0]![0];
		expect(call.invalidFiles).toEqual([]);
	});

	// -- kills 29bf141d049efbb3, 30e669df90a04a24, a9d426628e30bade -------
	it("allFiles is the deduped, filtered, mapped set of node.file values", () => {
		nodesJsonHolder.value = {
			nodes: [{ file: "a.ts" }, { file: null }, { file: "b.ts" }, { file: "a.ts" }],
		};

		buildStructureJsonSection("/fake/cwd", {});

		const calls = (vi.mocked(evaluateStructureRules)).mock.calls;
		expect(calls.length).toBe(1);
		const allFilesArg = calls[0]![2];
		expect(allFilesArg).toEqual(["a.ts", "b.ts"]);
	});

	// -- kills a272c65a01ad0339, 0c593fa34fbd8db9 --------------------------
	it("passes the full structured object (not {}) to the formatter, with catalogFresh derived from isCacheStale", () => {
		(vi.mocked(isCacheStale)).mockReturnValue(true);
		const config = baseConfig();
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(evaluateStructureRules)).mockReturnValue([]);

		buildStructureJsonSection("/fake/cwd", {});

		const calls2 = (vi.mocked(formatStructureVerifyOutput)).mock.calls;
		expect(calls2.length).toBe(1);
		const call = calls2[0]![0];
		expect(call).toHaveProperty("config");
		expect(call).toHaveProperty("findings");
		expect(call).toHaveProperty("invalidFiles");
		expect(call).toHaveProperty("adoption");
		expect(call.catalogFresh).toBe(false);
	});

	// -- kills 17155f71494538ac ---------------------------------------------
	it("buildStructureJsonSection does not apply the adoption gate when opts.adoptionGate is false", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(calculateAdoption)).mockReturnValue(adoption({ docs: 0.1 }));

		buildStructureJsonSection("/fake/cwd", { adoptionGate: false });

		expect(process.exitCode).toBeUndefined();
	});

	// -- kills a3f48f1d5eb705e (buildStructureJsonSection context) --------
	it("buildStructureJsonSection only counts fully_deterministic findings toward the exit code", () => {
		const config = baseConfig({
			verify: { fail_on_invalid_structure: false, fail_on_deterministic: true },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(evaluateStructureRules)).mockReturnValue([finding("heuristic")]);

		buildStructureJsonSection("/fake/cwd", {});

		expect(process.exitCode).toBeUndefined();
	});

	// -- kills baff382878f68ba2, 4e5347edd62aa14b, 7203a7415aea5f06/3bea2719c060ae2b --
	it("text report omits the blank separator line when there are no details", () => {
		(vi.mocked(formatStructureVerifyOutput)).mockReturnValue({
			mode: "standard",
 catalog_fresh: true,
 invalid_files: [],
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [],
			adoption: adoption({ docs: 0.5 }),
		});

		return runStructureVerify("/fake/cwd", { json: false }).then(() => {
			const full = stderrWrites.join("");
			const expected =
				"\n  \x1b[1minterlinked verify --structure\x1b[0m\n" +
				"  mode: standard\n" +
				"  findings: 0 deterministic, 0 partial, 0 heuristic\n" +
				"\n  \x1b[1madoption:\x1b[0m\n" +
				"    public_api: \x1b[31m0%\x1b[0m\n" +
				"    env: \x1b[31m0%\x1b[0m\n" +
				"    config: \x1b[31m0%\x1b[0m\n" +
				"    tests: \x1b[31m0%\x1b[0m\n" +
				"    docs: \x1b[33m50%\x1b[0m\n" +
				"    examples: \x1b[31m0%\x1b[0m\n" +
				"    glossary: \x1b[31m0%\x1b[0m\n" +
				"    layers: \x1b[31m0%\x1b[0m\n" +
				"    packages: \x1b[31m0%\x1b[0m\n" +
				"\n";
			expect(full).toBe(expected);
		});
	});

	it("text report includes the blank separator line and each detail when details is non-empty", () => {
		(vi.mocked(formatStructureVerifyOutput)).mockReturnValue({
			mode: "standard",
 catalog_fresh: true,
 invalid_files: [],
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 0 },
			details: [
				{
					name: "x",
					file: "f.ts",
					artifact_id: "a1",
					determinism: "heuristic",
					provenance: "declared",
					required_updates: [],
				},
			],
			adoption: adoption({ docs: 0.5 }),
		});

		return runStructureVerify("/fake/cwd", { json: false }).then(() => {
			const full = stderrWrites.join("");
			const expected =
				"\n  \x1b[1minterlinked verify --structure\x1b[0m\n" +
				"  mode: standard\n" +
				"  findings: 0 deterministic, 0 partial, 0 heuristic\n" +
				"\n" +
				"  \x1b[33mx\x1b[0m f.ts\n" +
				"    artifact: a1 (heuristic)\n" +
				"\n  \x1b[1madoption:\x1b[0m\n" +
				"    public_api: \x1b[31m0%\x1b[0m\n" +
				"    env: \x1b[31m0%\x1b[0m\n" +
				"    config: \x1b[31m0%\x1b[0m\n" +
				"    tests: \x1b[31m0%\x1b[0m\n" +
				"    docs: \x1b[33m50%\x1b[0m\n" +
				"    examples: \x1b[31m0%\x1b[0m\n" +
				"    glossary: \x1b[31m0%\x1b[0m\n" +
				"    layers: \x1b[31m0%\x1b[0m\n" +
				"    packages: \x1b[31m0%\x1b[0m\n" +
				"\n";
			expect(full).toBe(expected);
		});
	});

	// -- kills f581ae5513eb705e ---------------------------------------------
	it("runStructureVerify does not apply the adoption gate when opts.adoptionGate is false", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(calculateAdoption)).mockReturnValue(adoption({ docs: 0.1 }));

		return runStructureVerify("/fake/cwd", { json: true, adoptionGate: false }).then(() => {
			expect(process.exitCode).toBeUndefined();
		});
	});

	// -- kills 802ea0d326e7aaf0 -----------------------------------------------
	it("adoption gate failure message ends with a newline", () => {
		const config = baseConfig({
			adoption: { coverage_thresholds: { docs: 0.9 } },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(calculateAdoption)).mockReturnValue(adoption({ docs: 0.1 }));

		return runStructureVerify("/fake/cwd", { json: false, adoptionGate: true }).then(() => {
			const failLine = stderrWrites.find((s) => s.includes("adoption gate failed"));
			expect(failLine).toBeDefined();
			expect(failLine?.endsWith("\n")).toBe(true);
		});
	});

	// -- kills 5ca9afe5655abd87, 0ebab4deb746ac13, b9fa7d41bf1744ba (runStructureVerify context) --
	it("runStructureVerify only counts fully_deterministic findings toward the exit code", () => {
		const config = baseConfig({
			verify: { fail_on_invalid_structure: false, fail_on_deterministic: true },
		});
		setLoadStructureConfig({ config, errors: [], implicit: false });
		(vi.mocked(evaluateStructureRules)).mockReturnValue([finding("heuristic")]);
		(vi.mocked(formatStructureVerifyOutput)).mockReturnValue({
			mode: "standard",
 catalog_fresh: true,
 invalid_files: [],
			findings: { fully_deterministic: 0, partially_deterministic: 0, heuristic: 1 },
			details: [],
			adoption: adoption(),
		});

		return runStructureVerify("/fake/cwd", { json: true }).then(() => {
			expect(process.exitCode).toBeUndefined();
		});
	});
});
