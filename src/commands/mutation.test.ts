import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as checkPolicy from "../harness/check-policy.js";
import * as measureModule from "../harness/mutation/measure.js";
import { c, header, kvLine, stripAnsi } from "../lib/formatter.js";
import {
	mutationAcceptCommand,
	mutationBaselineCommand,
	mutationCheckCommand,
	mutationMeasureCommand,
} from "./mutation.js";

function captureIO(): {
	mocks: () => { stdout: string; stderr: string; exitCode: string | number | undefined };
	restore: () => void;
} {
	let stdout = "";
	let stderr = "";
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		stdout += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const rawStderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	return {
		mocks: () => ({ stdout, stderr, exitCode: process.exitCode }),
		restore: () => {
			logSpy.mockRestore();
			errSpy.mockRestore();
			rawStderrSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

function writeStrykerReport(
	cwd: string,
	perFile: Record<string, { killed: number; survived: number }>,
): void {
	mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
	const files: Record<string, unknown> = {};
	for (const [path, stats] of Object.entries(perFile)) {
		const mutants: Array<{ status: string }> = [];
		for (let i = 0; i < stats.killed; i++) mutants.push({ status: "Killed" });
		for (let i = 0; i < stats.survived; i++) mutants.push({ status: "Survived" });
		files[path] = { mutants };
	}
	writeFileSync(join(cwd, "reports", "mutation", "mutation.json"), JSON.stringify({ files }));
}

describe("mutationCheckCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-cli-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exits with guidance when no report is present", async () => {
		await mutationCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});

	it("writes the baseline when --update-baseline is set", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const saved = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "mutation-baseline.json"), "utf-8"),
		);
		expect(saved.files["src/foo.ts"].score).toBeCloseTo(0.9);
	});

	it("flags scores below the --min-score floor as warnings", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "0.8" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_below_floor"),
		).toBe(true);
	});

	it("emits an error finding on score regression and exits non-zero", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.9, killed: 9 } },
			}),
		);
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 7, survived: 3 } });
		await mutationCheckCommand({ cwd: tmp, json: true });
		expect(io.mocks().exitCode).toBe(1);
		const parsed = JSON.parse(io.mocks().stdout);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_decrease"),
		).toBe(true);
	});

	it("clamps out-of-range --min-score values", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "5" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(1);
	});

	it("restricts evaluation to --changed-files", async () => {
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 0, survived: 10 },
			"src/bar.ts": { killed: 0, survived: 10 },
		});
		await mutationCheckCommand({
			cwd: tmp,
			json: true,
			changedFiles: "src/foo.ts",
		});
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.stats.files_checked).toBe(1);
		expect(parsed.findings.every((f: { file: string }) => f.file === "src/foo.ts")).toBe(true);
	});

	it("reports a parse failure when the report file is not a valid report object", async () => {
		// resolveReportPath finds the file (it exists), but loadMutationReport
		// returns null because the parsed JSON is a bare string, not an object.
		mkdirSync(join(tmp, "reports", "mutation"), { recursive: true });
		writeFileSync(
			join(tmp, "reports", "mutation", "mutation.json"),
			JSON.stringify("not-a-report"),
		);
		await mutationCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Failed to parse mutation report");
		expect(io.mocks().stderr).toContain("mutation.json");
	});

	it("resolves an explicit --report path that exists", async () => {
		// Place the report at a non-default location to prove --report is used.
		mkdirSync(join(tmp, "custom"), { recursive: true });
		writeFileSync(
			join(tmp, "custom", "mut.json"),
			JSON.stringify({ files: { "src/foo.ts": { killed: 9, survived: 1 } } }),
		);
		await mutationCheckCommand({ cwd: tmp, json: true, report: "custom/mut.json" });
		expect(io.mocks().exitCode).toBeFalsy();
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.report).toContain(join("custom", "mut.json"));
		expect(parsed.stats.files_checked).toBe(1);
	});

	it("errors when an explicit --report path does not exist", async () => {
		await mutationCheckCommand({ cwd: tmp, report: "does/not/exist.json" });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});

	it("treats a non-finite --min-score as the 0.6 default floor", async () => {
		// killed=5/survived=5 → 50% score: below 0.6 (fires) but not below a
		// hypothetical lower clamp, so the floor we land on must be 0.6.
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 5, survived: 5 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "not-a-number" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(0.6);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_below_floor"),
		).toBe(true);
	});

	it("clamps a negative --min-score up to 0 (no floor findings)", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 0, survived: 10 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "-3" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(0);
		// With a floor of 0, even a 0% score is not "below floor".
		expect(parsed.findings).toHaveLength(0);
	});

	it("renders the human-readable gate with no regressions", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBeFalsy();
		expect(out).toContain("Mutation Gate");
		expect(out).toContain("Min score");
		expect(out).toContain("Files checked");
		expect(out).toContain("No mutation regressions");
	});

	it("renders regression errors and below-floor warnings in normal mode", async () => {
		// Baseline: foo at 90%. Current run drops foo to 40% (both a regression
		// AND below the 60% floor) and adds a brand-new bar at 20% (below-floor
		// only, no prior baseline → no regression).
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.9, killed: 9 } },
			}),
		);
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 4, survived: 6 },
			"src/bar.ts": { killed: 2, survived: 8 },
		});
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBe(1);
		expect(out).toContain("regression(s):");
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("90.0% → 40.0%");
		expect(out).toContain("below floor:");
		expect(out).toContain("src/bar.ts");
		expect(out).toContain("20.0%");
		expect(out).toContain("--update-baseline to accept");
	});

	it("renders only the regression block when nothing is below floor", async () => {
		// Baseline foo at 95%; current foo drops to 70% — a regression, but 70%
		// is still above the 60% floor, so there are errors and no warnings.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.95, killed: 19 } },
			}),
		);
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 7, survived: 3 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBe(1);
		expect(out).toContain("regression(s):");
		expect(out).toContain("95.0% → 70.0%");
		// No file was below the floor, so the warning block must be absent.
		expect(out).not.toContain("below floor:");
	});

	it("renders only the below-floor block for a new low-scoring file", async () => {
		// Brand-new file (no baseline) at 40% → a below-floor warning and, since
		// there is no prior score, no regression error.
		writeStrykerReport(tmp, { "src/fresh.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		// New-file-only below floor is a warning, not an error → exit stays clean.
		expect(io.mocks().exitCode).toBeFalsy();
		expect(out).toContain("below floor:");
		expect(out).toContain("src/fresh.ts");
		expect(out).toContain("40.0%");
		// No regression occurred, so the error block must be absent.
		expect(out).not.toContain("regression(s):");
	});

	it("surfaces a non-Error throw via String() in the catch path", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		// Force a thrown primitive (not an Error instance) from inside the try
		// block to exercise the `String(err)` ternary arm.
		// Deliberately reject with a non-Error primitive so the command's
		// `err instanceof Error ? err.message : String(err)` lands on String(err).
		const nonError: unknown = "policy-load-exploded";
		const spy = vi
			.spyOn(checkPolicy, "loadCheckPolicy")
			.mockImplementation((): never => {
				throw nonError;
			});
		try {
			await mutationCheckCommand({ cwd: tmp });
		} finally {
			spy.mockRestore();
		}
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("policy-load-exploded");
	});

	it("surfaces an Error thrown while persisting the baseline", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		// Make `.interlinked` a FILE so saveMutationBaseline's mkdirSync on that
		// path throws an Error, caught and reported by the command.
		writeFileSync(join(tmp, ".interlinked"), "i am a file, not a directory");
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr.toLowerCase()).toContain("error");
	});

	it("defaults cwd to process.cwd() when no --cwd is passed", async () => {
		// Drive the `opts.cwd || process.cwd()` fallback. From an empty working
		// directory there is no report, so we land on the guidance path.
		//
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a chdir here failed the mutation dry run
		// for EVERY file whose graph-selected test scope included this one —
		// reported only as a generic "There were failed tests in the initial test
		// run" (measured 2026-08-04). The spy tests the same fallback, is
		// process-global-free, and is safe under any pool.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
		try {
			await mutationCheckCommand({});
		} finally {
			spy.mockRestore();
		}
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});

	it("lists every default report path in the exact guidance message", async () => {
		await mutationCheckCommand({ cwd: tmp });
		expect(io.mocks().stderr).toBe(
			"Error: No mutation report found. Expected one of:\n  - reports/mutation/mutation.json\n  - reports/mutation/mutation-report.json\n  - .stryker-tmp/reports/mutation.json\nRun `npx stryker run` (or equivalent) first, or pass --report <path>.\n",
		);
	});

	it("does not write the baseline when --update-baseline is omitted", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "0.8" });
		expect(existsSync(join(tmp, ".interlinked", "mutation-baseline.json"))).toBe(false);
	});

	it("prints the exact checkmark confirmation with the full baseline path in normal mode", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true });
		const stderr = io.mocks().stderr;
		expect(stderr).toContain("✓");
		expect(stderr).toContain(`Mutation baseline updated at ${join(".interlinked", "mutation-baseline.json")}`);
	});

	it("suppresses the baseline confirmation message in --json mode", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true, json: true });
		expect(io.mocks().stderr).not.toContain("Mutation baseline updated");
	});

	it("keeps a --min-score already inside [0,1] unchanged (not forced to 1)", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "0.8" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(0.8);
	});

	it("trims whitespace and drops empty entries from --changed-files while still matching real files", async () => {
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 0, survived: 10 },
			"src/bar.ts": { killed: 0, survived: 10 },
		});
		await mutationCheckCommand({
			cwd: tmp,
			json: true,
			changedFiles: " src/foo.ts , , src/bar.ts ,  ",
		});
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.stats.files_checked).toBe(2);
	});

	it("renders the exact no-regressions structure, line for line", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp });
		const reportPath = join(tmp, "reports", "mutation", "mutation.json");
		const bodyLines = [
			...stripAnsi(header("Mutation Gate")).split("\n"),
			stripAnsi(kvLine("Report", reportPath)),
			stripAnsi(kvLine("Min score", "60%")),
			stripAnsi(kvLine("Files checked", "1")),
			stripAnsi(kvLine("New / Improved / Below floor / Decreased", "1 / 0 / 0 / 0")),
			"",
			stripAnsi(c.green("  ✓ No mutation regressions.")),
		];
		expect(stripAnsi(io.mocks().stdout)).toBe(`${bodyLines.join("\n")}\n`);
	});

	it("renders the exact regression + below-floor structure, line for line", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.9, killed: 9 } },
			}),
		);
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 4, survived: 6 },
			"src/bar.ts": { killed: 2, survived: 8 },
		});
		await mutationCheckCommand({ cwd: tmp });
		const reportPath = join(tmp, "reports", "mutation", "mutation.json");
		const bodyLines = [
			...stripAnsi(header("Mutation Gate")).split("\n"),
			stripAnsi(kvLine("Report", reportPath)),
			stripAnsi(kvLine("Min score", "60%")),
			stripAnsi(kvLine("Files checked", "2")),
			stripAnsi(kvLine("New / Improved / Below floor / Decreased", "1 / 0 / 2 / 1")),
			"",
			stripAnsi(c.red("  1 regression(s):")),
			stripAnsi(`    ${c.red("✗")} src/foo.ts ${c.dim("90.0% → 40.0%")}`),
			stripAnsi(c.yellow("  2 below floor:")),
			stripAnsi(`    ${c.yellow("!")} src/foo.ts ${c.dim("40.0%")}`),
			stripAnsi(`    ${c.yellow("!")} src/bar.ts ${c.dim("20.0%")}`),
			"",
			stripAnsi(c.dim("  Add tests that kill surviving mutants, or --update-baseline to accept.")),
		];
		expect(stripAnsi(io.mocks().stdout)).toBe(`${bodyLines.join("\n")}\n`);
	});
});

describe("mutationBaselineCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-base-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("prints an empty baseline hint when no file exists", () => {
		mutationBaselineCommand({ cwd: tmp });
		expect(io.mocks().stdout).toContain("no baseline yet");
	});

	it("emits JSON payload when --json is set", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22",
				files: { "src/foo.ts": { score: 0.9, killed: 27 } },
			}),
		);
		mutationBaselineCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.files["src/foo.ts"].score).toBe(0.9);
	});

	it("renders per-file rows sorted ascending by score in normal mode", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-05-01",
				files: {
					"src/high.ts": { score: 0.95, killed: 19 },
					"src/low.ts": { score: 0.4, killed: 4 },
				},
			}),
		);
		mutationBaselineCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(out).toContain("Mutation Baseline");
		expect(out).toContain("Updated");
		expect(out).toContain("Files");
		// Both files rendered with formatted score + kill count.
		expect(out).toContain("src/high.ts");
		expect(out).toContain("score=95.0% killed=19");
		expect(out).toContain("src/low.ts");
		expect(out).toContain("score=40.0% killed=4");
		// Ascending by score: low.ts (40%) must appear before high.ts (95%).
		expect(out.indexOf("src/low.ts")).toBeLessThan(out.indexOf("src/high.ts"));
		// No overflow line when there are <= 25 files.
		expect(out).not.toContain("more");
	});

	it("mutationBaselineCommand defaults cwd to process.cwd() when no --cwd is passed", () => {
		// Drive the `opts.cwd || process.cwd()` fallback for the baseline command.
		// Spy rather than process.chdir() — see the sibling test above: chdir
		// throws under Stryker's worker-thread pool and broke the mutation dry run.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
		try {
			mutationBaselineCommand({});
		} finally {
			spy.mockRestore();
		}
		// Empty working dir → no baseline file → the empty-baseline hint.
		expect(io.mocks().stdout).toContain("no baseline yet");
	});

	it("truncates to 25 rows and prints an overflow line for larger baselines", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const files: Record<string, { score: number; killed: number }> = {};
		for (let i = 0; i < 30; i++) {
			// Distinct ascending scores so ordering and truncation are deterministic.
			files[`src/file-${String(i).padStart(2, "0")}.ts`] = {
				score: i / 100,
				killed: i,
			};
		}
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({ version: 1, updated_at: "2026-05-02", files }),
		);
		mutationBaselineCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		// 30 files, capped at 25 rows → 5 hidden.
		expect(out).toContain("Files");
		expect(out).toContain("… and 5 more");
		// Lowest-scoring file is shown; a file beyond the 25-row window is not.
		expect(out).toContain("src/file-00.ts");
		expect(out).not.toContain("src/file-29.ts");
	});

	it("renders the exact empty-baseline structure, line for line", () => {
		mutationBaselineCommand({ cwd: tmp });
		const bodyLines = [
			...stripAnsi(header("Mutation Baseline")).split("\n"),
			stripAnsi(kvLine("Updated", new Date(0).toISOString())),
			stripAnsi(kvLine("Files", "0")),
			"",
			stripAnsi(c.dim("  (no baseline yet — run `interlinked mutation check --update-baseline`)")),
		];
		expect(stripAnsi(io.mocks().stdout)).toBe(`${bodyLines.join("\n")}\n`);
	});

	it("renders the exact single-file structure, line for line", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-05-01",
				files: { "src/only.ts": { score: 0.5, killed: 5 } },
			}),
		);
		mutationBaselineCommand({ cwd: tmp });
		const bodyLines = [
			...stripAnsi(header("Mutation Baseline")).split("\n"),
			stripAnsi(kvLine("Updated", "2026-05-01")),
			stripAnsi(kvLine("Files", "1")),
			"",
			stripAnsi(`  src/only.ts ${c.dim("score=50.0% killed=5")}`),
		];
		expect(stripAnsi(io.mocks().stdout)).toBe(`${bodyLines.join("\n")}\n`);
	});
});

describe("mutationAcceptCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	// The audited equivalent-mutant path: the per-edit gate's block message has
	// always promised "or annotating an equivalent mutant"; this is that verb.
	// Operates on the LIVE gate's manifest (mutation-manifest.json), not the
	// report ratchet's mutation-baseline.json.
	const FILE = "src/harness/mutation/harvest.ts";

	function writeLiveManifest(cwd: string): void {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const manifest = {
			version: 1,
			generation: 3,
			authoritativeAt: "2026-07-29T00:00:00Z",
			engine: "stryker",
			engineVersion: "9",
			dependencyGraphVersion: "g1",
			environmentHash: "e1",
			files: {
				[FILE]: {
					sym1: {
						symbolId: "sym1",
						qualifiedName: "claimPending",
						symbolHash: "h1",
						mutants: {
							m1: {
								mutantId: "m1",
								siteId: "s1",
								mutator: "ObjectLiteral",
								originalLexeme: '{kind:"not_ready"}',
								replacement: "{}",
								ordinalWithinSymbol: 0,
								status: "survived",
								firstSeen: "2026-07-28T00:00:00Z",
							},
						},
						instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
					},
				},
			},
		};
		writeFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), JSON.stringify(manifest));
	}

	function readMutant(cwd: string): { status: string; accepted_reason?: string } | undefined {
		// SAFETY: reads back the fixture this describe block wrote.
		const saved = JSON.parse(
			readFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), "utf-8"),
		) as {
			files: Record<
				string,
				Record<string, { mutants: Record<string, { status: string; accepted_reason?: string }> }>
			>;
		};
		return saved.files[FILE]?.sym1?.mutants.m1;
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-accept-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	// CHANGED 2026-07-31 (plan 16 §7, typed dispositions). These two cases used to
	// assert that `--reason <prose>` flipped the survivor to "equivalent" and
	// exited 0. That behavior is gone deliberately, not incidentally: a mutant now
	// reaches status "equivalent" only through a `proved_equivalent` disposition
	// whose method carries its own mechanism and whose certificate binds to the
	// mutant's current symbol hash. Prose has no mechanism and no invalidation
	// inputs, and a certificate this command minted for itself would prove
	// nothing — so the prose path is a refusal now. The old assertions encoded the
	// behavior this unit exists to remove; they are rewritten, not deleted.
	it("P1: refuses the prose path and leaves the manifest byte-identical", async () => {
		writeLiveManifest(tmp);
		const before = readFileSync(join(tmp, ".interlinked", "mutation-manifest.json"), "utf-8");
		await mutationAcceptCommand({
			file: FILE,
			id: "m1",
			reason: "poll loop only branches on ready/gone; the default arm is unobservable",
			cwd: tmp,
		});
		expect(readMutant(tmp)?.status).toBe("survived");
		expect(readMutant(tmp)?.accepted_reason).toBeUndefined();
		expect(readFileSync(join(tmp, ".interlinked", "mutation-manifest.json"), "utf-8")).toBe(before);
	});

	it("P2: says why — a reason is not a mechanism — and exits non-zero", async () => {
		writeLiveManifest(tmp);
		await mutationAcceptCommand({ file: FILE, id: "m1", reason: "unobservable arm", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("not a mechanism");
	});

	it("N1: an unknown mutant id changes nothing and exits non-zero", async () => {
		writeLiveManifest(tmp);
		const before = readFileSync(join(tmp, ".interlinked", "mutation-manifest.json"), "utf-8");
		await mutationAcceptCommand({ file: FILE, id: "nope", reason: "some reason", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(readFileSync(join(tmp, ".interlinked", "mutation-manifest.json"), "utf-8")).toBe(before);
	});

	it("N2: a blank reason is refused — an unauditable floor entry is how ratchets rot", async () => {
		writeLiveManifest(tmp);
		await mutationAcceptCommand({ file: FILE, id: "m1", reason: "   ", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("reason");
		expect(readMutant(tmp)?.status).toBe("survived");
	});

	it("N3: a missing manifest is a clear error, not a crash", async () => {
		await mutationAcceptCommand({ file: FILE, id: "m1", reason: "r", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("manifest");
	});

	it("N4: opts with no --cwd/--file/--id/--reason at all falls back to defaults and refuses", async () => {
		// Every option is `?? "" ` / `|| process.cwd()` defaulted when the caller
		// (e.g. a malformed invocation) omits it entirely — distinct from N2's
		// "reason is present but blank". Drive that with a cwd spy (not chdir,
		// which throws under Stryker's worker-thread pool — see the sibling
		// tests) and an opts object with nothing set at all.
		const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
		try {
			await mutationAcceptCommand({});
		} finally {
			spy.mockRestore();
		}
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T1: a whitespace-only --file is treated as blank (guard fires before any manifest load)", async () => {
		// No manifest written — if the guard were skipped, the failure would be
		// "No live mutation manifest…", not "Usage:".
		await mutationAcceptCommand({ file: "   ", id: "m1", reason: "valid reason text", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T2: an omitted --file is treated as blank the same way", async () => {
		await mutationAcceptCommand({ id: "m1", reason: "valid reason text", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T3: a whitespace-only --id is treated as blank", async () => {
		await mutationAcceptCommand({ file: FILE, id: "   ", reason: "valid reason text", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T4: an omitted --id is treated as blank the same way", async () => {
		await mutationAcceptCommand({ file: FILE, reason: "valid reason text", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T5: an omitted --reason is treated as blank the same way", async () => {
		await mutationAcceptCommand({ file: FILE, id: "m1", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
	});

	it("T6: a whitespace-only --reason fires the USAGE guard, not the mechanism refusal", async () => {
		// Distinct from N2: N2 only proves exitCode 1 + the word "reason" appears,
		// which is also true of the "not a mechanism" refusal message. This test
		// pins WHICH message fires.
		writeLiveManifest(tmp);
		await mutationAcceptCommand({ file: FILE, id: "m1", reason: "   ", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Usage: interlinked mutation accept");
		expect(io.mocks().stderr).not.toContain("not a mechanism");
	});

	it("T7: an unknown mutant id names both the id and the file in the error", async () => {
		writeLiveManifest(tmp);
		await mutationAcceptCommand({ file: FILE, id: "totally-unknown", reason: "some reason", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain(
			`Mutant "totally-unknown" not found under "${FILE}" in the manifest. List the file's survivors before accepting.`,
		);
	});

	it("T8: a missing manifest names the exact expected path", async () => {
		await mutationAcceptCommand({ file: FILE, id: "m1", reason: "some reason", cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain(
			`No live mutation manifest at ${join(tmp, ".interlinked", "mutation-manifest.json")} — the per-edit gate creates it on the first measured run.`,
		);
	});
});

describe("mutationMeasureCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	const FILE = "src/foo.ts";
	const SRC = "export function f(x: number): boolean {\n\treturn x > 0;\n}\n";
	const manifestPath = (cwd: string) => join(cwd, ".interlinked", "mutation-manifest.json");

	/** A Stryker-shaped whole-file report for SRC, one mutant at the `>`. */
	function strykerBody(status: string): unknown {
		const col = (SRC.split("\n")[1] ?? "").indexOf(">") + 1;
		return {
			engine: { exitCode: 0 },
			testRun: { overlayGreen: true, redWitnessSatisfied: null, executedTestCount: 1 },
			testFiles: { "src/foo.test.ts": { tests: [{ id: "test-1", name: "f" }] } },
			files: {
				[FILE]: {
					source: SRC,
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

	function manifestFileRecord(cwd: string): { mutants: Record<string, { status: string }> }[] | undefined {
		const raw = JSON.parse(readFileSync(manifestPath(cwd), "utf-8")) as {
			files: Record<string, Record<string, { mutants: Record<string, { status: string }> }>>;
		};
		const symbols = raw.files[FILE];
		return symbols ? Object.values(symbols) : undefined;
	}

	function manifestExists(cwd: string): boolean {
		try {
			readFileSync(manifestPath(cwd), "utf-8");
			return true;
		} catch {
			return false;
		}
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-measure-"));
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, FILE), SRC);
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		vi.unstubAllGlobals();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("N1: errors when the target file cannot be read, and touches nothing", async () => {
		await mutationMeasureCommand("src/does-not-exist.ts", { cwd: tmp, runnerUrl: "http://runner/" });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Cannot read");
		expect(manifestExists(tmp)).toBe(false);
	});

	it("N2: errors when no runner is configured (no --runner-url, no local rules)", async () => {
		await mutationMeasureCommand(FILE, { cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation runner configured");
	});

	// `--skip-preflight` behavior pin. The green-suite pre-flight refuses to
	// spend a multi-minute engine run against a RED suite, because a failing
	// suite makes the engine report every mutant it touches as killed. When it
	// cannot reach a verdict it says so on stderr rather than staying silent —
	// "skipped" is UNKNOWN, not green — and that line is the observable that
	// tells the two paths apart here.
	it("runs the pre-flight by default and reports an unverified suite on stderr", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Killed") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/" });
		expect(io.mocks().stderr).toContain("pre-flight skipped");
		expect(io.mocks().stderr).toContain("suite health is unverified");
	});

	it("--skip-preflight suppresses the pre-flight entirely, and still measures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Killed") })),
		);
		await mutationMeasureCommand(FILE, {
			cwd: tmp,
			runnerUrl: "http://runner/",
			skipPreflight: true,
			json: true,
		});
		// No pre-flight ran, so it has nothing to report either way.
		expect(io.mocks().stderr).not.toContain("pre-flight");
		// …and the measurement itself still happened — the flag skips the
		// pre-flight, not the run.
		expect(JSON.parse(io.mocks().stdout).status).toBe("measured");
	});

	it("P1: measures without recording by default — the manifest is untouched", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", json: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.status).toBe("measured");
		expect(parsed.mutants).toBe(1);
		expect(parsed.survivors).toBe(1);
		expect(parsed.record).toBeNull();
		expect(manifestExists(tmp)).toBe(false);
	});

	it("P2: --record folds a clean run into mutation-manifest.json with a real before/after delta", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", record: true, json: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.record.recorded).toBe(true);
		expect(parsed.record.before).toEqual({ mutants: 0, survivors: 0 });
		expect(parsed.record.after).toEqual({ mutants: 1, survivors: 1 });

		// The manifest ON DISK actually reflects the survivor — not just the
		// command's own report of what it did.
		const symbols = manifestFileRecord(tmp);
		expect(symbols).toBeDefined();
		const statuses = Object.values(symbols?.[0]?.mutants ?? {}).map((m) => m.status);
		expect(statuses).toEqual(["survived"]);
	});

	it("N3: --record on a not_measurable response writes NOTHING, even though --record was requested", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ not_measurable: { reason: "no_tests" } }),
			})),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", record: true, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.status).toBe("not_measurable");
		expect(parsed.record.recorded).toBe(false);
		expect(parsed.record.reason).toContain("not_measurable");
		expect(manifestExists(tmp)).toBe(false);
	});

	it("reads the runner endpoint from .interlinked/guard-rules.local.json when --runner-url is omitted", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ per_edit_mutation: { runner_url: "http://configured-runner/" } }),
		);
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Killed") }));
		vi.stubGlobal("fetch", fetchMock);
		await mutationMeasureCommand(FILE, { cwd: tmp, json: true });
		expect(io.mocks().exitCode).toBeFalsy();
		expect(fetchMock).toHaveBeenCalledWith("http://configured-runner/", expect.anything());
	});

	it("renders human-readable survivor lines and the recorded delta in normal mode", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", record: true });
		const out = io.mocks().stdout;
		expect(out).toContain("Mutation Measure");
		expect(out).toContain("Survivors");
		expect(out).toContain("L2");
		expect(out).toContain("EqualityOperator");
		expect(out).toContain("Recorded");
		expect(out).toContain("0/0");
		expect(out).toContain("1/1");
	});

	it("N4: exits non-zero when the runner answers with an HTTP error, and writes nothing", async () => {
		// A non-503 HTTP error is reported immediately (no retry/backoff), so this
		// stays a fast, deterministic unit test rather than exercising the real
		// jittered-retry timer (which the command does not expose a fake clock for).
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://down/", json: true });
		expect(io.mocks().exitCode).toBe(1);
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.status).toBe("error");
		expect(parsed.reason).toContain("HTTP 500");
		expect(manifestExists(tmp)).toBe(false);
	});

	it("T9: prints the measuring diagnostic with overlay/runner counts and no stray warnings", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/" });
		const err = io.mocks().stderr;
		expect(err).toContain("measuring src/foo.ts (1 overlay(s)) via 1 runner(s)…");
		// No fallback placeholder text leaked into the diagnostic, and no
		// unreadable-overlay warning fired when nothing was actually unreadable.
		expect(err).not.toContain("Stryker was here");
		expect(err).not.toContain("WARNING");
	});

	it("T9b: runs the green-suite pre-flight by default, reporting a skipped probe as unverified", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/" });
		// A skipped probe is UNKNOWN, not green — saying nothing would let a
		// reader infer the suite was checked and passed.
		expect(io.mocks().stderr).toContain("pre-flight skipped");
		expect(io.mocks().stderr).toContain("suite health is unverified");
	});

	it("T9c: --skip-preflight bypasses the pre-flight probe entirely", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", skipPreflight: true });
		// The probe never ran, so it emits neither its skipped note nor a red
		// verdict — and the measurement itself still proceeds.
		expect(io.mocks().stderr).not.toContain("pre-flight");
		expect(io.mocks().exitCode).not.toBe(1);
	});

	it("T10: suppresses the measuring diagnostic entirely in --json mode", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", json: true });
		expect(io.mocks().stderr).not.toContain("measuring");
	});

	it("T11: forwards a configured runner token as a Bearer Authorization header", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ per_edit_mutation: { runner_url: "http://configured-runner/", token: "secret-tok" } }),
		);
		const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
			ok: true,
			status: 200,
			json: async () => strykerBody("Killed"),
		}));
		vi.stubGlobal("fetch", fetchMock);
		await mutationMeasureCommand(FILE, { cwd: tmp, json: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const init = fetchMock.mock.calls[0]?.[1];
		expect(init?.headers?.authorization).toBe("Bearer secret-tok");
	});

	it("T12: --budget-ms 0 reports a busy verdict citing the configured 0s deadline", async () => {
		// deadlineMs=0 means the retry loop's `now() < deadline` is false before
		// the first attempt — the runner is never even called, and the busy
		// reason names the deadline actually used (0s), not the 900s default.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/", budgetMs: "0", json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.status).toBe("busy");
		expect(parsed.reason).toContain("after 0s");
		expect(io.mocks().exitCode).toBe(1);
	});

	it("T14: warns and names the dropped files when the overlay closure was capped", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		const spy = vi.spyOn(measureModule, "buildScopedMeasureOverlays").mockReturnValue({
			overlays: [{ path: FILE, content: SRC }],
			unreadable: [],
			capped: { limit: 1400, candidateCount: 1450, dropped: ["src/dropped-a.ts", "src/dropped-b.ts"] },
		});
		try {
			await mutationMeasureCommand(FILE, { cwd: tmp, runnerUrl: "http://runner/" });
		} finally {
			spy.mockRestore();
		}
		const err = io.mocks().stderr;
		expect(err).toContain(
			"WARNING: overlay closure had 1450 candidates, capped to 1400; dropped 2 dependency file(s): src/dropped-a.ts, src/dropped-b.ts",
		);
	});

	it("T13: a non-numeric --budget-ms falls back to the default deadline instead of NaN", async () => {
		// A NaN deadline would make `now() + NaN` = NaN and `now() < NaN` always
		// false, so the runner would report "busy" without ever calling fetch.
		// Falling back to the default deadline means the mocked fetch succeeds.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => strykerBody("Survived") })),
		);
		await mutationMeasureCommand(FILE, {
			cwd: tmp,
			runnerUrl: "http://runner/",
			budgetMs: "not-a-number",
			json: true,
		});
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.status).toBe("measured");
	});
});
