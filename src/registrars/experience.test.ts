// Experience registrar — pins the `interlinked experience` command surface so
// the subcommand names the docs reference stay wired, and drives each `.action`
// body through `parseAsync` so the option→argument→exit-code wiring is pinned
// too (the action bodies are the only code this module executes at run time).

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExperienceCommands } from "./experience.js";

// Each action returns a DISTINCT exit code so a test can tell which one the
// registrar wired into `process.exitCode` — not merely that a mock was called.
const experienceExportAction = vi.fn((..._args: unknown[]) => 21);
const experienceAnalyzeAction = vi.fn((..._args: unknown[]) => 22);
const experienceListAction = vi.fn((..._args: unknown[]) => 23);

vi.mock("../commands/experience.js", () => ({
	experienceExportAction: (...args: unknown[]) => experienceExportAction(...args),
	experienceAnalyzeAction: (...args: unknown[]) => experienceAnalyzeAction(...args),
	experienceListAction: (...args: unknown[]) => experienceListAction(...args),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride();
	registerExperienceCommands(program);
	return program;
}

let priorExitCode: number | string | undefined;
beforeEach(() => {
	vi.clearAllMocks();
	priorExitCode = process.exitCode;
});
afterEach(() => {
	process.exitCode = priorExitCode;
});

describe("registerExperienceCommands", () => {
	it("registers experience with export + analyze + list subcommands", () => {
		const program = new Command();
		registerExperienceCommands(program);
		const experience = program.commands.find((cmd) => cmd.name() === "experience");
		expect(experience).toBeDefined();
		const subs = (experience?.commands ?? []).map((cmd) => cmd.name()).sort();
		expect(subs).toEqual(["analyze", "export", "list"]);
	});
});

describe("experience export — action wiring", () => {
	it("forwards every option through its real flag name and adopts the action's exit code", async () => {
		const program = build();
		await program.parseAsync(
			[
				"experience",
				"export",
				"--session",
				"s1",
				"--format",
				"letta",
				"--out",
				"/tmp/s1.letta.jsonl",
				"--truncate",
				"0",
				"--json",
			],
			{ from: "user" },
		);
		expect(experienceExportAction).toHaveBeenCalledWith({
			session: "s1",
			format: "letta",
			out: "/tmp/s1.letta.jsonl",
			truncate: "0",
			json: true,
		});
		expect(process.exitCode).toBe(21);
	});

	it("passes only --session when the optional flags are omitted", async () => {
		const program = build();
		await program.parseAsync(["experience", "export", "--session", "s2"], { from: "user" });
		expect(experienceExportAction).toHaveBeenCalledWith({ session: "s2" });
		expect(process.exitCode).toBe(21);
	});
});

describe("experience analyze — action wiring", () => {
	it("forwards --session/--json and adopts the action's exit code", async () => {
		const program = build();
		await program.parseAsync(["experience", "analyze", "--session", "s3", "--json"], {
			from: "user",
		});
		expect(experienceAnalyzeAction).toHaveBeenCalledWith({ session: "s3", json: true });
		expect(process.exitCode).toBe(22);
	});
});

describe("experience list — action wiring", () => {
	it("forwards --limit/--json and adopts the action's exit code", async () => {
		const program = build();
		await program.parseAsync(["experience", "list", "--limit", "3", "--json"], { from: "user" });
		expect(experienceListAction).toHaveBeenCalledWith({ limit: "3", json: true });
		expect(process.exitCode).toBe(23);
	});
});
