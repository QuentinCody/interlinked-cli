import { createRequire } from "node:module";
import { basename, dirname, posix } from "node:path";
import { lintObject } from "./json.js";
import { mentionsLint, type LintCommandSource } from "./command-discovery.js";

const COMMAND_KEYS = new Set(["run", "script", "entry", "cmd", "cmds", "command", "commands", "before_script", "after_script"]);
const YAML_TASKS = /(?:^|\/)(?:\.github\/workflows\/[^/]+|\.gitlab-ci|azure-pipelines|bitbucket-pipelines|\.circleci\/config|\.?lefthook|\.?pre-commit-config|[Tt]askfile(?:\.dist)?)\.ya?ml$/;

export function isYamlLintTask(file: string): boolean { return YAML_TASKS.test(file); }

function parseYaml(content: string): unknown {
    let imported: unknown;
    try { imported = createRequire(import.meta.url)("yaml"); }
    catch (error) { throw new Error("YAML task parsing requires the optional yaml package; inspect this evidence before declaring an adapter", { cause: error }); }
    const parser = lintObject(imported).parse;
    if (typeof parser !== "function") throw new Error("Installed YAML parser has no parse API");
    const value: unknown = parser(content, { merge: true, strict: true, uniqueKeys: true, maxAliasCount: 100 });
    return value;
}

function workingDirectory(object: Record<string, unknown>, parent: string): string {
    const defaults = object.defaults;
    if (defaults && typeof defaults === "object") {
        const run = lintObject(defaults).run;
        if (run && typeof run === "object") return workingDirectory(lintObject(run), parent);
    }
    const cwd = object["working-directory"];
    if (typeof cwd === "string") return cwd;
    return typeof object.dir === "string" ? posix.join(parent, object.dir) : parent;
}

function contextReason(object: Record<string, unknown>, inherited?: string): string | undefined {
    if (inherited) return inherited;
    if (["env", "environment", "matrix", "strategy", "includes", "include", "extends", "deps", "vars", "before_script", "language", "additional_dependencies", "repo", "container"].some((key) => object[key] !== undefined)) return "Task has environment, expansion, inheritance or setup dependencies requiring review";
    if (object.shell !== undefined && object.shell !== "bash" && object.shell !== "sh") return "Task shell semantics require review";
    return undefined;
}

interface Walk { file: string; content: string; commands: LintCommandSource[]; visited: number }

function addCommand(context: Walk, command: string, scope: string, label: string, reason?: string): void {
    const index = context.content.indexOf(command);
    const line = index < 0 ? 1 : context.content.slice(0, index).split("\n").length;
    const source: LintCommandSource = { command, scope, origin: { file: context.file, line, kind: "ci", label } };
    if (reason !== undefined) source.reason = reason;
    context.commands.push(source);
}

function commandValues(value: unknown): string[] {
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function visitYaml(value: unknown, context: Walk, scope: string, path: string, reason?: string): void {
    if (++context.visited > 10_000) throw new Error("YAML task traversal budget exceeded");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, index) => visitYaml(item, context, scope, `${path}[${index}]`, reason)); return; }
    const object = lintObject(value);
    const cwd = workingDirectory(object, scope);
    const review = contextReason(object, reason);
    for (const [key, child] of Object.entries(object)) {
        if (COMMAND_KEYS.has(key)) for (const command of commandValues(child)) addCommand(context, command, cwd, `${path}.${key}`, review);
        visitYaml(child, context, cwd, `${path}.${key}`, review);
    }
}

export function yamlDocumentCommands(file: string, content: string, document: unknown): LintCommandSource[] {
    const scope = /taskfile/i.test(basename(file)) ? dirname(file) : ".";
    const context: Walk = { file, content, commands: [], visited: 0 };
    visitYaml(document, context, scope, "tasks");
    return context.commands;
}

export function yamlLintCommands(file: string, content: string): LintCommandSource[] {
    try { return yamlDocumentCommands(file, content, parseYaml(content)); }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return content.split(/\r?\n/).flatMap((command, index) => mentionsLint(command) ? [{ command: command.trim(), scope: ".", reason, origin: { file, line: index + 1, kind: "ci" as const, label: "unresolved YAML task" } }] : []);
    }
}
