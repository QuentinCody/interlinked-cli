import { describe, expect, it } from "vitest";
import type { PacketJudgmentRow } from "./evaluator.js";
import { sampleFile, samplePacket } from "./fixtures.js";
import { buildLabelSheet, judgmentId, labeledJudgments, observationAliases } from "./label-sheet.js";
import type { ReplayRow } from "./replay.js";
import { withHash } from "./schema.js";

function judged(overrides: Partial<PacketJudgmentRow> = {}): PacketJudgmentRow {
	return {
		ts: "2026-11-05T00:00:00Z",
		session_id: "session-aaaa",
		tool_use_id: "tu1",
		seq: 5,
		runner: "claude-code",
		tool: "Bash",
		packet: "bounded-log-read",
		packet_hash: CURRENT,
		evidence_hash: "e".repeat(64),
		status: "shadow",
		status_effective: "shadow",
		p: 0.9,
		settled: null,
		source: "live",
		eligible: false,
		shown: false,
		warning: null,
		latency_ms: 90,
		input_tokens: 100,
		usd: 0.000004,
		model: "jev-1.14.0",
		renderer: "evidence-v1",
		redaction: "e20-v3",
		gate: null,
		error: null,
		...overrides,
	};
}
const replay = (session_id: string, seq: number, tool_use_id: string | null, command: string): ReplayRow => ({ session_id, seq, tool_use_id, provider: null, view: { tool: "Bash", phase: "pre", path: null, command, hunks: [] } });
const file = sampleFile([withHash(samplePacket())]);
const CURRENT = file.packets[0]!.packet_hash;

describe("buildLabelSheet — positive", () => {
	it("P1: a judged row joins its collection row by tool_use_id and re-renders the evidence Jev saw", () => {
		const { sheet, unjoined } = buildLabelSheet([judged()], file, [replay("session-aaaa", 5, "tu1", "cat .interlinked/collection.jsonl")]);
		expect(unjoined).toBe(0);
		expect(sheet).toHaveLength(1);
		expect(sheet[0]).toEqual(
			expect.objectContaining({
				id: judgmentId(judged()),
				packet: "bounded-log-read",
				instruction: samplePacket().source.quote,
				evidence: { command: "cat .interlinked/collection.jsonl" },
			}),
		);
		expect(sheet[0]?.question.type).toBe("noul");
	});
	it("P2: without a tool_use_id the join falls back to (session, seq)", () => {
		const { sheet } = buildLabelSheet([judged({ tool_use_id: null })], file, [replay("session-aaaa", 5, null, "cat x.jsonl")]);
		expect(sheet[0]?.evidence).toEqual({ command: "cat x.jsonl" });
	});
	it("P2 n140: a live row with no tool_use_id carries its POST seq; the post→pre pairing joins it to its own pre row", () => {
		const rows = [replay("session-aaaa", 5, null, "cat a.jsonl"), replay("session-aaaa", 7, null, "cat b.jsonl")];
		const live = judged({ tool_use_id: null, seq: 6 });
		expect(buildLabelSheet([live], file, rows).unjoined).toBe(1);
		const { sheet, unjoined } = buildLabelSheet([live], file, rows, new Map([["session-aaaa#6", "session-aaaa#5"]]));
		expect(unjoined).toBe(0);
		expect(sheet[0]?.evidence).toEqual({ command: "cat a.jsonl" });
		expect(sheet[0]?.seq).toBe(6);
	});
	it("P3: the sheet never carries p, gate, model or any score field", () => {
		const { sheet } = buildLabelSheet([judged()], file, [replay("session-aaaa", 5, "tu1", "ls")]);
		expect(Object.keys(sheet[0] ?? {}).sort()).toEqual(["evidence", "id", "instruction", "packet", "question", "runner", "seq", "session_id", "tool_use_id"]);
	});
});

describe("buildLabelSheet — negative", () => {
	it("P5: two rows of one observation (same id) count once, the newest winning", () => {
		const older = judged({ ts: "2026-11-05T00:00:00Z", p: 0.2 });
		const newer = judged({ ts: "2026-11-05T00:00:05Z", p: 0.9 });
		const items = labeledJudgments([older, newer], { A: { [judgmentId(newer)]: "true" }, B: { [judgmentId(newer)]: "true" } });
		expect(items).toHaveLength(1);
		expect(items[0]?.p).toBe(0.9);
		expect(buildLabelSheet([older, newer], file, [replay("session-aaaa", 5, "tu1", "ls")]).sheet).toHaveLength(1);
	});
	it("N1: gate rows (no judgment) are skipped", () => {
		const { sheet } = buildLabelSheet([judged({ gate: "no_consent", p: null })], file, [replay("session-aaaa", 5, "tu1", "ls")]);
		expect(sheet).toEqual([]);
	});
	it("N2: a row whose collection twin is missing is counted unjoined", () => {
		const { sheet, unjoined } = buildLabelSheet([judged()], file, []);
		expect(sheet).toEqual([]);
		expect(unjoined).toBe(1);
	});
	it("N4: a judgment made under an OLDER wording (other packet_hash) is never exported under the new wording", () => {
		const { sheet, unjoined } = buildLabelSheet([judged({ packet_hash: "0".repeat(64) })], file, [replay("session-aaaa", 5, "tu1", "ls")]);
		expect(sheet).toEqual([]);
		expect(unjoined).toBe(0);
	});
	it("N3: a row for a packet no longer in the file is skipped", () => {
		const { sheet } = buildLabelSheet([judged({ packet: "gone" })], file, [replay("session-aaaa", 5, "tu1", "ls")]);
		expect(sheet).toEqual([]);
	});
});

describe("labeledJudgments", () => {
	it("P4: joins judged rows to every labeler's label by id; rows nobody labeled are dropped", () => {
		const a = judged();
		const b = judged({ tool_use_id: "tu2", seq: 6, p: 0.2 });
		const items = labeledJudgments([a, b, judged({ gate: "secret", p: null })], { A: { [judgmentId(a)]: "true" }, B: { [judgmentId(a)]: "true", [judgmentId(b)]: "false" } });
		const cohort = "jev-1.14.0|claude-code|evidence-v1|e20-v3";
		expect(items).toEqual([
			{ id: judgmentId(a), packet: "bounded-log-read", session_id: "session-aaaa", p: 0.9, labels: { A: "true", B: "true" }, cohort },
			{ id: judgmentId(b), packet: "bounded-log-read", session_id: "session-aaaa", p: 0.2, labels: { B: "false" }, cohort },
		]);
	});
	it("P5 (break R5 #4): two sessions sharing an 8-char prefix, same seq and evidence, are two observations with two ids", () => {
		const a = judged({ session_id: "0190aaaa-1111-7000-8000-000000000001", tool_use_id: null, seq: 7, p: 0.9 });
		const b = judged({ session_id: "0190aaaa-2222-7000-8000-000000000002", tool_use_id: null, seq: 7, p: 0.2 });
		expect(judgmentId(a)).not.toBe(judgmentId(b));
		const items = labeledJudgments([a, b], { A: { [judgmentId(a)]: "true", [judgmentId(b)]: "false" } });
		expect(items.map((i) => [i.p, i.labels.A])).toEqual([
			[0.9, "true"],
			[0.2, "false"],
		]);
	});
	it("P6: a label saved under the OLD id form still joins when that id names one observation, and joins nothing when it names two", () => {
		const a = judged();
		const legacy = `bounded-log-read:${a.session_id.slice(0, 8)}:${a.seq}:${(a.packet_hash ?? "").slice(0, 8)}:${(a.evidence_hash ?? "").slice(0, 8)}`;
		expect(labeledJudgments([a], { A: { [legacy]: "true" } }).map((i) => i.labels.A)).toEqual(["true"]);
		const twin = judged({ session_id: "session-aaaa-other", tool_use_id: "tu9" });
		expect(labeledJudgments([a, twin], { A: { [legacy]: "true" } })).toEqual([]);
	});
	it("P7 (break R5 #5): a newer UNJUDGED row of the same observation never takes the labels away from the judged row", () => {
		const pre = judged({ ts: "2026-11-05T00:00:01Z", p: 0.9 });
		const post = judged({ ts: "2026-11-05T00:00:02Z", seq: 6, p: null, gate: "missing_answer" }); // same call (tool_use_id), next seq
		const items = labeledJudgments([pre, post], { A: { [judgmentId(pre)]: "true" } });
		expect(items.map((i) => i.id)).toEqual([judgmentId(pre)]);
		expect(observationAliases([pre, post]).get(judgmentId(post))).toBe(judgmentId(pre));
	});
});
