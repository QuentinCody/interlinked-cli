import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { metricsComplexityCommand } from "../commands/metrics-complexity.js";
import { metricsScoreCommand } from "../commands/metrics-score.js";
import { metricsSplitPlanCommand } from "../commands/metrics-split-plan.js";
import { registerMetricsCommands } from "./metrics.js";

// Only the three subcommands under test are mocked — `metrics.ts`'s own bare
// action and the coupling/arch/rework siblings are untouched by these tests.
vi.mock("../commands/metrics-complexity.js", () => ({
	metricsComplexityCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../commands/metrics-split-plan.js", () => ({
	metricsSplitPlanCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../commands/metrics-score.js", () => ({
	metricsScoreCommand: vi.fn(),
}));

describe("registerMetricsCommands", () => {
	it("merges the parent `metrics --cwd` option into metricsComplexityCommand's opts", async () => {
		vi.mocked(metricsComplexityCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerMetricsCommands(program);
		await program.parseAsync([
			"node",
			"interlinked",
			"metrics",
			"--cwd",
			"/parent/root",
			"complexity",
			"--top",
			"10",
		]);
		const [calledOpts] = vi.mocked(metricsComplexityCommand).mock.calls[0]!;
		expect(calledOpts.cwd).toBe("/parent/root");
		expect(calledOpts.top).toBe("10");
	});

	it("wires `metrics split-plan <file>` to metricsSplitPlanCommand, passing the file argument", async () => {
		vi.mocked(metricsSplitPlanCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerMetricsCommands(program);
		await program.parseAsync(["node", "interlinked", "metrics", "split-plan", "src/foo.ts"]);
		const [calledOpts] = vi.mocked(metricsSplitPlanCommand).mock.calls[0]!;
		expect(calledOpts.file).toBe("src/foo.ts");
	});

	it("merges the parent `metrics --cwd` option into metricsScoreCommand's opts", async () => {
		vi.mocked(metricsScoreCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerMetricsCommands(program);
		await program.parseAsync([
			"node",
			"interlinked",
			"metrics",
			"--cwd",
			"/parent/root",
			"score",
			"--short",
		]);
		const [calledOpts] = vi.mocked(metricsScoreCommand).mock.calls[0]!;
		expect(calledOpts.cwd).toBe("/parent/root");
		expect(calledOpts.short).toBe(true);
	});
});
