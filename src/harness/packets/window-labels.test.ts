import { describe, expect, it } from "vitest";
import { sampleFile, samplePacket } from "./fixtures.js";
import { withHash } from "./schema.js";
import { renderWindowState, type WindowJudgmentRow, windowJudgmentId } from "./trajectory.js";
import type { Packet } from "./types.js";
import { buildWindowLabelSheet, windowJudgedRows, windowLabeledJudgments } from "./window-labels.js";
import { sessionWindow, turnWindows, type WindowSource } from "./window-source.js";
import type { WindowCall } from "./window.js";

const S = "sess-aaaa";
function windowPacket(): Packet {
	return withHash(
		samplePacket({
			id: "commit-unprompted",
			kind: "window",
			applies: { phase: "stop", tools: [], command_regex: "git", path_regex: null, exclude_path_regex: null, new_text_regex: null, role: null },
			evidence: "window_calls",
		}),
	);
}
const file = sampleFile([windowPacket()]);
const call = (seq: number, command: string, ts: string): WindowCall => ({ seq, ts, tool: "Bash", class: "git", files: [], command, outcome: "pass", scope: "n/a" });
const source: WindowSource = {
	calls: [call(1, "git status", "2026-11-05T10:00:01Z"), call(2, "git commit -m x", "2026-11-05T10:00:02Z")],
	timeline: [{ ts: "2026-11-05T10:00:00Z", session: S, category: "user_prompt", text: "ship it" }],
	provider: "claude-code",
};
function row(overrides: Partial<WindowJudgmentRow> = {}): WindowJudgmentRow {
	return {
		ts: "2026-11-05T10:00:05Z", session_id: S, runner: "claude-code", window: { kind: "turn", from_seq: 1, to_seq: 2, calls: 2, truncated: false },
		packet: "commit-unprompted", packet_hash: file.packets[0]!.packet_hash, evidence_hash: "e".repeat(64), screen: "trigger", sampled: false,
		p: 0.4, chosen_call: 2, chosen_probabilities: null, settled: null, status: "shadow", status_effective: "shadow", eligible: false, shown: false, warning: null,
		latency_ms: 1, input_tokens: 1, usd: 0, model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null, source: "replay",
		...overrides,
	};
}
const config = { enabled: true, evidence_consent: { kinds: ["window", "prompts"] as ("window" | "prompts")[], paths: [] } };

describe("windowJudgedRows", () => {
	it("P1: keeps model judgments only, one per id (newest wins), under the packet's current hash", () => {
		const rows = [row({ ts: "t1", p: 0.1 }), row({ ts: "t2", p: 0.4 }), row({ gate: "insufficient", p: null }), row({ settled: "violated", p: null }), row({ packet_hash: "0".repeat(64) })];
		const judged = windowJudgedRows(rows, file);
		expect(judged).toHaveLength(1);
		expect(judged[0]?.p).toBe(0.4);
	});
});

describe("buildWindowLabelSheet", () => {
	it("P2: rebuilds the window from the session's logs, re-renders the evidence under consent, and carries no score", () => {
		const { sheet, unjoined } = buildWindowLabelSheet([row()], file, new Map([[S, source]]), config, "/repo");
		expect(unjoined).toBe(0);
		expect(sheet).toHaveLength(1);
		expect(sheet[0]).toEqual(expect.objectContaining({ id: windowJudgmentId(row()), kind: "window", packet: "commit-unprompted", instruction: samplePacket().source.quote }));
		expect(Object.keys(sheet[0] ?? {}).sort()).toEqual(["evidence", "id", "instruction", "kind", "packet", "question", "runner", "session_id", "window"]);
		const ev = JSON.stringify(sheet[0]?.evidence);
		expect(ev).toContain("ship it");
		expect(ev).toContain("2 git Bash pass");
	});
	it("N1: a window the logs no longer hold is unjoined", () => {
		const { sheet, unjoined } = buildWindowLabelSheet([row({ window: { kind: "turn", from_seq: 50, to_seq: 60, calls: 3, truncated: false } })], file, new Map([[S, source]]), config, "/repo");
		expect(sheet).toEqual([]);
		expect(unjoined).toBe(1);
	});
});

describe("buildWindowLabelSheet — session windows (review-100 n42)", () => {
	const twoTurns: WindowSource = {
		calls: [...source.calls, call(3, "git push", "2026-11-05T10:00:09Z")],
		timeline: [...source.timeline, { ts: "2026-11-05T10:00:08Z", session: S, category: "user_prompt", text: "now push" }],
		provider: "claude-code",
	};
	it("P2 n42: a session judgment joins the whole-session window, with every prompt", () => {
		const r = row({ window: { kind: "session", from_seq: 1, to_seq: 3, calls: 3, truncated: false } });
		const { sheet, unjoined } = buildWindowLabelSheet([r], file, new Map([[S, twoTurns]]), config, "/repo");
		expect(unjoined).toBe(0);
		expect(sheet[0]?.window.kind).toBe("session");
		expect(sheet[0]?.evidence).toEqual(renderWindowState(sessionWindow(S, twoTurns.calls, twoTurns.timeline), config, "/repo").entry);
	});
	it("P2 n42: in a one-turn session with equal bounds, a session row shows the session digest, not the turn digest", () => {
		const r = row({ window: { kind: "session", from_seq: 1, to_seq: 2, calls: 2, truncated: false } });
		const { sheet } = buildWindowLabelSheet([r], file, new Map([[S, source]]), config, "/repo");
		expect(sheet[0]?.evidence).toEqual(renderWindowState(sessionWindow(S, source.calls, source.timeline), config, "/repo").entry);
		expect(sheet[0]?.evidence).not.toEqual(renderWindowState(turnWindows(S, source.calls, source.timeline)[0]!, config, "/repo").entry);
	});
	it("N n42: a session row whose bounds the logs no longer hold is unjoined", () => {
		const r = row({ window: { kind: "session", from_seq: 1, to_seq: 9, calls: 9, truncated: false } });
		expect(buildWindowLabelSheet([r], file, new Map([[S, twoTurns]]), config, "/repo").unjoined).toBe(1);
	});
});

describe("windowLabeledJudgments", () => {
	it("P3: joins labels by window id with the evaluator cohort", () => {
		const r = row();
		const items = windowLabeledJudgments([r], { A: { [windowJudgmentId(r)]: "true" } }, file);
		expect(items).toEqual([{ id: windowJudgmentId(r), packet: "commit-unprompted", session_id: S, p: 0.4, labels: { A: "true" }, cohort: "jev-1.14.0|claude-code|evidence-v1|e20-v3" }]);
	});
});
