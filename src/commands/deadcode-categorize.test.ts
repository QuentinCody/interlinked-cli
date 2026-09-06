// Tests for the dead-code categorizer (operator decision 2026-08-17):
// candidates sort into mechanically-derived buckets so deletion agents only
// ever touch the provably-safe ones. The classifier is a pure function over
// extracted signals; git probes are injected so tests never spawn git.
//
// Fixtures are real temp directories, never module mocks: a broken symlink
// under docs/ stands in for an entry that vanishes mid-walk, an unparseable
// package.json for an unreadable manifest, and a seeded
// .interlinked/mutation-dispositions.json for the mutation-adjudication
// ledger the inert-branch layer reads.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildDocsCorpus,
	type CandidateSignals,
	type CandidateVerdict,
	categorizeCandidate,
	categorizeDeadCode,
	type CategorizeReport,
	type DeadCodeBucket,
	type DeadCodeRecommendation,
	formatCategorizeReport,
} from "./deadcode-categorize.js";

function signals(partial: Partial<CandidateSignals>): CandidateSignals {
	return {
		kind: "export",
		everImported: true,
		docReferenced: false,
		seamName: false,
		publishedSurface: false,
		testOnlyImporters: false,
		reExportLine: false,
		typeOnly: false,
		hadImportersRemoved: false,
		...partial,
	};
}

describe("categorizeCandidate — positive (bucket per signal)", () => {
	// test-contract: behavior — never-imported + doc-referenced is planned
	// scaffolding; deleting it undoes design intent (differential-fuzz-types)
	it("P1: never-imported + doc-referenced → future-scaffolding", () => {
		// Typed via the public API shapes so the exported types are themselves
		// under test reference (bucket/recommendation unions included).
		const c: CandidateVerdict = categorizeCandidate(
			signals({ everImported: false, docReferenced: true }),
		);
		const bucket: DeadCodeBucket = c.bucket;
		const rec: DeadCodeRecommendation = c.recommendation;
		expect(bucket).toBe("future-scaffolding");
		expect(rec).toBe("keep");
	});

	// test-contract: behavior — seam names and published surface are
	// deliberate API; the fix is annotation, not deletion
	it("P2: seam name or published surface → deliberate-seam", () => {
		expect(categorizeCandidate(signals({ seamName: true })).bucket).toBe("deliberate-seam");
		expect(categorizeCandidate(signals({ publishedSurface: true })).bucket).toBe(
			"deliberate-seam",
		);
		expect(categorizeCandidate(signals({ testOnlyImporters: true })).bucket).toBe(
			"deliberate-seam",
		);
	});

	// test-contract: behavior — a re-export line whose symbol lives elsewhere
	// deletes zero code; tsc guards the removal
	it("P3: re-export line → reexport-residue, delete-line recommendation", () => {
		const c = categorizeCandidate(signals({ reExportLine: true }));
		expect(c.bucket).toBe("reexport-residue");
		expect(c.recommendation).toBe("delete-line");
	});

	it("P4: type-only export → orphaned-type", () => {
		const c = categorizeCandidate(signals({ typeOnly: true }));
		expect(c.bucket).toBe("orphaned-type");
		expect(c.recommendation).toBe("delete");
	});

	// test-contract: behavior — git shows importers existed and were removed:
	// superseded by a successor; safe with the refactor commit cited
	it("P5: had importers removed → superseded", () => {
		const c = categorizeCandidate(signals({ hadImportersRemoved: true }));
		expect(c.bucket).toBe("superseded");
		expect(c.recommendation).toBe("delete");
	});
});

describe("categorizeCandidate — negative (precedence + fallback)", () => {
	// test-contract: invariant — keep-buckets outrank delete-buckets: a
	// doc-referenced never-imported file stays scaffolding even when type-only
	it("N1: future-scaffolding outranks orphaned-type", () => {
		const c = categorizeCandidate(
			signals({ everImported: false, docReferenced: true, typeOnly: true }),
		);
		expect(c.bucket).toBe("future-scaffolding");
	});

	it("N2: deliberate-seam outranks reexport-residue", () => {
		const c = categorizeCandidate(signals({ seamName: true, reExportLine: true }));
		expect(c.bucket).toBe("deliberate-seam");
	});

	it("N3: no signal → ambiguous, review recommendation", () => {
		const c = categorizeCandidate(signals({}));
		expect(c.bucket).toBe("ambiguous");
		expect(c.recommendation).toBe("review");
	});

	// test-contract: behavior — never-imported WITHOUT a doc reference stays
	// ambiguous (could be scaffolding whose docs use prose, could be
	// stillborn), but the reason must carry the never-imported evidence so
	// the reviewer starts from it (calibration find: differential-fuzz-types'
	// plan docs say "differential fuzzing", never the file base)
	it("N4: never-imported without doc reference → ambiguous, evidence in reason", () => {
		const c = categorizeCandidate(signals({ everImported: false }));
		expect(c.bucket).toBe("ambiguous");
		expect(c.reason).toContain("never imported in git history");
	});
});

describe("signal extraction over a fixture repo", () => {
	let tmp: string;

	function seed(rel: string, content: string): void {
		const abs = join(tmp, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-deadcat-"));
		seed("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "./dist/index.js" } }));
		seed("docs/plans/01-future.md", "The fuzz prover consumes `PlannedThing` from planned-module.\n");
		seed("src/index.ts", 'import { used } from "./lib.js";\nconsole.log(used);\n');
		seed(
			"src/lib.ts",
			'export const used = 1;\nexport type OrphanShape = { a: number };\nexport function _resetForTests(): void {}\n',
		);
		seed("src/barrel.ts", 'export { used } from "./lib.js";\nexport const barrelOnly = 2;\n');
		seed("src/planned-module.ts", "export interface PlannedThing { x: number }\n");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: behavior — the docs corpus is a word-boundary match, so
	// symbol names hit but substrings of longer identifiers do not
	it("P6: buildDocsCorpus matches whole symbols only", () => {
		const corpus = buildDocsCorpus(tmp);
		expect(corpus.mentions("PlannedThing")).toBe(true);
		expect(corpus.mentions("Planned")).toBe(false);
		expect(corpus.mentions("NeverMentioned")).toBe(false);
	});

	// test-contract: public-api — the end-to-end pass buckets a doc-referenced
	// never-imported file as scaffolding and a seam-named export as deliberate,
	// with git probes injected (no spawns)
	it("P7: categorizeDeadCode buckets fixture candidates end-to-end", () => {
		const report: CategorizeReport = categorizeDeadCode(tmp, {
			unreachableFiles: ["src/planned-module.ts"],
			deadExports: [
				{ file: "src/lib.ts", detail: "unused export '_resetForTests' — remove" },
				{ file: "src/lib.ts", detail: "unused export 'OrphanShape' — remove" },
			],
			gitProbe: () => ({ everImported: false, hadImportersRemoved: false }),
		});
		const byName = new Map(report.items.map((i) => [i.symbol ?? i.file, i.bucket]));
		expect(byName.get("src/planned-module.ts")).toBe("future-scaffolding");
		expect(byName.get("_resetForTests")).toBe("deliberate-seam");
		expect(byName.get("OrphanShape")).toBe("orphaned-type");
	});

	// test-contract: behavior — a docs entry that cannot be stat'd (broken
	// symlink, or a file deleted mid-walk) is skipped and the walk continues,
	// so later markdown still reaches the corpus
	it("P8: a docs entry that vanishes mid-walk does not stop the corpus build", () => {
		symlinkSync(join(tmp, "docs", "no-such-target.md"), join(tmp, "docs", "aa-broken.md"));
		seed("docs/zz-later.md", "The successor is `SentinelSymbol`.\n");

		const corpus = buildDocsCorpus(tmp);

		expect(corpus.mentions("SentinelSymbol")).toBe(true);
		expect(corpus.mentions("PlannedThing")).toBe(true);
	});

	// test-contract: behavior — a package.json bin target resolves to its src
	// path, so that file is a published surface and must not be deleted
	it("P9: a bin target marks the source file as a published surface", () => {
		const report = categorizeDeadCode(tmp, {
			unreachableFiles: ["src/index.ts"],
			deadExports: [],
			gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
		});

		expect(report.items[0]?.bucket).toBe("deliberate-seam");
		expect(report.items[0]?.reason).toBe(
			"published surface — deliberate API; document instead of deleting",
		);
	});

	// test-contract: behavior — an unparseable manifest publishes nothing
	// rather than aborting the pass; the same file then falls through to review
	it("P10: an unparseable package.json leaves the published set empty", () => {
		seed("package.json", "{ this is not json");

		const report = categorizeDeadCode(tmp, {
			unreachableFiles: ["src/index.ts"],
			deadExports: [],
			gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
		});

		expect(report.items[0]?.bucket).toBe("ambiguous");
		expect(report.items[0]?.reason).toBe("no safety signal matched — human/agent review before any action");
	});

	// test-contract: behavior — a detail line with no `unused export '<x>'`
	// clause falls back to every backticked identifier, one item per symbol
	it("P11: a backticked detail yields one candidate per quoted symbol", () => {
		const report = categorizeDeadCode(tmp, {
			unreachableFiles: [],
			deadExports: [{ file: "src/barrel.ts", detail: "dead: `used` and `barrelOnly` unreferenced" }],
			gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
		});

		expect(report.items.map((i) => i.symbol)).toEqual(["used", "barrelOnly"]);
		expect(report.items[0]?.bucket).toBe("reexport-residue");
	});

	// test-contract: behavior — when the candidate's file cannot be read the
	// shape signals stay false, so a type-shaped name is NOT auto-deleted
	it("P12: an unreadable candidate file keeps the shape signals false", () => {
		const report = categorizeDeadCode(tmp, {
			unreachableFiles: [],
			deadExports: [{ file: "src/vanished.ts", detail: "unused export 'GhostShape'" }],
			gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
		});

		expect(report.items[0]?.bucket).toBe("ambiguous");
		expect(report.items[0]?.recommendation).toBe("review");
	});
});

describe("inert branches from the mutation-adjudication ledger", () => {
	let tmp: string;

	function seedLedger(records: unknown): void {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-dispositions.json"),
			typeof records === "string" ? records : JSON.stringify({ records }),
		);
	}

	function report(): CategorizeReport {
		return categorizeDeadCode(tmp, {
			unreachableFiles: [],
			deadExports: [],
			gitProbe: () => ({ everImported: true, hadImportersRemoved: false }),
		});
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-deadcat-ledger-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: behavior — repeated dead_code adjudications for one
	// function fold into a single row carrying the record count, most-recorded
	// function first (that ordering is the review queue)
	it("folds repeated dead_code records into one row ordered by record count", () => {
		seedLedger([
			{ file: "src/a.ts", qualifiedName: "alpha", disposition: { kind: "dead_code" } },
			{ file: "src/b.ts", qualifiedName: "beta", disposition: { kind: "dead_code" } },
			{ file: "src/a.ts", qualifiedName: "alpha", disposition: { kind: "dead_code" } },
		]);

		expect(report().inertBranches).toEqual([
			{ file: "src/a.ts", qualifiedName: "alpha", records: 2 },
			{ file: "src/b.ts", qualifiedName: "beta", records: 1 },
		]);
	});

	// test-contract: behavior — only dead_code dispositions count; a record
	// missing its identity fields still counts but reports "?" rather than
	// inventing a file name
	it("skips non-dead_code records and reports missing identity fields as ?", () => {
		seedLedger([
			"not-a-record",
			{ file: "src/c.ts", qualifiedName: "gamma", disposition: { kind: "equivalent" } },
			{ file: "src/d.ts", qualifiedName: "delta" },
			{ disposition: { kind: "dead_code" } },
		]);

		expect(report().inertBranches).toEqual([{ file: "?", qualifiedName: "?", records: 1 }]);
	});

	// test-contract: behavior — a malformed ledger reports nothing rather than
	// guessing, and the candidate classification still completes
	it("reports no inert branches when the ledger is malformed JSON", () => {
		seedLedger("{ truncated");

		const out = categorizeDeadCode(tmp, {
			unreachableFiles: ["src/orphan.ts"],
			deadExports: [],
			gitProbe: () => ({ everImported: false, hadImportersRemoved: false }),
		});

		expect(out.inertBranches).toEqual([]);
		expect(out.items[0]?.bucket).toBe("ambiguous");
	});
});

describe("formatCategorizeReport", () => {
	// test-contract: behavior — the inert-branch layer prints its own heading
	// with the function count and one row per function carrying its record count
	it("prints an inert-branch section with one row per adjudicated function", () => {
		const lines = formatCategorizeReport({
			items: [],
			inertBranches: [
				{ file: "src/a.ts", qualifiedName: "alpha", records: 3 },
				{ file: "src/b.ts", qualifiedName: "beta", records: 1 },
			],
		});

		expect(lines).toEqual([
			"\ninert branches (2 functions, mutation-adjudicated) — recommendation: delete the dead branch",
			"  src/a.ts: alpha (3 record(s))",
			"  src/b.ts: beta (1 record(s))",
		]);
	});
});
