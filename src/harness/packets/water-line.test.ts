import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectBaselineGaming, evaluateBaselineIntegrityForEvent } from "../evaluator/baseline-integrity-gate.js";
import { releaseEdit } from "./release.js";
import type { HarnessEvent } from "../types.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { withHash } from "./schema.js";
import { applyPacketTransition } from "./transition.js";
import type { Packet, PacketFile } from "./types.js";
import { detectPacketLoosening, packetCreationDefects } from "./water-line.js";

const FILE = "/repo/.interlinked/instruction-packets.json";

function file(packets: Packet[], overrides: Partial<PacketFile> = {}): string {
	return JSON.stringify(sampleFile(packets.map(withHash), overrides));
}
const rules = (before: string, after: string) => detectPacketLoosening(FILE, before, after).map((f) => f.rule);
const RELEASE = { text: "Never full-read `collection.jsonl` …", released_at: "2026-11-05T17:00:00.000Z", span_hash: "c".repeat(64) };

describe("detectPacketLoosening — a release vouched for by the instruction file on disk (R43)", () => {
	const QUOTE = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).";
	const SRC = `# rules\n\n- ${QUOTE}\n- Keep cwd at the repo root.\n`;
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");
	function releasedPair(): { before: string; after: string; pointerFile: string } {
		const live = warnPacket({ source: { file: "CLAUDE.md", span: null, quote: QUOTE } });
		const beforeFile = sampleFile([live], { sources: { "CLAUDE.md": sha(SRC) } });
		const edit = releaseEdit(beforeFile, "CLAUDE.md", SRC, "2026-11-05T20:00:00.000Z");
		if (!edit.ok) throw new Error(edit.error);
		return { before: JSON.stringify(beforeFile), after: JSON.stringify(edit.file), pointerFile: edit.source };
	}
	it("N0: the release `packets release` made passes when the reader sees the pointer-bearing file", () => {
		const { before, after, pointerFile } = releasedPair();
		expect(detectPacketLoosening(FILE, before, after, () => pointerFile).map((f) => f.rule)).toEqual([]);
	});
	it("P0a: without a reader (no disk to vouch) the same release still fires", () => {
		const { before, after } = releasedPair();
		expect(detectPacketLoosening(FILE, before, after).map((f) => f.rule)).toContain("release-added:bounded-log-read");
	});
	it("P0b: the words still in the file, or a file that does not hash to the recorded source, fires", () => {
		const { before, after, pointerFile } = releasedPair();
		expect(detectPacketLoosening(FILE, before, after, () => SRC).map((f) => f.rule)).toContain("release-added:bounded-log-read");
		expect(detectPacketLoosening(FILE, before, after, () => `${pointerFile}\n- an extra line\n`).map((f) => f.rule)).toContain("release-added:bounded-log-read");
		expect(detectPacketLoosening(FILE, before, after, () => null).map((f) => f.rule)).toContain("release-added:bounded-log-read");
	});
	it("N0b (audit D7): a wrapped duplicate of the quote left elsewhere in the file does not make a real release look forged", () => {
		const { before, after, pointerFile } = releasedPair();
		const withDuplicate = `${pointerFile}\n> ${QUOTE.replace(", or", ",\n> or")}\n`;
		const file = JSON.parse(after) as PacketFile;
		const rehashed = JSON.stringify({ ...file, sources: { ...file.sources, "CLAUDE.md": sha(withDuplicate) } });
		expect(detectPacketLoosening(FILE, before, rehashed, () => withDuplicate).map((f) => f.rule)).toEqual([]);
	});
	it("P0d (audit C6): a tool-written release whose text is not the packet's own quote fires, even with the disk consistent", () => {
		const { before, after, pointerFile } = releasedPair();
		const forged = JSON.parse(after) as PacketFile;
		for (const p of forged.packets) if (p.release) p.release = { ...p.release, text: "ok", span_hash: sha("ok") };
		expect(detectPacketLoosening(FILE, before, JSON.stringify(forged), () => pointerFile).map((f) => f.rule)).toContain("release-added:bounded-log-read");
	});
	it("P0e (audit C1, P1): a released live packet whose decider is neutered, rehashed and re-bound with the old holdout fires — at the tool gate AND at the commit gate", () => {
		const { after, pointerFile } = releasedPair();
		const releasedFile = JSON.parse(after) as PacketFile;
		const gamed = JSON.parse(after) as PacketFile;
		gamed.packets = gamed.packets.map((p) => {
			const neutered = withHash({ ...p, settle: { compliant_regex: ".*", violated_regex: null } });
			const bound_to = p.calibration.bound_to ? { ...p.calibration.bound_to, packet_hash: neutered.packet_hash } : null;
			return { ...neutered, calibration: { ...p.calibration, bound_to } };
		});
		for (const origin of ["tool", "recorded"] as const) {
			expect(detectPacketLoosening(FILE, JSON.stringify(releasedFile), JSON.stringify(gamed), () => pointerFile, origin).map((f) => f.rule)).toContain("released-packet-changed:bounded-log-read");
		}
	});
	it("P0f: a released packet moved to another instruction file fires (the release names the old file)", () => {
		const { after, pointerFile } = releasedPair();
		const moved = JSON.parse(after) as PacketFile;
		moved.packets = moved.packets.map((p) => ({ ...p, source: { ...p.source, file: "AGENTS.md" } }));
		expect(detectPacketLoosening(FILE, after, JSON.stringify(moved), () => pointerFile).map((f) => f.rule)).toContain("released-packet-changed:bounded-log-read");
	});
	it("P0g: a TOOL write that raises a released packet's tau fires (nothing would warn, the words are gone); the commit gate cannot tell it from a recalibration and does not", () => {
		const { after, pointerFile } = releasedPair();
		const raised = JSON.parse(after) as PacketFile;
		raised.packets = raised.packets.map((p) => ({ ...p, calibration: { ...p.calibration, tau: 1 } }));
		expect(detectPacketLoosening(FILE, after, JSON.stringify(raised), () => pointerFile, "tool").map((f) => f.rule)).toContain("released-calibration-changed:bounded-log-read");
		expect(detectPacketLoosening(FILE, after, JSON.stringify(raised), () => pointerFile, "recorded").map((f) => f.rule)).not.toContain("released-calibration-changed:bounded-log-read");
	});
	it("N0c: a tool write that DEMOTES a released packet is allowed — the fallback hands the words back", () => {
		const { after, pointerFile } = releasedPair();
		const demoted = JSON.parse(after) as PacketFile;
		demoted.packets = demoted.packets.map((p) => ({ ...p, calibration: { ...samplePacket().calibration } }));
		expect(detectPacketLoosening(FILE, after, JSON.stringify(demoted), () => pointerFile, "tool")).toEqual([]);
	});
	it("N0d (R6 P3): a TOOL write that changes ONLY measured_at on a shadow released packet passes; any other field still fires", () => {
		const { after } = releasedPair();
		const shadow = JSON.parse(after) as PacketFile;
		shadow.packets = shadow.packets.map((p) => ({ ...p, calibration: { ...samplePacket().calibration } }));
		const base = JSON.stringify(shadow);
		const stamped = JSON.parse(base) as PacketFile;
		stamped.packets = stamped.packets.map((p) => ({ ...p, calibration: { ...p.calibration, measured_at: "2026-11-06T12:00:00.000Z" } }));
		expect(detectPacketLoosening(FILE, base, JSON.stringify(stamped), () => null, "tool").map((f) => f.rule)).not.toContain("released-calibration-changed:bounded-log-read");
		const moved = JSON.parse(base) as PacketFile;
		moved.packets = moved.packets.map((p) => ({ ...p, calibration: { ...p.calibration, measured_at: "2026-11-06T12:00:00.000Z", holdout: { ...p.calibration.holdout, n: p.calibration.holdout.n + 1 } } }));
		expect(detectPacketLoosening(FILE, base, JSON.stringify(moved), () => null, "tool").map((f) => f.rule)).toContain("released-calibration-changed:bounded-log-read");
	});
	it("P0h (R6 P2): a TOOL write that demotes a released packet one step AND raises its tau fires; only the demote edge passes", () => {
		const { after, pointerFile } = releasedPair();
		const gamed = JSON.parse(after) as PacketFile;
		gamed.packets = gamed.packets.map((p) => ({ ...p, calibration: { ...p.calibration, status: "score", tau: 1 } }));
		expect(detectPacketLoosening(FILE, after, JSON.stringify(gamed), () => pointerFile, "tool").map((f) => f.rule)).toContain("released-calibration-changed:bounded-log-read");
		const edge = JSON.parse(after) as PacketFile;
		edge.packets = edge.packets.map((p) => {
			const r = applyPacketTransition(p.calibration, { kind: "demote", reason: { kind: "reconstructed" }, now: "2026-11-06T11:00:00.000Z" }, p.packet_hash);
			if (!r.ok) throw new Error(r.reason);
			return { ...p, calibration: r.calibration };
		});
		expect(detectPacketLoosening(FILE, after, JSON.stringify(edge), () => pointerFile, "tool")).toEqual([]);
	});
	it("P0c: a release on a packet without a measured promotion fires even when the disk agrees", () => {
		const { before, after, pointerFile } = releasedPair();
		const demoted = JSON.parse(after) as PacketFile;
		for (const p of demoted.packets) p.calibration = { ...p.calibration, holdout: { ...p.calibration.holdout, n: 1 } };
		expect(detectPacketLoosening(FILE, before, JSON.stringify(demoted), () => pointerFile).map((f) => f.rule)).toContain("release-added:bounded-log-read");
	});
});

describe("a pre-image the strict parser refuses is not a free pass (break R1)", () => {
	const invalid = JSON.stringify({ ...sampleFile([samplePacket()]), a_field_from_a_newer_cli: true });
	it("P: a write onto an invalid file that adds a live or released packet fires, as a creation would", () => {
		expect(rules(invalid, file([warnPacket()]))).toContain("new-packet-not-shadow:bounded-log-read");
		expect(rules(invalid, file([samplePacket({ release: RELEASE })]))).toContain("new-packet-not-shadow:bounded-log-read");
	});
	it("N: repairing an invalid file to shadow packets with nothing released passes", () => {
		expect(rules(invalid, file([samplePacket()]))).toEqual([]);
	});
	it("P (break R4 #3): a write onto an invalid file that held a RELEASE (the lenient reader delivers it) and drops it fires", () => {
		const text = "Never full-read `collection.jsonl`.";
		const released = warnPacket({ release: { text, released_at: "2026-11-05T17:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") } });
		const invalidReleased = JSON.stringify({ ...sampleFile([released]), a_field_from_a_newer_cli: true });
		expect(rules(invalidReleased, file([samplePacket()]))).toContain("released-packet-dropped:bounded-log-read");
	});
	it("N (R6 P3): repairing an invalid file while KEEPING its release does not fire released-packet-dropped", () => {
		const text = "Never full-read `collection.jsonl`.";
		const released = warnPacket({ release: { text, released_at: "2026-11-05T17:00:00.000Z", span_hash: createHash("sha256").update(text).digest("hex") } });
		const invalidReleased = JSON.stringify({ ...sampleFile([released]), a_field_from_a_newer_cli: true });
		expect(rules(invalidReleased, file([released]))).not.toContain("released-packet-dropped:bounded-log-read");
	});
	it("P: the same through the real gate entry point (detectBaselineGaming), incl. a pre-image that is not JSON at all", () => {
		const gaming = (before: string) => detectBaselineGaming(FILE, before, file([warnPacket()])).map((f) => f.rule);
		expect(gaming(invalid)).toContain("new-packet-not-shadow:bounded-log-read");
		expect(gaming("{torn")).toContain("new-packet-not-shadow:bounded-log-read");
	});
});

describe("window packets never cosign (R36, audit C7)", () => {
	it("P: a hand edit raising a window packet to cosign with a fabricated full measurement fires", () => {
		const base = samplePacket({ id: "w", kind: "window", evidence: "window_calls", applies: { ...samplePacket().applies, phase: "stop", tools: [] }, questions: { ...samplePacket().questions, where: { type: "choice", over: "window_calls", instructions: "which?" } } });
		const warn = withHash({ ...base, calibration: { ...warnPacket().calibration } });
		const bound = { ...warn.calibration.bound_to!, packet_hash: warn.packet_hash };
		const before = { ...warn, calibration: { ...warn.calibration, bound_to: bound } };
		const cosign = { ...before, calibration: { ...before.calibration, status: "cosign" as const, adjudication: { n: 250, tp: 240 } } };
		expect(rules(JSON.stringify(sampleFile([before])), JSON.stringify(sampleFile([cosign])))).toContain("window-cosign:w");
	});
	it("P-C9: dropping a cosignal from a packet that stays at cosign fires cosignal-dropped", () => {
		const warn = warnPacket({ cosignals: ["r1", "r2"] });
		const cosign = { ...warn, calibration: { ...warn.calibration, status: "cosign" as const, adjudication: { n: 250, tp: 240 } } };
		expect(rules(JSON.stringify(sampleFile([cosign])), JSON.stringify(sampleFile([{ ...cosign, cosignals: ["r2"] }])))).toEqual(["cosignal-dropped:bounded-log-read"]);
	});
	it("N-C9: adding a cosignal, or dropping one from a packet below cosign, does not fire", () => {
		const warn = warnPacket({ cosignals: ["r1"] });
		const cosign = { ...warn, calibration: { ...warn.calibration, status: "cosign" as const, adjudication: { n: 250, tp: 240 } } };
		expect(rules(JSON.stringify(sampleFile([cosign])), JSON.stringify(sampleFile([{ ...cosign, cosignals: ["r1", "r3"] }])))).toEqual([]);
		expect(rules(JSON.stringify(sampleFile([warn])), JSON.stringify(sampleFile([{ ...warn, cosignals: [] }])))).toEqual([]);
	});
});

describe("detectPacketLoosening — negative (must not fire)", () => {
	it("N1: an identical rewrite", () => expect(rules(file([warnPacket()]), file([warnPacket()]))).toEqual([]));
	it("N2: lowering a status (warn → shadow) tightens nothing", () =>
		expect(rules(file([warnPacket()]), file([samplePacket()]))).toEqual([]));
	it("N3: changing a trigger with the status reset to shadow is a recompile", () => {
		const changed = samplePacket({ applies: { ...samplePacket().applies, command_regex: "activity" } });
		expect(rules(file([warnPacket()]), file([changed]))).toEqual([]);
	});
	it("N4: adding a new shadow packet", () => expect(rules(file([]), file([samplePacket()]))).toEqual([]));
	it("N5: removing an unreleased packet", () => expect(rules(file([warnPacket()]), file([]))).toEqual([]));
	it("N6: raising tau", () =>
		expect(rules(file([warnPacket()]), file([warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.9 } })]))).toEqual([]));
	it("N7: removing a release passes when the instruction file holds the words again and not the pointer (what restore leaves)", () => {
		const restored = `# rules\n\n- ${RELEASE.text}\n`;
		expect(detectPacketLoosening(FILE, file([warnPacket({ release: RELEASE })]), file([warnPacket()]), () => restored, "tool").map((f) => f.rule)).toEqual([]);
	});
	it("P17 (break R4 #1, P1): clearing a release while the file still holds only the pointer fires — the words would exist nowhere; without a reader it fires too", () => {
		const pointerOnly = "# rules\n\n- [interlinked packet bounded-log-read: enforced by hook]\n";
		const demotedNoRelease = file([samplePacket()]);
		expect(detectPacketLoosening(FILE, file([warnPacket({ release: RELEASE })]), demotedNoRelease, () => pointerOnly, "tool").map((f) => f.rule)).toContain("release-removed:bounded-log-read");
		expect(detectPacketLoosening(FILE, file([warnPacket({ release: RELEASE })]), demotedNoRelease, () => pointerOnly, "recorded").map((f) => f.rule)).toContain("release-removed:bounded-log-read");
		expect(rules(file([warnPacket({ release: RELEASE })]), demotedNoRelease)).toContain("release-removed:bounded-log-read");
	});
	it("P18 (break R4 #2): changing a release's span_hash fires (restore would refuse); changing only released_at does not", () => {
		expect(rules(file([warnPacket({ release: RELEASE })]), file([warnPacket({ release: { ...RELEASE, span_hash: "d".repeat(64) } })]))).toContain("release-text-changed:bounded-log-read");
		expect(rules(file([warnPacket({ release: RELEASE })]), file([warnPacket({ release: { ...RELEASE, released_at: "2026-11-06T00:00:00.000Z" } })]))).toEqual([]);
	});
	it("N8: recompiling the sources map and the skipped list", () =>
		expect(rules(file([samplePacket()]), file([samplePacket()], { sources: { "CLAUDE.md": "b".repeat(64) }, skipped: [] }))).toEqual([]));
});

/** A live packet WITHOUT a complete measurement (what a hand edit, not calibrate --apply, produces). */
const unmeasuredWarn = (overrides: Partial<Packet> = {}) => {
	const w = warnPacket(overrides);
	return { ...w, calibration: { ...w.calibration, holdout: { n: 3, pos: 1, auroc: null, precision_at_tau: null, recall_at_tau: null } } };
};

describe("detectPacketLoosening — positive (must fire)", () => {
	it("P1: raising a status by hand (no complete measurement behind it)", () => {
		const unmeasured = warnPacket({ calibration: { ...warnPacket().calibration, holdout: { n: 3, pos: 1, auroc: null, precision_at_tau: null, recall_at_tau: null } } });
		expect(rules(file([samplePacket()]), file([unmeasured]))).toContain("status-raised:bounded-log-read");
	});
	it("N11: a status raise carrying a complete measured promotion (what calibrate --apply writes) passes, so a promotion stays committable", () =>
		expect(rules(file([samplePacket()]), file([warnPacket()]))).toEqual([]));
	it("P2: lowering tau by hand (no measurement behind the new value)", () => {
		const lowered = unmeasuredWarn({ calibration: { ...warnPacket().calibration, tau: 0.3 } });
		expect(rules(file([warnPacket()]), file([lowered]))).toContain("tau-lowered:bounded-log-read");
	});
	it("P3: changing a trigger while the packet stays live, by hand", () => {
		const changed = unmeasuredWarn({ applies: { ...warnPacket().applies, command_regex: "activity" } });
		expect(rules(file([warnPacket()]), JSON.stringify(sampleFile([rebind(changed)])))).toContain("hash-changed-live:bounded-log-read");
	});
	it("P4: changing a criterion while the packet stays live, by hand", () => {
		const w = warnPacket();
		const changed = unmeasuredWarn({ questions: { violated: { ...w.questions.violated, criteria: { true: "anything", false: "nothing" } }, where: null } });
		expect(rules(file([w]), JSON.stringify(sampleFile([rebind(changed)])))).toContain("hash-changed-live:bounded-log-read");
	});
	it("P5: changing the binding while the status stays live, by hand", () => {
		const moved = unmeasuredWarn({ calibration: { ...warnPacket().calibration, bound_to: { ...warnPacket().calibration.bound_to!, model: "jev-2.0.0" } } });
		expect(rules(file([warnPacket()]), file([moved]))).toContain("binding-changed-live:bounded-log-read");
	});
	it("N12: a measured recalibration that lowers tau, or promotes a recompiled identity, passes (it is what calibrate --apply writes)", () => {
		const lower = warnPacket({ calibration: { ...warnPacket().calibration, tau: 0.5 } });
		expect(rules(file([warnPacket()]), file([lower]))).toEqual([]);
		const recompiled = warnPacket({ questions: { ...warnPacket().questions, violated: { ...warnPacket().questions.violated, instructions: "reworded" } } });
		expect(rules(file([warnPacket()]), file([recompiled]))).toEqual([]);
	});
	it("P16: a cosign raise without holdout recall is a hand raise", () => {
		const noRecall = warnPacket({ calibration: { ...warnPacket().calibration, status: "cosign", holdout: { ...warnPacket().calibration.holdout, recall_at_tau: null } } });
		expect(rules(file([warnPacket()]), file([noRecall]))).toContain("status-raised:bounded-log-read");
		const noAdjudication = warnPacket({ calibration: { ...warnPacket().calibration, status: "cosign" } });
		expect(rules(file([warnPacket()]), file([noAdjudication]))).toContain("status-raised:bounded-log-read");
		const measured = warnPacket({ calibration: { ...warnPacket().calibration, status: "cosign", adjudication: { n: 200, tp: 180 } } });
		expect(rules(file([warnPacket()]), file([measured]))).toEqual([]);
	});
	it("P6: adding a release through a tool write", () =>
		expect(rules(file([warnPacket()]), file([warnPacket({ release: RELEASE })]))).toContain("release-added:bounded-log-read"));
	it("P7: editing released text", () =>
		expect(rules(file([warnPacket({ release: RELEASE })]), file([warnPacket({ release: { ...RELEASE, text: "shorter" } })]))).toContain("release-text-changed:bounded-log-read"));
	it("P8: removing a released packet drops its fallback text", () =>
		expect(rules(file([warnPacket({ release: RELEASE })]), file([]))).toContain("released-packet-removed:bounded-log-read"));
	it("P9: a new packet that is not shadow", () =>
		expect(rules(file([]), file([warnPacket()]))).toContain("new-packet-not-shadow:bounded-log-read"));
	it("P10: a post-image the parser refuses", () => {
		const r = rules(file([samplePacket()]), JSON.stringify({ ...sampleFile([withHash(samplePacket())]), version: 2 }));
		expect(r.some((x) => x.startsWith("packets-invalid"))).toBe(true);
	});
});

describe("packetCreationDefects", () => {
	it("N9: an all-shadow file may be created", () => expect(packetCreationDefects(file([samplePacket()]))).toEqual([]));
	it("P11: a created file carrying a live packet is refused", () => expect(packetCreationDefects(file([warnPacket()]))).not.toEqual([]));
	it("P12: an unparseable created file is refused", () => expect(packetCreationDefects("{")).not.toEqual([]));
});

describe("wired into the baseline-integrity gate", () => {
	it("P13: detectBaselineGaming routes the packet file to the packet detector", () => {
		const unmeasured = warnPacket({ calibration: { ...warnPacket().calibration, holdout: { n: 3, pos: 1, auroc: null, precision_at_tau: null, recall_at_tau: null } } });
		const f = detectBaselineGaming(FILE, file([samplePacket()]), file([unmeasured]));
		expect(f.map((x) => x.rule)).toContain("status-raised:bounded-log-read");
	});
	it("P14: a Write that creates the file with a live packet is blocked", () => {
		const event = write(file([warnPacket()]));
		const d = evaluateBaselineIntegrityForEvent(event, { getDisk: () => null });
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
	});
	it("N10: a Write that creates the file with shadow packets only is allowed", () => {
		expect(evaluateBaselineIntegrityForEvent(write(file([samplePacket()])), { getDisk: () => null })).toBeNull();
	});
	it("P15: a Write that raises a status over the on-disk file without measurement is blocked", () => {
		const unmeasured = warnPacket({ calibration: { ...warnPacket().calibration, holdout: { n: 3, pos: 1, auroc: null, precision_at_tau: null, recall_at_tau: null } } });
		const d = evaluateBaselineIntegrityForEvent(write(file([unmeasured])), { getDisk: () => file([samplePacket()]) });
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("status-raised");
	});
});

function rebind(p: Packet): Packet {
	const hashed = withHash(p);
	return { ...hashed, calibration: { ...hashed.calibration, bound_to: { ...hashed.calibration.bound_to!, packet_hash: hashed.packet_hash } } };
}

function write(content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: FILE, content },
		timestamp: "2026-11-05T00:00:00Z",
		cwd: "/repo",
	} as HarnessEvent;
}
