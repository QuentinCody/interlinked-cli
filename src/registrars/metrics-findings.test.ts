import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerFindingCommands } from "./metrics-findings.js";
import { findingAction } from "../commands/metrics-findings.js";

vi.mock("../commands/metrics-findings.js", () => ({ findingAction: vi.fn().mockResolvedValue(0) }));

it("exposes explicit inference separately from local preparation and review", () => {
	const decisions = new Command("decisions");
	registerFindingCommands(decisions);
	const group = decisions.commands.find(command => command.name() === "findings");
	expect(group?.commands.map(command => command.name())).toEqual(["catalog", "discover", "prepare", "questions", "plan", "assess", "show", "labels", "review"]);
	expect(group?.commands.find(command => command.name() === "assess")?.options.map(option => option.long)).toEqual(expect.arrayContaining(["--max-calls", "--max-usd", "--dry-run", "--output", "--json", "--short", "--full"]));
});

it("forwards frozen-profile, selection and inherited scope through actual Commander parsing", async () => {
	vi.mocked(findingAction).mockClear();
	const metrics = new Command("metrics").option("--cwd <path>").option("--json");
	registerFindingCommands(metrics.command("decisions"));
	await metrics.parseAsync(["--cwd", "/selected/root", "--json", "decisions", "findings", "plan", "bundle.json", "--question-profile", "questions.json", "--select", "a,b", "--output", "plan.json"], { from: "user" });
	expect(findingAction).toHaveBeenCalledExactlyOnceWith("plan", "bundle.json", expect.objectContaining({ cwd: "/selected/root", json: true, questionProfile: "questions.json", select: "a,b", output: "plan.json" }));
});

it("forwards explicit estimate allowance, maximum spend, approval and saved reuse", async () => {
	vi.mocked(findingAction).mockClear();
	const decisions = new Command("decisions");
	registerFindingCommands(decisions);
	await decisions.parseAsync(["findings", "assess", "plan.json", "--estimate-allowance-usd", "1", "--max-usd", "0.5", "--approve-plan", "approved-id", "--reuse", "saved.json", "--output", "run.json"], { from: "user" });
	expect(findingAction).toHaveBeenCalledExactlyOnceWith("assess", "plan.json", expect.objectContaining({ estimateAllowanceUsd: "1", maxUsd: "0.5", approvePlan: "approved-id", reuse: "saved.json", output: "run.json" }));
});
