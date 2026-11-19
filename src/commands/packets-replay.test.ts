// Unit pins for the pure helpers of `interlinked packets replay | replay-windows`.
// The command-level behavior (ledger rows, skips, the unauthorized-commit acceptance
// case) is pinned in packets.test.ts through the re-exports in packets.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPacketEvaluatorState } from "../harness/packets/evaluator.js";
import { samplePacket } from "../harness/packets/fixtures.js";
import type { ReplayRow } from "../harness/packets/replay.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import { packetsCompileCommand } from "./packets.js";
import { boundedWork, newestSessions, packetsReplayCommand, pairPostToPre, toolInputOf } from "./packets-replay.js";

const row = (session_id: string, seq: number, view: ReplayRow["view"]): ReplayRow => ({ session_id, seq, tool_use_id: `${session_id}-${seq}`, provider: "claude-code", view });
const bash = (command: string): ReplayRow["view"] => ({ tool: "Bash", phase: "pre", path: null, command, hunks: [] });
const edit = (path: string, hunks: { old: string; new: string }[], tool = "Edit"): ReplayRow["view"] => ({ tool, phase: "pre", path, command: null, hunks });

describe("toolInputOf — rebuilding a tool_input from a collection view", () => {
	it("P1: a command view is a Bash input", () => {
		expect(toolInputOf(row("s", 1, bash("ls")))).toEqual({ tool: "Bash", input: { command: "ls" } });
	});
	it("P2: one empty→content hunk is a Write; one old/new hunk is an Edit; several hunks are a MultiEdit", () => {
		expect(toolInputOf(row("s", 1, edit("/r/a.ts", [{ old: "", new: "x" }], "Write")))).toEqual({ tool: "Write", input: { file_path: "/r/a.ts", content: "x" } });
		expect(toolInputOf(row("s", 1, edit("/r/a.ts", [{ old: "a", new: "b" }])))).toEqual({ tool: "Edit", input: { file_path: "/r/a.ts", old_string: "a", new_string: "b" } });
		expect(toolInputOf(row("s", 1, edit("/r/a.ts", [{ old: "a", new: "b" }, { old: "c", new: "d" }])))?.tool).toBe("MultiEdit");
	});
	it("N1: an apply_patch view, or a view with no path, cannot be rebuilt", () => {
		expect(toolInputOf(row("s", 1, edit("/r/a.ts", [{ old: "", new: "x" }], "apply_patch")))).toBeNull();
		expect(toolInputOf(row("s", 1, { tool: "Edit", phase: "pre", path: null, command: null, hunks: [] }))).toBeNull();
	});
});

describe("newestSessions — by first appearance in append order", () => {
	it("P3: keeps the last n distinct session ids in order of first appearance", () => {
		const rows = [row("a", 1, bash("x")), row("b", 1, bash("x")), row("a", 2, bash("x")), row("c", 1, bash("x"))];
		expect([...newestSessions(rows, 2)]).toEqual(["b", "c"]);
		expect([...newestSessions(rows, 10)]).toEqual(["a", "b", "c"]);
	});
});

describe("pairPostToPre (break R5 #7)", () => {
	const at = (seq: number, phase: "pre" | "post", tool_use_id: string | null = null): ReplayRow => ({ session_id: "s", seq, tool_use_id, provider: null, view: { tool: "Bash", phase, path: null, command: "ls", hunks: [] } });
	it("P4: a post row pairs with the newest unpaired pre row before it; a blocked call (pre, no post) stays unpaired", () => {
		expect([...pairPostToPre([at(1, "pre"), at(2, "pre"), at(3, "post")])]).toEqual([["s#3", "s#2"]]);
		expect([...pairPostToPre([at(1, "pre"), at(2, "post"), at(3, "pre"), at(4, "post")])]).toEqual([
			["s#2", "s#1"],
			["s#4", "s#3"],
		]);
	});
	it("N2: rows with a tool_use_id are keyed by it and never paired", () => {
		expect(pairPostToPre([at(1, "pre", "t1"), at(2, "post", "t1")]).size).toBe(0);
	});
});

describe("pairPostToPre — a post row whose action cannot be rebuilt (R6 F2)", () => {
	const view = (tool: string, phase: "pre" | "post", command: string | null): ReplayRow["view"] => ({ tool, phase, path: null, command, hunks: [] });
	const at = (seq: number, phase: "pre" | "post", command: string | null = "ls", session = "s", tool = "Bash"): ReplayRow => ({ session_id: session, seq, tool_use_id: null, provider: null, view: view(tool, phase, command) });
	it("P5: pairs with the one unpaired pre row of the same session and tool before it", () => {
		expect([...pairPostToPre([at(1, "pre"), at(2, "post", null)])]).toEqual([["s#2", "s#1"]]);
		// Pre rows of another session, another tool, or AFTER the post are not candidates.
		expect([...pairPostToPre([at(1, "pre", "ls", "other"), at(2, "pre", "x", "s", "Read"), at(3, "pre"), at(4, "post", null), at(5, "pre")])]).toEqual([["s#4", "s#3"]]);
		// A pre row already paired is not a candidate either.
		expect([...pairPostToPre([at(1, "pre"), at(2, "post"), at(3, "pre"), at(4, "post", null)])]).toEqual([
			["s#2", "s#1"],
			["s#4", "s#3"],
		]);
	});
	it("N3: with two candidates it pairs with neither and leaves both open for a later post row", () => {
		expect(pairPostToPre([at(1, "pre"), at(2, "pre"), at(3, "post", null)]).size).toBe(0);
		expect([...pairPostToPre([at(1, "pre"), at(2, "pre"), at(3, "post", null), at(4, "post")])]).toEqual([["s#4", "s#2"]]);
	});
	it("N4: with no candidate before it, it pairs with nothing (a later pre row is not taken)", () => {
		expect(pairPostToPre([at(1, "post", null), at(2, "pre")]).size).toBe(0);
	});
});

describe("boundedWork — the calls one bounded run sends (review-100 n11)", () => {
	const never = { lastAttempt: () => null };
	const owe = (r: ReplayRow) => ({ row: r, only: new Set(["p"]) });
	it("P2 n11: unrebuildable calls never take the budget, so rebuildable calls behind them are sent", () => {
		const patches = [1, 2, 3].map((seq) => owe(row("s", seq, edit("/r/a.ts", [{ old: "", new: "x" }], "apply_patch"))));
		const sendable = owe(row("s", 4, bash("cat .interlinked/activity.jsonl")));
		const out = boundedWork([...patches, sendable], never, 2);
		expect(out.fresh.map((w) => w.row.seq)).toEqual([4]);
		expect(out.unrebuildable).toBe(3);
	});
	it("N n11: a call that owes nothing is neither sent nor counted unrebuildable", () => {
		const idle = { row: row("s", 1, edit("/r/a.ts", [{ old: "", new: "x" }], "apply_patch")), only: new Set<string>() };
		expect(boundedWork([idle], never, 5)).toEqual({ fresh: [], unrebuildable: 0 });
	});
});

describe("packetsReplayCommand — a live judgment keyed by an unrebuildable post row (R6 F2)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-packets-replay-"));
		mkdirSync(join(tmp, ".interlinked"));
		writeFileSync(join(tmp, "CLAUDE.md"), "# rules\n");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
	});
	const jevOk = async () =>
		new Response(JSON.stringify({ model: "jev-1.14.0", answers: { "bounded-log-read": { type: "noul", noul: 0.8 } }, usage: { input_tokens: 50, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
	async function compile(): Promise<string> {
		const p = samplePacket();
		const draft = join(tmp, "draft.json");
		writeFileSync(draft, JSON.stringify({ version: 1, compiler: { model: "m", skill: "enforce@4" }, sources: ["CLAUDE.md"], packets: [{ id: p.id, kind: p.kind, source: p.source, strength: p.strength, applies: p.applies, evidence: p.evidence, questions: p.questions }], skipped: [] }));
		vi.spyOn(console, "log").mockImplementation(() => {});
		await packetsCompileCommand({ from: draft, cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "guard-rules.local.json"), JSON.stringify({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["command"], paths: [] } } }));
		const parsed = parsePacketFile(readFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "utf8"));
		if (!parsed.ok) throw new Error("compile failed");
		return parsed.value.packets[0]?.packet_hash ?? "";
	}
	const callRow = (seq: number, phase: "pre" | "post", action: Record<string, unknown>) =>
		JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase, provider: "claude-code", provider_tool: "Bash", session_id: "s-new", seq, tool_use_id: null, ts: `2026-11-05T00:00:0${seq}Z`, action });
	const liveRow = (seq: number, hash: string) =>
		JSON.stringify({
			ts: "2026-11-05T00:00:00Z", session_id: "s-new", tool_use_id: null, seq, runner: "claude-code", tool: "Bash", packet: "bounded-log-read", packet_hash: hash, evidence_hash: "e".repeat(64), status: "shadow", status_effective: "shadow", p: 0.9, settled: null, source: "live",
			eligible: false, shown: false, warning: null, latency_ms: 1, input_tokens: 1, usd: 0, model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null,
		});
	async function replay(): Promise<{ events: number; already_judged: number; unrebuildable: number }> {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		resetPacketEvaluatorState();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k", json: true });
		return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { events: number; already_judged: number; unrebuildable: number };
	}
	it("P6: a call judged LIVE at a post event with an empty action is already judged for the replay of its pre row", async () => {
		const hash = await compile();
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[callRow(1, "pre", { command: "cat .interlinked/activity.jsonl" }), callRow(2, "post", {})].join("\n")}\n`);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${liveRow(2, hash)}\n`);
		expect(await replay()).toEqual(expect.objectContaining({ events: 0, already_judged: 1, unrebuildable: 0 }));
	});
	it("N5: with two open pre rows before the empty post row, neither is marked judged (no guess), and the empty row is never sent", async () => {
		const hash = await compile();
		const cmd = { command: "cat .interlinked/activity.jsonl" };
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[callRow(1, "pre", cmd), callRow(2, "pre", cmd), callRow(3, "post", {})].join("\n")}\n`);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${liveRow(3, hash)}\n`);
		expect(await replay()).toEqual(expect.objectContaining({ events: 2, already_judged: 0, unrebuildable: 0 }));
	});
});
