// Behavioral tests for `interlinked ci-status`.
//
// Strategy: every effectful boundary is mocked so the full branch tree is
// driven deterministically and nothing touches the real network / gh / git:
//   - node:child_process → execFileSync spy (the gh subprocess)
//   - ../lib/formatter.js → pass-through `c` proxy so assertions match plain
//     strings without smuggling ANSI escape codes
// console.log is spied so emitted output is captured verbatim; process.exitCode
// is saved/restored around the not-available path.
//
// Coverage spans: aggregateRuns grouping/sort/failure-classes/recent-cap,
// GhCliFetcher.available (ok + throw), GhCliFetcher.listRuns (branch arg,
// non-array result, parse/exec throw), the isCiRun type guard (every field
// branch), all three formatters in every mode, the not-available + clamp
// paths in ciStatusCommand, and registerCiCommand action wiring.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: mocks.execFileSync,
}));

// Pass-through formatter: `c.red("x")` === "x". Lets assertions match the
// literal message text rather than ANSI-wrapped output.
vi.mock("../lib/formatter.js", () => ({
	c: new Proxy(
		{},
		{
			get: () => (s: string) => s,
		},
	),
}));

import { nonNull } from "../lib/non-null.js";
import {
	aggregateRuns,
	type CiRun,
	type CiStatusFetcher,
	ciStatusCommand,
	GhCliFetcher,
	registerCiCommand,
} from "./ci-status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(partial: Partial<CiRun> & { conclusion: string | null }): CiRun {
	return {
		databaseId: 1,
		workflowName: "CI",
		status: "completed",
		name: "commit",
		createdAt: "2026-05-01T00:00:00Z",
		...partial,
	};
}

class StubFetcher implements CiStatusFetcher {
	public lastOpts: { limit: number; branch?: string | undefined } | undefined;
	constructor(
		private readonly runs: CiRun[],
		private readonly _available = true,
	) {}
	available(): boolean {
		return this._available;
	}
	listRuns(opts: { limit: number; branch?: string | undefined }): CiRun[] {
		this.lastOpts = opts;
		return this.runs;
	}
}

let logSpy: ReturnType<typeof vi.spyOn>;

/** Join everything that was written to console.log into a single string. */
function captured(): string {
	return logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
}

beforeEach(() => {
	mocks.execFileSync.mockReset();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// aggregateRuns
// ---------------------------------------------------------------------------

describe("aggregateRuns", () => {
	it("returns an empty aggregation when there are no runs", () => {
		const agg = aggregateRuns([]);
		expect(agg).toEqual({
			total: 0,
			completed: 0,
			failures: 0,
			byWorkflow: [],
			recentFailures: [],
		});
	});

	it("groups completed runs by workflow and computes per-workflow failure rate", () => {
		const agg = aggregateRuns([
			run({ workflowName: "CI", conclusion: "success" }),
			run({ workflowName: "CI", conclusion: "failure" }),
			run({ workflowName: "CI", conclusion: "failure" }),
			run({ workflowName: "Release", conclusion: "success" }),
		]);
		expect(agg.total).toBe(4);
		expect(agg.completed).toBe(4);
		expect(agg.failures).toBe(2);

		const ci = agg.byWorkflow.find((w) => w.workflowName === "CI");
		expect(ci).toEqual({
			workflowName: "CI",
			total: 3,
			failures: 2,
			failureRate: 2 / 3,
		});
		const release = agg.byWorkflow.find((w) => w.workflowName === "Release");
		expect(release).toEqual({
			workflowName: "Release",
			total: 1,
			failures: 0,
			failureRate: 0,
		});
	});

	it("sorts workflows by failure rate desc, then by failure count as tiebreak", () => {
		const agg = aggregateRuns([
			run({ workflowName: "ok", conclusion: "success" }),
			run({ workflowName: "ok", conclusion: "success" }),
			run({ workflowName: "half", conclusion: "failure" }),
			run({ workflowName: "half", conclusion: "success" }),
			run({ workflowName: "all-bad", conclusion: "failure" }),
		]);
		expect(agg.byWorkflow.map((w) => w.workflowName)).toEqual([
			"all-bad",
			"half",
			"ok",
		]);
	});

	it("uses failure count as the tiebreak when two workflows share a failure rate", () => {
		// Two 100%-failing workflows: the one with more failures sorts first.
		const agg = aggregateRuns([
			run({ workflowName: "few", conclusion: "failure" }),
			run({ workflowName: "many", conclusion: "failure" }),
			run({ workflowName: "many", conclusion: "failure" }),
		]);
		expect(agg.byWorkflow.map((w) => w.workflowName)).toEqual(["many", "few"]);
	});

	it("treats failure / cancelled / timed_out / action_required as failures", () => {
		const agg = aggregateRuns([
			run({ conclusion: "failure" }),
			run({ conclusion: "cancelled" }),
			run({ conclusion: "timed_out" }),
			run({ conclusion: "action_required" }),
			run({ conclusion: "success" }),
		]);
		expect(agg.failures).toBe(4);
	});

	it("does NOT count benign conclusions (skipped, neutral, null) as failures", () => {
		const agg = aggregateRuns([
			run({ conclusion: "skipped" }),
			run({ conclusion: "neutral" }),
			run({ conclusion: null }),
		]);
		expect(agg.completed).toBe(3);
		expect(agg.failures).toBe(0);
		expect(nonNull(agg.byWorkflow[0]).failures).toBe(0);
	});

	it("excludes in-progress and queued runs from completed/failure counts but keeps total", () => {
		const agg = aggregateRuns([
			run({ status: "in_progress", conclusion: null }),
			run({ status: "queued", conclusion: null }),
			run({ conclusion: "success" }),
		]);
		expect(agg.total).toBe(3);
		expect(agg.completed).toBe(1);
		expect(agg.failures).toBe(0);
	});

	it("returns at most 5 failures, most-recent first by createdAt", () => {
		const runs: CiRun[] = [];
		for (let i = 0; i < 10; i++) {
			runs.push(
				run({
					conclusion: "failure",
					createdAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
					name: `commit-${i}`,
				}),
			);
		}
		const agg = aggregateRuns(runs);
		expect(agg.recentFailures).toHaveLength(5);
		expect(agg.recentFailures.map((r) => r.name)).toEqual([
			"commit-9",
			"commit-8",
			"commit-7",
			"commit-6",
			"commit-5",
		]);
	});
});

// ---------------------------------------------------------------------------
// GhCliFetcher.available
// ---------------------------------------------------------------------------

describe("GhCliFetcher.available", () => {
	it("returns true when `gh --version` succeeds", () => {
		mocks.execFileSync.mockReturnValue("gh version 2.0.0");
		expect(new GhCliFetcher().available()).toBe(true);
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"gh",
			["--version"],
			expect.objectContaining({ stdio: "ignore", timeout: 3000 }),
		);
	});

	it("returns false when `gh --version` throws (gh not installed)", () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(new GhCliFetcher().available()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// GhCliFetcher.listRuns + isCiRun type guard
// ---------------------------------------------------------------------------

describe("GhCliFetcher.listRuns", () => {
	it("invokes gh with the json field list and the limit, parsing valid runs", () => {
		const valid = run({ conclusion: "success" });
		mocks.execFileSync.mockReturnValue(JSON.stringify([valid]));

		const out = new GhCliFetcher().listRuns({ limit: 30 });

		expect(out).toEqual([valid]);
		const firstCall = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(firstCall[0]).toBe("gh");
		expect(firstCall[1]).toEqual([
			"run",
			"list",
			"--json",
			"databaseId,workflowName,status,conclusion,name,headBranch,createdAt,url",
			"--limit",
			"30",
		]);
		// No --branch when branch is omitted.
		expect(firstCall[1]).not.toContain("--branch");
	});

	it("appends --branch <name> when a branch is provided", () => {
		mocks.execFileSync.mockReturnValue("[]");
		new GhCliFetcher().listRuns({ limit: 10, branch: "main" });
		const args = nonNull(mocks.execFileSync.mock.calls[0])[1];
		expect(args).toContain("--branch");
		expect(args[args.indexOf("--branch") + 1]).toBe("main");
	});

	it("filters out malformed entries via the isCiRun guard", () => {
		const good = run({ conclusion: "failure", databaseId: 7 });
		mocks.execFileSync.mockReturnValue(
			JSON.stringify([
				good,
				null, // not an object
				42, // primitive
				{ ...good, databaseId: "nope" }, // databaseId wrong type
				{ ...good, workflowName: 123 }, // workflowName wrong type
				{ ...good, status: false }, // status wrong type
				{ ...good, name: undefined }, // name missing
				{ ...good, createdAt: 0 }, // createdAt wrong type
			]),
		);
		const out = new GhCliFetcher().listRuns({ limit: 50 });
		expect(out).toEqual([good]);
	});

	it("returns [] when the parsed JSON is not an array", () => {
		mocks.execFileSync.mockReturnValue(JSON.stringify({ not: "an array" }));
		expect(new GhCliFetcher().listRuns({ limit: 30 })).toEqual([]);
	});

	it("returns [] when the JSON is unparseable", () => {
		mocks.execFileSync.mockReturnValue("this is not json{");
		expect(new GhCliFetcher().listRuns({ limit: 30 })).toEqual([]);
	});

	it("returns [] when gh itself throws (not authenticated / no repo)", () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("gh: not authenticated");
		});
		expect(new GhCliFetcher().listRuns({ limit: 30 })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — not-available path
// ---------------------------------------------------------------------------

describe("ciStatusCommand — gh unavailable", () => {
	it("normal mode: prints an install hint and sets exitCode 1", async () => {
		await ciStatusCommand({}, new StubFetcher([], false));
		const out = captured();
		expect(out).toContain("gh CLI not found.");
		expect(out).toContain("https://cli.github.com");
		expect(out).toContain("gh auth login");
		expect(process.exitCode).toBe(1);
	});

	it("short mode: prints the one-line not-installed summary", async () => {
		await ciStatusCommand({ short: true }, new StubFetcher([], false));
		expect(captured()).toBe("gh: not installed");
		expect(process.exitCode).toBe(1);
	});

	it("json mode: prints a structured error object", async () => {
		await ciStatusCommand({ json: true }, new StubFetcher([], false));
		expect(JSON.parse(captured())).toEqual({ error: "gh CLI not available" });
		expect(process.exitCode).toBe(1);
	});

	it("does not call listRuns when gh is unavailable", async () => {
		const fetcher = new StubFetcher([run({ conclusion: "failure" })], false);
		await ciStatusCommand({}, fetcher);
		expect(fetcher.lastOpts).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — limit clamping
// ---------------------------------------------------------------------------

describe("ciStatusCommand — limit clamping", () => {
	it("clamps an over-max limit down to 100", async () => {
		const fetcher = new StubFetcher([]);
		await ciStatusCommand({ limit: 9999 }, fetcher);
		expect(fetcher.lastOpts?.limit).toBe(100);
	});

	it("clamps a below-min limit up to 1", async () => {
		const fetcher = new StubFetcher([]);
		await ciStatusCommand({ limit: -5 }, fetcher);
		expect(fetcher.lastOpts?.limit).toBe(1);
	});

	it("defaults to 30 when no limit is supplied", async () => {
		const fetcher = new StubFetcher([]);
		await ciStatusCommand({}, fetcher);
		expect(fetcher.lastOpts?.limit).toBe(30);
	});

	it("passes a valid in-range limit through unchanged", async () => {
		const fetcher = new StubFetcher([]);
		await ciStatusCommand({ limit: 42 }, fetcher);
		expect(fetcher.lastOpts?.limit).toBe(42);
	});

	it("forwards the branch option to the fetcher", async () => {
		const fetcher = new StubFetcher([]);
		await ciStatusCommand({ branch: "feature/x" }, fetcher);
		expect(fetcher.lastOpts?.branch).toBe("feature/x");
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — short mode (formatShort)
// ---------------------------------------------------------------------------

describe("ciStatusCommand — short mode", () => {
	it("reports 'no completed runs' when nothing has completed", async () => {
		await ciStatusCommand(
			{ short: true },
			new StubFetcher([run({ status: "in_progress", conclusion: null })]),
		);
		expect(captured()).toBe("no completed runs");
	});

	it("reports 'all green' when the top workflow has zero failures", async () => {
		await ciStatusCommand(
			{ short: true },
			new StubFetcher([
				run({ conclusion: "success" }),
				run({ conclusion: "success" }),
			]),
		);
		expect(captured()).toBe("2 runs, all green");
	});

	it("reports the worst workflow's failure ratio when there are failures", async () => {
		await ciStatusCommand(
			{ short: true },
			new StubFetcher([
				run({ workflowName: "Build", conclusion: "failure" }),
				run({ workflowName: "Build", conclusion: "failure" }),
				run({ workflowName: "Build", conclusion: "success" }),
			]),
		);
		expect(captured()).toBe("Build: 2/3 failed");
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — normal mode (formatNormal)
// ---------------------------------------------------------------------------

describe("ciStatusCommand — normal mode", () => {
	it("renders the 'all branches' scope when no branch is given", async () => {
		await ciStatusCommand({}, new StubFetcher([run({ conclusion: "success" })]));
		const out = captured();
		expect(out).toContain("GitHub Actions — last 30 runs (all branches)");
	});

	it("renders a branch-scoped header when a branch is given", async () => {
		await ciStatusCommand(
			{ branch: "main", limit: 10 },
			new StubFetcher([run({ conclusion: "success" })]),
		);
		expect(captured()).toContain("GitHub Actions — last 10 runs (branch main)");
	});

	it("short-circuits to 'No completed runs found.' when nothing completed", async () => {
		await ciStatusCommand(
			{},
			new StubFetcher([run({ status: "queued", conclusion: null })]),
		);
		const out = captured();
		expect(out).toContain("No completed runs found.");
		// The failure-rate / recent-failures sections are skipped.
		expect(out).not.toContain("Failure rate by workflow:");
	});

	it("renders an ' ok' marker for a clean workflow and a failure ratio for a broken one", async () => {
		await ciStatusCommand(
			{},
			new StubFetcher([
				run({ workflowName: "Lint", conclusion: "success" }),
				run({ workflowName: "Tests", conclusion: "failure", name: "boom" }),
				run({ workflowName: "Tests", conclusion: "success" }),
			]),
		);
		const out = captured();
		expect(out).toContain("Failure rate by workflow:");
		// Clean workflow -> " ok"
		expect(out).toMatch(/Lint\s+ ok/);
		// Broken workflow -> "<fails>/<total> fail (<pct>%)"
		expect(out).toContain("1/2 fail (50%)");
	});

	it("lists recent failures with a trimmed timestamp + workflow + commit name", async () => {
		await ciStatusCommand(
			{},
			new StubFetcher([
				run({
					workflowName: "CI",
					conclusion: "failure",
					name: "regression in parser",
					createdAt: "2026-05-09T14:30:55Z",
				}),
			]),
		);
		const out = captured();
		expect(out).toContain("Recent failures:");
		// createdAt sliced to 16 chars with the 'T' swapped for a space.
		expect(out).toContain("2026-05-09 14:30  CI — regression in parser");
	});

	it("omits the 'Recent failures:' section when everything is green", async () => {
		await ciStatusCommand({}, new StubFetcher([run({ conclusion: "success" })]));
		const out = captured();
		expect(out).not.toContain("Recent failures:");
	});

	it("truncates an over-long failing commit name to 60 chars in the recent list", async () => {
		const longName = "x".repeat(120);
		await ciStatusCommand(
			{},
			new StubFetcher([run({ conclusion: "failure", name: longName })]),
		);
		const out = captured();
		expect(out).toContain("x".repeat(60));
		expect(out).not.toContain("x".repeat(61));
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — json mode
// ---------------------------------------------------------------------------

describe("ciStatusCommand — json mode", () => {
	it("emits the full aggregation object as JSON", async () => {
		await ciStatusCommand(
			{ json: true },
			new StubFetcher([
				run({ workflowName: "CI", conclusion: "failure", name: "broke" }),
				run({ workflowName: "CI", conclusion: "success" }),
			]),
		);
		const parsed = JSON.parse(captured());
		expect(parsed.total).toBe(2);
		expect(parsed.completed).toBe(2);
		expect(parsed.failures).toBe(1);
		expect(parsed.byWorkflow[0].workflowName).toBe("CI");
		expect(parsed.byWorkflow[0].failureRate).toBeCloseTo(0.5);
		expect(parsed.recentFailures[0].name).toBe("broke");
	});
});

// ---------------------------------------------------------------------------
// ciStatusCommand — full mode (formatFull)
// ---------------------------------------------------------------------------

describe("ciStatusCommand — full mode", () => {
	it("lists every run including the normal-mode summary header", async () => {
		await ciStatusCommand(
			{ full: true },
			new StubFetcher([
				run({ workflowName: "CI", conclusion: "success", name: "green one" }),
				run({ workflowName: "CI", conclusion: "failure", name: "red one" }),
			]),
		);
		const out = captured();
		// Includes the normal-mode header (formatFull embeds formatNormal).
		expect(out).toContain("GitHub Actions — last 30 runs");
		expect(out).toContain("All runs:");
		expect(out).toContain("green one");
		expect(out).toContain("red one");
	});

	it("shows the conclusion for completed runs (success / failure rows)", async () => {
		await ciStatusCommand(
			{ full: true },
			new StubFetcher([
				run({ conclusion: "success", name: "ok-row" }),
				run({ conclusion: "failure", name: "fail-row" }),
			]),
		);
		const out = captured();
		expect(out).toContain("success");
		expect(out).toContain("failure");
	});

	it("shows a benign non-failure conclusion verbatim (neither green nor red branch)", async () => {
		// conclusion="skipped" is completed, not success, not a failure → the
		// uncolored ternary fallback. With the pass-through formatter the row
		// still contains the literal status word.
		await ciStatusCommand(
			{ full: true },
			new StubFetcher([run({ conclusion: "skipped", name: "skip-row" })]),
		);
		expect(captured()).toContain("skipped");
	});

	it("shows the live status (not the conclusion) for in-progress, and '?' when both absent", async () => {
		await ciStatusCommand(
			{ full: true },
			new StubFetcher([
				run({ status: "in_progress", conclusion: null, name: "running" }),
				// completed but conclusion null → status branch yields "?"
				run({ status: "completed", conclusion: null, name: "weird" }),
			]),
		);
		const out = captured();
		expect(out).toContain("in_progress");
		// The completed-with-null-conclusion run renders "?" for its status cell.
		expect(out).toMatch(/weird/);
		expect(out).toContain("?");
	});

	it("truncates an over-long commit name to 60 chars in the all-runs list", async () => {
		const longName = "y".repeat(100);
		await ciStatusCommand(
			{ full: true },
			new StubFetcher([run({ conclusion: "success", name: longName })]),
		);
		const out = captured();
		expect(out).toContain("y".repeat(60));
		expect(out).not.toContain("y".repeat(61));
	});
});

// ---------------------------------------------------------------------------
// registerCiCommand — commander wiring
// ---------------------------------------------------------------------------

describe("registerCiCommand", () => {
	it("registers a 'ci-status' subcommand with the documented options", () => {
		const program = new Command();
		registerCiCommand(program);
		const subcommand = nonNull(program.commands.find((command) => command.name() === "ci-status"));
		expect(subcommand.description()).toContain("GitHub Actions");
		const optionFlags = subcommand.options.map((option) => option.flags);
		expect(optionFlags).toEqual([
			"--limit <n>",
			"--branch <name>",
			"--json",
			"--short",
			"--full",
		]);
	});

	it("the --limit parser converts the raw string to an integer", () => {
		const program = new Command();
		registerCiCommand(program);
		const subcommand = nonNull(program.commands.find((command) => command.name() === "ci-status"));
		subcommand.parseOptions(["--limit", "57"]);
		expect(subcommand.opts().limit).toBe(57);
	});

	it("the registered action runs ciStatusCommand with the real (mocked) gh fetcher", async () => {
		// Drive the default GhCliFetcher path: make `gh --version` throw so the
		// command takes the deterministic not-available branch end-to-end.
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("no gh");
		});
		const program = new Command();
		registerCiCommand(program);
		await program.parseAsync(["ci-status", "--json"], { from: "user" });
		expect(JSON.parse(captured())).toEqual({ error: "gh CLI not available" });
		expect(process.exitCode).toBe(1);
	});
});
