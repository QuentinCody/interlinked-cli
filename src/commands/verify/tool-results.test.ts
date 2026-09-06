// ===========================================
// tool-results behavioral test
// ===========================================
// Drives every branch of runCodeQualityChecks's orchestration:
//   - undocumented-env aggregation (sort comparators, fileCount math, doc skip)
//   - verify-parity pass: cross-file switch discriminant, single-impl interface,
//     project LOC ratio (finite + infinite/"∞" rendering)
//   - PII config conditional spreads (both arms)
//   - unreadable-file try/catch in collectModuleExports + per-file pass
//   - .d.ts skip in the export-collection pass
// plus filterCodeQualityResults and runSuggestions.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { createScanProgress } from "./scan-progress.js";
import {
	applyPersistedSuppressions,
	clearCodeQualityResults,
	filterCodeQualityResults,
	filterCodeQualityResultsInPlace,
	runCodeQualityChecks,
	runCodeQualityChecksProgressive,
	runSuggestions,
} from "./tool-results.js";
import type { CodeQualityResults } from "./tool-results-types.js";

let tempDir: string;
let counter = 0;
const savedInterlinkedHome = process.env.INTERLINKED_HOME;

beforeEach(() => {
	// Use mkdtempSync so concurrent agents/tests never collide on a fixed path.
	tempDir = mkdtempSync(join(tmpdir(), `tool-results-test-${process.pid}-${++counter}-`));
	// getConfigDir() honors INTERLINKED_HOME; clear it so config resolution stays
	// strictly cwd-relative to our temp fixture and isn't pinned to a real repo.
	delete process.env.INTERLINKED_HOME;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	if (savedInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = savedInterlinkedHome;
});

/** Write a file under tempDir, creating parent dirs, return its absolute path. */
function fixture(relPath: string, content: string): string {
	const abs = join(tempDir, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

describe("runCodeQualityChecks", () => {
	it("returns a full CodeQualityResults object for an empty file set", () => {
		const r = runCodeQualityChecks([], tempDir);
		expect(r.strongTyping).toEqual([]);
		expect(r.suppressions).toEqual([]);
		expect(r.projectLocRatio).toEqual([]);
		expect(r.undocumentedEnvVars).toEqual([]);
		expect(r.crossFileSwitchDiscriminant).toEqual([]);
	});

	it("flags strong-typing issues on a file with `any` usage", () => {
		const file = fixture("bad.ts", "export function foo(x: any): any { return x; }\n");
		const r = runCodeQualityChecks([file], tempDir);
		expect(r.strongTyping.length).toBeGreaterThan(0);
	});

	it("aggregates one undocumented_env_vars issue per var across files, counting refs and files", () => {
		// Two refs to the SAME undocumented var in two distinct files -> one issue
		// with refs.length === 2 and fileCount === 2. The per-file/per-line sort
		// comparators run (different files => localeCompare arm; see same-file test).
		const v = `UNDOC_SYNTH_VAR_${process.pid}_${counter}`;
		const a = fixture("a.ts", `export const a = process.env.${v};\n`);
		const b = fixture("b.ts", `export const b = process.env.${v};\n`);
		const r = runCodeQualityChecks([a, b], tempDir);

		const hits = r.undocumentedEnvVars.filter((i) => i.message.includes(v));
		expect(hits.length).toBe(1);
		const issue = hits[0];
		expect(nonNull(issue).check).toBe("undocumented_env_vars");
		// "(2 references across 2 files)" — exercises refs.length and fileCount math.
		expect(nonNull(issue).message).toContain("2 references across 2 files");
		// firstRef is the lexicographically-first file (a.ts < b.ts).
		expect(nonNull(issue).file).toBe("a.ts");
		expect(nonNull(issue).line).toBe(1);
	});

	it("uses the line tiebreaker when an undocumented var is referenced twice in one file", () => {
		// Same file, two lines -> the firstRef sort's localeCompare returns 0 and
		// the `a.line - b.line` tiebreaker decides ordering (picks the earlier line).
		const v = `UNDOC_SAMEFILE_${process.pid}_${counter}`;
		const f = fixture(
			"solo.ts",
			`const x = "noop";\nexport const a = process.env.${v};\nexport const b = process.env.${v};\n`,
		);
		const r = runCodeQualityChecks([f], tempDir);
		const issue = r.undocumentedEnvVars.find((i) => i.message.includes(v));
		expect(issue).toBeDefined();
		expect(issue?.file).toBe("solo.ts");
		// Earliest reference is line 2 (line 1 is the noop string).
		expect(issue?.line).toBe(2);
		expect(issue?.message).toContain("2 references across 1 files");
	});

	it("skips documented env vars and reports only undocumented ones", () => {
		// .env.example documents KNOWN_* but not HIDDEN_*; both are referenced.
		// Names are chosen so neither is a substring of the other (avoids a
		// spurious `.includes` match between the two findings/messages).
		const docVar = `KNOWN_SYNTH_${process.pid}_${counter}`;
		const undocVar = `HIDDEN_SYNTH_${process.pid}_${counter}`;
		// Quoted assertions to be sure substring checks are unambiguous.
		const docQuoted = `"${docVar}"`;
		const undocQuoted = `"${undocVar}"`;
		fixture(".env.example", `${docVar}=value\n`);
		const f = fixture(
			"cfg.ts",
			`export const d = process.env.${docVar};\nexport const u = process.env.${undocVar};\n`,
		);
		const r = runCodeQualityChecks([f], tempDir);
		const msgs = r.undocumentedEnvVars.map((i) => i.message);
		// Documented var is filtered out (the `documentedEnvVars.has` arm fires).
		expect(msgs.some((m) => m.includes(docQuoted))).toBe(false);
		// Undocumented var is still reported.
		expect(msgs.some((m) => m.includes(undocQuoted))).toBe(true);
	});

	it("emits a cross_file_switch_discriminant finding when the same discriminant switches in two files", () => {
		const sw = "switch (node.kind) { case 1: break; default: break; }";
		const f1 = fixture("disc1.ts", `export function p(node: { kind: number }) { ${sw} }\n`);
		const f2 = fixture("disc2.ts", `export function q(node: { kind: number }) { ${sw} }\n`);
		const r = runCodeQualityChecks([f1, f2], tempDir);

		expect(r.crossFileSwitchDiscriminant.length).toBeGreaterThanOrEqual(2);
		const first = r.crossFileSwitchDiscriminant[0];
		expect(nonNull(first).check).toBe("cross_file_switch_discriminant");
		expect(nonNull(first).line).toBe(0);
		// Paths are relativized to cwd (tempDir) — no absolute prefix leaks.
		expect(nonNull(first).file === "disc1.ts" || nonNull(first).file === "disc2.ts").toBe(true);
		expect(nonNull(first).message).toContain("kind");
	});

	it("emits a single_implementation_interface finding for an interface with exactly one implementor", () => {
		const iface = fixture("shape.ts", "export interface Shape { area(): number; }\n");
		const impl = fixture(
			"circle.ts",
			"import type { Shape } from './shape';\nexport class Circle implements Shape { area() { return 1; } }\n",
		);
		const r = runCodeQualityChecks([iface, impl], tempDir);

		const hit = r.singleImplementationInterface.find((i) => i.message.includes("Shape"));
		expect(hit).toBeDefined();
		expect(hit?.check).toBe("single_implementation_interface");
		expect(hit?.line).toBe(0);
		expect(hit?.file).toBe("shape.ts");
		expect(hit?.message).toContain("one implementor");
	});

	it("renders a finite project LOC ratio when both prod and test files are present and over the limit", () => {
		// ~60 prod lines vs ~1 test line -> a finite ratio well over the 5:1
		// limit (so the ternary takes the toFixed(1) arm, not "∞").
		const prodBody = `${Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;
		const prod = fixture("big.ts", prodBody);
		const test = fixture("big.test.ts", "it('x', () => {});\n");
		const r = runCodeQualityChecks([prod, test], tempDir);

		expect(r.projectLocRatio.length).toBe(1);
		const issue = r.projectLocRatio[0];
		expect(nonNull(issue).check).toBe("project_loc_ratio");
		expect(nonNull(issue).file).toBe("<project>");
		// Finite ratio: rendered as a decimal "<n>.<d>:1" with a limit of 5:1,
		// never the "∞" sentinel.
		expect(nonNull(issue).message).toMatch(/ratio is \d+\.\d:1 \(limit 5:1\)/);
		expect(nonNull(issue).message).not.toContain("∞");
	});

	it("renders an infinite (∞) project LOC ratio when there are prod files but zero test lines", () => {
		// Only prod files -> testLoc === 0 -> ratio === Infinity -> exceeded, and
		// Number.isFinite is false so the message uses the "∞" arm of the ternary.
		const prod = fixture(
			"prodonly.ts",
			`${Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`,
		);
		const r = runCodeQualityChecks([prod], tempDir);

		expect(r.projectLocRatio.length).toBe(1);
		const issue = r.projectLocRatio[0];
		expect(nonNull(issue).message).toContain("∞:1");
		expect(nonNull(issue).message).not.toContain("Infinity");
	});

	it("honors PII config (pii_opt_in + pii_patterns) from .interlinked/config.json without throwing", () => {
		// Writing both keys drives the TRUE arm of both conditional spreads that
		// build piiOpts. We assert the run completes and returns a well-formed
		// result rather than asserting on the (config-dependent) PII findings.
		fixture(
			".interlinked/config.json",
			JSON.stringify({
				pii_opt_in: ["email"],
				pii_patterns: [{ name: "synthetic_id", pattern: "ZZ-\\d{4}", severity: "warning" }],
			}),
		);
		const f = fixture("svc.ts", "export const note = 'contact ZZ-1234';\n");
		const r = runCodeQualityChecks([f], tempDir);
		// Sanity: a known bucket exists and is an array (orchestration completed).
		expect(Array.isArray(r.strongTyping)).toBe(true);
		expect(Array.isArray(r.undocumentedEnvVars)).toBe(true);
	});

	it("skips unreadable files in both the export-collection and per-file passes without throwing", () => {
		// A path present in the file list but absent on disk makes readFileSync
		// throw in collectModuleExports (pass 1) AND the per-file loop (pass 2);
		// both catch-and-continue. A real sibling file proves the run still works.
		const ghost = join(tempDir, "does-not-exist.ts");
		const real = fixture("real.ts", "export function ok(x: any) { return x; }\n");
		const r = runCodeQualityChecks([ghost, real], tempDir);
		// The real file's `any` is still flagged (run didn't abort on the ghost).
		expect(r.strongTyping.some((i) => i.file === "real.ts")).toBe(true);
	});

	it("skips .d.ts files in the export-collection pass (no crash, processes siblings)", () => {
		// `.d.ts` has ext `.ts` (in JS_TS_EXTS) but endsWith('.d.ts') so the
		// export-collection `if` is false — the declaration file is not parsed
		// for exports. The sibling .ts is still processed normally.
		const decl = fixture("types.d.ts", "export declare const X: number;\n");
		const src = fixture("use.ts", "export function f(x: any) { return x; }\n");
		const r = runCodeQualityChecks([decl, src], tempDir);
		expect(r.strongTyping.some((i) => i.file === "use.ts")).toBe(true);
	});

	it("ignores non-JS/TS files in the export-collection pass", () => {
		// A markdown file isn't in JS_TS_EXTS -> export-collection `if` is false.
		const md = fixture("README.md", "# heading\nsome prose\n");
		const ts = fixture("code.ts", "export function g(x: any) { return x; }\n");
		const r = runCodeQualityChecks([md, ts], tempDir);
		expect(r.strongTyping.some((i) => i.file === "code.ts")).toBe(true);
	});
});

describe("filterCodeQualityResults", () => {
	it("drops issues whose check is in the skip set", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			strongTyping: [{ check: "strong_typing", file: "a.ts", line: 1, message: "m" }],
		};
		const filtered = filterCodeQualityResults(results, new Set(["strong_typing"]));
		expect(filtered.strongTyping).toEqual([]);
	});

	it("retains unrelated checks", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			largeFiles: [{ check: "large_files", file: "a.ts", line: 1, message: "m" }],
		};
		const filtered = filterCodeQualityResults(results, new Set(["strong_typing"]));
		expect(filtered.largeFiles.length).toBe(1);
	});

	it("does not mutate the input results object", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			strongTyping: [{ check: "strong_typing", file: "a.ts", line: 1, message: "m" }],
		};
		const before = results.strongTyping.length;
		filterCodeQualityResults(results, new Set(["strong_typing"]));
		expect(results.strongTyping.length).toBe(before);
	});

	it("drops issues across multiple buckets and keeps partial matches within a bucket", () => {
		const results: CodeQualityResults = {
			...runCodeQualityChecks([], tempDir),
			strongTyping: [
				{ check: "strong_typing", file: "a.ts", line: 1, message: "x" },
				{ check: "other_check", file: "b.ts", line: 2, message: "y" },
			],
			largeFiles: [{ check: "large_files", file: "c.ts", line: 3, message: "z" }],
		};
		const filtered = filterCodeQualityResults(
			results,
			new Set(["strong_typing", "large_files"]),
		);
		expect(filtered.strongTyping.map((i) => i.check)).toEqual(["other_check"]);
		expect(filtered.largeFiles).toEqual([]);
	});
});

describe("applyPersistedSuppressions — suppression-file hygiene findings", () => {
	it("pushes one suppressionHygiene issue per finding the validator reports", () => {
		const results = runCodeQualityChecks([], tempDir);
		applyPersistedSuppressions(results, join(tempDir, ".interlinked"), () => [
			{ name: "missing_rationale", file: "src/a.ts", message: "no reason given" },
		]);
		expect(results.suppressionHygiene).toEqual([
			{ check: "missing_rationale", file: "src/a.ts", line: 0, message: "no reason given" },
		]);
	});

	it("leaves suppressionHygiene empty when the default validator is used (the real stub returns none)", () => {
		const results = runCodeQualityChecks([], tempDir);
		applyPersistedSuppressions(results, join(tempDir, ".interlinked"));
		expect(results.suppressionHygiene).toEqual([]);
	});
});

describe("memory-bounded result ownership", () => {
	it("compacts an owned result in place without allocating replacement buckets", () => {
		const results = runCodeQualityChecks([], tempDir);
		const bucket = results.strongTyping;
		bucket.push(
			{ check: "drop", file: "a.ts", line: 1, message: "drop" },
			{ check: "keep", file: "b.ts", line: 2, message: "keep" },
		);

		const filtered = filterCodeQualityResultsInPlace(results, new Set(["drop"]));

		expect(filtered).toBe(results);
		expect(filtered.strongTyping).toBe(bucket);
		expect(filtered.strongTyping.map((row) => row.check)).toEqual(["keep"]);
	});

	it("clears every finding bucket after streaming has consumed the result", () => {
		const results = runCodeQualityChecks([], tempDir);
		results.strongTyping.push({ check: "a", file: "a.ts", line: 1, message: "a" });
		results.largeFiles.push({ check: "b", file: "b.ts", line: 2, message: "b" });

		clearCodeQualityResults(results);

		expect(Object.values(results).every((rows) => rows.length === 0)).toBe(true);
	});
});

// ===========================================
// runCodeQualityChecksProgressive
// ===========================================
// The progress-reporting entry point must be observationally identical to the
// synchronous one except for its stderr side-channel, and it must emit that
// side-channel WHILE the scan runs — the whole point of the change.

/** A clock that always jumps past the throttle window, so every file renders. */
function alwaysPastInterval(): () => number {
	let t = 0;
	return () => {
		t += 10_000;
		return t;
	};
}

describe("runCodeQualityChecksProgressive — equivalence with the sync entry point", () => {
	it("P1: returns exactly what runCodeQualityChecks returns for the same files", async () => {
		const a = fixture("a.ts", "export function foo(x: any): any { return x; }\n");
		const b = fixture("b.ts", "export const B = process.env.SOME_UNDOCUMENTED_VAR;\n");
		const sync = runCodeQualityChecks([a, b], tempDir);
		const async_ = await runCodeQualityChecksProgressive(
			[a, b],
			tempDir,
			createScanProgress(2, { write: () => {}, now: () => 0 }),
		);
		expect(async_).toEqual(sync);
	});

	it("P2: matches the sync entry point on an empty file set", async () => {
		const sync = runCodeQualityChecks([], tempDir);
		const async_ = await runCodeQualityChecksProgressive(
			[],
			tempDir,
			createScanProgress(0, { write: () => {}, now: () => 0 }),
		);
		expect(async_).toEqual(sync);
	});
});

describe("runCodeQualityChecksProgressive — progress is emitted during the scan", () => {
	it("P1: writes an intermediate per-file count while files still remain", async () => {
		const files = [
			fixture("p1.ts", "export const A = 1;\n"),
			fixture("p2.ts", "export const B = 2;\n"),
			fixture("p3.ts", "export const C = 3;\n"),
		];
		const chunks: string[] = [];
		await runCodeQualityChecksProgressive(
			files,
			tempDir,
			createScanProgress(files.length, { write: (c) => void chunks.push(c), now: alwaysPastInterval() }),
		);
		const out = chunks.join("");
		// "checks 1/3" can only have been written with two files still to scan.
		expect(out).toContain("scanning checks 1/3");
		expect(out).toContain("scanning checks 3/3");
	});

	it("P2: reports both passes by name", async () => {
		const files = [fixture("q1.ts", "export const A = 1;\n")];
		const chunks: string[] = [];
		await runCodeQualityChecksProgressive(
			files,
			tempDir,
			createScanProgress(1, { write: (c) => void chunks.push(c), now: alwaysPastInterval() }),
		);
		expect(chunks.join("")).toContain("scanning exports");
		expect(chunks.join("")).toContain("scanning checks");
	});

	it("N1: writes progress to stderr only — stdout stays untouched", async () => {
		const files = [fixture("r1.ts", "export const A = 1;\n")];
		const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Default deps => the real stderr writer.
		await runCodeQualityChecksProgressive(files, tempDir, createScanProgress(1));
		// Snapshot before restoring: mockRestore also resets the recorded calls.
		const errCalls = errSpy.mock.calls.length;
		const outCalls = outSpy.mock.calls.length;
		outSpy.mockRestore();
		errSpy.mockRestore();
		expect(errCalls).toBeGreaterThan(0);
		expect(outCalls).toBe(0);
	});
});

describe("runCodeQualityChecksProgressive — event-loop yielding", () => {
	it("P1: lets a queued macrotask run before the scan resolves", async () => {
		// More files than YIELD_EVERY_FILES (25), so at least one yield happens.
		const files = Array.from({ length: 26 }, (_, i) =>
			fixture(`y${i}.ts`, `export const Y${i} = ${i};\n`),
		);
		const order: string[] = [];
		const scan = runCodeQualityChecksProgressive(
			files,
			tempDir,
			createScanProgress(files.length, { write: () => {}, now: () => 0 }),
		).then(() => void order.push("scan"));
		// Queued after the first synchronous span; a non-yielding implementation
		// would settle its promise (a microtask) before this macrotask ever ran.
		setImmediate(() => void order.push("interrupt"));
		await scan;
		expect(order).toEqual(["interrupt", "scan"]);
	});
});

describe("runSuggestions", () => {
	it("returns empty map for no files", () => {
		const r = runSuggestions({ files: [], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips test files", () => {
		const file = fixture("foo.test.ts", "describe('x', () => { it('y', () => {}); });\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});
});
