import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import { registerRelationCommands } from "./metrics-relations.js";
import { relationsAction } from "../commands/metrics-relations.js";
import { registerMetricsCommands } from "./metrics.js";

vi.mock("../commands/metrics-relations.js", () => ({ relationsAction: vi.fn(async () => 0) }));
afterEach(() => { vi.clearAllMocks(); process.exitCode = 0; });
function program(): Command { const command = new Command(); registerRelationCommands(command); return command; }

test("prepare routes source, policy and pre-change history boundaries independently", async () => {
    await program().parseAsync(["relations", "prepare", "--revision", "after", "--policy-revision", "policy", "--history-tip", "before", "--since", "2026-01-01T00:00:00Z", "--until", "2026-10-01T00:00:00Z", "--max-history", "123", "--engines", "engines.json"], { from: "user" });
    expect(relationsAction).toHaveBeenCalledWith("prepare", undefined, expect.objectContaining({ revision: "after", policyRevision: "policy", historyTip: "before", maxHistory: "123", engines: "engines.json" }));
});
test("compare supports both paired-plan creation and argument-free paired reporting", async () => {
    await program().parseAsync(["relations", "compare", "before.json", "--after", "after.json", "--output-plan", "paired.json"], { from: "user" });
    expect(relationsAction).toHaveBeenLastCalledWith("compare", "before.json", expect.objectContaining({ after: "after.json", outputPlan: "paired.json" }));
    await program().parseAsync(["relations", "compare", "--assessment-run", "paired-run.json"], { from: "user" });
    expect(relationsAction).toHaveBeenLastCalledWith("compare", undefined, expect.objectContaining({ assessmentRun: "paired-run.json" }));
});
test("handler rejects mixed compare modes before opening an input or invoking a model", async () => {
    const actual = await vi.importActual<typeof import("../commands/metrics-relations.js")>("../commands/metrics-relations.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
        expect(await actual.relationsAction("compare", "missing-before.json", { assessmentRun: "missing-paired.json" })).toBe(1);
        expect(String(error.mock.calls[0]![0])).toContain("exclusive");
    } finally { error.mockRestore(); }
});

test.each(["prepare", "assess"])("%s inherits --cwd consumed by the actual metrics parent", async action => {
    const root = new Command();
    registerMetricsCommands(root);
    const args = ["metrics", "decisions", "relations", action, ...(action === "assess" ? ["input"] : []), "--cwd", "/isolated/source", "--json"];
    await root.parseAsync(args, { from: "user" });
    expect(relationsAction).toHaveBeenLastCalledWith(action, action === "assess" ? "input" : undefined, expect.objectContaining({ cwd: "/isolated/source", json: true }));
});
