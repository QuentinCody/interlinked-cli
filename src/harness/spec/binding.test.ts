import { describe, expect, it } from "vitest";
import { claimBindsToNamespace, defLineSet, localNounBindings } from "./binding.js";
import { extractSpecFacts } from "./extract-facts.js";

const facts = (text: string) => extractSpecFacts(text, "docs/plan.md");

describe("claimBindsToNamespace", () => {
	it("binds via same-line co-occurrence", () => {
		const f = facts("Six bets (B1, B2, B7) compose.");
		const ns = f.namespaces[0];
		expect(ns).toBeDefined();
		if (!ns) return;
		const claim = f.countClaims[0];
		expect(claim && claimBindsToNamespace(claim, f, ns, defLineSet(ns))).toBe(true);
	});

	it("binds via heading-section containment, not mere presence elsewhere", () => {
		const f = facts(
			["## The six bets", "- B1 a", "- B2 b", "- B7 c", "## Other", "text"].join(
				"\n",
			),
		);
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim && claimBindsToNamespace(claim, f, ns, defLineSet(ns))).toBe(
			true,
		);
	});

	it("N-enum1: does not bind from ONE incidental id on the claim line (stop-digest FPs 2026-08-21)", () => {
		// "F9 — the --help audit lists 83 commands" is a findings-table row, not
		// a registry enumeration; binding command→F here flagged every "N
		// commands" claim repo-wide against the F census.
		const f = facts(["F9 — the audit lists 83 widgets in one screen.", "- F1 a", "- F2 b"].join("\n"));
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim ? claimBindsToNamespace(claim, f, ns, defLineSet(ns)) : null).toBe(
			false,
		);
	});

	it("P-enum1: still binds from a same-line enumeration of two or more ids", () => {
		const f = facts("Three gates (G1, G2) plus G7 compose.");
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim ? claimBindsToNamespace(claim, f, ns, defLineSet(ns)) : null).toBe(
			true,
		);
	});

	it("does not bind an unrelated noun", () => {
		const f = facts(["Six reasons this works.", "- W1 a", "- W2 b", "- W3 c"].join("\n"));
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim ? claimBindsToNamespace(claim, f, ns, defLineSet(ns)) : null).toBe(
			false,
		);
	});
});

describe("localNounBindings", () => {
	it("maps bound noun singulars to style-qualified prefixes", () => {
		const f = facts(["## The six bets", "- B1 a", "- B2 b", "- B7 c"].join("\n"));
		const b = localNounBindings(f);
		expect(b.get("bet")).toEqual(new Set(["compact B"]));
	});

	it("returns no bindings without co-occurrence evidence", () => {
		const f = facts(["Six reasons.", "- W1 a", "- W2 b", "- W3 c"].join("\n"));
		expect(localNounBindings(f).size).toBe(0);
	});
});

describe("heading-derived binding hardening (sol-max batch 1)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not bind a heading noun over prose-only (undefined) ids (#9)", () => {
		expect(bind("## Six bets\nB1, B2, and B3 were retired.")).toEqual([]);
	});

	it("binds only the deepest owning heading, not an ancestor (#10)", () => {
		expect(bind("# Protocol requirements\n## Bets\n- B1 a\n- B2 b\n- B3 c")).toEqual([
			"bet=>compact B",
		]);
	});

	it("includes the real registry noun from a multi-noun heading (#11)", () => {
		const b = bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c");
		expect(b).toContain("bet=>compact B");
	});

	it("count-claim path binds only the deepest owning heading, not an ancestor (round-4 #7)", () => {
		expect(bind("# Six protocol requirements\n## Bets\n- B1 a\n- B2 b\n- B3 c")).toEqual([
			"bet=>compact B",
		]);
	});

	it("does not bind a secondary heading noun that would fabricate drift (round-4 #8)", () => {
		expect(bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c")).toEqual(["bet=>compact B"]);
	});

	it("does not overflow the stack on a large registry (round-4 #9)", () => {
		const doc = ["## Bets", ...Array(130_000).fill("- B1"), "- B2", "- B3"].join("\n");
		expect(() => localNounBindings(facts(doc))).not.toThrow();
	});
});

describe("binding hardening (sol-max round 5)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not cross-bind nouns/namespaces packed on one ambiguous line (#10)", () => {
		const b = localNounBindings(
			facts("Six bets B1 B2 B3 B4 B5 B6 and four gates G1 G2 G3 G4"),
		);
		expect(b.get("bet")?.has("compact G") ?? false).toBe(false);
		expect(b.get("gate")?.has("compact B") ?? false).toBe(false);
	});

	it("binds when the earliest definition is on the heading line (#11)", () => {
		expect(bind("## Bets B1\n- B2\n- B3\nThree bets.")).toEqual(["bet=>compact B"]);
	});

	it("binds the real plural, skipping a singular -s modifier in the heading (#12)", () => {
		expect(bind("## Access policies\n- P1\n- P2\n- P3")).toEqual(["policy=>compact P"]);
	});

	it("binds in sub-cubic time across many namespaces × claims × headings (#1)", () => {
		const parts: string[] = [];
		for (let i = 0; i < 800; i++) {
			const p =
				String.fromCharCode(65 + (i % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 26) % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 676) % 26));
			parts.push(`## Section ${p}`, `- ${p}-1 x`, `- ${p}-2 y`, "three widgets");
		}
		const start = Date.now();
		localNounBindings(facts(parts.join("\n")));
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe("binding hardening (round 7)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not bind a heading when the registry's definitions straddle two sections (#27)", () => {
		expect(bind("## Bets\n- X1\n## Gates\n- X2\n- X3\nSix bets.")).toEqual([]);
	});

	it("public predicate rejects a straddled owner too (#27)", () => {
		const f = facts("## Bets\n- X1\n## Gates\n- X2\n- X3\nSix bets.");
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns && claim ? claimBindsToNamespace(claim, f, ns, defLineSet(ns)) : null).toBe(false);
	});

	it("does not bind on an even two-section split (#27)", () => {
		expect(bind("## Bets\n- X1\n- X2\n## Gates\n- X3\n- X4\nFour bets.")).toEqual([]);
	});

	it("still binds with one stray definition outside the owner section (#27)", () => {
		// 3-in/1-out is a strong majority — the changelog-recap shape keeps binding.
		expect(bind("## Bets\n- B1 a\n- B2 b\n- B3 c\n## Changelog\n- B3 was revised")).toEqual([
			"bet=>compact B",
		]);
	});

	it("keeps binding a fully-contained registry with prose mentions elsewhere (#27)", () => {
		expect(bind("## Bets\n- B1 a\n- B2 b\n- B3 c\n## Other\nB1 is neat.\nThree bets.")).toEqual([
			"bet=>compact B",
		]);
	});

	it("binds a fully-contained dashed registry (#27)", () => {
		expect(bind("## Reqs\n- REQ-1 a\n- REQ-2 b\nTwo reqs.")).toEqual(["req=>dashed REQ"]);
	});

	it("does not bind a claim on a line carrying ids of two namespaces (#28)", () => {
		const b = localNounBindings(facts("Six bets B1 B2 B3 B4 B5 B6 use gates G1 G2 G3."));
		expect(b.get("bet")?.has("compact G") ?? false).toBe(false);
		expect(b.get("bet")?.has("compact B") ?? false).toBe(false);
	});

	it("public predicate treats the one-claim two-namespace line as ambiguous (#28)", () => {
		const f = facts("Six bets B1 B2 B3 B4 B5 B6 use gates G1 G2 G3.");
		expect(f.namespaces.length).toBe(2);
		const claim = f.countClaims[0];
		for (const ns of f.namespaces) {
			expect(claim && claimBindsToNamespace(claim, f, ns, defLineSet(ns))).toBe(false);
		}
	});

	it("same-line binding still works with a single namespace on the line (#28)", () => {
		expect(bind("Six bets B1 B2 B3 B4 B5 B6 anchor the plan.")).toEqual(["bet=>compact B"]);
	});

	it("an ambiguous line falls back to the heading path (#28)", () => {
		expect(
			bind(["## Bets", "- B1 a", "- B2 b", "- B3 c", "Six bets B1 B2 use gates G1 G2 G3."].join("\n")),
		).toEqual(["bet=>compact B"]);
	});

	it("claims on separate single-namespace lines bind independently (#28)", () => {
		expect(bind("Six bets B1 B2 B3.\nFour gates G1 G2 G3.")).toEqual([
			"bet=>compact B",
			"gate=>compact G",
		]);
	});

	it("does not bind a count claim to a secondary heading noun (#29)", () => {
		expect(bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c\nSix owners run these.")).toEqual([
			"bet=>compact B",
		]);
	});

	it("does not fabricate drift from a secondary noun that names another registry (#29)", () => {
		expect(bind("## Bets and gates\n- B1 a\n- B2 b\n- B3 c\nSix gates.")).toEqual(["bet=>compact B"]);
	});

	it("binds a claim that names the heading's registry noun (#29)", () => {
		expect(bind("## Bets and owners\n- B1 a\n- B2 b\n- B3 c\nSix bets are placed.")).toEqual([
			"bet=>compact B",
		]);
	});

	it("matches claim and heading through shared singularization (#29)", () => {
		expect(bind("## Indexes\n- IDX-1 a\n- IDX-2 b\nTwo indices exist.")).toEqual(["index=>dashed IDX"]);
	});

	it("does not bind a claim noun absent from the heading (#29)", () => {
		expect(bind("## Bets\n- B1 a\n- B2 b\n- B3 c\nSix widgets exist.")).toEqual(["bet=>compact B"]);
	});

	it("evaluates 300 namespaces x 300 claims through the public predicate in bounded time (#30)", () => {
		const parts: string[] = [];
		for (let i = 0; i < 300; i++) {
			const p =
				String.fromCharCode(65 + (i % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 26) % 26)) +
				String.fromCharCode(65 + (Math.floor(i / 676) % 26));
			parts.push(`## Zone ${p}`, `- ${p}-1 x`, `- ${p}-2 y`);
		}
		for (let i = 0; i < 300; i++) parts.push("three gadgets here");
		const f = facts(parts.join("\n"));
		const start = Date.now();
		for (const ns of f.namespaces) {
			const defLines = defLineSet(ns);
			for (const claim of f.countClaims) claimBindsToNamespace(claim, f, ns, defLines);
		}
		// Current unmemoized code runs this in ~1460ms; the memoized path measured 6ms.
		expect(Date.now() - start).toBeLessThan(500);
	});

	it("memoized and fresh-set public calls agree (#30)", () => {
		const f = facts("## The six bets\n- B1 a\n- B2 b\n- B7 c");
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns).toBeDefined();
		if (!ns || !claim) return;
		const defLines = defLineSet(ns);
		expect(claimBindsToNamespace(claim, f, ns, defLines)).toBe(true);
		expect(claimBindsToNamespace(claim, f, ns, defLines)).toBe(true);
		expect(claimBindsToNamespace(claim, f, ns, defLineSet(ns))).toBe(true);
	});

	it("memoization does not leak across facts objects (#30)", () => {
		const doc = "## Bets\n- X1\n## Gates\n- X2\n- X3\nSix bets.";
		const run = (f: ReturnType<typeof facts>): boolean | null => {
			const ns = f.namespaces[0];
			const claim = f.countClaims[0];
			return ns && claim ? claimBindsToNamespace(claim, f, ns, defLineSet(ns)) : null;
		};
		expect(run(facts(doc))).toBe(false);
		expect(run(facts(doc))).toBe(false);
	});

	it("negative verdicts stay stable under repeated memoized queries (#30)", () => {
		// "## Core" has no plural registry noun, so the stored-null memo path is hit.
		const f = facts("## Core\n- C1 x\n- C2 y\n- C3 z\nThree cores.");
		const ns = f.namespaces[0];
		const claim = f.countClaims[0];
		expect(ns).toBeDefined();
		if (!ns || !claim) return;
		const defLines = defLineSet(ns);
		expect(claimBindsToNamespace(claim, f, ns, defLines)).toBe(false);
		expect(claimBindsToNamespace(claim, f, ns, defLines)).toBe(false);
		expect(localNounBindings(f).size).toBe(0);
	});
});

describe("heading binding uses rendered text, not raw markdown (round-7 #10)", () => {
	const bind = (text: string) =>
		[...localNounBindings(facts(text))].map(([k, v]) => `${k}=>${[...v].join(",")}`);

	it("does not bind a noun from a link destination in the heading", () => {
		expect(bind("## [Registry](bets.md)\n- B1 a\n- B2 b\n- B3 c")).toEqual([]);
	});

	it("does not bind a noun from an HTML comment in the heading", () => {
		expect(bind("## <!-- owners --> Bets\n- B1 a\n- B2 b\n- B3 c")).toEqual(["bet=>compact B"]);
	});
});
