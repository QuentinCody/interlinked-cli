import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QualityCheckConfig } from "../types.js";
import { resetFindingDeltaStore } from "./finding-delta.js";

const {
	runChecksAsync,
	tryAcquireHeavyProcess,
	releaseHeavyProcess,
	getProfileForFile,
	runBoundedTestProcess,
	resolveDependencyAuditCommandAsync,
	runProcessAsync,
} = vi.hoisted(() => ({
	runChecksAsync: vi.fn(),
	tryAcquireHeavyProcess: vi.fn(),
	releaseHeavyProcess: vi.fn(),
	getProfileForFile: vi.fn(),
	runBoundedTestProcess: vi.fn(),
	resolveDependencyAuditCommandAsync: vi.fn(),
	runProcessAsync: vi.fn(),
}));

vi.mock("../check-engine/index.js", () => ({
	configNameToToolId: (name: string) =>
		({
			typescript: "tsc",
			biome_lint: "biome",
			eslint: "eslint",
			oxlint: "oxlint",
			semgrep: "semgrep",
			gitleaks: "gitleaks",
			mypy: "mypy",
			ruff: "ruff",
		}[name]),
	getOrCreateEngine: () => ({ runChecksAsync }),
}));

vi.mock("../project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: tryAcquireHeavyProcess,
}));

vi.mock("../language-profiles.js", () => ({
	getProfileForFile,
	findProjectRootForLanguage: () => "/repo",
}));
vi.mock("./test-process-gate.js", () => ({ runBoundedTestProcess }));
vi.mock("./dependency-audit.js", () => ({ resolveDependencyAuditCommandAsync }));
vi.mock("../check-engine/spawn-async.js", () => ({ runProcessAsync }));

import { createChangeSetExternalBatch } from "./change-set-external.js";

function config(
	severity: QualityCheckConfig["severity"] = "warning",
): QualityCheckConfig {
	return {
		enabled: true,
		command: "external-tool",
		file_types: [".ts"],
		timeout_ms: 5_000,
		severity,
	};
}

function namedConfig(
	severity: QualityCheckConfig["severity"] = "warning",
): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 5_000,
		severity,
	};
}

function manifestConfig(): QualityCheckConfig {
	return {
		enabled: true,
		file_types: ["package.json", "package-lock.json"],
		timeout_ms: 5_000,
		severity: "error",
		use_osv_scanner: false,
	};
}

function completedReport() {
	return {
		results: [
			{
				tool: "tsc",
				severity: "error",
				file: "src/a.ts",
				line: 4,
				message: "TS2304: missing",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "src/b.ts",
				line: 7,
				message: "lint issue",
			},
		],
		toolsRun: [
			{ id: "tsc", available: true },
			{ id: "biome", available: true },
			{ id: "gitleaks", available: true },
		],
		toolsSkipped: [],
		skipped: [],
		elapsedMs: 12,
		metrics: [
			{ tool: "tsc", elapsedMs: 8, findingCount: 1, cacheHit: false },
			{ tool: "biome", elapsedMs: 3, findingCount: 1, cacheHit: false },
			{ tool: "gitleaks", elapsedMs: 1, findingCount: 0, cacheHit: false },
		],
		deduplicatedCount: 0,
	};
}

beforeEach(() => {
	runChecksAsync.mockReset();
	tryAcquireHeavyProcess.mockReset();
	releaseHeavyProcess.mockReset();
	tryAcquireHeavyProcess.mockReturnValue(releaseHeavyProcess);
	getProfileForFile.mockReset();
	getProfileForFile.mockReturnValue({
		id: "typescript",
		test_runner: { command: "npx vitest run" },
	});
	runBoundedTestProcess.mockReset();
	runBoundedTestProcess.mockResolvedValue({
		kind: "completed",
		code: 0,
		stdout: "",
		stderr: "",
	});
	resolveDependencyAuditCommandAsync.mockReset();
	resolveDependencyAuditCommandAsync.mockResolvedValue({
		cmd: ["npm", "audit", "--json", "--audit-level=moderate"],
		parser: "npm-audit",
	});
	runProcessAsync.mockReset();
	runProcessAsync.mockResolvedValue({
		code: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		killed: false,
	});
	resetFindingDeltaStore();
});

describe("ChangeSet external-check batching", () => {
	it("runs TypeScript, lint, and security tools once and attributes findings per file", async () => {
		runChecksAsync.mockResolvedValue(completedReport());
		const checksRan: string[] = [];
		const metrics: Array<{ tool: string; ms: number; finding_count: number }> = [];
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: {
				typescript: config("error"),
				biome_lint: config(),
				gitleaks: config("error"),
			},
			cwd: "/repo",
			outChecksRan: checksRan,
			outToolMetrics: metrics,
		});

		const [aResults, bResults, aAgain] = await Promise.all([
			batch.resultsForFile("/repo/src/a.ts"),
			batch.resultsForFile("/repo/src/b.ts"),
			batch.resultsForFile("/repo/src/a.ts"),
		]);

		expect(runChecksAsync).toHaveBeenCalledTimes(1);
		expect(runChecksAsync).toHaveBeenCalledWith(
			{ projectRoot: "/repo", mode: "project" },
			expect.objectContaining({
				tools: ["tsc", "biome", "gitleaks"],
				admissionAlreadyHeld: true,
			}),
		);
		expect(tryAcquireHeavyProcess).toHaveBeenCalledTimes(1);
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
		expect(aResults.map((result) => [result.name, result.file])).toEqual([
			["typescript", "/repo/src/a.ts"],
		]);
		expect(bResults.map((result) => [result.name, result.file])).toEqual([
			["biome_lint", "/repo/src/b.ts"],
		]);
		expect(aAgain).toEqual(aResults);
		expect(checksRan).toEqual(["typescript", "biome_lint", "gitleaks"]);
		expect(metrics).toHaveLength(3);
	});

	it("emits one NOT-CHECKED result when capacity and bounded adapters prevent verdicts", async () => {
		tryAcquireHeavyProcess.mockReturnValue(null);
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: {
				typescript: config("error"),
				biome_lint: config(),
				affected_tests: namedConfig("error"),
			},
			cwd: "/repo",
		});

		const aResults = await batch.resultsForFile("/repo/src/a.ts");
		const bResults = await batch.resultsForFile("/repo/src/b.ts");
		const all = [...aResults, ...bResults];

		expect(runChecksAsync).not.toHaveBeenCalled();
		expect(runBoundedTestProcess).not.toHaveBeenCalled();
		expect(releaseHeavyProcess).not.toHaveBeenCalled();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			name: "external_check_deferred",
			file: "/repo/src/a.ts",
		});
		expect(all[0]?.message).toContain("2 changed files");
		expect(all[0]?.detail).toContain("affected_tests");
		expect(all[0]?.detail).toContain("external-tool capacity is busy");
	});

	it("runs one unioned affected-test process for every changed TypeScript source", async () => {
		const checksRan: string[] = [];
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: { affected_tests: namedConfig("error") },
			cwd: "/repo",
			outChecksRan: checksRan,
		});

		expect(await batch.resultsForFile("/repo/src/a.ts")).toEqual([]);
		expect(await batch.resultsForFile("/repo/src/b.ts")).toEqual([]);

		expect(runChecksAsync).not.toHaveBeenCalled();
		expect(runBoundedTestProcess).toHaveBeenCalledTimes(1);
		expect(runBoundedTestProcess).toHaveBeenCalledWith({
			command: "npx",
			args: [
				"vitest",
				"related",
				"/repo/src/a.ts",
				"/repo/src/b.ts",
				"--run",
				"--reporter=verbose",
			],
			cwd: "/repo",
			timeoutMs: 5_000,
			admissionAlreadyHeld: true,
		});
		expect(checksRan).toEqual(["affected_tests"]);
		expect(tryAcquireHeavyProcess).toHaveBeenCalledTimes(1);
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	it("defers one explicit verdict for a mixed-language affected-test ChangeSet", async () => {
		getProfileForFile.mockImplementation((path: string) =>
			path.endsWith(".py")
				? { id: "python", test_runner: { command: "pytest" } }
				: { id: "typescript", test_runner: { command: "npx vitest run" } },
		);
		const mixed = { ...namedConfig("error"), file_types: [".ts", ".py"] };
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.py"],
			checks: { affected_tests: mixed },
			cwd: "/repo",
		});

		const all = [
			...(await batch.resultsForFile("/repo/src/a.ts")),
			...(await batch.resultsForFile("/repo/src/b.py")),
		];
		expect(all).toHaveLength(1);
		expect(all[0]?.name).toBe("external_check_deferred");
		expect(all[0]?.detail).toContain("mixed-language ChangeSets");
		expect(runBoundedTestProcess).not.toHaveBeenCalled();
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	it("runs one dependency audit for a same-ecosystem ChangeSet", async () => {
		const checksRan: string[] = [];
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/package.json", "/repo/package-lock.json"],
			checks: { dependency_audit: manifestConfig() },
			cwd: "/repo",
			outChecksRan: checksRan,
		});

		expect(await batch.resultsForFile("/repo/package.json")).toEqual([]);
		expect(await batch.resultsForFile("/repo/package-lock.json")).toEqual([]);

		expect(resolveDependencyAuditCommandAsync).toHaveBeenCalledTimes(1);
		expect(runProcessAsync).toHaveBeenCalledTimes(1);
		expect(runProcessAsync).toHaveBeenCalledWith(
			"npm",
			["audit", "--json", "--audit-level=moderate"],
			{ cwd: "/repo", timeout: 5_000 },
		);
		expect(checksRan).toEqual(["dependency_audit"]);
		expect(tryAcquireHeavyProcess).toHaveBeenCalledTimes(1);
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
	});

	it("holds one request lease across engine, audit, and unioned-test work", async () => {
		runChecksAsync.mockResolvedValue(completedReport());
		const paths = [
			"/repo/src/a.ts",
			"/repo/src/b.ts",
			"/repo/package.json",
			"/repo/package-lock.json",
		];
		const batch = createChangeSetExternalBatch({
			paths,
			checks: {
				typescript: config("error"),
				biome_lint: config(),
				dependency_audit: manifestConfig(),
				affected_tests: namedConfig("error"),
			},
			cwd: "/repo",
		});

		await Promise.all(paths.map((path) => batch.resultsForFile(path)));

		expect(tryAcquireHeavyProcess).toHaveBeenCalledTimes(1);
		expect(runChecksAsync).toHaveBeenCalledTimes(1);
		expect(runProcessAsync).toHaveBeenCalledTimes(1);
		expect(runBoundedTestProcess).toHaveBeenCalledTimes(1);
		expect(releaseHeavyProcess).toHaveBeenCalledTimes(1);
		expect(releaseHeavyProcess.mock.invocationCallOrder[0]).toBeGreaterThan(
			runBoundedTestProcess.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("defers one aggregate result before spawning when the ChangeSet exceeds the path cap", async () => {
		const paths = Array.from({ length: 33 }, (_, index) => `/repo/src/f${index}.ts`);
		const batch = createChangeSetExternalBatch({
			paths,
			checks: { typescript: config("error"), affected_tests: namedConfig() },
			cwd: "/repo",
		});

		const all = (await Promise.all(paths.map((path) => batch.resultsForFile(path)))).flat();
		expect(all).toHaveLength(1);
		expect(all[0]?.name).toBe("external_check_deferred");
		expect(all[0]?.detail).toContain("cap 32");
		expect(tryAcquireHeavyProcess).not.toHaveBeenCalled();
		expect(runChecksAsync).not.toHaveBeenCalled();
		expect(runBoundedTestProcess).not.toHaveBeenCalled();
	});

	it("defers one aggregate result before spawning when requested work exceeds the tool cap", async () => {
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: {
				typescript: config(),
				biome_lint: config(),
				eslint: config(),
				oxlint: config(),
				semgrep: config(),
				gitleaks: config(),
				mypy: config(),
				ruff: config(),
				affected_tests: namedConfig(),
			},
			cwd: "/repo",
		});

		const all = [
			...(await batch.resultsForFile("/repo/src/a.ts")),
			...(await batch.resultsForFile("/repo/src/b.ts")),
		];
		expect(all).toHaveLength(1);
		expect(all[0]?.detail).toContain("9 project tools requested (cap 8)");
		expect(tryAcquireHeavyProcess).not.toHaveBeenCalled();
		expect(runChecksAsync).not.toHaveBeenCalled();
	});

	it("attributes project findings only to exact normalized touched paths", async () => {
		const report = completedReport();
		report.results = [
			{
				tool: "biome",
				severity: "warning",
				file: "src/a.ts",
				line: 1,
				message: "owned",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "src/a.ts.evil",
				line: 2,
				message: "prefix look-alike",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "../outside/src/a.ts",
				line: 3,
				message: "outside",
			},
		];
		runChecksAsync.mockResolvedValue(report);
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: { biome_lint: config() },
			cwd: "/repo",
		});

		const a = await batch.resultsForFile("/repo/src/a.ts");
		const b = await batch.resultsForFile("/repo/src/b.ts");
		expect(a).toHaveLength(1);
		expect(a[0]?.detail).toContain("owned");
		expect(a[0]?.detail).not.toContain("look-alike");
		expect(a[0]?.detail).not.toContain("outside");
		expect(b).toEqual([]);
	});

	it("never substitutes previous-run state for an existing file's pre-edit TypeScript baseline", async () => {
		runChecksAsync.mockResolvedValue(completedReport());
		const existing = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			checks: { typescript: config("error") },
			cwd: "/repo",
		});
		const existingResult = (await existing.resultsForFile("/repo/src/a.ts"))[0];
		expect(existingResult).toMatchObject({ severity: "warning" });
		expect(existingResult?.message).toContain("no per-file pre-edit compiler baseline");

		const created = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
			newFilePaths: ["/repo/src/a.ts"],
			checks: { typescript: config("error") },
			cwd: "/repo",
		});
		const createdResult = (await created.resultsForFile("/repo/src/a.ts"))[0];
		expect(createdResult).toMatchObject({ severity: "error" });
		expect(createdResult?.message).toContain("newly-created");
	});
});
