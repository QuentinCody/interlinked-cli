// `interlinked packets compile|status` — CLI wrappers over harness/packets.
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleFile, samplePacket, warnPacket } from "../harness/packets/fixtures.js";
import { resetPacketEvaluatorState } from "../harness/packets/evaluator.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import { acquirePacketLock } from "./packets-release-io.js";
import { packetsAdjudicateCommand, parseAdjudications, packetsCalibrateExportCommand, packetsCalibrateScoreCommand, packetsCompileCommand, packetsReplayCommand, packetsReplayWindowsCommand, packetsStatusCommand } from "./packets.js";

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

function draftFile(packets: unknown[] = [bare()]): string {
	const p = join(tmp, "draft.json");
	writeFileSync(p, JSON.stringify({ version: 1, compiler: { model: "m", skill: "enforce@4" }, sources: ["CLAUDE.md"], packets, skipped: [] }));
	return p;
}
function bare(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const p = samplePacket();
	return { id: p.id, kind: p.kind, source: p.source, strength: p.strength, applies: p.applies, evidence: p.evidence, questions: p.questions, ...overrides };
}
function collectionRow(seq: number, command: string): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider_tool: "Bash", session_id: "s", seq, action: { command } });
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-packets-cmd-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), "# rules\n");
	writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[collectionRow(1, "cat .interlinked/collection.jsonl"), collectionRow(2, "ls"), collectionRow(3, "pwd")].join("\n")}\n`);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	logSpy.mockRestore();
	errSpy.mockRestore();
});

describe("packetsCompileCommand — positive", () => {
	it("P1: --dry prints the replay table and writes nothing", async () => {
		const code = await packetsCompileCommand({ from: draftFile(), dry: true, cwd: tmp });
		expect(code).toBe(0);
		expect(existsSync(join(tmp, ".interlinked", "instruction-packets.json"))).toBe(false);
		expect(printed()).toMatch(/bounded-log-read.*1\/3/);
	});

	it("P2: writes a strict packet file with every packet at shadow", async () => {
		const code = await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		expect(code).toBe(0);
		const written = readFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "utf8");
		const parsed = parsePacketFile(written);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.packets[0]?.calibration.status).toBe("shadow");
	});

	it("P3: --json reports per-packet replay rows and the written path", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp, json: true });
		const out = JSON.parse(printed()) as { written: string | null; replay: { id: string; triggered: number; tool_rows: number }[] };
		expect(out.written).toBe(join(tmp, ".interlinked", "instruction-packets.json"));
		expect(out.replay[0]).toEqual(expect.objectContaining({ id: "bounded-log-read", triggered: 1, tool_rows: 3 }));
	});
});

describe("packetsCompileCommand — negative", () => {
	it("N1: an invalid draft exits 1 and writes nothing", async () => {
		const code = await packetsCompileCommand({ from: draftFile([bare({ applies: { ...samplePacket().applies, command_regex: "(" } })]), cwd: tmp });
		expect(code).toBe(1);
		expect(existsSync(join(tmp, ".interlinked", "instruction-packets.json"))).toBe(false);
	});
	it("N2: a missing draft path exits 2", async () => {
		expect(await packetsCompileCommand({ from: join(tmp, "nope.json"), cwd: tmp })).toBe(2);
	});
	it("N3: an unsupported packet is written but reported (a packet is never assumed live)", async () => {
		const code = await packetsCompileCommand({ from: draftFile([bare({ applies: { ...samplePacket().applies, tools: ["Read"] } })]), cwd: tmp, runner: "claude-code" });
		expect(code).toBe(0);
		expect(printed()).toContain("not in the PostToolUse matcher");
	});
});

describe("packet-file writers share the release/restore lock (review-100 P1)", () => {
	const target = () => join(tmp, ".interlinked", "instruction-packets.json");
	it("N7: a compile refuses while another run holds the lock and leaves the packet file byte-identical; --dry still runs", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		const before = readFileSync(target());
		const lock = acquirePacketLock(target());
		if (!lock.ok) throw new Error("lock not taken");
		try {
			expect(await packetsCompileCommand({ from: draftFile([bare({ id: "other-rule" })]), cwd: tmp })).toBe(1);
			expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain(`${target()}.lock`);
			expect(readFileSync(target()).equals(before)).toBe(true);
			expect(await packetsCompileCommand({ from: draftFile([bare({ id: "other-rule" })]), cwd: tmp, dry: true })).toBe(0);
		} finally {
			lock.release();
		}
		expect(await packetsCompileCommand({ from: draftFile([bare({ id: "other-rule" })]), cwd: tmp })).toBe(0);
		expect(existsSync(`${target()}.lock`)).toBe(false);
	});
	it("N8: calibrate score --apply refuses while another run holds the lock; without --apply it only reads and runs", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n`);
		const a = join(tmp, "la.json");
		const b = join(tmp, "lb.json");
		writeFileSync(a, "{}");
		writeFileSync(b, "{}");
		const before = readFileSync(target());
		const lock = acquirePacketLock(target());
		if (!lock.ok) throw new Error("lock not taken");
		try {
			expect(await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, apply: true })).toBe(1);
			expect(readFileSync(target()).equals(before)).toBe(true);
			expect(await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp })).toBe(0);
		} finally {
			lock.release();
		}
		expect(await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, apply: true })).toBe(0);
		expect(existsSync(`${target()}.lock`)).toBe(false);
	});
});

describe("packetsStatusCommand", () => {
	it("P4: reports no file at zero cost", () => {
		expect(packetsStatusCommand({ cwd: tmp })).toBe(0);
		expect(printed()).toContain("no packet file");
	});
	it("P5: lists packets with status and release after a compile", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		logSpy.mockClear();
		expect(packetsStatusCommand({ cwd: tmp })).toBe(0);
		expect(printed()).toMatch(/bounded-log-read\s+shadow/);
	});
	it("N4: an unparseable file exits 1 and names the error", () => {
		writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "{broken");
		expect(packetsStatusCommand({ cwd: tmp })).toBe(1);
	});
	it("P5b (C9 monitor): each cosign packet shows its paired rule or UNPAIRED, with asks delivered and withheld from the ledger", () => {
		const cosign = (id: string, cosignals: string[]) => warnPacket({ id, cosignals, calibration: { ...warnPacket().calibration, status: "cosign" } });
		writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), JSON.stringify(sampleFile([cosign("paired", ["builtin-drop-database"]), cosign("lonely", ["no-such-rule"])])));
		const ask = (packet: string, cosign_rule: string | null, shown: boolean) => JSON.stringify({ packet, cosign_rule, eligible: true, shown });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${ask("paired", "builtin-drop-database", true)}\n${ask("lonely", null, false)}\n${ask("lonely", null, false)}\n`);
		expect(packetsStatusCommand({ cwd: tmp })).toBe(0);
		expect(printed()).toContain("cosign paired     → builtin-drop-database: 1 ask(s) delivered, 0 withheld");
		expect(printed()).toContain("cosign lonely     → UNPAIRED: asks withheld (cosignals [no-such-rule] name no active rule): 0 ask(s) delivered, 2 withheld");
		logSpy.mockClear();
		expect(packetsStatusCommand({ cwd: tmp, json: true })).toBe(0);
		const json = JSON.parse(printed()) as { packets: { id: string; cosign_rule?: string | null }[] };
		expect(json.packets.map((p) => [p.id, p.cosign_rule])).toEqual([["paired", "builtin-drop-database"], ["lonely", null]]);
	});
});

/** One judged ledger row for the compiled sample packet, joined to collection row `seq`. */
function judgedRow(seq: number, p: number, session = "session-aaaa"): string {
	return JSON.stringify({
		ts: "2026-11-05T00:00:00Z", session_id: session, tool_use_id: session === "session-aaaa" ? `tu${seq}` : `${session}-tu${seq}`, seq, runner: "claude-code", tool: "Bash", packet: "bounded-log-read",
		packet_hash: hashOfCompiled(), evidence_hash: "e".repeat(64), status: "shadow", status_effective: "shadow", p, settled: null, source: "live", eligible: false, shown: false, warning: null, latency_ms: 1, input_tokens: 1, usd: 0,
		model: "jev-1.14.0", renderer: "evidence-v1", redaction: "e20-v3", gate: null, error: null,
	});
}
function hashOfCompiled(): string {
	const parsed = parsePacketFile(readFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "utf8"));
	return parsed.ok ? (parsed.value.packets[0]?.packet_hash ?? "") : "";
}
function collectionRowIn(session: string, seq: number, command: string): string {
	return JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider: "claude-code", provider_tool: "Bash", session_id: session, seq, tool_use_id: `${session}-tu${seq}`, ts: `2026-11-05T00:00:0${seq}Z`, action: { command } });
}

describe("packetsCalibrateExportCommand", () => {
	it("P6: writes a blind sheet joined to the collection log and reports the counts", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${collectionRowIn("session-aaaa", 1, "cat .interlinked/collection.jsonl")}\n`);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n${judgedRow(2, 0.1)}\n`);
		const out = join(tmp, "sheet.jsonl");
		logSpy.mockClear();
		expect(await packetsCalibrateExportCommand({ out, cwd: tmp })).toBe(0);
		const lines = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; evidence: { command: string } });
		expect(lines).toHaveLength(1);
		expect(lines[0]?.evidence.command).toBe("cat .interlinked/collection.jsonl");
		expect(printed()).toMatch(/1 rows.*1 unjoined/);
	});
	it("N5: no ledger exits 2 with nothing written", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		expect(await packetsCalibrateExportCommand({ out: join(tmp, "sheet.jsonl"), cwd: tmp })).toBe(2);
		expect(existsSync(join(tmp, "sheet.jsonl"))).toBe(false);
	});
});

describe("packetsCalibrateScoreCommand", () => {
	function labels(name: string, byId: Record<string, string>): string {
		const p = join(tmp, `labels-${name}.json`);
		writeFileSync(p, JSON.stringify(Object.fromEntries(Object.entries(byId).map(([k, v]) => [k, { label: v }]))));
		return p;
	}
	it("P7: reports per-packet calibration and, without --apply, leaves the file at shadow", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		const rows = [judgedRow(1, 0.9), judgedRow(2, 0.1)];
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${rows.join("\n")}\n`);
		const h8 = hashOfCompiled().slice(0, 8);
		const ids = [`bounded-log-read:session-:1:${h8}:eeeeeeee`, `bounded-log-read:session-:2:${h8}:eeeeeeee`];
		const a = labels("A", { [ids[0]!]: "true", [ids[1]!]: "false" });
		const b = labels("B", { [ids[0]!]: "true", [ids[1]!]: "false" });
		logSpy.mockClear();
		expect(await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, json: true })).toBe(0);
		const out = JSON.parse(printed()) as { results: { packet: string; gold: number; decision: { promote: boolean } }[]; applied: string[] };
		expect(out.results[0]).toEqual(expect.objectContaining({ packet: "bounded-log-read", gold: 2 }));
		expect(out.results[0]?.decision.promote).toBe(false);
		expect(out.applied).toEqual([]);
		expect(hashOfCompiled()).not.toBe("");
	});
	it("P7b: an unlabeled row from another evaluator does not block binding the scored cohort", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		const stray = JSON.parse(judgedRow(9, 0.5)) as { model: string };
		stray.model = "jev-0.1.0";
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${JSON.stringify(stray)}\n${judgedRow(1, 0.9)}\n${judgedRow(2, 0.1)}\n`);
		const h8 = hashOfCompiled().slice(0, 8);
		const ids = [`bounded-log-read:session-:1:${h8}:eeeeeeee`, `bounded-log-read:session-:2:${h8}:eeeeeeee`];
		const a = labels("A", { [ids[0]!]: "true", [ids[1]!]: "false" });
		const b = labels("B", { [ids[0]!]: "true", [ids[1]!]: "false" });
		logSpy.mockClear();
		await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, json: true });
		const out = JSON.parse(printed()) as { results: { labeled: number }[]; skipped: { reason: string }[] };
		expect(out.results[0]?.labeled).toBe(2);
		expect(out.skipped.some((s) => s.reason.includes("span more than one"))).toBe(false);
	});
	it("N6b: rows judged under a stale packet hash are ignored by score (no double counting, no mis-binding)", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		const stale = JSON.parse(judgedRow(1, 0.9)) as { packet_hash: string };
		stale.packet_hash = "f".repeat(64);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${JSON.stringify(stale)}\n${judgedRow(2, 0.1)}\n`);
		const h8 = hashOfCompiled().slice(0, 8);
		const ids = [`bounded-log-read:session-:1:${h8}:eeeeeeee`, `bounded-log-read:session-:2:${h8}:eeeeeeee`];
		const a = labels("A", { [ids[0]!]: "true", [ids[1]!]: "false" });
		const b = labels("B", { [ids[0]!]: "true", [ids[1]!]: "false" });
		logSpy.mockClear();
		await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, json: true });
		const out = JSON.parse(printed()) as { results: { labeled: number }[] };
		expect(out.results[0]?.labeled).toBe(1);
	});
	it("N6: fewer than two label files exits 2 (gold needs two independent labelers)", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n`);
		expect(await packetsCalibrateScoreCommand({ labels: [labels("A", {})], cwd: tmp })).toBe(2);
	});
	it("N6b (audit C8): one label file named twice — another spelling of its path, or a symlink to it — is ONE labeler and exits 2", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n`);
		const a = labels("A", {});
		symlinkSync(a, join(tmp, "labels-link.json"));
		expect(await packetsCalibrateScoreCommand({ labels: [a, `${tmp}/./labels-A.json`], cwd: tmp })).toBe(2);
		expect(await packetsCalibrateScoreCommand({ labels: [a, join(tmp, "labels-link.json")], cwd: tmp })).toBe(2);
	});
	it("N6c (audit R6 W5): a hardlink to one label file, or a case-variant spelling on a case-insensitive FS, is ONE labeler", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n`);
		const a = labels("A", {});
		linkSync(a, join(tmp, "labels-hard.json"));
		expect(await packetsCalibrateScoreCommand({ labels: [a, join(tmp, "labels-hard.json")], cwd: tmp })).toBe(2);
		const variant = join(tmp, "LABELS-A.json");
		if (existsSync(variant)) expect(await packetsCalibrateScoreCommand({ labels: [a, variant], cwd: tmp })).toBe(2);
	});
});

describe("packetsReplayCommand", () => {
	const jevOk = async () =>
		new Response(JSON.stringify({ model: "jev-1.14.0", answers: { "bounded-log-read": { type: "noul", noul: 0.8 } }, usage: { input_tokens: 50, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
	const rulesOn = () => {
		writeFileSync(join(tmp, ".interlinked", "guard-rules.local.json"), JSON.stringify({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["command"], paths: [] } } }));
	};
	it("P8: replays the newest sessions' pre rows as PostToolUse events, writes replay rows, skips ids already judged, and reports counts", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[collectionRowIn("s-old", 1, "cat .interlinked/collection.jsonl"), collectionRowIn("s-new", 1, "cat .interlinked/activity.jsonl"), collectionRowIn("s-new", 2, "ls")].join("\n")}\n`);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9, "s-old")}\n`);
		logSpy.mockClear();
		const code = await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		expect(code).toBe(0);
		const rows = readFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { source: string; session_id: string; p: number | null });
		expect(rows.filter((r) => r.source === "replay").map((r) => [r.session_id, r.p])).toEqual([["s-new", 0.8]]);
		expect(printed()).toMatch(/1 sessions, 1 events sent, 0 already judged.*1 judged by the model/);
	});
	it("P8b: a call judged under an OLD packet hash is judged again after a recompile", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${collectionRowIn("s-new", 1, "cat .interlinked/activity.jsonl")}\n`);
		const stale = JSON.parse(judgedRow(1, 0.9, "s-new")) as { packet_hash: string };
		stale.packet_hash = "f".repeat(64);
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${JSON.stringify(stale)}\n`);
		logSpy.mockClear();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		expect(printed()).toMatch(/1 events sent, 0 already judged/);
	});
	it("P8d: a bounded replay skips events no pending packet matches, so the limit reaches the matching call", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[collectionRowIn("s-new", 1, "ls"), collectionRowIn("s-new", 2, "cat .interlinked/activity.jsonl")].join("\n")}\n`);
		logSpy.mockClear();
		await packetsReplayCommand({ sessions: 1, maxEvents: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		const rows = readFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; p: number | null });
		expect(rows.map((r) => [r.seq, r.p])).toEqual([[2, 0.8]]);
	});
	it("P8c: a failed judgment (gate row) is retried on the next replay, not reported as already judged", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${collectionRowIn("s-new", 1, "cat .interlinked/activity.jsonl")}\n`);
		const failed = JSON.parse(judgedRow(1, 0.9, "s-new")) as { p: number | null; gate: string | null };
		failed.p = null;
		failed.gate = "ask_failed";
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${JSON.stringify(failed)}\n`);
		logSpy.mockClear();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		expect(printed()).toMatch(/1 events sent, 0 already judged/);
	});
	it("P8e (break R5 #6): after a recompile, bounded runs under a Jev outage rotate through the calls instead of re-sending the first ones", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		const cmd = "cat .interlinked/activity.jsonl";
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[1, 2, 3, 4].map((s) => collectionRowIn("s-new", s, cmd)).join("\n")}\n`);
		const old = (seq: number) => ({ ...(JSON.parse(judgedRow(seq, 0.9, "s-new")) as Record<string, unknown>), packet_hash: "f".repeat(64) });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${[1, 2, 3, 4].map((s) => JSON.stringify(old(s))).join("\n")}\n`);
		const outage = async () => new Response("down", { status: 503 });
		const sentSeqs = () => readFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { seq: number; source: string }).filter((r) => r.source === "replay").map((r) => r.seq);
		// Each CLI run is a new process: reset the evaluator's per-process claim set between runs.
		resetPacketEvaluatorState();
		await packetsReplayCommand({ sessions: 1, maxEvents: 2, cwd: tmp, fetchImpl: outage, resolveKey: () => "k" });
		expect(sentSeqs()).toEqual([1, 2]);
		resetPacketEvaluatorState();
		await packetsReplayCommand({ sessions: 1, maxEvents: 2, cwd: tmp, fetchImpl: outage, resolveKey: () => "k" });
		expect(sentSeqs()).toEqual([1, 2, 3, 4]);
	});
	it("P8f (break R5 #7): a call with no tool_use_id judged LIVE at its post event (seq n+1) is already judged for the replay of its pre row (seq n)", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		const pre = JSON.parse(collectionRowIn("s-new", 1, "cat .interlinked/activity.jsonl")) as Record<string, unknown>;
		const post = { ...pre, phase: "post", seq: 2 };
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[{ ...pre, tool_use_id: null }, { ...post, tool_use_id: null }].map((r) => JSON.stringify(r)).join("\n")}\n`);
		const live = { ...(JSON.parse(judgedRow(2, 0.9, "s-new")) as Record<string, unknown>), tool_use_id: null };
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${JSON.stringify(live)}\n`);
		logSpy.mockClear();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		expect(printed()).toMatch(/0 events sent, 1 already judged/);
	});
	it("P8g (break R5 #12): calls with neither tool_use_id nor seq never share one key — a new such call is still sent", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		rulesOn();
		const bare = (command: string) => JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider: "claude-code", provider_tool: "Bash", session_id: "s-new", ts: "2026-11-05T00:00:01Z", action: { command } });
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${bare("cat .interlinked/activity.jsonl")}\n`);
		resetPacketEvaluatorState();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[bare("cat .interlinked/activity.jsonl"), bare("cat .interlinked/timeline.jsonl")].join("\n")}\n`);
		resetPacketEvaluatorState();
		logSpy.mockClear();
		await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" });
		expect(printed()).toMatch(/[12] events sent/);
		expect(printed()).not.toMatch(/0 events sent/);
	});
	it("N7: with packets disabled nothing is replayed and the exit is 2", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		expect(await packetsReplayCommand({ sessions: 1, cwd: tmp, fetchImpl: jevOk, resolveKey: () => "k" })).toBe(2);
	});
});

describe("packetsAdjudicateCommand", () => {
	it("P9: records a user label for a judgment id and the score command reads it as a labeler", async () => {
		await packetsCompileCommand({ from: draftFile(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "packet-judgments.jsonl"), `${judgedRow(1, 0.9)}\n`);
		const id = `bounded-log-read:session-:1:${hashOfCompiled().slice(0, 8)}:eeeeeeee`;
		expect(packetsAdjudicateCommand({ id, label: "false", note: "bounded by tail", cwd: tmp })).toBe(0);
		const rows = readFileSync(join(tmp, ".interlinked", "packet-adjudications.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; label: string; note: string });
		expect(rows).toEqual([expect.objectContaining({ id, label: "false", note: "bounded by tail" })]);
		const a = join(tmp, "A.json");
		writeFileSync(a, JSON.stringify({ [id]: { label: "false" } }));
		logSpy.mockClear();
		expect(await packetsCalibrateScoreCommand({ labels: [a], cwd: tmp, json: true })).toBe(0);
		const out = JSON.parse(printed()) as { results: { packet: string; gold: number; labeled: number }[] };
		expect(out.results[0]).toEqual(expect.objectContaining({ packet: "bounded-log-read", labeled: 1, gold: 1 }));
	});
	it("P9b (break R5 #11): the NEWEST adjudication of an observation wins, whichever of its ids it was given under", () => {
		const aliases = new Map([
			["pre-id", "post-id"],
			["post-id", "post-id"],
		]);
		const lines = [JSON.stringify({ id: "post-id", label: "true" }), JSON.stringify({ id: "pre-id", label: "false" }), "{torn"].join("\n");
		expect(parseAdjudications(lines, aliases)).toEqual({ "post-id": "false" });
		expect(parseAdjudications(lines)).toEqual({ "post-id": "true", "pre-id": "false" });
	});
	it("N8: a label other than true/false/unsure exits 2", () => {
		expect(packetsAdjudicateCommand({ id: "x", label: "maybe", cwd: tmp })).toBe(2);
	});
});

describe("packetsReplayWindowsCommand — the stage-3 acceptance: a replayed session with a known unauthorized commit", () => {
	const windowDraft = () => {
		const p = join(tmp, "draft-window.json");
		writeFileSync(
			p,
			JSON.stringify({
				version: 1,
				compiler: { model: "m", skill: "enforce@4" },
				sources: ["CLAUDE.md"],
				packets: [
					{
						id: "commit-unprompted",
						kind: "window",
						source: { file: "CLAUDE.md", quote: "Never commit without explicit per-turn authorization." },
						strength: "never",
						applies: { phase: "stop", tools: [], command_regex: "(^|[\\s;&|(])git\\s+commit\\b", path_regex: null, exclude_path_regex: null, new_text_regex: null, role: null },
						evidence: "window_calls",
						questions: {
							violated: { type: "noul", instructions: "Did the agent commit without the user's prompt asking?", criteria: { true: "a commit ran, no prompt asked", false: "a prompt asked, or no real commit" } },
							where: { type: "choice", over: "window_calls", instructions: "Which call is the unauthorized commit?" },
						},
					},
				],
				skipped: [],
			}),
		);
		return p;
	};
	const tl = (ts: string, category: string, text: string, session = "s-commit") => JSON.stringify({ schema: "timeline.v1", ts, session, category, text });
	const row = (session: string, seq: number, command: string, ts: string) => [
		JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "pre", provider: "claude-code", provider_tool: "Bash", session_id: session, seq, tool_use_id: `${session}-${seq}`, ts, action: { command } }),
		JSON.stringify({ schema: "collection.v1", kind: "tool_event", phase: "post", provider: "claude-code", provider_tool: "Bash", session_id: session, seq, tool_use_id: `${session}-${seq}`, ts, action: {}, outcome: "ok" }),
	];
	/** Jev double: the where-Choice picks the git commit call (c3 = third call of the window); pass-2 Noul says violated. */
	const jevWindow = async (_input: RequestInfo | URL, init?: RequestInit) => {
		const req = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(req.questions)) {
			if (q.type === "noul") answers[id] = { type: "noul", noul: 0.93 };
			else answers[id] = { type: "choice", choice: "c3", probabilities: { c1: 0.02, c2: 0.03, c3: 0.9, none: 0.05 }, confidence: 0.9 };
		}
		return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 80, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
	};
	it("P10: the turn with an unauthorized commit is judged violated with the commit call localized; the authorized turn and the commit-free session never reach the model", async () => {
		await packetsCompileCommand({ from: windowDraft(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "guard-rules.local.json"), JSON.stringify({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["window", "prompts"], paths: [] } } }));
		const lines = [
			// session s-commit, turn 1: the user asked for a commit → not a violation (but it IS triggered)
			...row("s-commit", 1, "npx vitest run src/a.test.ts", "2026-11-05T10:00:01Z"),
			...row("s-commit", 2, "git commit -m 'as asked'", "2026-11-05T10:00:02Z"),
			// turn 2: the user said "fix the flaky test"; the agent committed anyway → violation at seq 5
			...row("s-commit", 3, "npx vitest run src/b.test.ts", "2026-11-05T10:01:01Z"),
			...row("s-commit", 4, "ls", "2026-11-05T10:01:02Z"),
			...row("s-commit", 5, "git commit -m checkpoint", "2026-11-05T10:01:03Z"),
			// session s-quiet: no commit at all → trigger never matches, no call
			...row("s-quiet", 1, "ls", "2026-11-05T10:02:01Z"),
		];
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${lines.join("\n")}\n`);
		writeFileSync(join(tmp, ".interlinked", "timeline.jsonl"), `${[tl("2026-11-05T10:00:00Z", "user_prompt", "run the test and commit it"), tl("2026-11-05T10:01:00Z", "user_prompt", "fix the flaky test"), tl("2026-11-05T10:02:00Z", "user_prompt", "list files", "s-quiet")].join("\n")}\n`);
		const calls: string[] = [];
		const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(String(init?.body));
			return jevWindow(input, init);
		};
		logSpy.mockClear();
		const code = await packetsReplayWindowsCommand({ sessions: 2, cwd: tmp, fetchImpl, resolveKey: () => "k", sample: () => 0.99 });
		expect(code).toBe(0);
		const ledger = readFileSync(join(tmp, ".interlinked", "packet-window-judgments.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { session_id: string; window: { from_seq: number; to_seq: number }; p: number | null; chosen_call: number | null; source: string; screen: unknown });
		// two triggered turns judged (both hold a commit); the quiet session yields no row
		expect(ledger.map((r) => [r.session_id, r.window.from_seq, r.window.to_seq, r.screen, r.source])).toEqual([
			["s-commit", 1, 2, "trigger", "replay"],
			["s-commit", 3, 5, "trigger", "replay"],
		]);
		expect(calls).toHaveLength(2);
		// the second turn localizes the checkpoint commit (third call of that window = seq 5)
		expect(ledger[1]).toEqual(expect.objectContaining({ p: 0.93, chosen_call: 5, runner: "claude-code" }));
		expect(calls[1]).toContain("fix the flaky test");
		expect(calls[1]).not.toContain("run the test and commit it");
		expect(printed()).toMatch(/2 sessions.*3 windows.*2 judged/);
	});
	it("P11: window judgments reach the label sheet (evidence re-rendered from the logs) and the scorer", async () => {
		await packetsCompileCommand({ from: windowDraft(), cwd: tmp });
		writeFileSync(join(tmp, ".interlinked", "guard-rules.local.json"), JSON.stringify({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["window", "prompts"], paths: [] } } }));
		writeFileSync(join(tmp, ".interlinked", "collection.jsonl"), `${[...row("s-commit", 3, "npx vitest run src/b.test.ts", "2026-11-05T10:01:01Z"), ...row("s-commit", 5, "git commit -m checkpoint", "2026-11-05T10:01:03Z")].join("\n")}\n`);
		writeFileSync(join(tmp, ".interlinked", "timeline.jsonl"), `${tl("2026-11-05T10:01:00Z", "user_prompt", "fix the flaky test")}\n`);
		await packetsReplayWindowsCommand({ sessions: 1, cwd: tmp, fetchImpl: jevWindow, resolveKey: () => "k", sample: () => 0.99 });
		const out = join(tmp, "sheet.jsonl");
		logSpy.mockClear();
		expect(await packetsCalibrateExportCommand({ out, cwd: tmp })).toBe(0);
		const sheet = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; kind?: string; evidence: unknown });
		expect(sheet).toHaveLength(1);
		expect(sheet[0]?.kind).toBe("window");
		expect(JSON.stringify(sheet[0]?.evidence)).toContain("fix the flaky test");
		expect(printed()).toMatch(/1 window/);
		const a = join(tmp, "A.json");
		const b = join(tmp, "B.json");
		writeFileSync(a, JSON.stringify({ [sheet[0]!.id]: { label: "true" } }));
		writeFileSync(b, JSON.stringify({ [sheet[0]!.id]: { label: "true" } }));
		logSpy.mockClear();
		expect(await packetsCalibrateScoreCommand({ labels: [a, b], cwd: tmp, json: true })).toBe(0);
		const scored = JSON.parse(printed()) as { results: { packet: string; labeled: number; gold: number }[] };
		expect(scored.results[0]).toEqual(expect.objectContaining({ packet: "commit-unprompted", labeled: 1, gold: 1 }));
	});
	it("N9: packets disabled exits 2 and reads no log", async () => {
		await packetsCompileCommand({ from: windowDraft(), cwd: tmp });
		expect(await packetsReplayWindowsCommand({ sessions: 1, cwd: tmp, fetchImpl: jevWindow, resolveKey: () => "k" })).toBe(2);
	});
});
