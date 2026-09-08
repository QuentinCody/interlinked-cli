import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { LINT_DETECTORS } from "./catalog.js";
import { lintRuleDeclarations } from "./declarations.js";
import { isLintInvocationFile, lintInvocationsInFile } from "./invocation-files.js";
import type { LintInventory, LintSource } from "./types.js";

const SKIP_DIRS = new Set([".git", ".interlinked", ".claude", ".codex", ".agents", ".stryker-tmp", ".wrangler", ".cache", "scratch", "node_modules", ".venv", "venv", "vendor", "target", "dist", "build", "coverage", "__pycache__", ".next", ".gradle"]);
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 1_000_000;
const MAX_DECLARATIONS = 100;
const MAX_DECLARATION_CHARS = 400;
const MANIFESTS = new Set(LINT_DETECTORS.flatMap((detector) => Object.keys(detector.manifests ?? {})));

export function lintDigest(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

function declarations(content: string): string[] {
    return content.split(/\r?\n/).map((line, index) => ({ text: line.trim(), line: index + 1 }))
        .filter(({ text }) => text.length > 0 && !text.startsWith("//") && !text.startsWith("#"))
        .slice(0, MAX_DECLARATIONS).map(({ text, line }) => `${line}: ${text.slice(0, MAX_DECLARATION_CHARS)}`);
}

function sourceFor({ tool, file, content, kind }: { tool: string; file: string; content: string; kind: LintSource["kind"] }): LintSource {
    const notes = ["Bounded declaration excerpts; effective presets, options and suppressions remain owned by the analyzer."];
    if (/\.[cm]?[jt]s$/.test(file)) notes.push("Executable configuration was inspected as text, not executed.");
    return { tool, file, scope: dirname(file), kind, declarations: declarations(content), rules: lintRuleDeclarations(content), digest: lintDigest(content), notes };
}

/** Callers confine the path first. Explicit selection still only reads bounded text. */
export function inspectLintInput({ root, file, tool, kind }: { root: string; file: string; tool: string; kind: LintSource["kind"] }): LintSource {
    const path = join(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Lint input must be a regular file: ${file}`);
    if (stat.size > MAX_BYTES) throw new Error(`Lint input exceeds ${MAX_BYTES} bytes: ${file}`);
    return sourceFor({ tool, file, content: readFileSync(path, "utf8"), kind });
}

function parseLintScripts(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || !("scripts" in value)) return {};
    const scripts = value.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    const commands: Record<string, string> = {};
    for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === "string") commands[name] = command;
    }
    return commands;
}

function packageScripts(file: string, content: string): LintSource[] {
    if (basename(file) !== "package.json") return [];
    // interlinked: defer json_parse_unsafe -- visitEntry catches malformed manifests and marks discovery incomplete; do not substitute empty scripts.
    const scripts = parseLintScripts(JSON.parse(content));
    return Object.entries(scripts).filter(([name]) => /lint|check|format/.test(name))
        .map(([name, value]) => ({ ...sourceFor({ tool: "custom-script", file, content, kind: "script" }), rules: [], declarations: [`scripts.${name}: ${value.slice(0, MAX_DECLARATION_CHARS)}`], notes: ["Custom scripts require review; discovery never executes scripts or installs packages."] }));
}

function unavailable(report: LintInventory, file: string, error: unknown): void {
    report.warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    report.complete = false;
}

function inspectFile(file: string, report: LintInventory): void {
    const name = basename(file);
    const possible = LINT_DETECTORS.filter((detector) => detector.files.test(name) || detector.manifests?.[name]);
    if (possible.length === 0 && !isLintInvocationFile(file)) return;
    const absolute = join(report.root, file);
    if (lstatSync(absolute).size > MAX_BYTES) {
        unavailable(report, file, `configuration exceeds ${MAX_BYTES} bytes; not inspected`);
        return;
    }
    const content = readFileSync(absolute, "utf8");
    const invocations = lintInvocationsInFile(file, content);
    if (invocations.length > 0) {
        report.invocations ??= [];
        report.invocations.push(...invocations);
        report.sources.push(sourceFor({ tool: "invocation", file, content, kind: "script" }));
    }
    for (const detector of possible) {
        const direct = detector.files.test(name);
        if (!direct && !detector.manifests?.[name]?.test(content)) continue;
        let kind: LintSource["kind"] = direct ? "config" : "manifest";
        if (/ignore|suppress/.test(name)) kind = "ignore";
        report.sources.push(sourceFor({ tool: detector.tool, file, content, kind }));
    }
    report.sources.push(...packageScripts(file, content));
}

function visitEntry({ directory, entry, report, pending }: { directory: string; entry: Dirent; report: LintInventory; pending: string[] }): void {
    const absolute = join(directory, entry.name);
    const file = relative(report.root, absolute).split("\\").join("/");
    if (entry.isSymbolicLink()) {
        if (LINT_DETECTORS.some((detector) => detector.files.test(entry.name)) || MANIFESTS.has(entry.name) || isLintInvocationFile(file)) {
            unavailable(report, file, "symlinked configuration requires review");
        }
        return;
    }
    if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(absolute);
        return;
    }
    if (!entry.isFile()) return;
    try { inspectFile(file, report); }
    catch (error) { unavailable(report, file, error); }
}

/** Includes dotfiles and nested packages without git; skips dependencies and symlinks. */
export function discoverLint(rootPath: string): LintInventory {
    const root = realpathSync(resolve(rootPath));
    const report: LintInventory = { root, sources: [], warnings: [], complete: true };
    const pending = [root];
    let visited = 0;
    while (pending.length > 0 && visited < MAX_ENTRIES) {
        const directory = pending.pop();
        if (!directory) break;
        try {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (++visited > MAX_ENTRIES) break;
                visitEntry({ directory, entry, report, pending });
            }
        } catch (error) { unavailable(report, relative(root, directory) || ".", error); }
    }
    if (visited >= MAX_ENTRIES) unavailable(report, ".", `discovery stopped at ${MAX_ENTRIES} entries`);
    report.sources.sort((a, b) => a.file.localeCompare(b.file) || a.tool.localeCompare(b.tool));
    return report;
}
