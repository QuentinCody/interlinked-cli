import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { metricsComplexityCommand } from "../commands/metrics-complexity.js";
import { metricsJitCommand } from "../commands/metrics-jit.js";
import { metricsScoreCommand } from "../commands/metrics-score.js";
import { metricsDiagnosticsCommand } from "../commands/metrics-diagnostics.js";
import { metricsDiagnosticsCompareCommand } from "../commands/metrics-diagnostics-compare.js";
import { metricsSplitPlanCommand } from "../commands/metrics-split-plan.js";
import { registerMetricsCommands } from "./metrics.js";

// Only the subcommands under test are mocked — `metrics.ts`'s own bare
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
vi.mock("../commands/metrics-jit.js", () => ({ metricsJitCommand: vi.fn() }));
vi.mock("../commands/metrics-diagnostics.js", () => ({ metricsDiagnosticsCommand: vi.fn() }));
vi.mock("../commands/metrics-diagnostics-compare.js", () => ({ metricsDiagnosticsCompareCommand: vi.fn() }));

describe("registerMetricsCommands", () => {
    it("routes commit risk with a ref, calibration size, and inherited scope", async () => {
        vi.mocked(metricsJitCommand).mockClear();
        const program = new Command();
        registerMetricsCommands(program);
        await program.parseAsync(["node", "interlinked", "metrics", "--cwd", "/parent/root", "jit", "HEAD~1", "--calibrate", "25", "--json"]);
        expect(metricsJitCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            cwd: "/parent/root", ref: "HEAD~1", calibrate: "25", json: true,
        }));
    });
    it("routes staged commit risk with its message and no ref", async () => {
        vi.mocked(metricsJitCommand).mockClear();
        const program = new Command();
        registerMetricsCommands(program);
        await program.parseAsync(["node", "interlinked", "metrics", "jit", "--staged", "--message", "fix: handle loopback", "--short"]);
        expect(metricsJitCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            ref: undefined, staged: true, message: "fix: handle loopback", short: true,
        }));
    });
    it("routes saved diagnostic comparison without performing a census", async () => {
        const program = new Command();
        registerMetricsCommands(program);
        await program.parseAsync(["node", "interlinked", "metrics", "diagnostics", "compare", "before.json", "after.json", "--json"]);
        expect(metricsDiagnosticsCompareCommand).toHaveBeenCalledWith("before.json", "after.json", expect.objectContaining({ json: true }));
    });
    it("routes diagnostics with inherited scope and JSON output", async () => {
        const program = new Command();
        registerMetricsCommands(program);
        await program.parseAsync(["node", "interlinked", "metrics", "--cwd", "/selected/root", "diagnostics", "--json"]);
        expect(metricsDiagnosticsCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/selected/root", json: true }));
    });
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
