import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";
import { resolveRelativeTarget } from "./ledger-xref.js";

const never = (): boolean => false;

// The archived Sol corpus shape (audit findings D-1/D-2): the plan is the
// registry home; README states counts/ranges without enumerating ids.
const PLAN = [
	"# Plan",
	"## The seven bets",
	"| **B1** | Chronicle |",
	"| **B2** | Strata |",
	"| **B3** | Loom |",
	"| **B4** | Ripple |",
	"| **B5** | Determinism |",
	"| **B6** | Warden |",
	"| **B7** | Sextant |",
	"## Invariants",
	"| FG-INV-01 | truth |",
	"| FG-INV-20 | scope |",
	"| FG-INV-28 | replay |",
].join("\n");

const README = [
	"# README",
	"The composition of six bets does the work.",
	"Every invariant (FG-INV-01 through FG-INV-20) has a live checker.",
	"See [the plan](./PLAN.md#the-seven-bets) and [gone](./PLAN.md#nope).",
	"Also [missing doc](./docs/absent.md) is referenced.",
].join("\n");

describe("SpecLedger cross-file drift (Sol D-1/D-2 acceptance)", () => {
	const ledger = SpecLedger.fromContents("/repo", { "PLAN.md": PLAN, "README.md": README }, never);

	it("reproduces D-1: README count claim vs plan census", () => {
		const d1 = ledger
			.computeDrift()
			.filter((f) => f.kind === "count_claim_drift");
		expect(d1).toEqual([
			expect.objectContaining({
				file: "README.md",
				line: 2,
				relatedFiles: ["PLAN.md"],
				message: expect.stringContaining("7 distinct ids"),
			}),
		]);
	});

	it("reproduces D-2: README range claim vs plan census max", () => {
		const d2 = ledger
			.computeDrift()
			.filter((f) => f.kind === "range_claim_drift");
		expect(d2).toEqual([
			expect.objectContaining({
				file: "README.md",
				line: 3,
				message: expect.stringContaining("FG-INV-28"),
			}),
		]);
	});

	it("does not flag an intentional cross-file SUB-range (round-broaden sol #2)", () => {
		// README's "FG-INV-05 through FG-INV-20" starts above the census min (1),
		// so it's a slice, not a full-registry claim — no range_claim_drift.
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"PLAN.md": ["| FG-INV-01 | a |", "| FG-INV-20 | b |", "| FG-INV-28 | c |"].join("\n"),
				"README.md": "Examples FG-INV-05 through FG-INV-20 illustrate the flow.",
			},
			never,
		);
		expect(l.computeDrift().filter((f) => f.kind === "range_claim_drift")).toEqual([]);
	});

	it("finds broken cross-file anchors but honors valid ones", () => {
		const xrefs = ledger.computeDrift().filter((f) => f.kind.startsWith("xref"));
		expect(xrefs).toEqual([
			expect.objectContaining({
				kind: "xref_missing_anchor",
				file: "README.md",
				line: 4,
				message: expect.stringContaining('"nope"'),
			}),
			expect.objectContaining({
				kind: "xref_missing_file",
				line: 5,
				message: expect.stringContaining("docs/absent.md"),
			}),
		]);
	});

	it("scopes drift to findings involving one file (per-edit query)", () => {
		// Editing the PLAN surfaces README's stale claims via relatedFiles.
		const scoped = ledger.computeDrift("PLAN.md");
		expect(scoped.some((f) => f.kind === "count_claim_drift")).toBe(true);
		// A file uninvolved in any finding scopes to nothing.
		const ledger2 = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": README, "OTHER.md": "# Other\nplain text" },
			never,
		);
		expect(ledger2.computeDrift("OTHER.md")).toEqual([]);
	});

	it("goes quiet when the claim is fixed (refreshFile dirty layer)", () => {
		const l = SpecLedger.fromContents("/repo", { "PLAN.md": PLAN, "README.md": README }, never);
		l.refreshFile(
			"README.md",
			README.replace("six bets", "seven bets").replace(
				"FG-INV-01 through FG-INV-20",
				"FG-INV-01 through FG-INV-28",
			),
		);
		const kinds = l.computeDrift().map((f) => f.kind);
		expect(kinds).not.toContain("count_claim_drift");
		expect(kinds).not.toContain("range_claim_drift");
	});

	it("incidental prose citations never suppress cross-file drift (round-4 #8/#9)", () => {
		const readmeWithCitations = [
			"# README",
			"Six bets compose the system; B1 and B2 are described below.",
			"FG-INV-01 through FG-INV-20 are checked; FG-INV-28 is discussed separately.",
		].join("\n");
		const l = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": readmeWithCitations },
			never,
		);
		const kinds = l.computeDrift("README.md").map((f) => f.kind);
		expect(kinds).toContain("count_claim_drift");
		expect(kinds).toContain("range_claim_drift");
	});

	it("does not cross-compare an ambiguous shared noun across files (round-2 #19)", () => {
		// "phase" binds to W in one doc and P in another — a correct "three
		// phases" (W1–W3) claim must not be compared against the P1–P4 registry.
		const wDoc = ["# A", "## Three phases", "- W1 x", "- W2 y", "- W3 z"].join("\n");
		const pDoc = ["# B", "## Four phases", "- P1 a", "- P2 b", "- P3 c", "- P4 d"].join("\n");
		const l = SpecLedger.fromContents("/repo", { "a.md": wDoc, "b.md": pDoc }, never);
		expect(l.computeDrift().filter((f) => f.kind === "count_claim_drift")).toEqual([]);
	});

	it("still fires an unambiguous cross-file count claim (D-1 preserved)", () => {
		// "bet" binds to exactly one namespace (B); README has no local B ids
		// yet the claim must still be checked against the plan's registry.
		const l = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": "# R\nThe composition of six bets does the work." },
			never,
		);
		expect(l.computeDrift().some((f) => f.kind === "count_claim_drift")).toBe(true);
	});

	it("folds a sub-threshold registry fragment from another file into the census (sol-max #1)", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"plan.md": "## The bets\n- B1 a\n- B2 b\n- B3 c\n- B4 d\n- B5 e\n- B6 f",
				"addon.md": "- B7 extra", // lone defined B7 — below the per-file threshold
				"readme.md": "There are six bets.",
			},
			never,
		);
		// The census reaches B7 (6+1), so "six bets" is stale.
		const count = l.computeDrift().filter((f) => f.kind === "count_claim_drift");
		expect(count).toEqual([
			expect.objectContaining({ file: "readme.md", message: expect.stringContaining("7 distinct") }),
		]);
	});

	it("does not fabricate a census from a lone fragment with no qualifying home (sol-max #1 FP-safe)", () => {
		const l = SpecLedger.fromContents("/repo", { "a.md": "- Z9 lonely\nThere are five zebras." }, never);
		expect(l.computeDrift().filter((f) => f.kind === "count_claim_drift")).toEqual([]);
	});

	it("binds a plain-heading registry (no own count claim) to a cross-file claim (sol-max #2)", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"plan.md": "## Bets\n- B1 a\n- B2 b\n- B3 c\n- B4 d\n- B5 e\n- B6 f\n- B7 g",
				"readme.md": "There are six bets.",
			},
			never,
		);
		// "## Bets" over B1..B7 binds bet→B even without a count claim in plan.md.
		expect(l.computeDrift().some((f) => f.kind === "count_claim_drift")).toBe(true);
	});

	it("does not double-report a purely-local contradiction the inline check owns (sol-max #13)", () => {
		// W1/W2/W3 appear ONLY in prose (no definition-shaped lines) with a
		// disagreeing count claim, all in one file. The cross-file ledger must stay
		// silent — the inline single-file check owns purely-local contradictions and
		// fires regardless of definition sites (the old hasDefSites gate leaked here).
		const doc = "The phases W1, W2, and W3 are done. There are four phases total.";
		const l = SpecLedger.fromContents("/repo", { "a.md": doc }, never);
		expect(l.computeDrift().filter((f) => f.kind === "count_claim_drift")).toEqual([]);
	});

	it("skips an ambiguous count claim when several candidate registries are local (sol-max #14)", () => {
		// "phase" binds to BOTH W and P (same heading section), and BOTH are
		// enumerated in the file that makes the "five phases" claim; siblings extend
		// each census so neither is purely-local. The claim can't be attributed to
		// one registry, so the ledger must not compare it against either.
		const claimDoc = ["## Five phases", "- W1 a", "- W2 b", "- W3 c", "- P1 d", "- P2 e", "- P3 f"].join("\n");
		const extDoc = ["- W4 a", "- W5 b", "- W6 c", "- P4 d", "- P5 e", "- P6 f", "- P7 g"].join("\n");
		const l = SpecLedger.fromContents("/repo", { "a.md": claimDoc, "ext.md": extDoc }, never);
		expect(l.computeDrift().filter((f) => f.kind === "count_claim_drift")).toEqual([]);
	});

	it("does not report an existing-but-unwalked markdown target as missing (round-2 #18)", () => {
		// The walk excludes directories / depth-skips / won't follow symlinks, so
		// a markdown target absent from the file map may still exist on disk.
		const doc = "# Doc\nSee [guide](./vendor/guide.md) for details.";
		const existsGuide = (abs: string): boolean => abs.endsWith("/vendor/guide.md");
		const l = SpecLedger.fromContents("/repo", { "doc.md": doc }, existsGuide);
		expect(l.computeDrift().filter((f) => f.kind === "xref_missing_file")).toEqual([]);
		// A target that truly does not exist is still reported.
		const l2 = SpecLedger.fromContents("/repo", { "doc.md": doc }, never);
		expect(
			l2.computeDrift().some((f) => f.kind === "xref_missing_file"),
		).toBe(true);
	});

	it("never double-reports same-file disagreement (single-file check's beat)", () => {
		// Plan says "seven bets" AND holds B1..B7 (agrees). A same-file
		// contradiction is spec_count_claim territory, not the ledger's.
		const selfContradicting = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN.replace("The seven bets", "The six bets") },
			never,
		);
		expect(selfContradicting.computeDrift()).toEqual([]);
	});
});

describe("declared fact drift", () => {
	it("fires one finding per involved file when values disagree", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
				"b.md": "cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
				"c.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			},
			never,
		);
		const facts = l.computeDrift().filter((f) => f.kind === "declared_fact_drift");
		expect(facts.map((f) => f.file).sort()).toEqual(["a.md", "b.md", "c.md"]);
		expect(facts[0]?.message).toContain("a.md:1=500");
		expect(facts[0]?.message).toContain("b.md:1=800");
	});

	it("bounds output for a marker repeated across many files (round-broaden #5 / sol-max #5)", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 40; i++) {
			files[`f${i}.md`] = `cap <!-- fact:line_cap -->${i % 2 === 0 ? "500" : "800"}<!-- /fact:line_cap -->`;
		}
		const l = SpecLedger.fromContents("/repo", files, never);
		const facts = l.computeDrift().filter((f) => f.kind === "declared_fact_drift");
		// Findings capped (one per file, ≤ FACT_FINDING_CAP), and the summary is
		// representative — it names BOTH contradicting values, not O(N) sites.
		expect(facts.length).toBeLessThanOrEqual(10);
		expect(facts[0]?.message).toContain("=500");
		expect(facts[0]?.message).toContain("=800");
	});

	it("keeps the contradictory file/value even behind a long leading same-value run (sol-max #5)", () => {
		const files: Record<string, string> = {};
		// 20 identical 500 sites, then one 800 — the 800 (and b.md) must survive.
		for (let i = 0; i < 20; i++) {
			files[`a${i}.md`] = `cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->`;
		}
		files["b.md"] = `cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->`;
		const l = SpecLedger.fromContents("/repo", files, never);
		const drift = l.computeDrift();
		expect(drift.some((f) => f.file === "b.md" && f.kind === "declared_fact_drift")).toBe(true);
		expect(drift.find((f) => f.kind === "declared_fact_drift")?.message).toContain("=800");
		// A scoped query on the disagreeing file is no longer empty.
		expect(l.computeDrift("b.md").length).toBeGreaterThan(0);
	});

	it("stays quiet when all declared values agree", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
				"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			},
			never,
		);
		expect(l.computeDrift()).toEqual([]);
	});
});

describe("ledger maintenance", () => {
	it("removeFile drops a file's facts and its findings", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": README },
			never,
		);
		expect(l.computeDrift().length).toBeGreaterThan(0);
		l.removeFile("README.md");
		expect(l.fileCount).toBe(1);
		expect(l.computeDrift().filter((f) => f.file === "README.md")).toEqual([]);
	});

	it("refreshFile ignores non-markdown paths", () => {
		const l = SpecLedger.fromContents("/repo", {}, never);
		l.refreshFile("src/code.ts", "# not markdown");
		expect(l.fileCount).toBe(0);
	});

	it("refreshFile with unchanged content is a version no-op (round-2 #15)", () => {
		const l = SpecLedger.fromContents("/repo", { "a.md": PLAN }, never);
		l.computeDrift(); // warm the census/binding memos
		const v = l.versionForTesting();
		l.refreshFile("a.md", PLAN); // identical content — the redundant refresh
		expect(l.versionForTesting()).toBe(v); // no bump ⇒ memos survive
		// A real content change still bumps the version.
		l.refreshFile("a.md", `${PLAN}\n| **B8** | Extra |`);
		expect(l.versionForTesting()).toBeGreaterThan(v);
	});

	it("fileList exposes every ledger path", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": README },
			never,
		);
		expect(l.fileList().sort()).toEqual(["PLAN.md", "README.md"]);
	});

	it("previewWithFile computes hypothetical drift without mutating state", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{ "PLAN.md": PLAN, "README.md": README },
			never,
		);
		const before = l.computeDrift().length;
		const preview = l.previewWithFile(
			"README.md",
			README.replace("six bets", "seven bets").replace(
				"FG-INV-01 through FG-INV-20",
				"FG-INV-01 through FG-INV-28",
			),
		);
		expect(
			preview.computeDrift("README.md").filter((f) => f.kind.endsWith("_drift")),
		).toEqual([]);
		// The real ledger is untouched — a denied write leaves no residue.
		expect(l.computeDrift().length).toBe(before);
	});
});

describe("pre-gate queries", () => {
	it("declaredFactNamesInDisagreement reports only disagreeing names", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "<!-- fact:cap -->500<!-- /fact:cap --> <!-- fact:tz -->utc<!-- /fact:tz -->",
				"b.md": "<!-- fact:cap -->800<!-- /fact:cap --> <!-- fact:tz -->utc<!-- /fact:tz -->",
			},
			never,
		);
		expect(l.declaredFactNamesInDisagreement()).toEqual(new Set(["cap"]));
	});

	it("declaredFactValuesElsewhere excludes the asking file (round-5 #2)", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "<!-- fact:cap -->500<!-- /fact:cap -->",
				"b.md": "<!-- fact:cap -->800<!-- /fact:cap -->",
			},
			never,
		);
		expect(l.declaredFactValuesElsewhere("cap", "a.md")).toEqual(new Set(["800"]));
		expect(l.declaredFactValuesElsewhere("cap", "c.md")).toEqual(
			new Set(["500", "800"]),
		);
		expect(l.declaredFactValuesElsewhere("missing", "a.md")).toEqual(new Set());
	});

	it("externalReferrersTo finds other files' links to the given slugs", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"docs/plan.md": "# Plan\n## Storage Model",
				"README.md": "see [storage](./docs/plan.md#storage-model) and [x](#storage-model)",
			},
			never,
		);
		expect(l.externalReferrersTo("docs/plan.md", new Set(["storage-model"]))).toEqual([
			{ file: "README.md", line: 1, anchor: "storage-model" },
		]);
		expect(l.externalReferrersTo("docs/plan.md", new Set(["other"]))).toEqual([]);
	});
});

describe("resolveRelativeTarget", () => {
	it("resolves ./, nested, and parent-relative targets", () => {
		expect(resolveRelativeTarget("docs/design/a.md", "./b.md")).toBe(
			"docs/design/b.md",
		);
		expect(resolveRelativeTarget("docs/a.md", "../README.md")).toBe("README.md");
		expect(resolveRelativeTarget("a.md", "docs/plan.md")).toBe("docs/plan.md");
	});

	it("returns null for targets escaping the repo root", () => {
		expect(resolveRelativeTarget("a.md", "../../etc/passwd")).toBeNull();
	});

	it("strips URL query/fragment and decodes escapes (sol-max #15)", () => {
		expect(resolveRelativeTarget("docs/a.md", "./guide.md?view=1#intro")).toBe(
			"docs/guide.md",
		);
		expect(resolveRelativeTarget("a.md", "my%20file.md")).toBe("my file.md");
	});
});

describe("filesystem walk (build)", () => {
	const root = mkdtempSync(join(tmpdir(), "spec-ledger-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("walks markdown files, skips excluded dirs, counts files", () => {
		mkdirSync(join(root, "docs"));
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "README.md"), "# Root\nSix bets: B1 B2 B7.");
		writeFileSync(join(root, "docs", "plan.md"), "# Plan");
		writeFileSync(join(root, "node_modules", "x.md"), "# Vendored");
		writeFileSync(join(root, "code.ts"), "export {}");
		const l = SpecLedger.build(root, never);
		expect(l.fileCount).toBe(2);
		expect(l.factsOf("docs/plan.md")).toBeDefined();
		expect(l.factsOf("node_modules/x.md")).toBeUndefined();
		expect(l.wasTruncated).toBe(false);
		expect(l.skippedCount).toBe(0);
	});

	it("size-skipped markdown targets are never reported missing (round-4 #2)", () => {
		const big = mkdtempSync(join(tmpdir(), "spec-ledger-big-"));
		try {
			writeFileSync(
				join(big, "huge.md"),
				`# Huge\n${"x".repeat(2 * 1024 * 1024 + 1)}`,
			);
			writeFileSync(
				join(big, "README.md"),
				"# Root\nSee [the huge plan](./huge.md#intro) and [gone](./absent.md).",
			);
			const l = SpecLedger.build(big, () => false);
			expect(l.skippedCount).toBe(1);
			const xrefs = l.computeDrift().filter((f) => f.kind === "xref_missing_file");
			expect(xrefs.map((f) => f.message)).toEqual([
				expect.stringContaining("absent.md"),
			]);
		} finally {
			rmSync(big, { recursive: true, force: true });
		}
	});
});

describe("computeDrift scoping (sol-max #19)", () => {
	const SEVEN_BETS = [
		"## The seven bets",
		"- B1 a",
		"- B2 b",
		"- B3 c",
		"- B4 d",
		"- B5 e",
		"- B6 f",
		"- B7 g",
	].join("\n");

	const SEVEN_GATES = [
		"## The seven gates",
		"- G1 a",
		"- G2 b",
		"- G3 c",
		"- G4 d",
		"- G5 e",
		"- G6 f",
		"- G7 g",
	].join("\n");

	it("scopes count drift to the edited file, dropping unrelated registries", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				// Two independent cross-file pairs: bets (plan↔readme), gates (gates↔notes).
				"plan.md": SEVEN_BETS,
				"readme.md": "The composition of six bets does the work.",
				"gates.md": SEVEN_GATES,
				"notes.md": "We ship six gates in total.",
			},
			never,
		);
		// Scoped to plan.md: README's "six bets" (related to plan.md) is kept; the
		// unrelated gates pair is never even computed.
		const scoped = l.computeDrift("plan.md").filter((f) => f.kind === "count_claim_drift");
		expect(scoped.map((f) => f.file)).toEqual(["readme.md"]);
		const all = l.computeDrift().filter((f) => f.kind === "count_claim_drift");
		expect(all.map((f) => f.file).sort()).toEqual(["notes.md", "readme.md"]);
	});

	it("keeps a finding anchored in the scoped file even with no local ids", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{ "plan.md": SEVEN_BETS, "readme.md": "The composition of six bets does the work." },
			never,
		);
		const scoped = l.computeDrift("readme.md").filter((f) => f.kind === "count_claim_drift");
		expect(scoped.map((f) => f.file)).toEqual(["readme.md"]);
	});

	it("scopes declared-fact drift to names the edited file declares", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "cap <!-- fact:line_cap -->1<!-- /fact:line_cap -->",
				"b.md": "cap <!-- fact:line_cap -->2<!-- /fact:line_cap -->",
				"c.md": "port <!-- fact:port -->8<!-- /fact:port -->",
				"d.md": "port <!-- fact:port -->9<!-- /fact:port -->",
			},
			never,
		);
		const scoped = l.computeDrift("a.md").filter((f) => f.kind === "declared_fact_drift");
		expect(scoped.length).toBeGreaterThan(0);
		expect(scoped.every((f) => f.message.includes("line_cap"))).toBe(true);
		expect(scoped.some((f) => f.message.includes("port"))).toBe(false);
	});

	it("scopes xref drift to links from or to the edited file", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": "# A\nSee [b](./b.md#gone).",
				"b.md": "# B\ntext",
				"c.md": "# C\nSee [d](./d.md).",
			},
			never,
		);
		const fromA = l.computeDrift("a.md");
		expect(fromA.filter((f) => f.kind === "xref_missing_anchor").map((f) => f.file)).toEqual(["a.md"]);
		// The unrelated c→d missing-file is excluded from a.md's scope.
		expect(fromA.some((f) => f.kind === "xref_missing_file")).toBe(false);
		// Scoped to the TARGET: the a→b#gone anchor finding still surfaces.
		const toB = l.computeDrift("b.md").filter((f) => f.kind === "xref_missing_anchor");
		expect(toB.map((f) => f.file)).toEqual(["a.md"]);
	});
});

describe("bounded walk (sol-max #22/#24)", () => {
	it("records a subtree past the depth cap and never mis-reports a deep target", () => {
		const root = mkdtempSync(join(tmpdir(), "spec-deep-"));
		try {
			// Build a chain deeper than MAX_DEPTH (8) with a markdown file at the bottom.
			let dir = root;
			for (let i = 0; i < 10; i++) {
				dir = join(dir, `d${i}`);
				mkdirSync(dir);
			}
			writeFileSync(join(dir, "deep.md"), "# Deep");
			writeFileSync(
				join(root, "README.md"),
				"# Root\nSee [deep](./d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/deep.md).",
			);
			// fileExists is ground truth: the deep target is on disk, so no missing-file.
			const exists = (abs: string): boolean => abs.endsWith("/deep.md");
			const l = SpecLedger.build(root, exists);
			expect(l.skippedCount).toBeGreaterThan(0); // the omitted deep subtree is recorded
			expect(l.computeDrift().filter((f) => f.kind === "xref_missing_file")).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records unreadable directories and files without crashing", () => {
		if (process.getuid?.() === 0) return; // root bypasses chmod, can't simulate EACCES
		const root = mkdtempSync(join(tmpdir(), "spec-perm-"));
		const badDir = join(root, "locked");
		const badFile = join(root, "locked.md");
		try {
			mkdirSync(badDir);
			writeFileSync(join(badDir, "inner.md"), "# Inner");
			writeFileSync(badFile, "# Locked");
			chmodSync(badDir, 0o000);
			chmodSync(badFile, 0o000);
			const l = SpecLedger.build(root, () => false);
			// Unreadable dir (readdir throws) + unreadable file (readFile throws) are
			// both recorded, not fatal — an advisory walker keeps going.
			expect(l.skippedCount).toBeGreaterThanOrEqual(2);
		} finally {
			chmodSync(badDir, 0o755);
			chmodSync(badFile, 0o644);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
