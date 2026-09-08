import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

// All external dependencies of pre-tool-coverage-gates.ts are mocked so each
// test can drive the exact branch a survivor lives in without needing a real
// TS project graph, coverage runner, or mutation runner.
const mocks = vi.hoisted(() => ({
	extractApplyPatchRaw: vi.fn(),
	looksLikeApplyPatch: vi.fn(),
	parseApplyPatchSections: vi.fn(),
	applyDebtMode: vi.fn(),
	noteWanderBlockDecision: vi.fn(),
	resolveDependencyView: vi.fn(),
	checkCommitGate: vi.fn(),
	checkCoverageWrite: vi.fn(),
	getGraphForFile: vi.fn(),
	runPerEditMutationGate: vi.fn(),
	emptyManifest: vi.fn(),
	// SAFETY: `any` return — the mock stands in for the tri-state loader whose
	// valid arm carries a manifest payload the per-case overrides supply.
	loadManifestState: vi.fn((): any => ({ kind: "missing" })),
	makeManifestPersister: vi.fn(),
	makeManifestPersisterWithIndex: vi.fn(),
	overlayHash: vi.fn(),
	pendingRegistry: vi.fn(),
	recordPending: vi.fn(),
}));

vi.mock("../apply-patch-content.js", () => ({
	extractApplyPatchRaw: mocks.extractApplyPatchRaw,
	looksLikeApplyPatch: mocks.looksLikeApplyPatch,
	parseApplyPatchSections: mocks.parseApplyPatchSections,
}));
vi.mock("../coverage-debt-gate.js", () => ({ applyDebtMode: mocks.applyDebtMode }));
vi.mock("../debt-evasion.js", () => ({ noteWanderBlockDecision: mocks.noteWanderBlockDecision }));
vi.mock("../dependency-view.js", () => ({ resolveDependencyView: mocks.resolveDependencyView }));
vi.mock("../evaluator/commit-gate.js", () => ({ checkCommitGate: mocks.checkCommitGate }));
vi.mock("../evaluator/coverage-write-guard.js", () => ({ checkCoverageWrite: mocks.checkCoverageWrite }));
vi.mock("../mutation/gate.js", () => ({ runPerEditMutationGate: mocks.runPerEditMutationGate }));
vi.mock("../mutation/manifest.js", () => ({
	emptyManifest: mocks.emptyManifest,
	loadManifestState: mocks.loadManifestState,
	makeManifestPersister: mocks.makeManifestPersister,
}));
vi.mock("../mutation/survivors-index.js", () => ({
	makeManifestPersisterWithIndex: mocks.makeManifestPersisterWithIndex,
}));
vi.mock("../mutation/pending-registry.js", () => ({
	overlayHash: mocks.overlayHash,
	pendingRegistry: mocks.pendingRegistry,
	initPendingRegistryStore: vi.fn(),
	commitPendingRegistry: vi.fn(),
}));
vi.mock("../mutation/pending-runs.js", () => ({ recordPending: mocks.recordPending }));
vi.mock("./runtime-context.js", () => ({ getGraphForFile: mocks.getGraphForFile }));

import { runCommitGate, runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/repo",
		rules: { per_edit_coverage: { enabled: true }, per_edit_mutation: { enabled: true } },
		sessions: {},
		...overrides,
	} as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.applyDebtMode.mockImplementation((_event: unknown, _cfg: unknown, decision: unknown) => decision);
	mocks.noteWanderBlockDecision.mockImplementation(() => {});
	mocks.resolveDependencyView.mockImplementation((filePath: unknown, cwd: unknown, graph: unknown) => ({
		filePath,
		cwd,
		graph,
	}));
	mocks.getGraphForFile.mockReturnValue({});
	mocks.extractApplyPatchRaw.mockReturnValue("");
	mocks.looksLikeApplyPatch.mockReturnValue(false);
	mocks.parseApplyPatchSections.mockReturnValue([]);
	mocks.checkCoverageWrite.mockResolvedValue(null);
	mocks.checkCommitGate.mockResolvedValue(null);
	mocks.runPerEditMutationGate.mockResolvedValue(null);
	mocks.emptyManifest.mockReturnValue({ empty: true });
	mocks.loadManifestState.mockReturnValue({ kind: "missing" });
	mocks.makeManifestPersister.mockReturnValue(() => {});
	mocks.makeManifestPersisterWithIndex.mockReturnValue(() => {});
	mocks.overlayHash.mockReturnValue("hash");
	mocks.pendingRegistry.mockReturnValue({});
	mocks.recordPending.mockImplementation(() => {});
});

async function depViewFor(toolInput: Record<string, unknown>) {
	const ctx = makeCtx();
	const event = { tool_name: "Write", tool_input: toolInput, cwd: "/repo" };
	await runCoverageWriteGate(ctx, event as any, { decision: "allow", warnings: undefined } as any);
	const call = mocks.checkCoverageWrite.mock.calls.at(-1);
	return call?.[3];
}

describe("editedFileForEvent / depViewForEvent via runCoverageWriteGate", () => {
	it("non-string file_path with no fallback path resolves to no file (kills ba42c33f, dd8821c5, 15a678f9)", async () => {
		const dv = await depViewFor({ file_path: 42 });
		expect(dv).toBeUndefined();
	});

	it("string file_path with no path resolves to that file (kills 3ac13e5e, 487d7f50, c77d983c, 40b433fb, c51fcd53, 71d87c94, e46db68e, 3ae04f11, 2661188e)", async () => {
		const dv = await depViewFor({ file_path: "foo.ts" });
		expect(dv).toBeDefined();
		expect(dv.filePath).toBe("foo.ts");
	});

	it("no file_path, string path falls back to path (kills de2fd745, 08c0176e, ed2bee8d, 54b4c84a, 7cfad7de)", async () => {
		const dv = await depViewFor({ path: "bar.ts" });
		expect(dv?.filePath).toBe("bar.ts");
	});

	it("both file_path and path present prefers file_path (kills 49ab63b3, 19ff540d)", async () => {
		const dv = await depViewFor({ file_path: "foo.ts", path: "other.ts" });
		expect(dv?.filePath).toBe("foo.ts");
	});

	it("no file_path, non-string path resolves to no file (kills 3c72964e, 4b510333)", async () => {
		const dv = await depViewFor({ path: 99 });
		expect(dv).toBeUndefined();
	});

	it("valid apply_patch section resolves the patch's first path (kills 0f1ab2b3, cc0e9a7f, 1cc7bbbb)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("RAW");
		mocks.looksLikeApplyPatch.mockReturnValue(true);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "patched.ts" }]);
		const dv = await depViewFor({});
		expect(dv?.filePath).toBe(path.resolve("/repo", "patched.ts"));
	});

	it("raw text present but not apply-patch shaped resolves to no file (kills d61db841, 6747d0f9, c2e841f5)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("RAW");
		mocks.looksLikeApplyPatch.mockReturnValue(false);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "x.ts" }]);
		const dv = await depViewFor({});
		expect(dv).toBeUndefined();
	});

	it("no raw patch text resolves to no file even if shape check would pass (kills ebf60e7b)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("");
		mocks.looksLikeApplyPatch.mockReturnValue(true);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "y.ts" }]);
		const dv = await depViewFor({});
		expect(dv).toBeUndefined();
	});
});

describe("runCoverageWriteGate fail-loud warnings merge (967af0d592bf538a)", () => {
	it("an empty (but defined) warnings array must not trigger a merge (kills de8d885, d5220a6, 0690eef)", async () => {
		const ctx = makeCtx();
		const originalWarnings = ["existing"];
		mocks.checkCoverageWrite.mockResolvedValue({ decision: "allow", warnings: [] });
		const preDecision = { decision: "allow" as const, warnings: originalWarnings };
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		await runCoverageWriteGate(ctx, event as any, preDecision as any);
		expect(preDecision.warnings).toBe(originalWarnings);
	});
});

describe("mergeWarnings empty-array normalization (38d1706b2920f6fc)", () => {
	it("merging two empty/undefined warning lists on a block decision yields undefined, not an empty array (kills f2519b7, 43996329)", async () => {
		const ctx = makeCtx();
		mocks.checkCoverageWrite.mockResolvedValue({ decision: "block", reason: "x", warnings: undefined });
		const preDecision = { decision: "allow" as const, warnings: undefined };
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		const result = await runCoverageWriteGate(ctx, event as any, preDecision as any);
		expect(result?.warnings).toBeUndefined();
	});
});

describe("runCommitGate (c13dc57da2bd0a31)", () => {
	it("an empty preDecision.warnings must not merge into commitDecision.warnings (kills 24605df, 4a75fef)", async () => {
		const ctx = makeCtx();
		const originalArr = ["orig"];
		mocks.checkCommitGate.mockResolvedValue({ decision: "block", reason: "r", warnings: originalArr });
		const preDecision = { decision: "allow" as const, warnings: [] as string[] };
		const event = { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/repo" };
		const result = await runCommitGate(ctx, event as any, preDecision as any);
		expect(result?.warnings).toBe(originalArr);
	});

	it("a null commitDecision short-circuits cleanly to null (kills 3379b4b)", async () => {
		const ctx = makeCtx();
		mocks.checkCommitGate.mockResolvedValue(null);
		const preDecision = { decision: "allow" as const, warnings: ["x"] };
		const event = { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/repo" };
		await expect(runCommitGate(ctx, event as any, preDecision as any)).resolves.toBeNull();
	});
});

describe("runMutationWriteGate (ca547d5a5d37967e)", () => {
	it("resolves the manifest directory under cwd/.interlinked (kills 322d856)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "valid", manifest: { generation: 1 } });
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		await runMutationWriteGate(ctx, event as any, { decision: "allow", warnings: undefined } as any);
		expect(mocks.loadManifestState).toHaveBeenCalledWith(path.resolve("/repo", ".interlinked"));
	});

	it("a null/undefined manifest falls back to emptyManifest's result, not null (kills 28cf88a)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "missing" });
		const sentinelEmpty = { empty: true, marker: "sentinel" };
		mocks.emptyManifest.mockReturnValue(sentinelEmpty);
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		await runMutationWriteGate(ctx, event as any, { decision: "allow", warnings: undefined } as any);
		const call = mocks.runPerEditMutationGate.mock.calls.at(-1);
		expect(call?.[0]?.baseManifest).toBe(sentinelEmpty);
	});

	it("an empty warnings array must not merge into preDecision.warnings (kills 38818a4, 2b89599, 1ecb350)", async () => {
		const ctx = makeCtx();
		const originalWarnings = ["existing"];
		mocks.runPerEditMutationGate.mockResolvedValue({ decision: "allow", warnings: [] });
		const preDecision = { decision: "allow" as const, warnings: originalWarnings };
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		await runMutationWriteGate(ctx, event as any, preDecision as any);
		expect(preDecision.warnings).toBe(originalWarnings);
	});
});

describe("MUTATION_PLACEHOLDER_META (1235b8c2f630d07b)", () => {
	it("passes the exact placeholder meta fields to emptyManifest (kills 31769158, 4e1a1b9c, 10680075, 518f501d, e37a17dd)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "missing" });
		const event = { tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" };
		await runMutationWriteGate(ctx, event as any, { decision: "allow", warnings: undefined } as any);
		expect(mocks.emptyManifest).toHaveBeenCalledWith({
			engine: "stryker",
			engineVersion: "0",
			dependencyGraphVersion: "0",
			environmentHash: "0",
			authoritativeAt: new Date(0).toISOString(),
		});
	});
});
