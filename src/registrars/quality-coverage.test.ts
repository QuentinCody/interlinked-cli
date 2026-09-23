import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCoverageCommands } from "./quality-coverage.js";

const coverageCheckCommand = vi.fn();
const coverageBaselineCommand = vi.fn();
const coverageMetricsCommand = vi.fn();
const coverageE2eIdentityCommand = vi.fn();
const coverageLaneStatusCommand = vi.fn();

vi.mock("../commands/coverage-e2e.js", () => ({
    coverageE2eIdentityCommand: (...args: unknown[]) => coverageE2eIdentityCommand(...args),
    coverageLaneStatusCommand: (...args: unknown[]) => coverageLaneStatusCommand(...args),
}));

vi.mock("../commands/coverage.js", () => ({
	coverageCheckCommand: (...args: unknown[]) => coverageCheckCommand(...args),
	coverageBaselineCommand: (...args: unknown[]) => coverageBaselineCommand(...args),
}));
vi.mock("../commands/coverage-metrics.js", () => ({
	coverageMetricsCommand: (...args: unknown[]) => coverageMetricsCommand(...args),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride();
	registerCoverageCommands(program);
	return program;
}

function coverage(program: Command): Command {
	const cmd = program.commands.find((c) => c.name() === "coverage");
	if (!cmd) throw new Error("coverage command not registered");
	return cmd;
}

beforeEach(() => {
	coverageCheckCommand.mockReset();
	coverageBaselineCommand.mockReset();
	coverageMetricsCommand.mockReset();
    coverageE2eIdentityCommand.mockReset();
    coverageLaneStatusCommand.mockReset();
});

describe("registerCoverageCommands — positive (must fire)", () => {
    it("forwards e2e moves, repeated mappings, retirements and lane status", async () => {
        await build().parseAsync(["coverage", "move", "old.ts", "new.ts", "--lane", "e2e", "--map", "A=B", "--map", "C=D", "--base", "origin/main"], { from: "user" });
        expect(coverageE2eIdentityCommand).toHaveBeenLastCalledWith({ lane: "e2e", map: ["A=B", "C=D"], base: "origin/main" }, { old: "old.ts", next: "new.ts" });
        await build().parseAsync(["coverage", "retire", "removed.ts", "--lane", "e2e"], { from: "user" });
        expect(coverageE2eIdentityCommand).toHaveBeenLastCalledWith({ lane: "e2e" }, { retire: "removed.ts" });
        await build().parseAsync(["coverage", "status", "--cwd", "/repo", "--json"], { from: "user" });
        expect(coverageLaneStatusCommand).toHaveBeenCalledWith({ cwd: "/repo", json: true });
    });
    it("forwards e2e check mappings and baseline selection", async () => {
        await build().parseAsync(["coverage", "check", "--lane", "e2e", "--map", "A=B", "--map", "C=D", "--require-measured"], { from: "user" });
        expect(coverageCheckCommand).toHaveBeenCalledWith({ lane: "e2e", map: ["A=B", "C=D"], requireMeasured: true });
        await build().parseAsync(["coverage", "baseline", "--lane", "e2e"], { from: "user" });
        expect(coverageBaselineCommand).toHaveBeenCalledWith({ lane: "e2e" });
    });
	it("P1: registers check (default), metrics, and baseline under `coverage`", () => {
		const names = coverage(build()).commands.map((c) => c.name()).sort();
		expect(names).toEqual(["baseline", "check", "metrics", "move", "retire", "status"]);
	});

	it("P2: `coverage metrics` forwards every documented option to coverageMetricsCommand", async () => {
		await build().parseAsync(
			["coverage", "metrics", "--metric", "branches", "--under", "80", "--top", "3", "--report", "r.json", "--cwd", "/x", "--json"],
			{ from: "user" },
		);
		expect(coverageMetricsCommand).toHaveBeenCalledWith({
			metric: "branches",
			under: "80",
			top: "3",
			report: "r.json",
			cwd: "/x",
			json: true,
		});
	});

	it("P3: `coverage` with no subcommand still runs the check (default subcommand)", async () => {
		await build().parseAsync(["coverage"], { from: "user" });
		expect(coverageCheckCommand).toHaveBeenCalledTimes(1);
		expect(coverageCheckCommand).toHaveBeenCalledWith({});
		expect(coverageMetricsCommand).not.toHaveBeenCalled();
	});
});

describe("registerCoverageCommands — negative (must not fire)", () => {
	it("N1: `coverage metrics` never reaches the check or baseline implementations", async () => {
		await build().parseAsync(["coverage", "metrics"], { from: "user" });
		expect(coverageMetricsCommand).toHaveBeenCalledWith({});
		expect(coverageCheckCommand).not.toHaveBeenCalled();
		expect(coverageBaselineCommand).not.toHaveBeenCalled();
	});

	it("N2: an unknown option on `coverage metrics` is refused by commander", async () => {
		await expect(build().parseAsync(["coverage", "metrics", "--bogus"], { from: "user" })).rejects.toThrow();
		expect(coverageMetricsCommand).not.toHaveBeenCalled();
	});
});
