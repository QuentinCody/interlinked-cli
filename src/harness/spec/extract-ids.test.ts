import { describe, expect, it } from "vitest";
import { extractCountClaims } from "./extract-counts.js";
import {
	extractIdNamespaces,
	extractLooseDefinedIds,
	extractRangeClaims,
} from "./extract-ids.js";

const lines = (text: string): string[] => text.split("\n");

describe("id extraction hardening (sol-max batch 1)", () => {
	const nums = (doc: string[], prefix: string) =>
		extractIdNamespaces(doc).find((n) => n.prefix === prefix)?.ids.map((i) => i.num);

	it("excludes emphasized and repeated range endpoints from the census (#1/#2)", () => {
		expect(extractIdNamespaces(["**FG-INV-01** through **FG-INV-20** hold"])).toEqual([]);
		expect(extractIdNamespaces(["A-1 through A-2; A-1 through A-2"])).toEqual([]);
	});

	it("recognizes +/N) list rows but not bold prose as loose definitions (#4/#5)", () => {
		expect(extractLooseDefinedIds(["**Note:** B7 was removed."])).toEqual([]);
		expect(extractLooseDefinedIds(["+ B7 extra"]).map((l) => l.num)).toEqual([7]);
		expect(extractLooseDefinedIds(["1) B7 extra"]).map((l) => l.num)).toEqual([7]);
	});

	it("stoplists exact prose prefixes but keeps compound registry prefixes (#6)", () => {
		expect(extractIdNamespaces(["HTTP-200 and HTTP-404 are codes"])).toEqual([]);
		expect(nums(["| HTTP-REQ-1 | a |", "| HTTP-REQ-2 | b |"], "HTTP-REQ")).toEqual([1, 2]);
	});

	it("rejects underscore-suffixed identifiers (#7)", () => {
		expect(extractIdNamespaces(["B1_case B2_case B3_case"])).toEqual([]);
	});

	it("does not read a decimal as a count claim (#13)", () => {
		expect(extractCountClaims(["There are 1.5 invariants."])).toEqual([]);
	});

	it("takes the true plural, not a false-plural adjective ending in ss (#14)", () => {
		const c = extractCountClaims(["six access policies"]);
		expect(c[0]?.nounSingular).toBe("policy");
	});

	it("requires whitespace after # and full bold-wrap for a definition (round-4 #1/#2)", () => {
		expect(extractLooseDefinedIds(["#Note B7 was removed."])).toEqual([]);
		expect(extractLooseDefinedIds(["**B7 was removed from the registry**"])).toEqual([]);
		expect(extractLooseDefinedIds(["**B7** first"]).map((l) => l.num)).toEqual([7]);
	});

	it("uses the exact range match column, not a substring search (round-4 #4)", () => {
		// The "FG-1 through FG-2" that failed the leading boundary in "XFG-1 …" must
		// not let its endpoints seed a spurious FG namespace.
		expect(extractIdNamespaces(["XFG-1 through FG-2; FG-1 through FG-2"])).toEqual([]);
	});

	it("keeps intraword underscores literal so B_1 is not an id (round-4 #5)", () => {
		expect(extractIdNamespaces(["- B_1", "- B_2", "- B_3"])).toEqual([]);
	});

	it("rejects singular -us/-is nouns as false plurals (round-4 #6)", () => {
		expect(extractCountClaims(["six status codes"])[0]?.nounSingular).toBe("code");
		expect(extractCountClaims(["six analysis methods"])[0]?.nounSingular).toBe("method");
	});

	it("keeps genuine -us/-is plurals that the old morphology hack dropped (round-5 #8)", () => {
		expect(extractCountClaims(["six APIs"])[0]?.nounSingular).toBe("api");
		expect(extractCountClaims(["six menus"])[0]?.nounSingular).toBe("menu");
		// A stoplisted singular's real plural still matches and singularizes.
		expect(extractCountClaims(["seven accesses"])[0]?.nounSingular).toBe("access");
	});

	it("does not accept an underscore-embedded noun (round-5 #8)", () => {
		expect(extractCountClaims(["six bad_s"]).some((c) => c.noun === "bad_s")).toBe(false);
	});

	it("does not read a signed delta or hyphenated tail as a count (round-5 #9)", () => {
		expect(extractCountClaims(["-5 invariants"])).toEqual([]);
		expect(extractCountClaims(["twenty-six invariants"])).toEqual([]);
	});

	it("does not treat inherited object keys as number words (round-5 #24)", () => {
		expect(extractCountClaims(["six constructor invariants"])[0]?.nounSingular).toBe(
			"invariant",
		);
	});

	it("does not re-anchor an over-cap dashed id after an internal dash (round-5 #3)", () => {
		const over = "ABCDEFGHIJKLMNOP-QRSTUVWXYZABCDEF-REQ";
		expect(extractIdNamespaces([`- ${over}-1`, `- ${over}-2`])).toEqual([]);
	});

	it("does not harvest a compact id from a dashed id's prefix (round-5 #4)", () => {
		expect(extractIdNamespaces(["- P1-99", "- P2-99", "- P3-99"])).toEqual([]);
	});

	it("credits a definition in a space-less blockquote (round-5 #5)", () => {
		expect(extractLooseDefinedIds([">B7 extra"]).map((l) => l.num)).toEqual([7]);
	});

	it("rejects underscore-embedded range endpoints (round-5 #6)", () => {
		expect(extractRangeClaims(["X_A1 through A9_case"])).toEqual([]);
	});

	it("keeps a backslash-escaped underscore literal so it cannot fabricate an id (round-5 #7)", () => {
		expect(extractIdNamespaces(["- \\_B1", "- \\_B2", "- \\_B3"])).toEqual([]);
	});

	it("does not truncate extended dashed tokens into base ids (round-6 #1)", () => {
		expect(extractIdNamespaces(["REQ-1-alpha REQ-2-beta"])).toEqual([]);
	});

	it("rejects a dash-extended upper range endpoint (round-6 #6)", () => {
		expect(extractRangeClaims(["A1 through A9-extra"])).toEqual([]);
	});

	it("applies the open -ss singular rule, not just the enumerated list (round-6 #7)", () => {
		expect(extractCountClaims(["six glass panels"])[0]?.nounSingular).toBe("panel");
		expect(extractCountClaims(["six status codes"])[0]?.nounSingular).toBe("code");
	});

	it("rejects plus- and Unicode-minus-signed quantities (round-6 #8)", () => {
		expect(extractCountClaims(["+5 invariants"])).toEqual([]);
		expect(extractCountClaims(["−5 invariants"])).toEqual([]);
	});

	it("rejects an underscore-extended noun token (round-6 #9)", () => {
		expect(extractCountClaims(["six widgets_case"])).toEqual([]);
	});

	it("rejects a number that continues a slashed id (stop-digest FP 2026-08-21)", () => {
		// "NIP-29/43 events" is one id list, not a "43 events" count claim —
		// the claim bound event→NIP for the whole repo and flagged an
		// unrelated CHANGELOG "14 events" line against the NIP census.
		expect(extractCountClaims(["NIP-29/43 events are signed"])).toEqual([]);
	});

	it("rejects an approximate (~) quantity (stop-digest FP 2026-08-21)", () => {
		// "~17 commands" asserts an approximation; only exact counts are
		// checkable against a census.
		expect(extractCountClaims(["~17 commands still import it"])).toEqual([]);
	});

	it("rejects verbs and function words ending in s as the noun (stop-digest FP 2026-08-21)", () => {
		// "the tree said 25 was the 75th percentile" parsed as claim "25 was".
		expect(extractCountClaims(["the tree said 25 was the 75th percentile"])).toEqual([]);
		expect(extractCountClaims(["the flag 12 has no effect"])).toEqual([]);
		expect(extractCountClaims(["value 9 does nothing"])).toEqual([]);
		expect(extractCountClaims(["3 versus 4"])).toEqual([]);
	});

	it("still accepts an exact claim after the new guards (control)", () => {
		expect(extractCountClaims(["six bets"])[0]?.value).toBe(6);
		expect(extractCountClaims(["28 invariants"])[0]?.value).toBe(28);
	});

	it("does not fabricate a range from an unpaired leading underscore (round-7 #4)", () => {
		expect(extractRangeClaims(["_A1 through A9"])).toEqual([]);
	});

	it("reads count claims through emphasis on individual terms (round-7 #2)", () => {
		expect(extractCountClaims(["**six** bets"])[0]?.value).toBe(6);
		expect(extractCountClaims(["_six bets_"])[0]?.value).toBe(6);
	});

	it("rejects count/range claims glued to Unicode word chars (round-7 #3/#5)", () => {
		expect(extractCountClaims(["ésix bets"])).toEqual([]);
		expect(extractCountClaims(["six betsé"])).toEqual([]);
		expect(extractRangeClaims(["éA1 through A9"])).toEqual([]);
		expect(extractRangeClaims(["A1 through A9é"])).toEqual([]);
	});

	it("requires whitespace around a word range operator (round-7 #6)", () => {
		expect(extractRangeClaims(["A1toA9"])).toEqual([]);
		expect(extractRangeClaims(["A1 to A9"]).length).toBe(1);
	});
});

describe("extractIdNamespaces", () => {
	it("clusters dashed ids with census, gaps, and sites (FG-INV shape)", () => {
		const ns = extractIdNamespaces(
			lines(
				[
					"## Invariants",
					"| **FG-INV-01** | commit stream is sole truth |",
					"| **FG-INV-02** | derived state rebuildable |",
					"Body text referencing FG-INV-01 again and FG-INV-05.",
				].join("\n"),
			),
		);
		expect(ns).toHaveLength(1);
		const inv = ns[0];
		expect(inv?.prefix).toBe("FG-INV");
		expect(inv?.style).toBe("dashed");
		expect(inv?.min).toBe(1);
		expect(inv?.max).toBe(5);
		expect(inv?.uniqueCount).toBe(3);
		expect(inv?.gaps).toEqual([3, 4]);
		expect(inv?.gapCount).toBe(2);
		const one = inv?.ids.find((i) => i.num === 1);
		expect(one?.sites).toEqual([2, 4]);
		expect(one?.defSites).toEqual([2]);
	});

	it("clusters compact ids only at ≥3 distinct numbers (B1..B7 shape)", () => {
		const hit = extractIdNamespaces(
			lines("Bets B1, B2 and B7 compose. Also W4 alone."),
		);
		expect(hit.map((n) => n.prefix)).toEqual(["B"]);
		expect(hit[0]?.uniqueCount).toBe(3);
		expect(hit[0]?.gaps).toEqual([3, 4, 5, 6]);
	});

	it("keeps dashed and compact namespaces separate and sorted", () => {
		const ns = extractIdNamespaces(
			lines("W1 W2 W3 then FG-INV-01 and FG-INV-02."),
		);
		expect(ns.map((n) => `${n.style}:${n.prefix}`)).toEqual([
			"dashed:FG-INV",
			"compact:W",
		]);
	});

	it("excludes range-claim endpoints from the census (sol-max #12)", () => {
		// The registry defines FG-INV-01 and FG-INV-20; the claim OVERSTATES to
		// FG-INV-30. The claim's own endpoint must not seed the census, so max
		// stays 20 and the overstatement stays visible to the count check.
		const ns = extractIdNamespaces([
			"| FG-INV-01 | a |",
			"| FG-INV-20 | b |",
			"Every invariant FG-INV-01 through FG-INV-30 has a checker.",
		]);
		expect(ns).toHaveLength(1);
		expect(ns[0]?.max).toBe(20);
		expect(ns[0]?.uniqueCount).toBe(2);
	});

	it("does not fabricate a census from a range claim's endpoints alone (sol-max #12)", () => {
		// FG-INV appears ONLY inside the range claim — with both endpoints
		// excluded there is no registry to compare against.
		expect(
			extractIdNamespaces(lines("Range FG-INV-01 through FG-INV-20 applies.")),
		).toEqual([]);
	});

	it("keeps a same-line registry definition that shares a line with a range claim (sol-max #3)", () => {
		// The FIRST X-01 is a table definition; only the range's OWN endpoints
		// (the second X-01 and X-03) are excluded, so X-01 still seeds the census.
		const ns = extractIdNamespaces([
			"| X-01 | row; range X-01 through X-03 |",
			"| X-02 | row |",
			"| X-04 | row |",
		]);
		expect(ns).toHaveLength(1);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 2, 4]);
	});

	it("excludes BOTH endpoints of a mixed-notation range (sol-max #4)", () => {
		// "A1 through A-09" is a compact→dashed range; the dashed A-09 endpoint
		// must NOT seed the dashed census, so the real dashed A-01..A-02 registry
		// is not falsely measured against a phantom A-09.
		const ns = extractIdNamespaces([
			"| A-01 | a |",
			"| A-02 | b |",
			"Mixed A1 through A-09.",
		]);
		const dashed = ns.find((n) => n.style === "dashed" && n.prefix === "A");
		expect(dashed?.ids.map((i) => i.num)).toEqual([1, 2]);
	});

	it("does not fire on years, stoplisted prefixes, or sparse tokens", () => {
		expect(extractIdNamespaces(lines("CVE-2024 and CVE-2025 advisories"))).toEqual(
			[],
		);
		expect(extractIdNamespaces(lines("UTF8 UTF16 UTF32 everywhere"))).toEqual([]);
		expect(extractIdNamespaces(lines("V8 is fast, S3 is storage"))).toEqual([]);
		expect(extractIdNamespaces(lines("REQ-1 appears once"))).toEqual([]);
	});

	it("rejects malformed dashed prefixes (double dash, dash-digit segment)", () => {
		expect(extractIdNamespaces(lines("A--B-1 A--B-2 tokens"))).toEqual([]);
	});

	it("supports 4-digit dashed ids and rejects longer runs atomically", () => {
		const ns = extractIdNamespaces(lines("REQ-1234 then REQ-1235 registered"));
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1234, 1235]);
		// REQ-12345 must not be truncated into a phantom REQ-1234.
		expect(extractIdNamespaces(lines("REQ-12345 REQ-12346 tokens"))).toEqual([]);
	});

	it("rejects longer compact tokens atomically (B123 is not B12)", () => {
		expect(extractIdNamespaces(lines("B123 B124 B125 build numbers"))).toEqual(
			[],
		);
	});

	it("rejects version-suffixed tokens in the census (REQ-2.0 is not REQ-2)", () => {
		expect(extractIdNamespaces(lines("REQ-2.0 and REQ-3.0 and REQ-4.0"))).toEqual(
			[],
		);
		const sentenceFinal = extractIdNamespaces(
			lines("See REQ-2. Also REQ-3. Then REQ-4."),
		);
		expect(sentenceFinal[0]?.ids.map((i) => i.num)).toEqual([2, 3, 4]);
	});

	it("dedupes same-line sites and merges spellings with provenance", () => {
		const ns = extractIdNamespaces(
			lines("FG-INV-01 and FG-INV-01 again\nFG-INV-1 short form\nFG-INV-02 x"),
		);
		const one = ns[0]?.ids.find((i) => i.num === 1);
		expect(one?.sites).toEqual([1, 2]);
		expect(one?.spellings).toEqual(["FG-INV-01", "FG-INV-1"]);
	});

	it("credits definitions only to the first id on a definition line", () => {
		const ns = extractIdNamespaces(
			lines("| FG-INV-01 | Depends on FG-INV-02 and supersedes FG-INV-03 |"),
		);
		const ids = ns[0]?.ids ?? [];
		expect(ids.find((i) => i.num === 1)?.defSites).toEqual([1]);
		expect(ids.find((i) => i.num === 2)?.defSites).toEqual([]);
		expect(ids.find((i) => i.num === 3)?.defSites).toEqual([]);
	});

	it("recognizes blockquote and task-list registry lines as definitions", () => {
		const ns = extractIdNamespaces(
			lines("> FG-INV-01: rule\n- [ ] FG-INV-02: implement rule"),
		);
		const ids = ns[0]?.ids ?? [];
		expect(ids.find((i) => i.num === 1)?.defSites).toEqual([1]);
		expect(ids.find((i) => i.num === 2)?.defSites).toEqual([2]);
	});

	it("caps gap enumeration but reports the true gapCount", () => {
		const ns = extractIdNamespaces(lines("QQ-1 start and QQ-999 end"));
		expect(ns[0]?.gaps).toHaveLength(50);
		expect(ns[0]?.gapCount).toBe(997);
	});

	it("stays fast on pathological all-caps dash runs (ReDoS guard)", () => {
		const evil = `${"A-".repeat(2000)}${"A".repeat(2000)}`;
		const evilRange = `${"AB-12 through ".repeat(500)}${"9".repeat(100)}`;
		const start = Date.now();
		extractIdNamespaces([evil, evil, evilRange]);
		extractRangeClaims([evil, evilRange]);
		extractCountClaims([evilRange]);
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe("extractCountClaims", () => {
	it("extracts word-number and digit claims with full provenance", () => {
		const claims = extractCountClaims(
			lines("The composition of six bets. There are 28 invariants."),
		);
		expect(claims).toEqual([
			{
				noun: "bets",
				nounSingular: "bet",
				value: 6,
				raw: "six bets",
				line: 1,
			},
			{
				noun: "invariants",
				nounSingular: "invariant",
				value: 28,
				raw: "28 invariants",
				line: 1,
			},
		]);
	});

	it("accepts one qualifying adjective and capitalized nouns", () => {
		const claims = extractCountClaims(
			lines("the 28 documented Invariants and all six core bets"),
		);
		expect(claims.map((c) => [c.noun, c.value])).toEqual([
			["invariants", 28],
			["bets", 6],
		]);
	});

	it("never misreads comma-grouped numbers as their tail", () => {
		// "1,200 invariants" must not become a 200-claim; >500 values drop.
		expect(extractCountClaims(lines("There are 1,200 invariants."))).toEqual([]);
	});

	it("skips quantity/trajectory nouns, scale words, and non-plurals", () => {
		expect(extractCountClaims(lines("ran three times over 900 bytes"))).toEqual(
			[],
		);
		expect(extractCountClaims(lines("two commits failed, three checks passed"))).toEqual(
			[],
		);
		expect(extractCountClaims(lines("three hundred items shipped"))).toEqual([]);
		expect(extractCountClaims(lines("twenty six bets"))).toEqual([]);
		expect(extractCountClaims(lines("one bet placed"))).toEqual([]);
	});

	it("singularizes -ies, +es, -sses, and irregular forms for binding", () => {
		const claims = extractCountClaims(
			lines(
				"five policies, four indexes, seven statuses, three classes, six phases, and four analyses are listed",
			),
		);
		expect(claims.map((c) => c.nounSingular)).toEqual([
			"policy",
			"index",
			"status",
			"class",
			"phase",
			"analysis",
		]);
	});
});

describe("extractRangeClaims", () => {
	it("extracts 'through' ranges with repeated prefix and full provenance", () => {
		const rc = extractRangeClaims(
			lines("every invariant (FG-INV-01 through FG-INV-20) has a checker"),
		);
		expect(rc).toEqual([
			{
				prefix: "FG-INV",
				from: 1,
				to: 20,
				toExplicit: true,
				raw: "FG-INV-01 through FG-INV-20",
				line: 1,
				style: "dashed",
				col: 17,
			},
		]);
	});

	it("extracts ellipsis and en-dash ranges, marking bare endpoints inferred", () => {
		const bare = extractRangeClaims(lines("ids FG-INV-01 … 20 are registered"));
		expect(bare).toEqual([
			expect.objectContaining({
				prefix: "FG-INV",
				from: 1,
				to: 20,
				toExplicit: false,
			}),
		]);
		expect(extractRangeClaims(lines("W1–W9 in order"))).toEqual([
			expect.objectContaining({ prefix: "W", from: 1, to: 9, toExplicit: true }),
		]);
	});

	it("parses emphasized endpoints (bold/backtick formatting)", () => {
		expect(
			extractRangeClaims(lines("**FG-INV-01** through **FG-INV-20** hold")),
		).toEqual([expect.objectContaining({ prefix: "FG-INV", from: 1, to: 20 })]);
		expect(
			extractRangeClaims(lines("`FG-INV-01` through `FG-INV-20` hold")),
		).toEqual([expect.objectContaining({ prefix: "FG-INV", from: 1, to: 20 })]);
	});

	it("never fabricates a range across different prefixes", () => {
		expect(
			extractRangeClaims(lines("FG-INV-01 through OTHER-20 are unrelated")),
		).toEqual([]);
	});

	it("rejects version-suffixed endpoints but keeps sentence-final periods", () => {
		expect(
			extractRangeClaims(lines("FG-INV-01 through FG-INV-20.0 shipped")),
		).toEqual([]);
		expect(
			extractRangeClaims(lines("valid up to FG-INV-01 through FG-INV-20.")),
		).toEqual([expect.objectContaining({ from: 1, to: 20 })]);
	});

	it("rejects year ranges, inverted ranges, and bad prefixes", () => {
		expect(extractRangeClaims(lines("from 2020 to 2024"))).toEqual([]);
		expect(extractRangeClaims(lines("SPAN-1999 to SPAN-2050 era"))).toEqual([]);
		expect(extractRangeClaims(lines("FG-INV-20 through FG-INV-05"))).toEqual([]);
		expect(extractRangeClaims(lines("A--B-1 through A--B-9"))).toEqual([]);
	});
});

describe("acceptance corpus (Sol D-1 / D-2 extraction fidelity)", () => {
	// The ledger (spike 2) correlates these; this pins that extraction alone
	// yields exactly the facts needed to reproduce both audit findings.
	const planDoc = [
		"# Plan",
		"The composition of seven bets, each at the frontier:",
		"| **B1** | Chronicle |",
		"| **B2** | Strata |",
		"| **B3** | Loom |",
		"| **B4** | Ripple |",
		"| **B5** | Determinism |",
		"| **B6** | Warden |",
		"| **B7** | Sextant |",
		"Invariants run FG-INV-01, FG-INV-02, and up to FG-INV-28.",
	].join("\n");
	const readmeDoc = [
		"# README",
		"No single trick makes this work. The composition of six bets does.",
		"Every invariant (FG-INV-01 … FG-INV-20) has a live checker.",
	].join("\n");

	it("plan census: seven B ids and FG-INV max 28", () => {
		const ns = extractIdNamespaces(lines(planDoc));
		const b = ns.find((n) => n.prefix === "B");
		const inv = ns.find((n) => n.prefix === "FG-INV");
		expect(b?.uniqueCount).toBe(7);
		expect(b?.max).toBe(7);
		expect(inv?.max).toBe(28);
		const seven = extractCountClaims(lines(planDoc)).find(
			(c) => c.noun === "bets",
		);
		expect(seven?.value).toBe(7);
	});

	it("readme claims: six bets and range through 20", () => {
		const six = extractCountClaims(lines(readmeDoc)).find(
			(c) => c.noun === "bets",
		);
		expect(six).toEqual(
			expect.objectContaining({ value: 6, nounSingular: "bet", line: 2 }),
		);
		const range = extractRangeClaims(lines(readmeDoc));
		expect(range).toEqual([
			expect.objectContaining({ prefix: "FG-INV", from: 1, to: 20, line: 3 }),
		]);
	});
});

describe("id extraction hardening (round-7 ids-deep)", () => {
	it("does not harvest ids glued to Unicode words (round-7 #2)", () => {
		expect(extractIdNamespaces(["éREQ-1 éREQ-2"])).toEqual([]);
		expect(extractIdNamespaces(["REQ-1é REQ-2é"])).toEqual([]);
		expect(extractIdNamespaces(["𝐀B1 𝐀B2 𝐀B3"])).toEqual([]);
		expect(extractIdNamespaces(["B1́ B2́ B3́"])).toEqual([]);
	});

	it("keeps ASCII-delimited and punctuation-adjacent ids (round-7 #2)", () => {
		expect(extractIdNamespaces(["REQ-1 REQ-2"])[0]?.prefix).toBe("REQ");
		expect(
			extractIdNamespaces(["(REQ-1) (REQ-2)"])[0]?.ids.map((i) => i.num),
		).toEqual([1, 2]);
		expect(extractIdNamespaces(["B1, B2, B7."])[0]?.uniqueCount).toBe(3);
	});

	it("treats an unpaired low surrogate as boundary, not glue (round-7 #2)", () => {
		const ns = extractIdNamespaces(["x\uDC00REQ-1 x\uDC00REQ-2"]);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 2]);
	});

	it("stays near-linear when one line repeats thousands of range claims (round-7 #3)", () => {
		const line = "A-1 through A-2; ".repeat(30_000);
		const start = Date.now();
		expect(extractIdNamespaces([line])).toEqual([]);
		expect(Date.now() - start).toBeLessThan(1500);
	});

	it("keeps outside-span ids with multiple claims on one line (round-7 #3)", () => {
		const ns = extractIdNamespaces([
			"| X-01 | X-04 through X-06; X-07 through X-09 |",
			"| X-02 | r |",
		]);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 2]);
	});

	it("handles caller-supplied unsorted and overlapping spans (round-7 #3)", () => {
		const mk = (col: number, raw: string) => ({
			prefix: "X",
			style: "dashed" as const,
			from: 2,
			to: 3,
			toExplicit: true,
			raw,
			line: 1,
			col,
		});
		// Unsorted + overlapping spans: [12,18) then [9,14). X-01 (col 2) stays;
		// X-02 (col 9) and X-03 (col 14) are excluded.
		const ns = extractIdNamespaces(
			["| X-01 | X-02 X-03 |", "| X-05 | r |"],
			[mk(12, "X-03 x"), mk(9, "X-02 ")],
		);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 5]);
	});

	it("filtered leading tokens still block trailing definition credit (round-7 #4)", () => {
		const ns = extractIdNamespaces(["| HTTP-200 | see REQ-1 |", "| REQ-2 | b |"]);
		const reqs = ns[0]?.ids ?? [];
		expect(reqs.find((i) => i.num === 1)?.defSites).toEqual([]);
		expect(reqs.find((i) => i.num === 2)?.defSites).toEqual([2]);
	});

	it("a year-filtered leading token blocks def credit too (round-7 #4)", () => {
		const ns = extractIdNamespaces(["| CVE-2024 | REQ-1 note |", "- REQ-2 x"]);
		expect(ns[0]?.ids.find((i) => i.num === 1)?.defSites).toEqual([]);
	});

	it("a glue-rejected leading token blocks def credit (round-7 #2+#4)", () => {
		const ns = extractIdNamespaces(["| éREQ-9 | REQ-1 |", "| REQ-2 | b |"]);
		expect(ns[0]?.ids.find((i) => i.num === 1)?.defSites).toEqual([]);
	});

	it("blocks loose-id credit behind a filtered leader (round-7 #4)", () => {
		expect(extractLooseDefinedIds(["| HTTP-200 | see B7 |"])).toEqual([]);
	});

	it("still credits a valid leading id (round-7 #4 negative)", () => {
		const ns = extractIdNamespaces(["| REQ-1 | uses HTTP-200 |", "| REQ-2 | b |"]);
		expect(ns[0]?.ids.find((i) => i.num === 1)?.defSites).toEqual([1]);
		expect(extractLooseDefinedIds(["- B7 first"]).map((l) => l.num)).toEqual([7]);
	});

	it("keeps lone emphasis markers literal so deletion cannot fabricate ids (round-7 #5)", () => {
		expect(extractIdNamespaces(["- A*1", "- A*2", "- A*3"])).toEqual([]);
		expect(extractRangeClaims(["A*1 through A*9"])).toEqual([]);
		expect(extractIdNamespaces(["- A`1", "- A`2", "- A`3"])).toEqual([]);
		expect(extractRangeClaims(["A`1 through A`9"])).toEqual([]);
	});

	it("still strips word-edge paired emphasis and code spans (round-7 #5 negative)", () => {
		expect(extractRangeClaims(["**FG-INV-01** through **FG-INV-20** hold"])).toEqual([
			expect.objectContaining({ from: 1, to: 20 }),
		]);
		expect(extractRangeClaims(["`FG-INV-01` through `FG-INV-20` hold"])).toEqual([
			expect.objectContaining({ from: 1, to: 20 }),
		]);
		const ns = extractIdNamespaces(["| *REQ-1* | a |", "| *REQ-2* | b |"]);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 2]);
	});

	it("unbalanced marker runs stay literal without hiding real ids (round-7 #5)", () => {
		const ns = extractIdNamespaces(["**REQ-1* x", "**REQ-2* y"]);
		expect(ns[0]?.ids.map((i) => i.num)).toEqual([1, 2]);
	});

	it("code-span pairing is next-equal-run; inner runs stay literal (round-7 #5)", () => {
		expect(
			extractRangeClaims(["``FG-INV-01`` through ``FG-INV-20`` hold"]),
		).toEqual([expect.objectContaining({ from: 1, to: 20 })]);
	});
});

describe("branch-coverage batch (span merge, binary search)", () => {

	it("merges a range-claim span fully contained in a preceding span on the same line, and still excludes both endpoints", () => {
		// Two explicit spans on line 1: [4,7) then a CONTAINED [4,6) — sorted with
		// equal starts, the second's end (6) does not exceed the first's (7), so
		// sortAndMergeSpans must take its "keep existing end" branch rather than
		// growing it. Z-2 sits inside both; Z-1/Z-3/Z-4/Z-5 sit outside either.
		const doc = ["Z-1 Z-2 Z-3 Z-4 Z-5"];
		const rangeClaims = [
			{ prefix: "Z", style: "dashed" as const, from: 2, to: 2, toExplicit: false, raw: "Z-2", line: 1, col: 4 },
			{ prefix: "Z", style: "dashed" as const, from: 2, to: 2, toExplicit: false, raw: "Z-", line: 1, col: 4 },
		];
		const ns = extractIdNamespaces(doc, rangeClaims);
		expect(ns.find((n) => n.prefix === "Z")?.ids.map((i) => i.num)).toEqual([1, 3, 4, 5]);
	});

	it("binary-searches past a span that starts after the queried column (col < span start)", () => {
		// A custom range-claim placed AFTER the ids on the same line means the
		// lookup for each id's column must walk the low half of the search
		// (col < s), not just the high half — the only way to reach inSortedSpan's
		// `hi = mid - 1` arm.
		const doc = ["Z-1 Z-2 Z-3 filler filler filler"];
		const rangeClaims = [
			{ prefix: "Q", style: "dashed" as const, from: 1, to: 2, toExplicit: false, raw: "QQQQQ", line: 1, col: 20 },
		];
		const ns = extractIdNamespaces(doc, rangeClaims);
		expect(ns.find((n) => n.prefix === "Z")?.ids.map((i) => i.num)).toEqual([1, 2, 3]);
	});
});
