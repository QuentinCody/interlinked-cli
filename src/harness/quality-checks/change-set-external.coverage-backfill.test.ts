// ===========================================
// ChangeSet external-check batch — coverage backfill
// ===========================================
// Sibling to `change-set-external.test.ts` (kept separate because that file
// is already over the repo's companion-file size guidance). Pins the sites
// the main suite never reaches: the "timeout"/"error" skip categories in
// `unavailableReason`, the `findProjectRoot(...) || options.cwd` fallback
// used by both `retainAffectedChanges` and `runBatch`, `evidenceForFile`,
// and the `results.get(filePath) ?? []` miss path in `resultsForFile`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QualityCheckConfig } from "../types.js";
import { resetFindingDeltaStore } from "./finding-delta.js";

const {
	runChecksAsync,
	tryAcquireHeavyProcess,
	acquireHeavyProcess,
	releaseHeavyProcess,
	getProfileForFile,
	findProjectRootForLanguage,
	scheduleTests,
	resolveDependencyAuditCommandAsync,
	runProcessAsync,
} = vi.hoisted(() => ({
	runChecksAsync: vi.fn(),
	tryAcquireHeavyProcess: vi.fn(),
	acquireHeavyProcess: vi.fn(),
	releaseHeavyProcess: vi.fn(),
	getProfileForFile: vi.fn(),
	findProjectRootForLanguage: vi.fn(),
	scheduleTests: vi.fn(),
	resolveDependencyAuditCommandAsync: vi.fn(),
	runProcessAsync: vi.fn(),
}));

vi.mock("../check-engine/index.js", () => ({
	configNameToToolId: (name: string) =>
		({
			typescript: "tsc",
			biome_lint: "biome",
			eslint: "eslint",
		}[name]),
	getOrCreateEngine: () => ({ runChecksAsync }),
}));

vi.mock("../project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: tryAcquireHeavyProcess,
	acquireProjectHeavyProcessLease: acquireHeavyProcess,
}));

vi.mock("../language-profiles.js", () => ({
	getProfileForFile,
	findProjectRootForLanguage,
}));
vi.mock("../test-scheduler.js", () => ({ scheduleTests }));
vi.mock("../test-requests.js", () => ({ requestTests: vi.fn() }));
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
			{ tool: "tsc", severity: "error", file: "src/a.ts", line: 4, message: "TS2304: missing" },
		],
		toolsRun: [{ id: "tsc", available: true }],
		toolsSkipped: [],
		skipped: [],
		elapsedMs: 12,
		metrics: [{ tool: "tsc", elapsedMs: 8, findingCount: 1, cacheHit: false }],
		deduplicatedCount: 0,
	};
}

beforeEach(() => {
	acquireHeavyProcess.mockReset().mockResolvedValue(releaseHeavyProcess);
	runChecksAsync.mockReset();
	tryAcquireHeavyProcess.mockReset();
	releaseHeavyProcess.mockReset();
	tryAcquireHeavyProcess.mockReturnValue(releaseHeavyProcess);
	getProfileForFile.mockReset();
	getProfileForFile.mockReturnValue({ id: "typescript", test_runner: { command: "npx vitest run" } });
	findProjectRootForLanguage.mockReset();
	findProjectRootForLanguage.mockReturnValue("/repo");
	scheduleTests.mockReset();
	scheduleTests.mockResolvedValue({ status: "passed", durationMs: 12, output: "" });
	resolveDependencyAuditCommandAsync.mockReset();
	resolveDependencyAuditCommandAsync.mockResolvedValue({
		cmd: ["npm", "audit", "--json", "--audit-level=moderate"],
		parser: "npm-audit",
	});
	runProcessAsync.mockReset();
	runProcessAsync.mockResolvedValue({ code: 0, stdout: "", stderr: "", timedOut: false, killed: false });
	resetFindingDeltaStore();
});

describe("ChangeSet external-check batching — unavailableReason skip categories", () => {
	it("defers a candidate the engine skipped for a timeout", async () => {
		runChecksAsync.mockResolvedValue({
			results: [],
			skipped: [{ check: "tsc", category: "timeout", reason: "tsc exceeded its budget" }],
			toolsRun: [],
			toolsSkipped: [],
			elapsedMs: 3,
			metrics: [],
			deduplicatedCount: 0,
		});
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts"],
			checks: { typescript: config("error") },
			cwd: "/repo",
		});
		const results = await batch.resultsForFile("/repo/src/a.ts");
		const deferred = results.find((result) => result.name === "external_check_deferred");
		expect(deferred?.detail).toContain("typescript: tsc exceeded its budget");
	});

	it("defers a candidate the engine skipped with an internal error", async () => {
		runChecksAsync.mockResolvedValue({
			results: [],
			skipped: [{ check: "tsc", category: "error", reason: "tsc crashed" }],
			toolsRun: [],
			toolsSkipped: [],
			elapsedMs: 3,
			metrics: [],
			deduplicatedCount: 0,
		});
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts"],
			checks: { typescript: config("error") },
			cwd: "/repo",
		});
		const results = await batch.resultsForFile("/repo/src/a.ts");
		const deferred = results.find((result) => result.name === "external_check_deferred");
		expect(deferred?.detail).toContain("typescript: tsc crashed");
	});
});

describe("ChangeSet external-check batching — findProjectRoot fallback", () => {
	it("falls back to the batch cwd for every project-root lookup when no profile or marker file resolves one", async () => {
		// No profile match (getProfileForFile returns undefined) and a
		// nonexistent cwd ("/repo") means the tsconfig/package.json disk walk
		// inside `findProjectRoot` also comes up empty, so `findProjectRoot`
		// itself returns null and every call site falls back to `options.cwd`
		// (retainAffectedChanges, and both call sites inside runBatch).
		getProfileForFile.mockReturnValue(undefined);
		runChecksAsync.mockResolvedValue(completedReport());
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts"],
			checks: { typescript: config("error"), affected_tests: namedConfig("error") },
			cwd: "/repo",
		});
		const results = await batch.resultsForFile("/repo/src/a.ts");
		expect(results.some((row) => row.name === "typescript")).toBe(true);
		expect(runChecksAsync).toHaveBeenCalledWith(
			{ projectRoot: "/repo", mode: "project" },
			expect.objectContaining({ tools: ["tsc"] }),
		);
	});
});

describe("ChangeSet external-check batching — evidenceForFile", () => {
	it("returns an issue-carrying evidence record when a batch input cannot be captured from disk", async () => {
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/package.json"],
			checks: { dependency_audit: manifestConfig() },
			cwd: "/repo",
		});
		const evidence = await batch.evidenceForFile("/repo/package.json");
		expect(evidence.checks).toEqual([]);
		expect(evidence.scopes).toEqual([]);
		expect(evidence.unavailable.length).toBeGreaterThan(0);
	});

	it("attributes the completed check name once a real batch input's captured identity is unchanged", async () => {
		// Evidence capture reads the file from disk (identity = sha256 +
		// stat), so this test uses this repo's own real, unmoving
		// `package.json` instead of a fabricated path.
		const realManifest = `${process.cwd()}/package.json`;
		const batch = createChangeSetExternalBatch({
			paths: [realManifest],
			checks: { dependency_audit: manifestConfig() },
			cwd: process.cwd(),
		});
		const evidence = await batch.evidenceForFile(realManifest);
		expect(evidence.checks).toEqual(["dependency_audit"]);
		expect(evidence.unavailable).toEqual([]);
	});
});

describe("ChangeSet external-check batching — resultsForFile on an untouched path", () => {
	it("returns an empty array for a file the ChangeSet never included", async () => {
		runChecksAsync.mockResolvedValue(completedReport());
		const batch = createChangeSetExternalBatch({
			paths: ["/repo/src/a.ts"],
			checks: { typescript: config("error") },
			cwd: "/repo",
		});
		expect(await batch.resultsForFile("/repo/src/never-requested.ts")).toEqual([]);
	});
});
