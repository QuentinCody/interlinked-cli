import { makeServerRuntime } from "./__tests__/fixtures.js";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import type { ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";
import {
	governedSpawn,
	runSessionEndJobs,
	runSessionEndResourcePlan,
	type SessionEndJobDeps,
} from "./session-end-batch.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })),
}));

type SpawnFn = NonNullable<SessionEndJobDeps["spawn"]>;

function sessionEnd(sessionId = "s1"): HarnessEvent {
	return {
		hook_event: "SessionEnd",
		session_id: sessionId,
		agent_source: "claude",
		tool_input: {},
		cwd: "/repo",
		timestamp: "t",
	};
}

function makeCtx(over: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime & { _logLines: string[] } {
	const logLines: string[] = [];
	const base = {
		cwd: "/repo",

		cohort: new CohortManager(),
		log: (msg: string) => {
			logLines.push(msg);
		},
		logAlways: () => {},
		_logLines: logLines,
	};
	return Object.assign(makeServerRuntime({ ...base, ...over }), { _logLines: logLines });
}

describe("runSessionEndResourcePlan", () => {
	it("defers heavy session-end work when the host is busy", () => {
		const cores = vi.spyOn(os, "availableParallelism").mockReturnValue(2);
		const load = vi.spyOn(os, "loadavg").mockReturnValue([20, 20, 20]);
		try {
			const ctx = makeCtx();
			expect(runSessionEndResourcePlan(ctx, sessionEnd("busy"))).toMatchObject({ defer: true });
			expect(ctx._logLines.join("\n")).toContain("DEFER heavy lane");
		} finally {
			load.mockRestore();
			cores.mockRestore();
		}
	});

	it("returns a valid resource plan for the current machine", () => {
		const ctx = makeCtx();
		const plan = runSessionEndResourcePlan(ctx, sessionEnd());
		expect(plan).not.toBeNull();
		expect(plan?.maxJobs).toBeGreaterThanOrEqual(0);
		expect(typeof plan?.defer).toBe("boolean");
		expect(plan?.reason.length).toBeGreaterThan(0);
	});

	it("logs the plan with the session id", () => {
		const logLines: string[] = [];
		const ctx = makeCtx({
			log: (m: string) => {
				logLines.push(m);
			},
		});
		runSessionEndResourcePlan(ctx, sessionEnd("abc"));
		expect(logLines.some((l) => l.includes("abc") && l.includes("resource plan"))).toBe(true);
	});

	it("never throws even if the cohort read fails (never-throw contract)", () => {
		const brokenCohort = {
			getActiveAgents() {
				throw new Error("cohort exploded");
			},
		};
		const ctx = makeCtx({ cohort: brokenCohort });
		expect(() => runSessionEndResourcePlan(ctx, sessionEnd())).not.toThrow();
		expect(runSessionEndResourcePlan(ctx, sessionEnd())).toBeNull();
	});
});

describe("governedSpawn", () => {
	it("runs the command directly when there is no priority prefix", () => {
		const { file, args } = governedSpawn("", "/node", ["cli.js", "recurrence"]);
		expect(file).toBe("/node");
		expect(args).toEqual(["cli.js", "recurrence"]);
	});

	it("wraps in taskpolicy on macOS", () => {
		const { file, args } = governedSpawn("taskpolicy -b ", "/node", ["cli.js", "scan"]);
		expect(file).toBe("taskpolicy");
		expect(args).toEqual(["-b", "/node", "cli.js", "scan"]);
	});

	it("wraps in nice on Linux", () => {
		const { file, args } = governedSpawn("nice -n 19 ", "/node", ["cli.js"]);
		expect(file).toBe("nice");
		expect(args).toEqual(["-n", "19", "/node", "cli.js"]);
	});
});

describe("runSessionEndJobs", () => {
	const activePlan: ResourcePlan = {
		maxJobs: 4,
		background: true,
		commandPrefix: "taskpolicy -b ",
		defer: false,
		reason: "quiet",
	};

	afterEach(() => {
		delete process.env.INTERLINKED_DISABLE_SESSION_END_JOBS;
	});

	function fakeChild() {
		return { on() {}, unref() {} };
	}

	it("spawns each governed job with the priority-wrapped argv", () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const spawn = ((file: string, args: string[]) => {
			calls.push({ file, args });
			return fakeChild();
		}) satisfies SpawnFn;
		runSessionEndJobs(makeCtx(), activePlan, {
			spawn,
			cliEntry: "/repo/dist/index.js",
			execPath: "/node",
		});
		// Job 4 (recurrence scan) + Job 1 (coverage ratchet), both taskpolicy-wrapped.
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c.file).toBe("taskpolicy");
			expect(c.args.slice(0, 4)).toEqual(["-b", "/node", "--max-old-space-size=128", "/repo/dist/harness/background-job-main.js"]);
			expect(c.args.slice(5, 7)).toEqual(["/node", "/repo/dist/index.js"]);
		}
		const commands = calls.map((c) => c.args.slice(7).join(" "));
		expect(commands).toContain("recurrence scan --record");
		expect(commands).toContain("coverage check --update-baseline");
	});

	it("keeps each heavy job single-flight until its detached child exits", () => {
		const activeJobs = new Set<string>();
		const exits: Array<() => void> = [];
		let spawnCount = 0;
		// SAFETY: the double implements the event/unref surface used by the
		// production single-flight tracker; exit is driven explicitly below.
		const spawn = (() => {
			spawnCount += 1;
			return {
				on(...args: ["error", (error: Error) => void] | ["exit", () => void]) {
					if (args[0] === "exit") exits.push(args[1]);
				},
				unref() {},
			};
		}) satisfies SpawnFn;
		const deps = { spawn, cliEntry: "/repo/dist/index.js", execPath: "/node", activeJobs };

		runSessionEndJobs(makeCtx(), activePlan, deps);
		runSessionEndJobs(makeCtx(), activePlan, deps);
		expect(spawnCount).toBe(2);
		expect(activeJobs).toEqual(new Set(["recurrence-scan", "coverage-ratchet"]));

		exits[0]?.();
		runSessionEndJobs(makeCtx(), activePlan, deps);
		expect(spawnCount).toBe(3);
	});

	it("does NOT spawn when the governor defers (busy machine)", () => {
		let spawned = false;
		const spawn = (() => {
			spawned = true;
			return fakeChild();
		}) satisfies SpawnFn;
		runSessionEndJobs(makeCtx(), { ...activePlan, defer: true }, { spawn });
		expect(spawned).toBe(false);
	});

	it("does NOT spawn when opted out via env", () => {
		process.env.INTERLINKED_DISABLE_SESSION_END_JOBS = "1";
		let spawned = false;
		const spawn = (() => {
			spawned = true;
			return fakeChild();
		}) satisfies SpawnFn;
		runSessionEndJobs(makeCtx(), activePlan, { spawn });
		expect(spawned).toBe(false);
	});

	it("never throws when spawn itself fails", () => {
		const spawn = (() => {
			throw new Error("ENOENT");
		}) satisfies SpawnFn;
		expect(() =>
			runSessionEndJobs(makeCtx(), activePlan, { spawn, cliEntry: "x", execPath: "y" }),
		).not.toThrow();
	});

	it("logs the job name when the spawned child emits an error", () => {
		const ctx = makeCtx();
		// SAFETY: test double matching only the (event, cb) shape spawnGovernedJob reads.
		const spawn = ((_file: string, _args: string[]) => {
			return {
				on(event: string, cb: (e: Error) => void) {
					if (event === "error") cb(new Error("ENOENT: no such file"));
				},
				unref() {},
			};
		}) satisfies SpawnFn;
		runSessionEndJobs(ctx, activePlan, { spawn, cliEntry: "/x", execPath: "/node" });
		const lines = ctx._logLines;
		expect(lines.some((l) => l.includes("spawn failed (skipped): ENOENT: no such file"))).toBe(
			true,
		);
	});

	it("resolves the default cli entry from argv[1]'s parent directory", () => {
		const original = process.argv[1];
		process.argv[1] = "/repo/dist/harness/server.js";
		try {
			const calls: Array<{ file: string; args: string[] }> = [];
			const spawn = ((file: string, args: string[]) => {
				calls.push({ file, args });
				return fakeChild();
			}) satisfies SpawnFn;
			runSessionEndJobs(makeCtx(), activePlan, { spawn, execPath: "/node" });
			expect(calls[0]?.args).toContain("/repo/dist/index.js");
		} finally {
			if (original !== undefined) process.argv[1] = original;
		}
	});

	it("resolves the default cli entry relative to '.' when argv[1] is unset", () => {
		const original = process.argv[1];
		// SAFETY: simulating a runtime where argv[1] is absent; resolveCliEntry's `?? ""` fallback.
		process.argv.splice(1);
		try {
			const calls: Array<{ file: string; args: string[] }> = [];
			const spawn = ((file: string, args: string[]) => {
				calls.push({ file, args });
				return fakeChild();
			}) satisfies SpawnFn;
			runSessionEndJobs(makeCtx(), activePlan, { spawn, execPath: "/node" });
			expect(calls.length).toBeGreaterThan(0);
			expect(calls[0]?.args.some((a) => a.endsWith("index.js"))).toBe(true);
		} finally {
			if (original !== undefined) process.argv[1] = original;
		}
	});

	it("falls back to nodeSpawn/process.execPath/resolveCliEntry when no deps are given", async () => {
		const { spawn: mockedNodeSpawn } = await import("node:child_process");
		vi.mocked(mockedNodeSpawn).mockClear();
		const originalArgv = [...process.argv];
		process.argv.splice(1, 1, "/repo/dist/harness/server.js");
		try {
			runSessionEndJobs(makeCtx(), activePlan, {});
			expect(vi.mocked(mockedNodeSpawn)).toHaveBeenCalledTimes(2);
			expect(vi.mocked(mockedNodeSpawn)).toHaveBeenNthCalledWith(
				1,
				"taskpolicy",
				["-b", process.execPath, "--max-old-space-size=128", "/repo/dist/harness/background-job-main.js", "recurrence-scan", process.execPath, "/repo/dist/index.js", "recurrence", "scan", "--record"],
				{ cwd: "/repo", detached: true, stdio: "ignore" },
			);
			expect(vi.mocked(mockedNodeSpawn)).toHaveBeenNthCalledWith(
				2,
				"taskpolicy",
				["-b", process.execPath, "--max-old-space-size=128", "/repo/dist/harness/background-job-main.js", "coverage-ratchet", process.execPath, "/repo/dist/index.js", "coverage", "check", "--update-baseline"],
				{ cwd: "/repo", detached: true, stdio: "ignore" },
			);
		} finally {
			process.argv.splice(0, process.argv.length, ...originalArgv);
		}
	});
});

describe("runSessionEndResourcePlan — os fallback branches", () => {
	it("falls back to os.cpus().length when availableParallelism is unavailable", () => {
		const original = Object.getOwnPropertyDescriptor(os, "availableParallelism");
		Object.defineProperty(os, "availableParallelism", {
			value: undefined,
			configurable: true,
		});
		try {
			const ctx = makeCtx();
			const plan = runSessionEndResourcePlan(ctx, sessionEnd());
			expect(plan).not.toBeNull();
		} finally {
			if (original) Object.defineProperty(os, "availableParallelism", original);
		}
	});

	it("defaults load1 to 0 when os.loadavg() returns an empty array", () => {
		const original = Object.getOwnPropertyDescriptor(os, "loadavg");
		Object.defineProperty(os, "loadavg", {
			value: () => [],
			configurable: true,
			writable: true,
		});
		try {
			const ctx = makeCtx();
			const plan = runSessionEndResourcePlan(ctx, sessionEnd());
			expect(plan).not.toBeNull();
		} finally {
			if (original) Object.defineProperty(os, "loadavg", original);
		}
	});
});
