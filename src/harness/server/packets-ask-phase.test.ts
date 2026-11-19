import { describe, expect, it, vi } from "vitest";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { applyPacketAsk } from "./packets-ask-phase.js";

const event = (overrides: Partial<HarnessEvent> = {}): HarnessEvent =>
	({ hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command: "x" }, timestamp: "t", cwd: "/repo", ...overrides }) as HarnessEvent;
const ASK: HarnessDecision = { decision: "ask", reason: "[interlinked:packet] prefer-rg asks for confirmation", rule_id: "packet:prefer-rg", severity: "low", category: "packet" };

describe("applyPacketAsk — the §3 decision table on the PreToolUse side", () => {
	it("P1: an eligible cosign judgment turns allow into ask, keeping the earlier warnings", async () => {
		const allow: HarnessDecision = { decision: "allow", warnings: ["w"] };
		const collect = vi.fn(async (_e: HarnessEvent, _r: GuardRulesConfig, local: HarnessDecision) => ({ ...ASK, warnings: local.warnings }));
		const out = await applyPacketAsk(event(), {} as never, allow, { collect, timeoutMs: 1000 });
		expect(out.decision).toBe("ask");
		expect(out.rule_id).toBe("packet:prefer-rg");
		expect(out.warnings).toEqual(["w"]);
	});
	it("N1: a local block is unchanged under an eligible verdict, and the collector is not even asked", async () => {
		const block: HarnessDecision = { decision: "block", reason: "BLOCKED: x", rule_id: "r" };
		const collect = vi.fn(async () => ASK);
		expect(await applyPacketAsk(event(), {} as never, block, { collect, timeoutMs: 1000 })).toEqual(block);
		expect(collect).not.toHaveBeenCalled();
	});
	it("N2: a local ask is unchanged", async () => {
		const ask: HarnessDecision = { decision: "ask", reason: "confirm" };
		expect(await applyPacketAsk(event(), {} as never, ask, { collect: async () => ASK, timeoutMs: 1000 })).toEqual(ask);
	});
	it("N3: a collector that throws, or returns the same allow, changes nothing", async () => {
		const allow: HarnessDecision = { decision: "allow" };
		expect(await applyPacketAsk(event(), {} as never, allow, { collect: async () => { throw new Error("boom"); }, timeoutMs: 1000 })).toEqual(allow);
		expect(await applyPacketAsk(event(), {} as never, allow, { collect: async (_e: HarnessEvent, _r: GuardRulesConfig, local: HarnessDecision) => local, timeoutMs: 1000 })).toEqual(allow);
	});
	it("N4: a collector slower than the budget is abandoned and allow stands", async () => {
		const allow: HarnessDecision = { decision: "allow" };
		const collect = () => new Promise<HarnessDecision>((resolve) => setTimeout(() => resolve(ASK), 200));
		expect(await applyPacketAsk(event(), {} as never, allow, { collect, timeoutMs: 20 })).toEqual(allow);
	});
	it("N5: a dry run never calls the collector", async () => {
		const collect = vi.fn(async () => ASK);
		const allow: HarnessDecision = { decision: "allow" };
		expect(await applyPacketAsk(event({ dry_run: true }), {} as never, allow, { collect, timeoutMs: 1000 })).toEqual(allow);
		expect(collect).not.toHaveBeenCalled();
	});
	it("N6: a PostToolUse event is not this phase's business", async () => {
		const collect = vi.fn(async () => ASK);
		const allow: HarnessDecision = { decision: "allow" };
		expect(await applyPacketAsk(event({ hook_event: "PostToolUse" }), {} as never, allow, { collect, timeoutMs: 1000 })).toEqual(allow);
		expect(collect).not.toHaveBeenCalled();
	});
});
