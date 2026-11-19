import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactIfLarge, type DeliveryChannel, deliveredIds, FALLBACK_LEDGER, fallbackIdsIn, LEDGER_KEEP_BYTES, LEDGER_MAX_BYTES, recordVisibleFallback } from "./fallback-ledger.js";

const line = (id: string, text = "Prefer `rg`.") => `[interlinked:packet ${id}] not live here (daemon unreachable); instruction released from CLAUDE.md, verbatim:\n${text}`;
/** What a JSON-context adapter (Claude Code, Codex, Copilot, Gemini) prints: the lines escaped inside a JSON string. */
const jsonContext = (lines: string[]) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lines.join("\n") } });
const VISIBLE: DeliveryChannel = { modelVisible: true };
const INVISIBLE: DeliveryChannel = { modelVisible: false };

let dir: string;
const ledger = () => (existsSync(join(dir, FALLBACK_LEDGER)) ? readFileSync(join(dir, FALLBACK_LEDGER), "utf8").split("\n").filter(Boolean) : []);
const post = (session: string, lines: string[], stdout: string | undefined, channel = VISIBLE) => recordVisibleFallback(dir, { session_id: session, phase: "post-tool" }, lines, stdout, "cold", channel);
const start = (session: string, lines: string[], stdout: string | undefined, channel = VISIBLE) => recordVisibleFallback(dir, { session_id: session, phase: "session-start" }, lines, stdout, "daemon", channel);
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "packets-fallback-ledger-")), ".interlinked");
	mkdirSync(dir);
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("fallbackIdsIn", () => {
	it("P1: finds every fallback line's packet id in warnings, in order, once each", () => {
		expect(fallbackIdsIn(["[other] x", line("prefer-rg"), line("bounded-log-read"), line("prefer-rg")])).toEqual(["prefer-rg", "bounded-log-read"]);
	});
	it("N1: a delivered judgment warning or a quote of the pattern inside text is not a fallback line", () => {
		expect(fallbackIdsIn(["[interlinked:packet] [heuristic] prefer-rg p=0.91 ≥ τ 0.7", "see [interlinked:packet x] elsewhere"])).toEqual([]);
	});
});

describe("recordVisibleFallback — 'received' means the model got the whole line", () => {
	it("P2: a post-tool line present in the JSON context of a model-visible event is recorded, for that session only", () => {
		post("s1", [line("prefer-rg")], jsonContext([line("prefer-rg")]));
		expect([...deliveredIds(dir, "s1")]).toEqual(["prefer-rg"]);
		expect([...deliveredIds(dir, "s2")]).toEqual([]);
	});
	it("N2: a line that went to stderr only (stdout empty or without it) is NOT recorded — it will be proposed again", () => {
		post("s1", [line("prefer-rg")], undefined);
		post("s1", [line("prefer-rg")], JSON.stringify({ decision: "allow" }));
		expect(deliveredIds(dir, "s1").size).toBe(0);
		expect(ledger()).toEqual([]);
	});
	it("N3 (break R1, P1): stdout that carries the line on an event the model does NOT see (OpenCode/Pi bridge output) is not a receipt", () => {
		post("s1", [line("prefer-rg")], JSON.stringify({ decision: "allow", warnings: [line("prefer-rg")] }), INVISIBLE);
		expect(deliveredIds(dir, "s1").size).toBe(0);
	});
	it("N4 (break R1, P1): a line that ends past the runner's context limit (Codex 2,500) was cut, so it is not received", () => {
		const filler = `[other] ${"x".repeat(2_480)}`;
		const lines = [filler, line("late")];
		post("s1", lines, jsonContext(lines), { modelVisible: true, limit: 2_500 });
		expect(deliveredIds(dir, "s1").size).toBe(0);
		const first = [line("early"), filler];
		post("s1", first, jsonContext(first), { modelVisible: true, limit: 2_500 });
		expect([...deliveredIds(dir, "s1")]).toEqual(["early"]);
	});
	it("P3: the adapter's context prefix counts toward the limit", () => {
		post("s1", [line("x")], jsonContext([line("x")]), { modelVisible: true, limit: 2_500, prefix: 2_450 });
		expect(deliveredIds(dir, "s1").size).toBe(0);
	});
	it("P4: a SessionStart resets the session's set (fresh context) and records what it carried", () => {
		post("s1", [line("a"), line("b")], jsonContext([line("a"), line("b")]));
		start("s1", [line("c")], jsonContext([line("c")]));
		expect([...deliveredIds(dir, "s1")]).toEqual(["c"]);
	});
	it("P5: a SessionStart the model does not see still resets — and records nothing as received", () => {
		post("s1", [line("a")], jsonContext([line("a")]));
		start("s1", [line("a")], jsonContext([line("a")]), INVISIBLE);
		expect(deliveredIds(dir, "s1").size).toBe(0);
	});
	it("N5: a SessionStart with no fallback line writes nothing when the ledger does not exist yet", () => {
		start("s1", ["[other] x"], jsonContext(["[other] x"]));
		expect(existsSync(join(dir, FALLBACK_LEDGER))).toBe(false);
	});
	it("P6: a plain-text channel (stdout carrying the raw line) counts too", () => {
		post("s1", [line("x")], `${line("x")}\n`);
		expect([...deliveredIds(dir, "s1")]).toEqual(["x"]);
	});
	it("N6 (break R1, P3): the placeholder session id `unknown` is shared by every session without one — never recorded or read", () => {
		post("unknown", [line("x")], jsonContext([line("x")]));
		expect(ledger()).toEqual([]);
		expect(deliveredIds(dir, "unknown").size).toBe(0);
	});
	it("N7: non-string warnings and a missing .interlinked directory never throw", () => {
		expect(() => recordVisibleFallback(dir, { session_id: "s", phase: "post-tool" }, [42, null, line("x")], jsonContext([line("x")]), "cold", VISIBLE)).not.toThrow();
		expect(() => recordVisibleFallback(join(dir, "nope"), { session_id: "s", phase: "post-tool" }, [line("x")], jsonContext([line("x")]), "cold", VISIBLE)).not.toThrow();
	});
});

describe("deliveredIds — bounded, torn-line tolerant read", () => {
	it("P7: torn and foreign lines are skipped", () => {
		writeFileSync(join(dir, FALLBACK_LEDGER), `{"ts":"t","session_id":"s1","kind":"delivered","packets":["a"],"via":"cold"}\n{torn\n42\n{"session_id":"s1","kind":"delivered","packets":"not-a-list"}\n`);
		expect([...deliveredIds(dir, "s1")]).toEqual(["a"]);
	});
	it("P8: only the newest part of a large ledger is read; a session's recent rows are still found", () => {
		const filler = `${JSON.stringify({ ts: "t", session_id: "old", kind: "delivered", packets: ["z"], via: "cold" })}\n`.repeat(12_000);
		writeFileSync(join(dir, FALLBACK_LEDGER), filler);
		appendFileSync(join(dir, FALLBACK_LEDGER), `${JSON.stringify({ ts: "t", session_id: "s1", kind: "delivered", packets: ["a"], via: "cold" })}\n`);
		expect([...deliveredIds(dir, "s1")]).toEqual(["a"]);
	});
	it("P7b (R6 P2): a receipt written after a torn last line (no trailing newline) starts on its own line and is read", () => {
		writeFileSync(join(dir, FALLBACK_LEDGER), `{"ts":"t","session_id":"s0","kind":"deliv`);
		post("s1", [line("prefer-rg")], jsonContext([line("prefer-rg")]));
		expect([...deliveredIds(dir, "s1")]).toEqual(["prefer-rg"]);
	});
	it("N8: no ledger, no session id → empty", () => {
		expect(deliveredIds(dir, "s1").size).toBe(0);
		expect(deliveredIds(dir, "").size).toBe(0);
	});
});

describe("ledger compaction — bounded on disk (seventh review, R3 P3)", () => {
	const row = (session: string, id: string) => `${JSON.stringify({ ts: "t", session_id: session, kind: "delivered", packets: [id], via: "cold" })}\n`;
	it("P9: a write that takes the ledger past LEDGER_MAX_BYTES rewrites it to its newest LEDGER_KEEP_BYTES, whole lines only, and keeps the recent sessions' receipts", () => {
		const filler = row("old", "z");
		writeFileSync(join(dir, FALLBACK_LEDGER), filler.repeat(Math.ceil(LEDGER_MAX_BYTES / filler.length)));
		appendFileSync(join(dir, FALLBACK_LEDGER), row("recent", "a"));
		post("s1", [line("prefer-rg")], jsonContext([line("prefer-rg")]));
		const size = statSync(join(dir, FALLBACK_LEDGER)).size;
		expect(size).toBeLessThanOrEqual(LEDGER_KEEP_BYTES + filler.length);
		for (const l of ledger()) expect(() => JSON.parse(l)).not.toThrow();
		expect([...deliveredIds(dir, "s1")]).toEqual(["prefer-rg"]);
		expect([...deliveredIds(dir, "recent")]).toEqual(["a"]);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
	it("P10 (R6 P3): a receipt another hook appends between the tail read and the rename survives the compaction", () => {
		const path = join(dir, FALLBACK_LEDGER);
		const filler = row("old", "z");
		writeFileSync(path, filler.repeat(Math.ceil(LEDGER_MAX_BYTES / filler.length) + 1));
		compactIfLarge(path, () => appendFileSync(path, `${row("racer", "b")}{"partial`));
		expect([...deliveredIds(dir, "racer")]).toEqual(["b"]);
		for (const l of ledger()) expect(() => JSON.parse(l)).not.toThrow();
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
	it("P11 (R6 P3): a torn multibyte last row that its writer finishes during compaction stays one whole row", () => {
		const path = join(dir, FALLBACK_LEDGER);
		const filler = row("old", "z");
		const torn = Buffer.from(row("torn-é", "c"));
		const cut = torn.indexOf(Buffer.from("é")) + 1;
		writeFileSync(path, Buffer.concat([Buffer.from(filler.repeat(Math.ceil(LEDGER_MAX_BYTES / filler.length) + 1)), torn.subarray(0, cut)]));
		compactIfLarge(path, () => appendFileSync(path, torn.subarray(cut)));
		expect([...deliveredIds(dir, "torn-é")]).toEqual(["c"]);
		for (const l of ledger()) expect(() => JSON.parse(l)).not.toThrow();
	});
	it("N9: a ledger at or under LEDGER_MAX_BYTES is only appended to, never rewritten", () => {
		writeFileSync(join(dir, FALLBACK_LEDGER), row("old", "z").repeat(100));
		const before = readFileSync(join(dir, FALLBACK_LEDGER), "utf8");
		post("s1", [line("prefer-rg")], jsonContext([line("prefer-rg")]));
		expect(readFileSync(join(dir, FALLBACK_LEDGER), "utf8").startsWith(before)).toBe(true);
	});
});
