import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callsFromCollectionRows, readCollectionCalls, readTimelineRows, readWindowSources, sessionWindow, type TimelineRow, turnWindows } from "./window-source.js";

const S = "sess-1";
function pre(seq: number, tool: string, action: Record<string, unknown>, ts: string, session = S): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider: "claude-code", provider_tool: tool, session_id: session, seq, tool_use_id: `${session}-${seq}`, ts, action });
}
function post(seq: number, tool: string, outcome: string | null, ts: string, session = S): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "post", provider: "claude-code", provider_tool: tool, session_id: session, seq, tool_use_id: `${session}-${seq}`, ts, action: {}, outcome, observation: { exit_code: null } });
}
const prompt = (ts: string, text: string, session = S): TimelineRow => ({ ts, session, category: "user_prompt", text });
const message = (ts: string, text: string, session = S): TimelineRow => ({ ts, session, category: "agent_message", text });

const rows = [
	JSON.parse(pre(1, "Bash", { command: "npx vitest run src/a.test.ts" }, "2026-11-05T10:00:01Z")),
	JSON.parse(post(1, "Bash", "ok", "2026-11-05T10:00:02Z")),
	JSON.parse(pre(2, "Edit", { path: "/r/src/a.ts", diff: { hunks: [{ old: "a", new: "b" }] } }, "2026-11-05T10:00:03Z")),
	JSON.parse(post(2, "Edit", "fail", "2026-11-05T10:00:04Z")),
	JSON.parse(pre(3, "Bash", { command: "git commit -m x" }, "2026-11-05T10:01:01Z")),
	// no post row for seq 3: outcome unknown
	JSON.parse(pre(4, "Bash", { command: "ls" }, "2026-11-05T10:01:02Z", "other-session")),
] as unknown[];

describe("callsFromCollectionRows — positive", () => {
	it("P1: joins pre and post by tool_use_id, classifies, scopes, and maps outcomes; a missing post is unknown", () => {
		const calls = callsFromCollectionRows(rows, S);
		expect(calls.map((c) => [c.seq, c.class, c.outcome, c.scope])).toEqual([
			[1, "test", "pass", "file"],
			[2, "edit", "fail", "n/a"],
			[3, "git", "unknown", "n/a"],
		]);
		expect(calls[1]?.files).toEqual(["/r/src/a.ts"]);
	});
	it("P1b: a completed command whose exit code is non-zero is a FAIL, whatever the completion flag says", () => {
		const r = [
			JSON.parse(pre(7, "Bash", { command: "npx vitest run src/x.test.ts" }, "2026-11-05T10:03:01Z")),
			JSON.parse(JSON.stringify({ ...JSON.parse(post(7, "Bash", "ok", "2026-11-05T10:03:02Z")), observation: { exit_code: 1 } })),
		];
		expect(callsFromCollectionRows(r, S)[0]?.outcome).toBe("fail");
	});
	it("N1: rows of another session are ignored", () => {
		expect(callsFromCollectionRows(rows, S).some((c) => c.seq === 4)).toBe(false);
	});
});

describe("turnWindows — prompts split the session into turns", () => {
	const timeline = [prompt("2026-11-05T10:00:00Z", "run the tests and fix a.ts"), message("2026-11-05T10:00:30Z", "fixed"), prompt("2026-11-05T10:01:00Z", "ship it"), message("2026-11-05T10:02:00Z", "committed")];
	it("P2: one window per prompt, in order, each with its prompt, its calls and the last message before the next prompt", () => {
		const windows = turnWindows(S, callsFromCollectionRows(rows, S), timeline);
		expect(windows).toHaveLength(2);
		expect(windows[0]).toEqual(expect.objectContaining({ kind: "turn", prompts: ["run the tests and fix a.ts"], final_message: "fixed", from_seq: 1, to_seq: 2 }));
		expect(windows[1]).toEqual(expect.objectContaining({ prompts: ["ship it"], final_message: "committed", from_seq: 3, to_seq: 3 }));
	});
	it("P3: calls before the first prompt form a prompt-less leading turn (the log can start mid-session)", () => {
		const windows = turnWindows(S, callsFromCollectionRows(rows, S), [prompt("2026-11-05T10:00:30Z", "late")]);
		expect(windows[0]?.prompts).toEqual([]);
		expect(windows[0]?.calls.map((c) => c.seq)).toEqual([1, 2]);
		expect(windows[1]?.calls.map((c) => c.seq)).toEqual([3]);
	});
	it("N2: a turn with no calls is still a window (an empty turn is evidence too)", () => {
		const windows = turnWindows(S, [], timeline);
		expect(windows.map((w) => w.calls.length)).toEqual([0, 0]);
	});
	it("P4: sessionWindow holds every call and every prompt in order", () => {
		const w = sessionWindow(S, callsFromCollectionRows(rows, S), timeline);
		expect(w.kind).toBe("session");
		expect(w.prompts).toEqual(["run the tests and fix a.ts", "ship it"]);
		expect(w.calls.map((c) => c.seq)).toEqual([1, 2, 3]);
		expect(w.final_message).toBe("committed");
	});
});

describe("readers", () => {
	it("P5: readCollectionCalls and readTimelineRows stream a bounded tail, skip a torn line, and filter by session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packets-window-"));
		const torn = "not json at all";
		writeFileSync(join(dir, "collection.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		writeFileSync(join(dir, "timeline.jsonl"), `${[JSON.stringify({ schema: "timeline.v1", ts: "2026-11-05T10:00:00Z", session: S, category: "user_prompt", text: "hi" }), torn, JSON.stringify({ schema: "timeline.v1", ts: "2026-11-05T10:00:05Z", session: "x", category: "user_prompt", text: "no" })].join("\n")}\n`);
		const calls = await readCollectionCalls(join(dir, "collection.jsonl"), 1024 * 1024, S);
		const tl = await readTimelineRows(join(dir, "timeline.jsonl"), 1024 * 1024, S);
		rmSync(dir, { recursive: true, force: true });
		expect(calls.map((c) => c.seq)).toEqual([1, 2, 3]);
		expect(tl).toEqual([{ ts: "2026-11-05T10:00:00Z", session: S, category: "user_prompt", text: "hi" }]);
	});
	it("P6: readWindowSources reads each log once and groups by session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packets-window-"));
		writeFileSync(join(dir, "collection.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		writeFileSync(join(dir, "timeline.jsonl"), `${JSON.stringify({ schema: "timeline.v1", ts: "2026-11-05T10:00:00Z", session: S, category: "user_prompt", text: "hi" })}\n`);
		const by = await readWindowSources(join(dir, "collection.jsonl"), join(dir, "timeline.jsonl"), 1024 * 1024, new Set([S, "other-session"]));
		rmSync(dir, { recursive: true, force: true });
		expect(by.get(S)?.calls.map((c) => c.seq)).toEqual([1, 2, 3]);
		expect(by.get(S)?.timeline).toHaveLength(1);
		expect(by.get("other-session")?.calls.map((c) => c.seq)).toEqual([4]);
		expect(by.get(S)?.provider).toBe("claude-code");
	});
	it("N3: missing files yield nothing", async () => {
		expect(await readCollectionCalls("/nonexistent/c.jsonl", 1024, S)).toEqual([]);
		expect(await readTimelineRows("/nonexistent/t.jsonl", 1024, S)).toEqual([]);
	});
});
