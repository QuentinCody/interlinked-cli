import { parseWire, wireString } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionsCommand } from "./completions.js";

describe("completionsCommand", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.exitCode = 0;
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = 0;
	});

	// SAFETY: console.log is always invoked with a single string argument by
	// every code path under test (generateBashCompletions/Zsh/Fish all return
	// and log a string); this helper centralizes the one cast instead of
	// repeating it at every call site.
	function getLoggedOutput(): string {
		return parseWire(logSpy.mock.calls[0][0], wireString, "test JSON value");
	}

	it("prints bash completions for 'bash'", async () => {
		await completionsCommand("bash");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("# interlinked bash completion"));
		expect(getLoggedOutput()).toContain("complete -F _interlinked_completions interlinked");
	});

	it("prints zsh completions for 'zsh'", async () => {
		await completionsCommand("zsh");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#compdef interlinked"));
		expect(getLoggedOutput()).toContain('_interlinked "$@"');
	});

	it("prints fish completions for 'fish'", async () => {
		await completionsCommand("fish");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("# interlinked fish completion"));
		expect(getLoggedOutput()).toContain("complete -c interlinked -f");
	});

	it("is case-insensitive on the shell name", async () => {
		await completionsCommand("BASH");
		// "BASH" must resolve to the same generator as "bash", not the unknown-shell path.
		expect(getLoggedOutput()).toContain("# interlinked bash completion");
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("exits with code 1 for an unknown shell", async () => {
		await completionsCommand("powershell");
		expect(errSpy).toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("prints the exact unknown-shell error message and does not log anything", async () => {
		await completionsCommand("powershell");
		expect(errSpy).toHaveBeenCalledWith("Unknown shell: powershell. Supported: bash, zsh, fish");
		expect(logSpy).not.toHaveBeenCalled();
	});

	describe("bash output content", () => {
		it("contains the header, hook comment, and function name", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			expect(out).toContain("# interlinked bash completion");
			expect(out).toContain('# Add to ~/.bashrc: eval "$(interlinked completions bash)"');
			expect(out).toContain("_interlinked_completions() {");
			expect(out).toContain("complete -F _interlinked_completions interlinked");
		});

		it("embeds the full top-level command list in the commands= line", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			expect(out).toContain(
				'commands="activity attach check checkpoint clean completions context coverage daemons disable doctor enable env explain git guard handoff harness inbox init install-hooks login logout logs mode multi-edit mutation reminder reset resume rewind search send setup status structure sync tasks telemetry trace uninstall-hooks update verify version watch workspace write"',
			);
		});

		it("emits a case block per subcommand table entry with its exact subcommand list", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			expect(out).toContain(
				'        checkpoint)\n            COMPREPLY=( $(compgen -W "list show compare prune archive" -- "${cur}") )\n            ;;',
			);
			expect(out).toContain(
				'        completions)\n            COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") )\n            ;;',
			);
			expect(out).toContain(
				'        harness)\n            COMPREPLY=( $(compgen -W "start stop restart status test" -- "${cur}") )\n            ;;',
			);
		});

		it("falls back to the global options in the default case arm", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			expect(out).toContain(
				'        *)\n            COMPREPLY=( $(compgen -W "--json --short --full --help" -- "${cur}") )\n            ;;',
			);
		});

		it("is case-insensitive and produces identical content for 'BASH' as for 'bash'", async () => {
			await completionsCommand("BASH");
			const upper = getLoggedOutput();
			logSpy.mockClear();
			await completionsCommand("bash");
			const lower = getLoggedOutput();
			expect(upper).toBe(lower);
			expect(upper).toContain("_interlinked_completions() {");
		});

		it("matches the exact full generated script byte-for-byte", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			const expected = [
				"# interlinked bash completion",
				'# Add to ~/.bashrc: eval "$(interlinked completions bash)"',
				"_interlinked_completions() {",
				"    local cur prev commands",
				"    COMPREPLY=()",
				'    cur="${COMP_WORDS[COMP_CWORD]}"',
				'    prev="${COMP_WORDS[COMP_CWORD-1]}"',
				'    commands="activity attach check checkpoint clean completions context coverage daemons disable doctor enable env explain git guard handoff harness inbox init install-hooks login logout logs mode multi-edit mutation reminder reset resume rewind search send setup status structure sync tasks telemetry trace uninstall-hooks update verify version watch workspace write"',
				"",
				"    if [[ ${COMP_CWORD} -eq 1 ]]; then",
				'        COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )',
				"        return 0",
				"    fi",
				"",
				'    case "${prev}" in',
				"        checkpoint)",
				'            COMPREPLY=( $(compgen -W "list show compare prune archive" -- "${cur}") )',
				"            ;;",
				"        completions)",
				'            COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") )',
				"            ;;",
				"        coverage)",
				'            COMPREPLY=( $(compgen -W "check baseline" -- "${cur}") )',
				"            ;;",
				"        git)",
				'            COMPREPLY=( $(compgen -W "context link-checkpoint" -- "${cur}") )',
				"            ;;",
				"        guard)",
				'            COMPREPLY=( $(compgen -W "install check status uninstall" -- "${cur}") )',
				"            ;;",
				"        harness)",
				'            COMPREPLY=( $(compgen -W "start stop restart status test" -- "${cur}") )',
				"            ;;",
				"        mutation)",
				'            COMPREPLY=( $(compgen -W "check baseline" -- "${cur}") )',
				"            ;;",
				"        reminder)",
				'            COMPREPLY=( $(compgen -W "add list remove" -- "${cur}") )',
				"            ;;",
				"        structure)",
				'            COMPREPLY=( $(compgen -W "init scan status accept doctor baseline" -- "${cur}") )',
				"            ;;",
				"        tasks)",
				'            COMPREPLY=( $(compgen -W "list create show claim complete" -- "${cur}") )',
				"            ;;",
				"        trace)",
				'            COMPREPLY=( $(compgen -W "export import" -- "${cur}") )',
				"            ;;",
				"        workspace)",
				'            COMPREPLY=( $(compgen -W "list switch" -- "${cur}") )',
				"            ;;",
				"        *)",
				'            COMPREPLY=( $(compgen -W "--json --short --full --help" -- "${cur}") )',
				"            ;;",
				"    esac",
				"    return 0",
				"}",
				"complete -F _interlinked_completions interlinked",
				"",
			].join("\n");
			expect(out).toBe(expected);
		});
	});

	describe("zsh output content", () => {
		it("contains the compdef header and function wiring", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			expect(out).toContain("#compdef interlinked");
			expect(out).toContain('# Add to ~/.zshrc: eval "$(interlinked completions zsh)"');
			expect(out).toContain("_interlinked() {");
			expect(out).toContain("_arguments -C \\\n        '1:command:->cmd' \\\n        '*::arg:->args'");
			expect(out).toContain('_interlinked "$@"');
		});

		it("lists every top-level command with its own describe entry", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			expect(out).toContain("        'activity:activity command'");
			expect(out).toContain("        'write:write command'");
			expect(out).toContain("        'checkpoint:checkpoint command'");
			expect(out).toContain("_describe -t commands 'interlinked commands' commands");
		});

		it("emits a per-subcommand case arm using _values", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			expect(out).toContain(
				"                checkpoint)\n                    _values 'subcommand' list show compare prune archive\n                    ;;",
			);
			expect(out).toContain(
				"                completions)\n                    _values 'subcommand' bash zsh fish\n                    ;;",
			);
		});

		it("falls back to the three global-option arguments in the default arm", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			expect(out).toContain(
				"                *)\n                    _arguments \\\n                        '--json[Machine-readable output]' \\\n                        '--short[One-line summary]' \\\n                        '--full[Detailed output]'\n                    ;;",
			);
		});

		it("matches the exact full generated script byte-for-byte", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			const expected = [
				"#compdef interlinked",
				"# interlinked zsh completion",
				'# Add to ~/.zshrc: eval "$(interlinked completions zsh)"',
				"",
				"_interlinked() {",
				"    local -a commands",
				"    commands=(",
				"        'activity:activity command'",
				"        'attach:attach command'",
				"        'check:check command'",
				"        'checkpoint:checkpoint command'",
				"        'clean:clean command'",
				"        'completions:completions command'",
				"        'context:context command'",
				"        'coverage:coverage command'",
				"        'daemons:daemons command'",
				"        'disable:disable command'",
				"        'doctor:doctor command'",
				"        'enable:enable command'",
				"        'env:env command'",
				"        'explain:explain command'",
				"        'git:git command'",
				"        'guard:guard command'",
				"        'handoff:handoff command'",
				"        'harness:harness command'",
				"        'inbox:inbox command'",
				"        'init:init command'",
				"        'install-hooks:install-hooks command'",
				"        'login:login command'",
				"        'logout:logout command'",
				"        'logs:logs command'",
				"        'mode:mode command'",
				"        'multi-edit:multi-edit command'",
				"        'mutation:mutation command'",
				"        'reminder:reminder command'",
				"        'reset:reset command'",
				"        'resume:resume command'",
				"        'rewind:rewind command'",
				"        'search:search command'",
				"        'send:send command'",
				"        'setup:setup command'",
				"        'status:status command'",
				"        'structure:structure command'",
				"        'sync:sync command'",
				"        'tasks:tasks command'",
				"        'telemetry:telemetry command'",
				"        'trace:trace command'",
				"        'uninstall-hooks:uninstall-hooks command'",
				"        'update:update command'",
				"        'verify:verify command'",
				"        'version:version command'",
				"        'watch:watch command'",
				"        'workspace:workspace command'",
				"        'write:write command'",
				"    )",
				"",
				"    _arguments -C \\",
				"        '1:command:->cmd' \\",
				"        '*::arg:->args'",
				"",
				"    case $state in",
				"        cmd)",
				"            _describe -t commands 'interlinked commands' commands",
				"            ;;",
				"        args)",
				"            case $words[1] in",
				"                checkpoint)",
				"                    _values 'subcommand' list show compare prune archive",
				"                    ;;",
				"                completions)",
				"                    _values 'subcommand' bash zsh fish",
				"                    ;;",
				"                coverage)",
				"                    _values 'subcommand' check baseline",
				"                    ;;",
				"                git)",
				"                    _values 'subcommand' context link-checkpoint",
				"                    ;;",
				"                guard)",
				"                    _values 'subcommand' install check status uninstall",
				"                    ;;",
				"                harness)",
				"                    _values 'subcommand' start stop restart status test",
				"                    ;;",
				"                mutation)",
				"                    _values 'subcommand' check baseline",
				"                    ;;",
				"                reminder)",
				"                    _values 'subcommand' add list remove",
				"                    ;;",
				"                structure)",
				"                    _values 'subcommand' init scan status accept doctor baseline",
				"                    ;;",
				"                tasks)",
				"                    _values 'subcommand' list create show claim complete",
				"                    ;;",
				"                trace)",
				"                    _values 'subcommand' export import",
				"                    ;;",
				"                workspace)",
				"                    _values 'subcommand' list switch",
				"                    ;;",
				"                *)",
				"                    _arguments \\",
				"                        '--json[Machine-readable output]' \\",
				"                        '--short[One-line summary]' \\",
				"                        '--full[Detailed output]'",
				"                    ;;",
				"            esac",
				"            ;;",
				"    esac",
				"}",
				"",
				'_interlinked "$@"',
				"",
			].join("\n");
			expect(out).toBe(expected);
		});
	});

	describe("fish output content", () => {
		it("contains the header and disables file completion", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			expect(out).toContain("# interlinked fish completion");
			expect(out).toContain("# Add to config: interlinked completions fish | source");
			expect(out).toContain("complete -c interlinked -f");
		});

		it("emits one complete line per top-level command with matching -a and -d values", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			expect(out).toContain(
				"complete -c interlinked -n '__fish_use_subcommand' -a 'activity' -d 'activity'",
			);
			expect(out).toContain(
				"complete -c interlinked -n '__fish_use_subcommand' -a 'write' -d 'write'",
			);
			expect(out).toContain(
				"complete -c interlinked -n '__fish_use_subcommand' -a 'checkpoint' -d 'checkpoint'",
			);
		});

		it("emits one complete line per subcommand table entry scoped with __fish_seen_subcommand_from", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			expect(out).toContain(
				"complete -c interlinked -n '__fish_seen_subcommand_from checkpoint' -a 'list show compare prune archive'",
			);
			expect(out).toContain(
				"complete -c interlinked -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'",
			);
		});

		it("emits the three global options as long-flag completions with descriptions", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			expect(out).toContain("complete -c interlinked -l json -d 'Machine-readable output'");
			expect(out).toContain("complete -c interlinked -l short -d 'One-line summary'");
			expect(out).toContain("complete -c interlinked -l full -d 'Detailed output'");
		});

		it("matches the exact full generated script byte-for-byte", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			const expected = [
				"# interlinked fish completion",
				"# Add to config: interlinked completions fish | source",
				"",
				"# Disable file completions for interlinked",
				"complete -c interlinked -f",
				"",
				"# Main commands",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'activity' -d 'activity'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'attach' -d 'attach'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'check' -d 'check'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'checkpoint' -d 'checkpoint'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'clean' -d 'clean'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'completions' -d 'completions'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'context' -d 'context'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'coverage' -d 'coverage'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'daemons' -d 'daemons'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'disable' -d 'disable'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'doctor' -d 'doctor'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'enable' -d 'enable'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'env' -d 'env'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'explain' -d 'explain'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'git' -d 'git'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'guard' -d 'guard'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'handoff' -d 'handoff'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'harness' -d 'harness'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'inbox' -d 'inbox'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'init' -d 'init'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'install-hooks' -d 'install-hooks'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'login' -d 'login'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'logout' -d 'logout'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'logs' -d 'logs'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'mode' -d 'mode'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'multi-edit' -d 'multi-edit'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'mutation' -d 'mutation'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'reminder' -d 'reminder'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'reset' -d 'reset'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'resume' -d 'resume'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'rewind' -d 'rewind'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'search' -d 'search'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'send' -d 'send'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'setup' -d 'setup'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'status' -d 'status'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'structure' -d 'structure'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'sync' -d 'sync'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'tasks' -d 'tasks'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'telemetry' -d 'telemetry'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'trace' -d 'trace'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'uninstall-hooks' -d 'uninstall-hooks'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'update' -d 'update'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'verify' -d 'verify'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'version' -d 'version'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'watch' -d 'watch'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'workspace' -d 'workspace'",
				"complete -c interlinked -n '__fish_use_subcommand' -a 'write' -d 'write'",
				"",
				"# Subcommands",
				"complete -c interlinked -n '__fish_seen_subcommand_from checkpoint' -a 'list show compare prune archive'",
				"complete -c interlinked -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'",
				"complete -c interlinked -n '__fish_seen_subcommand_from coverage' -a 'check baseline'",
				"complete -c interlinked -n '__fish_seen_subcommand_from git' -a 'context link-checkpoint'",
				"complete -c interlinked -n '__fish_seen_subcommand_from guard' -a 'install check status uninstall'",
				"complete -c interlinked -n '__fish_seen_subcommand_from harness' -a 'start stop restart status test'",
				"complete -c interlinked -n '__fish_seen_subcommand_from mutation' -a 'check baseline'",
				"complete -c interlinked -n '__fish_seen_subcommand_from reminder' -a 'add list remove'",
				"complete -c interlinked -n '__fish_seen_subcommand_from structure' -a 'init scan status accept doctor baseline'",
				"complete -c interlinked -n '__fish_seen_subcommand_from tasks' -a 'list create show claim complete'",
				"complete -c interlinked -n '__fish_seen_subcommand_from trace' -a 'export import'",
				"complete -c interlinked -n '__fish_seen_subcommand_from workspace' -a 'list switch'",
				"",
				"# Global options",
				"complete -c interlinked -l json -d 'Machine-readable output'",
				"complete -c interlinked -l short -d 'One-line summary'",
				"complete -c interlinked -l full -d 'Detailed output'",
				"",
			].join("\n");
			expect(out).toBe(expected);
		});
	});

	describe("shell dispatch produces distinct, non-overlapping output", () => {
		it("bash output has no zsh or fish markers", async () => {
			await completionsCommand("bash");
			const out = getLoggedOutput();
			expect(out).not.toContain("#compdef");
			expect(out).not.toContain("complete -c interlinked");
		});

		it("zsh output has no bash or fish markers", async () => {
			await completionsCommand("zsh");
			const out = getLoggedOutput();
			expect(out).not.toContain("_interlinked_completions() {");
			expect(out).not.toContain("complete -c interlinked");
		});

		it("fish output has no bash or zsh markers", async () => {
			await completionsCommand("fish");
			const out = getLoggedOutput();
			expect(out).not.toContain("#compdef");
			expect(out).not.toContain("_interlinked_completions() {");
		});
	});
});
