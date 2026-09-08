import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock every collaborator so each test can drive appendMutationHarvestWarning's
// internal branches directly, without touching the real registry/runner/fs.
vi.mock("../evaluator/tool-classifiers.js", () => ({
	isFileWrite: vi.fn(),
}));
vi.mock("../mutation/harvest.js", () => ({
	DEFAULT_HARVEST_BUDGET_MS: 12345,
	formatHarvestWarning: vi.fn(),
	harvestPending: vi.fn(),
}));
vi.mock("../mutation/pending-registry.js", () => ({
	overlayHash: vi.fn(),
	pendingRegistry: vi.fn(),
	initPendingRegistryStore: vi.fn(),
	commitPendingRegistry: vi.fn(),
}));
vi.mock("../mutation/pending-runs.js", () => ({
	takePending: vi.fn(),
}));

import { isFileWrite } from "../evaluator/tool-classifiers.js";
import { formatHarvestWarning, harvestPending } from "../mutation/harvest.js";
import { overlayHash, pendingRegistry } from "../mutation/pending-registry.js";
import { takePending } from "../mutation/pending-runs.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { appendMutationHarvestWarning } from "./post-tool-mutation-harvest.js";
import type { ServerRuntime } from "./runtime-context.js";

function makeCtx(cfg: unknown): ServerRuntime {
	return { rules: { per_edit_mutation: cfg }, cwd: "/repo" } as unknown as ServerRuntime;
}

function makeEvent(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return { tool_name: toolName, tool_input: toolInput } as unknown as HarnessEvent;
}

describe("appendMutationHarvestWarning", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(pendingRegistry).mockReturnValue({ runs: [] } as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns early when the tool is not a file write, even though tool_input names a real file", async () => {
		vi.mocked(isFileWrite).mockReturnValue(false);
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Read", { file_path: "target.ts" }),
			decision,
			{},
		);
		expect(decision.warnings).toBeUndefined();
		expect(takePending).not.toHaveBeenCalled();
	});

	it("falls back to `path` when file_path is not a string", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		let capturedFile: string | undefined;
		vi.mocked(takePending).mockImplementation((_store, file) => {
			capturedFile = file as string;
			return [];
		});
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { path: "sub/file.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(capturedFile).toBe("sub/file.ts");
	});

	it("falls back to `path` when file_path resolves to an empty string", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		let capturedFile: string | undefined;
		vi.mocked(takePending).mockImplementation((_store, file) => {
			capturedFile = file as string;
			return [];
		});
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: "", path: "fallback.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(capturedFile).toBe("fallback.ts");
	});

	it("does not treat a non-string file_path as a usable name (must still fall back to path)", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		let capturedFile: string | undefined;
		vi.mocked(takePending).mockImplementation((_store, file) => {
			capturedFile = file as string;
			return [];
		});
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: 123, path: "real.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(capturedFile).toBe("real.ts");
	});

	it("returns early with no takePending call when neither file_path nor path name a file", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(makeCtx({ enabled: true }), makeEvent("Write", {}), decision, {
			readDisk: () => null,
		});
		expect(decision.warnings).toBeUndefined();
		expect(takePending).not.toHaveBeenCalled();
	});

	it("treats an unreadable file as an empty hash without ever hashing null content", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		let capturedHash: string | undefined;
		vi.mocked(takePending).mockImplementation((_store, _file, hash) => {
			capturedHash = hash as string;
			return [];
		});
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(capturedHash).toBe("");
		expect(overlayHash).not.toHaveBeenCalled();
	});

	it("filters pending orphans to the written file only (no cross-file false match)", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([]);
		vi.mocked(pendingRegistry).mockReturnValue({
			runs: [{ file: "other-file.ts", overlayHash: "measured-hash" }],
		} as never);
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => null },
		);
		// The one pending run is for a different file; a correct filter finds no
		// orphan for "target.ts" and stays silent.
		expect(decision.warnings).toBeUndefined();
	});

	it("reports an unreadable-on-disk orphan with the correct hash text, and nothing extra", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([]);
		vi.mocked(pendingRegistry).mockReturnValue({
			runs: [{ file: "target.ts", overlayHash: "measured-hash" }],
		} as never);
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(decision.warnings).toHaveLength(1);
		const msg = decision.warnings?.[0] ?? "";
		expect(msg).toContain("on disk unreadable");
		expect(msg).not.toContain("Stryker was here");
	});

	it("reports a readable-on-disk orphan with the actual hash text, not 'unreadable'", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([]);
		vi.mocked(pendingRegistry).mockReturnValue({
			runs: [{ file: "target.ts", overlayHash: "measured-hash" }],
		} as never);
		vi.mocked(overlayHash).mockReturnValue("current-hash");
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true }),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => "some bytes" },
		);
		expect(decision.warnings).toHaveLength(1);
		const msg = decision.warnings?.[0] ?? "";
		expect(msg).toContain("on disk current-hash");
		expect(msg).not.toContain("on disk unreadable");
	});

	it("does nothing when per_edit_mutation config is absent (guarded before any work happens)", async () => {
		const decision: HarnessDecision = {} as HarnessDecision;
		await expect(
			appendMutationHarvestWarning(makeCtx(undefined), makeEvent("Write", {}), decision, {}),
		).resolves.toBeUndefined();
		expect(decision.warnings).toBeUndefined();
		expect(isFileWrite).not.toHaveBeenCalled();
	});

	it("does nothing when config is absent, even for a qualifying write with pending results", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([{ file: "target.ts" } as never]);
		const decision: HarnessDecision = {} as HarnessDecision;
		await expect(
			appendMutationHarvestWarning(
				makeCtx(undefined),
				makeEvent("Write", { file_path: "target.ts" }),
				decision,
				{ readDisk: () => "x" },
			),
		).resolves.toBeUndefined();
		expect(decision.warnings).toBeUndefined();
		expect(isFileWrite).not.toHaveBeenCalled();
	});

	it("appends the formatted survivor warning without polluting existing/absent warnings", async () => {
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([{ file: "target.ts" } as never]);
		const survivors = [{}];
		vi.mocked(harvestPending).mockResolvedValue({ harvested: 1, survivors } as never);
		vi.mocked(formatHarvestWarning).mockReturnValue("SURVIVOR_FOUND");
		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx({ enabled: true, harvest_budget_ms: 5000 }),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => null },
		);
		expect(decision.warnings).toEqual(["SURVIVOR_FOUND"]);
		expect(formatHarvestWarning).toHaveBeenCalledWith("target.ts", survivors);
	});

	it("builds the harvest request options from resolved config, and the not-measured warning stays clean", async () => {
		const cfg = { enabled: true, harvest_budget_ms: undefined } as unknown as {
			enabled: boolean;
			harvest_budget_ms?: number;
		};
		vi.mocked(isFileWrite).mockReturnValue(true);
		vi.mocked(takePending).mockReturnValue([{ file: "target.ts" } as never]);
		vi.mocked(formatHarvestWarning).mockReturnValue(null);

		const fakeNow = () => 999;
		const fakeSleep = async () => {};
		let capturedOpts: { budgetMs?: number; now?: unknown; sleep?: unknown } | undefined;
		let fetchImplThrew = false;
		vi.mocked(harvestPending).mockImplementation(async (_claimed, fetchImpl, opts) => {
			capturedOpts = opts as typeof capturedOpts;
			try {
				await (fetchImpl as (u: string) => Promise<unknown>)("http://runner/claim");
			} catch {
				fetchImplThrew = true;
			}
			return { harvested: 0, survivors: [] };
		});

		const fetchStub = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchStub);

		const decision: HarnessDecision = {} as HarnessDecision;
		await appendMutationHarvestWarning(
			makeCtx(cfg),
			makeEvent("Write", { file_path: "target.ts" }),
			decision,
			{ readDisk: () => null, now: fakeNow, sleep: fakeSleep },
		);

		// AbortSignal.timeout(claimTimeoutMs) must receive a real number
		// (cfg.harvest_budget_ms ?? DEFAULT_HARVEST_BUDGET_MS = 12345), not a
		// falsy/undefined short-circuit from a stray "&&".
		expect(fetchImplThrew).toBe(false);
		expect(capturedOpts?.budgetMs).toBe(12345);
		expect(capturedOpts?.now).toBe(fakeNow);
		expect(capturedOpts?.sleep).toBe(fakeSleep);

		expect(decision.warnings).toHaveLength(1);
		const msg = decision.warnings?.[0] ?? "";
		expect(msg).toContain("not measured");
		expect(msg).not.toContain("Stryker was here");
	});
});
