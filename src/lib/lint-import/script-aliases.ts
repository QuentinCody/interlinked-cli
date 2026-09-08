import { lintShellCommands } from "./shell-words.js";

function quote(word: string): string { return `'${word.replaceAll("'", "'\\''")}'`; }

function scriptName(words: string[]): { name: string; args: string[] } | undefined {
    if (!["npm", "pnpm", "yarn", "bun", "deno", "composer"].includes(words[0] ?? "")) return undefined;
    const index = ["run", "run-script", "task"].includes(words[1] ?? "") ? 2 : 1;
    const name = words[index];
    return name ? { name, args: words.slice(index + 1).filter((word) => word !== "--") } : undefined;
}

/** Resolve literal local aliases only; preserve substitutions/unknown shell forms for review. */
export function expandLintScript(command: string, scripts: Record<string, unknown>, seen = new Set<string>()): string {
    return lintShellCommands(command).map((words) => {
        const alias = scriptName(words);
        const target = alias ? scripts[alias.name] : undefined;
        if (!alias || typeof target !== "string") return words.map(quote).join(" ");
        if (seen.has(alias.name) || seen.size > 32) throw new Error("Lint script alias cycle or depth limit");
        const next = new Set([...seen, alias.name]);
        return [expandLintScript(target, scripts, next), ...alias.args.map(quote)].join(" ");
    }).join(" && ");
}
