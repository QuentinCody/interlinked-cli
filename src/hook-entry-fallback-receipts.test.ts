// The daemon path's receipt (packets/fallback-ledger.ts): after `encodeHookResult` encodes a daemon decision for
// ONE native event, a released-text line counts as received only if that event reaches the model (capability
// table) and the line ends inside the runner's context limit. Breaks R1 (OpenCode/Pi bridges print on invisible
// events; Codex keeps 2,500 chars) and R3 (this line had no test) are pinned here at the real boundary.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAllAdapters } from "./harness/adapters/index.js";
import { deliveredIds } from "./harness/packets/fallback-ledger.js";
import { encodeHookResult } from "./hook-entry-translation.js";

const LINE = "[interlinked:packet prefer-rg] not live here (packets disabled); instruction released from CLAUDE.md, verbatim:\nPrefer `rg` when searching the sample project for test fixtures under the examples directory.";
let dataDir: string;
beforeEach(() => {
	dataDir = join(mkdtempSync(join(tmpdir(), "hook-receipts-")), ".interlinked");
	mkdirSync(dataDir);
});
afterEach(() => rmSync(join(dataDir, ".."), { recursive: true, force: true }));

function encode(runner: string, nativeEvent: string, warnings: string[], raw: Record<string, unknown> = {}) {
	const adapter = buildAllAdapters().find((a) => a.id === runner);
	if (!adapter) throw new Error(runner);
	const event = adapter.parseHookInput({ session_id: "s1", sessionId: "s1", cwd: join(dataDir, ".."), tool_name: "Bash", toolName: "shell", tool_input: { command: "ls" }, toolInput: { command: "ls" }, hook_event_name: nativeEvent, ...raw }, nativeEvent);
	return encodeHookResult({ adapter, event, decision: { decision: "allow", warnings }, dataDir, fellBack: false });
}

describe("encodeHookResult records what the model received", () => {
	it("P1: Claude Code PostToolUse carries the line in additionalContext — recorded", () => {
		encode("claude-code", "PostToolUse", [LINE]);
		expect([...deliveredIds(dataDir, "s1")]).toEqual(["prefer-rg"]);
	});
	it("N1 (break R1): OpenCode's session.created output carries the line, but the model never sees that event — not recorded", () => {
		const out = encode("opencode", "event:session.created", [LINE]);
		expect(out.stdout ?? "").toContain("prefer-rg");
		expect(deliveredIds(dataDir, "s1").size).toBe(0);
	});
	it("N2 (break R1): on Codex a line that ends past 2,500 characters of context is not recorded; the same line first is", () => {
		const filler = `[other] ${"x".repeat(2_480)}`;
		encode("codex", "PostToolUse", [filler, LINE]);
		expect(deliveredIds(dataDir, "s1").size).toBe(0);
		encode("codex", "PostToolUse", [LINE, filler]);
		expect([...deliveredIds(dataDir, "s1")]).toEqual(["prefer-rg"]);
	});
	it("N3: a simulated (dry-run) event records nothing", () => {
		encode("claude-code", "PostToolUse", [LINE], { dry_run: true });
		expect(deliveredIds(dataDir, "s1").size).toBe(0);
	});
});
