import { describe, expect, it } from "vitest";
import type { CalibrationResult } from "./calibrate.js";
import type { PacketJudgmentRow } from "./evaluator.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { applyPromotions, bindingFromRows, shownAdjudications, shownItemsOf } from "./promote.js";
import { judgmentId } from "./evaluator.js";
import { parsePacketFile } from "./schema.js";

const NOW = "2026-11-05T19:00:00.000Z";
const file = sampleFile([samplePacket()]);

function result(overrides: Partial<CalibrationResult> = {}): CalibrationResult {
	return {
		packet: "bounded-log-read",
		labeled: 120,
		gold: 118,
		disagreements: 2,
		kappa: 0.95,
		tau: 0.7,
		tune: { n: 58, pos: 20 },
		holdout: { n: 60, pos: 20, auroc: 0.97, precision_at_tau: { tp: 18, flagged: 20 }, recall_at_tau: { tp: 18, pos: 20 }, brier: 0.05, brier_const: 0.22 },
		decision: { promote: true, reasons: [] },
		...overrides,
	};
}
function row(overrides: Partial<PacketJudgmentRow> = {}): PacketJudgmentRow {
	return {
		ts: NOW, session_id: "s", tool_use_id: "t", seq: 1, runner: "claude-code", tool: "Bash", packet: "bounded-log-read", packet_hash: file.packets[0]!.packet_hash, evidence_hash: "e".repeat(64),
		status: "shadow", status_effective: "shadow", p: 0.5, settled: null, source: "live", eligible: false, shown: false, warning: null, latency_ms: 1, input_tokens: 1, usd: 0, model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null,
		...overrides,
	};
}

const ACTIVE: ReadonlySet<string> = new Set(["builtin-large-log-read"]);

describe("bindingFromRows", () => {
	it("P1: one binding when every judged row shares model, runner, renderer, redaction and hash", () => {
		expect(bindingFromRows([row(), row({ seq: 2 })])).toEqual({ ok: true, binding: { packet_hash: file.packets[0]!.packet_hash, renderer: "evidence-v1", redaction: "e20-v3", model: "jev-1.14.0", runner: "claude-code" } });
	});
	it("N1: mixed models refuse a binding (the labels span two evaluators)", () => {
		const r = bindingFromRows([row(), row({ seq: 2, model: "jev-2.0.0" })]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("model");
	});
	it("N2: no judged rows refuse a binding", () => expect(bindingFromRows([row({ gate: "no_key", p: null })]).ok).toBe(false));
});

describe("applyPromotions", () => {
	it("P2: a promoted packet moves to warn with tau, holdout, binding and measured_at, and the file still parses", () => {
		const out = applyPromotions(file, [result()], { "bounded-log-read": [row()] }, NOW);
		expect(out.applied).toEqual(["bounded-log-read"]);
		const p = out.file.packets[0]!;
		expect(p.calibration).toEqual(expect.objectContaining({ status: "warn", tau: 0.7, measured_at: NOW, holdout: { n: 60, pos: 20, auroc: 0.97, precision_at_tau: 0.9, recall_at_tau: 0.9 } }));
		expect(p.calibration.bound_to?.packet_hash).toBe(p.packet_hash);
		expect(parsePacketFile(JSON.stringify(out.file)).ok).toBe(true);
	});
	it("N3: a result that did not promote leaves the packet untouched and says why", () => {
		const out = applyPromotions(file, [result({ decision: { promote: false, reasons: ["holdout has 3 positives, needs 15"] } })], { "bounded-log-read": [row()] }, NOW);
		expect(out.applied).toEqual([]);
		expect(out.skipped[0]).toEqual({ id: "bounded-log-read", reason: "holdout has 3 positives, needs 15" });
		expect(out.file.packets[0]?.calibration.status).toBe("shadow");
	});
	it("N4: a promoted result with no single binding is skipped", () => {
		const out = applyPromotions(file, [result()], { "bounded-log-read": [row(), row({ seq: 2, runner: "codex" })] }, NOW);
		expect(out.applied).toEqual([]);
		expect(out.skipped[0]?.reason).toContain("runner");
	});
	it("P3: a LIVE packet whose recalibration fails is demoted to shadow", () => {
		const liveFile = sampleFile([warnPacket()]);
		const out = applyPromotions(liveFile, [result({ decision: { promote: false, reasons: ["holdout has 4 positives, needs 15"] } })], { "bounded-log-read": [row()] }, NOW);
		expect(out.demoted).toEqual([{ id: "bounded-log-read", reason: "recalibration failed: holdout has 4 positives, needs 15" }]);
		expect(out.file.packets[0]?.calibration).toEqual(expect.objectContaining({ status: "shadow", tau: null, bound_to: null, measured_at: NOW }));
		expect(parsePacketFile(JSON.stringify(out.file)).ok).toBe(true);
	});
	it("P4: a live packet whose adjudicated shown findings fall below 0.6 precision over 30 is demoted", () => {
		const out = applyPromotions(sampleFile([warnPacket()]), [], {}, NOW, { "bounded-log-read": { n: 30, tp: 17 } });
		expect(out.demoted[0]?.reason).toContain("17/30");
		expect(out.file.packets[0]?.calibration.status).toBe("shadow");
	});
	it("N8: a precision failure also REFUSES promotion on the same pass (demoted and applied never both)", () => {
		const out = applyPromotions(sampleFile([warnPacket()]), [result()], { "bounded-log-read": [row()] }, NOW, { "bounded-log-read": { n: 30, tp: 17 } });
		expect(out.demoted.map((d) => d.id)).toEqual(["bounded-log-read"]);
		expect(out.applied).toEqual([]);
		expect(out.skipped[0]?.reason).toContain("promotion refused");
		expect(out.file.packets[0]?.calibration.status).toBe("shadow");
	});
	it("P5: shownAdjudications counts a repeated judgment once and keeps only the newest window", () => {
		// Distinct calls carry distinct tool_use_ids (one id per call); the repeated seq 1 is the SAME call judged twice.
		const shownRow = (seq: number, ts: string) => row({ seq, ts, shown: true, eligible: true, tool_use_id: `t${seq}` });
		const rows = [shownRow(1, "2026-11-05T00:00:01Z"), shownRow(1, "2026-11-05T00:00:02Z"), ...Array.from({ length: 40 }, (_, i) => shownRow(10 + i, `2026-11-05T01:${String(i).padStart(2, "0")}:00Z`))];
		const verdicts: Record<string, "true" | "false"> = {};
		for (const r of rows) verdicts[judgmentId(r)] = (r.seq ?? 0) === 1 || (r.seq ?? 0) < 30 ? "true" : "false"; // newest 20 (seq 30..49) false, older true
		const s = shownAdjudications(shownItemsOf(rows), verdicts, 30);
		expect(s["bounded-log-read"]).toEqual({ n: 30, tp: 10 });
		expect(shownAdjudications(shownItemsOf([shownRow(1, "t1"), shownRow(1, "t2")]), { [judgmentId(shownRow(1, "t1"))]: "false" })["bounded-log-read"]).toEqual({ n: 1, tp: 0 });
	});
	it("P5b (audit C4): a cosign call's PreToolUse and PostToolUse rows (two seqs, one call, one evidence) are ONE shown finding; an adjudication of either id counts once", () => {
		const pre = row({ seq: 10, tool_use_id: "call-1", ts: "2026-11-05T00:00:01Z", shown: true, eligible: true });
		const post = row({ seq: 11, tool_use_id: "call-1", ts: "2026-11-05T00:00:02Z", shown: true, eligible: true });
		const items = shownItemsOf([pre, post]);
		expect(new Set(items.map((i) => i.id)).size).toBe(1);
		expect(shownAdjudications(items, { [judgmentId(post)]: "true" })["bounded-log-read"]).toEqual({ n: 1, tp: 1 });
	});
	it("N7: 29 adjudications, or precision at the floor, do not demote", () => {
		expect(applyPromotions(sampleFile([warnPacket()]), [], {}, NOW, { "bounded-log-read": { n: 29, tp: 10 } }).demoted).toEqual([]);
		expect(applyPromotions(sampleFile([warnPacket()]), [], {}, NOW, { "bounded-log-read": { n: 30, tp: 18 } }).demoted).toEqual([]);
	});
	it("P6: cosign is granted only on request, with holdout recall ≥ 0.7 and ≥ 200 adjudicated shown findings at ≥ 0.8 precision", () => {
		const liveFile = sampleFile([warnPacket({ cosignals: ["builtin-large-log-read"] })]);
		const plenty = { "bounded-log-read": { n: 200, tp: 180 } };
		const granted = applyPromotions(liveFile, [result()], { "bounded-log-read": [row()] }, NOW, {}, { cosign: true, activeRules: ACTIVE, shownHistory: plenty });
		expect(granted.file.packets[0]?.calibration.status).toBe("cosign");
		expect(granted.file.packets[0]?.calibration.holdout.recall_at_tau).toBe(0.9);
		expect(granted.file.packets[0]?.calibration.adjudication).toEqual({ n: 200, tp: 180 });
		const notAsked = applyPromotions(liveFile, [result()], { "bounded-log-read": [row()] }, NOW, {}, { shownHistory: plenty });
		expect(notAsked.file.packets[0]?.calibration.status).toBe("warn");
	});
	it("N8: cosign is refused, and the packet stays warn, when recall or the adjudication body is short", () => {
		const liveFile = sampleFile([warnPacket({ cosignals: ["builtin-large-log-read"] })]);
		const lowRecall = applyPromotions(liveFile, [result({ holdout: { ...result().holdout, recall_at_tau: { tp: 10, pos: 20 } } })], { "bounded-log-read": [row()] }, NOW, {}, { cosign: true, activeRules: ACTIVE, shownHistory: { "bounded-log-read": { n: 200, tp: 180 } } });
		expect(lowRecall.file.packets[0]?.calibration.status).toBe("warn");
		expect(lowRecall.skipped[0]?.reason).toContain("recall");
		const fewAdjudications = applyPromotions(liveFile, [result()], { "bounded-log-read": [row()] }, NOW, {}, { cosign: true, activeRules: ACTIVE, shownHistory: { "bounded-log-read": { n: 199, tp: 190 } } });
		expect(fewAdjudications.file.packets[0]?.calibration.status).toBe("warn");
		expect(fewAdjudications.skipped[0]?.reason).toContain("needs 200");
		// the rolling demotion window (30) is NOT the promotion history: 200/200 all-time must pass even though any 30-window is 30
		const rolling = applyPromotions(liveFile, [result()], { "bounded-log-read": [row()] }, NOW, { "bounded-log-read": { n: 30, tp: 30 } }, { cosign: true, activeRules: ACTIVE, shownHistory: { "bounded-log-read": { n: 200, tp: 200 } } });
		expect(rolling.file.packets[0]?.calibration.status).toBe("cosign");
	});
	it("N9: a window packet is refused cosign (no PreToolUse tightening path) and stays warn", () => {
		const w = warnPacket({ kind: "window", evidence: "window_calls", applies: { ...warnPacket().applies, phase: "stop", tools: [] } });
		const out = applyPromotions(sampleFile([w]), [result()], { "bounded-log-read": [row({ packet_hash: w.packet_hash })] }, NOW, {}, { cosign: true, activeRules: ACTIVE, shownHistory: { "bounded-log-read": { n: 200, tp: 200 } } });
		expect(out.file.packets[0]?.calibration.status).toBe("warn");
		expect(out.skipped[0]?.reason).toContain("window packet");
	});
	it("N10 (C9): an unpaired packet is refused cosign and stays warn — no cosignals, or none among the active rules", () => {
		const plenty = { "bounded-log-read": { n: 200, tp: 180 } };
		for (const [cosignals, active] of [[[], ACTIVE], [["builtin-large-log-read"], new Set<string>()], [["builtin-large-log-read"], undefined]] as const) {
			const out = applyPromotions(sampleFile([warnPacket({ cosignals: [...cosignals] })]), [result()], { "bounded-log-read": [row()] }, NOW, {}, { cosign: true, shownHistory: plenty, ...(active ? { activeRules: active } : {}) });
			expect(out.file.packets[0]?.calibration.status).toBe("warn");
			expect(out.skipped[0]?.reason).toContain("unpaired");
		}
	});
	it("N11 (C9): a cosign packet that lost its pair is re-measured at warn by the next --apply", () => {
		const granted = applyPromotions(sampleFile([warnPacket({ cosignals: ["builtin-large-log-read"] })]), [result()], { "bounded-log-read": [row()] }, NOW, {}, { cosign: true, activeRules: ACTIVE, shownHistory: { "bounded-log-read": { n: 200, tp: 180 } } });
		expect(granted.file.packets[0]?.calibration.status).toBe("cosign");
		const again = applyPromotions(granted.file, [result()], { "bounded-log-read": [row()] }, NOW, {}, { activeRules: new Set(), shownHistory: { "bounded-log-read": { n: 200, tp: 180 } } });
		expect(again.file.packets[0]?.calibration.status).toBe("warn");
		expect(again.skipped[0]?.reason).toContain("unpaired");
	});
	it("N5: a result for an unknown packet is skipped", () => {
		const out = applyPromotions(file, [result({ packet: "ghost" })], {}, NOW);
		expect(out.skipped[0]?.id).toBe("ghost");
	});
	it("N6: a result whose rows judged another packet hash (recompiled since) is skipped", () => {
		const out = applyPromotions(file, [result()], { "bounded-log-read": [row({ packet_hash: "f".repeat(64) })] }, NOW);
		expect(out.applied).toEqual([]);
		expect(out.skipped[0]?.reason).toContain("hash");
	});
});
