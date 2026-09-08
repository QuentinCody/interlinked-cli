import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { lintDigest } from "./discovery.js";
import { importedLintInvocation } from "./invocation.js";
import { type LintDiagnostic, parseImportedLint } from "./parsers.js";
import { parseSarif } from "./sarif.js";
import { checkLintSources, lintPath } from "./policy.js";
import type { ImportedLintFinding, LintImportEntry, LintImportPolicy, LintMeasurement } from "./types.js";

function executable({ root, cwd, command }: { root: string; cwd: string; command: string }): string {
    let directory = cwd;
    for (;;) {
        for (const parts of [["node_modules", ".bin", command], [".venv", "bin", command], ["vendor", "bin", command], ["bin", command]]) {
            const candidate = join(directory, ...parts);
            if (existsSync(candidate)) return candidate;
        }
        if (directory === root) return command;
        const parent = dirname(directory);
        if (parent === directory) return command;
        directory = parent;
    }
}

function finding(root: string, entry: LintImportEntry, row: LintDiagnostic): ImportedLintFinding {
    const absolute = isAbsolute(row.file) ? row.file : resolve(root, entry.scope, row.file);
    const file = relative(root, absolute).split("\\").join("/");
    const path = lintPath(root, file);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const anchor = lines[row.line - 1];
    if (anchor === undefined) throw new Error(`Stale lint location: ${file}:${row.line}`);
    const profile = entry.config === undefined ? {} : { config: entry.config };
    const identity = [entry.tool, entry.scope, file, row.rule, row.message, anchor.trim()];
    if (entry.config !== undefined) identity.push(entry.config);
    if (entry.targets || entry.flags) identity.push(JSON.stringify([entry.targets, entry.flags]));
    const fingerprint = lintDigest(JSON.stringify(identity));
    return { tool: entry.tool, scope: entry.scope, ...profile, file, line: row.line, rule: row.rule, message: row.message, fingerprint };
}

async function measureEntry(root: string, entry: LintImportEntry, timeoutMs: number): Promise<LintMeasurement> {
    try {
        const invocation = importedLintInvocation(root, entry);
        const cwd = lintPath(root, entry.scope);
        const result = await runProcessAsync(executable({ root, cwd, command: invocation.command }), invocation.args, { cwd, timeout: timeoutMs });
        if (result.timedOut || result.killed || result.code === null) throw new Error("Analyzer unavailable or timed out; no verdict");
        if (!invocation.successCodes.includes(result.code)) throw new Error(`Analyzer exited ${result.code}: ${result.stderr.slice(0, 500)}`);
        // Both a zero exit status with warnings and a nonzero lint exit must be parsed.
        const output = entry.tool === "stylelint" && !result.stdout.trim() ? result.stderr : result.stdout;
        const diagnostics = entry.report ? parseSarif(output) : parseImportedLint({ tool: entry.tool, output });
        const findings = diagnostics.map((row) => finding(root, entry, row));
        if (result.code !== 0 && findings.length === 0) throw new Error("Analyzer failed without usable diagnostics");
        return { entry, status: "measured", findings };
    } catch (error) {
        return { entry, status: "unavailable", findings: [], reason: error instanceof Error ? error.message : String(error) };
    }
}

/** One bounded batch; callers own project admission. No shell, installs, or automatic fixes. */
export async function measureImportedLint(root: string, policy: LintImportPolicy, options: { timeoutMs?: number; now?: () => number; cadence?: "hook" | "audit" | "all" } = {}): Promise<LintMeasurement[]> {
    checkLintSources(root, policy);
    const now = options.now ?? performance.now.bind(performance);
    const deadline = now() + (options.timeoutMs ?? 30_000);
    const results: LintMeasurement[] = [];
    for (const entry of entriesForCadence(policy, options.cadence)) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            results.push({ entry, status: "unavailable", findings: [], reason: "Lint batch budget exhausted; no verdict" });
        } else {
            results.push(await measureEntry(root, entry, remaining));
        }
    }
    // A configuration edit during execution cannot produce a valid baseline.
    checkLintSources(root, policy);
    return results;
}

function entriesForCadence(policy: LintImportPolicy, cadence = "all"): LintImportEntry[] {
    if (cadence === "all") return policy.entries;
    return policy.entries.filter((entry) => (entry.cadence ?? "hook") === cadence);
}
