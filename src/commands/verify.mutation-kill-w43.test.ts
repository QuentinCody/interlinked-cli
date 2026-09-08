import { parseWire, wireArray, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// ===========================================
// Mutation-kill suite — wave pass1_w43 (src/commands/verify.ts)
// ===========================================
// Targets specific surviving mutants from the w43 brief packet. Every
// dependency of verify.ts is mocked at the module boundary (mirroring the
// approach in ./verify.test.ts) so assertions land on verify.ts's own
// string/arithmetic/conditional literals rather than on subfile behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanProgress } from "./verify/scan-progress.js";

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

// --- harness/check-engine ----------------------------------------------------
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

const releaseHeavyProcessMock = vi.fn<() => void>();
const tryAcquireProjectHeavyProcessLeaseMock = vi.fn<() => (() => void) | null>(
	() => releaseHeavyProcessMock,
);
vi.mock("../harness/project-heavy-process-lock.js", () => ({
	tryAcquireProjectHeavyProcessLease: tryAcquireProjectHeavyProcessLeaseMock,
}));

// --- harness/quality-checks --------------------------------------------------
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

// --- harness/registry-parity --------------------------------------------------
const runRegistryParityCheckMock = vi.fn<(cwd: string) => unknown[]>(() => []);
vi.mock("../harness/registry-parity.js", () => ({
	runRegistryParityCheck: runRegistryParityCheckMock,
}));

// --- harness/suppressions -----------------------------------------------------
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

// --- verify/advisory -----------------------------------------------------------
// NOTE: TOOL_IDS deliberately contains an underscore-form id ("alpha_beta") so
// the `t !== only` vs `t !== only.replace("_","-")` distinction in
// runVerifyBatchJson's onlySkipTools filter is actually observable (with a
// pure dash-form TOOL_IDS list the two clauses collapse to the same value).
vi.mock("./verify/advisory.js", () => ({
	DEFAULT_ADVISORY_SKIPS: new Set<string>(),
	TOOL_IDS: ["alpha_beta", "gamma"] as const,
}));
const getEffectiveSkipChecksMock = vi.fn<
	(skip: string | undefined, all: boolean | undefined) => Set<string>
>(() => new Set<string>());
const getSkipToolsMock = vi.fn<(skip: Set<string>) => string[]>(() => []);
vi.mock("./verify/advisory-skips.js", () => ({
	getEffectiveSkipChecks: getEffectiveSkipChecksMock,
	getSkipTools: getSkipToolsMock,
}));

// --- verify/clone-repo -----------------------------------------------------
const cloneRepoMock = vi.fn<(url: string, opts: unknown) => { dir: string; elapsed_ms: number }>(
	() => ({ dir: "/clone/dir", elapsed_ms: 1500 }),
);
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

// --- verify/output-json -----------------------------------------------------
const outputJsonMock = vi.fn<(args: Record<string, unknown>) => void>();
vi.mock("./verify/output-json.js", () => ({
	outputJson: outputJsonMock,
}));

// --- verify/streaming-output -------------------------------------------------
const setActiveSkipChecksMock = vi.fn<(s: Set<string>) => void>();
const streamAllCqSectionsMock =
	vi.fn<(cq: unknown, details: boolean, flagged: Set<string>) => void>();
vi.mock("./verify/streaming-output.js", () => ({
	setActiveSkipChecks: setActiveSkipChecksMock,
	streamAllCqSections: streamAllCqSectionsMock,
}));

// --- verify/structure ----------------------------------------------------------
const buildStructureJsonSectionMock = vi.fn<(cwd: string, opts: unknown) => unknown>(() => ({
	structure: true,
}));
const runStructureVerifyMock = vi.fn<(cwd: string, opts: unknown) => Promise<void>>(async () => {});
vi.mock("./verify/structure.js", () => ({
	buildStructureJsonSection: buildStructureJsonSectionMock,
	runStructureVerify: runStructureVerifyMock,
}));

// --- verify/tool-results -----------------------------------------------------
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

// --- verify/verify-tools -----------------------------------------------------
const streamExternalToolsMock = vi.fn<(args: unknown) => Promise<void>>(async () => {});
vi.mock("./verify/verify-tools.js", () => ({
	streamExternalTools: streamExternalToolsMock,
}));

// --- verify/verify-summary -----------------------------------------------------
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
	(cwd: string, files: readonly string[], flagged: Iterable<string>) => {
		flaggedFiles: number;
		totalFiles: number;
		projectFindings: number;
	}
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
// Test harness: capture stderr + exitCode.
// ---------------------------------------------------------------------------
let stderr: string;
let origErr: typeof process.stderr.write;
let origExitCode: typeof process.exitCode;

beforeEach(() => {
	vi.clearAllMocks();
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
	origErr = process.stderr.write;
	origExitCode = process.exitCode;
	process.exitCode = undefined;
	process.stderr.write = ((c: string) => {
		stderr += c;
		return true;
	});
});

afterEach(() => {
	process.stderr.write = origErr;
	process.exitCode = origExitCode;
	vi.restoreAllMocks();
});

async function importVerify() {
	return import("./verify.js");
}

// ===========================================
// displaySuppressions — mutants a59f2e3f9ee43a5b, 52cb051f3c0e7bb0
// ===========================================

describe("displaySuppressions literals", () => {
	it("prints no extra text when an entry has no reason (kills empty-string->literal mutant)", async () => {
		const { verifyCommand } = await importVerify();
		loadSuppressionFileMock.mockReturnValue({ "a.ts": { check1: {} } });
		await verifyCommand({ showSuppressions: true });
		expect(stderr).not.toContain("Stryker was here!");
		expect(stderr).toContain("    check1\n");
	});

	it("ends with a trailing blank line after the last suppression (kills trailing \\n mutant)", async () => {
		const { verifyCommand } = await importVerify();
		loadSuppressionFileMock.mockReturnValue({ "a.ts": { check1: {} } });
		await verifyCommand({ showSuppressions: true });
		expect(stderr.endsWith("check1\n\n")).toBe(true);
	});
});

// ===========================================
// applySuppressions — mutants 9c065fd4, dc2ee74a, 2e719a3b, b70b8e03, 35ad068f
// ===========================================

describe("applySuppressions literals", () => {
	it("does not smuggle a stray element into the entries array passed to addSuppressions", async () => {
		const { verifyCommand } = await importVerify();
		parseSuppressionEntryMock.mockReturnValueOnce({ file: "f1", check: "c1", reason: "" });
		await verifyCommand({ suppress: ["f1:c1"], json: true });
		expect(addSuppressionsMock).toHaveBeenCalledWith(expect.any(String), [
			{ file: "f1", check: "c1", reason: "" },
		]);
	});

	it("prints the expected-format hint verbatim on an unparseable entry", async () => {
		const { verifyCommand } = await importVerify();
		parseSuppressionEntryMock.mockReturnValueOnce(null);
		await verifyCommand({ suppress: ["bogus"] });
		expect(stderr).toContain("Expected: file:check or file:check:reason");
	});

	it("prints the ticket/expires_at hint verbatim when addSuppressions throws", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockImplementationOnce(() => {
			throw new Error("needs a ticket");
		});
		await verifyCommand({ suppress: ["f:c"] });
		expect(stderr).toContain(
			"Edit .interlinked/verify-suppressions.json directly to add the required `ticket` or `expires_at` fields.",
		);
	});

	it("prints no extra text for an added entry with no reason", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockReturnValueOnce([{ file: "x.ts", check: "c1", reason: "" }]);
		await verifyCommand({ suppress: ["x.ts:c1"], json: true });
		expect(stderr).not.toContain("Stryker was here!");
		expect(stderr).toContain("x.ts:c1\n");
	});

	it("ends the success message with a trailing blank line (isolated via --json to avoid downstream writes)", async () => {
		const { verifyCommand } = await importVerify();
		addSuppressionsMock.mockReturnValueOnce([{ file: "x.ts", check: "c1", reason: "" }]);
		await verifyCommand({ suppress: ["x.ts:c1"], json: true });
		expect(stderr.endsWith("verify-suppressions.json\n\n")).toBe(true);
	});
});

// ===========================================
// runVerify streaming literals — a4f1640b, 6a7aa182/d12ebf69, b67dda7e,
// c933decf, 011e1655, 4011db6b/dedd33d2, 016db7d6, 6d2b0063
// ===========================================

describe("runVerify streaming literals", () => {
	it("prints the header banner with file count", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("interlinked verify\x1b[0m · 2 files");
	});

	it("calls streamCaseDivergence only when --all-checks is set (true branch)", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", allChecks: true });
		expect(streamCaseDivergenceMock).toHaveBeenCalledTimes(1);
		expect(streamCaseDivergenceMock).toHaveBeenCalledWith(
			"/repo",
			["/p/a.ts", "/p/b.ts"],
			new Set(),
		);
	});

	it("does not call streamCaseDivergence when --all-checks is not set (false branch)", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		expect(streamCaseDivergenceMock).not.toHaveBeenCalled();
	});

	it("hands the scan a progress reporter sized to the discovered file count", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		const progress = runCodeQualityChecksProgressiveMock.mock.calls[0]?.[2];
		progress?.start("checks");
		// discoverFilesMock yields two files, so the reporter's total is 2.
		expect(stderr).toContain("scanning checks 0/2");
	});

	it("emits the carriage-return clear sequence through the progress reporter", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		const progress = runCodeQualityChecksProgressiveMock.mock.calls[0]?.[2];
		progress?.finish();
		expect(stderr).toContain("\r\x1b[K");
	});

	it("prints the code-quality-checks-completed line", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo" });
		expect(stderr).toContain("code quality checks completed in");
	});

	it("computes cqElapsed and duration_ms from Date.now() deltas divided (not multiplied)", async () => {
		const { verifyCommand } = await importVerify();
		let counter = 0;
		const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000_000 + counter++ * 100);
		try {
			await verifyCommand({ cwd: "/repo" });
		} finally {
			dateSpy.mockRestore();
		}
		// cqStart = call#1 (V), inline elapsed uses call#2 (V+100) => (100)/1000 = "0.1"
		expect(stderr).toContain("code quality checks completed in 0.1s");
		// duration_ms uses call#3 (V+200) - cqStart(V) = 200, not V+200+V (mutant `+`)
		const runArg = parseWire(emitVerifyRunMock.mock.calls[0]?.[1], wireObject({ "duration_ms": wireNumber }), "test JSON value");
		expect(runArg.duration_ms).toBe(200);
	});

	it("renders no ' · ' segment when there is nothing to report (kills forced-true / >=0 mutants)", async () => {
		const { verifyCommand } = await importVerify();
		summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
		await verifyCommand({ cwd: "/repo" });
		expect(stderr.endsWith("\n  0 / 2 files flagged\n\n")).toBe(true);
	});

	it("renders the exact separator + trailing double newline for a two-entry summary", async () => {
		const { verifyCommand } = await importVerify();
		summarizeFlaggedFilesMock.mockReturnValue({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
		streamExternalToolsMock.mockImplementationOnce(async (args: unknown) => {
			(parseWire(args, wireObject({ "summary": wireArray(wireObject({ "label": wireString, "count": wireNumber, "color": wireString })) }), "test JSON value")).summary.push(
				{ label: "E1", count: 1, color: "31" },
				{ label: "E2", count: 1, color: "32" },
			);
		});
		await verifyCommand({ cwd: "/repo" });
		const expectedTail =
			"\n  0 / 2 files flagged · \x1b[31mE1\x1b[0m · \x1b[32mE2\x1b[0m\n\n";
		expect(stderr.endsWith(expectedTail)).toBe(true);
	});
});

// ===========================================
// scope object passed into engine.runChecks — mutant 2d23ca979159c443
// ===========================================

describe("runVerify scope object", () => {
	it("passes the full {projectRoot, mode} scope to engine.runChecks, not an empty object", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", json: true });
		expect(runChecksMock).toHaveBeenCalledTimes(1);
		expect(runChecksMock.mock.calls[0]?.[0]).toEqual({ projectRoot: "/repo", mode: "project", lintCadence: "hook" });
	});
});

// ===========================================
// runVerifyBatchJson literals — 7345a916, 8f385a941, semgrep filter cluster,
// 4a17cbc5 (only-skip-tools underscore distinction)
// ===========================================

describe("runVerifyBatchJson literals", () => {
	function lastJsonArg(): Record<string, unknown> {
		return nonNull(outputJsonMock.mock.calls.at(-1)?.[0]);
	}

	it("resolves the interlinked dir as cwd/.interlinked when checking file suppressions", async () => {
		const { verifyCommand } = await importVerify();
		runChecksMock.mockReturnValue({
			results: [{ tool: "tsc", file: "x.ts", message: "m" }],
		});
		await verifyCommand({ cwd: "/repo", json: true });
		expect(loadFileSuppressionsMock).toHaveBeenCalledWith("/repo/.interlinked", "x.ts");
	});

	it("filters semgrepResults down to exactly the semgrep-tool entries", async () => {
		const { verifyCommand } = await importVerify();
		runChecksMock.mockReturnValue({
			results: [
				{ tool: "tsc", file: "a.ts", message: "m1" },
				{ tool: "semgrep", file: "s.ts", message: "sg" },
				{ tool: "gitleaks", file: "g.ts", message: "gl" },
			],
		});
		await verifyCommand({ cwd: "/repo", json: true });
		const arg = lastJsonArg();
		expect(arg.semgrepResults).toEqual([{ tool: "semgrep", file: "s.ts", message: "sg" }]);
	});

	it("still assigns registryDrift from the try body when runRegistryParityCheck succeeds", async () => {
		const { verifyCommand } = await importVerify();
		runRegistryParityCheckMock.mockReturnValueOnce([
			{ id: "drift-1" },
		]);
		await verifyCommand({ cwd: "/repo", json: true });
		expect(lastJsonArg().registryDrift).toEqual([{ id: "drift-1" }]);
	});

	it("excludes an --only id that matches exactly, even though TOOL_IDS has an underscore form", async () => {
		const { verifyCommand } = await importVerify();
		await verifyCommand({ cwd: "/repo", json: true, only: "alpha_beta" });
		const checkOpts = parseWire(runChecksMock.mock.calls[0]?.[1], wireObject({ "skipTools": wireArray(wireString) }), "test JSON value");
		expect(checkOpts.skipTools).not.toContain("alpha_beta");
		expect(checkOpts.skipTools).toContain("gamma");
	});
});
