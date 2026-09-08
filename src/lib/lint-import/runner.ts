import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runProcessAsync, type RunProcessOptions } from "../../harness/check-engine/spawn-async.js";
import { runClippyWithIsolatedOutput } from "./clippy-output.js";
import { lintDigest } from "./discovery.js";
import { importedLintInvocation, type LintInvocation } from "./invocation.js";
import { type LintDiagnostic, parseImportedLint } from "./parsers.js";
import { parseSarif } from "./sarif.js";
import { checkLintSources, lintPath } from "./policy.js";
import { captureLintSourceSnapshot, checkLintSourceSnapshot, lintSnapshotLine, type LintSourceSnapshot } from "./source-snapshot.js";
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

function finding(root: string, entry: LintImportEntry, row: LintDiagnostic, snapshot: LintSourceSnapshot, deadline: number): ImportedLintFinding {
    const absolute = isAbsolute(row.file) ? row.file : resolve(root, entry.scope, row.file);
    const file = relative(root, absolute).split("\\").join("/");
    lintPath(root, file);
    const anchor = lintSnapshotLine(root, file, row.line, snapshot, deadline);
    const profile = entry.config === undefined ? {} : { config: entry.config };
    const identity = [entry.tool, entry.scope, file, row.rule, row.message, anchor.trim()];
    if (entry.config !== undefined) identity.push(entry.config);
    if (entry.targets || entry.flags) identity.push(JSON.stringify([entry.targets, entry.flags]));
    const fingerprint = lintDigest(JSON.stringify(identity));
    return { tool: entry.tool, scope: entry.scope, ...profile, file, line: row.line, rule: row.rule, message: row.message, fingerprint };
}

interface EntryMeasurement { measurement: LintMeasurement; snapshot?: LintSourceSnapshot }

function runAnalyzer(root: string, entry: LintImportEntry, invocation: LintInvocation, command: string, options: RunProcessOptions) {
    if (entry.tool === "clippy" && !entry.report) return runClippyWithIsolatedOutput(root, command, invocation.args, options);
    return runProcessAsync(command, invocation.args, options);
}

function unavailable(entry: LintImportEntry, error: unknown): LintMeasurement {
    return { entry, status: "unavailable", findings: [], reason: error instanceof Error ? error.message : String(error) };
}

async function measureEntry(root: string, entry: LintImportEntry, timeoutMs: number): Promise<EntryMeasurement> {
    try {
        const deadline = performance.now() + timeoutMs;
        const cwd = lintPath(root, entry.scope);
        const snapshot = captureLintSourceSnapshot(root, entry, deadline);
        // Target selection belongs inside the observed source interval: a file
        // added during expansion must not be silently absent from the run.
        const invocation = importedLintInvocation(root, entry);
        const command = executable({ root, cwd, command: invocation.command });
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Lint batch budget exhausted; no verdict");
        const result = await runAnalyzer(root, entry, invocation, command, { cwd, timeout: remaining });
        if (result.timedOut || result.killed || result.code === null) throw new Error("Analyzer unavailable or timed out; no verdict");
        if (!invocation.successCodes.includes(result.code)) throw new Error(`Analyzer exited ${result.code}: ${result.stderr.slice(0, 500)}`);
        // Both a zero exit status with warnings and a nonzero lint exit must be parsed.
        const useStderr = entry.tool === "stylelint" && !result.stdout.trim();
        // Stylelint's fallback requires complete, empty stdout: a captured
        // whitespace prefix cannot establish that the full report was empty.
        if (result.stdoutTruncated || (useStderr && result.stderrTruncated)) {
            const stream = result.stdoutTruncated ? "stdout" : "stderr";
            throw new Error(`Analyzer ${stream} report was truncated; no verdict`);
        }
        const output = useStderr ? result.stderr : result.stdout;
        const diagnostics = entry.report ? parseSarif(output) : parseImportedLint({ tool: entry.tool, output });
        checkLintSourceSnapshot(snapshot, captureLintSourceSnapshot(root, entry, deadline));
        const findings = diagnostics.map((row) => finding(root, entry, row, snapshot, deadline));
        if (result.code !== 0 && findings.length === 0) throw new Error("Analyzer failed without usable diagnostics");
        return { measurement: { entry, status: "measured", findings }, snapshot };
    } catch (error) {
        return { measurement: unavailable(entry, error) };
    }
}

/** One bounded batch; callers own project admission. No shell, installs, or automatic fixes. */
export async function measureImportedLint(root: string, policy: LintImportPolicy, options: { timeoutMs?: number; now?: () => number; cadence?: "hook" | "audit" | "all" } = {}): Promise<LintMeasurement[]> {
    checkLintSources(root, policy);
    const now = options.now ?? performance.now.bind(performance);
    const deadline = now() + (options.timeoutMs ?? 30_000);
    const results: EntryMeasurement[] = [];
    for (const entry of entriesForCadence(policy, options.cadence)) {
        const remaining = deadline - now();
        if (remaining <= 0) {
            results.push({ measurement: unavailable(entry, "Lint batch budget exhausted; no verdict") });
        } else {
            results.push(await measureEntry(root, entry, remaining));
        }
    }
    // A configuration edit during execution cannot produce a valid baseline.
    checkLintSources(root, policy);
    // An earlier profile can go stale while a later analyzer is running.
    return results.map(({ measurement, snapshot }) => {
        if (!snapshot) return measurement;
        try {
            checkLintSourceSnapshot(snapshot, captureLintSourceSnapshot(root, measurement.entry, performance.now() + Math.max(0, deadline - now())));
            return measurement;
        } catch (error) { return unavailable(measurement.entry, error); }
    });
}

function entriesForCadence(policy: LintImportPolicy, cadence = "all"): LintImportEntry[] {
    if (cadence === "all") return policy.entries;
    return policy.entries.filter((entry) => (entry.cadence ?? "hook") === cadence);
}
