import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig } from "../types.js";
import { startFallbackLines } from "./fallback-start.js";
import { sampleFile, warnPacket } from "./fixtures.js";
import type { Packet } from "./types.js";

const CLAUDE = "# rules\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TEXT = "Never full-read `collection.jsonl` …";
const released = (overrides: Partial<Packet> = {}): Packet => warnPacket({ release: { text: TEXT, released_at: "2026-11-05T20:00:00.000Z", span_hash: sha(TEXT) }, ...overrides });
const rules = (over: Partial<GuardRulesConfig> = {}): GuardRulesConfig =>
	({ jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["command"], paths: [] } }, ...over }) as GuardRulesConfig;

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-fallback-start-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), CLAUDE);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const write = (packets: Packet[], sources: Record<string, string> = { "CLAUDE.md": sha(CLAUDE) }) => writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), JSON.stringify(sampleFile(packets, { sources })));

describe("startFallbackLines — what SessionStart prints for released packets", () => {
	it("P1: with Jev disabled the released text appears (the §9 acceptance case)", () => {
		write([released()]);
		const lines = startFallbackLines(tmp, rules({ jev: { enabled: false } }), "claude", () => "k");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("(jev disabled)");
		expect(lines[0]).toContain(TEXT);
	});
	it("P2: a source changed since compile makes every released packet fall back", () => {
		write([released()], { "CLAUDE.md": sha("other") });
		expect(startFallbackLines(tmp, rules(), "claude", () => "k")[0]).toContain("instruction files changed since compile");
	});
	it("P3: no key resolves to a fallback", () => {
		write([released()]);
		expect(startFallbackLines(tmp, rules(), "claude", () => undefined)[0]).toContain("(no TypeSafe key)");
	});
	it("N1: a live released packet prints nothing; no packet file prints nothing; an unparseable file prints nothing", () => {
		write([released()]);
		expect(startFallbackLines(tmp, rules(), "claude", () => "k")).toEqual([]);
		rmSync(join(tmp, ".interlinked", "instruction-packets.json"));
		expect(startFallbackLines(tmp, rules(), "claude", () => "k")).toEqual([]);
		writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), "{");
		expect(startFallbackLines(tmp, rules({ jev: { enabled: false } }), "claude", () => "k")).toEqual([]);
	});
});
