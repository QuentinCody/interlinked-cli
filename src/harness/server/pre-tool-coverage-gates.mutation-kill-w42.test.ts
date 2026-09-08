import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { getDefaultConfig } from "../rules-loader.js";
import { nonNull } from "../../lib/non-null.js";
import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import { ProjectGraph } from "../project-graph.js";
import { InternalDependencyView } from "../dependency-view.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import type { MutationManifest } from "../mutation/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

// All external dependencies of pre-tool-coverage-gates.ts are mocked so each
// test can drive the exact branch a survivor lives in without needing a real
// TS project graph, coverage runner, or mutation runner.
const mocks = vi.hoisted(() => ({
	extractApplyPatchRaw: vi.fn<typeof import("../apply-patch-content.js").extractApplyPatchRaw>(),
	looksLikeApplyPatch: vi.fn<typeof import("../apply-patch-content.js").looksLikeApplyPatch>(),
	parseApplyPatchSections: vi.fn<typeof import("../apply-patch-content.js").parseApplyPatchSections>(),
	applyDebtMode: vi.fn<typeof import("../coverage-debt-gate.js").applyDebtMode>(),
	noteWanderBlockDecision: vi.fn<typeof import("../debt-evasion.js").noteWanderBlockDecision>(),
	resolveDependencyView: vi.fn<typeof import("../dependency-view.js").resolveDependencyView>(),
	checkCommitGate: vi.fn<typeof import("../evaluator/commit-gate.js").checkCommitGate>(),
	checkCoverageWrite: vi.fn<typeof import("../evaluator/coverage-write-guard.js").checkCoverageWrite>(),
	getGraphForFile: vi.fn<typeof import("./runtime-context.js").getGraphForFile>(),
	runPerEditMutationGate: vi.fn<typeof import("../mutation/gate.js").runPerEditMutationGate>(),
	emptyManifest: vi.fn<typeof import("../mutation/manifest.js").emptyManifest>(),
	loadManifestState: vi.fn<typeof import("../mutation/manifest.js").loadManifestState>(),
	makeManifestPersister: vi.fn<typeof import("../mutation/manifest.js").makeManifestPersister>(),
	makeManifestPersisterWithIndex: vi.fn<typeof import("../mutation/survivors-index.js").makeManifestPersisterWithIndex>(),
	overlayHash: vi.fn<typeof import("../mutation/pending-registry.js").overlayHash>(),
	pendingRegistry: vi.fn<typeof import("../mutation/pending-registry.js").pendingRegistry>(),
	recordPending: vi.fn<typeof import("../mutation/pending-runs.js").recordPending>(),
}));

vi.mock("../apply-patch-content.js", () => ({
	extractApplyPatchRaw: mocks.extractApplyPatchRaw,
	looksLikeApplyPatch: mocks.looksLikeApplyPatch,
	parseApplyPatchSections: mocks.parseApplyPatchSections,
}));
vi.mock("../coverage-debt-gate.js", () => ({ applyDebtMode: mocks.applyDebtMode }));
vi.mock("../debt-evasion.js", () => ({ noteWanderBlockDecision: mocks.noteWanderBlockDecision }));
vi.mock("../dependency-view.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../dependency-view.js")>(), resolveDependencyView: mocks.resolveDependencyView }));
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

function makeCtx(overrides: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}) {
 const rules = makeGuardRules();
 rules.per_edit_coverage = { ...nonNull(getDefaultConfig().per_edit_coverage), enabled: true };
 rules.per_edit_mutation = { ...nonNull(getDefaultConfig().per_edit_mutation), enabled: true };
 return makeServerRuntime({ cwd: "/repo", rules, ...overrides });
}
const fixtureGraph = new ProjectGraph("/repo");
const fixtureManifest: MutationManifest = { version: 1, generation: 0, engine: "stryker", engineVersion: "0", dependencyGraphVersion: "0", environmentHash: "0", authoritativeAt: new Date(0).toISOString(), files: {} };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.applyDebtMode.mockImplementation((_event, _cfg, decision) => decision);
	mocks.noteWanderBlockDecision.mockImplementation(() => {});
	mocks.resolveDependencyView.mockImplementation((_filePath, _cwd, graph) => new InternalDependencyView(graph));
	mocks.getGraphForFile.mockReturnValue(fixtureGraph);
	mocks.extractApplyPatchRaw.mockReturnValue("");
	mocks.looksLikeApplyPatch.mockReturnValue(false);
	mocks.parseApplyPatchSections.mockReturnValue([]);
	mocks.checkCoverageWrite.mockResolvedValue(null);
	mocks.checkCommitGate.mockResolvedValue(null);
	mocks.runPerEditMutationGate.mockResolvedValue(null);
	mocks.emptyManifest.mockReturnValue(fixtureManifest);
	mocks.loadManifestState.mockReturnValue({ kind: "missing" });
	mocks.makeManifestPersister.mockReturnValue(() => {});
	mocks.makeManifestPersisterWithIndex.mockReturnValue(() => {});
	mocks.overlayHash.mockReturnValue("hash");
	mocks.pendingRegistry.mockReturnValue({ runs: [] });
	mocks.recordPending.mockImplementation(() => {});
});

async function depViewFor(toolInput: JsonObject) {
	const ctx = makeCtx();
	const event = makeEventFixture({ tool_name: "Write", tool_input: toolInput, cwd: "/repo" });
	await runCoverageWriteGate(ctx, event, { decision: "allow", warnings: undefined });
	return mocks.resolveDependencyView.mock.calls.at(-1)?.[0];
}

describe("editedFileForEvent / depViewForEvent via runCoverageWriteGate", () => {
	it("non-string file_path with no fallback path resolves to no file (kills ba42c33f, dd8821c5, 15a678f9)", async () => {
		const dv = await depViewFor({ file_path: 42 });
		expect(dv).toBeUndefined();
	});

	it("string file_path with no path resolves to that file (kills 3ac13e5e, 487d7f50, c77d983c, 40b433fb, c51fcd53, 71d87c94, e46db68e, 3ae04f11, 2661188e)", async () => {
		const dv = await depViewFor({ file_path: "foo.ts" });
		expect(dv).toBeDefined();
		expect(dv).toBe("foo.ts");
	});

	it("no file_path, string path falls back to path (kills de2fd745, 08c0176e, ed2bee8d, 54b4c84a, 7cfad7de)", async () => {
		const dv = await depViewFor({ path: "bar.ts", op: "update", body: [] });
		expect(dv).toBe("bar.ts");
	});

	it("both file_path and path present prefers file_path (kills 49ab63b3, 19ff540d)", async () => {
		const dv = await depViewFor({ file_path: "foo.ts", path: "other.ts" });
		expect(dv).toBe("foo.ts");
	});

	it("no file_path, non-string path resolves to no file (kills 3c72964e, 4b510333)", async () => {
		const dv = await depViewFor({ path: 99 });
		expect(dv).toBeUndefined();
	});

	it("valid apply_patch section resolves the patch's first path (kills 0f1ab2b3, cc0e9a7f, 1cc7bbbb)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("RAW");
		mocks.looksLikeApplyPatch.mockReturnValue(true);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "patched.ts", op: "update", body: [] }]);
		const dv = await depViewFor({});
		expect(dv).toBe(path.resolve("/repo", "patched.ts"));
	});

	it("raw text present but not apply-patch shaped resolves to no file (kills d61db841, 6747d0f9, c2e841f5)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("RAW");
		mocks.looksLikeApplyPatch.mockReturnValue(false);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "x.ts", op: "update", body: [] }]);
		const dv = await depViewFor({});
		expect(dv).toBeUndefined();
	});

	it("no raw patch text resolves to no file even if shape check would pass (kills ebf60e7b)", async () => {
		mocks.extractApplyPatchRaw.mockReturnValue("");
		mocks.looksLikeApplyPatch.mockReturnValue(true);
		mocks.parseApplyPatchSections.mockReturnValue([{ path: "y.ts", op: "update", body: [] }]);
		const dv = await depViewFor({});
		expect(dv).toBeUndefined();
	});
});

describe("runCoverageWriteGate fail-loud warnings merge (967af0d592bf538a)", () => {
	it("an empty (but defined) warnings array must not trigger a merge (kills de8d885, d5220a6, 0690eef)", async () => {
		const ctx = makeCtx();
		const originalWarnings = ["existing"];
		mocks.checkCoverageWrite.mockResolvedValue({ decision: "allow", warnings: [] });
		const preDecision: HarnessDecision = { decision: "allow" as const, warnings: originalWarnings };
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		await runCoverageWriteGate(ctx, event, preDecision);
		expect(preDecision.warnings).toBe(originalWarnings);
	});
});

describe("mergeWarnings empty-array normalization (38d1706b2920f6fc)", () => {
	it("merging two empty/undefined warning lists on a block decision yields undefined, not an empty array (kills f2519b7, 43996329)", async () => {
		const ctx = makeCtx();
		mocks.checkCoverageWrite.mockResolvedValue({ decision: "block", reason: "x", warnings: undefined });
		const preDecision: HarnessDecision = { decision: "allow" as const, warnings: undefined };
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		const result = await runCoverageWriteGate(ctx, event, preDecision);
		expect(result?.warnings).toBeUndefined();
	});
});

describe("runCommitGate (c13dc57da2bd0a31)", () => {
	it("an empty preDecision.warnings must not merge into commitDecision.warnings (kills 24605df, 4a75fef)", async () => {
		const ctx = makeCtx();
		const originalArr = ["orig"];
		mocks.checkCommitGate.mockResolvedValue({ decision: "block", reason: "r", warnings: originalArr });
		const preDecision: HarnessDecision = { decision: "allow" as const, warnings: [] };
		const event = makeEventFixture({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/repo" });
		const result = await runCommitGate(ctx, event, preDecision);
		expect(result?.warnings).toBe(originalArr);
	});

	it("a null commitDecision short-circuits cleanly to null (kills 3379b4b)", async () => {
		const ctx = makeCtx();
		mocks.checkCommitGate.mockResolvedValue(null);
		const preDecision: HarnessDecision = { decision: "allow" as const, warnings: ["x"] };
		const event = makeEventFixture({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/repo" });
		await expect(runCommitGate(ctx, event, preDecision)).resolves.toBeNull();
	});
});

describe("runMutationWriteGate (ca547d5a5d37967e)", () => {
	it("resolves the manifest directory under cwd/.interlinked (kills 322d856)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "valid", manifest: { ...fixtureManifest, generation: 1 } });
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		await runMutationWriteGate(ctx, event, { decision: "allow", warnings: undefined });
		expect(mocks.loadManifestState).toHaveBeenCalledWith(path.resolve("/repo", ".interlinked"));
	});

	it("a null/undefined manifest falls back to emptyManifest's result, not null (kills 28cf88a)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "missing" });
		const sentinelEmpty: MutationManifest = { ...fixtureManifest, generation: 2 };
		mocks.emptyManifest.mockReturnValue(sentinelEmpty);
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		await runMutationWriteGate(ctx, event, { decision: "allow", warnings: undefined });
		const call = mocks.runPerEditMutationGate.mock.calls.at(-1);
		expect(call?.[0]?.baseManifest).toBe(sentinelEmpty);
	});

	it("an empty warnings array must not merge into preDecision.warnings (kills 38818a4, 2b89599, 1ecb350)", async () => {
		const ctx = makeCtx();
		const originalWarnings = ["existing"];
		mocks.runPerEditMutationGate.mockResolvedValue({ decision: "allow", warnings: [] });
		const preDecision: HarnessDecision = { decision: "allow" as const, warnings: originalWarnings };
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		await runMutationWriteGate(ctx, event, preDecision);
		expect(preDecision.warnings).toBe(originalWarnings);
	});
});

describe("MUTATION_PLACEHOLDER_META (1235b8c2f630d07b)", () => {
	it("passes the exact placeholder meta fields to emptyManifest (kills 31769158, 4e1a1b9c, 10680075, 518f501d, e37a17dd)", async () => {
		const ctx = makeCtx();
		mocks.loadManifestState.mockReturnValue({ kind: "missing" });
		const event = makeEventFixture({ tool_name: "Write", tool_input: { file_path: "foo.ts" }, cwd: "/repo" });
		await runMutationWriteGate(ctx, event, { decision: "allow", warnings: undefined });
		expect(mocks.emptyManifest).toHaveBeenCalledWith({
			engine: "stryker",
			engineVersion: "0",
			dependencyGraphVersion: "0",
			environmentHash: "0",
			authoritativeAt: new Date(0).toISOString(),
		});
	});
});
