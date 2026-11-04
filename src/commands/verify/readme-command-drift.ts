import type { Command, Option } from "commander";
import type { CatalogueFinding } from "./catalogue-types.js";

function optionFor(command: Command, flag: string): Option | undefined {
    for (let current: Command | null = command; current; current = current.parent) {
        const option = current.options.find(item => item.long === flag || item.short === flag);
        if (option) return option;
    }
    return undefined;
}

/** Parse only literal examples, without running a shell or a command action. */
function literalTokens(example: string): string[] | null {
    if (/[|;&`\n]|\$\(|\\$/.test(example)) return null;
    const tokens = example.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g);
    if (!tokens || tokens[0] !== "interlinked") return null;
    return tokens.slice(1).map(token => token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
}

export function absentHelpItem(example: string, root: Command): string | null {
    const tokens = literalTokens(example);
    if (!tokens) return null;
    let current = root;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token || token === "--" || token === "…" || token === "..." || /^(?:\d*)>>?$/.test(token) || token.startsWith("#")) break;
        if (token === "--help" || token === "-h") continue;
        if (token.startsWith("-")) {
            const flag = token.split("=")[0] ?? token;
            const option = optionFor(current, flag);
            // A compact short-option cluster or shell placeholder is ambiguous.
            if (!option && /^-[^-].{1,}$/.test(flag)) continue;
            if (!option) return `flag ${flag} for ${current.name()}`;
            if (!token.includes("=") && option.required) index++;
            else if (!token.includes("=") && option.optional && tokens[index + 1] && !tokens[index + 1]?.startsWith("-")) index++;
            continue;
        }
        const child = current.commands.find(command => command.name() === token || command.aliases().includes(token));
        if (child) { current = child; continue; }
        // Documentation shorthand such as start/stop/status is not one command.
        if (token.includes("/") && current.registeredArguments.length === 0) return null;
        if (current.registeredArguments.length > 0 || /^[<[{]/.test(token)) continue;
        if (token === "help") return null;
        return `command ${token} under ${current.name()}`;
    }
    return null;
}

export function isCurrentCommandDocumentation(file: string): boolean {
    return !/^docs\/(?:design|plans|external-pulse)\//.test(file)
        && !/(?:^|\/)[^/]*-plan\.md$/.test(file);
}

export function checkReadmeCommandDrift(content: string, file: string, program: Command): CatalogueFinding[] {
    if (!isCurrentCommandDocumentation(file)) return [];
    const findings: CatalogueFinding[] = [];
    let fence: string | null = null;
    let shellFence = false;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
        const marker = /^\s*(`{3,}|~{3,})([\w-]*)/.exec(line);
        if (marker) {
            if (fence === null) { fence = marker[1]?.[0] ?? null; shellFence = /^(?:sh|bash|shell|console|zsh|)$/i.test(marker[2] ?? ""); }
            else if (marker[1]?.[0] === fence) { fence = null; shellFence = false; }
            continue;
        }
        const examples = fence === null
            ? [...line.matchAll(/`(interlinked [^`]+)`/g)].map(match => match[1] ?? "")
            : shellFence && /^\s*(?:\$\s+)?interlinked\s/.test(line) ? [line.trim().replace(/^\$\s+/, "")] : [];
        for (const example of examples) {
            const missing = absentHelpItem(example, program);
            if (missing) findings.push({ check: "readme_command_drift", file, line: index + 1,
                message: `Current CLI help does not expose ${missing}.`, evidence: example });
        }
    }
    return findings;
}
