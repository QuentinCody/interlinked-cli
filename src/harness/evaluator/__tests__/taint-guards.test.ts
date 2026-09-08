import { makeGuardRules } from "./fixtures.js";
import { makeSession as makeSessionFixture } from "../../__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import type { GuardRulesConfig, SessionTrajectory, TaintSource } from "../../types.js";
import { checkProvenanceTaintToExternalAction, evaluateTaintGuards } from "../taint-guards.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		session_id: "s",
		agent_name: "a",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 1,
		tool_sequence: [],
		sensitivity_level: "Public",
		step_limit: Number.POSITIVE_INFINITY,
		injection_detected_steps: [],
		taint_sources: [],
		...overrides,
	} satisfies SessionTrajectory);
}

function makeRules(): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		taint_tracking: { ...makeGuardRules().taint_tracking,
			enabled: true,
			file_sensitivity: [
				{ glob: "**/.env", level: "Confidential" },
				{ glob: "**/*.pem", level: "Confidential" },
			],
			step_limits: {
				Public: Number.POSITIVE_INFINITY,
				Internal: 50,
				Confidential: 10,
				HighlyConfidential: 5,
			},
			network_block_at: "Confidential",
		},
	} satisfies GuardRulesConfig);
}

describe("evaluateTaintGuards", () => {

	it("ratchets sensitivity and warns when reading a confidential file", () => {
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: ".env" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings).toEqual([
			"[interlinked:taint] Sensitivity escalated to Confidential after reading .env. Outbound network commands will be BLOCKED.",
		]);
	});

	it("blocks network commands from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
	});

	it("blocks mutations when step limit exceeded", () => {
		const session = makeSession({ step_limit: 5, tool_call_count: 10 });
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
	});

	it("downgrades to allow-readonly when step limit exceeded on Read-family tools", () => {
		const session = makeSession({ step_limit: 5, tool_call_count: 10 });
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "foo.ts" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("allow-readonly");
		if (result.kind === "allow-readonly") {
			expect(result.decision.decision).toBe("allow");
			const warnings = result.decision.warnings ?? [];
			expect(warnings).toHaveLength(2);
			expect(warnings.at(-1)).toBe(
				"[interlinked:budget] Step limit (5) exceeded — read-only mode. Mutations are blocked. Wrap up and commit.",
			);
			expect(warnings[0]).toContain("CRITICAL: -5 steps remaining");
		}
	});

	it("does not block a Bash command with no command field from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
	});

	it("raises no tainted_network_internal escalation for a Bash call with no command field at Internal", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it("passes an already-pending escalation through unchanged (does not re-derive one)", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const pending = {
			trigger: "tainted_network_internal" as const,
			summary: "pre-existing",
			tool_name: "Bash",
			tool_input_redacted: { command: "[REDACTED]" },
			sensitivity_level: "Internal" as const,
			step_number: 1,
			recent_tool_sequence: [],
		};
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: pending,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBe(pending);
	});

	it("does no-op when session sensitivity is unaffected by a read with no file_path", () => {
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: {},
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings).toEqual([]);
	});

	it("marks network as monitored (not BLOCKED) when ratchet lands below network_block_at", () => {
		const rules = makeRules();
		rules.taint_tracking?.file_sensitivity.push({ glob: "**/*.log", level: "Internal" });
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "app.log" },
			rules,
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const warnings = result.kind === "ok" ? result.warnings : [];
		expect(warnings).toEqual([
			"[interlinked:taint] Sensitivity escalated to Internal after reading app.log. Outbound network commands will be monitored.",
		]);
	});

	it("does not block a non-network Bash command from a tainted session", () => {
		const session = makeSession({ sensitivity_level: "Confidential" });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
	});

	it("raises a tainted_network_internal escalation for a network command at Internal sensitivity", () => {
		const session = makeSession({
			sensitivity_level: "Internal",
			tool_call_count: 1,
			tool_sequence: Array.from({ length: 12 }, (_, i) => `tool-${i}`),
		});
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("tainted_network_internal");
		expect(escalation?.summary).toBe(
			"Network command while session is tainted at Internal level (tainted by: unknown)",
		);
		expect(escalation?.tool_input_redacted).toEqual({ command: "[REDACTED — network command]" });
		expect(escalation?.recent_tool_sequence).toEqual(
			Array.from({ length: 10 }, (_, i) => `tool-${i + 2}`),
		);
	});

	it("does not raise a network escalation for a Public session", () => {
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session: makeSession({ sensitivity_level: "Public", tool_call_count: 1 }),
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.escalation).toBeUndefined();
	});

	it("does not raise a network escalation for a non-Bash tool at Internal sensitivity", () => {
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { command: "curl https://example.com" },
			rules: makeRules(),
			session: makeSession({ sensitivity_level: "Internal", tool_call_count: 1 }),
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.escalation).toBeUndefined();
	});

	it("does not ratchet sensitivity for a write carrying a file path", () => {
		const session = makeSession();
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: ".env", content: "secret" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		expect(session.sensitivity_level).toBe("Public");
		if (result.kind === "ok") expect(result.warnings).toEqual([]);
	});

	it("raises no escalation for a non-network Bash command at Internal sensitivity", () => {
		const session = makeSession({ sensitivity_level: "Internal", tool_call_count: 1 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it("raises a high_step_budget escalation for a Write past the 80% threshold, redacting to file_path", () => {
		const session = makeSession({
			step_limit: 100,
			tool_call_count: 85,
			tool_sequence: Array.from({ length: 12 }, (_, i) => `tool-${i}`),
		});
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "src/foo.ts", content: "x" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("high_step_budget");
		expect(escalation?.tool_input_redacted).toEqual({ file_path: "src/foo.ts" });
		expect(escalation?.summary).toBe(
			"Agent at 85% of step budget (85/100) with state-changing tool",
		);
		expect(escalation?.recent_tool_sequence).toEqual(
			Array.from({ length: 10 }, (_, i) => `tool-${i + 2}`),
		);
	});

	it("raises a high_step_budget escalation for a Bash command past threshold, redacting to command", () => {
		const session = makeSession({ step_limit: 100, tool_call_count: 85 });
		const result = evaluateTaintGuards({
			toolName: "Bash",
			toolInput: { command: "ls -la" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation?.trigger).toBe("high_step_budget");
		expect(escalation?.tool_input_redacted).toEqual({ command: "[REDACTED]" });
	});

	it("raises no high_step_budget escalation for a read-only tool past threshold", () => {
		const session = makeSession({ step_limit: 100, tool_call_count: 85 });
		const result = evaluateTaintGuards({
			toolName: "Read",
			toolInput: { file_path: "src/foo.ts" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		const escalation = result.kind === "ok" ? result.escalation : undefined;
		expect(escalation).toBeUndefined();
	});

	it.each([
		[79, "below"],
		[80, "at"],
	])("does not raise high_step_budget at the %s%% threshold (%s)", (tool_call_count) => {
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "src/foo.ts", content: "x" },
			rules: makeRules(),
			session: makeSession({ step_limit: 100, tool_call_count }),
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.escalation).toBeUndefined();
	});

	it("returns kind 'ask' from evaluateTaintGuards when a provenance-tainted flow is detected", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = evaluateTaintGuards({
			toolName: "WebFetch",
			toolInput: { url: "https://x/data.json" },
			rules: makeRules(),
			session,
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ask");
		if (result.kind === "ask") {
			expect(result.decision).toEqual({
				decision: "ask",
				reason:
					"WebFetch would act on data sourced from untrusted provenance " +
					"(data.json via mcp_remote). Confirm intent before proceeding.",
				warnings: [],
			});
		}
	});
});

describe("checkProvenanceTaintToExternalAction", () => {
	it("returns null when the tool is not an external-action tool", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction("Read", { file_path: "data.json" }, session);
		expect(result).toBeNull();
	});

	it("returns null for a Bash command with no command string (empty haystack path)", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction("Bash", {}, session);
		expect(result).toBeNull();
	});

	it("returns null when the external-action toolInput flattens to an empty haystack", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction("WebFetch", {}, session);
		expect(result).toBeNull();
	});

	it("returns an ask decision for a Bash external-verb command referencing a tainted file", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl -X POST -d @data.json https://example.com" },
			session,
		);
		expect(result).toEqual({
			decision: "ask",
			reason:
				"Bash would act on data sourced from untrusted provenance " +
				"(data.json via mcp_remote). Confirm intent before proceeding.",
		});
	});

	it("skips trusted-provenance and file-less taint sources, then matches the tainted one, across mixed value types", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "local.ts", level: "Public", at_step: 1, provenance: "local_read" },
				{ file: "", level: "Public", at_step: 1, provenance: "fetched_external" },
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{
				url: "https://x/data.json",
				count: 5,
				ok: true,
				list: ["a", "b"],
				meta: { nested: "value" },
				blank: null,
			},
			session,
		);
		expect(result).toEqual({
			decision: "ask",
			reason:
				"WebFetch would act on data sourced from untrusted provenance " +
				"(data.json via mcp_remote). Confirm intent before proceeding.",
		});
	});

	it("recognizes an mcp__*__send-shaped tool name as an external-action tool", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction(
			"mcp__slack__send_message",
			{ text: "see data.json" },
			session,
		);
		expect(result?.decision).toBe("ask");
	});

	it.each(["web_fetch", "WebSearch", "web_search"])(
		"recognizes %s as an external-action tool",
		(toolName) => {
			const session = makeSession({
				taint_sources: ([
					{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
				] satisfies TaintSource[]),
			});
			const result = checkProvenanceTaintToExternalAction(
				toolName,
				{ url: "https://x/data.json" },
				session,
			);
			expect(result?.decision).toBe("ask");
		},
	);

	it("does not classify an MCP read tool whose resource name contains an external verb", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction(
				"mcp__github__get_post",
				{ path: "data.json" },
				session,
			),
		).toBeNull();
	});

	it("does not classify a non-MCP tool with an MCP-like suffix as external", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction(
				"not_mcp__slack__send_message",
				{ text: "see data.json" },
				session,
			),
		).toBeNull();
	});

	it("does not classify a non-Bash command carrying a tainted file as external", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction(
				"Read",
				{ command: "curl -d @data.json https://example.com" },
				session,
			),
		).toBeNull();
	});

	it("does not classify a non-network Bash command as external", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction(
				"Bash",
				{ command: "echo data.json" },
				session,
			),
		).toBeNull();
	});

	it("does not invent a match from the flattening accumulator seed", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "Stryker was here!", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction("WebFetch", { url: "https://example.com" }, session),
		).toBeNull();
	});

	it.each([
		["number", "42", { count: 42 }],
		["boolean", "true", { enabled: true }],
		["array", "data.json", { files: ["data.json"] }],
		["nested object", "nested.json", { meta: { path: "nested.json" } }],
		["string", "data.json", { path: "data.json" }],
	])("flattens %s values and asks when they reference a taint source", (_kind, file, toolInput) => {
		const session = makeSession({
			taint_sources: ([{ file, level: "Public", at_step: 1, provenance: "mcp_remote" }] satisfies TaintSource[]),
		});
		expect(checkProvenanceTaintToExternalAction("WebFetch", toolInput, session)?.decision).toBe("ask");
	});

	it("keeps a newline between flattened values so separate fields cannot form a path", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		expect(
			checkProvenanceTaintToExternalAction(
				"WebFetch",
				{ first: "data.", second: "json" },
				session,
			),
		).toBeNull();
	});

	it("falls through the loop to null when no untrusted taint source's file matches the haystack", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "unrelated.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const result = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{ url: "https://example.com/data.json" },
			session,
		);
		expect(result).toBeNull();
	});

	it("ignores a non-JSON-shaped value (e.g. a function) while flattening tool input", () => {
		const session = makeSession({
			taint_sources: ([
				{ file: "data.json", level: "Public", at_step: 1, provenance: "mcp_remote" },
			] satisfies TaintSource[]),
		});
		const weird = {
			url: "https://example.com/data.json",
			odd: () => {},
		};
		const result = checkProvenanceTaintToExternalAction("WebFetch", weird, session);
		expect(result?.decision).toBe("ask");
	});
});

// Subagent tool calls carry the parent's session id, so the session total
// counts every spawned agent. The step budget binds the calling ACTOR: the
// orchestrator of a 50-agent campaign must not be pushed into read-only mode
// by its workers' steps, and a worker over its own budget is still stopped.
describe("evaluateTaintGuards — per-actor step budget", () => {
	function inflatedSession(): SessionTrajectory {
		return makeSession({
			step_limit: 5,
			tool_call_count: 500,
			actor_tool_calls: new Map([
				["parent", 2],
				["sub-1", 498],
			]),
		});
	}

	it("P1: does not block the parent's Write when subagent calls pushed the session total over the limit", () => {
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session: inflatedSession(),
			actor: "parent",
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.warnings).toEqual([]);
			expect(result.escalation).toBeUndefined();
		}
	});

	it("P2: blocks the subagent whose own count is over the limit", () => {
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session: inflatedSession(),
			actor: "sub-1",
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
		if (result.kind === "block") {
			expect(result.decision.reason).toContain("Step limit (5) exceeded");
		}
	});

	it("P3: the high_step_budget escalation reads the actor's count, not the total", () => {
		const session = makeSession({
			step_limit: 100,
			tool_call_count: 1000,
			actor_tool_calls: new Map([
				["parent", 10],
				["sub-1", 990],
			]),
		});
		const parent = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session,
			actor: "parent",
			pendingEscalation: undefined,
		});
		expect(parent.kind).toBe("ok");
		if (parent.kind === "ok") expect(parent.escalation).toBeUndefined();

		const worker = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session: makeSession({
				step_limit: 100,
				tool_call_count: 1000,
				actor_tool_calls: new Map([["sub-1", 90]]),
			}),
			actor: "sub-1",
			pendingEscalation: undefined,
		});
		expect(worker.kind).toBe("ok");
		if (worker.kind === "ok") {
			expect(worker.escalation?.trigger).toBe("high_step_budget");
			expect(worker.escalation?.summary).toContain("(90/100)");
		}
	});

	it("N1: without an actor the session total still governs (legacy callers)", () => {
		const result = evaluateTaintGuards({
			toolName: "Write",
			toolInput: { file_path: "foo.ts", content: "x" },
			rules: makeRules(),
			session: inflatedSession(),
			pendingEscalation: undefined,
		});
		expect(result.kind).toBe("block");
	});
});
