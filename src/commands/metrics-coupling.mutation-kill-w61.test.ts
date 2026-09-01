import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	annotateRelations,
	computeCoupling,
	isCompanionPair,
	parseNameOnlyLog,
} from "./metrics-coupling.js";

// ---------------------------------------------------------------------------
// Mocked ProjectGraph — lets the integration tests exercise `importLookupFor`
// (unexported closure inside metrics-coupling.ts) without a real TS project.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
	hasFile: (_f: string) => true,
	getDependencies: (_f: string) => [] as { toFile: string }[],
}));

vi.mock("../harness/project-graph.js", () => ({
	ProjectGraph: class {
		constructor(_cwd: string) {}
		initialize() {}
		hasFile(f: string) {
			return mockState.hasFile(f);
		}
		getDependencies(f: string) {
			return mockState.getDependencies(f);
		}
	},
}));

// Import AFTER the mock so metricsCouplingCommand picks up the fake graph.
const { metricsCouplingCommand } = await import("./metrics-coupling.js");

function makeTmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coupling-w61-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	return dir;
}

function commitFiles(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const full = path.join(dir, name);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "c"], { cwd: dir });
}

async function runJson(dir: string, opts: Record<string, string>): Promise<any> {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await metricsCouplingCommand({ cwd: dir, json: true, ...opts });
		const call = spy.mock.calls.at(-1);
		if (!call) throw new Error("console.log was not called");
		return JSON.parse(String(call[0]));
	} finally {
		spy.mockRestore();
	}
}

describe("parseNameOnlyLog — positive/negative", () => {
	// test-contract: public-api — parseNameOnlyLog trims each raw line before
	// matching HEADER_RE / blank-separator, per the function's own `line.trim()`.
	it("P1: trims whitespace-padded lines so a blank separator line still ends the commit (kills bd83cab56b3fce3c)", () => {
		// Without raw.trim(), a header line with trailing spaces fails the anchored
		// HEADER_RE match, so the whole commit is silently dropped.
		const text = "abc123\t1690000000  \nfile1.ts\n\n";
		const commits = parseNameOnlyLog(text);
		expect(commits).toEqual([{ sha: "abc123", timestamp: 1690000000, files: ["file1.ts"] }]);
	});

	// test-contract: public-api — the blank-line StringLiteral is what finalizes
	// a commit; without it, a leftover "" is pushed into `files` instead.
	it("N1: an untrimmed blank separator becomes a phantom empty-string file entry (kills f418867687d75767)", () => {
		const text = "sha1\t100\nfileA\n\n";
		const commits = parseNameOnlyLog(text);
		expect(commits).toEqual([{ sha: "sha1", timestamp: 100, files: ["fileA"] }]);
	});

	// test-contract: public-api — HEADER_RE is anchored with `^`; parseNameOnlyLog
	// must not accept a header pattern that only matches mid-line.
	it("P2: HEADER_RE requires the match to start at position 0 (kills a9a18eb2db0d93cd)", () => {
		// "a\tb\t123" only matches (\S+)\t(\d+)$ starting at index 2 ("b\t123");
		// the ^ anchor must reject that and treat the whole line as non-header.
		const text = "a\tb\t123\nfileX\n\n";
		const commits = parseNameOnlyLog(text);
		expect(commits).toEqual([]);
	});

	// test-contract: public-api — HEADER_RE's trailing `$` requires the digit
	// group to reach the true end of the line, not just start with digits.
	it("P3: HEADER_RE requires the digit group to reach the end of the line (kills ce616493d6fc9737)", () => {
		// "sha1\t123abc" only satisfies (\d+) without the trailing $ anchor.
		const text = "sha1\t123abc\nfileY\n\n";
		const commits = parseNameOnlyLog(text);
		expect(commits).toEqual([]);
	});
});

describe("computeCoupling — positive/negative", () => {
	const baseOpts = { minSupport: 1, maxCommitFiles: 30, minStrength: 0 };

	// test-contract: public-api — computeCoupling sorts each commit's unique
	// files before pairing, so pair identity (a,b) is deterministic by name.
	it("P1: commit files are deduped-and-sorted before pairing, fixing pair identity (kills ca313f7f60b5ea7c)", () => {
		const commits = [
			{ sha: "s1", timestamp: 1, files: ["zeta.ts", "alpha.ts"] },
			{ sha: "s2", timestamp: 2, files: ["zeta.ts", "alpha.ts"] },
		];
		const pairs = computeCoupling(commits, baseOpts);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ a: "alpha.ts", b: "zeta.ts" });
	});

	// test-contract: public-api — the bulk-commit skip uses a strict `>`, so a
	// commit exactly at the cap must still be counted.
	it("N1: a commit exactly AT maxCommitFiles is not skipped (kills 916dd31d9c076367)", () => {
		const commits = [{ sha: "s1", timestamp: 1, files: ["a.ts", "b.ts", "c.ts"] }];
		const pairs = computeCoupling(commits, { minSupport: 1, maxCommitFiles: 3, minStrength: 0 });
		// 3 unique files, all under-or-equal the cap: 3 pairs expected.
		expect(pairs).toHaveLength(3);
	});

	// test-contract: public-api — the minStrength filter uses strict `<`, so a
	// pair whose strength exactly equals the floor must be kept, not dropped.
	it("N2: a pair whose strength exactly equals the floor is KEPT, not dropped (kills 8e319b2fa4966084)", () => {
		// a: 4 revisions, b: 4 revisions, co-change support 2 -> strength 50%.
		const commits = [
			{ sha: "c1", timestamp: 1, files: ["a.ts", "b.ts"] },
			{ sha: "c2", timestamp: 2, files: ["a.ts", "b.ts"] },
			{ sha: "c3", timestamp: 3, files: ["a.ts"] },
			{ sha: "c4", timestamp: 4, files: ["a.ts"] },
			{ sha: "c5", timestamp: 5, files: ["b.ts"] },
			{ sha: "c6", timestamp: 6, files: ["b.ts"] },
		];
		const pairs = computeCoupling(commits, { minSupport: 1, maxCommitFiles: 30, minStrength: 50 });
		expect(pairs.find((p) => p.a === "a.ts" && p.b === "b.ts")).toMatchObject({
			support: 2,
			strength: 50,
		});
	});

	// test-contract: public-api — computeCoupling's sort comparator must break
	// a strength tie by support (descending), not by name alone.
	it("P2+N3: sort orders by strength desc, then by support desc on a strength tie (kills 98a64d2a2e795227 and 56d7851b092920a0)", () => {
		// Two independent pairs tied at strength 50%, differing support (5 vs 2).
		// Name the HIGH-support pair alphabetically LAST so a fallback to pure
		// name-compare (either mutant) visibly reorders the result.
		const commits: { sha: string; timestamp: number; files: string[] }[] = [];
		let n = 0;
		const push = (files: string[]) => commits.push({ sha: `s${n++}`, timestamp: n, files });
		// Z1/Z2: revA=revB=10, support=5 -> strength 50
		for (let i = 0; i < 5; i++) push(["Z1.ts", "Z2.ts"]);
		for (let i = 0; i < 5; i++) push(["Z1.ts"]);
		for (let i = 0; i < 5; i++) push(["Z2.ts"]);
		// A1/A2: revA=revB=4, support=2 -> strength 50
		for (let i = 0; i < 2; i++) push(["A1.ts", "A2.ts"]);
		for (let i = 0; i < 2; i++) push(["A1.ts"]);
		for (let i = 0; i < 2; i++) push(["A2.ts"]);

		const pairs = computeCoupling(commits, { minSupport: 1, maxCommitFiles: 30, minStrength: 0 });
		const zIdx = pairs.findIndex((p) => p.a === "Z1.ts");
		const aIdx = pairs.findIndex((p) => p.a === "A1.ts");
		expect(zIdx).toBeGreaterThanOrEqual(0);
		expect(aIdx).toBeGreaterThanOrEqual(0);
		// Higher support wins the tie -> Z pair sorts before A pair.
		expect(zIdx).toBeLessThan(aIdx);
	});
});

describe("isCompanionPair — positive/negative (also covers stemOf's regex use)", () => {
	// test-contract: public-api — isCompanionPair's aIsTest===bIsTest guard must
	// reject two files that are BOTH non-test, even if their stems match.
	it("N1: two non-test files never become companions even with the same stem (kills e23613c6e649b83d)", () => {
		expect(isCompanionPair("src/util.ts", "src/util.tsx")).toBe(false);
	});

	// test-contract: public-api — TEST_SUFFIX_RE's trailing `$` must anchor the
	// test-suffix match to the true end of the filename.
	it("P1: TEST_SUFFIX_RE must match at the true end of the filename (kills ef5799dd066cb2bb)", () => {
		expect(isCompanionPair("src/foo.test.ts.ts", "src/foo.ts")).toBe(false);
	});

	// test-contract: public-api — TEST_SUFFIX_RE's `[cm]?` must accept a literal
	// c/m char (e.g. ".test.cjs"), not exclude it.
	it("P2: TEST_SUFFIX_RE's [cm]? accepts a literal c/m before the js/ts ext (kills 5a6812a11bc6ddd5)", () => {
		expect(isCompanionPair("src/foo.test.cjs", "src/foo.ts")).toBe(true);
	});

	// test-contract: public-api — CODE_EXT_RE's trailing `$` must anchor the
	// extension match to the true end of the filename.
	it("P3: CODE_EXT_RE must match at the true end of the filename (kills 4dd543c047870098)", () => {
		expect(isCompanionPair("src/foo.bak.test.ts", "src/foo.ts.bak")).toBe(false);
	});

	// test-contract: public-api — CODE_EXT_RE's `[cm]?` must accept a literal
	// c/m char (e.g. ".cjs"), not exclude it.
	it("P4: CODE_EXT_RE's [cm]? accepts a literal c/m before the js/ts ext (kills 0ba69570c293af89)", () => {
		expect(isCompanionPair("src/foo.test.ts", "src/foo.cjs")).toBe(true);
	});
});

describe("annotateRelations — sanity (companion short-circuits isLinked)", () => {
	// test-contract: public-api — annotateRelations short-circuits to "companion"
	// via isCompanionPair before ever calling the isLinked callback.
	it("labels a companion pair without consulting isLinked", () => {
		const pairs = [{ a: "foo.ts", b: "foo.test.ts", support: 1, revA: 1, revB: 1, strength: 100 }];
		const annotated = annotateRelations(pairs, () => null);
		expect(annotated[0]?.relation).toBe("companion");
	});
});

describe("metricsCouplingCommand — integration (unexported helpers via real git + mocked graph)", () => {
	let dir: string;

	beforeEach(() => {
		mockState.hasFile = () => true;
		mockState.getDependencies = () => [];
	});

	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — importLookupFor's forward `e.toFile === absB`
	// check must not treat a non-matching, non-empty deps array as linked.
	it("relation is 'hidden' when the forward edge check finds no match (kills eb92c58474729c20)", async () => {
		dir = makeTmpRepo();
		commitFiles(dir, { "a.ts": "1", "c.ts": "1" });
		commitFiles(dir, { "a.ts": "2", "c.ts": "2" });
		const absA = path.join(dir, "a.ts");
		const elsewhere = path.join(dir, "other.ts");
		mockState.getDependencies = (f: string) => {
			if (f === absA) return [{ toFile: elsewhere }];
			return [];
		};
		const result = await runJson(dir, { minSupport: "1", minStrength: "0", limit: "50" });
		const pair = result.pairs.find((p: any) => p.a === "a.ts" && p.b === "c.ts");
		expect(pair.relation).toBe("hidden");
	});

	// test-contract: public-api — importLookupFor's reverse `e.toFile === absA`
	// check must not treat a non-matching, non-empty deps array as linked.
	it("relation is 'hidden' when the reverse edge check finds no match (kills 3163200f34806c23)", async () => {
		dir = makeTmpRepo();
		commitFiles(dir, { "a.ts": "1", "c.ts": "1" });
		commitFiles(dir, { "a.ts": "2", "c.ts": "2" });
		const absA = path.join(dir, "a.ts");
		const absB = path.join(dir, "c.ts");
		const elsewhere = path.join(dir, "other.ts");
		mockState.getDependencies = (f: string) => {
			if (f === absA) return [];
			if (f === absB) return [{ toFile: elsewhere }];
			return [];
		};
		const result = await runJson(dir, { minSupport: "1", minStrength: "0", limit: "50" });
		const pair = result.pairs.find((p: any) => p.a === "a.ts" && p.b === "c.ts");
		expect(pair.relation).toBe("hidden");
	});

	// test-contract: public-api — renderTable joins lines with "\n" so
	// normal-mode output is multi-line, not one concatenated string.
	it("normal-mode output joins report lines with real newlines (kills e42a45e4ff4db4b6)", async () => {
		dir = makeTmpRepo();
		commitFiles(dir, { "solo.ts": "1" });
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await metricsCouplingCommand({ cwd: dir });
			const call = spy.mock.calls.at(-1);
			if (!call) throw new Error("console.log was not called");
			const printed = String(call[0]);
			expect(printed).toContain("\n");
			expect(printed.split("\n").length).toBeGreaterThan(1);
		} finally {
			spy.mockRestore();
		}
	});

	// test-contract: public-api — EXCLUDE_RE is anchored with `^`, so it must
	// only drop paths rooted at dist/build/etc, not paths merely containing them.
	it("EXCLUDE_RE only strips paths ROOTED at dist/build/etc, not paths merely containing them (kills c0d0c5d88949f619)", async () => {
		dir = makeTmpRepo();
		commitFiles(dir, { "src/dist/foo.ts": "1", "src/bar.ts": "1" });
		const result = await runJson(dir, { minSupport: "1", minStrength: "0", limit: "50" });
		const pair = result.pairs.find(
			(p: any) =>
				(p.a === "src/dist/foo.ts" && p.b === "src/bar.ts") ||
				(p.a === "src/bar.ts" && p.b === "src/dist/foo.ts"),
		);
		expect(pair).toBeDefined();
	});

	// test-contract: public-api — numericOption trims raw before its blank
	// check, so a whitespace-only value must fall back to the default.
	it("numericOption trims before treating a value as blank (kills af39441e6eb66b12)", async () => {
		dir = makeTmpRepo();
		// Single co-change -> support 1. Default minSupport fallback is 4, so a
		// whitespace-only override that (correctly) falls back to 4 excludes it.
		commitFiles(dir, { "p.ts": "1", "q.ts": "1" });
		const result = await runJson(dir, { minSupport: "   ", minStrength: "0", limit: "50" });
		const pair = result.pairs.find((p: any) => p.a === "p.ts" && p.b === "q.ts");
		expect(pair).toBeUndefined();
	});
});
