import { execFileSync } from "node:child_process";
import { Command, Option } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../cli-program.js";
import { completionsCommand } from "./completions.js";

let logs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

async function script(shell: string, program?: Command): Promise<string> {
	logs.mockClear();
	await completionsCommand(shell, program);
	return String(logs.mock.calls[0]?.[0]);
}

function fixture(): Command {
	const program = new Command("interlinked").version("test");
	program.command("hidden", { hidden: true }).command("also-hidden");
	program.command("legacy").description("Deprecated compatibility command");
	const group = program.command("group").alias("g").option("--parent <value>");
	group.command("leaf").option("--enabled").option("--count <n>")
		.addOption(new Option("--secret-flag").hideHelp());
	program.command("plain").option("--other");
	return program;
}

async function bashComplete(words: string[], program = fixture()): Promise<string[]> {
	const generated = await script("bash", program);
	// Positional arguments are inert fixture input. Only the generated completion
	// function runs. No CLI handlers or daemon operations are invoked.
	const runner = generated + '\nCOMP_WORDS=("$@")\nCOMP_CWORD=$(($# - 1))\n_interlinked_completions\nprintf \'%s\\n\' "${COMPREPLY[@]}"';
	return execFileSync("bash", ["-c", runner, "completion-fixture", ...words], { encoding: "utf8" })
		.trim().split("\n").filter(Boolean);
}

describe("completion scripts derived from active Commander metadata", () => {
	it.each(["bash", "zsh", "fish"])("renders visible commands and flags for %s", async (shell) => {
		const generated = await script(shell, fixture());
		for (const expected of ["group", "legacy", "--parent", "--count"]) expect(generated).toContain(expected);
		expect(generated).not.toContain("also-hidden");
		expect(generated).not.toContain("--secret-flag");
	});

	it.each(["bash", "zsh"])("passes %s syntax validation with quoted names", async (shell) => {
		const program = fixture();
		program.command("quoted'command");
		const generated = await script(shell, program);
		expect(() => execFileSync(shell, ["-n"], { input: generated })).not.toThrow();
	});

	it("registers zsh completion when evaluated using documented setup", async () => {
		const generated = await script("zsh", fixture());
		const result = execFileSync("zsh", ["-f", "-c", 'compdef() { print -r -- "$*"; }\n' + generated], { encoding: "utf8" });
		expect(result.trim()).toBe("_interlinked interlinked");
	});

	it("executes zsh nested completion without changing its shell PATH", async () => {
		const generated = await script("zsh", fixture());
		const runner = 'compdef() { :; }\ncompadd() { shift; print -rl -- "$@"; }\n' + generated
			+ '\nwords=(interlinked g leaf --en)\nCURRENT=4\noriginal_path="$PATH"\n_interlinked\n[[ "$PATH" == "$original_path" ]]';
		const result = execFileSync("zsh", ["-f", "-c", runner], { encoding: "utf8" });
		expect(result.split("\n")).toContain("--enabled");
	});

	it("retains fish source setup and case-insensitive shell selection", async () => {
		expect(await script("fish", fixture())).toContain("complete -c interlinked -f");
		expect(await script("BASH", fixture())).toBe(await script("bash", fixture()));
	});

	it("rejects unsupported shells without printing a script", async () => {
		await completionsCommand("powershell", fixture());
		expect(logs).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith("Unknown shell: powershell. Supported: bash, zsh, fish");
	});

	it("completes nested commands and inherited plus local flags", async () => {
		expect(await bashComplete(["interlinked", "group", ""])).toContain("leaf");
		const flags = await bashComplete(["interlinked", "group", "leaf", "--"]);
		expect(flags).toEqual(expect.arrayContaining(["--parent", "--enabled", "--count", "--help", "--version"]));
		expect(flags).not.toContain("--other");
		expect(flags).not.toContain("--secret-flag");
	});

	it("resolves aliases and skips required option values matching a child command", async () => {
		expect(await bashComplete(["interlinked", "g", "leaf", "--en"])).toEqual(["--enabled"]);
		expect(await bashComplete(["interlinked", "group", "--parent", "leaf", ""])).toContain("leaf");
	});

	it("covers every visible top-level command from real registration", async () => {
		const program = buildProgram("test");
		const candidates = await bashComplete(["interlinked", ""], program);
		for (const command of program.createHelp().visibleCommands(program)) expect(candidates).toContain(command.name());
		expect(candidates).toContain("reload");
		expect(candidates).toContain("upgrade");
	});

	it("covers real multi-level paths and command-specific flags", async () => {
		const program = buildProgram("test");
		expect(await bashComplete(["interlinked", "harness", "coverage", ""], program)).toContain("verify");
		expect(await bashComplete(["interlinked", "init", "--"], program)).toContain("--dry-run");
	});

	it("contains every visible registered nested path and its visible option flags", async () => {
		const program = buildProgram("test");
		const generated = await script("bash", program);
		function visit(command: Command, path: string): void {
			expect(generated).toContain(`'${path}') candidates=(`);
			for (const option of command.createHelp().visibleOptions(command)) {
				for (const flag of [option.long, option.short].filter(Boolean)) expect(generated).toContain(`'${flag}'`);
			}
			for (const child of command.createHelp().visibleCommands(command)) {
				visit(child, path ? `${path}/${child.name()}` : child.name());
			}
		}
		visit(program, "");
	});

	it("preserves supported shell choices and direct API registry fallback", async () => {
		expect(await bashComplete(["interlinked", "completions", ""], buildProgram("test")))
			.toEqual(expect.arrayContaining(["bash", "zsh", "fish"]));
		expect(await script("bash")).toContain("reload");
	});
});
