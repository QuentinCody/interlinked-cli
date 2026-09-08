import { basename } from "node:path";
import { discoverLintCommand, type LintCommandSource } from "./command-discovery.js";
import { jsonTaskLintCommands, manifestLintCommands } from "./manifest-commands.js";
import { shellLintCommands, textTaskLintCommands } from "./text-commands.js";
import type { LintInvocationCandidate } from "./types.js";
import { isYamlLintTask, yamlLintCommands } from "./yaml-commands.js";
import { buildTaskLintCommands, isLintBuildFile } from "./build-task-evidence.js";

const MANIFEST_COMMANDS = new Set(["package.json", "composer.json", "deno.json", "deno.jsonc"]);
const JSON_TASKS = new Set(["project.json", "tasks.json"]);
const TEXT_TASKS = new Set(["pyproject.toml", "tox.ini", "setup.cfg"]);
const SHELL_TASKS = /^(?:[Mm]akefile|GNUmakefile|justfile|Justfile)$/;

export function isLintInvocationFile(file: string): boolean {
    const name = basename(file);
    return MANIFEST_COMMANDS.has(name) || JSON_TASKS.has(name) || TEXT_TASKS.has(name) || SHELL_TASKS.test(name) || isYamlLintTask(file) || isLintBuildFile(file) || /(?:^|\/)(?:scripts\/.*\.sh|\.husky\/[^/]+)$/.test(file);
}

function commandsInFile(file: string, content: string): LintCommandSource[] {
    if (isLintBuildFile(file)) return buildTaskLintCommands(file, content);
    if (isYamlLintTask(file)) return yamlLintCommands(file, content);
    const name = basename(file);
    if (MANIFEST_COMMANDS.has(name)) return manifestLintCommands(file, content);
    if (JSON_TASKS.has(name)) return jsonTaskLintCommands(file, content);
    if (TEXT_TASKS.has(name)) return textTaskLintCommands(file, content);
    return shellLintCommands(file, content);
}

export function lintInvocationsInFile(file: string, content: string): LintInvocationCandidate[] {
    if (!isLintInvocationFile(file)) return [];
    return commandsInFile(file, content).flatMap(discoverLintCommand);
}
