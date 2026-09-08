import { makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import { nonNull } from "../../lib/non-null.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import type { SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("./fuzz-targets.js", () => ({
	detectFuzzTargets: vi.fn(() => ["test/prop.smoke.test.ts"]),
}));

import { heavyJobReportPath, runSessionEndHeavyJobs } from "./session-end-heavy-jobs.js";

function makePlan(overrides: Partial<ResourcePlan> = {}): ResourcePlan {
	return {
		maxJobs: 1,
		background: true,
		commandPrefix: "",
		defer: false,
		reason: "test",
		...overrides,
	};
}

function makeCtx(cwd: string, logs: string[]): ServerRuntime {
	return makeServerRuntime({
		cwd,
		log: (msg: string) => {
			logs.push(msg);
		},
	});
}

function makeEvent(sessionId: string): HarnessEvent {
	return makeEventFixture({ session_id: sessionId });
}

describe("heavyJobReportPath — positive (must fire)", () => {
	it("P1: builds the exact expected path for fuzz kind", () => {
		const result = heavyJobReportPath("/tmp/repo", "fuzz", "abc123");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "fuzz-reports", "abc123.json"));
	});

	it("P2: builds the exact expected path for bench kind", () => {
		const result = heavyJobReportPath("/tmp/repo", "bench", "abc123");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "bench-reports", "abc123.json"));
	});

	it("P3: sanitizes special characters in the session id, replacing each with underscore", () => {
		const result = heavyJobReportPath("/tmp/repo", "fuzz", "a b");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "fuzz-reports", "a_b.json"));
	});

	it("P4: falls back to 'unknown' for an empty session id (not 'undefined', 'true', or 'false')", () => {
		const result = heavyJobReportPath("/tmp/repo", "fuzz", "");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "fuzz-reports", "unknown.json"));
	});

	it("P5: keeps a session id that needs no sanitizing intact (non-empty truthy branch)", () => {
		const result = heavyJobReportPath("/tmp/repo", "fuzz", "plain-id.1");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "fuzz-reports", "plain-id.1.json"));
	});

	it("P6: strips a slash from the session id using underscore, not empty string", () => {
		const result = heavyJobReportPath("/tmp/repo", "bench", "a/b");
		expect(result).toBe(join("/tmp/repo", ".interlinked", "bench-reports", "a_b.json"));
		expect(result).not.toContain("ab.json");
	});
});

describe("runSessionEndHeavyJobs — positive (must fire)", () => {
	let tmpCwd: string;
	let logs: string[];
	let spawnCalls: Array<{ file: string; args: string[]; options: SpawnOptions }>;
	let fakeChildren: Array<{ on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }>;

	beforeEach(() => {
		tmpCwd = mkdtempSync();
		logs = [];
		spawnCalls = [];
		fakeChildren = [];
	});

	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	function mkdtempSync(): string {
		return require("node:fs").mkdtempSync(join(os.tmpdir(), "heavy-jobs-w49-"));
	}

	function fakeSpawn(file: string, args: string[], options: SpawnOptions) {
		spawnCalls.push({ file, args, options });
		const child = { on: vi.fn(), unref: vi.fn() };
		fakeChildren.push(child);
		return child;
	}

	it("P1: spawns the fuzz-smoke job with the exact npx vitest args and 500 numRuns env", () => {
		const plan = makePlan();
		const event = makeEvent("sess-1");
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), event, plan, {
			spawn: fakeSpawn,
		});

		const reportPath = heavyJobReportPath(tmpCwd, "fuzz", "sess-1");
		const fuzzCall = spawnCalls.find((c) => c.args.includes("run"));
		expect(fuzzCall).toBeDefined();
		expect(fuzzCall?.file).toBe("npx");
		expect(fuzzCall?.args).toEqual([
			"vitest",
			"run",
			"test/prop.smoke.test.ts",
			"--reporter=json",
			`--outputFile=${reportPath}`,
		]);
		expect(fuzzCall?.options).toHaveProperty(["env","INTERLINKED_PROPERTY_NUMRUNS"], "500");
	});

	it("P2: merges process.env into the fuzz-smoke child env (inherits PATH), not replacing it", () => {
		process.env.HEAVY_JOBS_TEST_MARKER = "marker-value";
		const plan = makePlan();
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-2"), plan, {
			spawn: fakeSpawn,
		});
		const fuzzCall = spawnCalls.find((c) => c.args.includes("run"));
		const env = nonNull(fuzzCall?.options.env);
		expect(env.HEAVY_JOBS_TEST_MARKER).toBe("marker-value");
		delete process.env.HEAVY_JOBS_TEST_MARKER;
	});

	it("P3: spawns with detached true, stdio ignore, and cwd set to ctx.cwd", () => {
		const plan = makePlan();
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-3"), plan, {
			spawn: fakeSpawn,
		});
		const fuzzCall = spawnCalls.find((c) => c.args.includes("run"));
		expect(fuzzCall?.options.cwd).toBe(tmpCwd);
		expect(fuzzCall?.options.detached).toBe(true);
		expect(fuzzCall?.options.stdio).toBe("ignore");
	});

	it("P4: creates the nested report directory before spawning (mkdirSync recursive)", () => {
		const plan = makePlan();
		const reportPath = heavyJobReportPath(tmpCwd, "fuzz", "sess-4");
		expect(existsSync(dirname(reportPath))).toBe(false);
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-4"), plan, {
			spawn: fakeSpawn,
		});
		expect(existsSync(dirname(reportPath))).toBe(true);
	});

	it("P5: registers an 'error' listener on the spawned child (not some other event name)", () => {
		const plan = makePlan();
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-5"), plan, {
			spawn: fakeSpawn,
		});
		const child = fakeChildren[0];
		expect(child).toBeDefined();
		expect(child?.on).toHaveBeenCalledWith("error", expect.any(Function));
	});

	it("P6: logs the job name and background flag on successful spawn", () => {
		const plan = makePlan({ background: true });
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-6"), plan, {
			spawn: fakeSpawn,
		});
		expect(logs.some((l) => l.includes("fuzz-smoke") && l.includes("spawned") && l.includes("bg=true"))).toBe(
			true,
		);
	});

	it("P7: runs the bench-snapshot job (name + kind) when a bench/ dir exists, with a bench-reports path", () => {
		mkdirSync(join(tmpCwd, "bench"), { recursive: true });
		const plan = makePlan();
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-7"), plan, {
			spawn: fakeSpawn,
		});
		const benchReportPath = heavyJobReportPath(tmpCwd, "bench", "sess-7");
		const benchCall = spawnCalls.find((c) => c.args.includes("bench"));
		expect(benchCall).toBeDefined();
		expect(benchCall?.args).toContain(`--outputFile=${benchReportPath}`);
		expect(benchReportPath).toContain(`${join("bench-reports")}`);
		expect(logs.some((l) => l.includes("bench-snapshot"))).toBe(true);
	});

	it("P8: bench-snapshot job has no env key in spawn options (cmd.env is undefined)", () => {
		mkdirSync(join(tmpCwd, "bench"), { recursive: true });
		const plan = makePlan();
		runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-8"), plan, {
			spawn: fakeSpawn,
		});
		const benchCall = spawnCalls.find((c) => c.args.includes("bench"));
		expect(benchCall?.options.env).toBeUndefined();
	});

	it("P9: never throws even when the injected spawn function throws synchronously", () => {
		const plan = makePlan();
		const throwingSpawn = () => {
			throw new Error("boom");
		};
		expect(() =>
			runSessionEndHeavyJobs(makeCtx(tmpCwd, logs), makeEvent("sess-9"), plan, {
				spawn: throwingSpawn,
			}),
		).not.toThrow();
	});
});
