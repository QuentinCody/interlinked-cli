// Channel matrix for the kill-proof nudge, per runner, through the REAL encoders.
//
// The PostToolUse evaluator appends `collectPostWriteFileWarnings` output to
// `HarnessDecision.warnings` (evaluator/post-tool.ts); the Stop-time
// `[interlinked:mutation-kill-evidence]` line is likewise a warning. This file
// pins where each encoder puts a warning string: a stdout JSON field the runner
// documents as model context (P = reaches the model as context) or stderr on
// exit 0 only (N = operator-visible, not model context).
//
// Scope: encoder output only (unit-encoded). Whether a real runner process
// consumes that stdout field is NOT measured here; see
// docs/reviews/kill-proof-adapter-matrix.md.

import { describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import type { HarnessDecision } from "../types.js";
import { getAdapter } from "./index.js";
import type { AdapterOutput } from "./types.js";

const REL = "src/foo.mutation-kill.test.ts";
const NUDGE = killProofNudge({ root: "/repo", relPath: REL, readIndex: () => ({ version: 1, receipts: [] }) });
const STOP_LINE = "[interlinked:mutation-kill-evidence] 1 mutation-directed test file(s) carry no executed kill proof.";

function encode(runner: string, nativeEvent: string, decision: HarnessDecision): AdapterOutput {
	const adapter = getAdapter(runner);
	if (!adapter) throw new Error(`no adapter ${runner}`);
	const event = adapter.parseHookInput({ tool_name: "Write", tool_input: { file_path: REL } }, nativeEvent);
	return adapter.encodeDecision(decision, event);
}

function stdoutJson(output: AdapterOutput): Record<string, unknown> {
	return output.stdout ? (JSON.parse(output.stdout) as Record<string, unknown>) : {};
}

function stdoutText(output: AdapterOutput): string {
	return output.stdout ?? "";
}

const warn = (text: string): HarnessDecision => ({ decision: "allow", warnings: [text] });

describe("kill-proof nudge text", () => {
	it("is the real nudge string carrying the kill-proof tag", () => {
		expect(NUDGE).toMatch(/^\[interlinked:kill-proof\] src\/foo\.mutation-kill\.test\.ts: no executed kill proof/);
	});
});

describe("PostToolUse warning [interlinked:kill-proof] — channel per runner", () => {
	it("P1: claude-code PostToolUse puts the warning in hookSpecificOutput.additionalContext (stderr copy kept)", () => {
		const out = encode("claude-code", "PostToolUse", warn(NUDGE!));
		expect(out.exit_code).toBe(0);
		expect(stdoutJson(out)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NUDGE } });
		expect(out.stderr).toBe(NUDGE);
	});

	it("P2: codex PostToolUse puts the warning in hookSpecificOutput.additionalContext (no stderr copy)", () => {
		const out = encode("codex", "PostToolUse", warn(NUDGE!));
		expect(out.exit_code).toBe(0);
		expect(stdoutJson(out)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NUDGE } });
		expect(out.stderr).toBeUndefined();
	});

	// The three pins below were N1–N3 (stderr only) until 2026-11-05: the old
	// encoders hid every PostToolUse warning from these models.
	it("P7: factory-droid PostToolUse puts the warning in hookSpecificOutput.additionalContext (stderr copy kept)", () => {
		const out = encode("factory-droid", "PostToolUse", warn(NUDGE!));
		expect(out.exit_code).toBe(0);
		expect(stdoutJson(out)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NUDGE } });
		expect(out.stderr).toBe(NUDGE);
	});

	it("P8: copilot-cli postToolUse puts the warning in top-level additionalContext (stderr copy kept)", () => {
		const out = encode("copilot-cli", "postToolUse", warn(NUDGE!));
		expect(out.exit_code).toBe(0);
		expect(stdoutJson(out)).toEqual({ additionalContext: NUDGE });
		expect(out.stderr).toBe(NUDGE);
	});

	it("P9: gemini-cli AfterTool puts the warning in hookSpecificOutput.additionalContext (stderr copy kept)", () => {
		const out = encode("gemini-cli", "AfterTool", warn(NUDGE!));
		expect(out.exit_code).toBe(0);
		expect(stdoutJson(out)).toEqual({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: NUDGE } });
		expect(out.stderr).toBe(NUDGE);
	});

	it.each([
		["P10", "factory-droid", "PostToolUse"],
		["P11", "copilot-cli", "postToolUse"],
		["P12", "gemini-cli", "AfterTool"],
	] as const)("%s: %s %s joins additional_context first, then warnings (Codex order)", (_label, runner, nativeEvent) => {
		const out = encode(runner, nativeEvent, { decision: "allow", additional_context: "ctx-line", warnings: [NUDGE!, "second"] });
		expect(stdoutText(out)).toContain(JSON.stringify(`ctx-line\n${NUDGE}\nsecond`));
	});
});

describe("the same text as additional_context still reaches each context field", () => {
	const ctx: HarnessDecision = { decision: "allow", additional_context: NUDGE! };

	it("P3: factory-droid PostToolUse routes additional_context to hookSpecificOutput.additionalContext", () => {
		expect(stdoutJson(encode("factory-droid", "PostToolUse", ctx))).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NUDGE } });
	});

	it("P4: copilot-cli postToolUse routes additional_context to top-level additionalContext", () => {
		expect(stdoutJson(encode("copilot-cli", "postToolUse", ctx))).toEqual({ additionalContext: NUDGE });
	});

	it("P5: gemini-cli AfterTool routes additional_context to hookSpecificOutput.additionalContext", () => {
		expect(stdoutJson(encode("gemini-cli", "AfterTool", ctx))).toEqual({ hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: NUDGE } });
	});
});

describe("Stop warning [interlinked:mutation-kill-evidence] (advisory allow) — channel per runner", () => {
	it.each([
		["N4", "claude-code", "Stop"],
		["N5", "codex", "Stop"],
		["N6", "factory-droid", "Stop"],
		["N7", "copilot-cli", "agentStop"],
		["N8", "gemini-cli", "AfterAgent"],
	] as const)("%s: %s %s keeps the advisory Stop warning off stdout (stderr only, exit 0)", (_label, runner, nativeEvent) => {
		const out = encode(runner, nativeEvent, warn(STOP_LINE));
		expect(out.exit_code).toBe(0);
		expect(stdoutText(out)).not.toContain("mutation-kill-evidence");
		expect(out.stderr).toBe(STOP_LINE);
	});
});

describe("Stop-family warnings stay out of the context field on the runners that gained PostToolUse context", () => {
	it.each([
		["N10", "factory-droid", "SubagentStop"],
		["N11", "copilot-cli", "subagentStop"],
	] as const)("%s: %s %s keeps an advisory warning off stdout (stderr only)", (_label, runner, nativeEvent) => {
		const out = encode(runner, nativeEvent, warn(STOP_LINE));
		expect(out.exit_code).toBe(0);
		expect(stdoutText(out)).not.toContain("mutation-kill-evidence");
		expect(out.stderr).toBe(STOP_LINE);
	});

	it("N12: gemini-cli AfterAgent carries additional_context but never the Stop warning in additionalContext", () => {
		const out = encode("gemini-cli", "AfterAgent", { decision: "allow", additional_context: "ctx-line", warnings: [STOP_LINE] });
		expect(stdoutJson(out)).toEqual({ hookSpecificOutput: { hookEventName: "AfterAgent", additionalContext: "ctx-line" } });
		expect(out.stderr).toBe(STOP_LINE);
	});
});

describe("capability table agrees with the Stop encoders", () => {
	it.each(["claude-code", "codex"] as const)("N9: %s Stop declares no model context and no catalog 'context' control", runner => {
		const stop = getAdapter(runner)!.capabilities.events.find(row => row.name === "Stop");
		expect(stop).toMatchObject({ model_context: false, controls: ["continue"] });
	});

	it.each([
		["claude-code", "PostToolUse"],
		["codex", "PostToolUse"],
		["factory-droid", "PostToolUse"],
		["copilot-cli", "postToolUse"],
		["gemini-cli", "AfterTool"],
	] as const)("P6: %s %s declares model context, backed by a catalog 'context' control", (runner, nativeEvent) => {
		const post = getAdapter(runner)!.capabilities.events.find(row => row.name === nativeEvent);
		expect(post?.model_context).toBe(true);
		expect(post?.controls).toContain("context");
	});
});
