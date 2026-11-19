import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PacketJudgmentRow } from "./evaluator.js";
import { recordVisibleFallback } from "./fallback-ledger.js";
import { sampleFile, warnPacket } from "./fixtures.js";
import { nonLiveReason, outageFallbackLines, SLOW_JEV_REASON } from "./outage-fallback.js";

const TEXT = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const row = (over: Partial<PacketJudgmentRow>): PacketJudgmentRow => ({ gate: null, status: "warn", status_effective: "warn", model: "jev-1.14.0", ...over }) as PacketJudgmentRow;

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-outage-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const writePackets = (text: string) => writeFileSync(join(tmp, ".interlinked", "instruction-packets.json"), text);
const releasedFile = (ids: string[]) =>
	JSON.stringify(sampleFile(ids.map((id) => warnPacket({ id, release: { text: TEXT, released_at: "2026-11-05T20:00:00.000Z", span_hash: sha(TEXT) } }))));

describe("nonLiveReason — why released packets are not live right now", () => {
	it("P1: a failed ask in these rows wins; else the daemon's runtime reason; else a judgment forced to shadow by a binding mismatch", () => {
		expect(nonLiveReason([row({ gate: "ask_failed" })], "spend cap reached this daemon run")).toBe("Jev unreachable");
		expect(nonLiveReason([row({})], "spend cap reached this daemon run")).toBe("spend cap reached this daemon run");
		expect(nonLiveReason([row({ status_effective: "shadow", model: "jev-2.0.0" })], null)).toBe("judged at shadow: calibration binding does not match this evaluator (model jev-2.0.0)");
	});
	it("N1: live rows and shadow packets judged at shadow give no reason", () => {
		expect(nonLiveReason([row({}), row({ status: "shadow", status_effective: "shadow" })], null)).toBeNull();
		expect(nonLiveReason([], null)).toBeNull();
	});
});

describe("outageFallbackLines — every release, minus what this session already received", () => {
	it("P2: all released packets get the reason; one the hook recorded as received is skipped", () => {
		writePackets(releasedFile(["a", "b"]));
		const header = (id: string) => `[interlinked:packet ${id}] not live here (${SLOW_JEV_REASON}); instruction released from CLAUDE.md, verbatim:`;
		const first = outageFallbackLines(tmp, "s1", SLOW_JEV_REASON);
		expect(first.map((l) => l.split("\n")[0])).toEqual([header("a"), header("b")]);
		recordVisibleFallback(join(tmp, ".interlinked"), { session_id: "s1", phase: "post-tool" }, [first[0] as string], JSON.stringify({ additionalContext: first[0] }), "daemon", { modelVisible: true });
		expect(outageFallbackLines(tmp, "s1", SLOW_JEV_REASON).map((l) => l.split("\n")[0])).toEqual([header("b")]);
		expect(outageFallbackLines(tmp, "s2", SLOW_JEV_REASON)).toHaveLength(2);
	});
	it("P3: a packet file the strict parser refuses still yields its verified releases", () => {
		const parsed = JSON.parse(releasedFile(["a"])) as Record<string, unknown>;
		writePackets(JSON.stringify({ ...parsed, a_field_from_a_newer_cli: true }));
		const lines = outageFallbackLines(tmp, "s1", "Jev unreachable");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("the packet file does not parse");
		expect(lines[0]).toContain(TEXT);
	});
	it("N2: no packet file, or a file that is not JSON, yields nothing and never throws", () => {
		expect(outageFallbackLines(tmp, "s1", "x")).toEqual([]);
		writePackets("{torn");
		expect(outageFallbackLines(tmp, "s1", "x")).toEqual([]);
	});
});
