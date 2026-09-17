import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevClient } from "../jev/client.js";
import type { HarnessEvent } from "../types.js";
import { buildJevClaimWarning } from "./lifecycle-stop-jev.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-jev-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const FINAL = "The client is written to src/x.ts and all 14 tests pass now.";

function transcriptWithOneTurn(): string {
	const lines = [
		{ type: "user", message: { role: "user", content: "do it" } },
		{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/x.ts" } }] } },
		{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "File created" }] } },
		{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: FINAL }] } },
	];
	const path = join(dir, "t.jsonl");
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return path;
}

function noulClient(checkable: number, evidenced: number): JevClient {
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> }; // SAFETY: the client serializes exactly this shape
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: id.startsWith("k") ? checkable : evidenced };
		return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
	});
	return new JevClient({ apiKey: "k", fetchImpl });
}

function stopEvent(extra: Partial<HarnessEvent>): HarnessEvent {
	return { hook_event: "Stop", session_id: "s", agent_source: "claude", tool_name: "", tool_input: {}, timestamp: "2026-09-16T00:00:00Z", ...extra } as HarnessEvent; // SAFETY: test fixture; only the fields the SUT reads are populated
}

describe("buildJevClaimWarning — positive (must fire)", () => {
	it("P1: an unbacked checkable claim in the final message yields the jev-claims warning", async () => {
		const w = await buildJevClaimWarning(noulClient(0.9, 0.1), stopEvent({ last_assistant_message: FINAL, transcript_path: transcriptWithOneTurn() }));
		expect(w).toContain("[interlinked:jev-claims]");
		expect(w).toContain("14 tests pass");
	});
});

describe("buildJevClaimWarning — negative (must not fire)", () => {
	it("N1: null client (Jev disabled) → null without touching the transcript", async () => {
		expect(await buildJevClaimWarning(null, stopEvent({ last_assistant_message: FINAL, transcript_path: join(dir, "missing.jsonl") }))).toBeNull();
	});
	it("N2: no final message on the event → null", async () => {
		expect(await buildJevClaimWarning(noulClient(0.9, 0.1), stopEvent({ transcript_path: transcriptWithOneTurn() }))).toBeNull();
	});
	it("N3: an unreadable transcript path → null (no evidence to judge against)", async () => {
		expect(await buildJevClaimWarning(noulClient(0.9, 0.1), stopEvent({ last_assistant_message: FINAL, transcript_path: join(dir, "missing.jsonl") }))).toBeNull();
	});
	it("N4: evidence backs the claims → null", async () => {
		expect(await buildJevClaimWarning(noulClient(0.9, 0.9), stopEvent({ last_assistant_message: FINAL, transcript_path: transcriptWithOneTurn() }))).toBeNull();
	});
	it("N5: a dry-run event never calls the model", async () => {
		const client = noulClient(0.9, 0.1);
		expect(await buildJevClaimWarning(client, stopEvent({ last_assistant_message: FINAL, transcript_path: transcriptWithOneTurn(), dry_run: true }))).toBeNull();
		expect(client.spend().calls).toBe(0);
	});
});
