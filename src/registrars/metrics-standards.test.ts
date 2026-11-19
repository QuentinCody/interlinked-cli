import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { metricsStandardsCommand } from "../commands/metrics-standards.js";
import { registerMetricsStandardsCommands } from "./metrics-standards.js";

vi.mock("../commands/metrics-standards.js", () => ({ metricsStandardsCommand: vi.fn() }));

it.each([
	["metrics", "--cwd", "/foreign", "--json", "standards", "--profile", "dmmulroy-typescript", "--scope", "product"],
	["metrics", "standards", "--cwd", "/foreign", "--json", "--profile", "dmmulroy-typescript", "--scope", "product"],
])("forwards inherited and leaf selectors through actual Commander parsing %j", async (...args) => {
	vi.mocked(metricsStandardsCommand).mockClear();
	const program = new Command(), metrics = program.command("metrics").option("--cwd <path>").option("--json").option("--short").option("--full");
	registerMetricsStandardsCommands(metrics);
	await program.parseAsync(args, { from: "user" });
	expect(metricsStandardsCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: "/foreign", json: true, profile: "dmmulroy-typescript", scope: "product" }));
});

it.each(["--short", "--full"])("accepts %s locally", async flag => {
	vi.mocked(metricsStandardsCommand).mockClear();
	const program = new Command(), metrics = program.command("metrics");
	registerMetricsStandardsCommands(metrics);
	await program.parseAsync(["metrics", "standards", flag], { from: "user" });
	expect(metricsStandardsCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ [flag.slice(2)]: true }));
});
