import { describe, expect, it } from "vitest";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { packetHash, parsePacketFile, statusRank, withHash } from "./schema.js";
import type { Packet } from "./types.js";

function text(packets: Packet[], overrides = {}): string {
	return JSON.stringify(sampleFile(packets.map(withHash), overrides));
}

describe("parsePacketFile — positive (must accept)", () => {
	it("P1: accepts a well-formed file and returns typed packets", () => {
		const r = parsePacketFile(text([samplePacket()]));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.packets).toHaveLength(1);
		expect(r.value.packets[0]?.id).toBe("bounded-log-read");
		expect(r.value.packets[0]?.packet_hash).toBe(packetHash(samplePacket()));
	});

	it("P2: accepts a warn packet whose binding names its own hash", () => {
		const r = parsePacketFile(text([warnPacket()]));
		expect(r.ok).toBe(true);
	});

	it("P3: accepts a window packet with no tools, stop phase and window evidence", () => {
		const w = samplePacket({
			id: "verify-after-edits",
			kind: "window",
			applies: { phase: "stop", tools: [], command_regex: null, path_regex: null, exclude_path_regex: null, new_text_regex: null, role: null },
			evidence: "window_calls",
			questions: { ...samplePacket().questions, where: { type: "choice", over: "window_calls", instructions: "which call verified?" } },
		});
		expect(parsePacketFile(text([w])).ok).toBe(true);
	});

	it("P4: accepts an empty packet list", () => {
		expect(parsePacketFile(text([])).ok).toBe(true);
	});
});

describe("parsePacketFile — negative (must refuse)", () => {
	const refuse = (t: string, needle: string) => {
		const r = parsePacketFile(t);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain(needle);
	};

	it("N1: refuses broken JSON", () => refuse("{nope", "JSON"));
	it("N2: refuses an unknown top-level key", () => refuse(text([], { extra: 1 }), 'unknown key "extra"'));
	it("N3: refuses an unknown packet key", () => refuse(JSON.stringify(sampleFile([{ ...withHash(samplePacket()), bogus: true } as unknown as Packet])), 'unknown key "bogus"'));
	it("N4: refuses a version other than 1", () => refuse(text([], { version: 2 }), "version"));
	it("N5: refuses a malformed id", () => refuse(text([samplePacket({ id: "has space" })]), "id"));
	it("N6: refuses duplicate ids", () => refuse(text([samplePacket(), samplePacket()]), "unique"));
	it("N7: refuses a regex that does not compile", () =>
		refuse(text([samplePacket({ applies: { ...samplePacket().applies, command_regex: "(" } })]), "command_regex"));
	it("N8: refuses a call packet at the stop phase", () =>
		refuse(text([samplePacket({ applies: { ...samplePacket().applies, phase: "stop" } })]), "phase"));
	it("N9: refuses a call packet with no tools", () =>
		refuse(text([samplePacket({ applies: { ...samplePacket().applies, tools: [] } })]), "tools"));
	it("N10: refuses a window packet that names tools", () =>
		refuse(text([samplePacket({ kind: "window", evidence: "window_digest", applies: { ...samplePacket().applies, phase: "stop" } })]), "tools"));
	it("N11: refuses a `where` localizer whose `over` does not match the evidence", () =>
		refuse(text([samplePacket({ questions: { ...samplePacket().questions, where: { type: "choice", over: "hunks", instructions: "x" } } })]), "where.over"));
	it("N12: refuses a non-shadow packet with no binding", () =>
		refuse(text([samplePacket({ calibration: { ...samplePacket().calibration, status: "warn", tau: 0.7 } })]), "bound_to"));
	it("N13: refuses a binding whose packet_hash is not the packet's", () => {
		const p = withHash(warnPacket());
		p.calibration.bound_to = { ...p.calibration.bound_to!, packet_hash: "f".repeat(64) };
		refuse(JSON.stringify(sampleFile([p])), "bound_to.packet_hash");
	});
	it("N14 (now P): a demoted shadow packet that still carries a release parses — the fallback needs the words", () => {
		const parsed = parsePacketFile(text([samplePacket({ release: { text: "Never …", released_at: "2026-11-05T00:00:00Z", span_hash: "a".repeat(64) } })]));
		expect(parsed.ok).toBe(true);
	});
	it("N15: refuses tau outside [0, 1]", () =>
		refuse(text([warnPacket({ calibration: { ...warnPacket().calibration, tau: 1.5 } })]), "tau"));
	it("N16: refuses a source hash that is not 64 hex characters", () => refuse(text([], { sources: { "CLAUDE.md": "abc" } }), "sources"));
	it("N17: refuses a packet_hash that does not match the packet's content", () =>
		refuse(JSON.stringify(sampleFile([{ ...samplePacket(), packet_hash: "b".repeat(64) }])), "packet_hash"));
	it("N18: refuses a Noul whose criteria are empty", () =>
		refuse(
			text([samplePacket({ questions: { violated: { type: "noul", instructions: "q", criteria: { true: "", false: "x" } }, where: null } })]),
			"criteria",
		));
	it("N20: refuses a settle regex that does not compile", () =>
		refuse(text([samplePacket({ settle: { compliant_regex: "[", violated_regex: null } })]), "settle.compliant_regex"));
	it("N19: refuses an unknown status", () =>
		refuse(JSON.stringify(sampleFile([{ ...withHash(samplePacket()), calibration: { ...samplePacket().calibration, status: "block" } } as unknown as Packet])), "status"));
});

describe("packetHash", () => {
	it("P5: is stable across key order and ignores calibration and release", () => {
		const a = samplePacket();
		const reordered = { ...a, applies: Object.fromEntries(Object.entries(a.applies).reverse()) as Packet["applies"] };
		expect(packetHash(reordered)).toBe(packetHash(a));
		expect(packetHash(warnPacket())).toBe(packetHash(a));
		expect(packetHash(a)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("P6: changes when a criterion, a trigger or the evidence kind changes", () => {
		const a = samplePacket();
		const crit = samplePacket({ questions: { violated: { ...a.questions.violated, criteria: { true: "cat", false: "tail" } }, where: null } });
		const trig = samplePacket({ applies: { ...a.applies, command_regex: "x" } });
		const ev = samplePacket({ evidence: "file" });
		const settle = samplePacket({ settle: { compliant_regex: "tail", violated_regex: null } });
		const quote = samplePacket({ source: { ...a.source, quote: "reworded instruction" } });
		const hashes = new Set([packetHash(a), packetHash(crit), packetHash(trig), packetHash(ev), packetHash(settle), packetHash(quote)]);
		expect(hashes.size).toBe(6);
	});
});

describe("statusRank", () => {
	it("P7: orders shadow < score < warn < cosign", () => {
		expect(statusRank("shadow")).toBeLessThan(statusRank("score"));
		expect(statusRank("score")).toBeLessThan(statusRank("warn"));
		expect(statusRank("warn")).toBeLessThan(statusRank("cosign"));
	});
});
