// Adapter matrix for instruction-packet lines (design §10 / §12 "cross-runner"):
// a `[interlinked:packet …]` warning on an ALLOW must reach the model on every
// installed post-tool and session-start event whose capability table says
// `model_context: true`, and the text must survive verbatim (the released
// instruction is multi-line). The capability table is the contract; this test
// pins that each encoder honors it. Bridge runners (OpenCode, Pi) hand the
// whole decision JSON to their bridge, which carries warnings on every event —
// so for them the packet line is present even where the table says the model
// does not see it; that is the bridge's call, pinned as such.
import { describe, expect, it } from "vitest";
import { buildAllAdapters } from "./index.js";

const LINE = "[interlinked:packet prefer-rg] not live here (jev disabled); instruction released from CLAUDE.md, verbatim:\nPrefer `rg` over `grep`/`find` — it is installed,\n  faster, and respects ignore files.";
const ESCAPED = JSON.stringify(LINE).slice(1, -1);
/** Runners whose output is a decision JSON for a bridge; warnings are present whatever the table says. */
const BRIDGE = new Set(["opencode", "pi"]);

function carries(stdout: string | undefined): boolean {
	const s = stdout ?? "";
	return s.includes(LINE) || s.includes(ESCAPED);
}

function minimalNative(name: string): Record<string, unknown> {
	return { session_id: "s", sessionId: "s", cwd: process.cwd(), tool_name: "Bash", toolName: "shell", tool_input: { command: "ls" }, toolInput: { command: "ls" }, hook_event_name: name };
}

describe("packet line delivery × adapter × event", () => {
	const cases: { runner: string; event: string; phase: string; modelContext: boolean }[] = [];
	for (const adapter of buildAllAdapters()) {
		for (const e of adapter.capabilities.events) {
			if (!e.install || (e.phase !== "post-tool" && e.phase !== "session-start")) continue;
			cases.push({ runner: adapter.id, event: e.name, phase: e.phase, modelContext: e.model_context });
		}
	}
	it("the matrix is non-trivial: Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode and Pi all take part", () => {
		const runners = new Set(cases.map((c) => c.runner));
		for (const r of ["claude-code", "codex", "copilot-cli", "gemini-cli", "cursor", "opencode", "pi"]) expect(runners.has(r)).toBe(true);
		expect(cases.filter((c) => c.modelContext).length).toBeGreaterThanOrEqual(10);
	});
	it.each(cases)("$runner $event ($phase): model_context=$modelContext ⇔ the packet line rides a model-visible stdout channel", ({ runner, event, modelContext }) => {
		const adapter = buildAllAdapters().find((a) => a.id === runner);
		if (!adapter) throw new Error(runner);
		const unified = adapter.parseHookInput(minimalNative(event), event);
		const out = adapter.encodeDecision({ decision: "allow", warnings: [LINE] }, unified);
		expect(out.exit_code).toBe(0);
		if (modelContext) expect(carries(out.stdout)).toBe(true);
		else if (!BRIDGE.has(runner)) expect(carries(out.stdout)).toBe(false);
	});
	it("session-start reaches the model only on Claude Code, Codex and Factory Droid — every other runner needs the first-call fallback (packets-phase.ts)", () => {
		const visible = cases.filter((c) => c.phase === "session-start" && c.modelContext).map((c) => c.runner).sort();
		expect(visible).toEqual(["claude-code", "codex", "factory-droid"]);
	});
});
