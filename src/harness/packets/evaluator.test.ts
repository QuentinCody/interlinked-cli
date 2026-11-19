import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevFetch } from "../jev/client.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { decidePacketAsk, hasCosignPackets } from "./cosign-pairing.js";
import { collectPacketAsk, collectPacketWarnings, evidenceHash, hasLivePackets, type PacketJudgmentRow, PACKET_LEDGER, resetPacketEvaluatorState, runPacketEvaluation } from "./evaluator.js";
import type { HarnessDecision } from "../types.js";
import { recordVisibleFallback } from "./fallback-ledger.js";
import { sessionToken } from "./session-token.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { packetHash, withHash } from "./schema.js";
import type { Packet } from "./types.js";

let tmp: string;
const CLAUDE_MD = "# rules\nNever full-read the big logs.\n";

function writePackets(packets: Packet[]): void {
	const file = sampleFile(packets.map(withHash), { sources: { "CLAUDE.md": createHash("sha256").update(CLAUDE_MD).digest("hex") } });
	writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), JSON.stringify(file));
}
function rules(overrides: Partial<GuardRulesConfig> = {}): GuardRulesConfig {
	return {
		jev: { enabled: true },
		packets: { enabled: true, evidence_consent: { kinds: ["command", "hunks"], paths: ["src/**"] } },
		...overrides,
	} as unknown as GuardRulesConfig;
}
function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude-code",
		tool_name: "Bash",
		tool_input: { command: "cat .interlinked/collection.jsonl" },
		tool_use_id: `tu-${Math.random()}`,
		seq: 7,
		timestamp: "2026-11-05T00:00:00Z",
		cwd: tmp,
		...overrides,
	} as HarnessEvent;
}
function jevFetch(answers: Record<string, number>, model = "jev-1.14.0"): JevFetch & ReturnType<typeof vi.fn> {
	return vi.fn(async () =>
		new Response(
			JSON.stringify({ model, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: "noul", noul: v }])), usage: { input_tokens: 100, output_tokens: 0 } }),
			{ status: 200, headers: { "content-type": "application/json" } },
		),
	) as JevFetch & ReturnType<typeof vi.fn>;
}
function ledger(): PacketJudgmentRow[] {
	const p = join(tmp, ".interlinked", PACKET_LEDGER);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PacketJudgmentRow);
}
const deps = (fetchImpl: JevFetch) => ({ fetchImpl, resolveKey: () => "k" });
/** What the hook does after encoding: the model-visible context carried these lines, so the session received them. */
const receivedBy = (sessionId: string, lines: string[]) =>
	recordVisibleFallback(join(tmp, ".interlinked"), { session_id: sessionId, phase: "post-tool" }, lines, JSON.stringify({ additionalContext: lines.join("\n") }), "daemon", { modelVisible: true });

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-eval-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), CLAUDE_MD);
	resetPacketEvaluatorState();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("runPacketEvaluation — positive (a judgment is recorded)", () => {
	it("P1: a matching, consented command packet gets one shadow row with p and the binding stamps", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const rows = await runPacketEvaluation(event(), rules(), deps(fetchImpl));
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual(expect.objectContaining({ packet: "bounded-log-read", p: 0.9, gate: null, status: "shadow", status_effective: "shadow", shown: false, runner: "claude-code", model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", input_tokens: 100 }));
		expect(ledger()).toHaveLength(1);
	});

	it("P2: two matching packets share ONE call and get one row each", async () => {
		writePackets([samplePacket(), samplePacket({ id: "two" })]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.2, two: 0.8 });
		const rows = await runPacketEvaluation(event(), rules(), deps(fetchImpl));
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(rows.map((r) => [r.packet, r.p])).toEqual([["bounded-log-read", 0.2], ["two", 0.8]]);
	});

	it("P3: a warn packet whose binding names another model is judged at shadow for this evaluator", async () => {
		const w = warnPacket();
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-0.9.0" } } }]);
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.95 })));
		expect(rows[0]).toEqual(expect.objectContaining({ status: "warn", status_effective: "shadow", shown: false }));
	});

	it("P4: a call failure is a row with the gate ask_failed and the error class", async () => {
		writePackets([samplePacket()]);
		const failing: JevFetch = async () => new Response("nope", { status: 500 });
		const rows = await runPacketEvaluation(event(), rules(), deps(failing));
		expect(rows[0]).toEqual(expect.objectContaining({ gate: "ask_failed", p: null }));
		expect(rows[0]?.error).toBeTruthy();
	});
});

describe("runPacketEvaluation — settled without a model", () => {
	it("P5: a compliant-settled event is a row with settled=compliant, p null, and NO call", async () => {
		writePackets([samplePacket({ settle: { compliant_regex: "\\btail -n\\b", violated_regex: null } })]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const rows = await runPacketEvaluation(event({ tool_input: { command: "tail -n 3 .interlinked/collection.jsonl" } }), rules(), deps(fetchImpl));
		expect(rows).toEqual([expect.objectContaining({ packet: "bounded-log-read", settled: "compliant", p: null, gate: null, source: "live" })]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("P6: a violated-settled event is a row with settled=violated and NO call; the residue still goes to the model in the same event", async () => {
		writePackets([
			samplePacket({ settle: { compliant_regex: null, violated_regex: "\\bcat\\b" } }),
			samplePacket({ id: "residue" }),
		]);
		const fetchImpl = jevFetch({ residue: 0.3 });
		const rows = await runPacketEvaluation(event(), rules(), deps(fetchImpl));
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(rows.map((r) => [r.packet, r.settled, r.p])).toEqual([["bounded-log-read", "violated", null], ["residue", null, 0.3]]);
	});
	it("P7: a replayed judgment carries source=replay", async () => {
		writePackets([samplePacket()]);
		const rows = await runPacketEvaluation(event(), rules(), { ...deps(jevFetch({ "bounded-log-read": 0.5 })), source: "replay" });
		expect(rows[0]?.source).toBe("replay");
	});
});

describe("stage 2 delivery — positive (a warning is produced)", () => {
	/** A warn packet bound to THIS evaluator (claude-code, jev-1.14.0, current hash). */
	const live = () => {
		const w = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.7 } });
		return { ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } };
	};
	it("P8: p ≥ tau on a live packet is shown, with the rule quote, the evidence and the adjudicate command", async () => {
		writePackets([live()]);
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.91 })));
		expect(rows[0]).toEqual(expect.objectContaining({ eligible: true, shown: false, status_effective: "warn" }));
		expect(rows[0]?.warning).toMatch(/^\[interlinked:packet\] \[heuristic\] bounded-log-read p=0\.91 ≥ τ 0\.7 — "Never full-read/);
		expect(rows[0]?.warning).toContain("↳ evidence: cat .interlinked/collection.jsonl");
		expect(rows[0]?.warning).toContain(`interlinked packets adjudicate bounded-log-read:${sessionToken("s1")}:7:${packetHash(live()).slice(0, 8)}:${evidenceHash({ command: "cat .interlinked/collection.jsonl" }).slice(0, 8)} true|false`);
	});
	it("P9: a settled-violated event on a live packet is shown without a model call", async () => {
		const w = warnPacket({ settle: { compliant_regex: null, violated_regex: "\\bcat\\b" }, calibration: { ...warnPacket().calibration, tau: 0.7 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		const fetchImpl = jevFetch({});
		const rows = await runPacketEvaluation(event(), rules(), deps(fetchImpl));
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(rows[0]).toEqual(expect.objectContaining({ eligible: true, shown: false, settled: "violated" }));
		expect(rows[0]?.warning).toContain("matched the rule's violated pattern");
	});
	it("P10: collectPacketWarnings awaits when a live packet exists, returns the lines, and records shown=true", async () => {
		writePackets([live()]);
		expect(hasLivePackets(tmp)).toBe(true);
		const lines = await collectPacketWarnings(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.95 })));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[interlinked:packet]");
		expect(ledger().map((r) => [r.eligible, r.shown])).toEqual([[true, true]]);
	});
	it("P10b (§9): a Jev outage re-injects the released text of every released packet, once per session", async () => {
		const text = "Never full-read `collection.jsonl` …";
		const releasedLive = { ...live(), release: { text, released_at: "2026-11-05T20:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") } };
		writePackets([releasedLive]);
		const failing: JevFetch = async () => new Response("nope", { status: 500 });
		const first = await collectPacketWarnings(event(), rules(), deps(failing));
		expect(first).toHaveLength(1);
		expect(first[0]).toMatch(/^\[interlinked:packet bounded-log-read\] not live here \(Jev unreachable\); instruction released from CLAUDE\.md, verbatim:\n/);
		expect(first[0]).toContain(text);
		// Not yet received (no hook recorded it): proposed again — an invisible event never uses up the delivery.
		expect(await collectPacketWarnings(event(), rules(), deps(failing))).toHaveLength(1);
		// The hook recorded that the model received it: never repeated in this session, still offered to another.
		receivedBy("s1", first);
		expect(await collectPacketWarnings(event(), rules(), deps(failing))).toEqual([]);
		expect(await collectPacketWarnings(event({ session_id: "s2" }), rules(), deps(failing))).toHaveLength(1);
	});
	it("P10c (R40): under an exhausted spend cap EVERY session gets the released text once, not only the one that saw the cap row", async () => {
		const text = "Never full-read `collection.jsonl` …";
		writePackets([{ ...live(), release: { text, released_at: "2026-11-05T20:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") } }]);
		const capped = rules({ packets: { enabled: true, max_spend_usd: 0, evidence_consent: { kinds: ["command"], paths: [] } } });
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const s1 = await collectPacketWarnings(event({ session_id: "s1" }), capped, deps(fetchImpl));
		receivedBy("s1", s1);
		const s1Again = await collectPacketWarnings(event({ session_id: "s1" }), capped, deps(fetchImpl));
		const s2 = await collectPacketWarnings(event({ session_id: "s2" }), capped, deps(fetchImpl));
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(s1.map((l) => l.split("\n")[0])).toEqual(["[interlinked:packet bounded-log-read] not live here (spend cap reached this daemon run); instruction released from CLAUDE.md, verbatim:"]);
		expect(s1Again).toEqual([]);
		expect(s2).toHaveLength(1);
	});
	it("P10d (R39): a judgment forced to shadow by a model mismatch re-injects the released text", async () => {
		const text = "Never full-read `collection.jsonl` …";
		writePackets([{ ...live(), release: { text, released_at: "2026-11-05T20:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") } }]);
		const lines = await collectPacketWarnings(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.99 }, "jev-2.0.0")));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[interlinked:packet bounded-log-read\] not live here \(judged at shadow: calibration binding does not match this evaluator \(model jev-2\.0\.0\)\)/);
		expect(lines[0]).toContain(text);
	});
	it("N19b: an outage with nothing released prints nothing extra", async () => {
		writePackets([live()]);
		const failing: JevFetch = async () => new Response("nope", { status: 500 });
		expect(await collectPacketWarnings(event(), rules(), deps(failing))).toEqual([]);
	});
	it("N19: a judgment slower than the delivery budget is recorded eligible but NOT shown, and nothing is returned", async () => {
		writePackets([live()]);
		const slow: JevFetch = (input, init) => new Promise((resolve) => setTimeout(() => resolve(jevFetch({ "bounded-log-read": 0.95 })(input, init)), 60));
		const lines = await collectPacketWarnings(event(), rules(), deps(slow), 10);
		expect(lines).toEqual([]);
		await vi.waitFor(() => expect(ledger().map((r) => [r.eligible, r.shown])).toEqual([[true, false]]), { timeout: 2_000 });
	});
	it("P12: ONE packet matching two files of one patch is judged once per file, each against its own file", async () => {
		writePackets([samplePacket({ id: "pa", applies: { ...samplePacket().applies, tools: ["apply_patch"], command_regex: null, path_regex: "\\.ts$" }, evidence: "hunks" })]);
		const seen: string[] = [];
		const fetchImpl: JevFetch = async (_input, init) => {
			seen.push(String(init.body));
			return jevFetch({ pa: 0.3 })(_input, init);
		};
		const patch = "*** Begin Patch\n*** Add File: src/a.ts\n+A-ONLY\n*** Add File: src/b.ts\n+B-ONLY\n*** End Patch\n";
		const rows = await runPacketEvaluation(event({ agent_source: "codex", tool_name: "apply_patch", tool_input: { patch } }), rules(), deps(fetchImpl));
		expect(seen).toHaveLength(2);
		expect(rows.map((r) => r.packet)).toEqual(["pa", "pa"]);
		expect(new Set(rows.map((r) => r.evidence_hash)).size).toBe(2);
	});
	it("P11: two packets on different files of one apply_patch are each asked against THEIR file", async () => {
		const a = samplePacket({ id: "pa", applies: { ...samplePacket().applies, tools: ["Edit"], command_regex: null, path_regex: "a\\.ts$" }, evidence: "hunks" });
		const b = samplePacket({ id: "pb", applies: { ...samplePacket().applies, tools: ["Edit"], command_regex: null, path_regex: "b\\.ts$" }, evidence: "hunks" });
		writePackets([a, b]);
		const seen: string[] = [];
		const fetchImpl: JevFetch = async (_input, init) => {
			seen.push(String(init.body));
			return jevFetch({ pa: 0.1, pb: 0.2 })(_input, init);
		};
		// Two Edit views in one event: MultiEdit cannot span files, so simulate with two sequential events sharing nothing — the grouping is per DISTINCT evidence.
		await runPacketEvaluation(event({ tool_name: "Edit", tool_input: { file_path: join(tmp, "src", "a.ts"), old_string: "x", new_string: "A-ONLY" } }), rules(), deps(fetchImpl));
		await runPacketEvaluation(event({ tool_name: "Edit", tool_input: { file_path: join(tmp, "src", "b.ts"), old_string: "x", new_string: "B-ONLY" } }), rules(), deps(fetchImpl));
		expect(seen).toHaveLength(2);
		expect(seen[0]).toContain("A-ONLY");
		expect(seen[0]).not.toContain("B-ONLY");
		expect(seen[1]).toContain("B-ONLY");
	});
});

describe("stage 2 delivery — negative (nothing is shown)", () => {
	it("N14: p below tau on a live packet is logged, not shown", async () => {
		const w = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.7 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.5 })));
		expect(rows[0]).toEqual(expect.objectContaining({ eligible: false, shown: false, warning: null, p: 0.5 }));
	});
	it("N15: a warn packet bound to another model is judged at shadow and never shown, whatever p", async () => {
		writePackets([warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.5 } })]); // fixture binding names jev-1.14.0 but runner claude-code with a different hash? no: hash matches; model matches; runner matches → make the model differ
		const w = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.5 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-0.9.0" } } }]);
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.99 })));
		expect(rows[0]).toEqual(expect.objectContaining({ eligible: false, shown: false, status_effective: "shadow" }));
	});
	it("N16: a shadow packet is never shown", async () => {
		writePackets([samplePacket()]);
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.99 })));
		expect(rows[0]?.shown).toBe(false);
	});
	it("N17: collectPacketWarnings with only shadow packets returns nothing and does not await", async () => {
		writePackets([samplePacket()]);
		expect(hasLivePackets(tmp)).toBe(false);
		expect(await collectPacketWarnings(event(), rules(), deps(jevFetch({ "bounded-log-read": 0.99 })))).toEqual([]);
	});
	it("N18: a failed call on a live packet shows nothing (fail-open, no decision change)", async () => {
		const w = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.5 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		const failing: JevFetch = async () => new Response("nope", { status: 500 });
		expect(await collectPacketWarnings(event(), rules(), deps(failing))).toEqual([]);
	});
});

describe("stage 4 — cosign at PreToolUse (allow → ask only)", () => {
	const cosign = () => {
		const w = warnPacket({ cosignals: ["builtin-large-log-read"], calibration: { ...warnPacket().calibration, status: "cosign", tau: 0.7 } });
		return { ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } };
	};
	// The merged rule set holds the paired rule (§5): without it a cosign packet is unpaired and never asks.
	const paired = () => rules({ rules: [{ id: "builtin-large-log-read" }] } as unknown as Partial<GuardRulesConfig>);
	const pairs = new Map([["x", "builtin-large-log-read"]]);
	const allow: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
	const pre = (overrides: Partial<HarnessEvent> = {}) => event({ hook_event: "PreToolUse", ...overrides });
	it("P13: an eligible cosign judgment raises allow to ask with the rule, the evidence and the adjudicate command; the row is shown", async () => {
		writePackets([cosign()]);
		expect(hasCosignPackets(tmp)).toBe(true);
		const d = await collectPacketAsk(pre(), paired(), allow, deps(jevFetch({ "bounded-log-read": 0.9 })));
		expect(d.decision).toBe("ask");
		expect(d.rule_id).toBe("packet:bounded-log-read");
		expect(d.reason).toContain("Never full-read");
		expect(d.reason).toContain("cosign on rule builtin-large-log-read");
		expect(d.warnings).toEqual(["earlier"]);
		expect(ledger().map((r) => [r.status_effective, r.eligible, r.shown, r.cosign_rule])).toEqual([["cosign", true, true, "builtin-large-log-read"]]);
	});
	it("N28: an unpaired cosign packet (no cosignal names an active rule) never asks, and the evaluator is not called", async () => {
		writePackets([{ ...cosign(), cosignals: ["builtin-not-loaded"] }]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.99 });
		expect(await collectPacketAsk(pre(), paired(), allow, deps(fetchImpl))).toEqual(allow);
		expect(await collectPacketAsk(pre(), rules(), allow, deps(fetchImpl))).toEqual(allow);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N29: beside a paired packet, an unpaired one's eligible judgment is withheld: logged with cosign_rule null, never shown", async () => {
		const s2 = warnPacket({ id: "second", cosignals: [], calibration: { ...warnPacket().calibration, status: "cosign", tau: 0.7 } });
		writePackets([{ ...s2, calibration: { ...s2.calibration, bound_to: { ...s2.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }, cosign()]);
		const d = await collectPacketAsk(pre(), paired(), allow, deps(jevFetch({ "bounded-log-read": 0.1, second: 0.9 })));
		expect(d).toEqual(allow);
		expect(ledger().map((r) => [r.packet, r.eligible, r.shown, r.cosign_rule]).sort()).toEqual([["bounded-log-read", false, false, "builtin-large-log-read"], ["second", true, false, null]]);
	});
	it("N20: below tau, allow stays allow and the row is logged unshown", async () => {
		writePackets([cosign()]);
		const d = await collectPacketAsk(pre(), paired(), allow, deps(jevFetch({ "bounded-log-read": 0.2 })));
		expect(d).toEqual(allow);
		expect(ledger().map((r) => [r.eligible, r.shown])).toEqual([[false, false]]);
	});
	it("N21: a warn packet never asks, even at p 0.99 — only cosign tightens", async () => {
		const w = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.5 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		expect(hasCosignPackets(tmp)).toBe(false);
		expect(await collectPacketAsk(pre(), paired(), allow, deps(jevFetch({ "bounded-log-read": 0.99 })))).toEqual(allow);
	});
	it("N22: the decision table — block and ask are never touched by any row; allow is untouched by a failed row", () => {
		const eligible = { eligible: true, status_effective: "cosign", warning: "w", packet: "x", p: 0.9, settled: null } as unknown as PacketJudgmentRow;
		const block: HarnessDecision = { decision: "block", reason: "BLOCKED" };
		const ask: HarnessDecision = { decision: "ask", reason: "confirm" };
		expect(decidePacketAsk(block, [eligible], pairs)).toEqual(block);
		expect(decidePacketAsk(ask, [eligible], pairs)).toEqual(ask);
		expect(decidePacketAsk(allow, [{ ...eligible, eligible: false, gate: "ask_failed" }], pairs)).toEqual(allow);
		expect(decidePacketAsk(allow, [], pairs).decision).toBe("allow");
		expect(decidePacketAsk(allow, [eligible], pairs).decision).toBe("ask");
		expect(decidePacketAsk(allow, [eligible], new Map([["x", null]]))).toEqual(allow);
		expect(decidePacketAsk(allow, [eligible], new Map())).toEqual(allow);
	});
	it("N23: a slow judgment leaves allow untouched; its row lands eligible but not shown", async () => {
		writePackets([cosign()]);
		const slow: JevFetch = (input, init) => new Promise((resolve) => setTimeout(() => resolve(jevFetch({ "bounded-log-read": 0.95 })(input, init)), 60));
		const d = await collectPacketAsk(pre(), paired(), allow, deps(slow), 10);
		expect(d).toEqual(allow);
		await vi.waitFor(() => expect(ledger().map((r) => [r.eligible, r.shown])).toEqual([[true, false]]), { timeout: 2_000 });
	});
	it("N25: on a runner whose PreToolUse can only deny (Codex), cosign never asks — the evaluator is not even called", async () => {
		writePackets([{ ...cosign(), calibration: { ...cosign().calibration, bound_to: { ...cosign().calibration.bound_to!, runner: "codex" } } }]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.99 });
		expect(await collectPacketAsk(pre({ agent_source: "codex" }), paired(), allow, deps(fetchImpl))).toEqual(allow);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N26: the cosign pass at PreToolUse does not claim the call for the PostToolUse pass (shadow and warn still run)", async () => {
		writePackets([cosign(), samplePacket({ id: "other", applies: { ...samplePacket().applies, command_regex: "collection" } })]);
		const e = event({ hook_event: "PreToolUse" });
		await collectPacketAsk(e, paired(), allow, deps(jevFetch({ "bounded-log-read": 0.1 })));
		const post = await runPacketEvaluation({ ...e, hook_event: "PostToolUse" }, rules(), deps(jevFetch({ "bounded-log-read": 0.1, other: 0.5 })));
		expect(post.map((r) => r.packet).sort()).toEqual(["bounded-log-read", "other"]);
	});
	it("N27: with two eligible cosign packets only the delivered one is marked shown", async () => {
		const s2 = warnPacket({ id: "second", cosignals: ["builtin-large-log-read"], calibration: { ...warnPacket().calibration, status: "cosign", tau: 0.7 } });
		writePackets([cosign(), { ...s2, calibration: { ...s2.calibration, bound_to: { ...s2.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		const d = await collectPacketAsk(pre(), paired(), allow, deps(jevFetch({ "bounded-log-read": 0.9, second: 0.9 })));
		expect(d.decision).toBe("ask");
		expect(ledger().map((r) => [r.packet, r.eligible, r.shown]).sort()).toEqual([["bounded-log-read", true, true], ["second", true, false]]);
	});
	it("N24: a failed call leaves allow untouched (fail-open)", async () => {
		writePackets([cosign()]);
		const failing: JevFetch = async () => new Response("nope", { status: 500 });
		expect(await collectPacketAsk(pre(), paired(), allow, deps(failing))).toEqual(allow);
	});
});

describe("project root (review-100 P1: evaluator.ts read the packet file under the raw event.cwd)", () => {
	it("P-root: a call from a subdirectory is judged against the project's packet file, and its row lands in the project ledger", async () => {
		writePackets([samplePacket()]);
		const sub = join(tmp, "src", "deep");
		mkdirSync(sub, { recursive: true });
		const rows = await runPacketEvaluation(event({ cwd: sub }), rules(), deps(jevFetch({ "bounded-log-read": 0.9 })));
		expect(rows.map((r) => [r.packet, r.p])).toEqual([["bounded-log-read", 0.9]]);
		expect(ledger().map((r) => r.packet)).toEqual(["bounded-log-read"]);
		expect(existsSync(join(sub, ".interlinked"))).toBe(false);
	});
	it("P-root-ask: the cosign pass from a subdirectory finds the project's cosign packet", async () => {
		const w = warnPacket({ cosignals: ["builtin-large-log-read"], calibration: { ...warnPacket().calibration, status: "cosign", tau: 0.7 } });
		writePackets([{ ...w, calibration: { ...w.calibration, bound_to: { ...w.calibration.bound_to!, model: "jev-1.14.0", runner: "claude-code" } } }]);
		const sub = join(tmp, "src");
		mkdirSync(sub, { recursive: true });
		const paired = rules({ rules: [{ id: "builtin-large-log-read" }] } as unknown as Partial<GuardRulesConfig>);
		const d = await collectPacketAsk(event({ cwd: sub, hook_event: "PreToolUse" }), paired, { decision: "allow" }, deps(jevFetch({ "bounded-log-read": 0.9 })));
		expect(d.decision).toBe("ask");
	});
});

describe("runPacketEvaluation — negative (no call is made)", () => {
	it("N1: a dry run writes nothing and calls nothing", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		expect(await runPacketEvaluation(event({ dry_run: true }), rules(), deps(fetchImpl))).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(ledger()).toEqual([]);
	});
	it("N2: packets disabled, or jev disabled, is silent", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		expect(await runPacketEvaluation(event(), rules({ packets: { enabled: false } }), deps(fetchImpl))).toEqual([]);
		expect(await runPacketEvaluation(event(), rules({ jev: { enabled: false } }), deps(fetchImpl))).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N3: no packet file is zero cost", async () => {
		const fetchImpl = jevFetch({});
		expect(await runPacketEvaluation(event(), rules(), deps(fetchImpl))).toEqual([]);
		expect(ledger()).toEqual([]);
	});
	it("N4: no key is one no_key row per process, then silence", async () => {
		writePackets([samplePacket()]);
		const noKey = { fetchImpl: jevFetch({}), resolveKey: () => undefined };
		const first = await runPacketEvaluation(event(), rules(), noKey);
		expect(first.map((r) => r.gate)).toEqual(["no_key"]);
		expect(await runPacketEvaluation(event(), rules(), noKey)).toEqual([]);
	});
	it("N5: an unparseable packet file is one packets_invalid row per process", async () => {
		writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "{broken");
		const rows = await runPacketEvaluation(event(), rules(), deps(jevFetch({})));
		expect(rows.map((r) => r.gate)).toEqual(["packets_invalid"]);
		expect(await runPacketEvaluation(event(), rules(), deps(jevFetch({})))).toEqual([]);
	});
	it("N6: a source file edited since compile disables the set with one hash_mismatch row", async () => {
		writePackets([samplePacket()]);
		writeFileSync(join(tmp, "CLAUDE.md"), `${CLAUDE_MD}\nmore\n`);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const rows = await runPacketEvaluation(event(), rules(), deps(fetchImpl));
		expect(rows.map((r) => r.gate)).toEqual(["hash_mismatch"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N7: no trigger match is silent", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({});
		expect(await runPacketEvaluation(event({ tool_input: { command: "ls" } }), rules(), deps(fetchImpl))).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N8: no consent for the kind is a no_consent row and no call", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({});
		const rows = await runPacketEvaluation(event(), rules({ packets: { enabled: true, evidence_consent: { kinds: ["hunks"], paths: ["**"] } } }), deps(fetchImpl));
		expect(rows.map((r) => r.gate)).toEqual(["no_consent"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N9: a path outside the consented globs is a privacy row", async () => {
		writePackets([samplePacket({ id: "edits", applies: { ...samplePacket().applies, tools: ["Edit"], command_regex: null }, evidence: "hunks" })]);
		const fetchImpl = jevFetch({});
		const rows = await runPacketEvaluation(event({ tool_name: "Edit", tool_input: { file_path: join(tmp, "docs", "x.md"), old_string: "a", new_string: "b" } }), rules(), deps(fetchImpl));
		expect(rows.map((r) => r.gate)).toEqual(["privacy"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N10: a packet the runner does not deliver is an unsupported row", async () => {
		writePackets([samplePacket({ id: "edits", applies: { ...samplePacket().applies, tools: ["Edit"], command_regex: null }, evidence: "hunks" })]);
		const fetchImpl = jevFetch({});
		const rows = await runPacketEvaluation(event({ agent_source: "codex", tool_name: "Edit", tool_input: { file_path: join(tmp, "src", "a.ts"), old_string: "a", new_string: "b" } }), rules(), deps(fetchImpl));
		expect(rows.map((r) => r.gate)).toEqual(["unsupported"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N11: a repeated delivery of the same tool_use_id is judged once", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const e = event();
		await runPacketEvaluation(e, rules(), deps(fetchImpl));
		expect(await runPacketEvaluation(e, rules(), deps(fetchImpl))).toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
	it("N12: the spend cap stops calls with one spend_cap row", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({ "bounded-log-read": 0.9 });
		const capped = rules({ packets: { enabled: true, max_spend_usd: 0, evidence_consent: { kinds: ["command"], paths: [] } } });
		expect((await runPacketEvaluation(event(), capped, deps(fetchImpl))).map((r) => r.gate)).toEqual(["spend_cap"]);
		expect(await runPacketEvaluation(event(), capped, deps(fetchImpl))).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("N13: a PreToolUse event is ignored in stage 1 (post only)", async () => {
		writePackets([samplePacket()]);
		const fetchImpl = jevFetch({});
		expect(await runPacketEvaluation(event({ hook_event: "PreToolUse" }), rules(), deps(fetchImpl))).toEqual([]);
	});
});
