import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";
import { SpecLedger } from "./ledger.js";
import { buildAgenda, coverageGaps, writeReviewAgenda } from "./review-agenda.js";

const never = (): boolean => false;
const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const pad = "Detail sentence to pass the stub threshold. ".repeat(12);
const FORMAT_DOC = [
	"# Chronicle",
	"## Marker wire format",
	pad,
	"Records are framed with a length prefix and a crc32 checksum per frame.",
	pad,
	"## Retention",
	"Old capsules are reclaimed on a schedule.",
].join("\n");

describe("coverageGaps (contract templates, §7.2)", () => {
	it("emits missing concerns for a recognized kind (P0-3 shape)", () => {
		const facts = extractSpecFacts(FORMAT_DOC, "plan.md");
		const gaps = coverageGaps(facts, FORMAT_DOC, "plan.md");
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.title).toContain("Marker wire format");
		expect(gaps[0]?.title).toContain("versioning/migration");
		expect(gaps[0]?.title).toContain("torn-write/partial-tail");
		// Checksum IS addressed — never listed as missing.
		expect(gaps[0]?.title).not.toContain("checksum");
	});

	it("stays silent for fully-covered sections, stubs, and unrecognized kinds", () => {
		const covered = [
			"## Record format",
			pad,
			"Versioned with migration notes; little-endian; torn writes select the",
			"older valid frame by checksum; upgrade path documented.",
			pad,
		].join("\n");
		expect(
			coverageGaps(extractSpecFacts(covered, "a.md"), covered, "a.md"),
		).toEqual([]);
		const stub = "## Wire format\nTBD.";
		expect(coverageGaps(extractSpecFacts(stub, "a.md"), stub, "a.md")).toEqual([]);
		const prose = `## Motivation\n${pad}`;
		expect(coverageGaps(extractSpecFacts(prose, "a.md"), prose, "a.md")).toEqual([]);
	});
});

describe("buildAgenda + writeReviewAgenda (§7.3)", () => {
	it("emits compose-checks for entities constrained from multiple files", () => {
		const contents = new Map([
			["plan.md", "| FG-INV-01 | a |\n| FG-INV-02 | b |"],
			["agents.md", "Rules follow FG-INV-01 and FG-INV-07 strictly."],
		]);
		const ledger = SpecLedger.fromContents(
			"/repo",
			Object.fromEntries(contents),
			never,
		);
		const items = buildAgenda({ ledger, contents, openFindings: [] });
		const compose = items.filter((i) => i.kind === "compose_check");
		expect(compose).toHaveLength(1);
		expect(compose[0]?.title).toContain("namespace FG-INV");
		expect(compose[0]?.title).toContain("2 files");
	});

	it("emits a compose-check for a declared fact bound from two files", () => {
		const marker = "<!-- fact:line_cap -->500<!-- /fact:line_cap -->";
		const contents = new Map([
			["docs/policy.md", `The cap is ${marker} lines.`],
			["docs/harness.md", `The gate refuses a write past ${marker} lines.`],
		]);
		const ledger = SpecLedger.fromContents(
			"/repo",
			Object.fromEntries(contents),
			never,
		);
		const items = buildAgenda({ ledger, contents, openFindings: [] });
		const compose = items.filter((i) => i.kind === "compose_check");
		expect(compose).toHaveLength(1);
		expect(compose[0]?.title).toBe(
			"fact:line_cap is constrained from 2 files — verify the constraints compose",
		);
		expect(compose[0]?.sites).toEqual(["docs/policy.md:1", "docs/harness.md:1"]);
	});

	it("renders the agenda artifact with drift and open findings", () => {
		const cwd = mkdtempSync(join(tmpdir(), "agenda-"));
		roots.push(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const contents = new Map([
			["plan.md", "## The seven bets\n- B1 a\n- B2 b\n- B3 c\n- B4 d\n- B5 e\n- B6 f\n- B7 g"],
			["readme.md", "The composition of six bets does the work."],
		]);
		const ledger = SpecLedger.fromContents(cwd, Object.fromEntries(contents), never);
		const items = buildAgenda({ ledger, contents, openFindings: [] });
		const path = writeReviewAgenda(cwd, items, ["F-9 docs/x.md:2 — stale claim"]);
		const rendered = readFileSync(path, "utf8");
		expect(rendered).toContain("# Review agenda");
		expect(rendered).toContain("Outstanding deterministic drift");
		expect(rendered).toContain("six bets");
		expect(rendered).toContain("Open review findings");
		expect(rendered).toContain("F-9");
	});
});
