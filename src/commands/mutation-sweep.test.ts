import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearManifestCache } from "../harness/mutation/manifest.js";
import { tryAcquireProjectHeavyProcessLease } from "../harness/project-heavy-process-lock.js";
import type { MeasureOneResult } from "./mutation-measure-support.js";
import {
	eligibleMutationFiles,
	laneEndpoints,
	measuredBefore,
	mergeEligibleTargets,
	mutationSweepCommand,
	renderSweepLine,
	renderSweepSummary,
	runPool,
	selectSweepTargets,
	summarizeSweep,
	unqualifiedOnly,
} from "./mutation-sweep.js";

function target(file: string, open: number) {
	return { file, open, uncovered: 0, qualified: false };
}

function result(file: string, over: Partial<MeasureOneResult> = {}): MeasureOneResult {
	return {
		file,
		status: "measured",
		mutants: 10,
		survivors: 2,
		survivorList: [],
		record: { recorded: true, before: { mutants: 10, survivors: 5 }, after: { mutants: 10, survivors: 2 } },
		notes: [],
		...over,
	};
}

describe("selectSweepTargets", () => {
	const rows = [target("a.ts", 9), target("b.ts", 7), target("c.ts", 5), target("d.ts", 3), target("e.ts", 1)];

	it("P1: keeps the ranked order it was given", () => {
		expect(selectSweepTargets(rows, {}).map((t) => t.file)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
	});

	it("P2: --limit truncates from the worst end, where the work is", () => {
		expect(selectSweepTargets(rows, { limit: 2 }).map((t) => t.file)).toEqual(["a.ts", "b.ts"]);
	});

	it("P3: a shard takes every n-th file, so two machines split the heavy ones", () => {
		expect(selectSweepTargets(rows, { shard: { index: 0, count: 2 } }).map((t) => t.file)).toEqual([
			"a.ts",
			"c.ts",
			"e.ts",
		]);
	});

	it("P4: shard applies BEFORE limit, so --limit means 'this machine measures N'", () => {
		const picked = selectSweepTargets(rows, { shard: { index: 1, count: 2 }, limit: 1 });
		expect(picked.map((t) => t.file)).toEqual(["b.ts"]);
	});

	it("N1: an empty work-list selects nothing rather than throwing", () => {
		expect(selectSweepTargets([], { limit: 5 })).toEqual([]);
	});

	it("N2: a limit at or above the list length is the identity", () => {
		expect(selectSweepTargets(rows, { limit: 99 })).toHaveLength(5);
	});

	it("mutant-kill: no measuredBeforeMs means no cutoff filtering at all, even for a file with real provenance", () => {
		const withProvenance = [{ file: "a.ts", open: 5, uncovered: 0, qualified: true, measuredAt: "2026-08-01T00:00:00.000Z" }];
		expect(selectSweepTargets(withProvenance, {}).map((r) => r.file)).toEqual(["a.ts"]);
	});

	it("mutant-kill: a limit of exactly 0 is treated as 'no limit', not an empty slice", () => {
		expect(selectSweepTargets(rows, { limit: 0 })).toHaveLength(5);
	});
});

describe("measuredBefore — restart one fixed census", () => {
	const cutoffMs = Date.parse("2026-08-13T12:00:00.000Z");
	const rows = [
		{ ...target("old.ts", 9), qualified: true, measuredAt: "2026-08-13T11:59:59.999Z" },
		{ ...target("exact.ts", 8), qualified: true, measuredAt: "2026-08-13T12:00:00.000Z" },
		{ ...target("new.ts", 7), qualified: true, measuredAt: "2026-08-13T12:00:00.001Z" },
		{ ...target("missing.ts", 0), measuredAt: null },
		{ ...target("legacy.ts", 0), measuredAt: "not-a-date" },
	];

	it("P1: keeps old, absent, and unreadable provenance", () => {
		expect(measuredBefore(rows, cutoffMs).map((row) => row.file)).toEqual(["old.ts", "missing.ts", "legacy.ts"]);
	});

	it("P2: excludes a measurement exactly at or newer than the cutoff", () => {
		expect(measuredBefore(rows, cutoffMs).map((row) => row.file)).not.toContain("exact.ts");
		expect(measuredBefore(rows, cutoffMs).map((row) => row.file)).not.toContain("new.ts");
	});

	it("P3: cutoff filtering happens before sharding and limiting", () => {
		const selected = selectSweepTargets(rows, { measuredBeforeMs: cutoffMs, shard: { index: 1, count: 2 }, limit: 1 });
		expect(selected.map((row) => row.file)).toEqual(["missing.ts"]);
	});
});

describe("mergeEligibleTargets — source inventory closes manifest blind spots", () => {
	it("P1: includes files absent from the manifest and preserves measured-clean rows", () => {
		const rows = [
			{ ...target("src/debt.ts", 5), qualified: true, measuredAt: "2026-08-01T00:00:00.000Z" },
			{ ...target("src/clean.ts", 0), qualified: true, measuredAt: "2026-08-02T00:00:00.000Z" },
		];
		const merged = mergeEligibleTargets(rows, ["src/missing.ts", "src/clean.ts", "src/debt.ts"]);
		expect(merged.map((row) => row.file)).toEqual(["src/debt.ts", "src/clean.ts", "src/missing.ts"]);
		expect(merged.find((row) => row.file === "src/missing.ts")).toMatchObject({
			open: 0,
			qualified: false,
			measuredAt: null,
		});
	});

	it("N1: manifest-only deleted paths cannot enter the current source domain", () => {
		const merged = mergeEligibleTargets([target("src/deleted.ts", 99)], ["src/current.ts"]);
		expect(merged.map((row) => row.file)).toEqual(["src/current.ts"]);
	});

	it("mutant-kill: sorts by uncovered descending when open is tied", () => {
		const rows = [
			{ ...target("src/low.ts", 3), uncovered: 1 },
			{ ...target("src/high.ts", 3), uncovered: 9 },
			{ ...target("src/mid.ts", 3), uncovered: 5 },
		];
		const merged = mergeEligibleTargets(rows, ["src/low.ts", "src/high.ts", "src/mid.ts"]);
		expect(merged.map((r) => r.file)).toEqual(["src/high.ts", "src/mid.ts", "src/low.ts"]);
	});
});

describe("summarizeSweep", () => {
	it("P1: counts each terminal status separately", () => {
		const s = summarizeSweep([
			result("a.ts"),
			result("b.ts", { status: "busy" }),
			result("c.ts", { status: "error", reason: "boom" }),
			result("d.ts", { status: "not_measurable", reason: "no_tests" }),
			result("e.ts", { status: "partial", reason: "engine exited 2" }),
		]);
		expect(s).toMatchObject({ measured: 1, partial: 1, busy: 1, errors: 1, notMeasurable: 1 });
	});

	it("P2: sums the survivor delta only over files that actually re-measured", () => {
		const s = summarizeSweep([
			result("a.ts"), // 5 -> 2
			result("b.ts", { record: { recorded: true, before: { mutants: 4, survivors: 4 }, after: { mutants: 4, survivors: 1 } } }),
			result("c.ts", { status: "busy", record: null }),
		]);
		expect(s.survivorsBefore).toBe(9);
		expect(s.survivorsAfter).toBe(3);
	});

	it("P3: a file with no record contributes no delta", () => {
		const s = summarizeSweep([result("a.ts", { record: null })]);
		expect(s.survivorsBefore).toBe(0);
		expect(s.survivorsAfter).toBe(0);
	});

	it("N1: an empty sweep summarizes to zeros, not NaN", () => {
		const s = summarizeSweep([]);
		expect(s).toMatchObject({ measured: 0, partial: 0, busy: 0, errors: 0, survivorsBefore: 0, survivorsAfter: 0 });
	});

	it("N2: local refusals are counted as errors, not as measurements", () => {
		const s = summarizeSweep([
			result("a.ts", { status: "unreadable", reason: "gone" }),
			result("b.ts", { status: "no_runner", reason: "none" }),
			result("c.ts", { status: "red_suite", reason: "RED" }),
		]);
		expect(s.measured).toBe(0);
		expect(s.errors).toBe(3);
	});
});

describe("renderSweepLine", () => {
	it("P1: a measured file shows the before → after survivor movement", () => {
		expect(renderSweepLine(result("src/a.ts"))).toContain("5 → 2");
	});

	it("P2: a busy runner is reported as not measured, never as a clean result", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "busy", reason: "all endpoints busy" }));
		expect(line).toMatch(/busy/i);
		expect(line).not.toMatch(/→/);
	});

	it("P3: a failure carries the runner's reason", () => {
		expect(renderSweepLine(result("src/a.ts", { status: "error", reason: "npm install failed" }))).toContain(
			"npm install failed",
		);
	});

	it("N1: a measured file with no record still renders its absolute counts", () => {
		const line = renderSweepLine(result("src/a.ts", { record: null }));
		expect(line).toContain("2");
		expect(line).toContain("src/a.ts");
	});

	it("mutant-kill: measured line carries the checkmark icon", () => {
		expect(renderSweepLine(result("src/a.ts"))).toContain("✓");
	});

	it("mutant-kill: busy line is the exact phrase with its bullet, not the generic status:reason format", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "busy", reason: "503" }));
		expect(line).toContain("·");
		expect(line).toContain("src/a.ts  runner busy — not measured");
	});

	it("mutant-kill: not_measurable line uses the parenthesized-reason format with its bullet, not the generic colon format", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "not_measurable", reason: "no_tests" }));
		expect(line).toContain("·");
		expect(line).toContain("src/a.ts  not measurable (no_tests)");
		expect(line).not.toContain("not_measurable: no_tests");
	});

	it("partial evidence is visible but never rendered with the measured checkmark", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "partial", reason: "missing engine evidence" }));
		expect(line).toContain("partial evidence — not recorded");
		expect(line).not.toContain("✓");
	});

	it("mutant-kill: an unrecognized status uses the generic 'status: reason' format with a cross icon, not the not-measurable format", () => {
		const line = renderSweepLine(result("src/a.ts", { status: "error", reason: "boom" }));
		expect(line).toContain("✗");
		expect(line).toContain("error: boom");
		expect(line).not.toContain("not measurable");
	});
});

describe("renderSweepSummary", () => {
	it("P1: states the net survivor movement across the sweep", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts")]), { shard: { index: 0, count: 2 } });
		expect(text).toContain("5 → 2");
		expect(text).toContain("1/2");
	});

	it("N1: a sweep that measured nothing says so instead of claiming success", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts", { status: "busy" })]), {});
		expect(text).toMatch(/0 measured|nothing measured/i);
	});

	it("mutant-kill: shard suffix uses index+1, not index-1 (1-based display)", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts")]), { shard: { index: 2, count: 5 } });
		expect(text).toContain("(shard 3/5)");
	});

	it("mutant-kill: with no shard, the summary carries no stray shard suffix or placeholder text, and starts with a blank line", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts")]), {});
		expect(text).not.toContain("Stryker");
		expect(text.split("\n")[0]).toBe("");
	});

	it("mutant-kill: the per-status counts line reports each status label with its own count", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts"), result("b.ts", { status: "busy" })]), {});
		expect(text).toContain("1 measured · 0 partial · 1 busy · 0 not measurable · 0 failed");
	});

	it("mutant-kill: zero measured files says the exact phrase, newline-joined, not a survivor-delta line", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts", { status: "busy" })]), {});
		expect(text).toContain("nothing in this sweep reached the manifest");
		expect(text).not.toContain("survivors 0");
		expect(text.split("\n").length).toBeGreaterThan(1);
	});

	it("mutant-kill: the delta suffix is before-minus-after with a '-' sign on improvement, newline-joined", () => {
		const text = renderSweepSummary(summarizeSweep([result("a.ts")]), {}); // before=5, after=2
		expect(text).toContain("(-3)");
		expect(text.split("\n").length).toBeGreaterThan(1);
	});

	it("mutant-kill: delta sign flips to '+' when survivors increased", () => {
		const worse = result("a.ts", {
			record: { recorded: true, before: { mutants: 10, survivors: 2 }, after: { mutants: 10, survivors: 5 } },
		});
		const text = renderSweepSummary(summarizeSweep([worse]), {});
		expect(text).toContain("(+3)");
	});

	it("mutant-kill: a zero delta still gets the '-' sign (the >=0 boundary), not '+'", () => {
		const unchanged = result("a.ts", {
			record: { recorded: true, before: { mutants: 10, survivors: 4 }, after: { mutants: 10, survivors: 4 } },
		});
		const text = renderSweepSummary(summarizeSweep([unchanged]), {});
		expect(text).toContain("(-0)");
	});
});


describe("unqualifiedOnly — what makes a long sweep restartable", () => {
	const rows = [
		{ file: "done.ts", open: 92, uncovered: 0, qualified: true },
		{ file: "todo.ts", open: 5, uncovered: 0, qualified: false },
	];

	it("P1: drops files already measured under the current regime", () => {
		expect(unqualifiedOnly(rows).map((t) => t.file)).toEqual(["todo.ts"]);
	});

	it("P2: a qualified file is skipped even though it still has survivors — real debt survives re-measurement", () => {
		expect(unqualifiedOnly(rows).some((t) => t.file === "done.ts")).toBe(false);
	});

	it("P3: selectSweepTargets applies it before sharding, so both boxes skip the same finished work", () => {
		const picked = selectSweepTargets(rows, { unqualifiedOnly: true, shard: { index: 0, count: 1 } });
		expect(picked.map((t) => t.file)).toEqual(["todo.ts"]);
	});

	it("N1: without the flag every file stays in the list", () => {
		expect(selectSweepTargets(rows, {}).map((t) => t.file)).toEqual(["done.ts", "todo.ts"]);
	});

	it("N2: an all-qualified list selects nothing rather than falling back to everything", () => {
		expect(selectSweepTargets([rows[0]!], { unqualifiedOnly: true })).toEqual([]);
	});
});


describe("runPool — N workers pulling one queue", () => {
	it("P1: runs items concurrently up to the lane count", async () => {
		let inFlight = 0;
		let peak = 0;
		await runPool([1, 2, 3, 4, 5, 6], 3, async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
		});
		expect(peak).toBe(3);
	});

	it("P2: keeps results in INPUT order even when they finish out of order", async () => {
		const out = await runPool([30, 1, 20, 2], 4, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 1, 20, 2]);
	});

	it("P3: a slow lane does not hold back the queue — a fast worker takes more items", async () => {
		const byLane = [0, 0];
		await runPool(Array.from({ length: 10 }, (_, i) => i), 2, async (_item, lane) => {
			byLane[lane] = (byLane[lane] ?? 0) + 1;
			await new Promise((r) => setTimeout(r, lane === 0 ? 1 : 20));
		});
		// The fast lane must have claimed strictly more work than the slow one;
		// a static split would have given them five each.
		expect(byLane[0]!).toBeGreaterThan(byLane[1]!);
	});

	it("P4: every item runs exactly once", async () => {
		const seen: number[] = [];
		await runPool([1, 2, 3, 4, 5], 3, async (n) => {
			seen.push(n);
		});
		// Numeric comparator: the default sort is lexicographic, so a queue of ten
		// or more items would compare [10, 9] as [10, 9] and pass or fail by luck.
		expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	it("N1: more lanes than items does not spawn idle workers or throw", async () => {
		const out = await runPool([7], 8, async (n) => n * 2);
		expect(out).toEqual([14]);
	});

	it("N2: an empty queue completes immediately with an empty result", async () => {
		expect(await runPool([], 4, async () => 1)).toEqual([]);
	});

	it("N3: one lane is plain sequential execution", async () => {
		const order: number[] = [];
		await runPool([1, 2, 3], 1, async (n) => {
			order.push(n);
			await new Promise((r) => setTimeout(r, 1));
		});
		expect(order).toEqual([1, 2, 3]);
	});
});


describe("laneEndpoints — surviving a runner that disconnects", () => {
	const three = ["http://a", "http://b", "http://c"];

	it("P1: each lane prefers its own runner, so two lanes never open on the same one", () => {
		expect(laneEndpoints(three, 0)[0]).toBe("http://a");
		expect(laneEndpoints(three, 1)[0]).toBe("http://b");
		expect(laneEndpoints(three, 2)[0]).toBe("http://c");
	});

	it("P2: every lane still carries every runner as a fallback", () => {
		for (let lane = 0; lane < three.length; lane++) {
			expect([...laneEndpoints(three, lane)].sort()).toEqual([...three].sort());
		}
	});

	it("P3: the fallback order rotates, so a dead first choice does not send every lane to the same second choice", () => {
		expect(laneEndpoints(three, 0)[1]).toBe("http://b");
		expect(laneEndpoints(three, 1)[1]).toBe("http://c");
		expect(laneEndpoints(three, 2)[1]).toBe("http://a");
	});

	it("N1: a single runner has no fallback to add", () => {
		expect(laneEndpoints(["http://only"], 0)).toEqual(["http://only"]);
	});

	it("N2: an empty endpoint list stays empty rather than throwing", () => {
		expect(laneEndpoints([], 0)).toEqual([]);
	});
});

describe("eligibleMutationFiles — extension matching", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "eligible-files-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("mutant-kill: requires the extension at the END of the filename, not merely present anywhere in it", () => {
		writeFileSync(join(cwd, "src", "keep.ts.bak"), "not real source\n");
		expect(eligibleMutationFiles(cwd)).not.toContain("src/keep.ts.bak");
	});

	it("N: a genuine .ts file at the end of the name is still eligible", () => {
		writeFileSync(join(cwd, "src", "real.ts"), "export const x = 1;\n");
		expect(eligibleMutationFiles(cwd)).toContain("src/real.ts");
	});
});

// ===========================================
// mutationSweepCommand — the CLI dispatch: manifest load, endpoint/selection
// resolution, dry-run, and the pooled sweep itself. `measureOneFile` is
// injected so these tests never touch the network or a real runner.
// ===========================================
describe("mutationSweepCommand", () => {
	let cwd: string;
	let logs: string[];
	let errs: string[];

	function survivedManifest(files: Record<string, { mutantId: string }[]>) {
		const out: Record<string, unknown> = {};
		for (const [file, mutants] of Object.entries(files)) {
			out[file] = {
				s1: {
					symbolId: "s1",
					qualifiedName: "fn",
					symbolHash: "h",
					instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
					mutants: Object.fromEntries(
						mutants.map((m) => [
							m.mutantId,
							{
								mutantId: m.mutantId,
								siteId: `site-${m.mutantId}`,
								mutator: "BooleanLiteral",
								originalLexeme: "true",
								replacement: "false",
								ordinalWithinSymbol: 0,
								status: "survived",
								firstSeen: "2026-08-01T00:00:00.000Z",
							},
						]),
					),
				},
			};
		}
		return {
			version: 1,
			generation: 1,
			authoritativeAt: "2026-08-09T00:00:00.000Z",
			engine: "stryker",
			engineVersion: "8",
			dependencyGraphVersion: "1",
			environmentHash: "env",
			files: out,
		};
	}

	function writeManifest(manifest: unknown) {
		writeFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), JSON.stringify(manifest));
		clearManifestCache();
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-sweep-cmd-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "here.ts"), "export const x = 1;\n");
		writeFileSync(join(cwd, "src", "there.ts"), "export const y = 2;\n");
		logs = [];
		errs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			errs.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	function reported(): { summary: ReturnType<typeof summarizeSweep>; results: MeasureOneResult[] } {
		return JSON.parse(logs.join("\n"));
	}

	it("P1: a missing manifest is an error exit, not a silent empty sweep", async () => {
		await mutationSweepCommand({ cwd, json: true, runnerUrl: ["http://runner.invalid"] });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/no mutation manifest/i);
	});

	it("P2: an invalid --shard is refused before the manifest is even read", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, json: true, shard: "9/2", runnerUrl: ["http://runner.invalid"] });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--shard must be/);
	});

	it("N5: a corrupt manifest (parses but fails the schema) says so on stderr, distinct from a missing one", async () => {
		// Missing the required `files` object — `loadManifestState` reads this as
		// "corrupt", not "missing", so `loadTargets` must say CORRUPT rather than
		// silently falling into the same "no manifest" message P1 covers.
		writeFileSync(join(cwd, ".interlinked", "mutation-manifest.json"), JSON.stringify({ version: 1 }));
		clearManifestCache();
		await mutationSweepCommand({ cwd, json: true, runnerUrl: ["http://runner.invalid"] });
		expect(process.exitCode).toBe(1);
		expect(errs.join("\n")).toContain("is CORRUPT (manifest JSON parsed but does not match the manifest schema)");
	});

	it("P3: --dry-run selects targets and reports them without invoking measureOne", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
		);
		let called = false;
		await mutationSweepCommand({ cwd, json: true, dryRun: true }, async (): Promise<MeasureOneResult> => {
			called = true;
			return { file: "unused", status: "measured", mutants: 0, survivors: 0, survivorList: [], record: null, notes: [] };
		});
		expect(called).toBe(false);
		const payload = reported() as unknown as { dryRun: boolean; selected: unknown[]; total: number };
		expect(payload.dryRun).toBe(true);
		expect(payload.selected).toHaveLength(2);
		expect(payload.total).toBe(2);
	});

	it("P4: no configured runner (and none passed) is a clear error, not a silent 0-file sweep", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, json: true });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/no mutation runner configured/i);
	});

	it("P5: an explicit --runner-url is used and reaches measureOneFile's runnerUrls", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const seenUrls: string[][] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid", "http://b.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				seenUrls.push(args.runnerUrls ?? []);
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
					notes: [],
				};
			},
		);
		expect(seenUrls[0]).toEqual(["http://a.invalid", "http://b.invalid"]);
		expect(process.exitCode).toBe(0);
	});

	it("defers without measuring when another process owns the project heavyweight lane", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const release = tryAcquireProjectHeavyProcessLease(cwd);
		expect(release).not.toBeNull();
		let called = false;
		try {
			await mutationSweepCommand(
				{ cwd, json: true, runnerUrl: ["http://runner.invalid"] },
				async (): Promise<MeasureOneResult> => {
					called = true;
					return result("src/here.ts");
				},
			);
		} finally {
			release?.();
		}
		expect(called).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/sweep deferred/i);
		expect(logs.join("\n")).toMatch(/no files were measured/i);
	});

	it("P6: passes record:true and surface:'sweep' to every measured file — a sweep that never records changes nothing", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const argsSeen: Array<{ record: boolean | undefined; surface: string | undefined }> = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				argsSeen.push({ record: args.record, surface: args.surface });
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
					notes: [],
				};
			},
		);
		expect(argsSeen).toEqual([{ record: true, surface: "sweep" }]);
	});

	it("P7: excludes stale (deleted) files from the sweep — they cannot be re-measured", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/deleted.ts": [{ mutantId: "m2" }] }),
		);
		const files: string[] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => {
				files.push(args.file);
				return {
					file: args.file,
					status: "measured",
					mutants: 1,
					survivors: 0,
					survivorList: [],
					record: null,
					notes: [],
				};
			},
		);
		expect(files).toEqual(["src/here.ts"]);
	});

	it("P8: a --file filter narrows the sweep to one path", async () => {
		writeFileSync(join(cwd, "src", "alpha.ts"), "export const a = 1;\n");
		writeFileSync(join(cwd, "src", "beta.ts"), "export const b = 2;\n");
		writeManifest(
			survivedManifest({ "src/alpha.ts": [{ mutantId: "m1" }], "src/beta.ts": [{ mutantId: "m2" }] }),
		);
		const files: string[] = [];
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"], file: "alpha.ts" },
			async (args): Promise<MeasureOneResult> => {
				files.push(args.file);
				return { file: args.file, status: "measured", mutants: 1, survivors: 0, survivorList: [], record: null, notes: [] };
			},
		);
		expect(files).toEqual(["src/alpha.ts"]);
	});

	it("P9: --all-eligible includes missing and measured-clean source while excluding tests and declarations", async () => {
		writeFileSync(join(cwd, "src", "types.d.ts"), "export interface Thing {}\n");
		writeFileSync(join(cwd, "src", "ignored.test.ts"), "export const testOnly = true;\n");
		mkdirSync(join(cwd, "src", "__tests__"), { recursive: true });
		writeFileSync(join(cwd, "src", "__tests__", "helper.ts"), "export const helper = true;\n");
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [] }));

		await mutationSweepCommand({ cwd, json: true, allEligible: true, dryRun: true });

		const payload = reported() as unknown as { selected: Array<{ file: string; open: number }>; total: number };
		expect(payload.total).toBe(2);
		expect(payload.selected.map((row) => row.file)).toEqual(["src/here.ts", "src/there.ts"]);
		expect(eligibleMutationFiles(cwd)).toEqual(["src/here.ts", "src/there.ts"]);
	});

	it("P10: --measured-before resumes a full census without redoing files recorded after its cutoff", async () => {
		writeFileSync(join(cwd, "src", "missing.ts"), "export const missing = 3;\n");
		writeManifest({
			...survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
			fileProvenance: {
				"src/here.ts": {
					at: "2026-08-13T11:00:00.000Z",
					scope: "import_graph",
					testCount: 1,
					surface: "sweep",
				},
				"src/there.ts": {
					at: "2026-08-13T13:00:00.000Z",
					scope: "import_graph",
					testCount: 1,
					surface: "sweep",
				},
			},
		});

		await mutationSweepCommand({
			cwd,
			json: true,
			allEligible: true,
			measuredBefore: "2026-08-13T12:00:00.000Z",
			dryRun: true,
		});

		const payload = reported() as unknown as { selected: Array<{ file: string }> };
		expect(payload.selected.map((row) => row.file)).toEqual(["src/here.ts", "src/missing.ts"]);
	});

	it("N1: measurement errors set a nonzero exit code — a CI caller must not read a failed sweep as progress", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "error",
				reason: "boom",
				mutants: 0,
				survivors: 0,
				survivorList: [],
				record: null,
				notes: [],
			}),
		);
		expect(process.exitCode).toBe(1);
	});

	it("N2: a sweep that measures nothing (all busy) also exits nonzero", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, json: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "busy",
				reason: "503",
				mutants: 0,
				survivors: 0,
				survivorList: [],
				record: null,
				notes: [],
			}),
		);
		expect(process.exitCode).toBe(1);
	});

	it("N3: normal (non-json) mode prints a progress line to stderr per file, not just at the end", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "measured",
				mutants: 1,
				survivors: 0,
				survivorList: [],
				record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
				notes: [],
			}),
		);
		expect(errs.some((l) => l.includes("src/here.ts"))).toBe(true);
		expect(errs.some((l) => /sweeping \d+ of \d+/.test(l))).toBe(true);
	});

	it("N3b: --short prints the one-line measured/survivors summary, not the JSON payload", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand(
			{ cwd, short: true, runnerUrl: ["http://a.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "measured",
				mutants: 1,
				survivors: 0,
				survivorList: [],
				record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
				notes: [],
			}),
		);
		// Exact literal, not a substring match — a swapped direction or count would
		// still contain "measured"/"survivors" but produce a different string.
		expect(logs.join("\n")).toBe("1/1 measured, survivors 1 → 0");
	});

	it("N4: an invalid --measured-before value is refused before any runner work", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		let called = false;
		await mutationSweepCommand({ cwd, json: true, measuredBefore: "yesterday" }, async () => {
			called = true;
			return result("src/here.ts");
		});
		expect(called).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--measured-before must be an ISO timestamp/);
	});

	// ---- laneTag: the "[runner i/N · done/total]" stderr suffix ----------

	it("mutant-kill: with a single runner, the progress line is exactly renderSweepLine's output (no lane-tag suffix)", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const measured: MeasureOneResult = {
			file: "src/here.ts",
			status: "measured",
			mutants: 1,
			survivors: 0,
			survivorList: [],
			record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
			notes: [],
		};
		await mutationSweepCommand({ cwd, runnerUrl: ["http://a.invalid"] }, async () => measured);
		expect(errs).toContain(`${renderSweepLine(measured)}\n`);
	});

	it("mutant-kill: with 2 runners, the progress line carries a lane tag in the 'runner i/N · done/total' format", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
		);
		await mutationSweepCommand(
			{ cwd, runnerUrl: ["http://a.invalid", "http://b.invalid"] },
			async (args): Promise<MeasureOneResult> => ({
				file: args.file,
				status: "measured",
				mutants: 1,
				survivors: 0,
				survivorList: [],
				record: { recorded: true, before: { mutants: 1, survivors: 1 }, after: { mutants: 1, survivors: 0 } },
				notes: [],
			}),
		);
		expect(errs.some((l) => /\[runner \d\/2 · \d\/2\]/.test(l))).toBe(true);
	});

	// ---- loadTargets: qualified/open filtering, --all-eligible + --file ----

	it("mutant-kill: qualified reflects whether the file carries real provenance, not a constant", async () => {
		writeFileSync(join(cwd, "src", "unprovenanced.ts"), "export const z = 1;\n");
		writeManifest({
			...survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/unprovenanced.ts": [{ mutantId: "m2" }] }),
			fileProvenance: {
				"src/here.ts": { at: "2026-08-01T00:00:00.000Z", scope: "import_graph", testCount: 1, surface: "sweep" },
			},
		});
		await mutationSweepCommand({ cwd, json: true, allEligible: true, dryRun: true });
		const payload = reported() as unknown as { selected: Array<{ file: string; qualified: boolean }> };
		const here = payload.selected.find((r) => r.file === "src/here.ts");
		const un = payload.selected.find((r) => r.file === "src/unprovenanced.ts");
		expect(here?.qualified).toBe(true);
		expect(un?.qualified).toBe(false);
	});

	it("mutant-kill: a manifest file with zero open survivors is excluded from the default (non-all-eligible) sweep", async () => {
		writeFileSync(join(cwd, "src", "clean.ts"), "export const c = 1;\n");
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/clean.ts": [] }));
		const files: string[] = [];
		await mutationSweepCommand({ cwd, json: true, runnerUrl: ["http://a.invalid"] }, async (args) => {
			files.push(args.file);
			return result(args.file);
		});
		expect(files).toEqual(["src/here.ts"]);
	});

	it("mutant-kill: --all-eligible plus --file together actually narrow the selection (not just --all-eligible alone)", async () => {
		writeFileSync(join(cwd, "src", "alpha.ts"), "export const a = 1;\n");
		writeFileSync(join(cwd, "src", "beta.ts"), "export const b = 1;\n");
		writeManifest(survivedManifest({ "src/alpha.ts": [{ mutantId: "m1" }], "src/beta.ts": [{ mutantId: "m2" }] }));
		await mutationSweepCommand({ cwd, json: true, allEligible: true, dryRun: true, file: "alpha" });
		const payload = reported() as unknown as { selected: Array<{ file: string }> };
		expect(payload.selected.map((r) => r.file)).toEqual(["src/alpha.ts"]);
	});

	// ---- endpoint gate: measureOne must never run when no runner is configured ----

	it("mutant-kill: with no runner configured, measureOne is never invoked (fails before any work starts)", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		let called = false;
		await mutationSweepCommand({ cwd, json: true }, async (): Promise<MeasureOneResult> => {
			called = true;
			return result("src/here.ts");
		});
		expect(called).toBe(false);
		expect(process.exitCode).toBe(1);
	});

	it("mutant-kill: with no --runner-url, a configured runner_url in guard-rules.local.json is actually consulted", async () => {
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ per_edit_mutation: { runner_url: "http://configured.invalid" } }),
		);
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const seenUrls: string[][] = [];
		await mutationSweepCommand({ cwd, json: true }, async (args): Promise<MeasureOneResult> => {
			seenUrls.push(args.runnerUrls ?? []);
			return result(args.file);
		});
		expect(seenUrls[0]).toEqual(["http://configured.invalid"]);
	});

	it("mutant-kill: a trailing-comma runner-url list drops the resulting empty entry", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		const seenUrls: string[][] = [];
		await mutationSweepCommand({ cwd, json: true, runnerUrl: ["http://a.invalid,"] }, async (args) => {
			seenUrls.push(args.runnerUrls ?? []);
			return result(args.file);
		});
		expect(seenUrls[0]).toEqual(["http://a.invalid"]);
	});

	// ---- normal (non-json) mode dry-run rendering ----

	it("mutant-kill: normal (non-json) dry-run prints readable text, not 'undefined' or a thrown error", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, dryRun: true });
		const text = logs.join("\n");
		expect(text).toContain("dry run");
		expect(text).toContain("src/here.ts");
		expect(text).not.toContain("undefined");
	});

	// ---- --measured-before parsing edge cases ----

	it("mutant-kill: --measured-before rejects a valid-but-non-ISO date string like a bare date", async () => {
		writeManifest(survivedManifest({ "src/here.ts": [{ mutantId: "m1" }] }));
		await mutationSweepCommand({ cwd, json: true, measuredBefore: "2026-08-13" }, async () => result("src/here.ts"));
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--measured-before must be an ISO timestamp/);
	});

	// ---- parseSelection: --limit, --shard, --unqualified-only actually apply ----

	it("mutant-kill: --limit narrows the dry-run selection to N files", async () => {
		writeManifest(
			survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
		);
		await mutationSweepCommand({ cwd, json: true, dryRun: true, limit: "1" });
		const payload = reported() as unknown as { selected: unknown[] };
		expect(payload.selected).toHaveLength(1);
	});

	it("mutant-kill: a valid --shard actually narrows the dry-run selection (not silently dropped)", async () => {
		for (const name of ["a", "b", "c", "d"]) writeFileSync(join(cwd, "src", `${name}.ts`), "export const x=1;\n");
		writeManifest(
			survivedManifest({
				"src/a.ts": [{ mutantId: "m1" }],
				"src/b.ts": [{ mutantId: "m2" }],
				"src/c.ts": [{ mutantId: "m3" }],
				"src/d.ts": [{ mutantId: "m4" }],
			}),
		);
		await mutationSweepCommand({ cwd, json: true, dryRun: true, shard: "1/2" });
		const payload = reported() as unknown as { selected: unknown[] };
		expect(payload.selected.length).toBeLessThan(4);
	});

	it("mutant-kill: opts.unqualifiedOnly actually narrows the dry-run selection to unqualified files", async () => {
		writeManifest({
			...survivedManifest({ "src/here.ts": [{ mutantId: "m1" }], "src/there.ts": [{ mutantId: "m2" }] }),
			fileProvenance: {
				"src/here.ts": { at: "2026-08-01T00:00:00.000Z", scope: "import_graph", testCount: 1, surface: "sweep" },
			},
		});
		await mutationSweepCommand({ cwd, json: true, dryRun: true, unqualifiedOnly: true });
		const payload = reported() as unknown as { selected: Array<{ file: string }> };
		expect(payload.selected.map((r) => r.file)).toEqual(["src/there.ts"]);
	});
});
