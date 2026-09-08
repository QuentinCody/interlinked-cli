import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyManifest, loadManifest } from "../harness/mutation/manifest.js";
import type { MeasureOutcome, SurvivorEntry } from "../harness/mutation/measure.js";
import type { MutationTestScopeResult } from "../harness/mutation/test-scope.js";
import { c, header, kvLine } from "../lib/formatter.js";
import {
	maybeRecordMeasurement,
	type MeasureRecordSummary,
	measureOneFile,
	renderMeasureCommand,
	spawnVitestSuite,
	testScopeNote,
} from "./mutation-measure-support.js";

const FILE = "src/a.ts";
const CONTENT = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";

/** A Stryker-shaped report for CONTENT with one mutant at the `>` (mirrors
 *  measure.test.ts's own helper — kept local since that file isn't exported). */
function report(status: string): unknown {
	const line2 = CONTENT.split("\n")[1] ?? "";
	const col = line2.indexOf(">") + 1;
	return {
		engine: { exitCode: 0 },
		testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 1 },
		testFiles: { "src/a.test.ts": { tests: [{ id: "test-1", name: "f" }] } },
		files: {
			[FILE]: {
				source: CONTENT,
				mutants: [
					{
						mutatorName: "EqualityOperator",
						replacement: ">=",
						status,
						location: { start: { line: 2, column: col }, end: { line: 2, column: col + 1 } },
					},
				],
			},
		},
	};
}

function measuredOutcome(rawReport: unknown): MeasureOutcome {
	return { status: "measured", mutantCount: 1, survivorCount: 1, survivors: [], rawReport };
}

describe("testScopeNote", () => {
	it("reports the affected-test count when the graph resolved a scope", () => {
		const scope: MutationTestScopeResult = { tests: ["a.test.ts", "b.test.ts"] };
		expect(testScopeNote(scope)).toBe("test scope: 2 test(s) via the import graph\n");
	});

	it("reports the over-cap fallback with the true uncapped count", () => {
		const scope: MutationTestScopeResult = { tests: null, reason: "over_cap", uncappedCount: 500 };
		expect(testScopeNote(scope)).toBe(
			"test scope: graph selected 500 test(s), over cap — falling back to filename-glob scope\n",
		);
	});

	it("is silent for an unknown-file scope (no tests, no over_cap reason)", () => {
		const scope: MutationTestScopeResult = { tests: null, reason: "unknown_file" };
		expect(testScopeNote(scope)).toBe("");
	});

	it("is silent when tests is null and reason is absent entirely", () => {
		const scope: MutationTestScopeResult = { tests: null };
		expect(testScopeNote(scope)).toBe("");
	});
});

describe("spawnVitestSuite", () => {
	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.resetModules();
	});

	it("runs exactly the requested test paths and resolves the child exit result", async () => {
		vi.resetModules();
		const execFile = vi.fn((...args: unknown[]) => {
			const callback = args[3];
			if (typeof callback !== "function") throw new Error("expected execFile callback");
			callback(null, "vitest stdout", "vitest stderr");
			return { on: vi.fn() };
		});
		vi.doMock("node:child_process", () => ({ execFile }));
		const fresh = await import("./mutation-measure-support.js");

		await expect(fresh.spawnVitestSuite({ tests: ["src/a.test.ts"], cwd: "/repo" })).resolves.toEqual({
			exitCode: 0,
			stdout: "vitest stdout",
			stderr: "vitest stderr",
		});
		expect(execFile).toHaveBeenCalledWith(
			"npx",
			["vitest", "run", "src/a.test.ts"],
			expect.objectContaining({ cwd: "/repo", timeout: 180_000 }),
			expect.any(Function),
		);
		// The static import above is intentionally exercised too: it remains the
		// same public function used by callers, while the fresh import lets this
		// test replace only the child-process seam.
		expect(typeof spawnVitestSuite).toBe("function");
	});
});

describe("renderMeasureCommand — outcome rendering", () => {
	it("renders a not_measurable outcome with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "not_measurable",
			reason: "no_tests",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.yellow("  NOT MEASURABLE: no_tests")].join("\n"),
		);
	});

	it("falls back to 'unknown reason' when not_measurable carries none", () => {
		const outcome: MeasureOutcome = { status: "not_measurable", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.yellow("  NOT MEASURABLE: unknown reason")].join("\n"),
		);
	});

	it("renders a busy outcome distinctly from not_measurable, with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "busy",
			reason: "runner_busy: all endpoints busy",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				c.yellow("  RUNNER BUSY: runner_busy: all endpoints busy — not measured, retry later"),
			].join("\n"),
		);
	});

	it("falls back to 'all endpoints busy' when a busy outcome carries no reason", () => {
		const outcome: MeasureOutcome = { status: "busy", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				c.yellow("  RUNNER BUSY: all endpoints busy — not measured, retry later"),
			].join("\n"),
		);
	});

	it("renders an error outcome with its reason", () => {
		const outcome: MeasureOutcome = {
			status: "error",
			reason: "connection refused",
			mutantCount: 0,
			survivorCount: 0,
			survivors: [],
		};
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.red("  FAILED: connection refused")].join("\n"),
		);
	});

	it("renders partial evidence as not recorded while retaining parsed findings", () => {
		const outcome: MeasureOutcome = {
			status: "partial",
			reason: "engine exited 2",
			mutantCount: 2,
			survivorCount: 1,
			survivors: [{ line: 3, mutator: "EqualityOperator", replacement: ">=" }],
		};
		const rendered = renderMeasureCommand(FILE, outcome, null);
		expect(rendered).toContain("PARTIAL — NOT RECORDED: engine exited 2");
		expect(rendered).toContain("Parsed mutants");
		expect(rendered).toContain("L3  EqualityOperator");
	});

	it("falls back to 'unknown error' when an error outcome carries no reason", () => {
		const outcome: MeasureOutcome = { status: "error", mutantCount: 0, survivorCount: 0, survivors: [] };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), c.red("  FAILED: unknown error")].join("\n"),
		);
	});

	it("renders a measured outcome's mutant/survivor counts and each survivor line", () => {
		const survivors: SurvivorEntry[] = [{ line: 12, mutator: "EqualityOperator", replacement: ">=" }];
		const outcome: MeasureOutcome = { status: "measured", mutantCount: 3, survivorCount: 1, survivors };
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "3"),
				kvLine("Survivors", "1"),
				`    L12  EqualityOperator -> ${JSON.stringify(">=").slice(0, 90)}`,
			].join("\n"),
		);
	});

	it("truncates a long replacement in the survivor line", () => {
		const replacement = "x".repeat(200);
		const outcome: MeasureOutcome = {
			status: "measured",
			mutantCount: 1,
			survivorCount: 1,
			survivors: [{ line: 4, mutator: "StringLiteral", replacement }],
		};
		const rendered = renderMeasureCommand(FILE, outcome, null);
		const survivorLine = rendered.split("\n").at(-1) ?? "";
		expect(survivorLine).toContain(JSON.stringify(replacement).slice(0, 90));
		expect(survivorLine).not.toContain(JSON.stringify(replacement).slice(0, 91));
	});
});

describe("renderMeasureCommand — record-summary rendering", () => {
	const outcome: MeasureOutcome = { status: "measured", mutantCount: 0, survivorCount: 0, survivors: [] };

	it("renders nothing extra when record is null (no --record passed)", () => {
		expect(renderMeasureCommand(FILE, outcome, null)).toBe(
			[header(`Mutation Measure — ${FILE}`), kvLine("Mutants", "0"), kvLine("Survivors", "0")].join("\n"),
		);
	});

	it("renders 'not recorded' with the reason when recording was attempted but declined", () => {
		const record: MeasureRecordSummary = { recorded: false, reason: "zero mutants for this file" };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.yellow("  Not recorded: zero mutants for this file"),
			].join("\n"),
		);
	});

	it("falls back to 'unknown reason' when a declined record carries none", () => {
		const record: MeasureRecordSummary = { recorded: false };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.yellow("  Not recorded: unknown reason"),
			].join("\n"),
		);
	});

	it("renders a real before/after delta when both are present", () => {
		const record: MeasureRecordSummary = {
			recorded: true,
			before: { mutants: 4, survivors: 2 },
			after: { mutants: 4, survivors: 1 },
		};
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.green("  ✓ Recorded: 2/4 → 1/4 survivors/mutants (survivors/mutants, before → after)"),
			].join("\n"),
		);
	});

	it("renders '?' for whichever side (before/after) is missing", () => {
		const record: MeasureRecordSummary = { recorded: true };
		expect(renderMeasureCommand(FILE, outcome, record)).toBe(
			[
				header(`Mutation Measure — ${FILE}`),
				kvLine("Mutants", "0"),
				kvLine("Survivors", "0"),
				"",
				c.green("  ✓ Recorded: ? → ? survivors/mutants (survivors/mutants, before → after)"),
			].join("\n"),
		);
	});
});

describe("maybeRecordMeasurement", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-measure-support-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("no-ops (returns null) when --record was not passed", async () => {
		const result = await maybeRecordMeasurement({
			record: false,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toBeNull();
	});

	it("no-ops (returns null) when record is undefined", async () => {
		const result = await maybeRecordMeasurement({
			record: undefined,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toBeNull();
	});

	it("declines with a reason when the run was not measured, and folds in the outcome's own reason", () => {
		return maybeRecordMeasurement({
			record: true,
			outcome: { status: "error", reason: "connection refused", mutantCount: 0, survivorCount: 0, survivors: [] },
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		}).then((result) => {
			expect(result).toEqual({ recorded: false, reason: "run was error (connection refused) — nothing to record" });
		});
	});

	it("declines with a bare status when the non-measured outcome carries no reason", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: { status: "busy", mutantCount: 0, survivorCount: 0, survivors: [] },
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toEqual({ recorded: false, reason: "run was busy — nothing to record" });
	});

	// test-contract: invariant — review 2026-08-28 (Grok issue 2): the tri-state
	// contract binds EVERY mutation-state writer. A corrupt on-disk manifest must
	// refuse `--record` with the original bytes untouched — the old
	// `loadManifest() ?? emptyManifest()` treated corrupt as missing and replaced
	// damaged history with a fresh floor. Real filesystem, no mocks.
	it("N: refuses to record over a CORRUPT on-disk manifest, leaving its bytes unchanged", async () => {
		const manifestPath = join(dir, "mutation-manifest.json");
		const corruptBytes = "{ this is not json";
		writeFileSync(manifestPath, corruptBytes);
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Killed")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result?.recorded).toBe(false);
		expect(result?.reason).toContain("corrupt");
		expect(result?.reason).toContain("preserved");
		expect(readFileSync(manifestPath, "utf-8")).toBe(corruptBytes);
	});

	it("records a real measured-clean run into a fresh manifest on disk", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Survived")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result).toEqual({
			recorded: true,
			before: { mutants: 0, survivors: 0 },
			after: { mutants: 1, survivors: 1 },
		});
		// The write actually landed — loadManifest sees the same file this
		// command's own configDir points at.
		expect(loadManifest(dir)?.files[FILE]).toBeDefined();
	});

	it("preserves the fresh manifest metadata used by a recorded run", async () => {
		await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Killed")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		const manifest = loadManifest(dir);
		expect(manifest).toMatchObject({
			engine: "stryker",
			engineVersion: "unknown",
			dependencyGraphVersion: "1",
			environmentHash: "cli-measure",
		});
	});

	it("stamps supplied measurement provenance onto the recorded file", async () => {
		await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Killed")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
			provenance: { scope: "import_graph", testCount: 2, surface: "sweep" },
		});
		expect(loadManifest(dir)?.fileProvenance?.[FILE]).toMatchObject({
			scope: "import_graph",
			testCount: 2,
			surface: "sweep",
		});
	});

	it("builds on an existing on-disk manifest rather than starting fresh", async () => {
		const { saveManifest, mutationManifestPath } = await import("../harness/mutation/manifest.js");
		void mutationManifestPath; // imported only for symmetry with manifest.test.ts's pattern
		saveManifest(dir, emptyManifest({
			engine: "stryker",
			engineVersion: "1",
			dependencyGraphVersion: "g",
			environmentHash: "e",
			authoritativeAt: "t0",
		}));
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome(report("Killed")),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result?.recorded).toBe(true);
		expect(result?.after).toEqual({ mutants: 1, survivors: 0 });
	});

	it("declines without writing when the rawReport is not a recognizable report", async () => {
		const result = await maybeRecordMeasurement({
			record: true,
			outcome: measuredOutcome({ nonsense: true }),
			configDir: dir,
			key: FILE,
			content: CONTENT,
			cwd: dir,
		});
		expect(result?.recorded).toBe(false);
		expect(result?.reason).toContain("not a recognizable mutation report");
		expect(loadManifest(dir)).toBeNull();
	});
});

describe("preflightScopedSuite", () => {
	afterEach(() => {
		vi.doUnmock("../harness/mutation/baseline-suite.js");
		vi.resetModules();
	});

	async function runWithProbe(probe: { status: "green" | "red" | "skipped"; skipReason?: string }, quiet: boolean) {
		vi.resetModules();
		vi.doMock("../harness/mutation/baseline-suite.js", async () => {
			const actual = await vi.importActual<typeof import("../harness/mutation/baseline-suite.js")>(
				"../harness/mutation/baseline-suite.js",
			);
			return {
				...actual,
				probeScopedSuite: async () => ({ ...probe, testCount: 1, failures: [] }),
				redSuiteMessage: (value: { status: string }) => `red suite: ${value.status}`,
			};
		});
		const fresh = await import("./mutation-measure-support.js");
		return fresh.preflightScopedSuite({ tests: ["a.test.ts"], cwd: "/tmp", quiet });
	}

	it("returns the red-suite refusal from the probe", async () => {
		await expect(runWithProbe({ status: "red" }, false)).resolves.toBe("red suite: red");
	});

	it("warns when a skipped probe is not quiet", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await expect(runWithProbe({ status: "skipped", skipReason: "runner unavailable" }, false)).resolves.toBeNull();
			expect(stderr).toHaveBeenCalledWith("pre-flight skipped (runner unavailable) — suite health is unverified\n");
		} finally {
			stderr.mockRestore();
		}
	});

	it("does not warn for a green probe even when output is not quiet", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await expect(runWithProbe({ status: "green" }, false)).resolves.toBeNull();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
	});
});


// ===========================================
// measureOneFile — the whole single-file pipeline (resolve, scope, overlay,
// pre-flight, measure, record) as ONE reusable step. `mutation measure` and
// `mutation sweep` both drive it, so the RED-suite pre-flight policy and the
// record rules exist in exactly one place.
// ===========================================
describe("measureOneFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "measure-one-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), CONTENT);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const base = () => ({
		file: "src/a.ts",
		cwd: dir,
		configDir: join(dir, ".interlinked"),
		runnerUrl: "http://runner.invalid",
		skipPreflight: true,
		quiet: true,
	});

	it("P1: returns the measured outcome's counts", async () => {
		const result = await measureOneFile({
			...base(),
			measure: async () => measuredOutcome(report("Survived")),
		});
		expect(result.status).toBe("measured");
		expect(result.survivors).toBe(1);
		expect(result.mutants).toBe(1);
	});

	it("P1b: records the filename-fallback measurement regime when no graph tests are available", async () => {
		let seenScope: string[] | undefined;
		const result = await measureOneFile({
			...base(),
			record: true,
			measure: async (args) => {
				seenScope = args.testScope;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("measured");
		expect(seenScope).toBeUndefined();
		expect(result.record?.recorded).toBe(true);
		const provenance = loadManifest(join(dir, ".interlinked"))?.fileProvenance?.[FILE];
		expect(provenance).toMatchObject({
			scope: "glob_fallback",
			testCount: 0,
			surface: "measure",
		});
	});

	it("P2: records into the manifest when asked, and not otherwise", async () => {
		const measure = async () => measuredOutcome(report("Killed"));
		const norecord = await measureOneFile({ ...base(), measure });
		expect(norecord.record).toBeNull();
		const recorded = await measureOneFile({ ...base(), record: true, measure });
		expect(recorded.record?.recorded).toBe(true);
		expect(loadManifest(join(dir, ".interlinked"))).not.toBeNull();
	});

	it("P3: runs the RED-suite pre-flight unless skipped, and refuses on red", async () => {
		let ran = 0;
		const result = await measureOneFile({
			...base(),
			skipPreflight: false,
			preflight: async () => {
				ran += 1;
				return "the scoped suite is RED";
			},
			measure: async () => {
				throw new Error("must not measure against a red suite");
			},
		});
		expect(ran).toBe(1);
		expect(result.status).toBe("red_suite");
		expect(result.reason).toContain("RED");
	});

	it("P4: passes the busy status through instead of flattening it to an error", async () => {
		const result = await measureOneFile({
			...base(),
			measure: async () => ({ status: "busy" as const, reason: "503", mutantCount: 0, survivorCount: 0, survivors: [] }),
		});
		expect(result.status).toBe("busy");
	});

	it("N1: an unreadable path never reaches the runner", async () => {
		let called = false;
		const result = await measureOneFile({
			...base(),
			file: "src/missing.ts",
			measure: async () => {
				called = true;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("unreadable");
		expect(called).toBe(false);
		expect(result.mutants).toBe(0);
		expect(result.survivors).toBe(0);
		expect(result.survivorList).toEqual([]);
		expect(result.record).toBeNull();
		expect(result.notes).toEqual([]);
	});

	it("N2: no configured runner is its own status, not a failed run", async () => {
		const result = await measureOneFile({
			...base(),
			runnerUrl: undefined,
			measure: async () => measuredOutcome(report("Killed")),
		});
		expect(result.status).toBe("no_runner");
		expect(result.mutants).toBe(0);
		expect(result.survivors).toBe(0);
		expect(result.survivorList).toEqual([]);
		expect(result.record).toBeNull();
		expect(result.notes).toEqual([]);
	});

	it("N3: skipPreflight really skips it", async () => {
		let ran = 0;
		await measureOneFile({
			...base(),
			preflight: async () => {
				ran += 1;
				return null;
			},
			measure: async () => measuredOutcome(report("Killed")),
		});
		expect(ran).toBe(0);
	});

	it("P5: runnerUrls (plural, ordered) wins over a single runnerUrl when both are given", async () => {
		let seenEndpoints: string[] = [];
		await measureOneFile({
			...base(),
			runnerUrl: "http://single.invalid",
			runnerUrls: ["http://first.invalid", "http://second.invalid"],
			measure: async (a) => {
				seenEndpoints = a.endpoints;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(seenEndpoints).toEqual(["http://first.invalid", "http://second.invalid"]);
	});

	it("P5b: an empty runnerUrls list falls back to the single runnerUrl", async () => {
		const result = await measureOneFile({
			...base(),
			runnerUrls: [],
			measure: async (a) => {
				expect(a.endpoints).toEqual(["http://runner.invalid"]);
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("measured");
	});

	it("P6: with no explicit runner, falls back to the repo's configured per_edit_mutation endpoint + token", async () => {
		writeFileSync(
			join(dir, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ per_edit_mutation: { runner_url: "http://configured.invalid", token: "shh" } }),
		);
		let seen: { endpoints: string[]; token: string | undefined } = { endpoints: [], token: undefined };
		const result = await measureOneFile({
			file: "src/a.ts",
			cwd: dir,
			configDir: join(dir, ".interlinked"),
			skipPreflight: true,
			quiet: true,
			measure: async (a) => {
				seen = { endpoints: a.endpoints, token: a.token };
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("measured");
		expect(seen.endpoints).toEqual(["http://configured.invalid"]);
		expect(seen.token).toBe("shh");
	});

	it("P7: forwards quiet=false to the pre-flight runner", async () => {
		let seenQuiet: boolean | undefined;
		const result = await measureOneFile({
			...base(),
			skipPreflight: false,
			quiet: false,
			preflight: async (args) => {
				seenQuiet = args.quiet;
				return null;
			},
			measure: async () => measuredOutcome(report("Killed")),
		});
		expect(result.status).toBe("measured");
		expect(seenQuiet).toBe(false);
	});

	it("P8: omits an absent endpoint token instead of forwarding an undefined property", async () => {
		let sawTokenProperty = true;
		const result = await measureOneFile({
			...base(),
			measure: async (args) => {
				sawTokenProperty = "token" in args;
				return measuredOutcome(report("Killed"));
			},
		});
		expect(result.status).toBe("measured");
		expect(sawTokenProperty).toBe(false);
	});

	it("P9: includes a reason from the runner outcome in the result", async () => {
		const result = await measureOneFile({
			...base(),
			measure: async () => ({
				status: "busy" as const,
				reason: "runner is busy",
				mutantCount: 0,
				survivorCount: 0,
				survivors: [],
			}),
		});
		expect(result.reason).toBe("runner is busy");
	});
});
