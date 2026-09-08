import type { CheckEngine } from "../check-engine/index.js";
import { loopAudit, loopEngine, loopProfile, loopReport, type LoopReportFixture } from "./test-tool-loop-fixtures.js";
// ===========================================
// tool-check-loop.ts — mutation-kill wave 30
// ===========================================
// Targeted receipts for the 41 mutants the manifest reports as `survived`
// for this file. Each case is annotated with the exact mutantId(s) it kills.
// Mock boilerplate mirrors tool-check-loop.integration.test.ts (same SUT,
// independent module registry per test file).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, QualityCheckConfig } from "../types.js";
import { runToolCheckLoop, type ToolCheckLoopContext } from "./tool-check-loop.js";

// --- module-boundary mocks ------------------------------------------------

vi.mock("../check-engine/index.js", async () => {
	const actual = await vi.importActual<typeof import("../check-engine/index.js")>("../check-engine/index.js");
	return { ...actual, configNameToToolId: vi.fn(), getOrCreateEngine: vi.fn() };
});

vi.mock("../check-engine/spawn-async.js", () => ({
	runProcessAsync: vi.fn(),
}));

vi.mock("../project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: vi.fn(),
}));

vi.mock("../check-engine/output-parsers.js", () => ({
	parseNpmAuditJson: vi.fn(),
	parseOsvScannerJson: vi.fn(),
}));

vi.mock("../checks/shared.js", () => ({
	isGeneratedFile: vi.fn(() => false),
	isTestFile: vi.fn(() => false),
}));

vi.mock("../language-profiles.js", () => ({
	getProfileForFile: vi.fn(),
}));

vi.mock("./dependency-audit.js", () => ({
	resolveDependencyAuditCommandAsync: vi.fn(),
}));

vi.mock("./inline-language-checks.js", () => ({
	runInlineLanguageChecks: vi.fn(() => []),
}));

vi.mock("./lockfile-drift.js", () => ({
	checkLockfileDrift: vi.fn(),
	checkLockfileClassificationDrift: vi.fn(() => ({
		drifted: false,
		manifest: "package.json",
		mismatches: [],
	})),
	LOCKFILE_MAP: { "package.json": ["package-lock.json", "yarn.lock"] },
}));

vi.mock("./package-json.js", () => ({
	checkPackageJsonConsistency: vi.fn(() => []),
}));

vi.mock("./project-root.js", () => ({
	findProjectRoot: vi.fn(() => "/proj"),
}));

vi.mock("./secret-detection.js", () => ({
	containsSecrets: vi.fn(() => []),
}));

vi.mock("./software-version-regression.js", () => ({
	collectSoftwareVersionReferences: vi.fn(() => []),
	detectSoftwareVersionRegressions: vi.fn(() => []),
	detectSoftwareVersionFreshnessConcerns: vi.fn(() => []),
	formatSoftwareVersionRegressionDetail: vi.fn(() => "REG-DETAIL"),
	formatSoftwareVersionFreshnessDetail: vi.fn(() => "FRESH-DETAIL"),
}));

vi.mock("./strong-typing.js", () => ({
	findAnyTypes: vi.fn(() => []),
}));

vi.mock("./test-classifier.js", () => ({
	isLikelyTestFile: vi.fn(() => false),
}));

vi.mock("./test-dispatchers.js", () => ({
	TEST_DISPATCHERS: {},
}));

// --- typed handles to the mocks -------------------------------------------

import { configNameToToolId, getOrCreateEngine } from "../check-engine/index.js";
import { parseNpmAuditJson, parseOsvScannerJson } from "../check-engine/output-parsers.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { isTestFile } from "../checks/shared.js";
import { getProfileForFile } from "../language-profiles.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { resolveDependencyAuditCommandAsync } from "./dependency-audit.js";
import { findAnyTypes } from "./strong-typing.js";
import { isLikelyTestFile } from "./test-classifier.js";
import { TEST_DISPATCHERS } from "./test-dispatchers.js";

const mockRunProcessAsync = vi.mocked(runProcessAsync);
const mockTryHeavyProcess = vi.mocked(tryAcquireProjectHeavyProcessLease);
const mockReleaseHeavyProcess = vi.fn();
const mockConfigNameToToolId = vi.mocked(configNameToToolId);
const mockGetOrCreateEngine = vi.mocked(getOrCreateEngine);
const mockParseNpmAuditJson = vi.mocked(parseNpmAuditJson);
const mockParseOsvScannerJson = vi.mocked(parseOsvScannerJson);
const mockIsTestFile = vi.mocked(isTestFile);
const mockGetProfileForFile = vi.mocked(getProfileForFile);
const mockResolveDependencyAuditCommand = vi.mocked(resolveDependencyAuditCommandAsync);
const mockFindAnyTypes = vi.mocked(findAnyTypes);
const mockIsLikelyTestFile = vi.mocked(isLikelyTestFile);

// --- shared fixtures --------------------------------------------------------

const baseEvent: HarnessEvent = {
	hook_event: "PostToolUse",
	session_id: "s1",
	agent_source: "claude",
	tool_name: "Write",
	timestamp: "2026-06-01T00:00:00Z",
};

function cfg(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 1000,
		severity: "warning",
		...over,
	};
}

function makeCtx(over: Partial<ToolCheckLoopContext> = {}): ToolCheckLoopContext {
	return {
		event: { ...baseEvent, tool_input: { file_path: "src/x.ts", content: "ok" } },
		checks: {},
		cwd: "/cwd",
		filePath: "src/x.ts",
		absForTestCheck: "/cwd/src/x.ts",
		testCheckBaseName: "x",
		getSharedContent: () => "const ok = 1;",
		getAfterRefs: () => [],
		tscFilterFile: undefined,
		baseline: undefined,
		outToolMetrics: undefined,
		editedFileInRepo: undefined,
		onCheckBoundary: undefined,
		...over,
	};
}

function engineReturning(report: LoopReportFixture) {
	const runChecksAsync = vi.fn<CheckEngine["runChecksAsync"]>().mockResolvedValue(loopReport(report));
	mockGetOrCreateEngine.mockReturnValue(loopEngine(runChecksAsync));
	return runChecksAsync;
}

function processResult(over: Partial<Awaited<ReturnType<typeof runProcessAsync>>> = {}) {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		timedOut: false,
		killed: false,
		...over,
	};
}

const auditCtx = (over: Partial<ToolCheckLoopContext> = {}) =>
	makeCtx({
		filePath: "package.json",
		absForTestCheck: "/cwd/package.json",
		testCheckBaseName: "package",
		checks: { dependency_audit: cfg({ file_types: [".json"] }) },
		...over,
	});

beforeEach(() => {
	mockRunProcessAsync.mockReset().mockResolvedValue(processResult());
	mockReleaseHeavyProcess.mockReset();
	mockTryHeavyProcess.mockReset().mockReturnValue(mockReleaseHeavyProcess);
	mockConfigNameToToolId.mockReset();
	mockGetOrCreateEngine.mockReset();
	mockParseNpmAuditJson.mockReset();
	mockParseOsvScannerJson.mockReset();
	mockIsTestFile.mockReset().mockReturnValue(false);
	mockGetProfileForFile.mockReset().mockReturnValue(null);
	mockResolveDependencyAuditCommand.mockReset();
	mockFindAnyTypes.mockReset().mockReturnValue([]);
	mockIsLikelyTestFile.mockReset().mockReturnValue(false);
	for (const k of Object.keys(TEST_DISPATCHERS)) {
		Reflect.deleteProperty(TEST_DISPATCHERS, k);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tool-check-loop — mutation-kill wave 30", () => {
	// test-contract: kill fe82c2dc24cfe2b1 (ArrayDeclaration `parts: string[] = []` → ["Stryker was here"])
	it("strong_typing: exact message for an any-only finding (no leaked prefix)", async () => {
		mockFindAnyTypes.mockReturnValue([{ kind: "any", line: 3, text: "x: any" }]);
		const out = await runToolCheckLoop(makeCtx({ checks: { strong_typing: cfg() } }));
		expect(out[0]?.message).toBe(
			"1 `any` type(s) in src/x.ts — prefer strong types (interfaces, generics, branded types)",
		);
	});

	// test-contract: kill 38d43550a7e3fcf4 (`!resolved` → false) — real skip is a true
	// loop `continue`, so the trailing inline_<name> boundary must NOT fire.
	it("dependency_audit: resolver-null skip is a true continue (boundary not fired)", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue(null);
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			auditCtx({ onCheckBoundary: (n) => boundaries.push(n) }),
		);
		expect(out).toEqual([]);
		expect(boundaries).not.toContain("inline_dependency_audit");
		expect(mockReleaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	// test-contract: invariant — dependency audits run asynchronously with project-root isolation and the configured timeout
	// The async path has no stdio-buffering child_process call on the daemon
	// event loop. It resolves and runs against the project root while holding
	// the cross-process project lease.
	it("dependency_audit: async runner gets the exact command, cwd, and timeout", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		await runToolCheckLoop(auditCtx());
		expect(mockTryHeavyProcess).toHaveBeenCalledWith("/proj");
		expect(mockRunProcessAsync).toHaveBeenCalledWith(
			"npm",
			["audit", "--json"],
			expect.objectContaining({ cwd: "/proj", timeout: 1000 }),
		);
		expect(mockReleaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — an unavailable audit runner yields an explicit no-verdict result instead of appearing clean
	// An unavailable runner is UNKNOWN. It must surface a no-verdict finding,
	// never the old empty-array shape that consumers could read as clean.
	it("dependency_audit: unavailable runner is deferred, not clean", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockRunProcessAsync.mockResolvedValue(processResult({ code: null }));
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.name).toBe("external_check_deferred");
		expect(out[0]?.detail).toContain("unavailable");
	});

	// test-contract: public-api — a parseable nonzero npm-audit report exposes its vulnerability detail to callers
	it("dependency_audit: nonzero result with a parseable report produces a finding", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockRunProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "{}" }));
		mockParseNpmAuditJson.mockReturnValue(loopAudit("3 high"));
		const out = await runToolCheckLoop(auditCtx());
		expect(out).toHaveLength(1);
		expect(out[0]?.detail).toBe("3 high");
	});

	// test-contract: kill 8afe3ca919d16b9f (`.trim()` dropped) and
	// 6d1c07f8bf0f47b5 (`||` → `&&`) — both change what gets handed to the parser.
	it("dependency_audit: stdout is trimmed before parsing", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockRunProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "  hello  " }));
		mockParseNpmAuditJson.mockReturnValue(loopAudit("d"));
		await runToolCheckLoop(auditCtx());
		expect(mockParseNpmAuditJson).toHaveBeenCalledWith("hello");
	});

	// test-contract: boundary — unparseable npm-audit output cannot be represented as a vulnerability verdict
	it("dependency_audit: npm-audit null summary is explicit no-verdict", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["npm", "audit", "--json"],
			parser: "npm-audit",
		});
		mockRunProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "{}" }));
		mockParseNpmAuditJson.mockReturnValue(null);
		const out = await runToolCheckLoop(auditCtx());
		expect(out[0]?.name).toBe("external_check_deferred");
		expect(out[0]?.detail).toContain("without a parseable report");
	});

	// test-contract: boundary — unparseable osv-scanner output cannot be represented as a vulnerability verdict
	it("dependency_audit: osv-scanner null summary is explicit no-verdict", async () => {
		mockResolveDependencyAuditCommand.mockResolvedValue({
			cmd: ["osv-scanner", "scan"],
			parser: "osv-scanner",
		});
		mockRunProcessAsync.mockResolvedValue(processResult({ code: 1, stdout: "garbage" }));
		mockParseOsvScannerJson.mockReturnValue(null);
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			auditCtx({ onCheckBoundary: (n) => boundaries.push(n) }),
		);
		expect(out[0]?.name).toBe("external_check_deferred");
		expect(boundaries).toContain("deferred_dependency_audit");
		expect(boundaries).not.toContain("inline_dependency_audit");
	});

	// test-contract: kill 61446d11322a3870 (+1→-1), 397d069ae4501984 (slice→absPath),
	// a5a69b90d4636fc0 (end→true), 81eaff1e6aa2d666 (end→false),
	// 2a40b4f80e20f2fb (unary -→+), b892a27d59ea5ab2 (||→&&) — all six change
	// the basename passed to isLikelyTestFile away from the correct "feature".
	it("affected_tests: baseForTests strips exactly the extension", async () => {
		mockGetProfileForFile.mockReturnValue(loopProfile("typescript"));
		mockIsLikelyTestFile.mockReturnValue(false);
		const dispatcher = vi.fn().mockReturnValue([]);
		TEST_DISPATCHERS.typescript = dispatcher;
		await runToolCheckLoop(
			makeCtx({ filePath: "src/feature.ts", cwd: "/cwd", checks: { affected_tests: cfg() } }),
		);
		expect(mockIsLikelyTestFile).toHaveBeenCalledWith("feature", "/cwd/src/feature.ts");
	});

	// test-contract: kill 30c8463e998b6529 (`!profile` → false) — real no-profile
	// skip is a true continue (boundary not fired).
	it("affected_tests: no-profile skip is a true continue", async () => {
		mockGetProfileForFile.mockReturnValue(null);
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			makeCtx({ checks: { affected_tests: cfg() }, onCheckBoundary: (n) => boundaries.push(n) }),
		);
		expect(out).toEqual([]);
		expect(boundaries).not.toContain("inline_affected_tests");
	});

	// test-contract: kill 76953ebf1b8662bf (`!dispatcher` → false) — real
	// no-dispatcher skip is a true continue (boundary not fired).
	it("affected_tests: no-dispatcher skip is a true continue", async () => {
		mockGetProfileForFile.mockReturnValue(loopProfile("python"));
		mockIsLikelyTestFile.mockReturnValue(false);
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			makeCtx({ checks: { affected_tests: cfg() }, onCheckBoundary: (n) => boundaries.push(n) }),
		);
		expect(out).toEqual([]);
		expect(boundaries).not.toContain("inline_affected_tests");
	});

	// test-contract: kill b978d218609438ce (`!== undefined` → false) and
	// 645b8670d03c5793 (!==→===) — a defined max_dependent_tests must reach
	// the dispatcher.
	it("affected_tests: a defined max_dependent_tests is forwarded to the dispatcher", async () => {
		mockGetProfileForFile.mockReturnValue(loopProfile("typescript"));
		mockIsLikelyTestFile.mockReturnValue(false);
		const dispatcher = vi.fn().mockReturnValue([]);
		TEST_DISPATCHERS.typescript = dispatcher;
		await runToolCheckLoop(makeCtx({ checks: { affected_tests: cfg({ max_dependent_tests: 5 }) } }));
		const arg = dispatcher.mock.calls[0]?.[0];
		expect(arg).toMatchObject({ maxDependentTests: 5 });
	});

	// test-contract: kill d1c8154f42f9d72f (`!== undefined` → true) — an
	// undefined max_dependent_tests must NOT appear as a key at all.
	it("affected_tests: an undefined max_dependent_tests is omitted from the dispatcher call", async () => {
		mockGetProfileForFile.mockReturnValue(loopProfile("typescript"));
		mockIsLikelyTestFile.mockReturnValue(false);
		const dispatcher = vi.fn().mockReturnValue([]);
		TEST_DISPATCHERS.typescript = dispatcher;
		await runToolCheckLoop(makeCtx({ checks: { affected_tests: cfg() } }));
		const arg = dispatcher.mock.calls[0]?.[0];
		expect("maxDependentTests" in arg).toBe(false);
	});

	// test-contract: kill 3e5bffbe17ebc817 (`name === "typescript"` → true) —
	// a non-typescript command check must ignore tscFilterFile entirely.
	it("command branch: a non-typescript check ignores tscFilterFile for targetFile", async () => {
		mockConfigNameToToolId.mockReturnValue("biome");
		const run = engineReturning({ results: [] });
		await runToolCheckLoop(
			makeCtx({
				checks: { biome: cfg({ command: "biome" }) },
				editedFileInRepo: true,
				tscFilterFile: "sub/only.ts",
			}),
		);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ targetFile: "src/x.ts" }),
			expect.anything(),
		);
	});

	// test-contract: kill 2b24fb4ad780801f (`ctx.outToolMetrics` → true) — when
	// outToolMetrics is undefined the metrics loop must not run (it would throw
	// on `.push` of undefined, swallowing the real finding).
	it("command branch: engine findings survive when outToolMetrics is undefined", async () => {
		mockConfigNameToToolId.mockReturnValue("biome");
		engineReturning({
			results: [{ file: "src/x.ts", line: 1, message: "m" }],
			metrics: [{ tool: "biome", elapsedMs: 5, findingCount: 1 }],
		});
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out).toHaveLength(1);
	});

	// test-contract: kill 1ab6c2b0e8c62540 (`> 15` → `>= 15`) — exactly 15
	// results must not append an overflow suffix.
	it("command branch: exactly 15 engine results has no overflow suffix", async () => {
		mockConfigNameToToolId.mockReturnValue("biome");
		const results = Array.from({ length: 15 }, (_v, i) => ({
			file: "src/x.ts",
			line: i,
			message: `m${i}`,
		}));
		engineReturning({ results });
		const out = await runToolCheckLoop(
			makeCtx({ checks: { biome: cfg({ command: "biome" }) }, editedFileInRepo: true }),
		);
		expect(out[0]?.detail).not.toContain("more)");
	});

	// test-contract: kill b4cfc1db92b1487c (`check.command` → true) — an
	// unknown check with no handler and no command falls through to
	// `outcome = []`, a true not-null branch, so the boundary DOES fire.
	it("unknown check with no command falls through to outcome=[] (boundary fires)", async () => {
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { some_unknown_inline_check: cfg() },
				editedFileInRepo: true,
				onCheckBoundary: (n) => boundaries.push(n),
			}),
		);
		expect(out).toEqual([]);
		expect(boundaries).toContain("inline_some_unknown_inline_check");
	});

	// test-contract: kill 0af89a8d11778d1d (`editedFileInRepo === false && check.command` → false)
	it("an out-of-repo command check truly skips the engine", async () => {
		mockConfigNameToToolId.mockReturnValue("tsc");
		const run = engineReturning({ results: [] });
		const out = await runToolCheckLoop(
			makeCtx({ checks: { typescript: cfg({ command: "tsc" }) }, editedFileInRepo: false }),
		);
		expect(out).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});

	it("a ChangeSet batch skips subprocess branches but keeps cheap per-file checks", async () => {
		mockConfigNameToToolId.mockReturnValue("tsc");
		const run = engineReturning({ results: [] });
		const checksRan: string[] = [];
		const out = await runToolCheckLoop(
			makeCtx({
				checks: {
					typescript: cfg({ command: "tsc" }),
					affected_tests: cfg(),
					secrets_in_source: cfg(),
				},
				skipMultiFileExternalChecks: true,
				outChecksRan: checksRan,
			}),
		);
		expect(run).not.toHaveBeenCalled();
		expect(out).toEqual([]);
		expect(checksRan).toEqual(["secrets_in_source"]);
	});

	// test-contract: kill 7a707b609b6f3a5d (`outcome === null` → false) — a
	// real handler-returned-null skip is a true continue (boundary not fired).
	it("secrets_in_source test-file skip is a true continue", async () => {
		mockIsTestFile.mockReturnValue(true);
		const boundaries: string[] = [];
		const out = await runToolCheckLoop(
			makeCtx({
				checks: { secrets_in_source: cfg() },
				onCheckBoundary: (n) => boundaries.push(n),
			}),
		);
		expect(out).toEqual([]);
		expect(boundaries).not.toContain("inline_secrets_in_source");
	});
});
