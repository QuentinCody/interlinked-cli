// Shell completion is derived from the active Commander tree. Generating a
// script only reads registration metadata and never invokes command handlers.
import type { Command, Option } from "commander";

interface CompletionNode {
	path: string;
	candidates: string[];
	transitions: { word: string; path: string }[];
	valueFlags: string[];
}

function optionFlags(option: Option): string[] {
	return [option.short, option.long].filter((flag): flag is string => flag !== undefined);
}

function completionNodes(program: Command): CompletionNode[] {
	const nodes: CompletionNode[] = [];
	function visit(command: Command, path: string, inherited: Option[]): void {
		const help = command.createHelp();
		const children = help.visibleCommands(command);
		const options = [...inherited, ...help.visibleOptions(command)];
		const transitions = children.flatMap((child) =>
			[child.name(), ...child.aliases()].map((word) => ({
				word,
				path: path ? path + "/" + child.name() : child.name(),
			})),
		);
		// The shell argument is an existing public enum, rather than a command.
		const choices = path === "completions" ? ["bash", "zsh", "fish"] : [];
		nodes.push({
			path,
			candidates: [...new Set([...transitions.map((entry) => entry.word), ...choices, ...options.flatMap(optionFlags)])],
			transitions,
			valueFlags: options.filter((option) => option.required).flatMap(optionFlags),
		});
		for (const child of children) visit(child, path ? path + "/" + child.name() : child.name(), options);
	}
	visit(program, "", []);
	return nodes;
}

/** Literal shell words. Metadata must never become executable shell text. */
function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function fishQuote(value: string): string {
	return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

export async function completionsCommand(shell: string, program?: Command): Promise<void> {
	const normalized = shell.toLowerCase();
	if (!["bash", "zsh", "fish"].includes(normalized)) {
		console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
		process.exitCode = 1;
		return;
	}
	const activeProgram = program ?? (await import("../cli-program.js")).buildProgram("completion");
	const nodes = completionNodes(activeProgram);
	switch (normalized) {
		case "bash":
			console.log(generateBash(nodes));
			break;
		case "zsh":
			console.log(generateZsh(nodes));
			break;
		case "fish":
			console.log(generateFish(nodes));
			break;
	}
}

function transitionCases(nodes: CompletionNode[]): string {
	return nodes.flatMap((node) => [
		...node.transitions.map((entry) =>
			`            ${quote(node.path + "/" + entry.word)}) command_path=${quote(entry.path)} ;;`,
		),
		...node.valueFlags.map((flag) =>
			`            ${quote(node.path + "/" + flag)}) skip=1 ;;`,
		),
	]).join("\n");
}

function candidateCases(nodes: CompletionNode[]): string {
	return nodes.map((node) =>
		`        ${quote(node.path)}) candidates=(${node.candidates.map(quote).join(" ")}) ;;`,
	).join("\n");
}

function generateBash(nodes: CompletionNode[]): string {
	return `# interlinked bash completion
# Add to ~/.bashrc: eval "$(interlinked completions bash)"
_interlinked_completions() {
    local command_path="" word cur skip=0 i candidate
    local -a candidates
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    for ((i=1; i<COMP_CWORD; i++)); do
        word="\${COMP_WORDS[i]}"
        if [[ $skip -eq 1 ]]; then skip=0; continue; fi
        if [[ $word == -- ]]; then return 0; fi
        case "$command_path/$word" in
${transitionCases(nodes)}
        esac
    done
    if [[ $skip -eq 1 ]]; then return 0; fi
    case "$command_path" in
${candidateCases(nodes)}
    esac
    for candidate in "\${candidates[@]}"; do
        if [[ $candidate == "$cur"* ]]; then COMPREPLY+=("$candidate"); fi
    done
}
complete -F _interlinked_completions interlinked
`;
}

function generateZsh(nodes: CompletionNode[]): string {
	return `#compdef interlinked
# interlinked zsh completion
# Add to ~/.zshrc: eval "$(interlinked completions zsh)"
_interlinked() {
    local command_path="" word skip=0 i
    local -a candidates
    for ((i=2; i<CURRENT; i++)); do
        word="\${words[i]}"
        if [[ $skip -eq 1 ]]; then skip=0; continue; fi
        if [[ $word == -- ]]; then return 0; fi
        case "$command_path/$word" in
${transitionCases(nodes)}
        esac
    done
    if [[ $skip -eq 1 ]]; then return 0; fi
    case "$command_path" in
${candidateCases(nodes)}
    esac
    compadd -- "\${candidates[@]}"
}
compdef _interlinked interlinked
`;
}

function generateFish(nodes: CompletionNode[]): string {
	const transitions = nodes.flatMap((node) => [
		...node.transitions.map((entry) =>
			`            case ${fishQuote(node.path + "/" + entry.word)}\n                set command_path ${fishQuote(entry.path)}`,
		),
		...node.valueFlags.map((flag) =>
			`            case ${fishQuote(node.path + "/" + flag)}\n                set skip 1`,
		),
	]).join("\n");
	const candidates = nodes.map((node) =>
		`        case ${fishQuote(node.path)}\n            printf '%s\\n' ${node.candidates.map(fishQuote).join(" ")}`,
	).join("\n");
	return `# interlinked fish completion
# Add to config: interlinked completions fish | source
function __interlinked_candidates
    set -l command_path ''
    set -l skip 0
    set -l words (commandline -opc)
    for word in $words[2..-1]
        if test $skip -eq 1
            set skip 0
            continue
        end
        if test "$word" = --
            return
        end
        switch "$command_path/$word"
${transitions}
        end
    end
    if test $skip -eq 1
        return
    end
    switch "$command_path"
${candidates}
    end
end
complete -c interlinked -f -a '(__interlinked_candidates)'
`;
}
