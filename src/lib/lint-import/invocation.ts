import { matchesGlob } from "../path-glob.js";
import { LINT_ADAPTERS } from "./adapters.js";
import { validateLintArguments } from "./argv.js";
import { lintPath } from "./policy.js";
import type { LintImportEntry } from "./types.js";
import { lintSourceFiles, literalLintTargets } from "./source-files.js";
import { LINT_VALUE_OPTIONS } from "./option-specs.js";

export interface LintInvocation { command: string; args: string[]; successCodes: number[] }

const FILE_TARGET_TOOLS = new Set(["shellcheck", "hadolint"]);

function nativeOptionSyntax(tool: string, args: string[]): string[] {
    if (tool !== "phpcs") return args;
    const values = new Set(["--standard", ...(LINT_VALUE_OPTIONS.phpcs ?? [])]);
    const normalized: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const option = args[index] ?? "";
        if (!values.has(option)) { normalized.push(option); continue; }
        const value = args[++index];
        if (value === undefined) throw new Error(`Missing PHPCS option value: ${option}`);
        normalized.push(`${option}=${value}`);
    }
    return normalized;
}

function moduleTargets(entry: LintImportEntry): boolean {
    return entry.tool === "mypy" && (entry.flags ?? []).some((flag) => ["-p", "--package", "-m", "--module"].includes(flag));
}

function targetArguments(root: string, entry: LintImportEntry, defaults: string[]): string[] {
    if (moduleTargets(entry)) return entry.targets ?? [];
    const targets = entry.targets ?? defaults;
    if (!FILE_TARGET_TOOLS.has(entry.tool)) return targets;
    const cwd = lintPath(root, entry.scope);
    if (entry.targets !== undefined) return literalLintTargets(cwd, entry.targets);
    const files = lintSourceFiles(cwd).filter((file) => targets.some((target) => matchesGlob(file, target)));
    if (files.length === 0) throw new Error(`No ${entry.tool} source files found; no verdict`);
    return files;
}

/** Reporter replacement is explicit; semantic options and the original targets survive. */
export function importedLintInvocation(root: string, entry: LintImportEntry): LintInvocation {
    validateLintArguments(entry);
    if (entry.report) return { command: entry.report.command, args: [...entry.report.args], successCodes: entry.report.successCodes };
    const adapter = LINT_ADAPTERS[entry.tool];
    if (!adapter) throw new Error(`No execution adapter for ${entry.tool}`);
    const config = entry.config === undefined ? [] : [adapter.configFlag ?? "--config", lintPath(root, entry.config)];
    const args = [...adapter.prefix, ...config, ...(entry.flags ?? []), ...adapter.reporter, ...targetArguments(root, entry, adapter.targets)];
    if (entry.tool === "clippy") args.push("--", "--cap-lints=warn");
    return { command: adapter.command, args: nativeOptionSyntax(entry.tool, args), successCodes: adapter.successCodes };
}
