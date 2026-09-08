import { parseWire, wireArray, wireString } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn<typeof import("node:child_process").execFileSync>());

vi.mock("node:child_process", () => ({
	execFileSync: execFileSyncMock,
}));

import {
	type CiRun,
	type CiStatusFetcher,
	GhCliFetcher,
	aggregateRuns,
	ciStatusCommand,
} from "./ci-status.js";

function run(overrides: Partial<CiRun> = {}): CiRun {
	return {
		databaseId: 1,
		workflowName: "build",
		status: "completed",
		conclusion: "success",
		name: "build job",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("GhCliFetcher.listRuns — args + parsing (positive/negative)", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	it("P1: builds exact args array with run/list/--json/fields/--limit", () => {
		execFileSyncMock.mockReturnValue("[]");
		const fetcher = new GhCliFetcher();
		fetcher.listRuns({ limit: 7, branch: undefined });
		expect(execFileSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args] = nonNull(execFileSyncMock.mock.calls[0]);
		expect(cmd).toBe("gh");
		expect(args).toEqual([
			"run",
			"list",
			"--json",
			"databaseId,workflowName,status,conclusion,name,headBranch,createdAt,url",
			"--limit",
			"7",
		]);
	});

	it("P2: appends --branch <name> only when opts.branch is set", () => {
		execFileSyncMock.mockReturnValue("[]");
		const fetcher = new GhCliFetcher();
		fetcher.listRuns({ limit: 5, branch: "main" });
		const args = parseWire(execFileSyncMock.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(args).toContain("--branch");
		expect(args[args.indexOf("--branch") + 1]).toBe("main");
	});

	it("N1: does NOT append --branch when opts.branch is undefined", () => {
		execFileSyncMock.mockReturnValue("[]");
		const fetcher = new GhCliFetcher();
		fetcher.listRuns({ limit: 5, branch: undefined });
		const args = parseWire(execFileSyncMock.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(args).not.toContain("--branch");
	});

	it("N2: non-array JSON response yields empty result", () => {
		execFileSyncMock.mockReturnValue(JSON.stringify({ not: "an array" }));
		const fetcher = new GhCliFetcher();
		const result = fetcher.listRuns({ limit: 5, branch: undefined });
		expect(result).toEqual([]);
	});

	it("P3: array of valid rows parses through", () => {
		execFileSyncMock.mockReturnValue(
			JSON.stringify([
				{
					databaseId: 42,
					workflowName: "ci",
					status: "completed",
					conclusion: "success",
					name: "test",
					createdAt: "2026-01-01T00:00:00Z",
				},
			]),
		);
		const fetcher = new GhCliFetcher();
		const result = fetcher.listRuns({ limit: 5, branch: undefined });
		expect(result).toHaveLength(1);
		expect(result[0]?.databaseId).toBe(42);
	});
});

describe("parseCiRun (via GhCliFetcher.listRuns) — field validation", () => {
	beforeEach(() => {
		execFileSyncMock.mockReset();
	});

	function parseOne(row: unknown): CiRun[] {
		execFileSyncMock.mockReturnValue(JSON.stringify([row]));
		const fetcher = new GhCliFetcher();
		return fetcher.listRuns({ limit: 5, branch: undefined });
	}

	const valid = {
		databaseId: 1,
		workflowName: "build",
		status: "completed",
		conclusion: "success",
		name: "job",
		createdAt: "2026-01-01T00:00:00Z",
	};

	it("N3: a non-object array element (string) is filtered out", () => {
		expect(parseOne("not-an-object")).toEqual([]);
	});

	it("N4: missing databaseId (wrong type) filters the row", () => {
		expect(parseOne({ ...valid, databaseId: "1" })).toEqual([]);
	});

	it("N5: wrong-type workflowName (valid databaseId) filters the row", () => {
		expect(parseOne({ ...valid, databaseId: "not-a-number", workflowName: "ok" })).toEqual([]);
	});

	it("N6: databaseId wrong type only (workflowName valid) filters the row", () => {
		expect(parseOne({ ...valid, databaseId: "x" })).toEqual([]);
	});

	it("N7: workflowName wrong type only (databaseId valid) filters the row", () => {
		expect(parseOne({ ...valid, workflowName: 5 })).toEqual([]);
	});

	it("N8: status wrong type filters the row", () => {
		expect(parseOne({ ...valid, status: 1, name: "job" })).toEqual([]);
	});

	it("N9: status wrong type only (name valid) filters the row", () => {
		expect(parseOne({ ...valid, status: 1 })).toEqual([]);
	});

	it("N10: name wrong type only (status valid) filters the row", () => {
		expect(parseOne({ ...valid, name: 1 })).toEqual([]);
	});

	it("N11: createdAt wrong type filters the row", () => {
		expect(parseOne({ ...valid, createdAt: 12345 })).toEqual([]);
	});

	it("N12: name wrong type filters the row", () => {
		expect(parseOne({ ...valid, name: {} })).toEqual([]);
	});

	it("P4: conclusion valid string is accepted, not filtered", () => {
		const result = parseOne({ ...valid, conclusion: "success" });
		expect(result).toHaveLength(1);
		expect(result[0]?.conclusion).toBe("success");
	});

	it("P5: conclusion null is accepted (in-progress run)", () => {
		const result = parseOne({ ...valid, conclusion: null });
		expect(result).toHaveLength(1);
		expect(result[0]?.conclusion).toBeNull();
	});

	it("N13: conclusion wrong type (not null, not string) filters the row", () => {
		expect(parseOne({ ...valid, conclusion: 42 })).toEqual([]);
	});

	it("P6: headBranch and url absent -> row present without those keys", () => {
		const { headBranch, url, ...rest } = { ...valid, headBranch: "x", url: "y" };
		const result = parseOne(rest);
		expect(result).toHaveLength(1);
		expect(result[0]).not.toHaveProperty("headBranch");
		expect(result[0]).not.toHaveProperty("url");
	});

	it("P7: headBranch and url present with valid strings -> included with values", () => {
		const result = parseOne({ ...valid, headBranch: "main", url: "https://example.com" });
		expect(result).toHaveLength(1);
		expect(result[0]?.headBranch).toBe("main");
		expect(result[0]?.url).toBe("https://example.com");
	});

	it("N14: headBranch wrong type filters the row", () => {
		expect(parseOne({ ...valid, headBranch: 5 })).toEqual([]);
	});

	it("N15: url wrong type filters the row", () => {
		expect(parseOne({ ...valid, url: 5 })).toEqual([]);
	});
});

describe("aggregateRuns — positive/negative", () => {
	it("P1: only status===completed runs count toward completed/failures/byWorkflow", () => {
		const runs = [
			run({ databaseId: 1, status: "completed", conclusion: "success" }),
			run({ databaseId: 2, status: "in_progress", conclusion: null }),
			run({ databaseId: 3, status: "completed", conclusion: "failure" }),
		];
		const agg = aggregateRuns(runs);
		expect(agg.total).toBe(3);
		expect(agg.completed).toBe(2);
		expect(agg.failures).toBe(1);
	});

	it("P2: byWorkflow sorted by failureRate desc, then failures desc", () => {
		const runs = [
			// workflow "low" appears first in insertion order but has a low failure rate
			run({ databaseId: 1, workflowName: "low", status: "completed", conclusion: "success" }),
			run({ databaseId: 2, workflowName: "low", status: "completed", conclusion: "success" }),
			run({ databaseId: 3, workflowName: "low", status: "completed", conclusion: "success" }),
			run({ databaseId: 4, workflowName: "low", status: "completed", conclusion: "failure" }),
			// workflow "high" appears second but has a higher failure rate
			run({ databaseId: 5, workflowName: "high", status: "completed", conclusion: "failure" }),
		];
		const agg = aggregateRuns(runs);
		expect(agg.byWorkflow[0]?.workflowName).toBe("high");
		expect(agg.byWorkflow[1]?.workflowName).toBe("low");
	});

	it("N1: recentFailures capped at 5 even with more failures present", () => {
		const runs = Array.from({ length: 8 }, (_, i) =>
			run({
				databaseId: i,
				status: "completed",
				conclusion: "failure",
				createdAt: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
			}),
		);
		const agg = aggregateRuns(runs);
		expect(agg.recentFailures).toHaveLength(5);
	});

	it("N2: recentFailures sorted newest-first by createdAt", () => {
		const runs = [
			run({ databaseId: 1, status: "completed", conclusion: "failure", createdAt: "2026-01-01T00:00:00Z" }),
			run({ databaseId: 2, status: "completed", conclusion: "failure", createdAt: "2026-01-03T00:00:00Z" }),
			run({ databaseId: 3, status: "completed", conclusion: "failure", createdAt: "2026-01-02T00:00:00Z" }),
		];
		const agg = aggregateRuns(runs);
		expect(agg.recentFailures.map((r) => r.databaseId)).toEqual([2, 3, 1]);
	});
});

describe("ciStatusCommand — output shaping", () => {
	let logs: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logs = [];
		logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
			logs.push(String(msg));
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	function unavailableFetcher(): CiStatusFetcher {
		return {
			available: () => false,
			listRuns: () => [],
		};
	}

	function availableFetcher(runs: CiRun[]): CiStatusFetcher {
		return {
			available: () => true,
			listRuns: () => runs,
		};
	}

	it("P1: json mode when unavailable emits exact error object, not {}", async () => {
		await ciStatusCommand({ json: true }, unavailableFetcher());
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed).toEqual({ error: "gh CLI not available" });
	});

	it("N1: short mode when unavailable does not throw and prints 'gh: not installed'", async () => {
		await expect(ciStatusCommand({ short: true }, unavailableFetcher())).resolves.toBeUndefined();
		expect(logs.join("\n")).toContain("gh: not installed");
	});

	it("N2: normal mode when unavailable prints the install message, not throwing", async () => {
		await expect(ciStatusCommand({}, unavailableFetcher())).resolves.toBeUndefined();
		expect(logs.join("\n")).toContain("gh CLI not found.");
	});

	it("P2: listRuns is called with { limit, branch } derived from opts", async () => {
		const calls: unknown[] = [];
		const fetcher: CiStatusFetcher = {
			available: () => true,
			listRuns: (opts) => {
				calls.push(opts);
				return [];
			},
		};
		await ciStatusCommand({ limit: 12, branch: "feature-x" }, fetcher);
		expect(calls).toEqual([{ limit: 12, branch: "feature-x" }]);
	});

	it("P3: json mode with data emits the full aggregation, not undefined", async () => {
		const runs = [run({ databaseId: 1, status: "completed", conclusion: "success" })];
		await ciStatusCommand({ json: true }, availableFetcher(runs));
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed.total).toBe(1);
		expect(parsed.completed).toBe(1);
	});

	it("N3: short mode with zero completed runs reports 'no completed runs'", async () => {
		await ciStatusCommand({ short: true }, availableFetcher([]));
		expect(logs.join("\n")).toContain("no completed runs");
	});

	it("N4: short mode with a failing top workflow reports failure counts", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "failure" }),
		];
		await ciStatusCommand({ short: true }, availableFetcher(runs));
		expect(logs.join("\n")).toContain("build: 1/1 failed");
	});
});

describe("formatNormal (via ciStatusCommand normal mode)", () => {
	let logs: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logs = [];
		logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
			logs.push(String(msg));
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	function fetcherFor(runs: CiRun[]): CiStatusFetcher {
		return { available: () => true, listRuns: () => runs };
	}

	it("N1: zero completed runs shows 'No completed runs found.' and no workflow section", async () => {
		await ciStatusCommand({}, fetcherFor([]));
		const text = logs.join("\n");
		expect(text).toContain("No completed runs found.");
		expect(text).not.toContain("Failure rate by workflow:");
	});

	it("N2: output never contains the injected mutant marker string", async () => {
		const runs = [run({ databaseId: 1, status: "completed", conclusion: "success" })];
		await ciStatusCommand({}, fetcherFor(runs));
		expect(logs.join("\n")).not.toContain("Stryker was here");
	});

	it("P1: workflow with 50% failure rate shows '50%' in the summary", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "success" }),
			run({ databaseId: 2, workflowName: "build", status: "completed", conclusion: "failure" }),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		expect(logs.join("\n")).toContain("50%");
	});

	it("P2: a workflow with zero failures renders the ' ok' marker, not a fail summary", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "success" }),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		const text = logs.join("\n");
		expect(text).toContain("build");
		expect(text).toContain(" ok");
		expect(text).not.toContain("fail (");
	});

	it("N3: a workflow with failures renders the fail summary, not the ' ok' marker", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "failure" }),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		const text = logs.join("\n");
		expect(text).toContain("build");
		expect(text).toContain("1/1 fail (100%)");
		expect(text).not.toMatch(/build\s+ ok/);
	});

	it("P3: recent failures section appears when there are failures, with detail lines", async () => {
		const runs = [
			run({
				databaseId: 1,
				workflowName: "build",
				name: "unit tests",
				status: "completed",
				conclusion: "failure",
				createdAt: "2026-01-05T12:34:00Z",
			}),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		const text = logs.join("\n");
		expect(text).toContain("Recent failures:");
		expect(text).toContain("2026-01-05 12:34");
		expect(text).toContain("build");
		expect(text).toContain("unit tests");
	});

	it("N4: recent failures section absent when there are no failures", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "success" }),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		expect(logs.join("\n")).not.toContain("Recent failures:");
	});

	it("P4: blank separator line exists between sections", async () => {
		const runs = [
			run({ databaseId: 1, workflowName: "build", status: "completed", conclusion: "failure" }),
		];
		await ciStatusCommand({}, fetcherFor(runs));
		const lines = logs.join("\n").split("\n");
		expect(lines).toContain("");
	});
});
