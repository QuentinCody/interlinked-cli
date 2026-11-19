import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import type { MutationGateConfig } from "./check-policy.js";
import {
	compareMutation,
	emptyMutationBaseline,
	loadMutationBaseline,
	loadMutationReport,
	type MutationBaseline,
	type MutationReport,
	mutationBaselinePath,
	mutationScore,
	saveMutationBaseline,
} from "./mutation-gate.js";

const DEFAULT_CONFIG: MutationGateConfig = {
	enabled: true,
	min_score: 0.6,
	schedule: "weekly",
};

describe("mutationScore", () => {
	it("returns 0 for a file with no mutants", () => {
		expect(mutationScore({ killed: 0, survived: 0 })).toBe(0);
	});

	it("returns 1 when all mutants are killed", () => {
		expect(mutationScore({ killed: 10, survived: 0 })).toBe(1);
	});

	it("returns 0.5 on a 1-1 split", () => {
		expect(mutationScore({ killed: 5, survived: 5 })).toBeCloseTo(0.5);
	});

	it("excludes timeouts and compile errors from the denominator", () => {
		expect(
			mutationScore({ killed: 4, survived: 1, timeout: 5, compile_error: 10 }),
		).toBeCloseTo(0.8);
	});
});

describe("loadMutationBaseline / saveMutationBaseline round trip", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-baseline-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty baseline when file missing", () => {
		expect(loadMutationBaseline(tmp).files).toEqual({});
	});

	it("round-trips a baseline through disk", () => {
		const b: MutationBaseline = {
			version: 1,
			updated_at: "2026-04-22",
			files: { "src/foo.ts": { score: 0.9, killed: 27 } },
		};
		saveMutationBaseline(tmp, b);
		expect(loadMutationBaseline(tmp)).toEqual(b);
	});

	it("loads and saves an explicitly selected baseline without replacing the canonical one", () => {
		const baseline: MutationBaseline = { version: 1, updated_at: "2026-01-01", files: {} };
		saveMutationBaseline(tmp, baseline);
		const canonical = readFileSync(mutationBaselinePath(tmp), "utf8"), selected = join(tmp, "selected.json");
		saveMutationBaseline(tmp, { ...baseline, files: { "source.ts": { score: 1, killed: 4 } } }, selected);
		expect(loadMutationBaseline(tmp, selected).files["source.ts"]).toEqual({ score: 1, killed: 4 });
		expect(readFileSync(mutationBaselinePath(tmp), "utf8")).toBe(canonical);
	});

	it("rejects an explicitly missing or malformed baseline while preserving legacy default recovery", () => {
		expect(() => loadMutationBaseline(tmp, join(tmp, "missing.json"))).toThrow("Mutation baseline not found");
		const selected = join(tmp, "selected.json");
		writeFileSync(selected, '{ "version": 2, "files": {} }');
		expect(() => loadMutationBaseline(tmp, selected)).toThrow("Invalid mutation baseline");
		writeFileSync(selected, "{ malformed");
		expect(() => loadMutationBaseline(tmp, selected)).toThrow("Cannot read mutation baseline");
		expect(loadMutationBaseline(tmp).files).toEqual({});
	});

	it("requires complete mutation rows in an explicitly selected comparison file", () => {
		const selected = join(tmp, "selected.json");
		for (const stats of [{ lines: 100 }, { score: 2, killed: 3 }, { score: 0.9, killed: -1 }]) {
			writeFileSync(selected, JSON.stringify({ version: 1, files: { "source.ts": stats } }));
			expect(() => loadMutationBaseline(tmp, selected)).toThrow("Invalid mutation baseline");
		}
	});

	it("recovers from malformed baseline", () => {
		writeFileSync(mutationBaselinePath(tmp), "{ not json", "utf-8");
		expect(loadMutationBaseline(tmp).files).toEqual({});
	});

	it("returns empty baseline when the version field is wrong", () => {
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({ version: 2, updated_at: "x", files: { a: { score: 1, killed: 1 } } }),
			"utf-8",
		);
		expect(loadMutationBaseline(tmp)).toEqual(emptyMutationBaseline());
	});

	it("returns empty baseline when the files field is missing", () => {
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({ version: 1, updated_at: "x" }),
			"utf-8",
		);
		expect(loadMutationBaseline(tmp)).toEqual(emptyMutationBaseline());
	});

	it("N1: drops a malformed individual file entry but keeps valid ones", () => {
		// Pre-fix, `raw as MutationBaseline` trusted every per-file entry
		// unchecked — a corrupted or hand-edited entry for one file would have
		// silently propagated a non-numeric score into the ratchet comparison
		// instead of just losing that one file's high-water mark.
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22",
				files: {
					"src/good.ts": { score: 0.9, killed: 27 },
					"src/bad.ts": { score: "not-a-number", killed: 5 },
				},
			}),
			"utf-8",
		);
		const result = loadMutationBaseline(tmp);
		expect(result.files).toEqual({ "src/good.ts": { score: 0.9, killed: 27 } });
		expect(result.files["src/bad.ts"]).toBeUndefined();
	});

	it("N2: drops a non-object file entry while keeping the rest", () => {
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22",
				files: { "src/good.ts": { score: 0.9, killed: 27 }, "src/bad.ts": "oops" },
			}),
			"utf-8",
		);
		expect(loadMutationBaseline(tmp).files).toEqual({
			"src/good.ts": { score: 0.9, killed: 27 },
		});
	});

	it("N3: rejects the whole baseline when files is an array instead of a record", () => {
		// Pre-fix, the guard was `!raw.files` — a truthy check. An array is
		// truthy, so it sailed straight through to `raw as MutationBaseline`
		// with `.files` actually holding an array, not a Record.
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({ version: 1, updated_at: "x", files: ["not", "a", "record"] }),
			"utf-8",
		);
		expect(loadMutationBaseline(tmp)).toEqual(emptyMutationBaseline());
	});

	it("P1: defaults updated_at when missing, keeping valid file entries", () => {
		writeFileSync(
			mutationBaselinePath(tmp),
			JSON.stringify({ version: 1, files: { "src/foo.ts": { score: 0.75, killed: 3 } } }),
			"utf-8",
		);
		const result = loadMutationBaseline(tmp);
		expect(result.files).toEqual({ "src/foo.ts": { score: 0.75, killed: 3 } });
		expect(typeof result.updated_at).toBe("string");
	});
});

describe("loadMutationReport — Stryker shape normalization", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-report-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("aggregates Stryker-style mutant arrays", () => {
		const p = join(tmp, "stryker.json");
		writeFileSync(
			p,
			JSON.stringify({
				files: {
					"src/foo.ts": {
						mutants: [
							{ status: "Killed" },
							{ status: "Killed" },
							{ status: "Survived" },
							{ status: "Timeout" },
						],
					},
				},
			}),
		);
		const report = loadMutationReport(p);
		expect(report?.files["src/foo.ts"]).toEqual({
			killed: 2,
			survived: 1,
			timeout: 1,
			no_coverage: 0,
			compile_error: 0,
			runtime_error: 0,
		});
	});

	it("accepts flat kill/survived counts as well", () => {
		const p = join(tmp, "flat.json");
		writeFileSync(
			p,
			JSON.stringify({
				files: { "src/foo.ts": { killed: 8, survived: 2 } },
			}),
		);
		const report = loadMutationReport(p);
		expect(report?.files["src/foo.ts"]?.killed).toBe(8);
	});

	it("returns null on malformed JSON", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "nope", "utf-8");
		expect(loadMutationReport(p)).toBeNull();
	});

	it("aggregates no_coverage/compile_error/runtime_error mutant statuses", () => {
		const p = join(tmp, "extra-statuses.json");
		writeFileSync(
			p,
			JSON.stringify({
				files: {
					"src/foo.ts": {
						mutants: [
							{ status: "Killed" },
							{ status: "NoCoverage" },
							{ status: "no_coverage" },
							{ status: "CompileError" },
							{ status: "compile_error" },
							{ status: "RuntimeError" },
							{ status: "runtime_error" },
							{ status: "SomethingUnknown" },
						],
					},
				},
			}),
		);
		const report = loadMutationReport(p);
		expect(report?.files["src/foo.ts"]).toEqual({
			killed: 1,
			survived: 0,
			timeout: 0,
			no_coverage: 2,
			compile_error: 2,
			runtime_error: 2,
		});
	});

	it("returns an empty report when the top-level JSON has no `files` key", () => {
		const p = join(tmp, "no-files.json");
		writeFileSync(p, JSON.stringify({ other: 1 }), "utf-8");
		expect(loadMutationReport(p)).toEqual({ files: {} });
	});

	it("returns an empty report when `files` is not an object", () => {
		const p = join(tmp, "files-not-object.json");
		writeFileSync(p, JSON.stringify({ files: "nope" }), "utf-8");
		expect(loadMutationReport(p)).toEqual({ files: {} });
	});

	it("skips a null file entry in the report", () => {
		const p = join(tmp, "null-entry.json");
		writeFileSync(p, JSON.stringify({ files: { "src/foo.ts": null } }), "utf-8");
		expect(loadMutationReport(p)).toEqual({ files: {} });
	});
});

describe("compareMutation — floor check", () => {
	it("flags files below the configured score floor", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 4, survived: 6 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings.some((f) => f.name === "mutation_score_below_floor")).toBe(true);
		expect(res.stats.files_below_floor).toBe(1);
	});

	it("does NOT flag a file with zero total mutants (no signal)", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 0, survived: 0 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});

	it("does NOT flag files at or above the floor", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } }, // 0.8
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});
});

describe("compareMutation — ratchet (decrease detection)", () => {
	it("flags a per-file score decrease as error", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } }, // 0.8
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		const decrease = res.findings.find((f) => f.name === "mutation_score_decrease");
		expect(decrease).toBeDefined();
		expect(decrease?.severity).toBe("error");
		expect(res.stats.files_decreased).toBe(1);
	});

	it("preserves the high-water mark after a decrease", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.9, killed: 9 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } },
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({ score: 0.9, killed: 9 });
	});

	it("advances the baseline when score improves", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.7, killed: 7 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 9, survived: 1 } }, // 0.9
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(nonNull(res.nextBaseline.files["src/foo.ts"]).score).toBe(0.9);
		expect(res.stats.files_improved).toBe(1);
	});
});

describe("compareMutation — changedFiles scoping", () => {
	it("limits evaluation to listed paths", () => {
		const report: MutationReport = {
			files: {
				"src/foo.ts": { killed: 0, survived: 10 },
				"src/bar.ts": { killed: 0, survived: 10 },
			},
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
			changedFiles: ["src/foo.ts"],
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.findings.every((f) => f.file === "src/foo.ts")).toBe(true);
	});
});

describe("compareMutation — path normalization", () => {
	it("normalizes absolute paths to repo-relative", () => {
		const report: MutationReport = {
			files: { "/repo/src/foo.ts": { killed: 9, survived: 1 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toBeDefined();
	});

	it("drops paths outside the repo root", () => {
		const report: MutationReport = {
			files: { "/other/foo.ts": { killed: 9, survived: 1 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});

	it("drops an empty-string path", () => {
		const report: MutationReport = {
			files: { "": { killed: 9, survived: 1 } },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});

	it("skips a null/undefined file entry in the report", () => {
		const report: MutationReport = {
			files: { "src/foo.ts": undefined },
		};
		const res = compareMutation(report, emptyMutationBaseline(), {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});

	it("neither flags nor counts an improvement when the score is unchanged", () => {
		const baseline: MutationBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { score: 0.8, killed: 8 } },
		};
		const report: MutationReport = {
			files: { "src/foo.ts": { killed: 8, survived: 2 } }, // 0.8, unchanged
		};
		const res = compareMutation(report, baseline, {
			config: DEFAULT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		expect(res.stats.files_improved).toBe(0);
		expect(res.stats.files_decreased).toBe(0);
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({ score: 0.8, killed: 8 });
	});
});

describe("file I/O edge cases", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-io-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("saveMutationBaseline creates missing directories", () => {
		const deep = join(tmp, ".interlinked", "deep");
		saveMutationBaseline(deep, emptyMutationBaseline());
		const contents = JSON.parse(readFileSync(mutationBaselinePath(deep), "utf-8"));
		expect(contents.version).toBe(1);
	});

	it("loadMutationReport returns null when file is missing", () => {
		expect(loadMutationReport(join(tmp, "none.json"))).toBeNull();
	});
});
