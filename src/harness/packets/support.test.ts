import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_WRITE_TOOLS, CODEX_WRITE_TOOLS } from "../../lib/write-tool-registry.js";
import { samplePacket } from "./fixtures.js";
import { packetSupport, postToolUseTools, runnerIdOf, runnerSupportsAsk } from "./support.js";
import type { Packet } from "./types.js";

function withApplies(partial: Partial<Packet["applies"]>, rest: Partial<Packet> = {}): Packet {
	return samplePacket({ applies: { ...samplePacket().applies, ...partial }, ...rest });
}

describe("packetSupport — positive (supported)", () => {
	it("P1: a PostToolUse Bash packet is delivered on Claude Code and Codex", () => {
		expect(packetSupport(samplePacket(), "claude-code")).toEqual({ supported: true });
		expect(packetSupport(samplePacket(), "codex")).toEqual({ supported: true });
	});

	it("P2: a PostToolUse Edit packet is delivered on Claude Code", () => {
		expect(packetSupport(withApplies({ tools: ["Edit", "Write"] }), "claude-code")).toEqual({ supported: true });
	});

	it("P3: a PostToolUse apply_patch packet is delivered on Codex", () => {
		expect(packetSupport(withApplies({ tools: ["apply_patch"] }), "codex")).toEqual({ supported: true });
	});

	it("P4: a PreToolUse Read packet is delivered (the pre hook has no tool matcher)", () => {
		expect(packetSupport(withApplies({ phase: "pre", tools: ["Read"] }), "claude-code")).toEqual({ supported: true });
	});

	it("P5: a window packet at the stop phase is delivered on both runners", () => {
		const w = withApplies({ phase: "stop", tools: [] }, { kind: "window", evidence: "window_digest" });
		expect(packetSupport(w, "claude-code")).toEqual({ supported: true });
		expect(packetSupport(w, "codex")).toEqual({ supported: true });
	});
});

describe("packetSupport — negative (unsupported, with the reason)", () => {
	it("N1: a PostToolUse Read packet never executes on Claude Code (R7)", () => {
		const r = packetSupport(withApplies({ tools: ["Read"] }), "claude-code");
		expect(r.supported).toBe(false);
		if (!r.supported) expect(r.reason).toMatch(/Read.*PostToolUse.*claude-code/);
	});

	it("N2: a PostToolUse Edit packet never executes on Codex (its patch verb is apply_patch)", () => {
		const r = packetSupport(withApplies({ tools: ["Edit"] }), "codex");
		expect(r.supported).toBe(false);
	});

	it("N3: one unsupported tool in the list makes the packet unsupported", () => {
		const r = packetSupport(withApplies({ tools: ["Bash", "Grep"] }), "claude-code");
		expect(r.supported).toBe(false);
		if (!r.supported) expect(r.reason).toContain("Grep");
	});

	it("N4: a runner with no delivery table is unsupported, not assumed", () => {
		const r = packetSupport(samplePacket(), "cursor");
		expect(r.supported).toBe(false);
		if (!r.supported) expect(r.reason).toContain("cursor");
	});
});

describe("postToolUseTools — derived from the registries, never a list here", () => {
	it("P6: equals the adapters' matcher lists", () => {
		expect(postToolUseTools("claude-code")).toEqual(CLAUDE_CODE_WRITE_TOOLS);
		expect(postToolUseTools("codex")).toEqual(CODEX_WRITE_TOOLS);
		expect(postToolUseTools("cursor")).toBeNull();
	});
});

describe("runnerIdOf — the hook event's agent_source is the legacy client id", () => {
	it("P7: `claude` (what live events carry) maps to the adapter id `claude-code`; codex is itself; unknown passes through", () => {
		expect(runnerIdOf("claude")).toBe("claude-code");
		expect(runnerIdOf("codex")).toBe("codex");
		expect(runnerIdOf("claude-code")).toBe("claude-code");
		expect(runnerIdOf("mystery")).toBe("mystery");
		expect(packetSupport(samplePacket(), "claude")).toEqual({ supported: true });
	});
});

describe("runnerSupportsAsk — derived from the adapters' PreToolUse control", () => {
	it("P8: Claude Code can ask; Codex can only deny; an unknown runner cannot ask", () => {
		expect(runnerSupportsAsk("claude-code")).toBe(true);
		expect(runnerSupportsAsk("claude")).toBe(true);
		expect(runnerSupportsAsk("codex")).toBe(false);
		expect(runnerSupportsAsk("cursor")).toBe(false);
	});
});
