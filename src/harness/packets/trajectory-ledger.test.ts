import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { JevFetch } from "../jev/client.js";
import type { GuardRulesConfig } from "../types.js";
import { recordVisibleFallback } from "./fallback-ledger.js";
import { sampleFile, samplePacket } from "./fixtures.js";
import { withHash } from "./schema.js";
import { resetTrajectoryState, SCREEN_OPTIONS, WINDOW_LEDGER, type WindowJudgmentRow, windowJudgmentId } from "./trajectory.js";
import { drainWindowWarnings, drainWindowWarningsForStart, queueWindowWarnings, resetWindowQueue, runWindowEvaluation } from "./trajectory-ledger.js";
import type { Packet } from "./types.js";

let tmp: string;
const S = "sess-aaaa";
const CLAUDE_MD = "# rules\n";

function windowPacket(overrides: Partial<Packet> = {}): Packet {
	return samplePacket({
		id: "commit-unprompted",
		kind: "window",
		source: { file: "CLAUDE.md", span: null, quote: "Never commit without authorization." },
		applies: { phase: "stop", tools: [], command_regex: "git\\s+commit", path_regex: null, exclude_path_regex: null, new_text_regex: null, role: null },
		evidence: "window_calls",
		questions: { violated: samplePacket().questions.violated, where: { type: "choice", over: "window_calls", instructions: "which call?" } },
		...overrides,
	});
}
function writePackets(packets: Packet[]): void {
	writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), JSON.stringify(sampleFile(packets.map(withHash), { sources: { "CLAUDE.md": createHash("sha256").update(CLAUDE_MD).digest("hex") } })));
}
function pre(seq: number, command: string, ts: string): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider: "claude-code", provider_tool: "Bash", session_id: S, seq, tool_use_id: `${S}-${seq}`, ts, action: { command } });
}
function post(seq: number, ts: string): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "post", provider: "claude-code", provider_tool: "Bash", session_id: S, seq, tool_use_id: `${S}-${seq}`, ts, action: {}, outcome: "ok" });
}
function timeline(ts: string, category: string, text: string): string {
	return JSON.stringify({ schema: "timeline.v1", ts, session: S, category, text });
}
const rules = (): GuardRulesConfig => ({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["window", "prompts"], paths: [] } } }) as unknown as GuardRulesConfig;
const jevOk: JevFetch = async (_input, init) => {
	const req = JSON.parse(String(init.body)) as { questions: Record<string, { type: string }> };
	const answers: Record<string, unknown> = {};
	for (const [id, q] of Object.entries(req.questions)) {
		if (id.endsWith(":screen")) answers[id] = { type: "choice", choice: "could-apply", probabilities: Object.fromEntries(SCREEN_OPTIONS.map((o) => [o, 0.33])), confidence: 0.5 };
		else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
		else answers[id] = { type: "choice", choice: "c2", probabilities: { c1: 0.1, c2: 0.9, none: 0 }, confidence: 0.9 };
	}
	return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 50, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const jevDown: JevFetch = async () => new Response("nope", { status: 500 });
/** A released window packet at warn, bound to this evaluator (claude-code, jev-1.14.0). */
function releasedWindowPacket(): Packet {
	const text = "Never commit without authorization.";
	const base = windowPacket();
	return {
		...base,
		calibration: {
			status: "warn",
			bound_to: { packet_hash: base.packet_hash, renderer: "evidence-v1", redaction: "e20-v3", model: "jev-1.14.0", runner: "claude-code" },
			tau: 0.7,
			holdout: { n: 60, pos: 20, auroc: 0.95, precision_at_tau: 0.9, recall_at_tau: 0.75 },
			adjudication: null,
			measured_at: "2026-11-05T16:00:00.000Z",
		},
		release: { text, released_at: "2026-11-05T20:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") },
	};
}
const ledger = (): WindowJudgmentRow[] => (existsSync(join(tmp, ".interlinked", WINDOW_LEDGER)) ? readFileSync(join(tmp, ".interlinked", WINDOW_LEDGER), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as WindowJudgmentRow) : []);

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-traj-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), CLAUDE_MD);
	writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[pre(1, "npx vitest run src/a.test.ts", "2026-11-05T10:00:01Z"), post(1, "2026-11-05T10:00:02Z"), pre(2, "git commit -m wip", "2026-11-05T10:00:03Z"), post(2, "2026-11-05T10:00:04Z")].join("\n")}\n`);
	writeFileSync(join(tmp, ".interlinked", "timeline.jsonl"), `${[timeline("2026-11-05T10:00:00Z", "user_prompt", "fix the test, do not commit"), timeline("2026-11-05T10:00:05Z", "agent_message", "done")].join("\n")}\n`);
	resetTrajectoryState();
	resetWindowQueue();
});

describe("runWindowEvaluation — positive", () => {
	it("P1: a turn window is built from the two logs, judged, and written to the window ledger", async () => {
		writePackets([windowPacket()]);
		const rows = await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevOk, resolveKey: () => "k", sample: () => 0.99 } });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({ packet: "commit-unprompted", screen: "trigger", p: 0.9, chosen_call: 2, runner: "claude-code", source: "live" }));
		expect(rows[0]?.window).toEqual(expect.objectContaining({ kind: "turn", from_seq: 1, to_seq: 2, calls: 2 }));
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]?.shown).toBe(false);
	});
	it("P2: a session window spans every call", async () => {
		writePackets([windowPacket({ applies: { ...windowPacket().applies, phase: "session_start" }, kind: "session" })]);
		const rows = await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "session", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevOk, resolveKey: () => "k", sample: () => 0.99 } });
		expect(rows[0]?.window.kind).toBe("session");
	});
});

describe("runWindowEvaluation — released text when the window path is not live (R41)", () => {
	it("P4: a Jev outage at Stop queues the released text; the next PostToolUse delivers it once; the ledger holds no fallback row", async () => {
		writePackets([releasedWindowPacket()]);
		const rows = await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevDown, resolveKey: () => "k", sample: () => 0.99 } });
		expect(rows[0]?.gate).toBe("ask_failed");
		const delivered = drainWindowWarnings(tmp, S);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatch(/^\[interlinked:packet commit-unprompted\] not live here \(Jev unreachable\); instruction released from CLAUDE\.md, verbatim:\nNever commit without authorization\./);
		expect(ledger().some((r) => r.fallback === true)).toBe(false);
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
		// Drained but NOT yet recorded as received (an invisible event): a second outage queues it again.
		await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevDown, resolveKey: () => "k", sample: () => 0.99 } });
		const again = drainWindowWarnings(tmp, S);
		expect(again).toHaveLength(1);
		// The hook recorded that the model received it: a third outage queues nothing.
		recordVisibleFallback(join(tmp, ".interlinked"), { session_id: S, phase: "post-tool" }, again, JSON.stringify({ additionalContext: again.join("\n") }), "daemon", { modelVisible: true });
		await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevDown, resolveKey: () => "k", sample: () => 0.99 } });
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
	});
	it("N5: a SESSION window never queues released text — the session is over; its successor gets it at SessionStart", async () => {
		writePackets([releasedWindowPacket()]);
		await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "session", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevDown, resolveKey: () => "k", sample: () => 0.99 } });
		expect(drainWindowWarningsForStart(tmp).some((w) => w.includes("not live here"))).toBe(false);
	});
	it("N4: a spend cap on a window packet with nothing released queues nothing", async () => {
		writePackets([windowPacket()]);
		const capped = { jev: { enabled: true }, packets: { enabled: true, max_spend_usd: 0, evidence_consent: { kinds: ["window", "prompts"], paths: [] } } } as unknown as GuardRulesConfig;
		const rows = await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: capped, deps: { fetchImpl: jevOk, resolveKey: () => "k", sample: () => 0.99 } });
		expect(rows[0]?.gate).toBe("spend_cap");
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
	});
});

describe("runWindowEvaluation — negative", () => {
	it("N1: packets disabled is silent and writes nothing", async () => {
		writePackets([windowPacket()]);
		expect(await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: { jev: { enabled: true }, packets: { enabled: false } } as unknown as GuardRulesConfig, deps: { fetchImpl: jevOk, resolveKey: () => "k" } })).toEqual([]);
		expect(ledger()).toEqual([]);
	});
	it("N2: no packet file is zero cost", async () => {
		expect(await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevOk, resolveKey: () => "k" } })).toEqual([]);
	});
	it("N3: a source edited since compile disables the set", async () => {
		writePackets([windowPacket()]);
		writeFileSync(join(tmp, "CLAUDE.md"), "changed\n");
		expect(await runWindowEvaluation({ cwd: tmp, sessionId: S, kind: "turn", runnerSource: "claude", rules: rules(), deps: { fetchImpl: jevOk, resolveKey: () => "k" } })).toEqual([]);
	});
});

describe("delivery queue — eligible window warnings ride the NEXT PostToolUse", () => {
	const eligibleRow = (): WindowJudgmentRow =>
		({ ts: "2026-11-05T10:00:06Z", session_id: S, runner: "claude-code", window: { kind: "turn", from_seq: 1, to_seq: 2, calls: 2, truncated: false }, packet: "commit-unprompted", packet_hash: "h".repeat(64), evidence_hash: "e".repeat(64), screen: "trigger", sampled: false, p: 0.95, chosen_call: 2, chosen_probabilities: null, settled: null, status: "warn", status_effective: "warn", eligible: true, shown: false, warning: "[interlinked:packet] [heuristic] commit-unprompted …", latency_ms: 1, input_tokens: 1, usd: 0, model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null, source: "live" }) as WindowJudgmentRow;
	it("P3: queued eligible rows are drained once, returned as lines, and re-appended with shown=true under the same id", () => {
		queueWindowWarnings(tmp, S, [eligibleRow()]);
		const lines = drainWindowWarnings(tmp, S);
		expect(lines).toEqual(["[interlinked:packet] [heuristic] commit-unprompted …"]);
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
		const rows = ledger();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({ shown: true, eligible: true }));
		expect(windowJudgmentId(rows[0]!)).toBe(windowJudgmentId(eligibleRow()));
	});
	it("N4: non-eligible rows are never queued; another session's queue is untouched", () => {
		queueWindowWarnings(tmp, S, [{ ...eligibleRow(), eligible: false, warning: null }]);
		queueWindowWarnings(tmp, "other", [{ ...eligibleRow(), session_id: "other" }]);
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
		expect(drainWindowWarnings(tmp, "other")).toHaveLength(1);
	});
	it("P5: the queue is on disk, so it survives a daemon restart (a fresh reader drains it)", () => {
		queueWindowWarnings(tmp, S, [eligibleRow()]);
		resetWindowQueue();
		expect(readFileSync(join(tmp, ".interlinked", "packet-window-pending.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		expect(drainWindowWarnings(tmp, S)).toHaveLength(1);
	});
	it("P6: a SESSION-window finding of an ended session is delivered to the NEXT session at SessionStart, not to the dead session's PostToolUse", () => {
		const sessionFinding = { ...eligibleRow(), window: { ...eligibleRow().window, kind: "session" as const } };
		queueWindowWarnings(tmp, S, [sessionFinding]);
		expect(drainWindowWarnings(tmp, S)).toEqual([]);
		const lines = drainWindowWarningsForStart(tmp);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`from session ${S.slice(0, 8)}`);
		expect(drainWindowWarningsForStart(tmp)).toEqual([]);
		expect(ledger().some((r) => r.shown && r.window.kind === "session")).toBe(true);
	});
});
