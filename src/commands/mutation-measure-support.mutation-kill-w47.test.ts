import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for every dynamic/static dependency measureOneFile / maybeRecordMeasurement
// / preflightScopedSuite / spawnVitestSuite pull in, so each test can control
// exactly what the mutated branch sees. Each mock is typed as a variadic
// function so it can be spread-called from the vi.mock factory.
// ---------------------------------------------------------------------------

const execFileMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("node:child_process", () => ({
	execFile: (...args: any[]) => execFileMock(...args),
}));

const probeScopedSuiteMock = vi.fn((..._args: any[]): any => undefined);
const redSuiteMessageMock = vi.fn((..._args: any[]): any => "RED");
vi.mock("../harness/mutation/baseline-suite.js", () => ({
	probeScopedSuite: (...args: any[]) => probeScopedSuiteMock(...args),
	redSuiteMessage: (...args: any[]) => redSuiteMessageMock(...args),
}));

const normalizeManifestKeyMock = vi.fn((..._args: any[]): any => _args[0]);
// Tri-state loader (review 2026-08-28): missing may bootstrap, corrupt refuses.
const loadManifestStateMock = vi.fn((..._args: any[]): any => ({ kind: "missing" }));
const emptyManifestMock = vi.fn((..._args: any[]): any => ({ ...(_args[0] as object) }));
const saveManifestMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("../harness/mutation/manifest.js", () => ({
	normalizeManifestKey: (...args: any[]) => normalizeManifestKeyMock(...args),
	loadManifestState: (...args: any[]) => loadManifestStateMock(...args),
	emptyManifest: (...args: any[]) => emptyManifestMock(...args),
	saveManifest: (...args: any[]) => saveManifestMock(...args),
}));

const recordMeasurementMock = vi.fn((..._args: any[]): any => undefined);
const readDiskSafeMock = vi.fn((..._args: any[]): any => undefined);
const buildScopedMeasureOverlaysMock = vi.fn((..._args: any[]): any => undefined);
const measureFileMock = vi.fn((..._args: any[]): any => undefined);
const configuredRunnerEndpointsMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("../harness/mutation/measure.js", () => ({
	recordMeasurement: (...args: any[]) => recordMeasurementMock(...args),
	readDiskSafe: (...args: any[]) => readDiskSafeMock(...args),
	buildScopedMeasureOverlays: (...args: any[]) => buildScopedMeasureOverlaysMock(...args),
	measureFile: (...args: any[]) => measureFileMock(...args),
	configuredRunnerEndpoints: (...args: any[]) => configuredRunnerEndpointsMock(...args),
}));

const computeMutationTestScopeForRepoMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("../harness/mutation/test-scope.js", () => ({
	computeMutationTestScopeForRepo: (...args: any[]) => computeMutationTestScopeForRepoMock(...args),
}));

const configuredMaxTestScopeMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("../harness/mutation/runner-endpoints.js", () => ({
	configuredMaxTestScope: (...args: any[]) => configuredMaxTestScopeMock(...args),
}));

const writeSurvivorsIndexMock = vi.fn((..._args: any[]): any => undefined);
vi.mock("../harness/mutation/survivors-index.js", () => ({
	writeSurvivorsIndex: (...args: any[]) => writeSurvivorsIndexMock(...args),
}));

import {
	maybeRecordMeasurement,
	measureOneFile,
	measurementScopeFor,
	preflightScopedSuite,
	spawnVitestSuite,
	testScopeNote,
} from "./mutation-measure-support.js";

beforeEach(() => {
	vi.clearAllMocks();
	normalizeManifestKeyMock.mockImplementation((..._args: any[]): any => _args[0]);
	configuredMaxTestScopeMock.mockReturnValue(undefined);
	loadManifestStateMock.mockReturnValue({ kind: "missing" });
	emptyManifestMock.mockImplementation((..._args: any[]): any => ({ ...(_args[0] as object) }));
});

// ---------------------------------------------------------------------------
// spawnVitestSuite (symbols 912cca51b78a2218, 33a40d941920f210)
// ---------------------------------------------------------------------------

describe("spawnVitestSuite", () => {
	it("passes an 8MB maxBuffer to execFile", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: { maxBuffer: number }, cb: any) => {
			cb(null, "", "");
			return { on: vi.fn() };
		});
		await spawnVitestSuite({ tests: ["a.test.ts"], cwd: "/tmp" });
		const opts = execFileMock.mock.calls[0]![2] as { maxBuffer: number };
		expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
	});

	it("registers its rejection handler under the literal child-process 'error' event", async () => {
		let errorHandler: ((e: unknown) => void) | undefined;
		const onMock = vi.fn((event: string, handler: (e: unknown) => void) => {
			if (event === "error") errorHandler = handler;
		});
		execFileMock.mockImplementation(() => ({ on: onMock }));
		const promise = spawnVitestSuite({ tests: [], cwd: "/tmp" });
		expect(errorHandler).toBeDefined();
		const boom = new Error("spawn boom");
		errorHandler?.(boom);
		await expect(promise).rejects.toBe(boom);
	});

	it("resolves with the numeric exit code carried on a non-zero-exit error", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
			cb({ code: 3 }, "out", "errtext");
			return { on: vi.fn() };
		});
		const result = await spawnVitestSuite({ tests: [], cwd: "/tmp" });
		expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "errtext" });
	});

	it("rejects (does not resolve exitCode:0) on a spawn-level error with no numeric code", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
			cb(new Error("no npx"), "", "");
			return { on: vi.fn() };
		});
		await expect(spawnVitestSuite({ tests: [], cwd: "/tmp" })).rejects.toThrow("no npx");
	});
});

// ---------------------------------------------------------------------------
// testScopeNote (symbol 4fc14544785e27f5)
// ---------------------------------------------------------------------------

describe("testScopeNote", () => {
	it("prefers the companion-kill-test note over the lossy glob note when a companion scope exists", () => {
		const note = testScopeNote({
			tests: undefined,
			reason: "over_cap",
			uncappedCount: 9,
			companionScope: ["a.mutation-kill.test.ts"],
		} as any);
		expect(note).toContain("companion kill test(s)");
		expect(note).not.toContain("falling back to filename-glob scope");
	});
});

// ---------------------------------------------------------------------------
// measurementScopeFor (symbol a1a8fcb59590c1b2)
// ---------------------------------------------------------------------------

describe("measurementScopeFor", () => {
	it("returns import_graph when scope.tests is present", () => {
		expect(measurementScopeFor({ tests: ["x.test.ts"] } as any)).toBe("import_graph");
	});

	it("returns companion_fallback when there are no tests but a non-empty companionScope", () => {
		expect(measurementScopeFor({ tests: undefined, companionScope: ["y.test.ts"] } as any)).toBe(
			"companion_fallback",
		);
	});

	it("returns glob_fallback when neither tests nor companionScope are present", () => {
		expect(measurementScopeFor({ tests: undefined, companionScope: [] } as any)).toBe("glob_fallback");
	});
});

// ---------------------------------------------------------------------------
// preflightScopedSuite (symbol ac3c237e96fa0dbd)
// ---------------------------------------------------------------------------

describe("preflightScopedSuite", () => {
	it("forwards tests, cwd, and the real spawnVitestSuite runner to probeScopedSuite", async () => {
		probeScopedSuiteMock.mockResolvedValue({ status: "green" });
		await preflightScopedSuite({ tests: ["t.test.ts"], cwd: "/proj", quiet: true });
		expect(probeScopedSuiteMock).toHaveBeenCalledWith({
			tests: ["t.test.ts"],
			cwd: "/proj",
			run: spawnVitestSuite,
		});
	});
});

// ---------------------------------------------------------------------------
// maybeRecordMeasurement (symbol 5c3f6eb044107a3f)
// ---------------------------------------------------------------------------

describe("maybeRecordMeasurement", () => {
	const baseArgs = {
		record: true,
		outcome: { status: "measured", mutantCount: 1, survivorCount: 0, survivors: [] } as any,
		configDir: "/proj/.interlinked",
		key: "f.ts",
		content: "x",
		cwd: "/proj",
	};

	it("omits the provenance key from the recordMeasurement call when none was passed", async () => {
		recordMeasurementMock.mockReturnValue({ recorded: true, manifest: {} });
		await maybeRecordMeasurement({ ...baseArgs });
		const callArg = recordMeasurementMock.mock.calls[0]![0];
		expect("provenance" in callArg).toBe(false);
	});

	it("does not persist when recordMeasurement reports recorded:false, even if a manifest is present", async () => {
		recordMeasurementMock.mockReturnValue({ recorded: false, manifest: { some: "manifest" }, reason: "nope" });
		await maybeRecordMeasurement({ ...baseArgs });
		expect(saveManifestMock).not.toHaveBeenCalled();
		expect(writeSurvivorsIndexMock).not.toHaveBeenCalled();
	});

	it("persists when recordMeasurement reports recorded:true with a manifest", async () => {
		const manifest = { some: "manifest" };
		recordMeasurementMock.mockReturnValue({ recorded: true, manifest });
		await maybeRecordMeasurement({ ...baseArgs });
		expect(saveManifestMock).toHaveBeenCalledWith(baseArgs.configDir, manifest);
		expect(writeSurvivorsIndexMock).toHaveBeenCalledWith(baseArgs.configDir, manifest);
	});

	it("omits before/after/reason keys from the summary when recordMeasurement didn't set them", async () => {
		recordMeasurementMock.mockReturnValue({ recorded: true, manifest: {} });
		const result = await maybeRecordMeasurement({ ...baseArgs });
		expect(result?.recorded).toBe(true);
		expect(Object.keys(result as object).sort()).toEqual(["recorded"]);
	});
});

// ---------------------------------------------------------------------------
// measureOneFile (symbol fcab2a44a9a406da) + overlayNotes (symbol bd7ef8f4f0db609d,
// exercised only through measureOneFile's returned `notes`, since overlayNotes
// itself is not exported)
// ---------------------------------------------------------------------------

describe("measureOneFile", () => {
	function stdMeasure(extra: Record<string, unknown> = {}) {
		return vi
			.fn()
			.mockResolvedValue({ status: "measured", mutantCount: 1, survivorCount: 0, survivors: [], ...extra });
	}

	it("names the unreadable file and the original argument in the refusal reason", async () => {
		readDiskSafeMock.mockReturnValue(null);
		normalizeManifestKeyMock.mockReturnValue("normalized.ts");
		const result = await measureOneFile({
			file: "orig.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
		});
		expect(result.status).toBe("unreadable");
		expect(result.reason).toBe('Cannot read "normalized.ts" (resolved from "orig.ts").');
	});

	it("gives the full no-runner guidance message when no endpoints are configured", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: [] });
		const result = await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
		});
		expect(result.status).toBe("no_runner");
		expect(result.reason).toContain(
			"No mutation runner configured. Pass --runner-url, or set per_edit_mutation.runner_url",
		);
	});

	it("forwards maxScope into computeMutationTestScopeForRepo when configuredMaxTestScope returns one", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		configuredMaxTestScopeMock.mockReturnValue(5);
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		const callArg = computeMutationTestScopeForRepoMock.mock.calls[0]![0];
		expect(callArg.maxScope).toBe(5);
	});

	it("omits maxScope from computeMutationTestScopeForRepo when configuredMaxTestScope returns undefined", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		configuredMaxTestScopeMock.mockReturnValue(undefined);
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		const callArg = computeMutationTestScopeForRepoMock.mock.calls[0]![0];
		expect("maxScope" in callArg).toBe(false);
	});

	it("uses scope.tests directly via ?? even when companionScope is falsy (not && short-circuit)", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"], companionScope: undefined });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		expect(buildScopedMeasureOverlaysMock.mock.calls[0]![3]).toEqual(["a.test.ts"]);
	});

	it("passes the literal quiet flag through to the injected preflight", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		const preflight = vi.fn().mockResolvedValue(null);
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			quiet: true,
			preflight,
			measure: stdMeasure(),
		});
		expect(preflight.mock.calls[0]![0].quiet).toBe(true);
	});

	it("forwards a finite budgetMs as deadlineMs to measure", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		const measure = stdMeasure();
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			budgetMs: 100,
			measure,
		});
		expect(measure.mock.calls[0]![0].deadlineMs).toBe(100);
	});

	it("omits deadlineMs when budgetMs is not provided", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		const measure = stdMeasure();
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure,
		});
		expect("deadlineMs" in measure.mock.calls[0]![0]).toBe(false);
	});

	it("forwards a non-empty scopeTests as testScope to measure", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		const measure = stdMeasure();
		await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure,
		});
		expect(measure.mock.calls[0]![0].testScope).toEqual(["a.test.ts"]);
	});

	it("omits reason from the result when the outcome carries none", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: ["a.test.ts"] });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: [] });
		const result = await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		expect("reason" in result).toBe(false);
	});

	it("includes only the exact base progress note when nothing is unreadable or capped", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://a", "http://b"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: undefined, reason: undefined });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [{ path: "x.ts", content: "y" }], unreadable: [] });
		const result = await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		expect(result.notes).toEqual(["measuring f.ts (1 overlay(s)) via 2 runner(s)…"]);
	});

	it("adds an unreadable-files warning naming the missing paths", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: undefined, reason: undefined });
		buildScopedMeasureOverlaysMock.mockReturnValue({ overlays: [], unreadable: ["dep.ts"] });
		const result = await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		expect(result.notes.some((n) => n.includes("dep.ts") && n.includes("MISSING"))).toBe(true);
	});

	it("adds a capped-overlay warning when the closure was capped", async () => {
		readDiskSafeMock.mockReturnValue("content");
		normalizeManifestKeyMock.mockReturnValue("f.ts");
		configuredRunnerEndpointsMock.mockResolvedValue({ endpoints: ["http://runner"] });
		computeMutationTestScopeForRepoMock.mockReturnValue({ tests: undefined, reason: undefined });
		buildScopedMeasureOverlaysMock.mockReturnValue({
			overlays: [],
			unreadable: [],
			capped: { candidateCount: 5, limit: 2, dropped: ["b.ts", "c.ts"] },
		});
		const result = await measureOneFile({
			file: "f.ts",
			cwd: "/proj",
			configDir: "/proj/.interlinked",
			skipPreflight: true,
			measure: stdMeasure(),
		});
		expect(result.notes.some((n) => n.includes("capped to 2") && n.includes("b.ts, c.ts"))).toBe(true);
	});
});
