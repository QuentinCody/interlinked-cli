import { basename, dirname } from "node:path";
import { mentionsLint, type LintCommandSource } from "./command-discovery.js";

function literal(value: string): string | undefined {
    const match = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    return match?.[2];
}

function taskSetting(file: string, section: string, text: string, line: number): LintCommandSource | undefined {
    if (!/task|script|testenv|hatch\.envs/.test(section)) return undefined;
    const setting = text.match(/^\s*([^=]+)=\s*(.*)/);
    const value = setting?.[2] ?? "";
    if (!setting || !mentionsLint(value)) return undefined;
    const command = literal(value) ?? value;
    const source: LintCommandSource = { command, scope: dirname(file), origin: { file, line, kind: "task", label: `${section}.${setting[1]?.trim()}` } };
    if (/[{}]/.test(command) || !literal(value)) source.reason = "Task interpolation or non-string declaration requires review";
    return source;
}

/** TOML/INI task strings are inventoried without evaluating their host languages. */
export function textTaskLintCommands(file: string, content: string): LintCommandSource[] {
    let section = "";
    const sources: LintCommandSource[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
        const header = line.match(/^\s*\[([^\]]+)\]/);
        if (header) { section = header[1] ?? ""; continue; }
        const source = taskSetting(file, section, line, index + 1);
        if (source) sources.push(source);
    }
    return sources;
}

export function shellLintCommands(file: string, content: string): LintCommandSource[] {
    const make = /^(?:[Mm]akefile|GNUmakefile|justfile|Justfile)$/.test(basename(file));
    const lines = content.split(/\r?\n/);
    const sources: LintCommandSource[] = [];
    const dynamic = /^\s*(?:if|for|while|case|function)\b/m.test(content);
    for (const [index, text] of lines.entries()) {
        const command = text.trim().replace(/^@/, "");
        if (command.startsWith("#") || !mentionsLint(command)) continue;
        if (make && !/^\s/.test(text)) continue;
        const source: LintCommandSource = { command, scope: dirname(file), origin: { file, line: index + 1, kind: "shell", label: make ? "recipe" : "script" } };
        // Standalone shell scripts inherit the caller's cwd; their own directory is not proof.
        if (!make) { source.scope = "."; source.reason = "Shell script caller, environment and working directory require review"; }
        if (dynamic) source.reason = "Conditional shell execution requires review";
        sources.push(source);
    }
    return sources;
}
