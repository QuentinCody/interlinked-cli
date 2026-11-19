// Instruction packets, design §9: with the daemon unreachable NO packet is live, so a
// SessionStart on the cold path hands back the verbatim text of every released packet
// as session context. No release ⇒ nothing; a tool call (not SessionStart) ⇒ nothing;
// an unparseable packet file ⇒ nothing (never a crash).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleFile, warnPacket } from "./harness/packets/fixtures.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./hook-entry-transport.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hook-entry-transport.js")>()),
	discoverSocket: () => null,
	callHookDaemon: transport.call,
}));

const TEXT = "Never full-read `collection.jsonl`,\n`activity.jsonl`, or `timeline.jsonl`.";
let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hook-cold-packets-start-"));
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, "CLAUDE.md"), "# rules\n");
	vi.resetModules();
	transport.call.mockReset().mockResolvedValue({ ok: false, error: "daemon unreachable" });
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function writePackets(released: boolean): void {
	const packet = warnPacket(released ? { release: { text: TEXT, released_at: "2026-11-05T20:00:00.000Z", span_hash: createHash("sha256").update(TEXT).digest("hex") } } : {});
	writeFileSync(join(root, ".interlinked", "instruction-packets.json"), JSON.stringify(sampleFile([packet])));
}

async function coldEvent(nativeEventName: string, nativeJson: Record<string, unknown>, runner = "claude-code") {
	const { runHookEntry } = await import("./hook-entry.js");
	return runHookEntry({ runner, nativeEventName, nativeJson, socketPath: join(root, ".interlinked", "missing.sock"), env: { PATH: process.env.PATH ?? "", VITEST: "true" }, cwd: root });
}

/** True when the output's stdout carries the released text — raw or escaped inside a JSON context field. */
const visible = (stdout: string | undefined) => (stdout ?? "").includes("`activity.jsonl`, or `timeline.jsonl`.") || (stdout ?? "").includes(JSON.stringify("`activity.jsonl`, or `timeline.jsonl`.").slice(1, -1));
const tool = (session: string) => ({ cwd: root, session_id: session, sessionId: session, tool_name: "Bash", toolName: "shell", tool_input: { command: "ls" }, toolInput: { command: "ls" } });

describe("cold path on runners whose SessionStart never reaches the model (seventh review, P1)", () => {
	it.each([
		["copilot-cli", "sessionStart", "postToolUse"],
		["gemini-cli", "SessionStart", "AfterTool"],
		["cursor", "sessionStart", "postToolUse"],
		// Break R1: the OpenCode and Pi bridges PRINT warnings on their SessionStart, which the model never sees;
		// the receipt must come from the capability table, so the first post-tool event still delivers.
		["opencode", "event:session.created", "tool.execute.after"],
		["pi", "session_start", "tool_result"],
	])("P2: %s — SessionStart output is not model-visible, so the FIRST visible post-tool event carries the words, once", async (runner, start, post) => {
		writePackets(true);
		const atStart = await coldEvent(start, { cwd: root, session_id: "c1", sessionId: "c1", source: "startup" }, runner);
		// A bridge (OpenCode, Pi) prints the decision JSON on every event; elsewhere the text is not even in stdout.
		if (runner !== "opencode" && runner !== "pi") expect(visible(atStart.stdout)).toBe(false);
		const first = await coldEvent(post, tool("c1"), runner);
		expect(first.fell_back).toBe(true);
		expect(visible(first.stdout)).toBe(true);
		const second = await coldEvent(post, tool("c1"), runner);
		expect(visible(second.stdout)).toBe(false);
		// Another session of the same runner still gets it.
		expect(visible((await coldEvent(post, tool("c2"), runner)).stdout)).toBe(true);
	});
	it("P3: Cursor's invisible afterShellExecution does not use up the delivery; the next postToolUse still carries it", async () => {
		writePackets(true);
		const invisible = await coldEvent("afterShellExecution", { ...tool("c3"), command: "ls" }, "cursor");
		expect(visible(invisible.stdout)).toBe(false);
		expect(visible((await coldEvent("postToolUse", tool("c3"), "cursor")).stdout)).toBe(true);
	});
	it("N4: Claude Code got the words at its model-visible SessionStart — the first post-tool call does not repeat them", async () => {
		writePackets(true);
		expect(visible((await coldEvent("SessionStart", { cwd: root, session_id: "c4", source: "startup" })).stdout)).toBe(true);
		expect(visible((await coldEvent("PostToolUse", { ...tool("c4"), tool_response: {} })).stdout)).toBe(false);
	});
	it("P6 (break R1): a tool cwd in a subdirectory still gets the words — the project root is found by walking up", async () => {
		writePackets(true);
		writeFileSync(join(root, ".interlinked", "config.json"), "{}");
		mkdirSync(join(root, "src", "deep"), { recursive: true });
		const deep = join(root, "src", "deep");
		const result = await coldEvent("SessionStart", { cwd: deep, session_id: "c6", source: "startup" });
		expect(visible(result.stdout)).toBe(true);
	});
	it("P5: a packet file a strict parser refuses (a newer CLI's field) still hands back its verified release", async () => {
		writePackets(true);
		const path = join(root, ".interlinked", "instruction-packets.json");
		writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>), field_from_a_newer_cli: 1 }));
		const result = await coldEvent("SessionStart", { cwd: root, session_id: "c5", source: "startup" });
		expect(visible(result.stdout)).toBe(true);
		expect(result.stdout).toContain("the packet file does not parse");
	});
});

describe("cold SessionStart — released instruction text", () => {
	it("P1: prints the released text as session context, tagged with the daemon-down reason", async () => {
		writePackets(true);
		const result = await coldEvent("SessionStart", { cwd: root, session_id: "s1", source: "startup" });
		expect(result.fell_back).toBe(true);
		expect(result.stdout).toContain("[interlinked:packet bounded-log-read] not live here (daemon unreachable)");
		expect(result.stdout).toContain("`activity.jsonl`, or `timeline.jsonl`.");
	});
	it("N1: nothing released ⇒ no packet line", async () => {
		writePackets(false);
		const result = await coldEvent("SessionStart", { cwd: root, session_id: "s1", source: "startup" });
		expect(result.stdout ?? "").not.toContain("[interlinked:packet");
	});
	it("N2: a tool call on the cold path never prints released text", async () => {
		writePackets(true);
		const result = await coldEvent("PreToolUse", { cwd: root, session_id: "s1", tool_name: "Read", tool_input: { file_path: join(root, "CLAUDE.md") } });
		expect(result.stdout ?? "").not.toContain("[interlinked:packet");
	});
	it("N3: an unparseable packet file prints nothing and does not crash the hook", async () => {
		writeFileSync(join(root, ".interlinked", "instruction-packets.json"), "{");
		const result = await coldEvent("SessionStart", { cwd: root, session_id: "s1", source: "startup" });
		expect(result.exit_code).toBe(0);
		expect(result.stdout ?? "").not.toContain("[interlinked:packet");
	});
});
