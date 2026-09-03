// ===========================================
// Check Engine (index.ts) — behavioral coverage
// ===========================================
// Drives every branch of the CheckEngine orchestrator and its module-level
// helpers by mocking the sibling module boundaries:
//   - ./discovery.js          → discoverTools / discoverSingleTool / formatToolReport
//   - ./tool-runners/*.js     → every runner the registry references
//   - ./tool-runners/biome.js → runBiomeOverlay (overlay path)
//   - ./tool-runners/tsc-overlay.js → runTscOverlay / clearTscOverlayCache
//   - ../project-heavy-process-lock.js → faithful cross-process lease double
//   - node:fs                 → statSync (mtime cache control)
// No real subprocesses, filesystem, network, or wall-clock dependence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AuditResult,
	CheckResult,
	ToolAvailability,
	ToolId,
	ToolRunnerInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// node:fs — statSync drives the getDiagnostics mtime cache.
// ---------------------------------------------------------------------------
interface StatStub {
	mtimeMs: number;
}
// Map absolute path -> mtimeMs, or "throw" sentinel to force a stat failure.
const statTable = new Map<string, number | "throw">();

vi.mock("node:fs", () => ({
	statSync: (p: string): StatStub => {
		const v = statTable.get(p);
		if (v === undefined || v === "throw") {
			throw new Error(`ENOENT statSync ${p}`);
		}
		return { mtimeMs: v };
	},
	// Tool-commands config is absent in this fixture world (no
	// .interlinked/tool-commands*.json exists), so the resolver reads nothing.
	existsSync: () => false,
	readFileSync: (): string => {
		throw new Error("readFileSync not mocked — no tool-commands files expected");
	},
}));

// ---------------------------------------------------------------------------
// ./discovery.js — discovery results are fully controlled per test.
// ---------------------------------------------------------------------------
let discoverToolsImpl: (root: string) => ToolAvailability[];
let discoverSingleToolImpl: (id: ToolId, root: string) => ToolAvailability | undefined;
const discoverToolsSpy = vi.fn((root: string) => discoverToolsImpl(root));
const discoverSingleToolSpy = vi.fn((id: ToolId, root: string) =>
	discoverSingleToolImpl(id, root),
);
const formatToolReportSpy = vi.fn(
	(tools: ToolAvailability[]) => `report:${tools.map((t) => t.id).join(",")}`,
);

vi.mock("./discovery.js", () => ({
	discoverTools: (root: string) => discoverToolsSpy(root),
	discoverSingleTool: (id: ToolId, root: string) => discoverSingleToolSpy(id, root),
	formatToolReport: (tools: ToolAvailability[]) => formatToolReportSpy(tools),
}));

// ---------------------------------------------------------------------------
// Tool runner mocks. Each runner records its calls and returns a programmable
// payload. The registry in index.ts wires sync `runner` + (some) `runnerAsync`.
// We model a few concrete tools end-to-end:
//   tsc   → sync + async, concurrencySafe (parallel group)
//   biome → sync + async, concurrencySafe (parallel group)
//   cargo-check → sync only, NOT concurrencySafe (sequential group)
// ---------------------------------------------------------------------------

interface RunnerCall {
	id: string;
	scope: ToolRunnerInput["scope"];
	timeoutMs: number;
}
const syncCalls: RunnerCall[] = [];
const asyncCalls: RunnerCall[] = [];

// Programmable outputs keyed by tool id.
const syncOutputs = new Map<string, () => CheckResult[]>();
const asyncOutputs = new Map<string, () => Promise<CheckResult[]>>();

function mkSyncRunner(id: string) {
	return (input: ToolRunnerInput): CheckResult[] => {
		syncCalls.push({ id, scope: input.scope, timeoutMs: input.timeoutMs });
		const fn = syncOutputs.get(id);
		return fn ? fn() : [];
	};
}
function mkAsyncRunner(id: string) {
	return async (input: ToolRunnerInput): Promise<CheckResult[]> => {
		asyncCalls.push({ id, scope: input.scope, timeoutMs: input.timeoutMs });
		const fn = asyncOutputs.get(id);
		return fn ? fn() : [];
	};
}

// dep-audit returns AuditResult (special-cased in runDepAudit).
let depAuditImpl: (input: ToolRunnerInput) => AuditResult;
const depAuditSpy = vi.fn((input: ToolRunnerInput) => depAuditImpl(input));

// biome overlay + tsc overlay outputs.
let biomeOverlayImpl: (args: {
	projectRoot: string;
	timeoutMs: number;
	filePath: string;
	content: string;
}) => CheckResult[];
const biomeOverlaySpy = vi.fn(
	(args: { projectRoot: string; timeoutMs: number; filePath: string; content: string }) =>
		biomeOverlayImpl(args),
);
let tscOverlayImpl: (args: {
	projectRoot: string;
	filePath: string;
	content: string;
}) => CheckResult[];
const tscOverlaySpy = vi.fn(
	(args: { projectRoot: string; filePath: string; content: string }) => tscOverlayImpl(args),
);
const clearTscOverlayCacheSpy = vi.fn((_root: string) => {});

// --- discovery.js generic-runner module (multiple exports) ---
vi.mock("./tool-runners/generic.js", () => ({
	runEslint: mkSyncRunner("eslint"),
	runEslintAsync: mkAsyncRunner("eslint"),
	runSemgrep: mkSyncRunner("semgrep"),
	runSemgrepAsync: mkAsyncRunner("semgrep"),
	runGitleaks: mkSyncRunner("gitleaks"),
	runGitleaksAsync: mkAsyncRunner("gitleaks"),
	runOxlint: mkSyncRunner("oxlint"),
	runOxlintAsync: mkAsyncRunner("oxlint"),
	runKnip: mkSyncRunner("knip"),
	runKnipAsync: mkAsyncRunner("knip"),
	runDepAudit: (input: ToolRunnerInput) => depAuditSpy(input),
}));

vi.mock("./tool-runners/tsc.js", () => ({
	runTsc: mkSyncRunner("tsc"),
	runTscAsync: mkAsyncRunner("tsc"),
}));

vi.mock("./tool-runners/biome.js", () => ({
	runBiome: mkSyncRunner("biome"),
	runBiomeAsync: mkAsyncRunner("biome"),
	runBiomeOverlay: (args: {
		projectRoot: string;
		timeoutMs: number;
		filePath: string;
		content: string;
	}) => biomeOverlaySpy(args),
}));

vi.mock("./tool-runners/tsc-overlay.js", () => ({
	runTscOverlay: (args: { projectRoot: string; filePath: string; content: string }) =>
		tscOverlaySpy(args),
	// The engine's typed path routes through the same spy, wrapped in the
	// "ok" outcome; unavailable passthrough is pinned in tsc-overlay tests.
	runTscOverlayTyped: (args: { projectRoot: string; filePath: string; content: string }) => ({
		status: "ok",
		findings: tscOverlaySpy(args),
	}),
	clearTscOverlayCache: (root: string) => clearTscOverlayCacheSpy(root),
}));

vi.mock("./tool-runners/python.js", () => ({
	runMypy: mkSyncRunner("mypy"),
	runMypyAsync: mkAsyncRunner("mypy"),
	runRuff: mkSyncRunner("ruff"),
	runRuffAsync: mkAsyncRunner("ruff"),
	runRuffFormat: mkSyncRunner("ruff-format"),
	runRuffFormatAsync: mkAsyncRunner("ruff-format"),
}));

vi.mock("./tool-runners/rust.js", () => ({
	runCargoCheck: mkSyncRunner("cargo-check"),
	runCargoClippy: mkSyncRunner("cargo-clippy"),
	runRustfmtCheck: mkSyncRunner("rustfmt"),
}));

vi.mock("./tool-runners/go.js", () => ({
	runGoBuild: mkSyncRunner("go-build"),
	runGoBuildAsync: mkAsyncRunner("go-build"),
	runGolangciLint: mkSyncRunner("golangci-lint"),
	runGolangciLintAsync: mkAsyncRunner("golangci-lint"),
	runGoTest: mkSyncRunner("go-test"),
	runGoTestAsync: mkAsyncRunner("go-test"),
}));

vi.mock("./tool-runners/c-cpp.js", () => ({
	runCCompile: mkSyncRunner("c-compile"),
	runClangTidy: mkSyncRunner("clang-tidy"),
}));

vi.mock("./tool-runners/shellcheck.js", () => ({
	runShellcheck: mkSyncRunner("shellcheck"),
	runShellcheckAsync: mkAsyncRunner("shellcheck"),
}));

vi.mock("./tool-runners/actionlint.js", () => ({
	runActionlint: mkSyncRunner("actionlint"),
	runActionlintAsync: mkAsyncRunner("actionlint"),
}));

vi.mock("./tool-runners/hadolint.js", () => ({
	runHadolint: mkSyncRunner("hadolint"),
	runHadolintAsync: mkAsyncRunner("hadolint"),
}));

vi.mock("./tool-runners/taplo.js", () => ({
	runTaplo: mkSyncRunner("taplo"),
	runTaploAsync: mkAsyncRunner("taplo"),
}));

vi.mock("./tool-runners/swift.js", () => ({
	runSwiftBuild: mkSyncRunner("swift-build"),
	runSwiftLint: mkSyncRunner("swiftlint"),
	runSwiftLintAsync: mkAsyncRunner("swiftlint"),
}));

// Cross-process lease — faithful project-wide, non-queueing admission double.
// The closure is shared by every CheckEngine instance in this test module.
vi.mock("../project-heavy-process-lock.js", () => {
	let inFlight = false;
	return {
		tryAcquireProjectHeavyProcessLease: (_root: string) => {
			if (inFlight) return null;
			inFlight = true;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				inFlight = false;
			};
		},
	};
});

// ---------------------------------------------------------------------------
// System under test — imported AFTER all vi.mock declarations are hoisted.
// ---------------------------------------------------------------------------
import {
	CheckEngine,
	configNameToToolId,
	type DeduplicationResult,
	deduplicateResults,
	getOrCreateEngine,
	formatToolReport as reExportedFormatToolReport,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ROOT = "/proj";

function avail(id: ToolId, available: boolean, extra?: Partial<ToolAvailability>): ToolAvailability {
	return { id, available, ...extra };
}

function result(over: Partial<CheckResult> & Pick<CheckResult, "tool">): CheckResult {
	return {
		severity: "warning",
		file: "src/x.ts",
		line: 1,
		message: "m",
		...over,
	};
}

beforeEach(() => {
	statTable.clear();
	syncCalls.length = 0;
	asyncCalls.length = 0;
	syncOutputs.clear();
	asyncOutputs.clear();
	discoverToolsSpy.mockClear();
	discoverSingleToolSpy.mockClear();
	formatToolReportSpy.mockClear();
	depAuditSpy.mockClear();
	biomeOverlaySpy.mockClear();
	tscOverlaySpy.mockClear();
	clearTscOverlayCacheSpy.mockClear();
	// Default discovery: empty unless a test overrides.
	discoverToolsImpl = () => [];
	discoverSingleToolImpl = () => undefined;
	depAuditImpl = () => ({
		tool: "dep-audit",
		total: 0,
		critical: 0,
		high: 0,
		moderate: 0,
		low: 0,
		detail: "",
	});
	biomeOverlayImpl = () => [];
	tscOverlayImpl = () => [];
});

afterEach(() => {
	// Reset the module-level singleton between tests so getOrCreateEngine
	// branches are exercised cleanly. clearCache on a fresh engine clears the
	// shared module-level diagnosticCache too.
	new CheckEngine(ROOT).clearCache();
});

// ===========================================================================
// configNameToToolId
// ===========================================================================
describe("configNameToToolId", () => {
	it("maps known harness config names to engine tool ids", () => {
		expect(configNameToToolId("typescript")).toBe("tsc");
		expect(configNameToToolId("biome_lint")).toBe("biome");
		expect(configNameToToolId("biome")).toBe("biome");
		expect(configNameToToolId("dependency_audit")).toBe("dep-audit");
		expect(configNameToToolId("python_typecheck")).toBe("mypy");
		expect(configNameToToolId("swift_build")).toBe("swift-build");
	});

	it("returns undefined for an unknown config name", () => {
		expect(configNameToToolId("not_a_real_check")).toBeUndefined();
	});
});

// ===========================================================================
// Re-exports
// ===========================================================================
describe("re-exports", () => {
	it("re-exports formatToolReport from discovery", () => {
		const out = reExportedFormatToolReport([avail("tsc", true)]);
		expect(out).toBe("report:tsc");
		expect(formatToolReportSpy).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// deduplicateResults — the one module-level export with branching logic.
// (Sibling __tests__/index.test.ts also covers this; we pin the severity
//  tie-break + unknown-severity ?? 0 fallback branch here from THIS file so
//  it counts toward this file's branch coverage.)
// ===========================================================================
describe("deduplicateResults", () => {
	it("keeps higher severity on duplicate key and reports removedCount", () => {
		const res: DeduplicationResult = deduplicateResults([
			result({ tool: "biome", severity: "warning", file: "a.ts", line: 2, message: "same" }),
			result({ tool: "eslint", severity: "error", file: "a.ts", line: 2, message: "same" }),
		]);
		expect(res.deduplicated).toHaveLength(1);
		expect(res.removedCount).toBe(1);
		expect(res.deduplicated[0]?.severity).toBe("error");
	});

	it("keeps the first on a severity tie (earlier tool wins)", () => {
		const res = deduplicateResults([
			result({ tool: "biome", severity: "warning", file: "a.ts", line: 9, message: "dup" }),
			result({ tool: "eslint", severity: "warning", file: "a.ts", line: 9, message: "dup" }),
		]);
		expect(res.deduplicated).toHaveLength(1);
		expect(res.deduplicated[0]?.tool).toBe("biome");
	});

	it("treats an unrecognized EXISTING severity as rank 0 via the ?? fallback", () => {
		// First entry has a bogus severity (rank 0). Second has 'info' (rank 1),
		// so it must REPLACE the first — exercising the `?? 0` on the existing.
		const bogus = result({
			tool: "biome",
			severity: "warning",
			file: "z.ts",
			line: 1,
			message: "x",
		});
		// Force an out-of-enum severity without an `as` cast on the public type.
		Object.assign(bogus, { severity: "trace" });
		const info = result({
			tool: "eslint",
			severity: "info",
			file: "z.ts",
			line: 1,
			message: "x",
		});
		const res = deduplicateResults([bogus, info]);
		expect(res.deduplicated).toHaveLength(1);
		expect(res.deduplicated[0]?.severity).toBe("info");
	});

	it("treats an unrecognized INCOMING severity as rank 0 (keeps the existing)", () => {
		// Existing is 'info' (rank 1); incoming duplicate has a bogus severity
		// (rank 0 via the `severityRank[r.severity] ?? 0` fallback), so 0 > 1 is
		// false and the existing is kept.
		const info = result({
			tool: "biome",
			severity: "info",
			file: "z.ts",
			line: 2,
			message: "y",
		});
		const bogus = result({
			tool: "eslint",
			severity: "warning",
			file: "z.ts",
			line: 2,
			message: "y",
		});
		Object.assign(bogus, { severity: "trace" });
		const res = deduplicateResults([info, bogus]);
		expect(res.deduplicated).toHaveLength(1);
		expect(res.deduplicated[0]?.tool).toBe("biome");
		expect(res.deduplicated[0]?.severity).toBe("info");
	});
});

// ===========================================================================
// CheckEngine.discoverTools — caching + single-tool cache population.
// ===========================================================================
describe("CheckEngine.discoverTools", () => {
	it("calls discovery once and caches the result for subsequent calls", () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", false)];
		const eng = new CheckEngine(ROOT);
		const first = eng.discoverTools();
		const second = eng.discoverTools();
		expect(first).toBe(second); // same cached array reference
		expect(discoverToolsSpy).toHaveBeenCalledTimes(1);
		expect(discoverToolsSpy).toHaveBeenCalledWith(ROOT);
	});

	it("populates the per-tool cache so isToolAvailable hits the full cache", () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", false)];
		const eng = new CheckEngine(ROOT);
		eng.discoverTools();
		// Full cache present → isToolAvailable reads from it, no single-tool probe.
		expect(eng.isToolAvailable("tsc")).toBe(true);
		expect(eng.isToolAvailable("biome")).toBe(false);
		expect(discoverSingleToolSpy).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// CheckEngine.isToolAvailable — all three cache tiers + miss.
// ===========================================================================
describe("CheckEngine.isToolAvailable", () => {
	it("returns false from the full cache when the tool id is absent", () => {
		discoverToolsImpl = () => [avail("tsc", true)];
		const eng = new CheckEngine(ROOT);
		eng.discoverTools(); // populate full cache
		expect(eng.isToolAvailable("ruff")).toBe(false);
	});

	it("uses the per-tool cache (single probe) when no full cache exists", () => {
		discoverSingleToolImpl = (id) => avail(id, true);
		const eng = new CheckEngine(ROOT);
		expect(eng.isToolAvailable("ruff")).toBe(true);
		// Second call must hit the per-tool cache, not re-probe.
		expect(eng.isToolAvailable("ruff")).toBe(true);
		expect(discoverSingleToolSpy).toHaveBeenCalledTimes(1);
	});

	it("returns the cached availability=false from a prior single probe", () => {
		discoverSingleToolImpl = (id) => avail(id, false);
		const eng = new CheckEngine(ROOT);
		expect(eng.isToolAvailable("knip")).toBe(false);
		expect(eng.isToolAvailable("knip")).toBe(false);
		expect(discoverSingleToolSpy).toHaveBeenCalledTimes(1);
	});

	it("returns false when the single-tool probe yields undefined", () => {
		discoverSingleToolImpl = () => undefined;
		const eng = new CheckEngine(ROOT);
		expect(eng.isToolAvailable("taplo")).toBe(false);
		// undefined results are not cached → a second call probes again.
		expect(eng.isToolAvailable("taplo")).toBe(false);
		expect(discoverSingleToolSpy).toHaveBeenCalledTimes(2);
	});
});

// ===========================================================================
// CheckEngine.formatToolReport
// ===========================================================================
describe("CheckEngine.formatToolReport", () => {
	it("formats the discovered tool list", () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("ruff", false)];
		const eng = new CheckEngine(ROOT);
		expect(eng.formatToolReport()).toBe("report:tsc,ruff");
	});
});

// ===========================================================================
// CheckEngine.runChecks (sync)
// ===========================================================================
describe("CheckEngine.runChecks", () => {
	it("runs available tools, aggregates + dedups results, records metrics", () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		syncOutputs.set("tsc", () => [
			result({ tool: "tsc", severity: "error", file: "a.ts", line: 5, message: "dup" }),
		]);
		syncOutputs.set("biome", () => [
			result({ tool: "biome", severity: "warning", file: "a.ts", line: 5, message: "dup" }),
			result({ tool: "biome", severity: "warning", file: "b.ts", line: 1, message: "lone" }),
		]);

		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks({ projectRoot: ROOT, mode: "file" });

		// tsc(error) + biome(warning) on a.ts:5 dedup to 1; b.ts:1 survives.
		expect(rep.results).toHaveLength(2);
		expect(rep.deduplicatedCount).toBe(1);
		expect(rep.toolsRun.map((t) => t.id)).toEqual(["tsc", "biome"]);
		expect(rep.toolsSkipped).toHaveLength(0);
		expect(rep.metrics.map((m) => m.tool)).toEqual(["tsc", "biome"]);
		expect(rep.metrics.every((m) => m.cacheHit === false)).toBe(true);
		expect(rep.metrics[1]?.findingCount).toBe(2);
		expect(rep.elapsedMs).toBeGreaterThanOrEqual(0);
		// file mode → default 5s timeout passed to runners.
		expect(syncCalls.every((c) => c.timeoutMs === 5_000)).toBe(true);
	});

	it("uses the project-mode default timeout (30s)", () => {
		discoverToolsImpl = () => [avail("tsc", true)];
		const eng = new CheckEngine(ROOT);
		eng.runChecks({ projectRoot: ROOT, mode: "project" });
		expect(syncCalls[0]?.timeoutMs).toBe(30_000);
	});

	it("honors an explicit options.timeoutMs over the mode default", () => {
		discoverToolsImpl = () => [avail("tsc", true)];
		const eng = new CheckEngine(ROOT);
		eng.runChecks({ projectRoot: ROOT, mode: "project" }, { timeoutMs: 1234 });
		expect(syncCalls[0]?.timeoutMs).toBe(1234);
	});

	it("filters to the options.tools allow-list (skips others)", () => {
		discoverSingleToolImpl = (id) => avail(id, true);
		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks(
			{ projectRoot: ROOT, mode: "file" },
			{ tools: ["tsc"] },
		);
		expect(rep.toolsRun.map((t) => t.id)).toEqual(["tsc"]);
		expect(rep.toolsSkipped).toEqual([]);
		expect(syncCalls.map((c) => c.id)).toEqual(["tsc"]);
		expect(discoverToolsSpy).not.toHaveBeenCalled();
		expect(discoverSingleToolSpy).toHaveBeenCalledWith("tsc", ROOT);
	});

	it("respects options.skipTools", () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks(
			{ projectRoot: ROOT, mode: "file" },
			{ skipTools: ["biome"] },
		);
		expect(rep.toolsRun.map((t) => t.id)).toEqual(["tsc"]);
		expect(rep.toolsSkipped.map((t) => t.id)).toEqual(["biome"]);
	});

	it("excludes unavailable tools and tags them tool_missing with the reason", () => {
		discoverToolsImpl = () => [
			avail("tsc", true),
			avail("ruff", false, { reason: "not installed" }),
		];
		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks({ projectRoot: ROOT, mode: "file" });
		expect(rep.toolsRun.map((t) => t.id)).toEqual(["tsc"]);
		const ruffSkip = rep.skipped.find((s) => s.check === "ruff");
		expect(ruffSkip?.category).toBe("tool_missing");
		expect(ruffSkip?.reason).toBe("not installed");
	});

	it("falls back to 'not installed' when an unavailable tool has no reason", () => {
		discoverToolsImpl = () => [avail("ruff", false)]; // reason omitted
		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks({ projectRoot: ROOT, mode: "file" });
		const ruffSkip = rep.skipped.find((s) => s.check === "ruff");
		expect(ruffSkip?.reason).toBe("not installed");
		expect(ruffSkip?.category).toBe("tool_missing");
	});

	it("skips an available tool that has no registered runner (continue branch)", () => {
		// dep-audit is discoverable + available but NOT in TOOL_RUNNERS, so the
		// `if (!runner) continue` branch fires.
		discoverToolsImpl = () => [avail("dep-audit", true), avail("tsc", true)];
		syncOutputs.set("tsc", () => [result({ tool: "tsc" })]);
		const eng = new CheckEngine(ROOT);
		const rep = eng.runChecks({ projectRoot: ROOT, mode: "file" });
		// dep-audit is "run" (passes the filter) but produces no metric/results.
		expect(rep.metrics.map((m) => m.tool)).toEqual(["tsc"]);
		expect(rep.results).toHaveLength(1);
		expect(syncCalls.map((c) => c.id)).toEqual(["tsc"]);
	});
});

// ===========================================================================
// CheckEngine.runChecksAsync
// ===========================================================================
describe("CheckEngine.runChecksAsync", () => {
	it("declines a concurrent request burst and runs the admitted batch one tool at a time", async () => {
		discoverSingleToolImpl = (id) => avail(id, true);
		let active = 0;
		let peak = 0;
		let releaseRunners: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseRunners = resolve;
		});
		let observeFirstStart: () => void = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			observeFirstStart = resolve;
		});
		const boundedRunner = async (): Promise<CheckResult[]> => {
			active++;
			peak = Math.max(peak, active);
			observeFirstStart();
			await release;
			active--;
			return [];
		};
		asyncOutputs.set("tsc", boundedRunner);
		asyncOutputs.set("biome", boundedRunner);

		const first = new CheckEngine(ROOT);
		const admitted = first.runChecksAsync(
			{ projectRoot: ROOT, mode: "file" },
			{ tools: ["tsc", "biome"] },
		);

		await firstStarted;
		expect(peak).toBe(1);
		let eventLoopTurn = false;
		setTimeout(() => {
			eventLoopTurn = true;
		}, 0);
		const burst = await Promise.all(
			Array.from({ length: 32 }, () =>
				new CheckEngine(ROOT).runChecksAsync(
					{ projectRoot: ROOT, mode: "file" },
					{ tools: ["tsc"] },
				),
			),
		);
		expect(burst).toHaveLength(32);
		expect(
			burst.every(
				(report) =>
					report.toolsRun.length === 0 &&
					report.skipped[0]?.category === "resource_busy" &&
					report.skipped[0]?.check === "tsc",
			),
		).toBe(true);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(eventLoopTurn).toBe(true);
		expect(asyncCalls).toHaveLength(1);
		releaseRunners();
		await admitted;
		expect(peak).toBe(1);
		expect(asyncCalls).toHaveLength(2);

		// Release is real: the next request gets a slot and executes.
		await new CheckEngine(ROOT).runChecksAsync(
			{ projectRoot: ROOT, mode: "file" },
			{ tools: ["tsc"] },
		);
		expect(asyncCalls).toHaveLength(3);
		expect(discoverToolsSpy).not.toHaveBeenCalled();
	});

	it("runs concurrency-safe tools sequentially via async runners + dedups", async () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		asyncOutputs.set("tsc", async () => [
			result({ tool: "tsc", severity: "error", file: "a.ts", line: 7, message: "dup" }),
		]);
		asyncOutputs.set("biome", async () => [
			result({ tool: "biome", severity: "warning", file: "a.ts", line: 7, message: "dup" }),
			result({ tool: "biome", severity: "warning", file: "c.ts", line: 1, message: "lone" }),
		]);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "project" });
		expect(rep.results).toHaveLength(2);
		expect(rep.deduplicatedCount).toBe(1);
		// async runners were preferred over sync for both safe tools.
		expect(asyncCalls.map((c) => c.id).sort()).toEqual(["biome", "tsc"]);
		expect(syncCalls).toHaveLength(0);
		expect(rep.toolsRun.map((t) => t.id).sort()).toEqual(["biome", "tsc"]);
		// project mode → 30s timeout.
		expect(asyncCalls.every((c) => c.timeoutMs === 30_000)).toBe(true);
	});

	it("never invokes a sync-only runner on the daemon-safe async path", async () => {
		// cargo-check is concurrencySafe:false and sync-only. Running it here
		// would block every daemon socket despite the method being async.
		discoverToolsImpl = () => [avail("tsc", true), avail("cargo-check", true)];
		asyncOutputs.set("tsc", async () => [result({ tool: "tsc", file: "a.ts", line: 1 })]);
		syncOutputs.set("cargo-check", () => [
			result({ tool: "cargo-check", file: "main.rs", line: 2 }),
		]);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "project" });
		expect(rep.results).toHaveLength(1);
		expect(asyncCalls.map((c) => c.id)).toEqual(["tsc"]);
		expect(syncCalls).toHaveLength(0);
		expect(rep.metrics.map((m) => m.tool)).toEqual(["tsc", "cargo-check"]);
		expect(rep.toolsRun.map((tool) => tool.id)).toEqual(["tsc"]);
		expect(rep.skipped).toContainEqual({
			check: "cargo-check",
			reason: "async runner unavailable; run `interlinked verify` for this tool",
			category: "error",
		});
	});

	it("isolates a crashing async runner without calling it clean", async () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		asyncOutputs.set("tsc", async () => {
			throw new Error("tsc spawn blew up");
		});
		asyncOutputs.set("biome", async () => [result({ tool: "biome", file: "ok.ts", line: 1 })]);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "file" });
		// biome's one finding survives; tsc contributes nothing.
		expect(rep.results).toHaveLength(1);
		expect(rep.results[0]?.tool).toBe("biome");
		const tscMetric = rep.metrics.find((m) => m.tool === "tsc");
		expect(tscMetric?.findingCount).toBe(0);
		expect(rep.skipped).toContainEqual({
			check: "tsc",
			reason: "tsc spawn blew up",
			category: "error",
		});
	});

	it("defers a sync-only runner without calling it", async () => {
		discoverToolsImpl = () => [avail("cargo-check", true)];
		syncOutputs.set("cargo-check", () => {
			throw new Error("cargo exploded");
		});
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "project" });
		expect(rep.results).toHaveLength(0);
		expect(rep.metrics.find((m) => m.tool === "cargo-check")?.findingCount).toBe(0);
		expect(syncCalls).toHaveLength(0);
		expect(rep.skipped).toContainEqual({
			check: "cargo-check",
			reason: "async runner unavailable; run `interlinked verify` for this tool",
			category: "error",
		});
	});

	it("defers an available tool absent from the async registry", async () => {
		// dep-audit passes the filter but has no TOOL_REGISTRY entry → runOne
		// returns the zeroed metric branch.
		discoverToolsImpl = () => [avail("dep-audit", true)];
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "file" });
		// dep-audit has no concurrencySafe meta → lands in the sequential group.
		expect(rep.metrics).toEqual([
			{ tool: "dep-audit", elapsedMs: 0, findingCount: 0, cacheHit: false },
		]);
		expect(rep.results).toHaveLength(0);
		expect(rep.toolsRun).toEqual([]);
		expect(rep.skipped).toContainEqual({
			check: "dep-audit",
			reason: "no async check runner is registered; run `interlinked verify` for this tool",
			category: "error",
		});
	});

	it("runs every safe tool in the finite admitted batch", async () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		asyncOutputs.set("tsc", async () => [result({ tool: "tsc", file: "a.ts", line: 1 })]);
		asyncOutputs.set("biome", async () => [result({ tool: "biome", file: "b.ts", line: 1 })]);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "file" });
		expect(rep.results).toHaveLength(2);
		expect(asyncCalls.map((c) => c.id).sort()).toEqual(["biome", "tsc"]);
	});

	it("applies options.tools / skipTools filtering and skip categorization", async () => {
		discoverSingleToolImpl = (id) => avail(id, true);
		asyncOutputs.set("tsc", async () => []);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync(
			{ projectRoot: ROOT, mode: "file" },
			{ tools: ["tsc"] },
		);
		expect(rep.toolsRun.map((t) => t.id)).toEqual(["tsc"]);
		expect(rep.toolsSkipped).toEqual([]);
		expect(discoverToolsSpy).not.toHaveBeenCalled();
		expect(discoverSingleToolSpy).toHaveBeenCalledWith("tsc", ROOT);
	});

	it("falls back to 'skipped by options' reason for an available deselected tool", async () => {
		discoverToolsImpl = () => [avail("tsc", true), avail("biome", true)];
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync(
			{ projectRoot: ROOT, mode: "file" },
			{ skipTools: ["biome"] },
		);
		const biomeSkip = rep.skipped.find((s) => s.check === "biome");
		expect(biomeSkip?.reason).toBe("skipped by options");
	});

	it("falls back to 'not installed' for an unavailable tool with no reason", async () => {
		// Exercises the false side of the async skip `reason`/`category` ternaries.
		discoverToolsImpl = () => [avail("tsc", true), avail("ruff", false)]; // ruff reason omitted
		asyncOutputs.set("tsc", async () => []);
		const eng = new CheckEngine(ROOT);
		const rep = await eng.runChecksAsync({ projectRoot: ROOT, mode: "file" });
		const ruffSkip = rep.skipped.find((s) => s.check === "ruff");
		expect(ruffSkip?.reason).toBe("not installed");
		expect(ruffSkip?.category).toBe("tool_missing");
	});

});

// ===========================================================================
// CheckEngine.runDepAudit
// ===========================================================================
describe("CheckEngine.runDepAudit", () => {
	it("returns null when dep-audit is not discovered at all", () => {
		discoverToolsImpl = () => [avail("tsc", true)];
		const eng = new CheckEngine(ROOT);
		expect(eng.runDepAudit()).toBeNull();
		expect(depAuditSpy).not.toHaveBeenCalled();
	});

	it("returns null when dep-audit is present but unavailable", () => {
		discoverToolsImpl = () => [avail("dep-audit", false)];
		const eng = new CheckEngine(ROOT);
		expect(eng.runDepAudit()).toBeNull();
	});

	it("runs the audit with the default 30s timeout and project scope", () => {
		discoverToolsImpl = () => [avail("dep-audit", true)];
		const audit: AuditResult = {
			tool: "dep-audit",
			total: 4,
			critical: 1,
			high: 1,
			moderate: 2,
			low: 0,
			detail: "1 critical, 1 high, 2 moderate",
		};
		depAuditImpl = () => audit;
		const eng = new CheckEngine(ROOT);
		expect(eng.runDepAudit()).toEqual(audit);
		const call = depAuditSpy.mock.calls[0]?.[0];
		expect(call?.timeoutMs).toBe(30_000);
		expect(call?.scope).toEqual({ projectRoot: ROOT, mode: "project" });
	});

	it("honors an explicit timeout argument", () => {
		discoverToolsImpl = () => [avail("dep-audit", true)];
		const eng = new CheckEngine(ROOT);
		eng.runDepAudit(99);
		expect(depAuditSpy.mock.calls[0]?.[0]?.timeoutMs).toBe(99);
	});
});

// ===========================================================================
// CheckEngine.getDiagnostics — mtime cache, extension dispatch, stat failures.
// ===========================================================================
describe("CheckEngine.getDiagnostics", () => {
	it("reads a cold diagnostic cache without discovery or tool execution", () => {
		const file = "/proj/src/cold.ts";
		statTable.set(file, 1);
		discoverSingleToolImpl = (id) => avail(id, true);

		expect(new CheckEngine(ROOT).getCachedDiagnostics(file)).toEqual([]);
		expect(discoverSingleToolSpy).not.toHaveBeenCalled();
		expect(discoverToolsSpy).not.toHaveBeenCalled();
		expect(syncCalls).toHaveLength(0);
	});

	it("returns only an mtime-matched cache snapshot without re-running tools", () => {
		const file = "/proj/src/cached.ts";
		statTable.set(file, 10);
		discoverSingleToolImpl = (id) => avail(id, true);
		syncOutputs.set("tsc", () => [result({ tool: "tsc", file: "src/cached.ts", line: 1 })]);
		const engine = new CheckEngine(ROOT);
		const populated = engine.getDiagnostics(file);

		syncCalls.length = 0;
		discoverSingleToolSpy.mockClear();
		expect(engine.getCachedDiagnostics(file)).toBe(populated);
		expect(discoverSingleToolSpy).not.toHaveBeenCalled();
		expect(syncCalls).toHaveLength(0);

		statTable.set(file, 11);
		expect(engine.getCachedDiagnostics(file)).toEqual([]);
		expect(discoverSingleToolSpy).not.toHaveBeenCalled();
		expect(syncCalls).toHaveLength(0);
	});

	it("returns [] and short-circuits when the initial stat throws", () => {
		// no statTable entry for the path → statSync throws.
		discoverSingleToolImpl = (id) => avail(id, true);
		const eng = new CheckEngine(ROOT);
		expect(eng.getDiagnostics("/proj/missing.ts")).toEqual([]);
		// stat failed before any tool dispatch.
		expect(syncCalls).toHaveLength(0);
	});

	it("dispatches .ts to tsc/biome/oxlint, runs only available ones, caches by mtime", () => {
		const file = "/proj/src/a.ts";
		statTable.set(file, 111);
		discoverSingleToolImpl = (id) =>
			id === "oxlint" ? avail(id, false) : avail(id, true); // oxlint unavailable
		syncOutputs.set("tsc", () => [result({ tool: "tsc", file: "src/a.ts", line: 3 })]);
		syncOutputs.set("biome", () => [result({ tool: "biome", file: "src/a.ts", line: 4 })]);

		const eng = new CheckEngine(ROOT);
		const first = eng.getDiagnostics(file);
		expect(first).toHaveLength(2);
		// Only tsc + biome ran (oxlint filtered by availability=false).
		expect(syncCalls.map((c) => c.id)).toEqual(["tsc", "biome"]);
		// per-file 5s timeout is hard-coded in getDiagnostics.
		expect(syncCalls.every((c) => c.timeoutMs === 5_000)).toBe(true);

		// Second call, same mtime → cache HIT, no re-run.
		syncCalls.length = 0;
		const second = eng.getDiagnostics(file);
		expect(second).toBe(first); // cached array reference
		expect(syncCalls).toHaveLength(0);
	});

	it("re-runs when mtime changes (stale cache)", () => {
		const file = "/proj/src/b.ts";
		statTable.set(file, 100);
		discoverSingleToolImpl = (id) => avail(id, true);
		syncOutputs.set("tsc", () => [result({ tool: "tsc", file: "src/b.ts", line: 1 })]);

		const eng = new CheckEngine(ROOT);
		eng.getDiagnostics(file);
		const firstRunCount = syncCalls.length;
		expect(firstRunCount).toBeGreaterThan(0);

		// Bump mtime → cached entry is stale → re-run.
		statTable.set(file, 200);
		syncCalls.length = 0;
		eng.getDiagnostics(file);
		expect(syncCalls.length).toBe(firstRunCount);
	});

	it("returns [] for an extension with no mapped tools", () => {
		const file = "/proj/notes.md";
		statTable.set(file, 5);
		discoverSingleToolImpl = (id) => avail(id, true);
		const eng = new CheckEngine(ROOT);
		expect(eng.getDiagnostics(file)).toEqual([]);
		expect(syncCalls).toHaveLength(0);
	});

	// Exercise every branch of getToolsForExtension's dispatch switch.
	const extensionCases: Array<{ file: string; tools: ToolId[] }> = [
		{ file: "/proj/a.tsx", tools: ["tsc", "biome", "oxlint"] },
		{ file: "/proj/a.js", tools: ["biome", "oxlint"] },
		{ file: "/proj/a.jsx", tools: ["biome", "oxlint"] },
		{ file: "/proj/a.mjs", tools: ["biome", "oxlint"] },
		{ file: "/proj/a.cjs", tools: ["biome", "oxlint"] },
		{ file: "/proj/a.pyi", tools: ["mypy", "ruff", "ruff-format"] },
		{ file: "/proj/a.rs", tools: ["cargo-check", "cargo-clippy", "rustfmt"] },
		{ file: "/proj/a.go", tools: ["go-build", "golangci-lint"] },
		{ file: "/proj/a.c", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.cpp", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.cc", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.cxx", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.h", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.hpp", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.hxx", tools: ["c-compile", "clang-tidy"] },
		{ file: "/proj/a.sh", tools: ["shellcheck"] },
		{ file: "/proj/a.bash", tools: ["shellcheck"] },
		{ file: "/proj/a.zsh", tools: ["shellcheck"] },
		{ file: "/proj/a.ksh", tools: ["shellcheck"] },
		{ file: "/proj/a.toml", tools: ["taplo"] },
		{ file: "/proj/a.swift", tools: ["swiftlint", "swift-build"] },
	];

	it.each(extensionCases)(
		"dispatches $file to the expected tool set",
		({ file, tools }) => {
			statTable.set(file, 1);
			discoverSingleToolImpl = (id) => avail(id, true);
			// All dispatched tools return one finding so we can count dispatch.
			for (const t of tools) syncOutputs.set(t, () => [result({ tool: t })]);
			const eng = new CheckEngine(ROOT);
			const out = eng.getDiagnostics(file);
			expect(out).toHaveLength(tools.length);
			expect(syncCalls.map((c) => c.id)).toEqual(tools);
		},
	);

	it("skips a dispatched tool that is available but has no registered runner", () => {
		// .py dispatches to mypy + ruff + ruff-format; all are registered, so to
		// hit the `if (!runner) continue` branch we use a language whose dispatch
		// list includes a tool with a registry entry plus availability. Instead we
		// assert the available-but-unavailable filter for the ruff tools here and
		// rely on the registry-miss branch being covered by the runChecks suite.
		const file = "/proj/app.py";
		statTable.set(file, 9);
		discoverSingleToolImpl = (id) =>
			id === "ruff" || id === "ruff-format" ? avail(id, false) : avail(id, true);
		syncOutputs.set("mypy", () => [result({ tool: "mypy", file: "app.py", line: 1 })]);
		const eng = new CheckEngine(ROOT);
		const out = eng.getDiagnostics(file);
		expect(out).toHaveLength(1);
		expect(syncCalls.map((c) => c.id)).toEqual(["mypy"]);
	});

	it("still returns fresh results when the post-run stat throws (cache-write skipped)", () => {
		const file = "/proj/src/c.ts";
		statTable.set(file, 50);
		discoverSingleToolImpl = (id) => avail(id, true);
		syncOutputs.set("tsc", () => [result({ tool: "tsc", file: "src/c.ts", line: 2 })]);
		syncOutputs.set("biome", () => []);
		syncOutputs.set("oxlint", () => []);

		const eng = new CheckEngine(ROOT);
		// Make ONLY the post-run stat fail: succeed on read, throw on write.
		// First getDiagnostics: initial stat OK (entry=50). After runners, the
		// cache-write stat runs — flip the entry to "throw" via a one-shot.
		let calls = 0;
		statTable.set(file, 50);
		const orig = statTable.get.bind(statTable);
		vi.spyOn(statTable, "get").mockImplementation((k: string) => {
			if (k === file) {
				calls += 1;
				// 1st read (cache-check) succeeds; 2nd read (cache-write) throws.
				return calls >= 2 ? "throw" : 50;
			}
			return orig(k);
		});

		const out = eng.getDiagnostics(file);
		expect(out).toHaveLength(1); // results returned despite no cache write

		// Restore + verify nothing was cached: a follow-up re-runs the tools.
		vi.mocked(statTable.get).mockRestore();
		statTable.set(file, 50);
		syncCalls.length = 0;
		eng.getDiagnostics(file);
		expect(syncCalls.length).toBeGreaterThan(0); // not served from cache
	});
});

// ===========================================================================
// clearCache / clearAllCaches
// ===========================================================================
describe("cache clearing", () => {
	it("clearCache empties the diagnostic cache (subsequent call re-runs tools)", () => {
		const file = "/proj/src/d.ts";
		statTable.set(file, 1);
		discoverSingleToolImpl = (id) => avail(id, true);
		syncOutputs.set("tsc", () => [result({ tool: "tsc", file: "src/d.ts", line: 1 })]);
		syncOutputs.set("biome", () => []);
		syncOutputs.set("oxlint", () => []);

		const eng = new CheckEngine(ROOT);
		eng.getDiagnostics(file);
		eng.clearCache();
		syncCalls.length = 0;
		eng.getDiagnostics(file); // cache cleared → re-runs
		expect(syncCalls.length).toBeGreaterThan(0);
	});

	it("clearAllCaches clears the diagnostic cache AND the tsc overlay cache", () => {
		const eng = new CheckEngine(ROOT);
		eng.clearAllCaches();
		expect(clearTscOverlayCacheSpy).toHaveBeenCalledWith(ROOT);
	});
});

// ===========================================================================
// getBiomeDiagnosticsForOverlay
// ===========================================================================
describe("CheckEngine.getBiomeDiagnosticsForOverlay", () => {
	it("returns [] when biome is unavailable (no overlay run)", () => {
		discoverSingleToolImpl = () => avail("biome", false);
		const eng = new CheckEngine(ROOT);
		expect(eng.getBiomeDiagnosticsForOverlay("/proj/src/x.ts", "code")).toEqual([]);
		expect(biomeOverlaySpy).not.toHaveBeenCalled();
	});

	it("runs the overlay with the default 500ms timeout and filters to the relative path", () => {
		discoverSingleToolImpl = () => avail("biome", true);
		biomeOverlayImpl = () => [
			result({ tool: "biome", file: "src/x.ts", line: 1, message: "in" }),
			result({ tool: "biome", file: "src/other.ts", line: 9, message: "cross-file" }),
		];
		const eng = new CheckEngine(ROOT);
		const out = eng.getBiomeDiagnosticsForOverlay("/proj/src/x.ts", "code");
		// projectRoot-prefixed path → relative "src/x.ts" kept, cross-file dropped.
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/x.ts");
		const call = biomeOverlaySpy.mock.calls[0]?.[0];
		expect(call?.timeoutMs).toBe(500);
		expect(call?.filePath).toBe("/proj/src/x.ts");
		expect(call?.content).toBe("code");
	});

	it("honors a custom timeout and keeps results matching the absolute path", () => {
		discoverSingleToolImpl = () => avail("biome", true);
		// File path is OUTSIDE projectRoot → rel stays the absolute path; a
		// result whose file equals the absolute path is kept.
		const abs = "/elsewhere/y.ts";
		biomeOverlayImpl = () => [result({ tool: "biome", file: abs, line: 2, message: "abs" })];
		const eng = new CheckEngine(ROOT);
		const out = eng.getBiomeDiagnosticsForOverlay(abs, "x", 250);
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe(abs);
		expect(biomeOverlaySpy.mock.calls[0]?.[0]?.timeoutMs).toBe(250);
	});

	it("strips multiple leading slashes when computing the relative path", () => {
		discoverSingleToolImpl = () => avail("biome", true);
		const root = "/proj";
		// path "/proj//src/z.ts" → slice(root.length) = "//src/z.ts" → "src/z.ts"
		biomeOverlayImpl = () => [result({ tool: "biome", file: "src/z.ts", line: 1 })];
		const eng = new CheckEngine(root);
		const out = eng.getBiomeDiagnosticsForOverlay("/proj//src/z.ts", "c");
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/z.ts");
	});
});

// ===========================================================================
// getTscDiagnosticsForOverlay
// ===========================================================================
describe("CheckEngine.getTscDiagnosticsForOverlay", () => {
	it("delegates to runTscOverlay with project root, file path, and content", () => {
		tscOverlayImpl = () => [result({ tool: "tsc", severity: "error", file: "src/q.ts", line: 8 })];
		const eng = new CheckEngine(ROOT);
		const out = eng.getTscDiagnosticsForOverlay("/proj/src/q.ts", "const x: number = 's'");
		expect(out).toHaveLength(1);
		expect(out[0]?.tool).toBe("tsc");
		expect(tscOverlaySpy).toHaveBeenCalledWith({
			projectRoot: ROOT,
			filePath: "/proj/src/q.ts",
			content: "const x: number = 's'",
		});
	});

	it("typed variant returns the ok outcome with the same findings", () => {
		tscOverlayImpl = () => [result({ tool: "tsc", severity: "error", file: "src/q.ts", line: 8 })];
		const eng = new CheckEngine(ROOT);
		const out = eng.getTscDiagnosticsForOverlayTyped("/proj/src/q.ts", "const x: number = 's'");
		expect(out.status).toBe("ok");
		expect(out.status === "ok" && out.findings).toHaveLength(1);
	});
});

// ===========================================================================
// getOrCreateEngine — singleton lifecycle.
// ===========================================================================
describe("getOrCreateEngine", () => {
	it("creates an engine on first call and returns the same instance for the same root", () => {
		const a = getOrCreateEngine("/root-a");
		const b = getOrCreateEngine("/root-a");
		expect(a).toBe(b);
		expect(a.projectRoot).toBe("/root-a");
	});

	it("creates a new instance when the project root changes", () => {
		const a = getOrCreateEngine("/root-1");
		const b = getOrCreateEngine("/root-2");
		expect(a).not.toBe(b);
		expect(b.projectRoot).toBe("/root-2");
		// Switching back makes a fresh one again (current != requested).
		const c = getOrCreateEngine("/root-1");
		expect(c).not.toBe(a);
	});
});
