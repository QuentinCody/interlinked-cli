import { describe, expect, it } from "vitest";
import {
	checkSpecCountClaim,
	checkSpecDanglingAnchor,
	checkSpecNumbering,
	checkSpecPathRef,
	checkSpecStageOrder,
} from "./spec-structure.js";

const MD = "docs/plan.md";

describe("checkSpecDanglingAnchor", () => {
	it("fires on same-file anchors with no matching heading slug", () => {
		const out = checkSpecDanglingAnchor(
			"# Setup\nSee [config](#configuration).",
			MD,
		);
		expect(out).toEqual([
			expect.objectContaining({ line: 2, text: expect.stringContaining("configuration") }),
		]);
	});

	it("fires on §-refs to missing sections in numbered docs", () => {
		const doc = [
			"## 1. Intro",
			"## 2. Model",
			"## 3. Storage",
			"Details in §7.3 someday.",
		].join("\n");
		const out = checkSpecDanglingAnchor(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ line: 4, text: expect.stringContaining("§7.3") }),
		]);
	});

	it("fires on Appendix refs when the letter does not exist", () => {
		const doc = ["## Appendix A — formats", "See Appendix C for details."].join(
			"\n",
		);
		const out = checkSpecDanglingAnchor(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("Appendix C") }),
		]);
	});

	it("does not flag §-refs qualified as external documents (round-2 #24)", () => {
		const doc = [
			"## 1. Intro",
			"## 2. Model",
			"## 3. Storage",
			"See §7.3 of the plan and §9.1 in RFC 6330 for details.",
		].join("\n");
		expect(checkSpecDanglingAnchor(doc, MD)).toEqual([]);
	});

	it("flags a local §-ref even when a sibling external ref shares the line (round-broaden sol #4)", () => {
		const doc = ["## 1. Intro", "## 2. Model", "## 3. Storage", "See §9 of the plan, but §8 is local."].join(
			"\n",
		);
		// §9 is external (of the plan) — skipped; §8 is local and missing — flagged.
		const out = checkSpecDanglingAnchor(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("§8") }),
		]);
		expect(out.every((m) => !m.text.includes("§9"))).toBe(true);
	});

	it("qualifies each §-ref by its OWN clause, not a doc citation elsewhere on the line (sol-max #9)", () => {
		const doc = [
			"## 1. Intro",
			"## 2. Model",
			"## 3. Storage",
			// §7.3 is external (in RFC 6330); §8 is local and missing — the RFC
			// citation is bound to §7.3's clause and must NOT suppress §8.
			"See §7.3 in RFC 6330, but §8 is local.",
		].join("\n");
		const out = checkSpecDanglingAnchor(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("§8") }),
		]);
		expect(out.every((m) => !m.text.includes("§7.3"))).toBe(true);
	});

	it("treats a doc citation immediately before or after a ref as external (sol-max #9)", () => {
		const headings = ["## 1. Intro", "## 2. Model", "## 3. Storage"];
		// Preceding: "RFC 6330 §7.3"; trailing-in-clause: "§7.3, per RFC 6330".
		expect(checkSpecDanglingAnchor([...headings, "See RFC 6330 §7.3 here."].join("\n"), MD)).toEqual([]);
		expect(checkSpecDanglingAnchor([...headings, "See §7.3, per RFC 6330."].join("\n"), MD)).toEqual([]);
	});

	it("resolves a ref by its own column, not a textual-prefix match (sol-max #8)", () => {
		const headings = ["## 1. Intro", "## 2. Model", "## 3. Storage"];
		// §8 must NOT inherit §8.1's "in RFC 6330" qualifier via indexOf("§8")
		// matching inside "§8.1" — §8 is local and missing, so it must fire.
		const out = checkSpecDanglingAnchor(
			[...headings, "See §8.1 in RFC 6330, but §8 is local."].join("\n"),
			MD,
		);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("§8 ") }),
		]);
		expect(out.every((m) => !m.text.startsWith("§8.1"))).toBe(true);
	});

	it("qualifies Section/Appendix refs kind-agnostically (sol-max #10)", () => {
		const headings = ["## 1. Intro", "## 2. Model", "## 3. Storage"];
		// A later "Section 9 in RFC 6330" must not leak onto the local Section 8.
		const mixed = checkSpecDanglingAnchor(
			[...headings, "See Section 8 locally; Section 9 in RFC 6330."].join("\n"),
			MD,
		);
		expect(mixed.map((m) => m.text)).toEqual([
			expect.stringContaining("no §8 heading"),
		]);
		// "Section X of/Appendix C of the plan" are external → silent.
		expect(checkSpecDanglingAnchor([...headings, "See Section 8 of the plan."].join("\n"), MD)).toEqual([]);
		expect(checkSpecDanglingAnchor([...headings, "See Appendix C of the plan."].join("\n"), MD)).toEqual([]);
	});

	it("reuses the memoized facts on a second call with identical content+filePath (cache hit)", () => {
		const doc = "## 1. Intro\n## 2. Model\n## 3. Storage\nSee §7.3 someday.";
		// Two checks share the same (content, filePath) memo slot — the second
		// call must reuse `lastFacts` rather than re-parsing.
		const first = checkSpecDanglingAnchor(doc, MD);
		const second = checkSpecDanglingAnchor(doc, MD);
		expect(second).toEqual(first);
		expect(second).toEqual([
			expect.objectContaining({ text: expect.stringContaining("§7.3") }),
		]);
	});

	it("does not flag an unqualified §-ref when the doc has fewer than 3 numbered headings", () => {
		// Only one numbered heading — below MIN_NUMBERED_HEADINGS — so the ref is
		// treated as pointing outside this file's registry, not as dangling.
		const doc = "## 1. Only heading\nSee §5 here.";
		expect(checkSpecDanglingAnchor(doc, MD)).toEqual([]);
	});

	it("stays silent on valid anchors, parent-section refs, and prose docs", () => {
		const numbered = [
			"## 1. Intro",
			"### 1.1 Scope",
			"## 2. Model",
			"See §1 and [scope](#11-scope).",
		].join("\n");
		expect(checkSpecDanglingAnchor(numbered, MD)).toEqual([]);
		// Doc without numbered headings: §-refs point at other documents.
		expect(checkSpecDanglingAnchor("# Notes\nSee §7.3 of the plan.", MD)).toEqual(
			[],
		);
		// Doc without appendices: Appendix refs are external.
		expect(
			checkSpecDanglingAnchor("# Notes\nSee Appendix C of RFC 6330.", MD),
		).toEqual([]);
		// Non-markdown files are out of scope.
		expect(checkSpecDanglingAnchor("see §9", "src/a.ts")).toEqual([]);
	});
});

describe("checkSpecDanglingAnchor — MAX_MATCHES cap and link/appendix shapes", () => {
	it("caps dangling-anchor findings at MAX_MATCHES (20) even when more exist", () => {
		const lines: string[] = ["# Setup"];
		for (let i = 0; i < 25; i++) lines.push(`See [x${i}](#missing-${i}).`);
		const out = checkSpecDanglingAnchor(lines.join("\n"), MD);
		expect(out).toHaveLength(20);
	});

	it("caps dangling §-ref findings at MAX_MATCHES (20) even when more exist", () => {
		const headings = ["## 1. Intro", "## 2. Model", "## 3. Storage"];
		const refs: string[] = [];
		for (let i = 0; i < 25; i++) refs.push(`See §${90 + i} here.`);
		const out = checkSpecDanglingAnchor([...headings, ...refs].join("\n"), MD);
		expect(out).toHaveLength(20);
	});

	it("skips a cross-file link (targetFile set, no anchor) without flagging it", () => {
		// [plan](docs/plan.md) has targetFile set and no anchor — must not be
		// read as a dangling same-file anchor.
		expect(
			checkSpecDanglingAnchor("# Setup\nSee [plan](docs/plan.md) for details.", MD),
		).toEqual([]);
	});

	it("stays silent on an unqualified Appendix ref when the doc has zero appendix headings", () => {
		// No "of the plan"/"in RFC" qualifier and no Appendix heading at all —
		// hits the appendixLetters.size === 0 branch (a doc without appendices
		// may cite another doc's, so it's treated as out of scope, not dangling).
		const out = checkSpecDanglingAnchor("# Notes\nSee Appendix Z for detail.", MD);
		expect(out).toEqual([]);
	});

	it("stays silent when a referenced Appendix letter DOES exist", () => {
		const doc = ["## Appendix A — formats", "See Appendix A for the format."].join("\n");
		expect(checkSpecDanglingAnchor(doc, MD)).toEqual([]);
	});
});

describe("checkSpecNumbering", () => {
	it("fires on an id defined on two definition lines", () => {
		const doc = [
			"| FG-INV-01 | commit stream is truth |",
			"| FG-INV-02 | derived state rebuildable |",
			"| FG-INV-01 | duplicated row |",
		].join("\n");
		const out = checkSpecNumbering(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ line: 3, text: expect.stringContaining("FG-INV-01") }),
		]);
	});

	it("fires on small gaps in a definition registry", () => {
		const doc = ["- B1 Chronicle", "- B2 Strata", "- B3 Loom", "- B5 Determinism"].join(
			"\n",
		);
		const out = checkSpecNumbering(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("missing 4") }),
		]);
	});

	it("flags duplicate heading slugs (round-2 #37)", () => {
		const out = checkSpecNumbering("## Setup\ntext\n## Setup\nmore", MD);
		expect(out).toEqual([
			expect.objectContaining({ line: 3, text: expect.stringContaining("duplicate heading") }),
		]);
	});

	it("does not flag a legitimately-numbered sibling heading as a duplicate (round-broaden sol #3)", () => {
		// "Setup" slugs to "setup", "Setup 1" to "setup-1" — distinct, not a dup.
		expect(checkSpecNumbering("## Setup\ntext\n## Setup 1\nmore", MD)).toEqual([]);
	});

	it("stays silent on contiguous registries, prose citations, and huge gaps", () => {
		const contiguous = ["- W1 a", "- W2 b", "- W3 c"].join("\n");
		expect(checkSpecNumbering(contiguous, MD)).toEqual([]);
		// Prose citing a sparse subset (no definition lines) never fires.
		const prose = "As FG-INV-07 and FG-INV-18 require, replay works. FG-INV-19 too.";
		expect(checkSpecNumbering(prose, MD)).toEqual([]);
		// A sample of build ids with a huge span is not a registry.
		const sparse = ["- REQ-1 x", "- REQ-2 y", "- REQ-500 z"].join("\n");
		expect(checkSpecNumbering(sparse, MD)).toEqual([]);
	});

	// Definition credit is a POSITION rule, not just a line-shape rule: an id
	// named at the head of its site is declared, one mentioned after a word of
	// running text is referenced. Measured FP: docs/plans/16 defines the T1/T2/T3
	// verification tiers once in a table and cites them in later prose.
	it("P1: fires when the same id heads a registry row and a heading", () => {
		const doc = [
			"| D3 | placeholder_runtime_constant |",
			"| D4 | regex_from_interpolation |",
			"| D5 | rust_unsafe_span |",
			"",
			"## 4. D3 — placeholder_runtime_constant",
		].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([
			expect.objectContaining({
				line: 5,
				text: expect.stringContaining("D3 defined again"),
			}),
		]);
	});

	it("P2: fires when a decorated first cell redefines a heading's id", () => {
		const doc = [
			"| ★R1 | must not run mutation tests |",
			"| R2 | must not run gherkin mutation |",
			"| R3 | must not introduce new behavior |",
			"",
			"## R1 — refactorer must not run mutation tests",
		].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([
			expect.objectContaining({
				line: 5,
				text: expect.stringContaining("R1 defined again"),
			}),
		]);
	});

	it("N1: does not fire on tier names referenced in later prose (plan-16 shape)", () => {
		const doc = [
			"| tier | budget | surface |",
			"| **T1 blocking-fast** | < ~2s | PreToolUse |",
			"| **T2 start-now-harvest-later** | 30-60s wall | PreToolUse start |",
			"| **T3 session/commit** | minutes | Stop, commit gate |",
			"",
			"| risk | budget |",
			"| low | T1 only, seconds |",
			"| high | T1 + full T2 portfolio |",
			"",
			"2. **Run existing properties as a T2 verifier** with a larger budget.",
			"",
			"- **Blocking on slow verifiers.** Anything that cannot verdict in T1 goes to T2.",
		].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([]);
	});

	it("N2: a table that only cites ids cannot manufacture a gap registry", () => {
		// B1/B2/B3/B5 all sit in trailing cells — references, so there is no
		// definition registry whose numbering could have a gap at B4.
		const doc = [
			"| tier | note |",
			"| low | B1 only |",
			"| mid | B2 plus B3 |",
			"| high | B5 full |",
		].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([]);
	});

	// Measured FP (2026-11-06, a campaign run-book): a status table defines U1/E1, and the log below it
	// starts bullets with the same ids ("- E1 DONE: …"). A bullet under a table/heading registry
	// elaborates that id; only a bullet registry can be redefined by another bullet.
	it("N3: bullets that start with ids a table already defines are status notes, not redefinitions", () => {
		const doc = [
			"| # | Unit | Status |",
			"|---|---|---|",
			"| U1 | build the module | done |",
			"| U2 | build the command | done |",
			"| U3 | build the report | done |",
			"",
			"## Log",
			"- U1 DONE: module + test (10/10).",
			"- U1 fix: skipped files are lost.",
			"- U2 DONE: command + test.",
			"- U3 DONE: report.",
		].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([]);
	});

	it("P3: a bullet registry still fires when a later bullet reuses an id", () => {
		const doc = ["- W1 first rule", "- W2 second rule", "- W3 third rule", "- W2 renumbered residue"].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([
			expect.objectContaining({ line: 4, text: expect.stringContaining("W2 defined again (first definition at line 2)") }),
		]);
	});

	// Adjudicated TP (2026-11-06): docs/design/git-native-multiplayer-review-history.md defines S1/S2 as
	// review findings in a table, then a spike section declares "- **S1 native-isolated**: …" — a second entry.
	it("P5: a bullet that NAMES the id in bold declares a new entry, even under a table registry", () => {
		const doc = [
			"| S1 | refs lose a revert | fix |",
			"| S2 | worktrees clobber refs | fix |",
			"| S3 | refs lag a batch | fix |",
			"",
			"## Spike",
			"- **S1 native-isolated**: copy bytes into a private worktree.",
			"- **S2 plumbing**: hash-object plus update-index.",
		].join("\n");
		expect(checkSpecNumbering(doc, MD).map(f => f.line)).toEqual([6, 7]);
	});

	it("P4: a table row reused by a later table row still fires after status bullets", () => {
		const doc = ["| U1 | a |", "| U2 | b |", "| U3 | c |", "- U1 DONE: a", "| U1 | duplicate row |"].join("\n");
		expect(checkSpecNumbering(doc, MD)).toEqual([
			expect.objectContaining({ line: 5, text: expect.stringContaining("U1 defined again (first definition at line 1)") }),
		]);
	});

	it("caps duplicate-id findings at MAX_MATCHES (20)", () => {
		const rows: string[] = [];
		for (let i = 1; i <= 25; i++) rows.push(`| FG-INV-${i} | row ${i} |`);
		for (let i = 1; i <= 25; i++) rows.push(`| FG-INV-${i} | duplicate row ${i} |`);
		const out = checkSpecNumbering(rows.join("\n"), MD);
		expect(out.length).toBe(20);
	});

	it("caps duplicate-heading findings at MAX_MATCHES (20)", () => {
		const headings: string[] = [];
		for (let i = 0; i < 25; i++) headings.push(`## Setup\ntext`);
		const out = checkSpecNumbering(headings.join("\n"), MD);
		expect(out.length).toBe(20);
	});
});

describe("checkSpecCountClaim", () => {
	const planLike = [
		"## The six bets",
		"| **B1** | Chronicle |",
		"| **B2** | Strata |",
		"| **B3** | Loom |",
		"| **B4** | Ripple |",
		"| **B5** | Determinism |",
		"| **B6** | Warden |",
		"| **B7** | Sextant |",
	].join("\n");

	it("fires when a heading-bound count claim disagrees with the census", () => {
		const out = checkSpecCountClaim(planLike, MD);
		expect(out).toEqual([
			expect.objectContaining({
				line: 1,
				text: expect.stringContaining("7 distinct ids"),
			}),
		]);
	});

	it("fires when a range claim understates the census max (D-2 shape)", () => {
		const doc = [
			"| FG-INV-01 | a |",
			"| FG-INV-20 | b |",
			"| FG-INV-28 | c |",
			"Every invariant (FG-INV-01 through FG-INV-20) has a checker.",
		].join("\n");
		const out = checkSpecCountClaim(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({
				line: 4,
				text: expect.stringContaining("FG-INV-28"),
			}),
		]);
	});

	it("does not fire on an intentional sub-range (round-2 #20)", () => {
		const doc = [
			"| FG-INV-01 | a |",
			"| FG-INV-20 | b |",
			"| FG-INV-28 | c |",
			"Examples FG-INV-05 through FG-INV-10 illustrate the pattern.",
		].join("\n");
		// Sub-range (starts at 5, not census min 1) — not a full-span claim.
		expect(checkSpecCountClaim(doc, MD)).toEqual([]);
	});

	it("fires on a range that STARTS below the census min (overclaim, sol-max #14)", () => {
		const doc = [
			"| X-05 | a |",
			"| X-10 | b |",
			"| X-20 | c |",
			"See X-01 through X-10.",
		].join("\n");
		// from=1 is below the census min (5): it overclaims X-01..X-04 and understates
		// the max — drift, not an intentional slice.
		const out = checkSpecCountClaim(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("X-20") }),
		]);
	});

	it("caps range-claim findings at MAX_MATCHES (20) across many namespaces", () => {
		const seconds = "ABCDEFGHIJKLMNOPQRSTUVWXY".split("");
		const parts: string[] = [];
		for (const s of seconds) {
			const P = `A${s}`;
			parts.push(`| ${P}-01 | a |`);
			parts.push(`| ${P}-20 | b |`);
			parts.push(`| ${P}-28 | c |`);
			parts.push(`Every item (${P}-01 through ${P}-20) is covered.`);
		}
		const out = checkSpecCountClaim(parts.join("\n"), MD);
		expect(out.length).toBe(20);
	});

	it("formats a mismatched claim using DASHED notation for a dashed namespace", () => {
		const doc = [
			"## The five items",
			"| **FG-INV-01** | a |",
			"| **FG-INV-02** | b |",
			"| **FG-INV-03** | c |",
		].join("\n");
		const out = checkSpecCountClaim(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("FG-INV-1..FG-INV-3") }),
		]);
	});

	it("scopes a range claim to its OWN notation style (sol-max #11)", () => {
		// A dashed A namespace (reaches A-99) and a compact A namespace (reaches
		// A5) share the prefix. A COMPACT claim must be measured against the
		// compact census (A5), never the dashed one — the old prefix-only lookup
		// bound it to the dashed namespace (sorted first) and reported "A-99".
		const doc = [
			"| A-01 | . |",
			"| A-99 | . |",
			"Compact ids A1, A2, A5 are separate.",
			"Steps A1 through A2 cover setup.",
		].join("\n");
		const out = checkSpecCountClaim(doc, MD);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("A-5") }),
		]);
		expect(out[0]?.text).not.toContain("A-99");
	});

	it("does not bind a compact claim to a dashed-only namespace (sol-max #11)", () => {
		// Only a dashed A namespace exists; a compact "A1 through A3" claim has no
		// compact namespace to measure against, so it must stay silent rather than
		// borrow the dashed census.
		const doc = [
			"| A-01 | . |",
			"| A-05 | . |",
			"| A-40 | . |",
			"See A1 through A3 for the intro.",
		].join("\n");
		// A1/A3 form a compact A {1,3} whose max (3) the claim hits exactly → no
		// fire; crucially it is NOT measured against dashed A-40.
		expect(checkSpecCountClaim(doc, MD)).toEqual([]);
	});

	it("fires on same-line-bound claims", () => {
		const doc = "Six bets (B1, B2, B3, B4, B5, B6, B7) compose the leapfrog.";
		const out = checkSpecCountClaim(doc, MD);
		expect(out).toHaveLength(1);
	});

	it("caps count-claim findings at MAX_MATCHES (20) across many namespaces", () => {
		const nouns = [
			"gates", "cases", "docks", "edges", "forms", "hooks", "items", "jars",
			"keys", "lines", "marks", "nodes", "orbs", "parts", "quilts", "rules",
			"spans", "tiles", "units", "vines", "xrays", "yards", "zones", "bows", "caps",
		];
		const letters = "ACDEFHIJKLMNOPQRSTUVXYZBG".split("");
		const parts: string[] = [];
		for (let i = 0; i < nouns.length; i++) {
			const L = letters[i];
			parts.push(`## The five ${nouns[i]}`);
			parts.push(`| **${L}1** | a |`);
			parts.push(`| **${L}2** | b |`);
			parts.push(`| **${L}3** | c |`);
			parts.push(`| **${L}4** | d |`);
		}
		const out = checkSpecCountClaim(parts.join("\n"), MD);
		expect(out.length).toBe(20);
	});

	it("stays silent when counts agree, claims are unbound, or census is tiny", () => {
		const agree = [
			"## The seven bets",
			"| **B1** | a |",
			"| **B2** | b |",
			"| **B3** | c |",
			"| **B4** | d |",
			"| **B5** | e |",
			"| **B6** | f |",
			"| **B7** | g |",
		].join("\n");
		expect(checkSpecCountClaim(agree, MD)).toEqual([]);
		// Unbound: the noun never co-occurs with the namespace.
		const unbound = ["Six reasons this works.", "- W1 a", "- W2 b", "- W3 c"].join(
			"\n",
		);
		expect(checkSpecCountClaim(unbound, MD)).toEqual([]);
		// Range prefix that matches no in-file namespace is another doc's registry.
		expect(
			checkSpecCountClaim("Valid for REQ-01 through REQ-20.", MD),
		).toEqual([]);
	});
});

describe("non-markdown gating", () => {
	it("all spec checks no-op outside markdown files", () => {
		const doc = "## The six bets\n- B1 a\n- B2 b\n- B7 c\nSee §9 and [x](#gone).";
		expect(checkSpecNumbering(doc, "src/a.ts")).toEqual([]);
		expect(checkSpecCountClaim(doc, "src/a.py")).toEqual([]);
		expect(checkSpecDanglingAnchor(doc, "notes.txt")).toEqual([]);
	});
});

describe("checkSpecStageOrder", () => {
	const stages = "- W1 storage\n- W2 cursors\n- W3 txn\n- W4 loom\n- W8 fabric\n";

	it("fires on forward dependencies and backward constraints (Sol WS class)", () => {
		const fwd = checkSpecStageOrder(
			`${stages}W4 depends on W8 for replication hooks.`,
			MD,
		);
		expect(fwd).toEqual([
			expect.objectContaining({ text: expect.stringContaining("W4 depends on later W8") }),
		]);
		const back = checkSpecStageOrder(
			`${stages}W8 rewrites W2 cursor semantics for authorization.`,
			MD,
		);
		expect(back).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("W8 changes what W2 already fixed"),
			}),
		]);
	});

	it("stays silent on well-ordered deps, non-stage docs, and cross-prefix pairs", () => {
		expect(checkSpecStageOrder(`${stages}W4 depends on W3 outputs.`, MD)).toEqual([]);
		expect(
			checkSpecStageOrder("W4 depends on W8 with no stage registry here.", MD),
		).toEqual([]);
		expect(
			checkSpecStageOrder(`${stages}W4 depends on G2 landing first.`, MD),
		).toEqual([]);
		expect(checkSpecStageOrder(`${stages}W8 rewrites W2`, "src/a.ts")).toEqual([]);
	});

	it("does not treat a dashed W/G namespace as a stage registry (style must be compact)", () => {
		// W-1/W-2/W-3 are DASHED, not compact — hasStages requires compact style.
		const dashed = "| W-1 | a |\n| W-2 | b |\n| W-3 | c |\n";
		expect(checkSpecStageOrder(`${dashed}W4 depends on W8 for hooks.`, MD)).toEqual([]);
	});

	it("does not treat a non-W/G compact namespace as a stage registry", () => {
		// B1/B2/B3 are compact but neither prefix W nor G.
		const bees = "- B1 a\n- B2 b\n- B3 c\n";
		expect(checkSpecStageOrder(`${bees}W4 depends on W8 for hooks.`, MD)).toEqual([]);
	});

	it("does not treat fewer than 3 DEFINED W/G stages as a registry", () => {
		const twoStages = "- W1 a\n- W2 b\n";
		expect(checkSpecStageOrder(`${twoStages}W4 depends on W8 for hooks.`, MD)).toEqual([]);
	});

	it("skips a forward-dependency pattern inside a fenced code block (sol-max #18)", () => {
		const doc = `${stages}\`\`\`\nW4 depends on W8 for replication hooks.\n\`\`\`\n`;
		expect(checkSpecStageOrder(doc, MD)).toEqual([]);
	});
});

describe("checkSpecPathRef", () => {
	const exists = (p: string): boolean => p === "src/real.ts";

	it("fires on present-tense claims about missing paths", () => {
		const out = checkSpecPathRef(
			"The full `invariants.toml` exists in-repo.",
			MD,
			exists,
		);
		expect(out).toEqual([
			expect.objectContaining({ text: expect.stringContaining("invariants.toml") }),
		]);
	});

	it("stays silent on existing paths, future tense, and unknown tense", () => {
		expect(
			checkSpecPathRef("The entry lives at `src/real.ts` today.", MD, exists),
		).toEqual([]);
		expect(
			checkSpecPathRef("We will add `scripts/check.sh` later.", MD, exists),
		).toEqual([]);
		expect(checkSpecPathRef("Consider `maybe/file.ts` here.", MD, exists)).toEqual(
			[],
		);
	});

	it("no-ops outside markdown files", () => {
		expect(
			checkSpecPathRef("The full `invariants.toml` exists in-repo.", "src/a.ts", exists),
		).toEqual([]);
	});

	it("caps path-ref findings at MAX_MATCHES (20) even when more exist", () => {
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`The full \`missing-${i}.toml\` exists in-repo.`);
		const out = checkSpecPathRef(lines.join("\n"), MD, exists);
		expect(out).toHaveLength(20);
	});
});
