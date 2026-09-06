// Behavioral coverage for the two config-gated coverage phase helpers extracted
// from the PreToolUse pipeline orchestrator. `checkCoverageWrite` (per-edit) and
// `checkCommitGate` (commit-time) are mocked at the import boundary so each
// helper's gating / merge logic is driven deterministically without a real
// suite, git, or overlay.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { SessionTracker } from "../session-state.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../evaluator/coverage-write-guard.js", () => ({
	checkCoverageWrite: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../evaluator/commit-gate.js", () => ({
	checkCommitGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../mutation/gate.js", () => ({
	runPerEditMutationGate: vi.fn(async (): Promise<HarnessDecision | null> => null),
}));

vi.mock("../mutation/manifest.js", () => ({
	// Review 2026-08-28 item 4: the wiring reads the tri-state loader, and only
	// `missing` may bootstrap an adoptable empty baseline. Default = missing;
	// the corrupt-manifest test overrides per-case.
	loadManifestState: vi.fn(() => ({ kind: "missing" })),
	emptyManifest: vi.fn(() => ({ mutants: [] })),
	// The wiring hands the gate a real fs persister (measured-clean passes save
	// the manifest + append a receipt); a noop factory keeps these tests disk-free.
	makeManifestPersister: vi.fn(() => vi.fn()),
}));

vi.mock("../mutation/cloud-runner.js", () => ({
	createCloudMutationRunner: vi.fn(() => ({ runOverlay: vi.fn() })),
}));

import { checkCommitGate } from "../evaluator/commit-gate.js";
import { checkCoverageWrite } from "../evaluator/coverage-write-guard.js";
import { createCloudMutationRunner } from "../mutation/cloud-runner.js";
import { runPerEditMutationGate } from "../mutation/gate.js";
import { runCommitGate, runCoverageWriteGate, runMutationWriteGate } from "./pre-tool-coverage-gates.js";

const mCheckCoverage = checkCoverageWrite as unknown as Mock;
const mCheckCommit = checkCommitGate as unknown as Mock;
const mMutation = runPerEditMutationGate as unknown as Mock;
const mCreateRunner = createCloudMutationRunner as unknown as Mock;

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-06-07T00:00:00.000Z",
		...partial,
	};
}

function ctxWith(perEditEnabled: boolean): ServerRuntime {
	const rules = {
		per_edit_coverage: perEditEnabled
			? { enabled: true, mode: "block", budget_ms: 25_000, languages: ["js", "ts"] }
			: undefined,
	} as unknown as GuardRulesConfig;
	return { rules } as unknown as ServerRuntime;
}

function ctxMutation(cfg: unknown): ServerRuntime {
	return {
		rules: { per_edit_mutation: cfg } as unknown as GuardRulesConfig,
		cwd: "/tmp/harness-mutation-test",
	} as unknown as ServerRuntime;
}

function allow(warnings?: string[]): HarnessDecision {
	return warnings ? { decision: "allow", warnings } : { decision: "allow" };
}

describe("runCoverageWriteGate — debt-evasion arming (2026-07-17)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "gates-evasion-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function ctxDebt(sessions: SessionTracker): ServerRuntime {
		const rules = {
			per_edit_coverage: {
				enabled: true,
				mode: "block",
				budget_ms: 25_000,
				languages: ["ts"],
				debt_mode: true,
			},
		} as unknown as GuardRulesConfig;
		return { rules, sessions, cwd: root, log: () => {} } as unknown as ServerRuntime;
	}

	function editEv(session: string, file: string): HarnessEvent {
		return ev({
			session_id: session,
			tool_name: "Edit",
			cwd: root,
			tool_input: { file_path: join(root, file) },
		});
	}

	/** A base-gate uncovered block (carries the marker debt-mode folds on). */
	function uncoveredBlock(file: string): HarnessDecision {
		return {
			decision: "block",
			reason: `[interlinked:coverage] BLOCKED: ${file} line 5 is executable but uncovered by the test suite after this edit.`,
			rule_id: "per-edit-coverage",
		};
	}

	it("arms the session's evasion counter when the debt gate wander-blocks", async () => {
		const sessions = new SessionTracker();
		sessions.recordEvent(editEv("dbt", "src/foo.ts"));
		const ctx = ctxDebt(sessions);
		// Edit 1: uncovered source → debt opens, allow (warnings merged, null returned).
		mCheckCoverage.mockResolvedValueOnce(uncoveredBlock("src/foo.ts"));
		const first = await runCoverageWriteGate(ctx, editEv("dbt", "src/foo.ts"), allow());
		expect(first).toBeNull();
		expect(sessions.get("dbt")?.debt_wander_blocked_at_ms).toBeUndefined();
		// Edit 2: unrelated file while own debt open → wander block arms the counter.
		mCheckCoverage.mockResolvedValueOnce(null);
		const second = await runCoverageWriteGate(ctx, editEv("dbt", "src/bar.ts"), allow());
		expect(second?.decision).toBe("block");
		expect(sessions.get("dbt")?.debt_wander_blocked_at_ms).toBeDefined();
	});

	it("does not arm on a clean pass-through", async () => {
		const sessions = new SessionTracker();
		sessions.recordEvent(editEv("clean", "src/foo.ts"));
		mCheckCoverage.mockResolvedValueOnce(null);
		const out = await runCoverageWriteGate(ctxDebt(sessions), editEv("clean", "src/foo.ts"), allow());
		expect(out).toBeNull();
		expect(sessions.get("clean")?.debt_wander_blocked_at_ms).toBeUndefined();
	});
});

beforeEach(() => {
	vi.clearAllMocks();
	mCheckCoverage.mockResolvedValue(null);
	mCheckCommit.mockResolvedValue(null);
	mMutation.mockResolvedValue(null);
	mCreateRunner.mockReturnValue({ runOverlay: vi.fn() });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("runCoverageWriteGate", () => {
	it("no-op (guard never called) when per_edit_coverage is absent", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(false),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).not.toHaveBeenCalled();
	});

	it("no-op when the pre-decision is already a block", async () => {
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), {
			decision: "block",
			reason: "upstream",
		});
		expect(decision).toBeNull();
		expect(mCheckCoverage).not.toHaveBeenCalled();
	});

	it("returns the guard block and copies pre-decision warnings onto it", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "block", reason: "R" });
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings).toEqual(["PRE"]);
	});

	it("returns null (continue) when the guard finds nothing", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("PROPAGATES a fail-loud allow-decision's warning onto the running decision (not dropped)", async () => {
		// The guard degraded (no coverage provider) → it returns ALLOW + a warning
		// rather than a bare null. The gate must NOT drop it: it merges the warning
		// onto preDecision (so it rides to the agent) and returns null to continue
		// the pipeline. This is the regression pin against the silent-fail-open bug
		// where `if (!coverageBlock) return null` discarded any non-block decision.
		const COV_WARN = "[interlinked:coverage] WARNING: gate ON for ts but could not run — install @vitest/coverage-v8.";
		mCheckCoverage.mockResolvedValue({ decision: "allow", warnings: [COV_WARN] });
		const preDecision = allow();
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		// Continues the pipeline (does not short-circuit on a non-block)…
		expect(decision).toBeNull();
		// …but the warning was merged onto the running decision the pipeline returns.
		expect(preDecision.warnings).toEqual([COV_WARN]);
	});

	it("merges a fail-loud allow's warning AFTER any pre-existing warnings (order preserved)", async () => {
		const COV_WARN = "[interlinked:coverage] WARNING: this edit was NOT coverage-checked.";
		mCheckCoverage.mockResolvedValue({ decision: "allow", warnings: [COV_WARN] });
		const preDecision = allow(["PRE"]);
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toEqual(["PRE", COV_WARN]);
	});

	it("an allow-decision WITHOUT warnings is a clean continue (no spurious warning added)", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "allow" });
		const preDecision = allow();
		const decision = await runCoverageWriteGate(ctxWith(true), ev({ tool_name: "Write" }), preDecision);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toBeUndefined();
	});

	it("a block carrying its OWN warnings keeps them, with pre-decision warnings first", async () => {
		mCheckCoverage.mockResolvedValue({ decision: "block", reason: "R", warnings: ["COV-BLOCK"] });
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		// Merge, not overwrite: the old code clobbered the block's own warnings.
		expect(decision?.warnings).toEqual(["PRE", "COV-BLOCK"]);
	});
});

describe("runCoverageWriteGate — editedFileForEvent branch coverage (apply_patch path resolution)", () => {
	// editedFileForEvent isn't exported; each branch is exercised indirectly by
	// driving runCoverageWriteGate with a shaped tool_input and asserting the
	// gate still runs to completion (depViewForEvent fails open on any error).
	it("uses tool_input.path when file_path is absent", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Edit", cwd: "/repo", tool_input: { path: "src/x.ts" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("no named path and no apply_patch payload at all (raw is empty)", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Edit", cwd: "/repo", tool_input: {} }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("raw content present but does not look like an apply_patch payload", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({ tool_name: "Edit", cwd: "/repo", tool_input: { content: "just plain file text, no directives" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("apply_patch payload with no file sections (first section is undefined)", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({
				tool_name: "Edit",
				cwd: "/repo",
				tool_input: { content: "*** Begin Patch\n*** End Patch" },
			}),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("apply_patch payload with a real section, event.cwd present (resolves against it)", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({
				tool_name: "Edit",
				cwd: "/repo",
				tool_input: {
					content: "*** Begin Patch\n*** Add File: src/y.ts\n+hello\n*** End Patch",
				},
			}),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});

	it("apply_patch payload with a real section, event.cwd absent (falls back to process.cwd())", async () => {
		const decision = await runCoverageWriteGate(
			ctxWith(true),
			ev({
				tool_name: "Edit",
				tool_input: {
					content: "*** Begin Patch\n*** Add File: src/z.ts\n+hello\n*** End Patch",
				},
			}),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCoverage).toHaveBeenCalledOnce();
	});
});

describe("runCommitGate", () => {
	it("no-op (gate never called) when per_edit_coverage is absent", async () => {
		const decision = await runCommitGate(
			ctxWith(false),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("no-op for a non-Bash tool even when enabled", async () => {
		const decision = await runCommitGate(ctxWith(true), ev({ tool_name: "Write" }), allow());
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("no-op when the pre-decision is already a block", async () => {
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			{ decision: "block", reason: "upstream" },
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).not.toHaveBeenCalled();
	});

	it("returns the gate block when enabled + Bash + the gate blocks", async () => {
		mCheckCommit.mockResolvedValue({ decision: "block", reason: "[interlinked:commit-gate] BLOCKED" });
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("[interlinked:commit-gate]");
		expect(mCheckCommit).toHaveBeenCalledOnce();
	});

	it("merges pre-decision warnings ahead of the gate's own warnings", async () => {
		mCheckCommit.mockResolvedValue({
			decision: "block",
			reason: "R",
			warnings: ["GATE-NO-VERIFY"],
		});
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x --no-verify" } }),
			allow(["PRE"]),
		);
		expect(decision?.warnings).toEqual(["PRE", "GATE-NO-VERIFY"]);
	});

	it("merges pre-decision warnings even when the gate's own block carries none", async () => {
		mCheckCommit.mockResolvedValue({ decision: "block", reason: "R" });
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(["PRE"]),
		);
		expect(decision?.warnings).toEqual(["PRE"]);
	});

	it("returns null (continue) when the gate finds nothing (clean commit)", async () => {
		const decision = await runCommitGate(
			ctxWith(true),
			ev({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mCheckCommit).toHaveBeenCalledOnce();
	});
});

describe("runMutationWriteGate", () => {
	it("no-op (gate never called) when the pre-decision is already a block", async () => {
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			{ decision: "block", reason: "upstream" },
		);
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	// CLAUDE.md: "A dry run must not move the gate." `harness test --write/--edit`
	// sets `dry_run` on a synthetic event. Without this guard the mutation gate
	// ran for real on an edit that never happened — persisting a refreshed
	// manifest, appending a receipt, writing a run-log row and committing the
	// pending registry. It was missed because this gate's persistence is
	// indirect (a `persist` callback), not a visible file write.
	it("N: a dry_run event never reaches the gate — no run, no persistence", async () => {
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write", dry_run: true }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("no-op (default OFF, gate never called) when per_edit_mutation is absent", async () => {
		const decision = await runMutationWriteGate(ctxMutation(undefined), ev({ tool_name: "Write" }), allow());
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("no-op when per_edit_mutation is present but disabled (the inert default path)", async () => {
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: false, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("enabled + no runner_url: runs the gate with a NULL runner and builds no cloud runner", async () => {
		mMutation.mockResolvedValue(null);
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation).toHaveBeenCalledOnce();
		expect(mMutation.mock.calls[0]?.[0]?.runner).toBeNull();
		expect(mCreateRunner).not.toHaveBeenCalled();
	});

	it("falls back to an empty string toolName when event.tool_name is undefined", async () => {
		mMutation.mockResolvedValue(null);
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: undefined }),
			allow(),
		);
		expect(decision).toBeNull();
		expect(mMutation.mock.calls[0]?.[0]?.toolName).toBe("");
	});

	it("enabled + runner_url: lazily builds the cloud runner and passes it to the gate", async () => {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block", runner_url: "https://runner.example" }),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(mCreateRunner).toHaveBeenCalledOnce();
		expect(mMutation.mock.calls[0]?.[0]?.runner).not.toBeNull();
	});

	it("reuses the daemon graph and passes differently-named affected tests as a complete scope", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-scope-gate-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "subject.ts"), "export const subject = 1;\n");
			writeFileSync(
				join(root, "src", "subject-roundtrip.test.ts"),
				'import { subject } from "./subject.js";\nvoid subject;\n',
			);
			const runtime = {
				...ctxMutation({ enabled: true, mode: "block" }),
				cwd: root,
				graphCache: new Map(),
				log: () => {},
			} as unknown as ServerRuntime;
			await runMutationWriteGate(
				runtime,
				ev({ tool_name: "Write", tool_input: { file_path: "src/subject.ts", content: "export const subject = 2;\n" } }),
				allow(),
			);
			expect(mMutation.mock.calls[0]?.[0]?.selectTests("src/subject.ts")).toEqual({
				kind: "selected",
				options: { testFiles: ["src/subject-roundtrip.test.ts"], scopeMode: "import_graph" },
				partial: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks an over-cap companion-only selection partial so it cannot certify clean", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-scope-cap-"));
		try {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "subject.ts"), "export const subject = 1;\n");
			writeFileSync(
				join(root, "src", "subject.mutation-kill.test.ts"),
				'import { subject } from "./subject.js";\nvoid subject;\n',
			);
			const runtime = {
				...ctxMutation({ enabled: true, mode: "block", max_test_scope: 0 }),
				cwd: root,
				graphCache: new Map(),
				log: () => {},
			} as unknown as ServerRuntime;
			await runMutationWriteGate(
				runtime,
				ev({ tool_name: "Write", tool_input: { file_path: "src/subject.ts", content: "export const subject = 2;\n" } }),
				allow(),
			);
			expect(mMutation.mock.calls[0]?.[0]?.selectTests("src/subject.ts")).toEqual({
				kind: "selected",
				options: { testFiles: ["src/subject.mutation-kill.test.ts"], scopeMode: "companion_fallback" },
				partial: true,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// SHARDING RETIRED FROM v1 (review passes 11-18): line-range partitioning
	// loses boundary-spanning mutants, so multi-URL fan-out and cloud_shards
	// no longer build sharded runners (the sharded-runner module is deleted).
	// ONE runner, whole file; extra urls are a dormant failover seam.
	it("N: multiple runner_urls build ONE runner on the primary — never a sharded partition", async () => {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(
			ctxMutation({
				enabled: true,
				mode: "block",
				runner_url: "https://runner-a.example",
				runner_urls: ["https://runner-b.example", ""],
			}),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(mCreateRunner).toHaveBeenCalledTimes(1);
		expect(mCreateRunner.mock.calls[0]?.[0]?.url).toBe("https://runner-a.example");
	});

	it("N: cloud_shards is IGNORED — one un-shard-tagged runner regardless of the knob", async () => {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(
			ctxMutation({
				enabled: true,
				mode: "block",
				runner_url: "https://runner.example",
				cloud_shards: 3,
			}),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(mCreateRunner).toHaveBeenCalledTimes(1);
		expect(mCreateRunner.mock.calls[0]?.[0]?.shard).toBeUndefined();
	});

	it("N: cloud_shards + multiple urls still yields exactly one runner, no shard tags", async () => {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(
			ctxMutation({
				enabled: true,
				mode: "block",
				runner_url: "https://runner-a.example",
				runner_urls: ["https://runner-b.example"],
				cloud_shards: 4,
			}),
			ev({ tool_name: "Write" }),
			allow(),
		);
		expect(mCreateRunner).toHaveBeenCalledTimes(1);
		for (const call of mCreateRunner.mock.calls) {
			expect(call[0]?.shard).toBeUndefined();
		}
	});

	it("N: cloud_shards of 1, 0, or nonsense stays the unsharded single-runner path", async () => {
		mMutation.mockResolvedValue(null);
		for (const bad of [1, 0, -2, 1.5, Number.NaN]) {
			mCreateRunner.mockClear();
			await runMutationWriteGate(
				ctxMutation({
					enabled: true,
					mode: "block",
					runner_url: "https://runner.example",
					cloud_shards: bad,
				}),
				ev({ tool_name: "Write" }),
				allow(),
			);
			expect(mCreateRunner).toHaveBeenCalledOnce();
			expect(mCreateRunner.mock.calls[0]?.[0]?.shard).toBeUndefined();
		}
	});

	it("returns the gate's block, merging pre-decision warnings onto it", async () => {
		mMutation.mockResolvedValue({ decision: "block", reason: "[mutation] survivor", warnings: ["MUT"] });
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			allow(["PRE"]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.warnings).toEqual(["PRE", "MUT"]);
	});

	it("merges a not-measured allow's warning onto preDecision and continues (null)", async () => {
		const MUT_WARN = "[mutation:not-measured] cloud runner unavailable";
		mMutation.mockResolvedValue({ decision: "allow", warnings: [MUT_WARN] });
		const preDecision = allow();
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			preDecision,
		);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toEqual([MUT_WARN]);
	});

	it("a bare allow with no warnings is a clean continue (no spurious warning)", async () => {
		mMutation.mockResolvedValue({ decision: "allow" });
		const preDecision = allow();
		const decision = await runMutationWriteGate(
			ctxMutation({ enabled: true, mode: "block" }),
			ev({ tool_name: "Write" }),
			preDecision,
		);
		expect(decision).toBeNull();
		expect(preDecision.warnings).toBeUndefined();
	});

	// Review 2026-08-28 (second pass, finding 1): a corrupt manifest must not
	// become a fresh adoption, AND the exit must obey the operator's
	// `unavailable_behavior` policy through the one choke point — the first
	// version of this pin hand-built an allow, silently bypassing fail-closed.
	// In every case the gate itself never runs, so even a clean runner result
	// can persist nothing.
	async function corruptManifestCase(cfg: Record<string, unknown>) {
		const { loadManifestState } = await import("../mutation/manifest.js");
		(loadManifestState as unknown as Mock).mockReturnValueOnce({
			kind: "corrupt",
			detail: "Unexpected token < in JSON",
		});
		mMutation.mockResolvedValue({ decision: "allow" }); // a clean runner result, were it reached
		return runMutationWriteGate(ctxMutation(cfg), ev({ tool_name: "Write" }), allow());
	}

	it("P: corrupt + unavailable_behavior=block ⇒ BLOCKS (fail-closed policy governs)", async () => {
		const d = await corruptManifestCase({ enabled: true, mode: "block", unavailable_behavior: "block" });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("corrupt");
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("P: corrupt + allow_unmeasured ⇒ honest not-measured warning, file preserved", async () => {
		const d = await corruptManifestCase({
			enabled: true,
			mode: "block",
			unavailable_behavior: "allow_unmeasured",
		});
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("[mutation:not-measured]");
		expect(d?.warnings?.[0]).toContain("preserved");
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("P: corrupt + WARN mode downgrades the fail-closed block to allow + warning", async () => {
		const d = await corruptManifestCase({ enabled: true, mode: "warn", unavailable_behavior: "block" });
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("corrupt");
		expect(mMutation).not.toHaveBeenCalled();
	});

	it("N: mode=off produces NOTHING — not even a warning", async () => {
		const d = await corruptManifestCase({ enabled: true, mode: "off", unavailable_behavior: "block" });
		expect(d).toBeNull();
		expect(mMutation).not.toHaveBeenCalled();
	});
});

// The gate hands `runPerEditMutationGate` three callbacks it never invokes
// itself — `selectTests`, `readDisk`, `persist`. Each is captured off the mocked
// gate's first call and driven directly, so the decline reasons, the read
// fallback and the two persisted artifacts are asserted as values rather than
// inferred from the gate having run.
describe("runMutationWriteGate — the callbacks handed to the gate", () => {
	/** Run the gate once against `runtime`/`event` and return the arg object it
	 *  was called with (carrying selectTests / readDisk / persist). */
	async function callbacks(runtime: ServerRuntime, event: HarnessEvent) {
		mMutation.mockResolvedValue(null);
		await runMutationWriteGate(runtime, event, allow());
		return mMutation.mock.calls[0]?.[0];
	}

	/** A runtime rooted at a real temp dir, with the daemon's graph cache. */
	function rootedRuntime(root: string, cfg: Record<string, unknown>): ServerRuntime {
		return {
			// SAFETY: the production shape is assembled by the daemon; these tests
			// need only the fields the mutation gate reads.
			...ctxMutation({ enabled: true, mode: "block", ...cfg }),
			cwd: root,
			graphCache: new Map(),
			log: () => {},
		} as unknown as ServerRuntime;
	}

	it("selectTests reports the graph unavailable when the project graph cannot be built", async () => {
		// `ctxMutation` carries no `graphCache`, so `getGraphForFile` throws — the
		// same shape a graph-init failure produces. The gate must decline with an
		// honest reason, never a silently narrowed scope.
		const args = await callbacks(ctxMutation({ enabled: true, mode: "block" }), ev({ tool_name: "Write" }));
		expect(args.selectTests("src/subject.ts")).toEqual({
			kind: "unavailable",
			reason: "dependency graph unavailable — exact mutation test scope is unproven",
		});
	});

	it("selectTests names the file and the decline reason when the graph does not know it", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-unknown-file-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "subject.ts"), "export const subject = 1;\n");
		writeFileSync(join(root, "src", "subject-roundtrip.test.ts"), 'import { subject } from "./subject.js";\nvoid subject;\n');
		const args = await callbacks(rootedRuntime(root, {}), ev({ tool_name: "Write" }));
		const selection = args.selectTests("src/nowhere.ts");
		rmSync(root, { recursive: true, force: true });
		expect(selection).toEqual({
			kind: "unavailable",
			reason: "exact mutation test scope is unavailable for src/nowhere.ts: unknown_file",
		});
	});

	it("selectTests reports the uncapped test count when an over-cap decline has no companion to fall back on", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-over-cap-"));
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		writeFileSync(join(root, "src", "subject.ts"), "export const subject = 1;\n");
		// A dependent test in a SIBLING directory: affected by the graph walk, but
		// not a co-located companion — so the over-cap decline carries no reduced
		// scope and must say how many tests it declined.
		writeFileSync(join(root, "src", "nested", "uses-subject.test.ts"), 'import { subject } from "../subject.js";\nvoid subject;\n');
		const args = await callbacks(rootedRuntime(root, { max_test_scope: 0 }), ev({ tool_name: "Write" }));
		const selection = args.selectTests("src/subject.ts");
		rmSync(root, { recursive: true, force: true });
		expect(selection).toEqual({
			kind: "unavailable",
			reason: "exact mutation test scope is unavailable for src/subject.ts: over_cap (1 tests exceeded the cap)",
		});
	});

	it("readDisk returns null for an unreadable path instead of throwing out of the gate", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-read-disk-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "present.ts"), "export const present = 1;\n");
		const args = await callbacks(rootedRuntime(root, {}), ev({ tool_name: "Write" }));
		const present = args.readDisk("src/present.ts");
		const absent = args.readDisk("src/never-written.ts");
		rmSync(root, { recursive: true, force: true });
		expect(present).toBe("export const present = 1;\n");
		expect(absent).toBeNull();
	});

	const PERSIST_MANIFEST = {
		version: 1,
		generation: 7,
		authoritativeAt: "2026-08-30T00:00:00.000Z",
		files: {
			"src/a.ts": {
				"sym-1": {
					mutants: {
						"m-killed": { mutantId: "m-killed", status: "killed" },
						"m-survived": { mutantId: "m-survived", status: "survived" },
					},
				},
			},
		},
	};

	const PERSIST_RECEIPT = {
		measuredAt: "2026-08-30T01:02:03.000Z",
		outcome: "clean",
		sites: [
			{ mutantId: "m1", symbolId: "sym-1", status: "killed" },
			{ mutantId: "m2", symbolId: "sym-1", status: "killed" },
			{ mutantId: "m3", symbolId: "sym-1", status: "survived" },
			{ mutantId: "m4", symbolId: "sym-1", status: "uncovered" },
		],
	};

	/** Drive the gate's `persist` callback once against a real temp root. */
	async function persistInto(root: string): Promise<void> {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
		const args = await callbacks(
			rootedRuntime(root, {}),
			ev({ tool_name: "Write", cwd: root, tool_input: { file_path: join(root, "src", "a.ts") } }),
		);
		args.persist(PERSIST_MANIFEST, PERSIST_RECEIPT);
	}

	it("persist appends a run-log row whose counts come from the receipt's site STATUSES", async () => {
		// `total - killed` would misfile the uncovered site as a survivor (external
		// review 2026-08-23, finding 4) — the row is status-derived, and carries
		// the receipt's own outcome so the dashboard renders adoption neutrally.
		const root = mkdtempSync(join(tmpdir(), "mutation-persist-log-"));
		await persistInto(root);
		const log = readFileSync(join(root, ".interlinked", "mutation-runs.jsonl"), "utf-8");
		rmSync(root, { recursive: true, force: true });
		expect(log.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
			{
				ts: "2026-08-30T01:02:03.000Z",
				file: "src/a.ts",
				source: "per-edit",
				mutants: 4,
				killed: 2,
				survived: 1,
				uncovered: 1,
				outcome: "clean",
			},
		]);
	});

	it("persist also refreshes the survivors-index sidecar in the same call", async () => {
		const root = mkdtempSync(join(tmpdir(), "mutation-persist-index-"));
		await persistInto(root);
		const sidecar = readFileSync(join(root, ".interlinked", "mutation-survivors-index.json"), "utf-8");
		rmSync(root, { recursive: true, force: true });
		// SAFETY: the file was just written by `writeSurvivorsIndex`; the fields
		// read below are asserted against literals, so a shape change fails loudly.
		const parsed = JSON.parse(sidecar) as { generation: number; files: Record<string, unknown> };
		expect(parsed.generation).toBe(7);
		expect(parsed.files["src/a.ts"]).toEqual({ survivors: ["m-survived"], mutantCount: 2, killed: 1 });
	});
});
