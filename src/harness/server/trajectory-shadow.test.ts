import { beforeEach, describe, expect, it } from "vitest";
import type { Verdict } from "../trajectory/types.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	__resetTrajectoryShadowForTest,
	formatTrajectoryVerdict,
	mergeTrajectoryShadow,
	peekTrajectoryState,
	trajectoryShadowWarnings,
} from "./trajectory-shadow.js";

const CONFIG_ON = { trajectory_shadow: { enabled: true } };
const CONFIG_OFF = { trajectory_shadow: { enabled: false } };
const ALLOW: HarnessDecision = { decision: "allow" };

interface EditSpec {
	file: string;
	from: string;
	to: string;
	step: string;
}

function postEdit({ file, from, to, step }: EditSpec): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Edit",
		tool_use_id: `tu-${step}`,
		tool_input: { file_path: file, old_string: from, new_string: to },
		tool_outcome: "success",
		tool_response_sha256: `sha-${step}`,
		timestamp: "2026-07-01T00:00:00.000Z",
	};
}

beforeEach(() => {
	__resetTrajectoryShadowForTest();
});

describe("formatTrajectoryVerdict", () => {
	it("renders a block-catalog verdict as a non-blocking metric line, never a decision", () => {
		const verdict: Verdict = {
			ruleId: "sec_env_add_then_git_commit",
			action: "block",
			severity: "high",
			reason: "BLOCKED: a secret would be committed.",
		};
		const line = formatTrajectoryVerdict(verdict);
		expect(line.startsWith("[interlinked:trajectory]")).toBe(true);
		expect(line).toContain("sec_env_add_then_git_commit");
		expect(line).toContain("shadow — would block"); // the action is reported, never enacted
		expect(line).not.toContain("BLOCKED:");
	});
});

describe("trajectoryShadowWarnings", () => {
	it("surfaces a firing rule as an [interlinked:trajectory] warning", () => {
		trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" }), ALLOW, CONFIG_ON);
		const warnings = trajectoryShadowWarnings(
			postEdit({ file: "/x.ts", from: "bar", to: "foo", step: "2" }),
			ALLOW,
			CONFIG_ON,
		);
		expect(warnings.some((w) => w.includes("churn_literal_edit_revert"))).toBe(true);
		expect(warnings.every((w) => w.startsWith("[interlinked:trajectory]"))).toBe(true);
	});

	it("is silent when the shadow flag is disabled (negative path)", () => {
		trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" }), ALLOW, CONFIG_OFF);
		expect(
			trajectoryShadowWarnings(postEdit({ file: "/x.ts", from: "bar", to: "foo", step: "2" }), ALLOW, CONFIG_OFF),
		).toEqual([]);
	});

	it("ignores non-forwarded lifecycle events such as SessionStart (negative path)", () => {
		const sessionStart: HarnessEvent = {
			hook_event: "SessionStart",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		expect(trajectoryShadowWarnings(sessionStart, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("maps tool_outcome 'error' to a fail outcome without throwing", () => {
		const event: HarnessEvent = {
			...postEdit({ file: "/e.ts", from: "a", to: "b", step: "e1" }),
			tool_outcome: "error",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("maps tool_outcome 'interrupted' to a fail outcome without throwing", () => {
		const event: HarnessEvent = {
			...postEdit({ file: "/e.ts", from: "a", to: "b", step: "e2" }),
			tool_outcome: "interrupted",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("maps an absent tool_outcome to null without throwing", () => {
		const { tool_outcome: _drop, ...rest } = postEdit({
			file: "/e.ts",
			from: "a",
			to: "b",
			step: "e3",
		});
		const event: HarnessEvent = rest;
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("treats an absent tool_input as an empty input object", () => {
		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "sess-noinput",
			agent_source: "claude",
			tool_name: "Bash",
			timestamp: "t",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("copies only the command field when tool_input carries a bash command", () => {
		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "sess-cmd",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
			tool_outcome: "success",
			timestamp: "t",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("copies only the content field when tool_input carries write content", () => {
		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "sess-content",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { content: "console.log(1)" },
			tool_outcome: "success",
			timestamp: "t",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("maps a block decision into the tool event's checkDecision", () => {
		const BLOCK: HarnessDecision = { decision: "block", reason: "nope" };
		const event = postEdit({ file: "/b.ts", from: "a", to: "b", step: "blk" });
		expect(trajectoryShadowWarnings(event, BLOCK, CONFIG_ON)).toEqual([]);
	});

	it("returns no warnings when session_id is empty (falsy)", () => {
		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: { file_path: "/x.ts" },
			timestamp: "t",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("fails open (returns []) when the engine throws internally", () => {
		const badInput = new Proxy(
			{},
			{
				get(): never {
					throw new Error("boom");
				},
			},
			// SAFETY: Proxy simulates a malformed tool_input whose property reads throw,
			// forcing toInput()'s field copy to raise so the outer try/catch is exercised.
		) as unknown as HarnessEvent["tool_input"];
		const event: HarnessEvent = {
			hook_event: "PostToolUse",
			session_id: "sess-throw",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: badInput,
			timestamp: "t",
		};
		expect(trajectoryShadowWarnings(event, ALLOW, CONFIG_ON)).toEqual([]);
	});

	it("evicts the oldest per-session state once SESSION_CAP is exceeded", () => {
		for (let i = 0; i < 257; i++) {
			trajectoryShadowWarnings(
				{
					hook_event: "PostToolUse",
					session_id: `sess-cap-${i}`,
					agent_source: "claude",
					tool_name: "Edit",
					tool_use_id: `tu-cap-${i}`,
					tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
					tool_outcome: "success",
					timestamp: "2026-07-01T00:00:00.000Z",
				},
				ALLOW,
				CONFIG_ON,
			);
		}
		expect(peekTrajectoryState("sess-cap-0")).toBeNull();
		expect(peekTrajectoryState("sess-cap-256")).not.toBeNull();
	});

	it("forwards Stop events so the Stop-gated obligation inventory can fire", () => {
		// Open an obligation (a TODO the session never closes), then Stop.
		trajectoryShadowWarnings(
			postEdit({ file: "/z.ts", from: "x", to: "// TODO wire this", step: "1" }),
			ALLOW,
			CONFIG_ON,
		);
		const stop: HarnessEvent = {
			hook_event: "Stop",
			session_id: "sess-1",
			agent_source: "claude",
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		const warnings = trajectoryShadowWarnings(stop, ALLOW, CONFIG_ON);
		expect(warnings.some((w) => w.includes("obl_net_open_at_stop"))).toBe(true);
	});
});

describe("mergeTrajectoryShadow", () => {
	it("appends warnings without ever changing the decision verdict", () => {
		trajectoryShadowWarnings(postEdit({ file: "/y.ts", from: "a", to: "b", step: "1" }), ALLOW, CONFIG_ON); // seed
		const decision: HarnessDecision = { decision: "allow", warnings: ["existing"] };
		mergeTrajectoryShadow(postEdit({ file: "/y.ts", from: "b", to: "a", step: "2" }), decision, CONFIG_ON);
		expect(decision.decision).toBe("allow"); // verdict never mutated — shadow is metric-only
		expect(decision.warnings).toContain("existing"); // prior warnings preserved
		expect(decision.warnings?.some((w) => w.includes("churn_literal_edit_revert"))).toBe(true);
	});

	it("initializes warnings via ?? [] when the decision has no warnings array yet", () => {
		trajectoryShadowWarnings(postEdit({ file: "/q.ts", from: "1", to: "2", step: "q1" }), ALLOW, CONFIG_ON); // seed
		const decision: HarnessDecision = { decision: "allow" }; // no warnings key at all
		mergeTrajectoryShadow(postEdit({ file: "/q.ts", from: "2", to: "1", step: "q2" }), decision, CONFIG_ON);
		expect(decision.warnings?.some((w) => w.includes("churn_literal_edit_revert"))).toBe(true);
	});
});
