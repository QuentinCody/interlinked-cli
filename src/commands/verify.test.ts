// ===========================================
// Verify orchestrator — behavioral unit tests
// ===========================================
// These tests exercise `verifyCommand` / `runVerify` / `runVerifyBatchJson`
// in `./verify.ts` (the `interlinked verify` orchestrator) in isolation: every
// `./verify/*` subfile, the harness helpers it calls, and `node:fs` are mocked
// at the module boundary via `vi.mock`, so the assertions land on the
// orchestration/dispatch/exit logic that lives in `verify.ts` itself — not on
// the subfiles' behavior (those have their own companion tests).
//
// Integration-style coverage (real tsc/biome subprocesses over a temp dir)
// lives in `./__tests__/verify.test.ts`; this file is the fast branch sweep.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanProgress } from "./verify/scan-progress.js";

// Every mock is a plain `vi.fn()` referenced DIRECTLY by the module factory
// (no `(...a) => fn(...a)` wrapper). That keeps each export's identity equal to
// the spy — so `verify.ts`'s live `export { … } from "./verify/*"` re-exports
// resolve to the same function we assert against — and sidesteps the spread-
// into-fixed-arity typecheck error that arises from wrapper closures.

type Tally = { flaggedFiles: number; totalFiles: number; projectFindings: number };
type SuppEntry = { file: string; check: string; reason: string };
type ToolResult = { tool: string; file: string; message: string };

// --- node:fs ---------------------------------------------------------------
const existsSyncMock = vi.fn<(p: string) => boolean>(() => true);
const rmSyncMock = vi.fn<(p: string, opts?: unknown) => void>();
const statSyncMock = vi.fn<(p: string) => { isDirectory: () => boolean }>(() => ({
	isDirectory: () => true,
}));
vi.mock("node:fs", () => ({
	existsSync: existsSyncMock,
	rmSync: rmSyncMock,
	statSync: statSyncMock,
}));

// --- harness/check-engine --------------------------------------------------
const discoverToolsMock = vi.fn<() => unknown[]>(() => []);
const runChecksMock = vi.fn<(scope: unknown, opts: unknown) => { results: ToolResult[] }>(() => ({
	results: [],
}));
const runDepAuditMock = vi.fn<() => unknown>(() => ({ kind: "audit" }));
class FakeCheckEngine {
	constructor(public root: string) {}
	discoverTools = discoverToolsMock;
	runChecks = runChecksMock;
	runChecksAsync = (scope: unknown, options: unknown) => ({ toolsRun: [], ...runChecksMock(scope, options) });
	runDepAudit = runDepAuditMock;
}
const formatToolReportMock = vi.fn<(tools: unknown) => string>(() => "TOOL-REPORT");
vi.mock("./verify/lint-import.js", () => ({ streamImportedLint: vi.fn() }));
vi.mock("../harness/check-engine/index.js", () => ({
	CheckEngine: FakeCheckEngine,
	formatToolReport: formatToolReportMock,
}));

// --- harness/project-heavy-process-lock -----------------------------------
const releaseHeavyProcessMock = vi.fn<() => void>();
const tryAcquireProjectHeavyProcessLeaseMock = vi.fn<() => (() => void) | null>(
	() => releaseHeavyProcessMock,
);
vi.mock("../harness/project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: tryAcquireProjectHeavyProcessLeaseMock,
}));

// --- harness/quality-checks ------------------------------------------------
const detectDecisionSurfaceMock = vi.fn<(cwd: string) => unknown>(() => ({ ds: true }));
const detectLockfileMultiplicityMock = vi.fn<(cwd: string) => unknown>(() => ({ lm: true }));
vi.mock("../harness/quality-checks/decision-surface.js", () => ({
	detectDecisionSurface: detectDecisionSurfaceMock,
	detectLockfileMultiplicity: detectLockfileMultiplicityMock,
}));
const computeDecisionSurfaceRatchetMock = vi.fn<(cwd: string) => unknown>(() => ({ dsr: true }));
vi.mock("../harness/quality-checks/decision-surface-ratchet.js", () => ({
	computeDecisionSurfaceRatchet: computeDecisionSurfaceRatchetMock,
}));

// --- harness/registry-parity -----------------------------------------------
const runRegistryParityCheckMock = vi.fn<(cwd: string) => unknown[]>(() => []);
vi.mock("../harness/registry-parity.js", () => ({
	runRegistryParityCheck: runRegistryParityCheckMock,
}));

// --- harness/suppressions --------------------------------------------------
const addSuppressionsMock = vi.fn<(dir: string, entries: SuppEntry[]) => SuppEntry[]>(() => []);
const loadFileSuppressionsMock = vi.fn<(dir: string, file: string) => Set<string>>(
	() => new Set<string>(),
);
const loadSuppressionFileMock = vi.fn<
	(dir: string) => Record<string, Record<string, { reason?: string }>>
>(() => ({}));
const parseSuppressionEntryMock = vi.fn<(e: string) => SuppEntry | null>(() => ({
	file: "f",
	check: "c",
	reason: "",
}));
vi.mock("../harness/suppressions.js", () => ({
	addSuppressions: addSuppressionsMock,
	loadFileSuppressions: loadFileSuppressionsMock,
	loadSuppressionFile: loadSuppressionFileMock,
	parseSuppressionEntry: parseSuppressionEntryMock,
}));

// --- verify/advisory -------------------------------------------------------
const getEffectiveSkipChecksMock = vi.fn<
	(skip: string | undefined, all: boolean | undefined) => Set<string>
>(() => new Set<string>());
const getSkipToolsMock = vi.fn<(skip: Set<string>) => string[]>(() => []);
vi.mock("./verify/advisory.js", () => ({
	DEFAULT_ADVISORY_SKIPS: new Set<string>(),
	TOOL_IDS: ["tsc", "biome", "dep-audit"] as const,
}));
vi.mock("./verify/advisory-skips.js", () => ({
	getEffectiveSkipChecks: getEffectiveSkipChecksMock,
	getSkipTools: getSkipToolsMock,
}));

// --- verify/clone-repo -----------------------------------------------------
const cloneRepoMock = vi.fn<
	(url: string, opts: unknown) => { dir: string; elapsed_ms: number }
>(() => ({ dir: "/clone/dir", elapsed_ms: 1500 }));
const isGitUrlMock = vi.fn<(u: string) => boolean>(() => false);
const normalizeGitUrlMock = vi.fn<(u: string) => string>((u) => u);
const repoDisplayNameMock = vi.fn<(u: string) => string>((u) => `repo(${u})`);
vi.mock("./verify/clone-repo.js", () => ({
	cloneRepo: cloneRepoMock,
	isGitUrl: isGitUrlMock,
	normalizeGitUrl: normalizeGitUrlMock,
	repoDisplayName: repoDisplayNameMock,
}));

// --- verify/file-discovery -------------------------------------------------
const discoverFilesMock = vi.fn<(root: string) => string[]>(() => ["/p/a.ts", "/p/b.ts"]);
vi.mock("./verify/file-discovery.js", () => ({
	discoverFiles: discoverFilesMock,
	CODE_EXTENSIONS: new Set<string>(),
}));

// --- verify/output-json ----------------------------------------------------
const outputJsonMock = vi.fn<(args: Record<string, unknown>) => void>();
vi.mock("./verify/output-json.js", () => ({
	outputJson: outputJsonMock,
}));

// --- verify/streaming-output -----------------------------------------------
const setActiveSkipChecksMock = vi.fn<(s: Set<string>) => void>();
const streamAllCqSectionsMock = vi.fn<(cq: unknown, details: boolean, flagged: Set<string>) => void>();
vi.mock("./verify/streaming-output.js", () => ({
	setActiveSkipChecks: setActiveSkipChecksMock,
	streamAllCqSections: streamAllCqSectionsMock,
}));

// --- verify/structure ------------------------------------------------------
const buildStructureJsonSectionMock = vi.fn<(cwd: string, opts: unknown) => unknown>(() => ({
	structure: true,
}));
const runStructureVerifyMock = vi.fn<(cwd: string, opts: unknown) => Promise<void>>(
	async () => {},
);
vi.mock("./verify/structure.js", () => ({
	buildStructureJsonSection: buildStructureJsonSectionMock,
	runStructureVerify: runStructureVerifyMock,
}));

// --- verify/tool-results ---------------------------------------------------
const checkProjectSetupMock = vi.fn<(cwd: string) => unknown[]>(() => []);
const clearCodeQualityResultsMock = vi.fn<(r: unknown) => void>();
const filterCodeQualityResultsInPlaceMock = vi.fn<(r: unknown, s: Set<string>) => unknown>(
	(r) => r,
);
const runCodeQualityChecksProgressiveMock = vi.fn<
	(files: string[], cwd: string, progress: ScanProgress) => Promise<unknown>
>(async () => ({ undocumentedEnvVars: [] }));
const runSuggestionsMock = vi.fn<(args: unknown) => Map<string, unknown[]>>(() => new Map());
vi.mock("./verify/tool-results.js", () => ({
	checkProjectSetup: checkProjectSetupMock,
	clearCodeQualityResults: clearCodeQualityResultsMock,
	filterCodeQualityResultsInPlace: filterCodeQualityResultsInPlaceMock,
	runCodeQualityChecksProgressive: runCodeQualityChecksProgressiveMock,
	runSuggestions: runSuggestionsMock,
}));

// --- verify/verify-tools ---------------------------------------------------
const streamExternalToolsMock = vi.fn<(args: unknown) => Promise<void>>(async () => {});
vi.mock("./verify/verify-tools.js", () => ({
	streamExternalTools: streamExternalToolsMock,
}));

// --- verify/verify-summary -------------------------------------------------
const emitVerifyRunMock = vi.fn<(cwd: string, record: Record<string, unknown>) => void>();
const streamDecisionSurfaceRatchetMock = vi.fn<(r: unknown) => void>();
const streamLockfileMultiplicityMock = vi.fn<(r: unknown) => void>();
const streamProjectSetupMock = vi.fn<(cwd: string, flagged: Set<string>) => void>();
const streamRegistryParityMock = vi.fn<(cwd: string, flagged: Set<string>) => void>();
const streamCaseDivergenceMock =
	vi.fn<(cwd: string, files: readonly string[], flagged: Set<string>) => void>();
const streamSuggestionsSummaryMock = vi.fn<(files: string[], cwd: string) => void>();
const streamSupermodelDeadCodeMock = vi.fn<(cwd: string, opts: unknown, f: Set<string>) => void>();
const streamUndocumentedEnvVarsMock = vi.fn<(issues: unknown, f: Set<string>) => void>();
const summarizeFlaggedFilesMock = vi.fn<
	(cwd: string, files: readonly string[], flagged: Iterable<string>) => Tally
>(() => ({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 }));
vi.mock("./verify/verify-summary.js", () => ({
	emitVerifyRun: emitVerifyRunMock,
	streamDecisionSurfaceRatchet: streamDecisionSurfaceRatchetMock,
	streamLockfileMultiplicity: streamLockfileMultiplicityMock,
	streamProjectSetup: streamProjectSetupMock,
	streamRegistryParity: streamRegistryParityMock,
	streamCaseDivergence: streamCaseDivergenceMock,
	streamSuggestionsSummary: streamSuggestionsSummaryMock,
	streamSupermodelDeadCode: streamSupermodelDeadCodeMock,
	streamUndocumentedEnvVars: streamUndocumentedEnvVarsMock,
	summarizeFlaggedFiles: summarizeFlaggedFilesMock,
}));

// ---------------------------------------------------------------------------
// Test harness: capture stderr/stdout + exitCode, restore after each test.
// ---------------------------------------------------------------------------
let stderr: string;
let stdout: string;
let origErr: typeof process.stderr.write;
let origOut: typeof process.stdout.write;
let origExitCode: typeof process.exitCode;

beforeEach(() => {
	vi.clearAllMocks();
	// Re-seed default return values cleared by clearAllMocks.
	discoverToolsMock.mockReturnValue([]);
	runChecksMock.mockReturnValue({ results: [] });
	runDepAuditMock.mockReturnValue({ kind: "audit" });
	formatToolReportMock.mockReturnValue("TOOL-REPORT");
	tryAcquireProjectHeavyProcessLeaseMock.mockReturnValue(releaseHeavyProcessMock);
	detectDecisionSurfaceMock.mockReturnValue({ ds: true });
	detectLockfileMultiplicityMock.mockReturnValue({ lm: true });
	computeDecisionSurfaceRatchetMock.mockReturnValue({ dsr: true });
	runRegistryParityCheckMock.mockReturnValue([]);
	addSuppressionsMock.mockReturnValue([]);
	loadFileSuppressionsMock.mockReturnValue(new Set());
	loadSuppressionFileMock.mockReturnValue({});
	parseSuppressionEntryMock.mockImplementation(() => ({ file: "f", check: "c", reason: "" }));
	getEffectiveSkipChecksMock.mockReturnValue(new Set());
	getSkipToolsMock.mockReturnValue([]);
	cloneRepoMock.mockReturnValue({ dir: "/clone/dir", elapsed_ms: 1500 });
	isGitUrlMock.mockReturnValue(false);
	normalizeGitUrlMock.mockImplementation((u: string) => u);
	repoDisplayNameMock.mockImplementation((u: string) => `repo(${u})`);
	discoverFilesMock.mockReturnValue(["/p/a.ts", "/p/b.ts"]);
	buildStructureJsonSectionMock.mockReturnValue({ structure: true });
	checkProjectSetupMock.mockReturnValue([]);
	filterCodeQualityResultsInPlaceMock.mockImplementation((r: unknown) => r);
	runCodeQualityChecksProgressiveMock.mockImplementation(async () => ({
		undocumentedEnvVars: [],
	}));
	runSuggestionsMock.mockReturnValue(new Map());
	summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
	existsSyncMock.mockReturnValue(true);
	statSyncMock.mockReturnValue({ isDirectory: () => true });

	stderr = "";
	stdout = "";
	origErr = process.stderr.write;
	origOut = process.stdout.write;
	origExitCode = process.exitCode;
	process.exitCode = undefined;
	process.stderr.write = ((c: string) => {
		stderr += c;
		return true;
	}) as typeof process.stderr.write;
	process.stdout.write = ((c: string) => {
		stdout += c;
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stderr.write = origErr;
	process.stdout.write = origOut;
	process.exitCode = origExitCode;
});

async function importVerify() {
	return import("./verify.js");
}

// ===========================================
// Re-exports stay load-bearing
// ===========================================

describe("verify.ts re-exports", () => {
	it("re-exports the public names other modules import from here", async () => {
		const mod = await importVerify();
		expect(mod.DEFAULT_ADVISORY_SKIPS).toBeInstanceOf(Set);
		expect(mod.CODE_EXTENSIONS).toBeInstanceOf(Set);
		// `verify.ts` re-exports these as live bindings from the subfiles, which
		// are mocked here — so the re-exported name is identical to the spy.
		expect(mod.isGitUrl).toBe(isGitUrlMock);
		expect(mod.normalizeGitUrl).toBe(normalizeGitUrlMock);
		expect(mod.repoDisplayName).toBe(repoDisplayNameMock);
		expect(mod.cloneRepo).toBe(cloneRepoMock);
		expect(mod.discoverFiles).toBe(discoverFilesMock);
		expect(mod.summarizeFlaggedFiles).toBe(summarizeFlaggedFilesMock);
	});
});

// ===========================================
// Suppression management subflags
// ===========================================

describe("verifyCommand — showSuppressions", () => {
	it("reports the empty-suppressions hint and runs nothing else", async () => {
		const { verifyCommand } = await importVerify();
		loadSuppressionFileMock.mockReturnValue({});
		await verifyCommand({ showSuppressions: true });
		expect(loadSuppressionFileMock).toHaveBeenCalledTimes(1);
		expect(stderr).toContain("No suppressions configured.");
		expect(stderr).toContain("interlinked verify --suppress");
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});

	it("lists active suppressions sorted, with and without reasons", async () => {
		const { verifyCommand } = await importVerify();
		loadSuppressionFileMock.mockReturnValue({
			"z.ts": { beta: { reason: "why-beta" }, alpha: {} },
			"a.ts": { only: { reason: "why-a" } },
		});
		await verifyCommand({ showSuppressions: true });
		expect(stderr).toContain("Active suppressions");
		// a.ts sorts before z.ts
		expect(stderr.indexOf("a.ts")).toBeLessThan(stderr.indexOf("z.ts"));
		// alpha (no reason) sorts before beta (with reason) within z.ts
		expect(stderr.indexOf("alpha")).toBeLessThan(stderr.indexOf("beta"));
		expect(stderr).toContain("why-beta");
		expect(stderr).toContain("why-a");
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});
});

describe("verifyCommand — applySuppressions", () => {
	it("rejects an unparseable suppression entry and exits 1 without running verify", async () => {
		const { verifyCommand } = await importVerify();
		parseSuppressionEntryMock.mockReturnValueOnce(null);
		await verifyCommand({ suppress: ["bogus"] });
		expect(stderr).toContain("invalid suppression format");
		expect(process.exitCode).toBe(1);
		expect(addSuppressionsMock).not.toHaveBeenCalled();
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});

	it("surfaces an Error thrown by addSuppressions and exits 1", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockImplementationOnce(() => {
			throw new Error("needs a ticket");
		});
		await verifyCommand({ suppress: ["f:c"] });
		expect(stderr).toContain("Suppression rejected:");
		expect(stderr).toContain("needs a ticket");
		expect(process.exitCode).toBe(1);
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});

	it("stringifies a non-Error thrown by addSuppressions", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockImplementationOnce(() => {
			throw "raw-string-failure";
		});
		await verifyCommand({ suppress: ["f:c"] });
		expect(stderr).toContain("raw-string-failure");
		expect(process.exitCode).toBe(1);
	});

	it("prints added entries (with + without reason) then continues to verify", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockReturnValueOnce([
			{ file: "x.ts", check: "c1", reason: "because" },
			{ file: "y.ts", check: "c2", reason: "" },
		]);
		await verifyCommand({ suppress: ["x.ts:c1:because", "y.ts:c2"] });
		expect(stderr).toContain("Suppressions added:");
		expect(stderr).toContain("x.ts:c1");
		expect(stderr).toContain("because");
		expect(stderr).toContain("y.ts:c2");
		expect(stderr).toContain("Written to .interlinked/verify-suppressions.json");
		// ok === true → falls through to runVerify
		expect(discoverFilesMock).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBeUndefined();
	});

	it("reports 'already suppressed' when nothing new was added, then continues", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockReturnValueOnce([]);
		await verifyCommand({ suppress: ["x.ts:c1"] });
		expect(stderr).toContain("All entries already suppressed.");
		expect(discoverFilesMock).toHaveBeenCalledTimes(1);
	});

	it("does not apply suppressions when the suppress array is empty", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ suppress: [] });
		expect(addSuppressionsMock).not.toHaveBeenCalled();
		// empty suppress array is falsy-length → straight to runVerify
		expect(discoverFilesMock).toHaveBeenCalledTimes(1);
	});
});

// ===========================================
// Top-level dispatch
// ===========================================

describe("verifyCommand — dispatch", () => {
	it("routes --structure-only to runStructureVerify and returns early", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ structureOnly: true, cwd: "/repo" });
		expect(runStructureVerifyMock).toHaveBeenCalledWith("/repo", { structureOnly: true, cwd: "/repo" });
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});

	it("falls back to process.cwd() for --structure-only when no cwd given", async () => {
		const { verifyCommand } = await importVerify();
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/cwd-default");
		try {
			await verifyCommand({ structureOnly: true });
			expect(runStructureVerifyMock).toHaveBeenCalledWith("/cwd-default", { structureOnly: true });
		} finally {
			spy.mockRestore();
		}
	});

	it("routes a git-URL target to the remote-verify path", async () => {
		const { verifyCommand } = await importVerify();
		isGitUrlMock.mockReturnValue(true);
		await verifyCommand({ target: "https://github.com/o/r", json: true });
		expect(cloneRepoMock).toHaveBeenCalledTimes(1);
		// remote path scans the clone dir, not via the local stat() branch
		expect(statSyncMock).not.toHaveBeenCalled();
	});

	it("errors with the remote-repo hint when a local target does not exist", async () => {
		const { verifyCommand } = await importVerify();
		existsSyncMock.mockReturnValue(false);
		await verifyCommand({ target: "./missing" });
		expect(stderr).toContain("Target not found: ./missing");
		expect(stderr).toContain("interlinked verify https://github.com/owner/repo");
		expect(process.exitCode).toBe(1);
		expect(statSyncMock).not.toHaveBeenCalled();
	});

	it("resolves a relative local target against cwd and scans when it is a directory", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "sub/dir", cwd: "/repo", json: true });
		// resolve("/repo", "sub/dir") → existsSync + statSync hit the absolute path
		expect(existsSyncMock).toHaveBeenCalledWith("/repo/sub/dir");
		expect(statSyncMock).toHaveBeenCalledWith("/repo/sub/dir");
		// directory → runVerify(targetPath) → batch JSON
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
	});

	it("uses an absolute target verbatim (no resolve)", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "/abs/target", json: true });
		expect(existsSyncMock).toHaveBeenCalledWith("/abs/target");
		expect(statSyncMock).toHaveBeenCalledWith("/abs/target");
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
	});

	it("errors when a local target exists but is not a directory", async () => {
		const { verifyCommand } = await importVerify();
		statSyncMock.mockReturnValue({ isDirectory: () => false });
		await verifyCommand({ target: "/abs/file.ts" });
		expect(stderr).toContain("Target is not a directory: /abs/file.ts");
		expect(process.exitCode).toBe(1);
		expect(discoverFilesMock).not.toHaveBeenCalled();
		expect(outputJsonMock).not.toHaveBeenCalled();
	});

	it("runs against cwd when no target is provided", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/here", json: true });
		expect(discoverFilesMock).toHaveBeenCalledWith("/here");
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
	});
});

// ===========================================
// runRemoteVerify (via git-URL dispatch)
// ===========================================

describe("verifyCommand — remote verify", () => {
	beforeEach(() => {
		isGitUrlMock.mockReturnValue(true);
	});

	it("prints clone progress lines in non-json mode and cleans up the clone dir", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "https://github.com/o/r" });
		expect(normalizeGitUrlMock).toHaveBeenCalledWith("https://github.com/o/r");
		expect(stderr).toContain("cloning repo(https://github.com/o/r)...");
		expect(stderr).toContain("cloned in 1.5s");
		expect(cloneRepoMock).toHaveBeenCalledWith("https://github.com/o/r", { branch: undefined });
		// finally → cleanup of clone dir
		expect(rmSyncMock).toHaveBeenCalledWith("/clone/dir", { recursive: true, force: true });
	});

	it("suppresses clone progress lines in json mode", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "https://github.com/o/r", json: true });
		expect(stderr).not.toContain("cloning");
		expect(stderr).not.toContain("cloned in");
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
		expect(rmSyncMock).toHaveBeenCalledTimes(1);
	});

	it("passes --branch through to cloneRepo", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "https://github.com/o/r", branch: "dev", json: true });
		expect(cloneRepoMock).toHaveBeenCalledWith("https://github.com/o/r", { branch: "dev" });
	});

	it("scans the subdir under the clone dir when --subdir is given", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "https://github.com/o/r", subdir: "packages/app", json: true });
		expect(discoverFilesMock).toHaveBeenCalledWith("/clone/dir/packages/app");
	});

	it("scans the clone root when no --subdir is given", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ target: "https://github.com/o/r", json: true });
		expect(discoverFilesMock).toHaveBeenCalledWith("/clone/dir");
	});

	it("reports an Error from cloneRepo and exits 1 without scanning", async () => {
		const { verifyCommand } = await importVerify();
		cloneRepoMock.mockImplementationOnce(() => {
			throw new Error("Clone failed: no such repo");
		});
		await verifyCommand({ target: "https://github.com/o/r" });
		expect(stderr).toContain("Clone failed: no such repo");
		expect(process.exitCode).toBe(1);
		expect(discoverFilesMock).not.toHaveBeenCalled();
		expect(rmSyncMock).not.toHaveBeenCalled();
	});

	it("stringifies a non-Error thrown by cloneRepo", async () => {
		const { verifyCommand } = await importVerify();
		cloneRepoMock.mockImplementationOnce(() => {
			throw "raw clone failure";
		});
		await verifyCommand({ target: "https://github.com/o/r" });
		expect(stderr).toContain("raw clone failure");
		expect(process.exitCode).toBe(1);
	});

	it("still cleans up the clone dir when the inner runVerify throws", async () => {
		const { verifyCommand } = await importVerify();
		discoverFilesMock.mockImplementationOnce(() => {
			throw new Error("scan boom");
		});
		await expect(verifyCommand({ target: "https://github.com/o/r", json: true })).rejects.toThrow(
			"scan boom",
		);
		// finally block runs even on throw
		expect(rmSyncMock).toHaveBeenCalledWith("/clone/dir", { recursive: true, force: true });
	});
});

// ===========================================
// runVerify — streaming (non-json) path
// ===========================================

describe("runVerify — streaming output path", () => {
	it("defers without a verdict when another process owns the project lane", async () => {
		tryAcquireProjectHeavyProcessLeaseMock.mockReturnValueOnce(null);
		const { verifyCommand } = await importVerify();

		await verifyCommand({ cwd: "/repo" });

		expect(stderr).toContain("verify deferred");
		expect(stderr).toContain("no verification verdict was produced");
		expect(process.exitCode).toBe(1);
		expect(discoverFilesMock).not.toHaveBeenCalled();
		expect(runCodeQualityChecksProgressiveMock).not.toHaveBeenCalled();
		expect(releaseHeavyProcessMock).not.toHaveBeenCalled();
	});

	it("reports an unavailable no-verdict when project admission itself fails", async () => {
		tryAcquireProjectHeavyProcessLeaseMock.mockImplementationOnce(() => {
			throw new Error("lock directory unavailable");
		});
		const { verifyCommand } = await importVerify();

		await verifyCommand({ cwd: "/repo" });

		expect(stderr).toContain("verify unavailable");
		expect(stderr).toContain("lock directory unavailable");
		expect(stderr).toContain("no verification verdict was produced");
		expect(process.exitCode).toBe(1);
		expect(discoverFilesMock).not.toHaveBeenCalled();
	});

	it("always releases the project lane after a successful run", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		expect(releaseHeavyProcessMock).toHaveBeenCalledTimes(1);
	});

	it("releases the project lane when verification throws", async () => {
		runCodeQualityChecksProgressiveMock.mockRejectedValueOnce(new Error("scan failed"));
		const { verifyCommand } = await importVerify();

		await expect(verifyCommand({ cwd: "/repo" })).rejects.toThrow("scan failed");
		expect(releaseHeavyProcessMock).toHaveBeenCalledTimes(1);
	});

	it("runs no inline census before a requested --only external tool", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", only: "tsc" });

		expect(runCodeQualityChecksProgressiveMock).not.toHaveBeenCalled();
		expect(streamAllCqSectionsMock).not.toHaveBeenCalled();
		expect(streamExternalToolsMock).toHaveBeenCalledTimes(1);
	});

	it("drives the full streaming pipeline and emits the run record (default mode)", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });

		// skip-check resolution + propagation
		expect(getEffectiveSkipChecksMock).toHaveBeenCalledWith(undefined, undefined);
		expect(setActiveSkipChecksMock).toHaveBeenCalledTimes(1);

		// header + the four project-level streams
		expect(formatToolReportMock).toHaveBeenCalledTimes(1);
		expect(streamProjectSetupMock).toHaveBeenCalledTimes(1);
		expect(streamRegistryParityMock).toHaveBeenCalledTimes(1);
		expect(streamLockfileMultiplicityMock).toHaveBeenCalledWith({ lm: true });
		expect(streamDecisionSurfaceRatchetMock).toHaveBeenCalledWith({ dsr: true });

		// code-quality + external tools + dead code
		expect(filterCodeQualityResultsInPlaceMock).toHaveBeenCalledTimes(1);
		expect(clearCodeQualityResultsMock).toHaveBeenCalledTimes(1);
		expect(streamAllCqSectionsMock).toHaveBeenCalledTimes(1);
		expect(streamUndocumentedEnvVarsMock).toHaveBeenCalledTimes(1);
		expect(streamExternalToolsMock).toHaveBeenCalledTimes(1);
		expect(streamSupermodelDeadCodeMock).toHaveBeenCalledTimes(1);

		// no suggestions / structure by default
		expect(streamSuggestionsSummaryMock).not.toHaveBeenCalled();
		expect(runStructureVerifyMock).not.toHaveBeenCalled();

		// tally line + run record, default mode
		expect(stderr).toContain("0 / 2 files flagged");
		expect(emitVerifyRunMock).toHaveBeenCalledTimes(1);
		const runArg = emitVerifyRunMock.mock.calls[0]?.[1] as { mode: string; files_scanned: number };
		expect(runArg.mode).toBe("default");
		expect(runArg.files_scanned).toBe(2);

		// did NOT take the json branch
		expect(outputJsonMock).not.toHaveBeenCalled();
	});

	it("passes details=true through when --details is set", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", details: true });
		// streamAllCqSections(cq, details, allFlaggedFiles) — second arg is details
		expect(streamAllCqSectionsMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("defaults details to false when --details is omitted", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		expect(streamAllCqSectionsMock.mock.calls[0]?.[1]).toBe(false);
	});

	it("emits all-checks mode in the run record under --all-checks", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", allChecks: true });
		expect(getEffectiveSkipChecksMock).toHaveBeenCalledWith(undefined, true);
		const runArg = emitVerifyRunMock.mock.calls[0]?.[1] as { mode: string };
		expect(runArg.mode).toBe("all-checks");
	});

	it("forwards the --skip arg into skip-check resolution", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", skip: "complexity,magic_number" });
		expect(getEffectiveSkipChecksMock).toHaveBeenCalledWith("complexity,magic_number", undefined);
	});

	it("runs the suggestions summary when --suggestions is set", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", suggestions: true });
		expect(streamSuggestionsSummaryMock).toHaveBeenCalledWith(["/p/a.ts", "/p/b.ts"], "/repo");
	});

	it("runs structure verification when --structure is set", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", structure: true });
		expect(runStructureVerifyMock).toHaveBeenCalledTimes(1);
	});
});

describe("runVerify — tally line variants", () => {
	it("uses the singular noun for exactly one project-level finding", async () => {
		const { verifyCommand } = await importVerify();
		summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 1, totalFiles: 2, projectFindings: 1 });
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("1 / 2 files flagged");
		expect(stderr).toContain("1 project-level finding");
		expect(stderr).not.toContain("project-level findings");
	});

	it("uses the plural noun for multiple project-level findings", async () => {
		const { verifyCommand } = await importVerify();
		summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 0, totalFiles: 2, projectFindings: 3 });
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("3 project-level findings");
	});

	it("omits the project-findings clause when there are none", async () => {
		const { verifyCommand } = await importVerify();
		summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).not.toContain("project-level finding");
	});

	it("renders the external-tool summary segments when streamExternalTools populates them", async () => {
		const { verifyCommand } = await importVerify();
		// streamExternalTools receives the summary array by reference and pushes onto it.
		streamExternalToolsMock.mockImplementationOnce(async (args: unknown) => {
			(args as { summary: Array<{ label: string; count: number; color: string }> }).summary.push({
				label: "tsc 2 errors",
				count: 2,
				color: "31",
			});
		});
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("tsc 2 errors");
		const runArg = emitVerifyRunMock.mock.calls[0]?.[1] as {
			summary: Array<{ label: string }>;
		};
		expect(runArg.summary).toEqual([{ label: "tsc 2 errors", count: 2, color: "31" }]);
	});
});

// ===========================================
// runVerifyBatchJson — json path
// ===========================================

describe("runVerifyBatchJson — json output path", () => {
	function lastJsonArg(): Record<string, unknown> {
		return outputJsonMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
	}

	it("partitions engine results by tool and reports totals (no --only)", async () => {
		const { verifyCommand } = await importVerify();
		runChecksMock.mockReturnValue({
			results: [
				{ tool: "tsc", file: "a.ts", message: "m1" },
				{ tool: "biome", file: "b.ts", message: "m2" },
				{ tool: "gitleaks", file: "c.ts", message: "m3" },
			],
		});
		await verifyCommand({ cwd: "/repo", json: true });

		// runChecks got the assembled skipTools list (empty here)
		expect(runChecksMock).toHaveBeenCalledTimes(1);
		const checkOpts = runChecksMock.mock.calls[0]?.[1] as { skipTools: string[]; timeoutMs: number };
		expect(checkOpts.skipTools).toEqual([]);
		expect(checkOpts.timeoutMs).toBe(30_000);

		const arg = lastJsonArg();
		expect(arg.tscResults).toEqual([{ tool: "tsc", file: "a.ts", message: "m1" }]);
		expect(arg.linterResults).toEqual([{ tool: "biome", file: "b.ts", message: "m2" }]);
		expect(arg.linterName).toBe("biome");
		expect(arg.gitleaksResults).toEqual([{ tool: "gitleaks", file: "c.ts", message: "m3" }]);
		expect(arg.totalFiles).toBe(2);
		// no --only → dep audit runs
		expect(runDepAuditMock).toHaveBeenCalledTimes(1);
		expect(arg.auditResult).toEqual({ kind: "audit" });
		// no suggestions / structure by default
		expect(arg.suggestions).toBeNull();
		expect(arg.structureSection).toBeUndefined();
	});

	it("prefers eslint over biome for linterName when eslint results exist", async () => {
		const { verifyCommand } = await importVerify();
		runChecksMock.mockReturnValue({
			results: [
				{ tool: "biome", file: "b.ts", message: "b" },
				{ tool: "eslint", file: "e.ts", message: "e" },
			],
		});
		await verifyCommand({ cwd: "/repo", json: true });
		const arg = lastJsonArg();
		expect(arg.linterName).toBe("eslint");
		// linterResults concatenates biome then eslint
		expect(arg.linterResults).toEqual([
			{ tool: "biome", file: "b.ts", message: "b" },
			{ tool: "eslint", file: "e.ts", message: "e" },
		]);
	});

	it("filters out tool results whose file carries a matching file-suppression", async () => {
		const { verifyCommand } = await importVerify();
		runChecksMock.mockReturnValue({
			results: [
				{ tool: "tsc", file: "kept.ts", message: "keep" },
				{ tool: "tsc", file: "suppressed.ts", message: "drop" },
			],
		});
		loadFileSuppressionsMock.mockImplementation((_dir: string, file: string) =>
			file === "suppressed.ts" ? new Set(["tsc"]) : new Set<string>(),
		);
		await verifyCommand({ cwd: "/repo", json: true });
		const arg = lastJsonArg();
		expect(arg.tscResults).toEqual([{ tool: "tsc", file: "kept.ts", message: "keep" }]);
	});

	it("builds the only-skip-tools list and skips the audit for --only !== sca", async () => {
		const { verifyCommand } = await importVerify();
		getSkipToolsMock.mockReturnValue(["mypy"]);
		await verifyCommand({ cwd: "/repo", json: true, only: "tsc" });
		// onlySkipTools = TOOL_IDS minus "tsc" (and its dash-variant) → biome, dep-audit
		const checkOpts = runChecksMock.mock.calls[0]?.[1] as { skipTools: string[] };
		expect(checkOpts.skipTools).toEqual(expect.arrayContaining(["biome", "dep-audit", "mypy"]));
		expect(checkOpts.skipTools).not.toContain("tsc");
		// only set and != "sca" → audit skipped, auditResult null
		expect(runDepAuditMock).not.toHaveBeenCalled();
		expect(lastJsonArg().auditResult).toBeNull();
		// `--only tsc` means just typecheck: the expensive inline census must not
		// run before the requested compiler process.
		expect(runCodeQualityChecksProgressiveMock).not.toHaveBeenCalled();
		expect(filterCodeQualityResultsInPlaceMock).not.toHaveBeenCalled();
	});

	it("normalizes the underscore form of --only when excluding tools", async () => {
		const { verifyCommand } = await importVerify();
		// "dep_audit" should keep "dep-audit" in the run set (only.replace("_","-") match)
		await verifyCommand({ cwd: "/repo", json: true, only: "dep_audit" });
		const checkOpts = runChecksMock.mock.calls[0]?.[1] as { skipTools: string[] };
		expect(checkOpts.skipTools).not.toContain("dep-audit");
		expect(checkOpts.skipTools).toEqual(expect.arrayContaining(["tsc", "biome"]));
	});

	it("runs the dep audit for --only sca", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", json: true, only: "sca" });
		expect(runDepAuditMock).toHaveBeenCalledTimes(1);
		expect(lastJsonArg().auditResult).toEqual({ kind: "audit" });
	});

	it("includes scored suggestions in the JSON payload under --suggestions", async () => {
		const { verifyCommand } = await importVerify();
		const sugg = new Map([["a.ts", [{ id: "x" }]]]);
		runSuggestionsMock.mockReturnValue(sugg);
		await verifyCommand({ cwd: "/repo", json: true, suggestions: true });
		expect(runSuggestionsMock).toHaveBeenCalledWith({
			files: ["/p/a.ts", "/p/b.ts"],
			cwd: "/repo",
			limit: 3,
			threshold: 0.5,
		});
		expect(lastJsonArg().suggestions).toBe(sugg);
	});

	it("includes the structure section in JSON when --structure is set", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", json: true, structure: true });
		expect(buildStructureJsonSectionMock).toHaveBeenCalledTimes(1);
		expect(lastJsonArg().structureSection).toEqual({ structure: true });
	});

	it("swallows a registry-parity failure and still emits JSON", async () => {
		const { verifyCommand } = await importVerify();
		runRegistryParityCheckMock.mockImplementationOnce(() => {
			throw new Error("parity boom");
		});
		await verifyCommand({ cwd: "/repo", json: true });
		// caught → registryDrift stays the empty default, JSON still emitted
		expect(lastJsonArg().registryDrift).toEqual([]);
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
	});

	it("threads decision-surface + lockfile + ratchet detectors into the JSON payload", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", json: true });
		const arg = lastJsonArg();
		expect(arg.decisionSurface).toEqual({ ds: true });
		expect(arg.lockfileMultiplicity).toEqual({ lm: true });
		expect(arg.decisionSurfaceRatchet).toEqual({ dsr: true });
		expect(arg.registryDrift).toEqual([]);
	});
});

// ===========================================
// Scan progress plumbing
// ===========================================
// The measured defect: `verify --all-checks` emitted nothing for 6m20s while
// one CPU-bound span ran. These pin that the span now reports itself, that it
// reports on stderr, and that `--json` stdout is unaffected.

/** stderr as it stood partway through the scan, captured by the mock below. */
let stderrDuringScan = "";

/** Drive the real reporter verify handed the scan, as a mid-scan run would. */
function driveProgressMidScan(): void {
	stderrDuringScan = "";
	runCodeQualityChecksProgressiveMock.mockImplementation(
		async (files: string[], _cwd: string, progress: ScanProgress) => {
			progress.start("checks");
			progress.advance(files[0] ?? "/p/a.ts", 4000);
			// Snapshot with the scan still running — this is the "during" proof.
			stderrDuringScan = stderr;
			progress.advance(files[1] ?? "/p/b.ts", 1);
			progress.finish();
			return { undocumentedEnvVars: [] };
		},
	);
}

describe("runVerify — scan progress", () => {
	it("hands the scan a reporter sized to the discovered file count", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		const [passedFiles, passedCwd, progress] =
			runCodeQualityChecksProgressiveMock.mock.calls[0] ?? [];
		expect(passedFiles).toEqual(["/p/a.ts", "/p/b.ts"]);
		expect(passedCwd).toBe("/repo");
		progress?.start("checks");
		expect(stderr).toContain("scanning checks 0/2");
	});

	it("writes the progress line to stderr while the scan runs, not after it", async () => {
		const { verifyCommand } = await importVerify();
		driveProgressMidScan();
		await verifyCommand({ cwd: "/repo" });
		expect(stderrDuringScan).toContain("scanning checks");
		// The completion line had not been written yet at that moment.
		expect(stderrDuringScan).not.toContain("code quality checks completed");
	});

	it("advances the counter to the file total as the scan proceeds", async () => {
		const { verifyCommand } = await importVerify();
		driveProgressMidScan();
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("scanning checks 2/2");
		expect(stdout).toBe("");
	});

	it("keeps --json stdout free of progress bytes", async () => {
		const { verifyCommand } = await importVerify();
		driveProgressMidScan();
		await verifyCommand({ cwd: "/repo", json: true });
		expect(stderr).toContain("scanning checks");
		// outputJson is mocked, so every stdout byte here would be progress leakage.
		expect(stdout).toBe("");
		expect(outputJsonMock).toHaveBeenCalledTimes(1);
	});

	it("names the slowest files after a slow run", async () => {
		const { verifyCommand } = await importVerify();
		driveProgressMidScan();
		let t = 0;
		// Each Date.now() read jumps 6s, so the run clears the slow-run threshold.
		const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => (t += 6000));
		await verifyCommand({ cwd: "/repo" });
		dateSpy.mockRestore();
		expect(stderr).toContain("slowest files:");
		expect(stderr).toContain("/p/a.ts 4.0s");
	});

	it("stays silent about slow files on a fast run", async () => {
		const { verifyCommand } = await importVerify();
		driveProgressMidScan();
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).not.toContain("slowest files:");
	});
});
