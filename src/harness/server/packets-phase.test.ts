import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { appendPacketWarnings, postToolReachesModel, PROPOSAL_LEASE_MS, resetPacketPhaseState, sessionStartReachesModel } from "./packets-phase.js";

beforeEach(() => resetPacketPhaseState());

describe("released text the session has not received yet rides each PostToolUse (§9; audit B, findings 1, 6, 7)", () => {
	const quiet = { collect: async () => [], drain: () => [], timeoutMs: 1000, postVisible: () => true };
	const line = (id: string) => `[interlinked:packet ${id}] not live here (packets disabled); instruction released from CLAUDE.md, verbatim:\nPrefer \`rg\`.`;
	const entries = (...ids: string[]) => () => ids.map((id) => ({ id, line: line(id) }));
	it("P3: an id the session has not received is proposed; within the lease it is not proposed again; after it, it is (an invisible event never uses it up)", async () => {
		let clock = 1_000_000;
		const deps = { ...quiet, startFallback: entries("prefer-rg"), delivered: () => new Set<string>(), now: () => clock };
		const first: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event({ agent_source: "copilot-cli" }), {} as never, first, deps);
		expect(first.warnings).toEqual([line("prefer-rg")]);
		const parallel: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event({ agent_source: "copilot-cli" }), {} as never, parallel, deps);
		expect(parallel).toEqual({ decision: "allow" }); // break R3, P2-a: a parallel call does not duplicate it
		clock += PROPOSAL_LEASE_MS + 1;
		const later: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event({ agent_source: "copilot-cli" }), {} as never, later, deps);
		expect(later.warnings).toEqual([line("prefer-rg")]);
	});
	it("P7 (break R3, P2-b): on a runner no post-tool output reaches, outage and window fallback lines are dropped too — judgments are kept", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event({ agent_source: "windsurf" }), {} as never, decision, { ...quiet, postVisible: postToolReachesModel, collect: async () => [line("a"), "[interlinked:packet] [heuristic] judged"], drain: () => [line("b")], delivered: () => new Set() });
		expect(decision.warnings).toEqual(["[interlinked:packet] [heuristic] judged"]);
	});
	it("P8: released words go FIRST in the warnings (a runner keeping only the head of the context keeps them)", async () => {
		const decision: HarnessDecision = { decision: "allow", warnings: ["[earlier] finding"] };
		await appendPacketWarnings(event(), {} as never, decision, { ...quiet, collect: async () => ["[interlinked:packet] [heuristic] judged"], startFallback: entries("a"), delivered: () => new Set() });
		expect(decision.warnings).toEqual([line("a"), "[earlier] finding", "[interlinked:packet] [heuristic] judged"]);
	});
	it("P9 (break R1, P2): a tool cwd in a subdirectory resolves the project root — the receipts and the packet file live there", async () => {
		const root = mkdtempSync(join(tmpdir(), "packets-phase-root-"));
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(join(root, ".interlinked", "config.json"), "{}");
			mkdirSync(join(root, "src", "deep"), { recursive: true });
			const startFallback = vi.fn((_root: string) => entries("a")());
			const delivered = vi.fn((_root: string, _session: string) => new Set<string>());
			const decision: HarnessDecision = { decision: "allow" };
			await appendPacketWarnings(event({ cwd: join(root, "src", "deep") }), {} as never, decision, { ...quiet, startFallback, delivered });
			expect(startFallback.mock.calls[0]?.[0]).toBe(root);
			expect(delivered.mock.calls[0]?.[0]).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("N3: an id the hook recorded as received (at SessionStart or a visible earlier call) is never repeated", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event(), {} as never, decision, { ...quiet, startFallback: entries("prefer-rg", "other"), delivered: (_c, s) => new Set(s === "s" ? ["prefer-rg"] : []) });
		expect(decision.warnings).toEqual([line("other")]);
	});
	it("N4: a runner with no model-visible post-tool event (Windsurf, Antigravity, Crush) gets no proposal at all", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const startFallback = vi.fn(entries("prefer-rg"));
		await appendPacketWarnings(event({ agent_source: "windsurf" }), {} as never, decision, { ...quiet, postVisible: postToolReachesModel, startFallback, delivered: () => new Set() });
		expect(decision).toEqual({ decision: "allow" });
		expect(startFallback).not.toHaveBeenCalled();
	});
	it("P5: the same id proposed by the outage path and the static path is delivered once", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event(), {} as never, decision, { ...quiet, collect: async () => [line("prefer-rg")], startFallback: entries("prefer-rg"), delivered: () => new Set() });
		expect(decision.warnings).toEqual([line("prefer-rg")]);
	});
	it("P6: an evaluator that throws still lets the released words through (that is when they are needed)", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const collect = async (): Promise<string[]> => {
			throw new Error("boom");
		};
		await appendPacketWarnings(event(), {} as never, decision, { ...quiet, collect, startFallback: entries("prefer-rg"), delivered: () => new Set() });
		expect(decision.warnings).toEqual([line("prefer-rg")]);
	});
	it("P4: the visibility oracles read the adapter capability table", () => {
		expect(sessionStartReachesModel("claude")).toBe(true);
		expect(sessionStartReachesModel("claude-code")).toBe(true);
		expect(sessionStartReachesModel("codex")).toBe(true);
		for (const r of ["copilot-cli", "gemini-cli", "cursor", "opencode", "pi", "no-such-runner"]) expect(sessionStartReachesModel(r)).toBe(false);
		for (const r of ["claude", "codex", "copilot-cli", "gemini-cli", "cursor", "opencode", "pi"]) expect(postToolReachesModel(r)).toBe(true);
		for (const r of ["windsurf", "antigravity", "crush", "no-such-runner"]) expect(postToolReachesModel(r)).toBe(false);
	});
});

const event = (overrides: Partial<HarnessEvent> = {}): HarnessEvent =>
	({ hook_event: "PostToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command: "x" }, timestamp: "t", cwd: "/repo", ...overrides }) as HarnessEvent;

describe("appendPacketWarnings — the §3 decision table on the PostToolUse side", () => {
	it("P1: delivered warnings are appended; the decision stays allow", async () => {
		const decision: HarnessDecision = { decision: "allow", warnings: ["[other] first"] };
		const collect = vi.fn(async () => ["[interlinked:packet] [heuristic] prefer-rg p=0.91 ≥ τ 0.85 — …"]);
		await appendPacketWarnings(event(), {} as never, decision, { collect, drain: () => [], timeoutMs: 1000 });
		expect(decision.decision).toBe("allow");
		expect(decision.warnings).toEqual(["[other] first", "[interlinked:packet] [heuristic] prefer-rg p=0.91 ≥ τ 0.85 — …"]);
	});
	it("P2: queued trajectory warnings for THIS session are drained onto the allow, after the per-call lines", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const drain = vi.fn((_cwd: string, sessionId: string) => (sessionId === "s" ? ["[interlinked:packet] [heuristic] commit-unprompted …"] : []));
		await appendPacketWarnings(event(), {} as never, decision, { collect: async () => ["per-call"], drain, timeoutMs: 1000 });
		expect(decision.warnings).toEqual(["per-call", "[interlinked:packet] [heuristic] commit-unprompted …"]);
		expect(drain).toHaveBeenCalledWith("/repo", "s");
	});
	it("N1: no warning leaves the decision byte-identical", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event(), {} as never, decision, { collect: async () => [], drain: () => [], timeoutMs: 1000 });
		expect(decision).toEqual({ decision: "allow" });
	});
	it("N2: a collector that throws changes nothing (fail-open)", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event(), {} as never, decision, {
			collect: async () => {
				throw new Error("boom");
			},
			drain: () => [],
			timeoutMs: 1000,
		});
		expect(decision).toEqual({ decision: "allow" });
	});
	it("N3: a collector slower than the budget is abandoned and changes nothing", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const collect = () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["late"]), 200));
		await appendPacketWarnings(event(), {} as never, decision, { collect, drain: () => [], timeoutMs: 20 });
		expect(decision).toEqual({ decision: "allow" });
	});
	it("N4: a non-allow decision (block/ask from an earlier phase) is never touched, even with a warning", async () => {
		const decision: HarnessDecision = { decision: "block", reason: "BLOCKED: x", rule_id: "r" };
		await appendPacketWarnings(event(), {} as never, decision, { collect: async () => ["[interlinked:packet] y"], drain: () => ["queued"], timeoutMs: 1000 });
		expect(decision).toEqual({ decision: "block", reason: "BLOCKED: x", rule_id: "r" });
	});
	it("N5: a dry run never calls the collector", async () => {
		const collect = vi.fn(async () => ["x"]);
		const decision: HarnessDecision = { decision: "allow" };
		await appendPacketWarnings(event({ dry_run: true }), {} as never, decision, { collect, drain: () => ["queued"], timeoutMs: 1000 });
		expect(collect).not.toHaveBeenCalled();
	});
});
