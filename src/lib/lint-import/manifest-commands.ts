import { basename, dirname } from "node:path";
import { lintJson, lintJsonc, lintObject } from "./json.js";
import type { LintCommandSource } from "./command-discovery.js";
import { expandLintScript } from "./script-aliases.js";

function stringCommands(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
}

function commandSource(file: string, content: string, label: string, command: string): LintCommandSource {
    const index = content.indexOf(JSON.stringify(command));
    const line = index < 0 ? 1 : content.slice(0, index).split("\n").length;
    return { command, scope: dirname(file), origin: { file, line, kind: "package-script", label } };
}

function expandedSource(source: LintCommandSource, map: Record<string, unknown>): LintCommandSource {
    try { return { ...source, command: expandLintScript(source.command, map) }; }
    catch (error) { return { ...source, reason: error instanceof Error ? error.message : String(error) }; }
}

/** Each package owns its script cwd, even when CI invokes it through a workspace alias. */
export function manifestLintCommands(file: string, content: string): LintCommandSource[] {
    const document = lintObject(file.endsWith(".jsonc") ? lintJsonc(content) : lintJson(content));
    const field = basename(file).startsWith("deno.") ? "tasks" : "scripts";
    const map = document[field];
    if (map === undefined) return [];
    const scripts = lintObject(map);
    return Object.entries(scripts).flatMap(([name, value]) => stringCommands(value).map((command) => expandedSource(commandSource(file, content, `${field}.${name}`, command), scripts)));
}

interface TaskWalk { file: string; content: string; commands: LintCommandSource[]; scope: string; visited: number }

function jsonTaskScope(node: Record<string, unknown>, parent: string): string {
    const options = node.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) return parent;
    const cwd = lintObject(options).cwd;
    return typeof cwd === "string" ? cwd : parent;
}

function visitTask(value: unknown, context: TaskWalk, path: string, scope: string): void {
    if (++context.visited > 10_000) throw new Error("Task declaration inspection budget exceeded");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, index) => visitTask(item, context, `${path}[${index}]`, scope)); return; }
    const object = lintObject(value);
    const cwd = jsonTaskScope(object, scope);
    for (const [key, child] of Object.entries(object)) {
        if (["command", "commands"].includes(key)) {
            for (const command of stringCommands(child)) {
                const source = commandSource(context.file, context.content, `${path}.${key}`, command);
                const args = stringCommands(object.args);
                source.command = [command, ...args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)].join(" ");
                source.scope = cwd;
                source.origin.kind = "task";
                context.commands.push(source);
            }
        } else visitTask(child, context, `${path}.${key}`, cwd);
    }
}

export function jsonTaskLintCommands(file: string, content: string): LintCommandSource[] {
    const scope = file.startsWith(".vscode/") ? "." : dirname(file);
    const context: TaskWalk = { file, content, commands: [], scope, visited: 0 };
    visitTask(lintJsonc(content), context, "tasks", scope);
    return context.commands;
}
