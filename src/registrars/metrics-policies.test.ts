import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMetricsPolicyCommands } from "./metrics-policies.js";
import { metricsPoliciesEvaluateCommand, metricsPoliciesExportCommand, metricsPoliciesInspectCommand } from "../commands/metrics-policies.js";

vi.mock("../commands/metrics-policies.js", () => ({ metricsPoliciesEvaluateCommand: vi.fn(), metricsPoliciesExportCommand: vi.fn(), metricsPoliciesInspectCommand: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function program() {
	const root = new Command().exitOverride();
	const metrics = root.command("metrics").option("--cwd <path>").option("--json");
	registerMetricsPolicyCommands(metrics);
	return root;
}
describe("metrics policies registration", () => {
	it("forwards inherited output and root options to optional-profile evaluation", async () => {
		await program().parseAsync(["node", "cli", "metrics", "--cwd", "/foreign", "--json", "policies", "evaluate"]);
		expect(metricsPoliciesEvaluateCommand).toHaveBeenCalledWith(undefined, expect.objectContaining({ cwd: "/foreign", json: true }));
	});
	it("forwards profile position and full output", async () => {
		await program().parseAsync(["node", "cli", "metrics", "policies", "inspect", "team.json", "--full"]);
		expect(metricsPoliciesInspectCommand).toHaveBeenCalledWith("team.json", expect.objectContaining({ full: true }));
	});
	it("exports under the requested stable profile identity", async () => {
		await program().parseAsync(["node", "cli", "metrics", "policies", "export", "--id", "team.ts", "--json"]);
		expect(metricsPoliciesExportCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "team.ts", json: true }));
	});
});
