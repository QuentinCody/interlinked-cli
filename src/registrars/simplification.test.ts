import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { simplifyCommand, simplifyStatusCommand } from "../commands/simplify.js";
import { registerSimplifyCommands } from "./simplification.js";

// Mock the action layer (a different module from the registrar SUT) so
// parsing exercises the `.action(...)` wiring — including the dynamic
// `import("../commands/simplify.js")` inside runSimplify/runSimplifyStatus —
// without walking a real repository.
vi.mock("../commands/simplify.js", () => ({
	simplifyCommand: vi.fn(),
	simplifyStatusCommand: vi.fn(),
}));

describe("registerSimplifyCommands", () => {
	// test-contract: public-api — the namespace exposes three report depths and
	// the local recorded-run view without changing the top-level audit command
	it("registers scan, review, audit, and status", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		expect(simplify?.commands.map((command) => command.name())).toEqual([
			"scan",
			"review",
			"audit",
			"status",
		]);
	});

	// test-contract: public-api — review and audit advertise the git-scope and
	// explicit non-submitting deep-handoff switches
	it("registers scope and handoff options", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		const review = simplify?.commands.find((command) => command.name() === "review");
		const audit = simplify?.commands.find((command) => command.name() === "audit");
		expect(review?.options.map((option) => option.long)).toContain("--range");
		expect(audit?.options.map((option) => option.long)).toContain("--deep-handoff");
		expect(review?.options.map((option) => option.long)).toContain("--deep-handoff");
	});

	// test-contract: public-api — persistence is consistent and opt-in for
	// every local report execution while status remains a read-only view
	it("registers record on all report commands but not status", () => {
		const program = new Command();
		registerSimplifyCommands(program);
		const simplify = program.commands.find((command) => command.name() === "simplify");
		for (const name of ["scan", "review", "audit"]) {
			const command = simplify?.commands.find((candidate) => candidate.name() === name);
			expect(command?.options.map((option) => option.long)).toContain("--record");
		}
		const status = simplify?.commands.find((command) => command.name() === "status");
		expect(status?.options.map((option) => option.long)).not.toContain("--record");
		expect(status?.options.map((option) => option.long)).toEqual(["--cwd", "--json"]);
	});

	// test-contract: action wiring — each report subcommand forwards its own
	// parsed options to simplifyCommand with the matching depth name, and the
	// command's exitCode becomes the process exitCode (dynamic import of the
	// action layer resolves through runSimplify).
	it.each(["scan", "review", "audit"] as const)(
		"runs simplifyCommand(%s, options) and adopts its exit code",
		async (depth) => {
			vi.mocked(simplifyCommand).mockReset().mockResolvedValue(7);
			const program = new Command();
			program.exitOverride();
			registerSimplifyCommands(program);
			process.exitCode = undefined;
			await program.parseAsync(["node", "interlinked", "simplify", depth, "--json"]);
			expect(vi.mocked(simplifyCommand)).toHaveBeenCalledWith(
				depth,
				expect.objectContaining({ json: true }),
			);
			expect(process.exitCode).toBe(7);
		},
	);

	// test-contract: action wiring — status forwards its parsed options to
	// simplifyStatusCommand (a synchronous, non-report call) and its return
	// value becomes the process exitCode.
	it("runs simplifyStatusCommand(options) and adopts its exit code", async () => {
		vi.mocked(simplifyStatusCommand).mockReset().mockReturnValue(3);
		const program = new Command();
		program.exitOverride();
		registerSimplifyCommands(program);
		process.exitCode = undefined;
		await program.parseAsync(["node", "interlinked", "simplify", "status", "--cwd", "/tmp/repo"]);
		expect(vi.mocked(simplifyStatusCommand)).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/tmp/repo" }),
		);
		expect(process.exitCode).toBe(3);
	});
});
