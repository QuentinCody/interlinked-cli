// End-to-end ask-decision tests.
// Covers: PocketOS-shape Railway curl, GraphQL mutation w/ camelCase verb,
// MCP destructive tool name, and the agentSupportsAsk helper. These ride
// the same evaluator pipeline as the existing 81 evaluator tests but focus
// specifically on the ask flow added for the destructive-HTTP / Railway /
// MCP rule families landed 2026-04 in response to PocketOS's incident.

import { describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { ASK_CAPABLE_AGENTS, agentSupportsAsk } from "../types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "ask-test",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function freshRules(): GuardRulesConfig {
	const cfg = getDefaultConfig();
	const loaded = loadRules(process.cwd());
	cfg.rules = loaded.rules;
	if (cfg.structural_checks) cfg.structural_checks.test_first_mode = "warn";
	return cfg;
}

describe("agentSupportsAsk", () => {
	it("returns true for runtimes with an ask primitive", () => {
		expect(agentSupportsAsk("claude")).toBe(true);
		expect(agentSupportsAsk("cursor")).toBe(true);
		expect(agentSupportsAsk("pi")).toBe(true);
		expect(agentSupportsAsk("factory-droid")).toBe(true);
		expect(agentSupportsAsk("antigravity")).toBe(true);
	});
	it("returns false for runtimes without an ask primitive", () => {
		expect(agentSupportsAsk("copilot")).toBe(false);
		expect(agentSupportsAsk("codex")).toBe(false);
		expect(agentSupportsAsk("gemini")).toBe(false);
	});
	it("returns false for unknown / undefined sources", () => {
		expect(agentSupportsAsk(undefined)).toBe(false);
		expect(agentSupportsAsk("")).toBe(false);
		expect(agentSupportsAsk("anthropic-cli")).toBe(false);
	});
	it("exports the supported ask-capable runtimes", () => {
		expect(ASK_CAPABLE_AGENTS).toEqual(new Set([
			"claude", "cursor", "pi", "factory-droid", "antigravity",
		]));
	});
});

describe("ask-decision: REST DELETE via curl", () => {
	it("returns decision: 'ask' for curl -X DELETE against an arbitrary API", () => {
		const rules = freshRules();
		const event = makeEvent({
			tool_input: { command: `curl -X DELETE https://api.example.com/r/1 -H "Auth: x"` },
		});
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("ask");
		expect(r.reason).toMatch(/POTENTIALLY DESTRUCTIVE/);
		expect(r.system_message).toMatch(/destructive/i);
		expect(r.rule_id).toBe("builtin-curl-rest-delete");
	});
});

describe("hard-block: Railway GraphQL volumeDelete (the PocketOS shape)", () => {
	it("blocks the literal Railway volumeDelete that wiped PocketOS", () => {
		const rules = freshRules();
		const cmd = [
			`curl -X POST https://backboard.railway.app/graphql/v2`,
			`-H "Authorization: Bearer some-token"`,
			`-d '{"query":"mutation { volumeDelete(volumeId: \\"3d2c42fb-aaaa-bbbb-cccc-deadbeefdead\\") }"}'`,
		].join(" ");
		const event = makeEvent({ tool_input: { command: cmd } });
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		// Railway is HARD BLOCK — the family that must wins because it
		// comes before generic destructive-http in builtin-rules.ts ordering.
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("builtin-railway-graphql-destructive");
		expect(r.severity).toBe("critical");
		expect(r.reason).toMatch(/Railway/);
		expect(r.reason).toMatch(/PocketOS/);
	});
	it("blocks `railway volumes delete` CLI verb", () => {
		const rules = freshRules();
		const event = makeEvent({
			tool_input: { command: "railway volumes delete --volume-id abc-123" },
		});
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("builtin-railway-cli-destructive");
	});
});

describe("ask-decision: generic GraphQL destructive mutation (non-Railway vendor)", () => {
	it("asks on a curl POST to a non-Railway GraphQL endpoint with a delete mutation", () => {
		const rules = freshRules();
		const cmd = `curl -X POST -d '{"query":"mutation { deleteUser(id: \\"123\\") { id } }"}' https://api.example.com/graphql`;
		const event = makeEvent({ tool_input: { command: cmd } });
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("ask");
		expect(r.rule_id).toBe("builtin-graphql-destructive-mutation");
	});
	it("asks on a Fly.io GraphQL volumeDelete (camelCase verb)", () => {
		const rules = freshRules();
		const cmd = `curl -d '{"query":"mutation { volumeDelete(id: \\"v\\") }"}' https://api.fly.io/graphql`;
		const event = makeEvent({ tool_input: { command: cmd } });
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("ask");
	});
});

describe("ask-decision: MCP destructive tool", () => {
	it("asks on a generic mcp__supabase__delete_table call", () => {
		const rules = freshRules();
		const event = makeEvent({
			tool_name: "mcp__supabase__delete_table",
			tool_input: { table: "orders" },
		});
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("ask");
		expect(r.rule_id).toBe("builtin-mcp-destructive-verb");
	});
	it("blocks (not asks) a Railway MCP destructive call — Railway is hard-blocked", () => {
		const rules = freshRules();
		const event = makeEvent({
			tool_name: "mcp__railway__volume_delete",
			tool_input: { volumeId: "v" },
		});
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe("builtin-railway-mcp-destructive");
	});
	it("does NOT ask on a read-only mcp__supabase__select_rows call", () => {
		const rules = freshRules();
		const event = makeEvent({
			tool_name: "mcp__supabase__select_rows",
			tool_input: { table: "orders" },
		});
		const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
		expect(r.decision).toBe("allow");
	});
});

describe("agent_source carries through to the decision", () => {
	// The evaluator returns the same decision shape regardless of
	// agent_source — the per-client downgrade (ask → deny on Copilot/Codex/Gemini)
	// happens in the .mjs provider-response formatter, not here. So this
	// test asserts the decision stays "ask" for all sources; the integration
	// test for the per-client translation lives in the hook-template tests.
	for (const source of ["claude", "cursor", "copilot", "codex", "gemini"] as const) {
		it(`returns decision: 'ask' regardless of agent_source=${source}`, () => {
			const rules = freshRules();
			const event = makeEvent({
				agent_source: source,
				tool_input: { command: "curl -X DELETE https://api.example.com/r/1" },
			});
			const r = evaluatePreToolUse(event, rules, undefined, new ReservationManager(), new CohortManager());
			expect(r.decision).toBe("ask");
		});
	}
});
