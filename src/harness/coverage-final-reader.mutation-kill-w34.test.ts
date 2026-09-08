// Mutation-kill suite for coverage-final-reader.ts (wave 34).
//
// A few survivors here require the filesystem to say something the real
// filesystem can't easily be made to say (e.g. "existsSync says missing but
// the file is actually there", "statSync throws right after existsSync
// passed" — TOCTOU-shaped races). Those tests partially mock `node:fs`,
// keeping every other export wired to the real implementation.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetCoverageFinalCache,
	coverageForFile,
	loadCoverageFinal,
	loadCoverageFinalSummary,
} from "./coverage-final-reader.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		statSync: vi.fn(actual.statSync),
	};
});

let tmp: string;
let coveragePath: string;

beforeEach(() => {
	vi.clearAllMocks();
	tmp = mkdtempSync(join(tmpdir(), "crap-cov-w34-"));
	mkdirSync(join(tmp, "coverage"), { recursive: true });
	coveragePath = join(tmp, "coverage", "coverage-final.json");
	__resetCoverageFinalCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(fixture: unknown): void {
	writeFileSync(coveragePath, JSON.stringify(fixture), "utf-8");
}

describe("coverage-final-reader — mutation-kill-w34", () => {
	// test-contract: public-api — kill 9b8e02ddc37f0331 — __resetCoverageFinalCache must actually clear CACHE
	it("clears the mtime cache so a same-mtime file is re-parsed after reset", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "first", decl: { start: { line: 1 }, end: { line: 1 } } } },
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		loadCoverageFinal(coveragePath, tmp);
		const mtime = statSync(coveragePath).mtimeMs;
		__resetCoverageFinalCache();
		// Overwrite content but pin the mtime back — a cache that was NOT
		// cleared would (wrongly) hand back the stale first-pass entry.
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "second", decl: { start: { line: 1 }, end: { line: 1 } } } },
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		utimesSync(coveragePath, new Date(mtime), new Date(mtime));
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/foo.ts");
		expect(entry?.functions.map((f) => f.name)).toEqual(["second"]);
	});

	// test-contract: public-api — kill 84035ab02769fcd1 — must return null (not the parsed map) when
	// statSync throws even though existsSync already reported the file present (TOCTOU race)
	it("returns null when statSync throws even though the file exists", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {},
				f: {},
				statementMap: { "0": { start: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("stat race");
		});
		expect(loadCoverageFinal(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill a146a23ffa3f7fb4 — must return null when existsSync reports missing,
	// independent of whether a subsequent stat/read would have succeeded
	it("returns null when existsSync reports missing, regardless of what stat would say", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {},
				f: {},
				statementMap: { "0": { start: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		vi.mocked(existsSync).mockImplementationOnce(() => false);
		expect(loadCoverageFinal(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill 09dae06e0bc0ae83 — loadCoverageFinalSummary must return null when
	// existsSync reports missing, even though the file is actually valid on disk
	it("loadCoverageFinalSummary returns null when existsSync reports missing", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		vi.mocked(existsSync).mockImplementationOnce(() => false);
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill ebef1999fa347cc8 — lineMetricsOf tolerates a null statementMap entry
	it("loadCoverageFinalSummary tolerates a null statementMap entry (lines)", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				statementMap: { "0": null, "1": { start: { line: 5 }, end: { line: 5 } } },
				s: { "1": 1 },
			},
		});
		const summary = loadCoverageFinalSummary(coveragePath, tmp);
		expect(summary?.["src/foo.ts"]?.lines).toEqual({ pct: 100, covered: 1, total: 1 });
	});

	// test-contract: public-api — kill 371bddbafee50b39 — branchMetricsOf skips a non-array, non-iterable
	// `b` entry (a plain object) instead of throwing
	it("loadCoverageFinalSummary skips a non-array object value under `b`", () => {
		const absPath = join(tmp, "src/foo.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
				s: { "0": 1 },
				b: { "0": { not: "array" }, "1": [1, 0] },
			},
		});
		const summary = loadCoverageFinalSummary(coveragePath, tmp);
		expect(summary?.["src/foo.ts"]?.branches).toEqual({ pct: 50, covered: 1, total: 2 });
	});

	// test-contract: public-api — kill 8b55c763111566f2 — relKeyFor falls back to the map key (??, not &&)
	// when entry.path is absent
	it("loadCoverageFinalSummary keys a file by the raw map key when entry.path is absent", () => {
		const absPath = join(tmp, "src/nopath.ts");
		writeFixture({
			[absPath]: {
				statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		const summary = loadCoverageFinalSummary(coveragePath, tmp);
		expect(summary?.["src/nopath.ts"]).toBeDefined();
	});

	// test-contract: public-api — kill f886f859c275f522 — relKeyFor must return null (not throw) when the
	// resolved path is unresolvable
	it("loadCoverageFinalSummary returns null (does not throw) for an unresolvable empty path/key", () => {
		writeFixture({
			"": { statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } }, s: { "0": 1 } },
		});
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill 2be1ae6120af46a8 and 6ffa38a00b08d994 — loadCoverageFinalSummary
	// returns null (not throws) when the top-level JSON value is the literal `null`
	it("returns null (does not throw) for a top-level JSON null", () => {
		writeFileSync(coveragePath, "null", "utf-8");
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill 6f79efde30ec5862 — an entry with statementMap but no `s` is skipped
	// (the guard is OR, not AND — either missing field is enough)
	it("skips an entry that has statementMap but no `s`", () => {
		const absPath = join(tmp, "src/nos.ts");
		writeFixture({
			[absPath]: { path: absPath, statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } } },
		});
		expect(loadCoverageFinalSummary(coveragePath, tmp)).toBeNull();
	});

	// test-contract: public-api — kill 6796c2cf36b9d945 — buildPerFileCoverage skips a non-object entry value
	it("loadCoverageFinal skips a primitive (non-object) entry value", () => {
		const absPath = join(tmp, "src/weird.ts");
		writeFixture({ [absPath]: 42 });
		const result = loadCoverageFinal(coveragePath, tmp);
		expect(result?.size).toBe(0);
		expect(result?.has("src/weird.ts")).toBe(false);
	});

	// test-contract: public-api — kill bb6c3f3ea7f34160, b5fee421d066328a and 4b6bd5be05d05197 — an entry
	// outside repoRoot is excluded entirely (OR semantics, not AND; startsWith, not endsWith)
	it("excludes an entry whose resolved path is outside repoRoot", () => {
		const outside = "/tmp/some-other-repo-w34/src/bar.ts";
		writeFixture({
			[outside]: { path: outside, fnMap: {}, f: {}, statementMap: {}, s: {} },
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		expect(result?.size).toBe(0);
	});

	// test-contract: public-api — kill 9f4d6923eef34292 — per-line data still populates when every statement
	// is covered (uncovered.size === 0, so only the `covered.size > 0` operand is true)
	it("populates coveredLines/uncoveredLines when every statement in the file is covered", () => {
		const absPath = join(tmp, "src/allcovered.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {},
				f: {},
				statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/allcovered.ts");
		expect(entry?.coveredLines?.has(1)).toBe(true);
		expect(entry?.uncoveredLines?.size).toBe(0);
	});

	// test-contract: public-api — kill 4110a35c0efe38ff — extractFunctionCoverage tolerates decl present but
	// decl.start absent, falling back to fnEntry.line
	it("falls back to fnEntry.line when decl is present but decl.start is absent", () => {
		const absPath = join(tmp, "src/declnostart.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "f", decl: {}, line: 7 } },
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 7 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/declnostart.ts");
		expect(entry?.functions[0]?.line).toBe(7);
	});

	// test-contract: public-api — kill 84cabf2185a7f1f4 and aa25064ce0dd1202 — a function whose startLine
	// resolves to exactly 0 is skipped, even when a matching statement exists at line 0
	it("skips a function whose startLine resolves to 0, even with a matching statement", () => {
		const absPath = join(tmp, "src/zeroline.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "zeroFn", line: 0 } },
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 0 }, end: { line: 0 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/zeroline.ts");
		expect(entry?.functions).toEqual([]);
	});

	// test-contract: public-api — kill 97b3e162567ed5ba — extractFunctionCoverage tolerates loc present but
	// loc.end absent, falling back to decl.end
	it("falls back to decl.end when loc is present but loc.end is absent", () => {
		const absPath = join(tmp, "src/locnoend.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {
					"0": {
						name: "f",
						decl: { start: { line: 1 }, end: { line: 9 } },
						loc: { start: { line: 1 } },
					},
				},
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 1 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/locnoend.ts");
		expect(entry?.functions[0]?.endLine).toBe(9);
	});

	// test-contract: public-api — kill 180f9a09ae397542 — extractFunctionCoverage tolerates decl present but
	// decl.end absent, with no loc, falling back to startLine
	it("falls back to startLine when neither loc.end nor decl.end is present", () => {
		const absPath = join(tmp, "src/declnoend.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "f", decl: { start: { line: 4 } } } },
				f: { "0": 1 },
				statementMap: { "0": { start: { line: 4 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/declnoend.ts");
		expect(entry?.functions[0]?.endLine).toBe(4);
	});

	// test-contract: public-api — kill 3b0dcb70bdf6f3e2, cd06e81203a3fdc5 and c4f999cd7c8be9f4 — functions
	// are sorted ascending by declaration line, not left in fnMap iteration order
	it("sorts functions ascending by declaration line across three out-of-order entries", () => {
		const absPath = join(tmp, "src/order.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {
					c: { name: "ten", decl: { start: { line: 10 }, end: { line: 10 } } },
					b: { name: "five", decl: { start: { line: 5 }, end: { line: 5 } } },
					a: { name: "one", decl: { start: { line: 1 }, end: { line: 1 } } },
				},
				f: { c: 1, b: 1, a: 1 },
				statementMap: {
					c0: { start: { line: 10 } },
					b0: { start: { line: 5 } },
					a0: { start: { line: 1 } },
				},
				s: { c0: 1, b0: 1, a0: 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/order.ts");
		expect(entry?.functions.map((f) => f.name)).toEqual(["one", "five", "ten"]);
	});

	// test-contract: public-api — kill 8af5cd0717a4dfc5 — extractLineCoverage tolerates a null statementMap entry
	it("loadCoverageFinal tolerates a null statementMap entry (per-line data)", () => {
		const absPath = join(tmp, "src/nullrange.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: {},
				f: {},
				statementMap: { "0": null, "1": { start: { line: 5 }, end: { line: 5 } } },
				s: { "1": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/nullrange.ts");
		expect(entry?.coveredLines?.has(5)).toBe(true);
	});

	// test-contract: public-api — kill 11dc2cc9d46aa04d — computeStatementPct tolerates a null statementMap entry
	it("loadCoverageFinal tolerates a null statementMap entry (statement_pct)", () => {
		const absPath = join(tmp, "src/nullstmt.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "f", decl: { start: { line: 1 }, end: { line: 5 } } } },
				f: { "0": 1 },
				statementMap: { x: null, "0": { start: { line: 2 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/nullstmt.ts");
		expect(entry?.functions[0]?.statement_pct).toBe(100);
	});

	// test-contract: public-api — kill 5c0f30f919591f9c — computeStatementPct excludes a statement whose
	// start.line is missing entirely, rather than counting it as in-range
	it("excludes a statement whose start.line is missing entirely from the pct computation", () => {
		const absPath = join(tmp, "src/nostartline.ts");
		writeFixture({
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "f", decl: { start: { line: 1 }, end: { line: 5 } } } },
				f: { "0": 1 },
				statementMap: { "0": { end: { line: 2 } } },
				s: { "0": 1 },
			},
		});
		const result = loadCoverageFinal(coveragePath, tmp);
		const entry = coverageForFile(nonNull(result), "src/nostartline.ts");
		expect(entry?.functions).toEqual([]);
	});
});
import { nonNull } from "../lib/non-null.js";
