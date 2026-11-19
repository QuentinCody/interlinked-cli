import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compilePacketFile } from "./compile.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { packetHash, parsePacketFile } from "./schema.js";

const NOW = "2026-11-05T18:00:00.000Z";
const SOURCES: Record<string, string> = { "CLAUDE.md": "# rules\nNever full-read the big logs.\n" };
const readSource = (file: string) => SOURCES[file] ?? null;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A draft as the /enforce agent writes it: no hashes, no calibration, no release. */
function draft(packets: unknown[] = [draftPacket()], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ version: 1, compiler: { model: "draft-model", skill: "enforce@4" }, sources: ["CLAUDE.md"], packets, skipped: [], ...extra });
}
function draftPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const p = samplePacket();
	return { id: p.id, kind: p.kind, source: p.source, strength: p.strength, applies: p.applies, evidence: p.evidence, questions: p.questions, ...overrides };
}

describe("compilePacketFile — positive (must compile)", () => {
	it("P1: a bare draft becomes a strict file with hashes, shadow calibration and source digests", () => {
		const r = compilePacketFile(draft(), null, { now: NOW, readSource });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.file.compiled_at).toBe(NOW);
		expect(r.file.sources).toEqual({ "CLAUDE.md": sha(SOURCES["CLAUDE.md"]!) });
		const p = r.file.packets[0]!;
		expect(p.packet_hash).toBe(packetHash(samplePacket()));
		expect(p.calibration.status).toBe("shadow");
		expect(p.release).toBeNull();
		expect(parsePacketFile(JSON.stringify(r.file)).ok).toBe(true);
	});

	it("P2: an unchanged packet keeps the existing calibration (a recompile does not demote)", () => {
		const existing = JSON.stringify(sampleFile([warnPacket()]));
		const r = compilePacketFile(draft(), existing, { now: NOW, readSource });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.file.packets[0]?.calibration.status).toBe("warn");
	});

	it("P3: a packet whose question changed is reset to shadow with a note", () => {
		const existing = JSON.stringify(sampleFile([warnPacket()]));
		const changed = draftPacket({ questions: { ...samplePacket().questions, violated: { ...samplePacket().questions.violated, instructions: "reworded" } } });
		const r = compilePacketFile(draft([changed]), existing, { now: NOW, readSource });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.file.packets[0]?.calibration.status).toBe("shadow");
		expect(r.notes.join("\n")).toContain("bounded-log-read");
	});

	it("P4: a draft may give calibration or release, and they are ignored (every packet starts at shadow)", () => {
		const r = compilePacketFile(draft([draftPacket({ calibration: { status: "cosign" }, release: { text: "x" } })]), null, { now: NOW, readSource });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.file.packets[0]?.calibration.status).toBe("shadow");
	});
});

describe("compilePacketFile — negative (must refuse)", () => {
	const refuse = (text: string, existing: string | null, needle: string) => {
		const r = compilePacketFile(text, existing, { now: NOW, readSource });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain(needle);
	};
	it("N1: a draft that is not JSON", () => refuse("{", null, "JSON"));
	it("N2: a draft naming a source file that cannot be read", () => refuse(draft([], { sources: ["MISSING.md"] }), null, "MISSING.md"));
	it("N3: a draft packet the strict parser refuses (bad regex)", () =>
		refuse(draft([draftPacket({ applies: { ...samplePacket().applies, command_regex: "(" } })]), null, "command_regex"));
	it("N4: an existing file that does not parse (the compiler never silently drops calibration)", () =>
		refuse(draft(), "{broken", "existing"));
	it("N5b (audit C5): moving a RELEASED packet to another instruction file is refused — same hash, but the release names the old file", () => {
		const released = warnPacket({ release: { text: "Never …", released_at: NOW, span_hash: "c".repeat(64) } });
		const existing = JSON.stringify(sampleFile([released]));
		const moved = draftPacket({ source: { ...samplePacket().source, file: "AGENTS.md" } });
		const r = compilePacketFile(draft([moved], { sources: ["CLAUDE.md", "AGENTS.md"] }), existing, { now: NOW, readSource: (f) => (f === "AGENTS.md" ? "# agents\n" : readSource(f)) });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("run `interlinked packets restore CLAUDE.md` first");
	});
	it("N5: changing a RELEASED packet is refused until its text is restored", () => {
		const released = warnPacket({ release: { text: "Never …", released_at: NOW, span_hash: "c".repeat(64) } });
		const existing = JSON.stringify(sampleFile([released]));
		const changed = draftPacket({ applies: { ...samplePacket().applies, command_regex: "activity" } });
		refuse(draft([changed]), existing, "released");
	});
	it("N6: dropping a RELEASED packet is refused for the same reason", () => {
		const released = warnPacket({ release: { text: "Never …", released_at: NOW, span_hash: "c".repeat(64) } });
		refuse(draft([]), JSON.stringify(sampleFile([released])), "released");
	});
	it("N7: duplicate ids in the draft", () => refuse(draft([draftPacket(), draftPacket()]), null, "unique"));
});
