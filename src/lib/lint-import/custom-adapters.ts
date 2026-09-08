import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { lintJson, lintObject } from "./json.js";
import type { LintImportEntry, LintReportAdapter } from "./types.js";

export const LINT_ADAPTER_PATH = ".interlinked/lint-adapters.json";
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh", "eval", "env", "cat", "tee", "rm"]);

export function isReportTool(tool: string): boolean { return /^sarif:[a-z][a-z0-9-]{0,63}$/.test(tool); }

function reportArgs(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 1000) throw new Error("SARIF adapter args must be an argument array");
    return value.map((arg: unknown) => {
        if (typeof arg !== "string" || arg.length > 16_000 || /[\0\r\n]/.test(arg)) throw new Error("Invalid SARIF adapter argument");
        if (/^--?(?:fix|write|autocorrect|apply)(?:[=-]|$)/.test(arg)) throw new Error("SARIF adapters must not apply automatic fixes");
        return arg;
    });
}

export function parseReportAdapter(raw: unknown): LintReportAdapter {
    const row = lintObject(raw);
    if (row.format !== "sarif") throw new Error("Custom lint adapters require SARIF output on stdout");
    if (typeof row.command !== "string" || !/^[\w./-]+$/.test(row.command) || SHELLS.has(basename(row.command).replace(/\.exe$/, ""))) throw new Error("SARIF adapter requires a direct analyzer executable, not a shell");
    const codes = row.successCodes ?? [0];
    if (!Array.isArray(codes) || codes.length === 0 || codes.length > 32 || !codes.includes(0)) throw new Error("Invalid SARIF adapter success codes");
    const successCodes = codes.map((code: unknown) => {
        if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 255) throw new Error("Invalid analyzer exit code");
        return code;
    });
    return { format: "sarif", command: row.command, args: reportArgs(row.args), successCodes };
}

/** Registry entries are reviewable declarations, never shell snippets or downloaded runners. */
export function declaredLintAdapters(pathFor: (file: string) => string): LintImportEntry[] {
    const path = pathFor(LINT_ADAPTER_PATH);
    if (!existsSync(path)) return [];
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Lint adapter registry must be a bounded regular file");
    const text = readFileSync(path, "utf8");
    if (text.length > 1_000_000) throw new Error("Lint adapter registry exceeds its read budget");
    const value = lintObject(lintJson(text));
    if (value.version !== 1 || !Array.isArray(value.adapters) || value.adapters.length > 100) throw new Error("Invalid lint adapter registry");
    const entries = value.adapters.map((raw: unknown) => declaredEntry(raw, pathFor));
    uniqueAdapters(entries);
    return entries;
}

function uniqueAdapters(entries: LintImportEntry[]): void {
    const ids = entries.map((entry) => `${entry.tool}:${entry.scope}`);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate SARIF adapter id/scope");
}

function declaredEntry(raw: unknown, pathFor: (file: string) => string): LintImportEntry {
    const row = lintObject(raw);
    const tool = `sarif:${String(row.id)}`;
    if (!isReportTool(tool) || typeof row.scope !== "string") throw new Error("SARIF adapter needs a stable id and working scope");
    pathFor(row.scope);
    if (!Array.isArray(row.configs) || row.configs.some((file: unknown) => typeof file !== "string")) throw new Error("SARIF adapter configs must list its configuration inputs");
    const sources = row.configs.map((file: string) => { pathFor(file); return file; });
    if (row.cadence !== undefined && row.cadence !== "hook" && row.cadence !== "audit") throw new Error("Invalid SARIF adapter cadence");
    return { tool, scope: row.scope, sources: [LINT_ADAPTER_PATH, ...sources], cadence: row.cadence ?? "audit", report: parseReportAdapter(row), evidence: [{ file: LINT_ADAPTER_PATH, line: 1, kind: "registry", label: tool }] };
}
