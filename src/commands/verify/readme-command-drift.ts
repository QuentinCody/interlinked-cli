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
    const tokens = example.match(/"[^"\n]*"|'[^'\n]*'|\[--?[\w-]+(?:[ =][^\[\]\n]*)?\](?=\s|$)|[^\s]+/g);
    if (!tokens || tokens[0] !== "interlinked") return null;
    return tokens.slice(1).flatMap(token => /^\[--?/.test(token) && token.endsWith("]")
        ? token.slice(1, -1).split(/\s+/)
        : [token.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2")]);
}

/** Return the number of following value tokens consumed, or the missing flag diagnostic. */
function documentedOption(command: Command, token: string, next?: string): number | string {
    if (token === "--help" || token === "-h") return 0;
    const flag = token.split("=")[0] ?? token;
    const option = optionFor(command, flag);
    if (!option) return /^-[^-].{1,}$/.test(flag) ? 0 : `flag ${flag} for ${command.name()}`;
    if (token.includes("=")) return 0;
    if (option.required) return 1;
    return option.optional && next && !next.startsWith("-") ? 1 : 0;
}

function lastExampleToken(token: string): boolean {
    return token === "--" || token === "…" || token === "..." || /^(?:\d*)>>?$/.test(token) || token.startsWith("#");
}

/** A positional token selects a child, belongs to the current command, or ends the literal example. */
function documentedArgument(current: Command, token: string): Command | string | null {
    const child = current.commands.find(command => command.name() === token || command.aliases().includes(token));
    if (child) return child;
    if (current.registeredArguments.length > 0) return current;
    if (token.includes("/") || token === "help") return null;
    if (/^[<[{]/.test(token)) return current;
    return `command ${token} under ${current.name()}`;
}

export function absentHelpItem(example: string, root: Command): string | null {
    const tokens = literalTokens(example);
    if (!tokens) return null;
    let current = root;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token || lastExampleToken(token)) break;
        if (token.startsWith("-")) {
            const consumed = documentedOption(current, token, tokens[index + 1]);
            if (typeof consumed === "string") return consumed;
            index += consumed;
            continue;
        }
        const argument = documentedArgument(current, token);
        if (argument === null || typeof argument === "string") return argument;
        current = argument;
    }
    return null;
}

export function isCurrentCommandDocumentation(file: string, content = ""): boolean {
    if (/^docs\/(?:design|plans|external-pulse)\//.test(file) || /(?:^|\/)[^/]*-plan\.md$/.test(file)) return false;
    // Dated campaign records and review snapshots document an earlier tree.
    // A maintained command guide can live in either directory.
    if (file.startsWith("docs/campaigns/")) {
        const date = /-(\d{4}-\d{2}(?:-\d{2})?)\.md$/.exec(file)?.[1];
        return !date || !content.split("\n", 1)[0]?.includes(date);
    }
    if (!file.startsWith("docs/reviews/")) return true;
    const intro = content.split(/^##\s/m, 1)[0] ?? "";
    return !/^branch\b[^\n]*\bat\s+`?[a-f\d]{7,40}\b/im.test(intro)
        && !/\bverification run,\s+\d{4}-\d{2}-\d{2}\b/i.test(intro);
}

function* documentedExamples(content: string): Generator<{ example: string; line: number }> {
    let fence: string | null = null;
    let shellFence = false;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
        const marker = /^\s*(`{3,}|~{3,})([\w-]*)/.exec(line);
        if (marker) {
            if (fence === null) { fence = marker[1]?.[0] ?? null; shellFence = /^(?:sh|bash|shell|console|zsh|)$/i.test(marker[2] ?? ""); }
            else if (marker[1]?.[0] === fence) { fence = null; shellFence = false; }
            continue;
        }
        if (fence !== null && !shellFence) continue;
        const pattern = fence === null ? /`(interlinked [^`]+)`/g : /^\s*(?:\$\s+)?(interlinked\s.*)$/g;
        for (const match of line.matchAll(pattern)) {
            if (match[1]) yield { example: match[1].trimEnd(), line: index + 1 };
        }
    }
}

export function checkReadmeCommandDrift(content: string, file: string, program: Command): CatalogueFinding[] {
    if (!isCurrentCommandDocumentation(file, content)) return [];
    const findings: CatalogueFinding[] = [];
    for (const { example, line } of documentedExamples(content)) {
        const missing = absentHelpItem(example, program);
        if (missing) findings.push({ check: "readme_command_drift", file, line,
            message: `Current CLI help does not expose ${missing}.`, evidence: example });
    }
    return findings;
}
