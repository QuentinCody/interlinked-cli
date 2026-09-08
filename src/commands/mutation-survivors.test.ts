import { parseWire, wireAbsentOptional, wireArray, wireLiteral, wireNullable, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearManifestCache } from "../harness/mutation/manifest.js";
import type {
	SurvivorFileRow,
	SurvivorMutantRow,
	SurvivorMutatorRow,
	SurvivorSymbolRow,
	SurvivorSummary,
} from "../harness/mutation/survivors.js";
import { mutationSurvivorsCommand, parseShard, renderSurvivorReport, shardOf } from "./mutation-survivors.js";

const isCapturedSurvivorSummary = wireObject({ "generation": wireNumber, "authoritativeAt": wireString, "totals": wireObject({ "files": wireNumber, "symbols": wireNumber, "mutants": wireNumber, "killed": wireNumber, "survived": wireNumber, "open": wireNumber, "dispositioned": wireNumber, "uncovered": wireNumber, "timeout": wireNumber, "staleFiles": wireNumber, "unqualifiedFiles": wireNumber, "openByRemedy": wireObject({ "write_test": wireNumber, "strengthen_tests": wireNumber, "unknown": wireNumber }), "score": wireNumber }), "files": wireArray(wireObject({ "file": wireString, "symbols": wireNumber, "open": wireNumber, "dispositioned": wireNumber, "uncovered": wireNumber, "timeout": wireNumber, "killed": wireNumber, "total": wireNumber, "score": wireNumber, "stale": wireLiteral(false, true), "remedy": wireLiteral("write_test", "strengthen_tests", "unknown"), "provenance": wireNullable(wireObject({ "at": wireString, "scope": wireLiteral("unknown", "import_graph", "companion_fallback", "glob_fallback"), "testCount": wireNumber, "surface": wireLiteral("unknown", "per_edit", "measure", "sweep", "adopt"), "engine": wireAbsentOptional(wireString), "engineVersion": wireAbsentOptional(wireString) })) })), "symbols": wireArray(wireObject({ "file": wireString, "symbolId": wireString, "qualifiedName": wireString, "open": wireNumber, "dispositioned": wireNumber, "uncovered": wireNumber, "total": wireNumber, "quarantined": wireLiteral(false, true) })), "mutators": wireArray(wireObject({ "mutator": wireString, "open": wireNumber, "total": wireNumber, "escapeRate": wireNumber })), "mutants": wireArray(wireObject({ "file": wireString, "symbolId": wireString, "qualifiedName": wireString, "mutantId": wireString, "mutator": wireString, "originalLexeme": wireString, "replacement": wireString, "firstSeen": wireString, "disposition": wireNullable(wireLiteral("killed", "dead_code", "proved_equivalent", "proved_unreachable", "duplicate", "outside_contract", "accepted_risk", "unresolved")) })) });

function fileRow(file: string, open: number): SurvivorFileRow {
	return {
		file,
		symbols: 1,
		open,
		dispositioned: 0,
		uncovered: 0,
		timeout: 0,
		killed: 10,
		total: 10 + open,
		score: 0.5,
		stale: false,
		remedy: "unknown",
		provenance: null,
	};
}

function summary(over: Partial<SurvivorSummary> = {}): SurvivorSummary {
	return {
		generation: 3,
		authoritativeAt: "2026-08-09T00:00:00.000Z",
		totals: {
			files: 1,
			symbols: 1,
			mutants: 12,
			killed: 10,
			survived: 2,
			open: 2,
			dispositioned: 0,
			uncovered: 0,
			timeout: 0,
			staleFiles: 0,
			unqualifiedFiles: 0,
			openByRemedy: { write_test: 0, strengthen_tests: 2, unknown: 0 },
			score: 0.83,
		},
		files: [fileRow("src/a.ts", 2)],
		symbols: [
			{
				file: "src/a.ts",
				symbolId: "sym",
				qualifiedName: "doThing",
				open: 2,
				dispositioned: 0,
				uncovered: 0,
				total: 12,
				quarantined: false,
			},
		],
		mutators: [{ mutator: "BooleanLiteral", open: 2, total: 4, escapeRate: 0.5 }],
		mutants: [
			{
				file: "src/a.ts",
				symbolId: "sym",
				qualifiedName: "doThing",
				mutantId: "m1",
				mutator: "BooleanLiteral",
				originalLexeme: "true",
				replacement: "false",
				firstSeen: "2026-08-01T00:00:00.000Z",
				disposition: null,
			},
		],
		...over,
	};
}

describe("parseShard", () => {
	it("P1: parses the i/n form into a zero-based index and count", () => {
		expect(parseShard("2/3")).toEqual({ index: 1, count: 3 });
	});

	it("P2: parses the first shard", () => {
		expect(parseShard("1/2")).toEqual({ index: 0, count: 2 });
	});

	it("N1: rejects a shard index outside its count", () => {
		expect(parseShard("3/2")).toBeNull();
	});

	it("N2: rejects malformed input rather than guessing", () => {
		for (const bad of ["", "2", "a/b", "0/2", "2/0", "-1/3"]) expect(parseShard(bad)).toBeNull();
	});

	it("P3: the last shard (i === n) is valid — the boundary the `>` check protects", () => {
		expect(parseShard("3/3")).toEqual({ index: 2, count: 3 });
	});

	it("P4: a single-shard spec (1/1) is valid", () => {
		expect(parseShard("1/1")).toEqual({ index: 0, count: 1 });
	});

	it("P5: surrounding whitespace is trimmed before parsing", () => {
		expect(parseShard(" 2/3 ")).toEqual({ index: 1, count: 3 });
	});

	it("P6: multi-digit shard numbers parse in full, not just their first digit", () => {
		expect(parseShard("10/20")).toEqual({ index: 9, count: 20 });
	});

	it("N3: trailing junk after a valid i/n is rejected, not silently accepted", () => {
		expect(parseShard("2/3x")).toBeNull();
	});

	it("N4: a shard number so large it overflows to Infinity is rejected, not accepted", () => {
		// A finite-looking regex match whose Number() conversion overflows —
		// the only reachable way to make the `!Number.isFinite` guard fire, since
		// the regex admits digits only, so anything shorter never trips it.
		expect(parseShard(`1/${"9".repeat(400)}`)).toBeNull();
	});
});

describe("shardOf", () => {
	it("P1: round-robins so every shard gets comparable total work", () => {
		const rows = ["a", "b", "c", "d", "e"];
		expect(shardOf(rows, { index: 0, count: 2 })).toEqual(["a", "c", "e"]);
		expect(shardOf(rows, { index: 1, count: 2 })).toEqual(["b", "d"]);
	});

	it("P2: the shards partition the input exactly — nothing lost, nothing duplicated", () => {
		const rows = Array.from({ length: 17 }, (_, i) => `f${i}`);
		const union = [0, 1, 2].flatMap((index) => shardOf(rows, { index, count: 3 }));
		expect(union.sort()).toEqual([...rows].sort());
	});

	it("N1: a single shard is the identity", () => {
		expect(shardOf(["a", "b"], { index: 0, count: 1 })).toEqual(["a", "b"]);
	});

	it("N2: sharding an empty list yields an empty list", () => {
		expect(shardOf([], { index: 1, count: 2 })).toEqual([]);
	});
});

// ===========================================
// End-to-end: the two options whose whole behavior is "which files reach the
// report" (--include-stale, --file) can only be pinned against a real manifest
// on disk, because the filtering happens in the command, not the renderer.
// ===========================================
describe("mutationSurvivorsCommand — file scope options", () => {
	let cwd: string;
	let logs: string[];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-survivors-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "here.ts"), "export const x = 1;\n");
		writeFileSync(
			join(cwd, ".interlinked", "mutation-manifest.json"),
			JSON.stringify({
				version: 1,
				generation: 1,
				authoritativeAt: "2026-08-09T00:00:00.000Z",
				engine: "stryker",
				engineVersion: "8",
				dependencyGraphVersion: "1",
				environmentHash: "env",
				files: {
					"src/here.ts": {
						s1: {
							symbolId: "s1",
							qualifiedName: "here",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: {
								m1: {
									mutantId: "m1",
									siteId: "site1",
									mutator: "BooleanLiteral",
									originalLexeme: "true",
									replacement: "false",
									ordinalWithinSymbol: 0,
									status: "survived",
									firstSeen: "2026-08-01T00:00:00.000Z",
								},
							},
						},
					},
					"src/deleted.ts": {
						s2: {
							symbolId: "s2",
							qualifiedName: "gone",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: {
								m2: {
									mutantId: "m2",
									siteId: "site2",
									mutator: "BooleanLiteral",
									originalLexeme: "true",
									replacement: "false",
									ordinalWithinSymbol: 0,
									status: "survived",
									firstSeen: "2026-08-01T00:00:00.000Z",
								},
							},
						},
					},
				},
			}),
		);
		clearManifestCache();
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
	});

	function reported(): SurvivorSummary {
		return parseWire(JSON.parse(logs.join("\n")), isCapturedSurvivorSummary, "test JSON value");
	}

	it("P1: hides survivors in files that no longer exist by default", async () => {
		await mutationSurvivorsCommand({ cwd, json: true });
		const s = reported();
		expect(s.files.map((f) => f.file)).toEqual(["src/here.ts"]);
		expect(s.totals.open).toBe(1);
	});

	it("P2: --include-stale lists them, and the totals grow to match", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, includeStale: true });
		const s = reported();
		expect(s.files.map((f) => f.file).sort()).toEqual(["src/deleted.ts", "src/here.ts"]);
		expect(s.totals.open).toBe(2);
		expect(s.totals.staleFiles).toBe(1);
	});

	it("N1: --file narrows to the one path and reports only its mutants", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, file: "here.ts" });
		const s = reported();
		expect(s.mutants.map((m) => m.mutantId)).toEqual(["m1"]);
	});

	it("N2: a missing manifest is an error exit, not an empty success", async () => {
		const bare = mkdtempSync(join(tmpdir(), "mutation-survivors-bare-"));
		await mutationSurvivorsCommand({ cwd: bare, json: true });
		expect(process.exitCode).toBe(1);
		const message = logs.join("\n");
		expect(message).toMatch(/No mutation manifest at/);
		expect(message).toContain("mutation-manifest.json");
		expect(message).toContain("interlinked mutation measure <file> --record");
		process.exitCode = 0;
		rmSync(bare, { recursive: true, force: true });
	});

	it("P3: --shard narrows the report to this machine's slice of the ranked files", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, includeStale: true, shard: "1/2" });
		const s = reported();
		// Round-robin over the two manifest files (deleted.ts, here.ts in ranked
		// order) — shard 1/2 keeps every other one, starting at index 0.
		expect(s.files.length).toBeLessThan(2);
		expect(s.files.length).toBeGreaterThan(0);
	});

	it("N3: an invalid --shard is refused before the manifest is even loaded", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, shard: "0/2" });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--shard must be/);
		process.exitCode = 0;
	});

	it("N4: a corrupt manifest (JSON parses but fails the schema) reports CORRUPT, distinct from missing, and exits 1", async () => {
		// Missing the required `files` object — parses fine as JSON, fails
		// `parseManifestShell`'s schema check, hitting the corrupt branch
		// rather than the "no manifest" branch N2 already covers.
		writeFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), JSON.stringify({ version: 1 }));
		clearManifestCache();
		await mutationSurvivorsCommand({ cwd, json: true });
		expect(process.exitCode).toBe(1);
		const message = logs.join("\n");
		expect(message).toContain("is CORRUPT (manifest JSON parsed but does not match the manifest schema)");
		expect(message).not.toMatch(/No mutation manifest at/);
		process.exitCode = 0;
	});
});

describe("renderSurvivorReport", () => {
	it("P1: leads with the totals line and the ranked files", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("src/a.ts");
		expect(text).toMatch(/open/i);
	});

	it("P2: --top truncates the file table and says how many were hidden", () => {
		const files = Array.from({ length: 5 }, (_, i) => fileRow(`src/f${i}.ts`, 5 - i));
		const text = renderSurvivorReport(summary({ files }), { top: 2 });
		expect(text).toContain("src/f0.ts");
		expect(text).not.toContain("src/f4.ts");
		expect(text).toContain("3 more");
	});

	it("P3: a file-scoped report lists the individual mutants to kill", () => {
		const text = renderSurvivorReport(summary(), { top: 20, file: "src/a.ts" });
		expect(text).toContain("Surviving mutants (kill these)");
		expect(text).toContain("doThing");
		expect(text).toContain("true");
		expect(text).toContain("false");
	});

	it("P3a: a file-scoped report grounds each new test in a contract", () => {
		const text = renderSurvivorReport(summary(), { top: 20, file: "src/a.ts" });
		expect(text).toContain(
			"// test-contract: <public-api|invariant|bug|security|boundary> — <specific rationale>",
		);
	});

	it("P4: reports stale files so nobody chases survivors in deleted code", () => {
		const s = summary();
		s.totals.staleFiles = 2;
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).toMatch(/stale/i);
		expect(text).not.toContain("Stryker was here");
	});

	it("N1: a clean manifest renders a done message, not an empty table", () => {
		const s = summary({ files: [], symbols: [], mutants: [], mutators: [] });
		s.totals.open = 0;
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).toMatch(/no open surviving mutants/i);
		expect(text).not.toContain("Stryker was here");
		expect(text).not.toContain("test-contract:");
		expect(text).toContain("\n");
	});

	it("N2: never renders NaN when the manifest is empty", () => {
		const s = summary({ files: [], symbols: [], mutants: [], mutators: [] });
		s.totals = { ...s.totals, mutants: 0, killed: 0, survived: 0, open: 0, score: 1 };
		expect(renderSurvivorReport(s, { top: 20 })).not.toContain("NaN");
	});

	it("P5: warns when files carry no measurement provenance, naming the share and the fix", () => {
		const s = summary();
		s.totals.unqualifiedFiles = 1;
		s.totals.files = 1;
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).toMatch(/no measurement provenance/i);
		expect(text).toContain("100%");
		expect(text).toContain("mutation sweep");
	});

	it("P6: prints the shard-of-total note when the report is scoped to a shard", () => {
		const text = renderSurvivorReport(summary(), { top: 20, shard: { index: 0, count: 4 } });
		expect(text).toContain("shard 1/4");
	});
});

describe("renderSurvivorReport — totals line", () => {
	it("prints every totals field, in order, joined by the separator", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain(
			"12 mutants · 10 killed · 2 open survivors (0 need a test, 2 need stronger assertions, 0 unqualified) · 0 judged · 0 uncovered · score 83%",
		);
	});
});

describe("renderSurvivorReport — remedy grouping", () => {
	it("sorts the default (unknown-remedy) fixture into exactly the unqualified group", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("Unqualified — re-measure before you act on these");
		expect(text).toContain("No provenance: the counts came from an unknown test scope.");
		expect(text).not.toContain("No test runs against these files — write one");
		expect(text).not.toContain("Tests run but do not detect the change — strengthen the assertions");
	});

	it("groups a write_test-remedy file under the write-a-test heading", () => {
		const files: SurvivorFileRow[] = [{ ...fileRow("src/needs-test.ts", 4), remedy: "write_test" }];
		const text = renderSurvivorReport(summary({ files }), { top: 20 });
		expect(text).toContain("No test runs against these files — write one");
		expect(text).toContain("Every mutant here survives because nothing executes the code.");
		expect(text).toContain("src/needs-test.ts");
		expect(text).not.toContain("Stryker was here");
	});

	it("groups a strengthen_tests-remedy file under the strengthen-assertions heading", () => {
		const files: SurvivorFileRow[] = [{ ...fileRow("src/weak-tests.ts", 4), remedy: "strengthen_tests" }];
		const text = renderSurvivorReport(summary({ files }), { top: 20 });
		expect(text).toContain("Tests run but do not detect the change — strengthen the assertions");
		expect(text).toContain("The tests execute this code and pass while it behaves differently.");
		expect(text).toContain("src/weak-tests.ts");
	});

	it("only lists a file under the ONE remedy group its own remedy matches", () => {
		const files: SurvivorFileRow[] = [
			{ ...fileRow("src/w.ts", 3), remedy: "write_test" },
			{ ...fileRow("src/u.ts", 2), remedy: "unknown" },
		];
		const text = renderSurvivorReport(summary({ files }), { top: 20 });
		expect(text.split("src/u.ts").length - 1).toBe(1);
		expect(text.split("src/w.ts").length - 1).toBe(2);
	});

	it("excludes a file with zero open survivors even when its remedy matches the group", () => {
		const files: SurvivorFileRow[] = [
			{ ...fileRow("src/clean.ts", 0), remedy: "write_test" },
			{ ...fileRow("src/w.ts", 3), remedy: "write_test" },
		];
		const text = renderSurvivorReport(summary({ files }), { top: 20 });
		expect(text).not.toContain("src/clean.ts");
		expect(text).toContain("src/w.ts");
	});
});

describe("renderSurvivorReport — file table", () => {
	it("prints the column header and each file's own score", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("open  uncov  tests  score  file");
		// src/a.ts's OWN row score (0.5) — distinct from the totals line's 83%,
		// so this can only come from the per-row map running for real.
		expect(text).toContain("50%");
		expect(text).not.toContain("Stryker was here");
	});

	it("does not claim more files are hidden when every row is already shown", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).not.toMatch(/more file/i);
	});

	it("shows the exact test count when a file's provenance is known", () => {
		const files: SurvivorFileRow[] = [
			{
				...fileRow("src/known.ts", 2),
				provenance: { at: "2026-08-01T00:00:00.000Z", scope: "import_graph", testCount: 7, surface: "measure" },
			},
		];
		const text = renderSurvivorReport(summary({ files }), { top: 20 });
		expect(text).not.toContain("?");
	});

	it("shows ? when a file carries no measurement provenance", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("?");
	});
});

describe("renderSurvivorReport — mutator table", () => {
	it("lists mutators that still have open survivors and excludes fully-resolved ones", () => {
		const mutators: SurvivorMutatorRow[] = [
			{ mutator: "EscapeThis", open: 3, total: 5, escapeRate: 0.6 },
			{ mutator: "NeverShowThis", open: 0, total: 4, escapeRate: 0 },
		];
		const text = renderSurvivorReport(summary({ mutators }), { top: 20 });
		expect(text).toContain("Mutators that escape most often");
		expect(text).toContain("open  of total  escape  mutator");
		expect(text).toContain("EscapeThis");
		expect(text).not.toContain("NeverShowThis");
		expect(text).not.toContain("Stryker was here");
	});

	it("omits the mutator section entirely when nothing escapes", () => {
		const mutators: SurvivorMutatorRow[] = [{ mutator: "AllClear", open: 0, total: 4, escapeRate: 0 }];
		const text = renderSurvivorReport(summary({ mutators }), { top: 20 });
		expect(text).not.toContain("Mutators that escape most often");
	});

	it("truncates the mutator table to --top and hides the rest", () => {
		const mutators: SurvivorMutatorRow[] = [
			{ mutator: "First", open: 5, total: 5, escapeRate: 1 },
			{ mutator: "Second", open: 4, total: 5, escapeRate: 0.8 },
			{ mutator: "Third", open: 3, total: 5, escapeRate: 0.6 },
		];
		const text = renderSurvivorReport(summary({ mutators }), { top: 2 });
		expect(text).toContain("First");
		expect(text).toContain("Second");
		expect(text).not.toContain("Third");
	});
});

describe("renderSurvivorReport — symbol table (file-scoped)", () => {
	it("lists symbols with open survivors and excludes resolved ones", () => {
		const symbols: SurvivorSymbolRow[] = [
			{
				file: "src/a.ts",
				symbolId: "s1",
				qualifiedName: "escapeFn",
				open: 2,
				dispositioned: 0,
				uncovered: 0,
				total: 5,
				quarantined: false,
			},
			{
				file: "src/a.ts",
				symbolId: "s2",
				qualifiedName: "cleanFn",
				open: 0,
				dispositioned: 0,
				uncovered: 0,
				total: 3,
				quarantined: false,
			},
		];
		const text = renderSurvivorReport(summary({ symbols }), { top: 20, file: "src/a.ts" });
		expect(text).toContain("Symbols to fix");
		expect(text).toContain("escapeFn");
		expect(text).not.toContain("cleanFn");
		expect(text).not.toContain("Stryker was here");
	});

	it("omits the symbol table entirely when nothing is open", () => {
		const symbols: SurvivorSymbolRow[] = [
			{
				file: "src/a.ts",
				symbolId: "s2",
				qualifiedName: "cleanFn",
				open: 0,
				dispositioned: 0,
				uncovered: 0,
				total: 3,
				quarantined: false,
			},
		];
		const text = renderSurvivorReport(summary({ symbols }), { top: 20, file: "src/a.ts" });
		expect(text).not.toContain("Symbols to fix");
	});

	it("truncates the symbol table to --top and hides the rest", () => {
		const symbols: SurvivorSymbolRow[] = ["firstFn", "secondFn", "thirdFn"].map((qualifiedName, i) => ({
			file: "src/a.ts",
			symbolId: `s${i}`,
			qualifiedName,
			open: 3 - i,
			dispositioned: 0,
			uncovered: 0,
			total: 5,
			quarantined: false,
		}));
		const text = renderSurvivorReport(summary({ symbols }), { top: 2, file: "src/a.ts" });
		expect(text).toContain("firstFn");
		expect(text).toContain("secondFn");
		expect(text).not.toContain("thirdFn");
	});
});

describe("renderSurvivorReport — mutant table (file-scoped)", () => {
	it("omits the mutant table entirely when the scope has none", () => {
		const text = renderSurvivorReport(summary({ mutants: [] }), { top: 20, file: "src/a.ts" });
		expect(text).not.toContain("Surviving mutants (kill these)");
	});

	it("truncates the mutant table to --top and hides the rest, with no placeholder text", () => {
		const mutants: SurvivorMutantRow[] = ["mFirst", "mSecond", "mThird"].map((mutantId) => ({
			file: "src/a.ts",
			symbolId: "sym",
			qualifiedName: "doThing",
			mutantId,
			mutator: "BooleanLiteral",
			originalLexeme: "true",
			replacement: "false",
			firstSeen: "2026-08-01T00:00:00.000Z",
			disposition: null,
		}));
		const text = renderSurvivorReport(summary({ mutants }), { top: 2, file: "src/a.ts" });
		expect(text).toContain("mFirst");
		expect(text).toContain("mSecond");
		expect(text).not.toContain("mThird");
		expect(text).not.toContain("Stryker was here");
	});

	it("truncates long lexeme/replacement text instead of dumping it whole", () => {
		const mutants: SurvivorMutantRow[] = [
			{
				file: "src/a.ts",
				symbolId: "sym",
				qualifiedName: "doThing",
				mutantId: "mBig",
				mutator: "StringLiteral",
				originalLexeme: "A".repeat(100),
				replacement: "B".repeat(100),
				firstSeen: "2026-08-01T00:00:00.000Z",
				disposition: null,
			},
		];
		const text = renderSurvivorReport(summary({ mutants }), { top: 20, file: "src/a.ts" });
		expect(text).toContain("A".repeat(50));
		expect(text).toContain("B".repeat(50));
		expect(text).not.toContain("A".repeat(100));
		expect(text).not.toContain("B".repeat(100));
	});
});

describe("renderSurvivorReport — provenance and stale notes", () => {
	it("says nothing about provenance when every file is qualified", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).not.toMatch(/measurement provenance/i);
		expect(text).not.toContain("Stryker was here");
	});

	it("computes the unqualified share by division, not multiplication", () => {
		const s = summary();
		s.totals = { ...s.totals, unqualifiedFiles: 1, files: 4 };
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).toContain("25%");
		expect(text).toContain("their counts were recorded under an unknown test scope and are NOT comparable.");
		expect(text).not.toContain("Stryker was here");
	});

	it("never divides by zero files — no NaN or Infinity in the share", () => {
		const s = summary();
		s.totals = { ...s.totals, unqualifiedFiles: 1, files: 0 };
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("Infinity");
	});

	it("says nothing about stale files when none are stale", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).not.toMatch(/no longer exist/i);
		expect(text).not.toContain("Stryker was here");
	});
});

describe("renderSurvivorReport — next steps", () => {
	it("file-scoped view suggests killing one test, not the next-file pointer", () => {
		const text = renderSurvivorReport(summary(), { top: 20, file: "src/a.ts" });
		expect(text).toContain("Kill one: add a test that fails under the replacement, then");
		expect(text).toContain("re-measure with: interlinked mutation measure src/a.ts --record");
		expect(text).not.toContain("Next: interlinked mutation survivors --file");
		expect(text).not.toContain("Stryker was here");
	});

	it("repo-wide view points at the worst file, not the kill-one message", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("Next: interlinked mutation survivors --file src/a.ts");
		expect(text).not.toContain("Kill one: add a test that fails under the replacement");
		expect(text).not.toContain("test-contract:");
		expect(text).not.toContain("interlinked mutation measure");
		expect(text).not.toContain("Stryker was here");
	});

	it("suggests nothing when every open file is stale (no crash, no pointer)", () => {
		const base = summary();
		const files: SurvivorFileRow[] = [{ ...fileRow("src/stale-only.ts", 3), stale: true }];
		const s = { ...base, files, totals: { ...base.totals, open: 3 } };
		// A broken `!worst` guard either suppresses the real suggestion or falls
		// through to `worst.file` on an undefined `worst` — both are defects, so
		// this wraps the whole thing so either a crash or a wrong assertion fails
		// the same way.
		expect(() => {
			const text = renderSurvivorReport(s, { top: 20 });
			expect(text).not.toContain("Next: interlinked mutation survivors --file");
			// Pins that the rest of the report still rendered normally — a stub
			// that swallowed the whole render (or threw and got caught elsewhere)
			// would also satisfy the not.toContain check above.
			expect(text).toContain("Mutators that escape most often");
			expect(text).toContain("BooleanLiteral");
		}).not.toThrow();
	});

	it("does not suggest a file whose survivors are already resolved (open === 0)", () => {
		const base = summary();
		const files: SurvivorFileRow[] = [{ ...fileRow("src/resolved.ts", 0) }];
		const s = { ...base, files, totals: { ...base.totals, open: 5 } };
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).not.toContain("Next: interlinked mutation survivors --file src/resolved.ts");
	});
});

describe("renderSurvivorReport — structure", () => {
	it("prints the report header and the manifest generation/measured-at line", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("Mutation survivors");
		expect(text).toContain("manifest generation 3, measured 2026-08-09T00:00:00.000Z");
	});

	it("joins the report's lines with real newlines, not a flat string", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("\n");
	});
});

describe("mutationSurvivorsCommand — --top parsing, --short, --include-dispositioned", () => {
	let cwd: string;
	let logs: string[];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-survivors-top-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		for (const f of ["f0.ts", "f1.ts", "f2.ts"]) {
			writeFileSync(join(cwd, "src", f), "export const x = 1;\n");
		}
		const mutantOf = (id: string, extra: Record<string, unknown> = {}) => ({
			mutantId: id,
			siteId: `site-${id}`,
			mutator: "BooleanLiteral",
			originalLexeme: "true",
			replacement: "false",
			ordinalWithinSymbol: 0,
			status: "survived",
			firstSeen: "2026-08-01T00:00:00.000Z",
			...extra,
		});
		writeFileSync(
			join(cwd, ".interlinked", "mutation-manifest.json"),
			JSON.stringify({
				version: 1,
				generation: 1,
				authoritativeAt: "2026-08-09T00:00:00.000Z",
				engine: "stryker",
				engineVersion: "8",
				dependencyGraphVersion: "1",
				environmentHash: "env",
				files: {
					"src/f0.ts": {
						s0: {
							symbolId: "s0",
							qualifiedName: "f0Fn",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: {
								m0a: mutantOf("m0a"),
								m0b: mutantOf("m0b", { disposition: { kind: "unresolved" } }),
							},
						},
					},
					"src/f1.ts": {
						s1: {
							symbolId: "s1",
							qualifiedName: "f1Fn",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: { m1a: mutantOf("m1a") },
						},
					},
					"src/f2.ts": {
						s2: {
							symbolId: "s2",
							qualifiedName: "f2Fn",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: { m2a: mutantOf("m2a") },
						},
					},
				},
			}),
		);
		clearManifestCache();
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
	});

	it("--top 2 truncates the file table to 2 rows, not the default 20", async () => {
		await mutationSurvivorsCommand({ cwd, top: "2" });
		const text = logs.join("\n");
		expect(text).toContain("src/f0.ts");
		expect(text).toContain("src/f1.ts");
		expect(text).not.toContain("src/f2.ts");
	});

	it("an unparseable --top falls back to the default limit instead of showing nothing", async () => {
		await mutationSurvivorsCommand({ cwd, top: "abc" });
		const text = logs.join("\n");
		// Once in the file table row, once in the "Next:" suggestion — a broken
		// fallback slices the table to nothing and leaves only the second.
		expect(text.split("src/f0.ts").length - 1).toBe(2);
	});

	it("a negative --top falls back to the default limit instead of a negative slice", async () => {
		await mutationSurvivorsCommand({ cwd, top: "-5" });
		const text = logs.join("\n");
		expect(text.split("src/f0.ts").length - 1).toBe(2);
	});

	it("--short prints the real one-line summary, not a stub", async () => {
		await mutationSurvivorsCommand({ cwd, short: true });
		const text = logs.join("\n");
		expect(text).toContain("3 open survivors across 3 file(s), score 0%");
	});

	it("--include-dispositioned reveals judged survivors that are hidden by default", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, file: "f0.ts" });
		const hidden = parseWire(JSON.parse(logs.join("\n")), isCapturedSurvivorSummary, "test JSON value");
		expect(hidden.mutants.map((m) => m.mutantId)).toEqual(["m0a"]);

		logs = [];
		await mutationSurvivorsCommand({ cwd, json: true, file: "f0.ts", includeDispositioned: true });
		const shown = parseWire(JSON.parse(logs.join("\n")), isCapturedSurvivorSummary, "test JSON value");
		expect(shown.mutants.map((m) => m.mutantId).sort()).toEqual(["m0a", "m0b"]);
	});
});
