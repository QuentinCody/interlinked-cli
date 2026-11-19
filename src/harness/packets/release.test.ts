import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sampleFile, samplePacket, warnPacket } from "./fixtures.js";
import { locateQuote, MAX_RELEASE_CHARS, pointerLine, releaseEdit, restoreEdit } from "./release.js";

const SOURCE = ["# rules", "", "- Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).", "- Prefer `rg` when searching the sample project", "  for test fixtures under the examples directory.", "- Keep cwd at the repo root.", ""].join("\n");
const Q1 = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).";
const Q2_WRAPPED = "Prefer `rg` when searching the sample project\n  for test fixtures under the examples directory.";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NOW = "2026-11-05T20:00:00.000Z";

describe("locateQuote", () => {
	it("P1: an exact substring is found once with 1-based lines", () => {
		const hit = locateQuote(SOURCE, "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).");
		expect(hit).toEqual({ ok: true, start: 11, end: 11 + Q1.length, lines: [3, 3] });
		expect(SOURCE.slice(11, 11 + Q1.length)).toBe(Q1);
	});
	it("P2: a quote wrapped differently in the source matches through whitespace folding and covers the real bytes", () => {
		const hit = locateQuote(SOURCE, "Prefer `rg` when searching the sample project for test fixtures under the examples directory.");
		expect(hit.ok).toBe(true);
		if (!hit.ok) return;
		expect(SOURCE.slice(hit.start, hit.end)).toBe(Q2_WRAPPED);
		expect(hit.lines).toEqual([4, 5]);
	});
	it("P2b: markdown emphasis in the source is folded out, and the located span grows to cover its markers", () => {
		const md = "- **Prefer `rg`** when searching\n  the sample project.\n- __Never ever__ push.\n";
		const hit = locateQuote(md, "Prefer `rg` when searching the sample project.");
		expect(hit.ok).toBe(true);
		if (!hit.ok) return;
		expect(md.slice(hit.start, hit.end)).toBe("**Prefer `rg`** when searching\n  the sample project.");
		const hit2 = locateQuote(md, "Never ever push.");
		expect(hit2.ok && md.slice(hit2.start, hit2.end)).toBe("__Never ever__ push.");
		// A ONE-word underscore pair stays content (it is likelier an identifier like `__init__`): fail closed.
		expect(locateQuote("- __Never__ push.\n", "Never push.")).toEqual({ ok: false, error: "quote not found in the source" });
	});
	it("N1: a quote that occurs twice is refused as ambiguous", () => {
		expect(locateQuote("a b\na b\n", "a b")).toEqual({ ok: false, error: "quote occurs 2 times; a release needs exactly one" });
	});
	it("N2: a quote absent from the source is refused", () => {
		expect(locateQuote(SOURCE, "no such text")).toEqual({ ok: false, error: "quote not found in the source" });
	});
	it("N3: an empty quote is refused", () => {
		expect(locateQuote(SOURCE, "   ")).toEqual({ ok: false, error: "quote is empty" });
	});
});

describe("releaseEdit", () => {
	const live = warnPacket({ id: "bounded-log-read", source: { file: "CLAUDE.md", span: null, quote: "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB)." } });
	const live2 = warnPacket({ id: "prefer-rg", source: { file: "CLAUDE.md", span: null, quote: "Prefer `rg` when searching the sample project for test fixtures under the examples directory." } });

	it("P3: a live unreleased packet's span becomes one pointer line, the text is kept verbatim, both hashes are recomputed", () => {
		const out = releaseEdit(sampleFile([live, live2]), "CLAUDE.md", SOURCE, NOW);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.released).toEqual(["bounded-log-read", "prefer-rg"]);
		expect(out.source).toBe(["# rules", "", `- ${pointerLine("bounded-log-read", "CLAUDE.md")}`, `- ${pointerLine("prefer-rg", "CLAUDE.md")}`, "- Keep cwd at the repo root.", ""].join("\n"));
		const p = out.file.packets[0];
		expect(p?.release).toEqual({ text: "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).", released_at: NOW, span_hash: sha("Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB).") });
		expect(out.file.packets[1]?.release?.text).toBe(Q2_WRAPPED);
		expect(out.file.sources["CLAUDE.md"]).toBe(sha(out.source));
		expect(p?.packet_hash).toBe(live.packet_hash);
	});
	it("P4: `only` restricts the release to the named packets; the rest stay in the source", () => {
		const out = releaseEdit(sampleFile([live, live2]), "CLAUDE.md", SOURCE, NOW, ["prefer-rg"]);
		expect(out.ok && out.released).toEqual(["prefer-rg"]);
		expect(out.ok && out.source).toContain("Never full-read");
		expect(out.ok && out.file.packets[0]?.release).toBeNull();
	});
	it("N4: a shadow packet is never released; with nothing live the edit is refused", () => {
		const out = releaseEdit(sampleFile([samplePacket()]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: "no packet to release in CLAUDE.md: bounded-log-read is at shadow (release needs warn or cosign)" });
	});
	it("N5: an already released packet is skipped, and a packet of another file is not touched", () => {
		const released = warnPacket({ id: "x", release: { text: "t", released_at: NOW, span_hash: sha("t") } });
		const other = warnPacket({ id: "y", source: { file: "AGENTS.md", span: null, quote: "Keep cwd at the repo root." } });
		const out = releaseEdit(sampleFile([released, other]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: "no packet to release in CLAUDE.md: x already released" });
	});
	it("N6: a quote the source does not hold refuses the whole edit (nothing partial)", () => {
		const missing = warnPacket({ id: "gone", source: { file: "CLAUDE.md", span: null, quote: "not here" } });
		const out = releaseEdit(sampleFile([live, missing]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: "gone: quote not found in the source" });
	});
	it("N7: overlapping spans refuse the edit", () => {
		const outer = warnPacket({ id: "outer", source: { file: "CLAUDE.md", span: null, quote: "Prefer `rg` when searching the sample project for test fixtures under the examples directory." } });
		const inner = warnPacket({ id: "inner", source: { file: "CLAUDE.md", span: null, quote: "the sample project for test fixtures under the examples directory." } });
		const out = releaseEdit(sampleFile([outer, inner]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: "inner overlaps outer in CLAUDE.md; release one of them" });
	});
	it("N8: the pointer text already present in the source is refused (a restore would be ambiguous)", () => {
		const text = `${SOURCE}${pointerLine("bounded-log-read", "CLAUDE.md")}\n`;
		expect(releaseEdit(sampleFile([live]), "CLAUDE.md", text, NOW)).toEqual({ ok: false, error: "bounded-log-read: the source already holds this packet's pointer line" });
	});
});

describe("restoreEdit — release then restore is byte-identical", () => {
	const live = warnPacket({ id: "bounded-log-read", source: { file: "CLAUDE.md", span: null, quote: "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB)." } });
	const live2 = warnPacket({ id: "prefer-rg", source: { file: "CLAUDE.md", span: null, quote: "Prefer `rg` when searching the sample project for test fixtures under the examples directory." } });

	it("P5: the round trip returns the exact source bytes and clears release; sources[file] follows", () => {
		const rel = releaseEdit(sampleFile([live, live2]), "CLAUDE.md", SOURCE, NOW);
		expect(rel.ok).toBe(true);
		if (!rel.ok) return;
		const back = restoreEdit(rel.file, "CLAUDE.md", rel.source);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.source).toBe(SOURCE);
		expect(back.restored).toEqual(["bounded-log-read", "prefer-rg"]);
		expect(back.file.packets.every((p) => p.release === null)).toBe(true);
		expect(back.file.sources["CLAUDE.md"]).toBe(sha(SOURCE));
	});
	it("P6: a demoted packet (shadow) that still carries a release restores the same way", () => {
		const rel = releaseEdit(sampleFile([live]), "CLAUDE.md", SOURCE, NOW);
		if (!rel.ok) throw new Error(rel.error);
		const demoted = { ...rel.file, packets: rel.file.packets.map((p) => ({ ...p, calibration: { ...p.calibration, status: "shadow" as const, bound_to: null, tau: null } })) };
		const back = restoreEdit(demoted, "CLAUDE.md", rel.source);
		expect(back.ok && back.source).toBe(SOURCE);
	});
	it("N9: a released text whose hash no longer matches its span_hash is refused (the fallback must stay verbatim)", () => {
		const rel = releaseEdit(sampleFile([live]), "CLAUDE.md", SOURCE, NOW);
		if (!rel.ok) throw new Error(rel.error);
		const tampered = { ...rel.file, packets: rel.file.packets.map((p) => ({ ...p, release: p.release ? { ...p.release, text: "edited" } : null })) };
		expect(restoreEdit(tampered, "CLAUDE.md", rel.source)).toEqual({ ok: false, error: "bounded-log-read: release.text does not match span_hash; the file was edited by hand" });
	});
	it("N10: a pointer line missing while the words are ALSO gone is refused; nothing released in the file is refused too", () => {
		const rel = releaseEdit(sampleFile([live]), "CLAUDE.md", SOURCE, NOW);
		if (!rel.ok) throw new Error(rel.error);
		const neither = rel.source.replace(pointerLine("bounded-log-read", "CLAUDE.md"), "something else");
		expect(restoreEdit(rel.file, "CLAUDE.md", neither)).toEqual({ ok: false, error: "bounded-log-read: pointer line not found in CLAUDE.md (expected exactly one)" });
		expect(restoreEdit(sampleFile([live]), "CLAUDE.md", SOURCE)).toEqual({ ok: false, error: "no released packet in CLAUDE.md" });
	});
	it("P7 (R37): an interrupted release — packet file written, source untouched — restores by clearing the release only", () => {
		const rel = releaseEdit(sampleFile([live]), "CLAUDE.md", SOURCE, NOW);
		if (!rel.ok) throw new Error(rel.error);
		// The packet file carries the release and the hash of the pointer file; the source still holds the words.
		const back = restoreEdit(rel.file, "CLAUDE.md", SOURCE);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.source).toBe(SOURCE);
		expect(back.restored).toEqual(["bounded-log-read"]);
		expect(back.file.packets[0]?.release).toBeNull();
	});
	it("P8 (R42): restoring on a set that was already stale keeps it stale — an unrelated hand change is not re-validated", () => {
		const other = warnPacket({ id: "other", source: { file: "CLAUDE.md", span: null, quote: "Keep cwd at the repo root." } });
		const rel = releaseEdit(sampleFile([live, other]), "CLAUDE.md", SOURCE, NOW, ["bounded-log-read"]);
		if (!rel.ok) throw new Error(rel.error);
		const handEdited = rel.source.replace("Keep cwd at the repo root.", "Never keep cwd at the repo root.");
		const back = restoreEdit(rel.file, "CLAUDE.md", handEdited);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.source).toContain("Never full-read");
		expect(back.file.sources["CLAUDE.md"]).toBe(rel.file.sources["CLAUDE.md"]);
		expect(back.file.sources["CLAUDE.md"]).not.toBe(sha(back.source));
	});
});

describe("release refusals from the sixth review", () => {
	it("N11 (R38): a global instruction file (`~/`) is never released", () => {
		const global = warnPacket({ id: "g", source: { file: "~/.claude/CLAUDE.md", span: null, quote: "Keep cwd at the repo root." } });
		const out = releaseEdit(sampleFile([global]), "~/.claude/CLAUDE.md", SOURCE, NOW);
		expect(out.ok).toBe(false);
		expect(!out.ok && out.error).toMatch(/global instruction file loaded by every project/);
	});
	it("N12 (R45): a span not longer than its pointer is refused — a release must take bytes OUT of the context", () => {
		const short = warnPacket({ id: "quote-globs", source: { file: "CLAUDE.md", span: null, quote: "Keep cwd at the repo root." } });
		const out = releaseEdit(sampleFile([short]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: `no packet to release in CLAUDE.md: quote-globs span (26 chars) is not longer than its pointer (${pointerLine("quote-globs", "CLAUDE.md").length} chars); nothing to gain` });
	});
	it("N14 (break R1, Codex 2,500-char context): a span longer than MAX_RELEASE_CHARS is refused — its fallback could arrive cut", () => {
		const long = `Never ${"do this ".repeat(Math.ceil(MAX_RELEASE_CHARS / 8))}ever.`;
		const big = warnPacket({ id: "big", source: { file: "CLAUDE.md", span: null, quote: long } });
		const out = releaseEdit(sampleFile([big]), "CLAUDE.md", `# rules\n\n- ${long}\n`, NOW);
		expect(out.ok).toBe(false);
		expect(!out.ok && out.error).toMatch(/is longer than \d+: a runner that keeps only the head/);
	});
	it("N15 (audit D1): a quote that differs from a rule only in significant `*`/`_` locates nothing (fails closed)", () => {
		const cases: [string, string][] = [
			["- Never edit __init__.py files by hand.\n", "Never edit init.py files by hand."],
			["- Do not call _private helpers from tests.\n", "Do not call private helpers from tests."],
			["- Match *.lock files only in CI.\n", "Match .lock files only in CI."],
			["- Read docs/**/*.md before writing.\n", "Read docs/*/*.md before writing."],
			["- Serve /_next/ assets from the CDN.\n", "Serve /next/ assets from the CDN."],
			["````\n**x** _y_\n````\n- Keep this one rule.\n", "x y"],
		];
		for (const [source, quote] of cases) expect(locateQuote(source, quote)).toEqual({ ok: false, error: "quote not found in the source" });
	});
	it("N16 (audit D2): a cut that would split a `**…**` pair or end inside a word is refused", () => {
		expect(locateQuote("- **Never push** to main on Fridays.\n", "push to main on Fridays.")).toEqual({ ok: false, error: "the quote starts or ends inside an emphasized phrase; quote the whole phrase" });
		expect(locateQuote("- Never run the deleted migrations again.\n", "Never run the delete")).toEqual({ ok: false, error: "the quote ends inside a word" });
	});
	it("P9 (audit D, M2): an exact quote of a bold rule is cut WITH its markers — no stray `**` around the pointer", () => {
		const hit = locateQuote("- **Always run the full suite in the background.**\n", "Always run the full suite in the background.");
		expect(hit.ok && "- **Always run the full suite in the background.**\n".slice(hit.start, hit.end)).toBe("**Always run the full suite in the background.**");
	});
	it("N17 (audit D6): a release whose span also holds a shadow packet's instruction is refused", () => {
		const outer = warnPacket({ id: "outer", source: { file: "CLAUDE.md", span: null, quote: Q1 } });
		const inner = samplePacket({ id: "inner", source: { file: "CLAUDE.md", span: null, quote: "`activity.jsonl`, or `timeline.jsonl`" } });
		const out = releaseEdit(sampleFile([outer, inner]), "CLAUDE.md", SOURCE, NOW);
		expect(out).toEqual({ ok: false, error: "outer's span also holds packet inner's instruction (status shadow); releasing it would remove those words with nothing enforcing them" });
	});
	it("N17b (break R5 #1, P1): an AMBIGUOUS other quote whose every copy lies inside the cut is swallowed too — refused", () => {
		const src = "Before you push, run the tests. After you rebase, run the tests.\n";
		const outer = warnPacket({ id: "aaa-warn", source: { file: "CLAUDE.md", span: null, quote: "Before you push, run the tests. After you rebase, run the tests." } });
		const inner = samplePacket({ id: "bbb-shadow", source: { file: "CLAUDE.md", span: null, quote: "run the tests." } });
		const out = releaseEdit(sampleFile([outer, inner]), "CLAUDE.md", src, NOW);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("packet bbb-shadow's instruction");
	});
	it("N17c: a copy of the other quote OUTSIDE the cut keeps its words in the file — the release proceeds", () => {
		const src = "- Before you push, run the tests always and without exception.\n- run the tests always.\n";
		const outer = warnPacket({ id: "aaa-warn", source: { file: "CLAUDE.md", span: null, quote: "Before you push, run the tests always and without exception." } });
		const inner = samplePacket({ id: "bbb-shadow", source: { file: "CLAUDE.md", span: null, quote: "run the tests always" } });
		expect(releaseEdit(sampleFile([outer, inner]), "CLAUDE.md", src, NOW).ok).toBe(true);
	});
	it("N13 (R44): an underscore inside a code literal is content, not emphasis — `foobar` never matches `foo_bar`", () => {
		const md = "- Never modify `foo_bar`.\n";
		expect(locateQuote(md, "Never modify `foobar`.")).toEqual({ ok: false, error: "quote not found in the source" });
		expect(locateQuote(md, "Never modify `foo_bar`.").ok).toBe(true);
		expect(locateQuote("- Use snake_case names.\n", "Use snakecase names.")).toEqual({ ok: false, error: "quote not found in the source" });
		expect(locateQuote("- Use `*.ts` globs.\n", "Use `.ts` globs.")).toEqual({ ok: false, error: "quote not found in the source" });
	});
	it("R6 X2: an exact hit found only inside a code span is refused, so the pointer never lands inside backticks", () => {
		const md = "- Run `never push to main` to read the rule.\n";
		expect(locateQuote(md, "never push to main")).toEqual({ ok: false, error: "the quote starts or ends inside a code span" });
		expect(locateQuote(md, "Run `never push to main` to read the rule.").ok).toBe(true);
	});
});

describe("release survival proof (R6 wave W3)", () => {
	it("N20 (review-100): a span that holds ANOTHER packet's pointer line is refused — its restore would find no pointer", () => {
		const first = warnPacket({ id: "never-full-read", source: { file: "CLAUDE.md", span: null, quote: Q1 } });
		const one = releaseEdit(sampleFile([first], { sources: { "CLAUDE.md": sha(SOURCE) } }), "CLAUDE.md", SOURCE, NOW);
		if (!one.ok) throw new Error(one.error);
		// A later compile from the released file quotes across the pointer line (the distiller sees it as text).
		const spanning = `${pointerLine("never-full-read", "CLAUDE.md")}\n- Prefer \`rg\` when searching the sample project`;
		// Before the guard this release succeeded and restoreEdit then failed for the whole file (never-full-read: no pointer).
		const second = warnPacket({ id: "prefer-rg", source: { file: "CLAUDE.md", span: null, quote: spanning } });
		const out = releaseEdit({ ...one.file, packets: [...one.file.packets, second] }, "CLAUDE.md", one.source, NOW);
		expect(out).toEqual({ ok: false, error: "prefer-rg's span holds the pointer line of packet never-full-read; restore never-full-read first" });
	});
	it("N18 (P2): another same-file packet whose quote cannot be located refuses the release — survival cannot be proven", () => {
		const outer = warnPacket({ id: "outer", source: { file: "CLAUDE.md", span: null, quote: Q1 } });
		const lost = samplePacket({ id: "lost-quote", source: { file: "CLAUDE.md", span: null, quote: "words the compiler paraphrased" } });
		expect(releaseEdit(sampleFile([outer, lost]), "CLAUDE.md", SOURCE, NOW)).toEqual({ ok: false, error: "quote of lost-quote cannot be located; survival cannot be proven" });
	});
	it("P19 (P3): a FOLDED copy of the other quote outside the cut counts even when an exact copy lies inside it", () => {
		const src = "- Before you push, run the tests now and always, without any exception.\n- Also run the\n  tests now.\n";
		const outer = warnPacket({ id: "aaa-warn", source: { file: "CLAUDE.md", span: null, quote: "Before you push, run the tests now and always, without any exception." } });
		const inner = samplePacket({ id: "bbb-shadow", source: { file: "CLAUDE.md", span: null, quote: "run the tests now" } });
		const out = releaseEdit(sampleFile([outer, inner]), "CLAUDE.md", src, NOW);
		expect(out.ok ? out.released : out.error).toEqual(["aaa-warn"]);
	});
});
