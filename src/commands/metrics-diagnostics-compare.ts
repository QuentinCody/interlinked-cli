import { readFileSync, statSync } from "node:fs";
import { compareDiagnosticSnapshots } from "../lib/metrics/diagnostic-compare.js";
import { parseDiagnosticSnapshot } from "../lib/metrics/diagnostic-snapshot.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

function load(path: string) {
    if (statSync(path).size > 32 * 1024 * 1024) throw new Error("Diagnostic snapshot exceeds 32 MiB");
    return parseDiagnosticSnapshot(JSON.parse(readFileSync(path, "utf8")));
}

export function metricsDiagnosticsCompareCommand(before: string, after: string, options: { json?: boolean; short?: boolean }): void {
    const mode = getOutputMode(options);
    try {
        const result = compareDiagnosticSnapshots(load(before), load(after));
        const summary = result.comparable ? "Diagnostic snapshots comparable; no quality verdict" : `No overall comparison: ${result.reasons.join("; ")}`;
        const lines = [summary];
        for (const key of ["verbosity", "erosion"] as const) {
            const value = result[key];
            lines.push(`${key}: absolute numerator ${value.before.numerator} → ${value.after.numerator}; denominator ${value.before.denominator} → ${value.after.denominator}`);
            if (value.dilution) lines.push(`${key}: lower ratio without lower absolute burden; denominator dilution`);
        }
        output(mode, result, { normal: () => [...lines, ...result.limitations].join("\n"), short: () => summary });
        if (!result.comparable) process.exitCode = 1;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Diagnostic comparison failed");
    }
}
