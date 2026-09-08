// Targeted mutation-survivor kills for pre-tool-coverage-gates.ts, wave 3.
// Complements pre-tool-coverage-gates.test.ts and .mutation-kill-luna.test.ts,
// which already cover editedFileForEvent/depViewForEvent branch behavior. This
// file targets the remaining survivors: the warnings-merge "no-op on empty"
// guards (reference-identity, since content-equality tests can't see them),
// mergeWarnings' own empty->undefined collapse, runCommitGate's null-decision
// short-circuit, and the mutation gate's manifest-directory / fallback wiring
// including the module-level placeholder-metadata object literal.

import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

vi.mock("../evaluator/coverage-write-guard.js", () => ({ checkCoverageWrite: vi.fn() }));
vi.mock("../evaluator/commit-gate.js", () => ({ checkCommitGate: vi.fn() }));
vi.mock("../mutation/gate.js", () => ({ runPerEditMutationGate: vi.fn() }));
vi.mock("../mutation/manifest.js", () => ({
	loadManifestState: vi.fn(() => ({ kind: "missing" })),
	emptyManifest: vi.fn((meta) => ({ meta, mutants: [] })),
	makeManifestPersister: vi.fn(() => vi.fn()),
}));
vi.mock("../mutation/survivors-index.js", () => ({ makeManifestPersisterWithIndex: vi.fn((_dir, persist) => persist) }));
vi.mock("../mutation/pending-registry.js", () => ({
	overlayHash: vi.fn(() => "overlay-hash"),
	pendingRegistry: vi.fn(() => ({ pending: [] })),
	initPendingRegistryStore: vi.fn(),
	commitPendingRegistry: vi.fn(),
}));
vi.mock("../mutation/pending-runs.js", () => ({ recordPending: vi.fn() }));
vi.mock("../dependency-view.js", () => ({ resolveDependencyView: vi.fn() }));
vi.mock("./runtime-context.js", () => ({ getGraphForFile: vi.fn() }));
vi.mock("../coverage-debt-gate.js", () => ({ applyDebtMode: vi.fn((_event, _cfg, decision) => decision) }));
vi.mock("../debt-evasion.js", () => ({ noteWanderBlockDecision: vi.fn() }));

import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { emptyManifest, loadManifestState } from "../mutation/manifest.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { runCommitGate, runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";

// SAFETY: this import is replaced by a vi.mock factory above.
const coverage = vi.mocked(checkCoverageWrite);
// SAFETY: this import is replaced by a vi.mock factory above.
const commit = vi.mocked(checkCommitGate);
// SAFETY: this import is replaced by a vi.mock factory above.
const mutationGate = vi.mocked(runPerEditMutationGate);
// SAFETY: this import is replaced by a vi.mock factory above.
const mLoadManifestState = vi.mocked(loadManifestState);
// SAFETY: this import is replaced by a vi.mock factory above.
const mEmptyManifest = vi.mocked(emptyManifest);

function event(input: Record<string, unknown> = {}, extra: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "session",
		agent_source: "claude",
		timestamp: "2026-08-21T00:00:00.000Z",
		tool_name: "Write",
		cwd: "/repo",
		tool_input: input,
		...extra,
	};
}

function covCtx(): any {
	return { cwd: "/repo", rules: { per_edit_coverage: { enabled: true } }, sessions: {} };
}

function commitEv(): HarnessEvent {
	return event({ command: "git commit -m x" }, { tool_name: "Bash" });
}

function mutationCtx(cwd = "/repo-mut"): any {
	return { cwd, rules: { per_edit_mutation: { enabled: true, mode: "block" } }, sessions: {} };
}

beforeEach(() => {
	vi.clearAllMocks();
	coverage.mockResolvedValue(null);
	commit.mockResolvedValue(null);
	mutationGate.mockResolvedValue(null);
	mLoadManifestState.mockReturnValue({ kind: "missing" });
});

// --- runCoverageWriteGate: fail-loud-allow merge is a no-op on empty warnings ---
// Content-equality (toEqual) can't distinguish "skipped the merge" from "merged
// with nothing", since mergeWarnings(a, []) === a by value. Reference identity
// (toBe) is the only observable that separates them.

// test-contract: boundary — decision.warnings undefined must short-circuit the merge, not run it.
it("keeps preDecision.warnings by REFERENCE when the coverage decision carries no warnings key", async () => {
	coverage.mockResolvedValue({ decision: "allow" });
	const originalWarnings = ["PRE"];
	// SAFETY: minimal HarnessDecision literal; only decision/warnings are read by the gate under test.
	const preDecision: HarnessDecision = { decision: "allow", warnings: originalWarnings };
	const decision = await runCoverageWriteGate(covCtx(), event(), preDecision);
	expect(decision).toBeNull();
	expect(preDecision.warnings).toBe(originalWarnings);
});

// test-contract: boundary — a truthy-but-empty warnings array must also skip the merge.
it("keeps preDecision.warnings by REFERENCE when the coverage decision's warnings array is empty", async () => {
	coverage.mockResolvedValue({ decision: "allow", warnings: [] });
	const originalWarnings = ["PRE"];
	// SAFETY: minimal HarnessDecision literal; only decision/warnings are read by the gate under test.
	const preDecision: HarnessDecision = { decision: "allow", warnings: originalWarnings };
	const decision = await runCoverageWriteGate(covCtx(), event(), preDecision);
	expect(decision).toBeNull();
	expect(preDecision.warnings).toBe(originalWarnings);
});

// --- mergeWarnings: empty merge collapses to undefined, not [] ---

// test-contract: invariant — mergeWarnings must collapse a zero-length merge to undefined.
it("returns warnings === undefined (never an empty array) when a block and pre-decision both carry none", async () => {
	coverage.mockResolvedValue({ decision: "block", reason: "R" });
	const decision = await runCoverageWriteGate(covCtx(), event(), { decision: "allow" });
	expect(decision?.decision).toBe("block");
	expect(decision?.warnings).toBeUndefined();
});

// --- runCommitGate: the null-commitDecision short-circuit must not be skippable ---

// test-contract: bug — skipping the null check would write to a property of null and throw.
it("returns null with no crash when the commit gate finds nothing, even with pre-existing warnings", async () => {
	commit.mockResolvedValue(null);
	const decision = await runCommitGate(covCtx(), commitEv(), { decision: "allow", warnings: ["PRE"] });
	expect(decision).toBeNull();
});

// test-contract: boundary — an empty pre-decision warnings array must skip the prepend merge.
it("keeps commitDecision.warnings by REFERENCE when pre-decision's warnings array is empty", async () => {
	const originalWarn = ["GATE"];
	commit.mockResolvedValue({ decision: "block", reason: "R", warnings: originalWarn });
	const decision = await runCommitGate(covCtx(), commitEv(), { decision: "allow", warnings: [] });
	expect(decision?.warnings).toBe(originalWarn);
});

// --- runMutationWriteGate: manifest directory + loadManifest-vs-fallback wiring ---

// test-contract: public-api — the manifest lookup path is a fixed, non-empty subdirectory name; a
// wrong directory means loadManifest never finds the real manifest, so the gate silently falls back
// to an empty one (observed via emptyManifest firing where it should not).
it("resolves the manifest directory as cwd + '.interlinked' (module constant)", async () => {
	const ctx = mutationCtx("/repo-mut-a");
	const decision = await runMutationWriteGate(ctx, event(), { decision: "allow" });
	expect(mLoadManifestState).toHaveBeenCalledWith(resolve("/repo-mut-a", ".interlinked"));
	expect(decision).toBeNull();
});

// test-contract: invariant — `??` must prefer a real manifest over the empty-fallback constructor.
it("uses the VALID state's manifest directly (not the emptyManifest fallback) when one is found", async () => {
	const realManifest: import("../mutation/types.js").MutationManifest = { version: 1, generation: 7, files: {}, authoritativeAt: "2026-08-30T00:00:00.000Z", engine: "stryker", engineVersion: "test", dependencyGraphVersion: "test", environmentHash: "test" };
	mLoadManifestState.mockReturnValueOnce({ kind: "valid", manifest: realManifest });
	await runMutationWriteGate(mutationCtx(), event(), { decision: "allow" });
	expect(mutationGate.mock.calls[0]?.[0]?.baseManifest).toBe(realManifest);
	expect(mEmptyManifest).not.toHaveBeenCalled();
});

// test-contract: public-api — the module-level placeholder metadata object must be passed intact;
// pinned via the manifest the mutation gate actually receives (emptyManifest's real return shape),
// not just the call arguments.
it("builds the emptyManifest fallback with the EXACT placeholder metadata when no manifest is found", async () => {
	mLoadManifestState.mockReturnValueOnce({ kind: "missing" });
	const expectedMeta = {
		engine: "stryker",
		engineVersion: "0",
		dependencyGraphVersion: "0",
		environmentHash: "0",
		authoritativeAt: new Date(0).toISOString(),
	};
	await runMutationWriteGate(mutationCtx(), event(), { decision: "allow" });
	expect(mEmptyManifest).toHaveBeenCalledWith(expectedMeta);
	expect(mutationGate.mock.calls[0]?.[0]?.baseManifest).toEqual({ meta: expectedMeta, mutants: [] });
});

// --- runMutationWriteGate: fail-loud-allow merge is a no-op on empty warnings ---

// test-contract: boundary — decision.warnings undefined must short-circuit the merge, not run it.
it("keeps preDecision.warnings by REFERENCE when the mutation decision carries no warnings key", async () => {
	mutationGate.mockResolvedValue({ decision: "allow" });
	const originalWarnings = ["PRE"];
	// SAFETY: minimal HarnessDecision literal; only decision/warnings are read by the gate under test.
	const preDecision: HarnessDecision = { decision: "allow", warnings: originalWarnings };
	const decision = await runMutationWriteGate(mutationCtx(), event(), preDecision);
	expect(decision).toBeNull();
	expect(preDecision.warnings).toBe(originalWarnings);
});

// test-contract: boundary — a truthy-but-empty warnings array must also skip the merge.
it("keeps preDecision.warnings by REFERENCE when the mutation decision's warnings array is empty", async () => {
	mutationGate.mockResolvedValue({ decision: "allow", warnings: [] });
	const originalWarnings = ["PRE"];
	// SAFETY: minimal HarnessDecision literal; only decision/warnings are read by the gate under test.
	const preDecision: HarnessDecision = { decision: "allow", warnings: originalWarnings };
	const decision = await runMutationWriteGate(mutationCtx(), event(), preDecision);
	expect(decision).toBeNull();
	expect(preDecision.warnings).toBe(originalWarnings);
});
