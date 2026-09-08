import { nonNull } from "../../lib/non-null.js";
import type { ServerRuntime } from "./runtime-context.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { getDefaultConfig } from "../rules-loader.js";
import type { PerEditMutationConfig } from "../mutation/gate.js";
import { ProjectGraph } from "../project-graph.js";
import { InternalDependencyView } from "../dependency-view.js";
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
vi.mock("../mutation/survivors-index.js", () => ({ makeManifestPersisterWithIndex: vi.fn((persist) => persist) }));
vi.mock("../mutation/pending-registry.js", () => ({
	overlayHash: vi.fn(() => "overlay-hash"),
	pendingRegistry: vi.fn(() => ({ pending: [] })),
	initPendingRegistryStore: vi.fn(),
	commitPendingRegistry: vi.fn(),
}));
vi.mock("../mutation/pending-runs.js", () => ({ recordPending: vi.fn() }));
vi.mock("../dependency-view.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../dependency-view.js")>(), resolveDependencyView: vi.fn() }));
vi.mock("./runtime-context.js", () => ({ getGraphForFile: vi.fn() }));
vi.mock("../coverage-debt-gate.js", () => ({ applyDebtMode: vi.fn((_event, _cfg, decision) => decision) }));
vi.mock("../debt-evasion.js", () => ({ noteWanderBlockDecision: vi.fn() }));

import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { resolveDependencyView } from "../dependency-view.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { getGraphForFile } from "./runtime-context.js";
import { runCommitGate, runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";

// SAFETY: this import is replaced by a vi.mock factory above.
const coverage = vi.mocked(checkCoverageWrite);
// SAFETY: this import is replaced by a vi.mock factory above.
const commit = vi.mocked(checkCommitGate);
// SAFETY: this import is replaced by a vi.mock factory above.
const mutation = vi.mocked(runPerEditMutationGate);
// SAFETY: this import is replaced by a vi.mock factory above.
const graph = vi.mocked(getGraphForFile);
// SAFETY: this import is replaced by a vi.mock factory above.
const view = vi.mocked(resolveDependencyView);

const fixtureGraph = new ProjectGraph("/repo");
const fixtureView = new InternalDependencyView(fixtureGraph);

function event(input: Record<string, unknown> = {}, extra: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "session",
		agent_source: "claude",
		timestamp: "2026-08-20T00:00:00.000Z",
		tool_name: "Edit",
		cwd: "/repo",
		tool_input: input,
		...extra,
	};
}

function allow(warnings?: string[]): HarnessDecision {
	return warnings ? { decision: "allow", warnings } : { decision: "allow" };
}

function coverageContext(): ServerRuntime {
 const rules = makeGuardRules();
 rules.per_edit_coverage = { ...nonNull(getDefaultConfig().per_edit_coverage), enabled: true };
 return makeServerRuntime({ cwd: "/repo", rules });
}

function mutationContext(cfg: Partial<PerEditMutationConfig>): ServerRuntime {
 const rules = makeGuardRules();
 rules.per_edit_mutation = { ...nonNull(getDefaultConfig().per_edit_mutation), ...cfg };
 return makeServerRuntime({ cwd: "/repo", rules });
}

beforeEach(() => {
	vi.clearAllMocks();
	coverage.mockResolvedValue(null);
	commit.mockResolvedValue(null);
	mutation.mockResolvedValue(null);
	graph.mockReturnValue(fixtureGraph);
	view.mockReturnValue(fixtureView);
});

it("passes a string file_path to dependency resolution", async () => {
	// test-contract: public-api — Write/Edit file_path is the primary dependency-view seed.
	await runCoverageWriteGate(coverageContext(), event({ file_path: "src/main.ts" }), allow());
	expect(graph).toHaveBeenCalledWith(expect.anything(), "src/main.ts");
	expect(view).toHaveBeenCalledWith("src/main.ts", "/repo", fixtureGraph);
	expect(coverage.mock.calls[0]?.[3]).toEqual(fixtureView);
});

it("rejects a non-string file_path and uses a string path", async () => {
	// test-contract: boundary — malformed file_path must not masquerade as a usable path.
	await runCoverageWriteGate(coverageContext(), event({ file_path: 42, path: "src/fallback.ts" }), allow());
	expect(graph).toHaveBeenCalledWith(expect.anything(), "src/fallback.ts");
	expect(view).toHaveBeenCalledWith("src/fallback.ts", "/repo", fixtureGraph);
});

it("rejects a non-string path when no usable named path exists", async () => {
	// test-contract: security — process-boundary payload types must fail open to full-suite selection.
	await runCoverageWriteGate(coverageContext(), event({ file_path: 42, path: { bad: true } }), allow());
	expect(graph).not.toHaveBeenCalled();
	expect(view).not.toHaveBeenCalled();
	expect(coverage.mock.calls[0]?.[3]).toBeUndefined();
});

it("prefers a non-empty file_path over path", async () => {
	// test-contract: invariant — the explicit file_path field wins when both names are present.
	await runCoverageWriteGate(coverageContext(), event({ file_path: "src/first.ts", path: "src/second.ts" }), allow());
	expect(graph).toHaveBeenCalledWith(expect.anything(), "src/first.ts");
});

it("falls through an empty file_path to path", async () => {
	// test-contract: boundary — an empty primary name is absent, not a valid seed.
	await runCoverageWriteGate(coverageContext(), event({ file_path: "", path: "src/second.ts" }), allow());
	expect(graph).toHaveBeenCalledWith(expect.anything(), "src/second.ts");
});

it("resolves the first apply_patch section against event.cwd", async () => {
	// test-contract: public-api — apply_patch carries its target in the first section, not file_path.
	await runCoverageWriteGate(
		coverageContext(),
		event({ command: "*** Begin Patch\n*** Add File: src/patched.ts\n+new\n*** End Patch" }),
		allow(),
	);
	expect(graph).toHaveBeenCalledWith(expect.anything(), "/repo/src/patched.ts");
});

it("extracts patch paths from patch and raw-patch input keys", async () => {
	// test-contract: public-api — supported patch transport keys must all reach the same path resolver.
	for (const key of ["patch", "_raw_patch", "content"]) {
		vi.clearAllMocks();
		coverage.mockResolvedValue(null);
		graph.mockReturnValue(fixtureGraph);
		view.mockReturnValue(fixtureView);
		await runCoverageWriteGate(
			coverageContext(),
			event({ [key]: `*** Begin Patch\n*** Add File: src/${key}.ts\n+x\n*** End Patch` }),
			allow(),
		);
		expect(graph).toHaveBeenCalledWith(expect.anything(), `/repo/src/${key}.ts`);
	}
});

it("rejects plain content and an empty patch", async () => {
	// test-contract: boundary — ordinary file content and patch sentinels without sections have no seed.
	await runCoverageWriteGate(coverageContext(), event({ content: "plain text" }), allow());
	expect(graph).not.toHaveBeenCalled();
	await runCoverageWriteGate(coverageContext(), event({ content: "*** Begin Patch\n*** End Patch" }), allow());
	expect(graph).not.toHaveBeenCalled();
});

it("returns no dependency view when graph construction or view resolution fails", async () => {
	// test-contract: invariant — dependency analysis failures must select the safe full-suite fallback.
	graph.mockImplementation(() => { throw new Error("graph unavailable"); });
	await runCoverageWriteGate(coverageContext(), event({ file_path: "src/fail.ts" }), allow());
	expect(coverage.mock.calls[0]?.[3]).toBeUndefined();
	graph.mockReturnValue(fixtureGraph);
	view.mockImplementation(() => { throw new Error("view unavailable"); });
	await runCoverageWriteGate(coverageContext(), event({ file_path: "src/fail-view.ts" }), allow());
	expect(coverage.mock.calls[1]?.[3]).toBeUndefined();
});

it("returns an exact block and merges evaluator warnings first", async () => {
	// test-contract: public-api — block metadata and warning ordering are propagated without rewriting.
	const blocked: HarnessDecision = { decision: "block", reason: "exact-reason", rule_id: "coverage", warnings: ["gate"] };
	coverage.mockResolvedValue(blocked);
	const result = await runCoverageWriteGate(coverageContext(), event({ file_path: "src/x.ts" }), allow(["pre"]));
	expect(result).toEqual({ ...blocked, warnings: ["pre", "gate"] });
});

it("continues on a clean allow and preserves an existing empty warning boundary", async () => {
	// test-contract: boundary — null and warning-free allow decisions must not synthesize warnings or blocks.
	const pre = allow([]);
	coverage.mockResolvedValue({ decision: "allow", warnings: [] });
	expect(await runCoverageWriteGate(coverageContext(), event(), pre)).toBeNull();
	expect(pre.warnings).toEqual([]);
});

it("merges a fail-open warning after pre-existing warnings", async () => {
	// test-contract: bug — fail-open evaluator warnings must remain visible while the pipeline continues.
	coverage.mockResolvedValue({ decision: "allow", warnings: ["coverage-warning"] });
	const pre = allow(["pre"]);
	expect(await runCoverageWriteGate(coverageContext(), event(), pre)).toBeNull();
	expect(pre.warnings).toEqual(["pre", "coverage-warning"]);
});

it("skips coverage for disabled config and upstream blocks", async () => {
	// test-contract: invariant — both configuration opt-out and prior blocks short-circuit the expensive gate.
	await runCoverageWriteGate(makeServerRuntime(), event(), allow());
	await runCoverageWriteGate(coverageContext(), event(), { decision: "block", reason: "upstream" });
	expect(coverage).not.toHaveBeenCalled();
});

it("skips commit checks for non-Bash, disabled, and upstream-blocked events", async () => {
	// test-contract: boundary — commit quality checks only run for enabled Bash events after an allow.
	await runCommitGate(makeServerRuntime(), event({}, { tool_name: "Bash" }), allow());
	await runCommitGate(coverageContext(), event({}, { tool_name: "Write" }), allow());
	await runCommitGate(coverageContext(), event({}, { tool_name: "Bash" }), { decision: "block", reason: "upstream" });
	expect(commit).not.toHaveBeenCalled();
});

it("returns exact commit block metadata and warning order", async () => {
	// test-contract: public-api — commit-gate decision fields are returned intact with accumulated warnings first.
	const blocked: HarnessDecision = { decision: "block", reason: "commit-reason", rule_id: "commit-gate", warnings: ["commit-warning"] };
	commit.mockResolvedValue(blocked);
	const result = await runCommitGate(coverageContext(), event({ command: "git commit" }, { tool_name: "Bash" }), allow(["pre"]));
	expect(result).toEqual({ ...blocked, warnings: ["pre", "commit-warning"] });
});

it("returns null for a clean commit and calls the evaluator once", async () => {
	// test-contract: public-api — an enabled Bash commit with no finding continues the pipeline.
	expect(await runCommitGate(coverageContext(), event({ command: "git commit" }, { tool_name: "Bash" }), allow())).toBeNull();
	expect(commit).toHaveBeenCalledOnce();
});

it("skips mutation when disabled or already blocked", async () => {
	// test-contract: invariant — mutation measurement is default-off and never runs after an upstream block.
	await runMutationWriteGate(mutationContext({ enabled: false }), event(), allow());
	await runMutationWriteGate(mutationContext({ enabled: true }), event(), { decision: "block", reason: "upstream" });
	expect(mutation).not.toHaveBeenCalled();
});

it("passes an empty tool name and null runner when mutation has no URL", async () => {
	// test-contract: boundary — malformed optional tool metadata and absent runner degrade to honest measurement.
	mutation.mockResolvedValue(null);
	await runMutationWriteGate(mutationContext({ enabled: true }), event({}, { tool_name: undefined }), allow());
	expect(mutation.mock.calls[0]?.[0]?.toolName).toBe("");
	expect(mutation.mock.calls[0]?.[0]?.runner).toBeNull();
});

it("propagates mutation blocks and fail-open warnings", async () => {
	// test-contract: public-api — mutation decisions use the same block/allow warning contract as coverage.
	mutation.mockResolvedValueOnce({ decision: "block", reason: "mutation-reason", rule_id: "mutation", warnings: ["mut"] });
	const blocked = await runMutationWriteGate(mutationContext({ enabled: true }), event({ file_path: "src/x.ts" }), allow(["pre"]));
	expect(blocked).toEqual({ decision: "block", reason: "mutation-reason", rule_id: "mutation", warnings: ["pre", "mut"] });
	mutation.mockResolvedValueOnce({ decision: "allow", warnings: ["not-measured"] });
	const pre = allow(["pre"]);
	 expect(await runMutationWriteGate(mutationContext({ enabled: true }), event(), pre)).toBeNull();
	expect(pre.warnings).toEqual(["pre", "not-measured"]);
});
