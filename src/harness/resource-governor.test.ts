import { describe, expect, it } from "vitest";
import {
	backgroundPrefix,
	type GovernorInput,
	planResources,
} from "./resource-governor.js";

function input(overrides: Partial<GovernorInput> = {}): GovernorInput {
	return {
		cores: 10,
		load1: 0,
		agentCount: 1,
		platform: "darwin",
		memory: { totalBytes: 48 * 1024 ** 3, availableBytes: 32 * 1024 ** 3 },
		...overrides,
	};
}

describe("backgroundPrefix", () => {
	it("uses taskpolicy -b on macOS", () => {
		expect(backgroundPrefix("darwin")).toBe("taskpolicy -b ");
	});
	it("uses nice on Linux", () => {
		expect(backgroundPrefix("linux")).toBe("nice -n 19 ");
	});
	it("is empty (no portable equivalent) elsewhere", () => {
		expect(backgroundPrefix("win32")).toBe("");
	});
});

describe("planResources — memory admission", () => {
	it("defers when the caller cannot supply a memory reading", () => {
		const reading = input();
		delete reading.memory;
		expect(planResources(reading)).toMatchObject({ defer: true, maxJobs: 0 });
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid total memory %s", totalBytes => {
		expect(planResources(input({ memory: { totalBytes, availableBytes: 4 * 1024 ** 3 } })).defer).toBe(true);
	});
	it("admits one worker on an 8 GiB machine while preserving host headroom", () => {
		const result = planResources(input({ cores: 16, memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 } }));
		expect(result).toMatchObject({ maxJobs: 1, defer: false });
	});
	it("caps a 16 GiB machine by memory even when its CPU count is high", () => {
		const result = planResources(input({ cores: 32, memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 } }));
		expect(result).toMatchObject({ maxJobs: 3, defer: false });
	});
	it("defers on an 8 GiB machine when available memory cannot fit a worker and reserve", () => {
		const result = planResources(input({ memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 1.5 * 1024 ** 3 } }));
		expect(result).toMatchObject({ maxJobs: 0, defer: true });
		expect(result.reason).toContain("memory");
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not admit background work with invalid available memory %s", availableBytes => {
		expect(planResources(input({ memory: { totalBytes: 8 * 1024 ** 3, availableBytes } })).defer).toBe(true);
	});
});

describe("planResources — job cap", () => {
	it.each([Number.NaN, Number.POSITIVE_INFINITY])("uses a single core when the CPU reading is invalid: %s", cores => {
		expect(planResources(input({ cores })).maxJobs).toBe(1);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY])("uses one agent when the agent count is invalid: %s", agentCount => {
		expect(planResources(input({ agentCount })).maxJobs).toBe(5);
	});
	it.each([0.5, 1.9])("normalizes fractional worker limit %s to an integer", max_jobs => {
		expect(planResources(input({ config: { max_jobs } })).maxJobs).toBe(1);
	});
	it("ignores a non-finite worker limit and uses the CPU default", () => {
		expect(planResources(input({ config: { max_jobs: Number.POSITIVE_INFINITY } })).maxJobs).toBe(5);
	});
	it("caps at ~half the cores on a quiet machine", () => {
		const p = planResources(input({ cores: 10, load1: 0 }));
		expect(p.maxJobs).toBe(5);
		expect(p.defer).toBe(false);
		expect(p.background).toBe(true);
		expect(p.commandPrefix).toBe("taskpolicy -b ");
	});

	it("honors an explicit max_jobs config", () => {
		const p = planResources(input({ cores: 16, config: { max_jobs: 3 } }));
		expect(p.maxJobs).toBe(3);
	});

	it("never returns fewer than 1 job on a quiet single-core box", () => {
		const p = planResources(input({ cores: 1, load1: 0 }));
		expect(p.maxJobs).toBe(1);
	});
});

describe("planResources — load sensing", () => {
	it("halves jobs when per-core load crosses the load threshold", () => {
		// 10 cores, load 8 → per-core 0.8 ≥ 0.7 → base 5 halved to 2.
		const p = planResources(input({ cores: 10, load1: 8 }));
		expect(p.maxJobs).toBe(2);
		expect(p.defer).toBe(false);
	});

	it("defers the heavy lane entirely when load is very high", () => {
		// 10 cores, load 16 → per-core 1.6 ≥ 1.5 → defer.
		const p = planResources(input({ cores: 10, load1: 16 }));
		expect(p.defer).toBe(true);
		expect(p.maxJobs).toBe(0);
		expect(p.reason).toContain("deferring");
	});

	it("treats unknown load (0) as a quiet machine (fail-open)", () => {
		const p = planResources(input({ cores: 8, load1: 0 }));
		expect(p.defer).toBe(false);
		expect(p.maxJobs).toBe(4);
	});
});

describe("planResources — agent sharing + CPU budget", () => {
	it("shares cores across concurrent agents", () => {
		// base 5 / 2 agents → 2.
		const p = planResources(input({ cores: 10, agentCount: 2 }));
		expect(p.maxJobs).toBe(2);
		expect(p.reason).toContain("shared across 2 agents");
	});

	it("caps jobs by the CPU-second budget", () => {
		// base 5, but budget 40s / est 20s per job → 2 jobs.
		const p = planResources(
			input({ cores: 10, estJobWallSec: 20, config: { cpu_budget_sec: 40 } }),
		);
		expect(p.maxJobs).toBe(2);
		expect(p.reason).toContain("CPU-budget");
	});

	it("ignores the CPU budget when no per-job estimate is given", () => {
		const p = planResources(input({ cores: 10, config: { cpu_budget_sec: 40 } }));
		expect(p.maxJobs).toBe(5);
	});
});
