import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { packetBudget, type Pass1Rule, renderBudget } from "./budget.js";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { pointerLine, releaseEdit } from "./release.js";
import type { Packet } from "./types.js";

const LIVE_QUOTE = "Prefer `rg` when searching the sample project for test fixtures under the examples directory.";
const SHADOW_QUOTE = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).";
const RELEASED_TEXT = "Keep cwd at the repo root; a stray `.interlinked/` below it cold-allows every call made from there.";
const CLAUDE = ["# rules", "", `- ${SHADOW_QUOTE}`, `- ${LIVE_QUOTE}`, `- ${pointerLine("cwd-root", "CLAUDE.md")}`, "- Quote every glob.", ""].join("\n");
const AGENTS = "- Fire rate measures the AGENT, not the check.\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const read = (f: string) => (f === "CLAUDE.md" ? CLAUDE : f === "AGENTS.md" ? AGENTS : null);
const fresh = { "CLAUDE.md": sha(CLAUDE), "AGENTS.md": sha(AGENTS) };

const shadow = samplePacket({ id: "bounded-log-read", source: { file: "CLAUDE.md", span: null, quote: SHADOW_QUOTE } });
const live = warnPacket({ id: "prefer-rg", source: { file: "CLAUDE.md", span: null, quote: LIVE_QUOTE } });
const released = (overrides: Partial<Packet> = {}): Packet =>
	warnPacket({ id: "cwd-root", source: { file: "CLAUDE.md", span: null, quote: RELEASED_TEXT }, release: { text: RELEASED_TEXT, released_at: "2026-11-05T20:00:00.000Z", span_hash: sha(RELEASED_TEXT) }, ...overrides });
const pass1: Pass1Rule[] = [{ id: "enforce-claude-quote-globs", file: "CLAUDE.md", quote: "Quote every glob." }, { id: "enforce-agents-fire-rate", file: "AGENTS.md", quote: "Fire rate measures the AGENT, not the check." }];
const net = (id: string, text: string) => text.length - pointerLine(id, "CLAUDE.md").length;

describe("packetBudget — per source file, what holds the tokens", () => {
	it("P1: one row per source file; pass-1, live, released, shadow are counted; releasable is EXACTLY what the release would remove", () => {
		const file = sampleFile([shadow, live, released()], { sources: fresh });
		const rows = packetBudget(file, pass1, read);
		expect(rows.map((r) => r.file)).toEqual(["AGENTS.md", "CLAUDE.md"]);
		const claude = rows[1];
		expect(claude).toMatchObject({
			file: "CLAUDE.md",
			global: false,
			chars: CLAUDE.length,
			tokens: Math.round(CLAUDE.length / 4),
			pass1: { rules: 1, chars: "Quote every glob.".length },
			live: { packets: 1, chars: LIVE_QUOTE.length },
			released: { packets: 1, chars: net("cwd-root", RELEASED_TEXT) },
			released_fallback: { packets: 0, chars: 0 },
			shadow: { packets: 1, chars: SHADOW_QUOTE.length },
			releasable_packets: 1,
			releasable_blocked: null,
			unlocated: [],
		});
		const edit = releaseEdit(file, "CLAUDE.md", CLAUDE, "now");
		if (!edit.ok) throw new Error(edit.error);
		expect(claude?.releasable_chars).toBe(CLAUDE.length - edit.source.length);
	});
	it("P2: a released packet that is no longer live (demoted) is re-injected by the fallback: no saving, counted apart", () => {
		const file = sampleFile([released({ calibration: samplePacket().calibration })], { sources: fresh });
		const row = packetBudget(file, [], read).find((r) => r.file === "CLAUDE.md");
		expect(row?.released).toEqual({ packets: 0, chars: 0 });
		expect(row?.released_fallback).toEqual({ packets: 1, chars: RELEASED_TEXT.length });
	});
	it("P3: a release whose pointer is not in the file (interrupted) saves nothing either", () => {
		const withoutPointer = CLAUDE.replace(pointerLine("cwd-root", "CLAUDE.md"), RELEASED_TEXT);
		const file = sampleFile([released()], { sources: { "CLAUDE.md": sha(withoutPointer) } });
		const row = packetBudget(file, [], () => withoutPointer)[0];
		expect(row?.released).toEqual({ packets: 0, chars: 0 });
		expect(row?.released_fallback.packets).toBe(1);
	});
	it("P4: `notLive` (from the fallback oracle) overrides the status proxy for released packets", () => {
		const file = sampleFile([released()], { sources: fresh });
		const row = packetBudget(file, [], read, { notLive: new Set(["cwd-root"]) }).find((r) => r.file === "CLAUDE.md");
		expect(row?.released.packets).toBe(0);
		expect(row?.released_fallback.packets).toBe(1);
	});
	it("P5: a quote the file no longer holds is listed as unlocated and adds no characters", () => {
		const lost = warnPacket({ id: "lost", source: { file: "AGENTS.md", span: null, quote: "not in the file" } });
		const row = packetBudget(sampleFile([lost], { sources: { "AGENTS.md": sha(AGENTS) } }), [], read)[0];
		expect(row?.unlocated).toEqual(["lost"]);
		expect(row?.live).toEqual({ packets: 1, chars: 0 });
	});
	it("P6: an unreadable source gets a row with zero size and is not releasable", () => {
		const file = sampleFile([samplePacket({ source: { file: "GONE.md", span: null, quote: "x" } })], { sources: { "GONE.md": sha("") } });
		expect(packetBudget(file, [], read)[0]).toMatchObject({ file: "GONE.md", chars: 0, tokens: 0, readable: false, releasable_chars: 0, unlocated: ["bounded-log-read"] });
	});
	it("P7: a pass-1 rule from a file no packet names gets its own row", () => {
		const rows = packetBudget(sampleFile([], { sources: {} }), [{ id: "r", file: "AGENTS.md", quote: "Fire rate measures the AGENT, not the check." }], read);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ file: "AGENTS.md", pass1: { rules: 1, chars: "Fire rate measures the AGENT, not the check.".length } });
	});
});

describe("releasable is all-or-nothing, like the release (audit D, B1/B3)", () => {
	it("N1: one ambiguous quote makes the release refuse the whole file — releasable is 0 and the reason is shown", () => {
		const twice = `${CLAUDE}- ${LIVE_QUOTE}\n`;
		const file = sampleFile([live], { sources: { "CLAUDE.md": sha(twice) } });
		const row = packetBudget(file, [], () => twice)[0];
		expect(row?.releasable_chars).toBe(0);
		expect(row?.releasable_blocked).toMatch(/occurs 2 times/);
	});
	it("N2: two packets quoting the same text are not counted twice", () => {
		const file = sampleFile([live, warnPacket({ id: "prefer-rg-2", source: { file: "CLAUDE.md", span: null, quote: LIVE_QUOTE } })], { sources: fresh });
		const row = packetBudget(file, [], read).find((r) => r.file === "CLAUDE.md");
		expect(row?.releasable_chars).toBe(0);
		expect(row?.releasable_blocked).toMatch(/overlaps/);
	});
	it("N3: a stale set (any instruction file changed since compile) is not releasable anywhere", () => {
		const file = sampleFile([live], { sources: { "CLAUDE.md": sha(CLAUDE), "AGENTS.md": sha("old") } });
		const row = packetBudget(file, [], read).find((r) => r.file === "CLAUDE.md");
		expect(row?.releasable_chars).toBe(0);
		expect(row?.releasable_blocked).toMatch(/AGENTS\.md changed since compile/);
	});
	it("N4: a global (`~/`) source is budgeted but never releasable", () => {
		const globalName = "~/.claude/CLAUDE.md";
		const file = sampleFile([warnPacket({ id: "g", source: { file: globalName, span: null, quote: LIVE_QUOTE } })], { sources: { [globalName]: sha(CLAUDE) } });
		const row = packetBudget(file, [], () => CLAUDE)[0];
		expect(row).toMatchObject({ file: globalName, global: true, releasable_chars: 0, live: { packets: 1, chars: LIVE_QUOTE.length } });
		expect(row?.releasable_blocked).toMatch(/global/);
	});
	it("N5: a short span that would ADD bytes is not releasable; nothing to release is not an error", () => {
		const short = warnPacket({ id: "quote-globs", source: { file: "CLAUDE.md", span: null, quote: "Quote every glob." } });
		const row = packetBudget(sampleFile([short], { sources: fresh }), [], read).find((r) => r.file === "CLAUDE.md");
		expect(row?.releasable_chars).toBe(0);
		expect(row?.releasable_blocked).toMatch(/not longer than its pointer/);
		const none = packetBudget(sampleFile([shadow], { sources: fresh }), [], read).find((r) => r.file === "CLAUDE.md");
		expect(none?.releasable_blocked).toBeNull();
	});
});

describe("renderBudget", () => {
	it("P8: one header, one block per file, totals last; totals are the sums of the rows", () => {
		const file = sampleFile([shadow, live, released()], { sources: fresh });
		const rows = packetBudget(file, pass1, read);
		const text = renderBudget(rows);
		expect(text.split("\n")[0]).toMatch(/tokens ≈ chars \/ 4/);
		expect(text).toMatch(/releasable now: 1 packet\(s\), \d+ chars net/);
		expect(text).toMatch(/enforced in shadow, still in context: 1 packet/);
		expect(text).toMatch(/released already: 1 packet\(s\), \d+ chars net out of context/);
		const tokenSum = rows.reduce((n, r) => n + r.tokens, 0);
		expect(text.split("\n").at(-1)).toContain(`≈ ${tokenSum} tokens`);
	});
	it("P9: a blocked file names the reason; a global file says so", () => {
		const globalName = "~/.claude/CLAUDE.md";
		const file = sampleFile([warnPacket({ id: "g", source: { file: globalName, span: null, quote: LIVE_QUOTE } })], { sources: { [globalName]: sha(CLAUDE) } });
		const text = renderBudget(packetBudget(file, [], () => CLAUDE));
		expect(text).toContain("~/.claude/CLAUDE.md (global: budget only, never released from a repo)");
		expect(text).toMatch(/releasable now: none — /);
	});
});
