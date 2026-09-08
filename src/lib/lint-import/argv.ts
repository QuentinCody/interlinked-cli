import { basename, posix } from "node:path";
import { LINT_ADAPTERS } from "./adapters.js";
import { isReportTool, parseReportAdapter } from "./custom-adapters.js";
import { LINT_BOOLEAN_OPTIONS, LINT_PATH_OPTIONS, LINT_REPORT_OPTIONS, LINT_VALUE_OPTIONS } from "./option-specs.js";
import type { LintImportEntry } from "./types.js";

export function confinedArgument(value: string): string {
    if (!value || value.startsWith("-") || value.startsWith("/") || /[\0\r\n\\$`]/.test(value) || /^[A-Za-z]:/.test(value)) throw new Error(`Unsupported lint path: ${value}`);
    if (value.split("/").includes("..")) throw new Error(`Lint path leaves its scope: ${value}`);
    return value;
}

export function scopedLintPath(scope: string, value: string): string {
    if (posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error("Absolute invocation paths require explicit selection");
    return confinedArgument(posix.normalize(posix.join(scope, value)));
}

function optionValue(args: string[], index: number): { name: string; value?: string; consumed: number } {
    const text = args[index] ?? "";
    const equal = text.indexOf("=");
    if (equal > 0) return { name: text.slice(0, equal), value: text.slice(equal + 1), consumed: 1 };
    const next = args[index + 1];
    return next === undefined ? { name: text, consumed: 1 } : { name: text, value: next, consumed: 2 };
}

function configOption(tool: string, name: string): boolean {
    if (name === LINT_ADAPTERS[tool]?.configFlag) return true;
    return name === "-c" && ["eslint", "oxlint", "rubocop", "mypy", "phpstan", "psalm"].includes(tool);
}

function applyValueOption(entry: LintImportEntry, name: string, value: string): void {
    if (configOption(entry.tool, name)) {
        if (entry.config !== undefined) throw new Error("Multiple configs in one invocation need separate profiles");
        entry.config = scopedLintPath(entry.scope, value);
        entry.sources.push(entry.config);
        return;
    }
    if (LINT_REPORT_OPTIONS[entry.tool]?.includes(name)) {
        if (/[:/\\]/.test(value) && !value.startsWith("%(path)")) throw new Error("Custom/output-file reporters need review");
        return;
    }
    const path = LINT_PATH_OPTIONS[entry.tool]?.includes(name);
    if (!path && !LINT_VALUE_OPTIONS[entry.tool]?.includes(name)) throw new Error(`Unsupported option ${name}; invocation was not approximated`);
    if (path) entry.sources.push(scopedLintPath(entry.scope, value));
    entry.flags?.push(name, value);
}

function readOption(entry: LintImportEntry, args: string[], index: number): number {
    const text = args[index] ?? "";
    if (LINT_BOOLEAN_OPTIONS[entry.tool]?.includes(text)) { entry.flags?.push(text); return 1; }
    const option = optionValue(args, index);
    if (!option.value || option.value.startsWith("--")) throw new Error(`Missing value for ${option.name}`);
    applyValueOption(entry, option.name, option.value);
    return option.consumed;
}

/** Normalize only a supported read-only invocation. No source command is executed. */
export function parseLintArgv(tool: string, args: string[], scope: string): LintImportEntry {
    const adapter = LINT_ADAPTERS[tool];
    if (!adapter) throw new Error(`No execution adapter for ${tool}; use a SARIF report`);
    const entry: LintImportEntry = { tool, scope, sources: [], targets: [], flags: [] };
    const input = [...args];
    for (const verb of adapter.prefix) {
        if (input[0] === verb) input.shift();
        else if (tool !== "swiftlint") throw new Error(`Expected ${tool} ${verb}; other operations need review`);
    }
    for (let index = 0; index < input.length;) {
        const arg = input[index] ?? "";
        if (arg === "--") { entry.targets?.push(...input.slice(index + 1).map(confinedArgument)); break; }
        if (arg.startsWith("-")) index += readOption(entry, input, index);
        else { entry.targets?.push(confinedArgument(arg)); index++; }
    }
    if (entry.targets?.length === 0) delete entry.targets;
    if (entry.flags?.length === 0) delete entry.flags;
    return entry;
}

/** Revalidate persisted flags before every run, including hand-edited policies. */
function validateReportEntry(entry: LintImportEntry): void {
    if (entry.flags || entry.targets || entry.config) throw new Error("SARIF profiles declare arguments and configs in their adapter registry");
}

export function validateLintArguments(entry: LintImportEntry): void {
    if (isReportTool(entry.tool)) {
        parseReportAdapter(entry.report);
        validateReportEntry(entry);
        return;
    }
    const adapter = LINT_ADAPTERS[entry.tool];
    if (!adapter) throw new Error(`Unknown lint adapter: ${entry.tool}`);
    if (entry.config !== undefined && !adapter.configFlag) throw new Error(`${entry.tool} has no explicit config option`);
    const parsed = parseLintArgv(entry.tool, [...adapter.prefix, ...(entry.flags ?? []), "--", ...(entry.targets ?? [])], entry.scope);
    if (parsed.config !== undefined || JSON.stringify(parsed.flags ?? []) !== JSON.stringify(entry.flags ?? [])) throw new Error("Unvalidated imported lint flags");
    if (parsed.sources.some((file) => !entry.sources.includes(file))) throw new Error("Lint option input has no source provenance");
}

export function toolForExecutable(command: string, args: string[]): string | undefined {
    const name = basename(command).replace(/\.exe$/, "");
    if (name === "cargo") return args[0] === "clippy" ? "clippy" : undefined;
    return Object.keys(LINT_ADAPTERS).find((tool) => LINT_ADAPTERS[tool]?.command === name);
}
