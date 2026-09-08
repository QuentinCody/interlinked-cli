import { existsSync, readFileSync } from "node:fs";
import { trustedBaselineValue } from "../../harness/evaluator/baseline-effect-guard.js";
import { lintEntryKey } from "./identity.js";
import { LINT_BASELINE_PATH, lintObject, lintPath, writeLintJson } from "./policy.js";
import type { ImportedLintFinding, LintBaseline, LintMeasurement } from "./types.js";

export function loadLintBaseline(root: string): LintBaseline {
    const path = lintPath(root, LINT_BASELINE_PATH);
    const trusted = trustedBaselineValue(root, LINT_BASELINE_PATH);
    if (trusted === null && !existsSync(path)) return { version: 1, entries: {} };
    const raw = lintObject(JSON.parse(trusted ?? readFileSync(path, "utf8")));
    if (raw.version !== 1) throw new Error("Unsupported lint baseline version");
    const entries = lintObject(raw.entries);
    for (const counts of Object.values(entries)) {
        for (const [fingerprint, count] of Object.entries(lintObject(counts))) {
            if (!/^[a-f0-9]{64}$/.test(fingerprint) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
                throw new Error("Invalid lint baseline fingerprint/count");
            }
        }
    }
    // SAFETY: all entry values and counts were validated above.
    return { version: 1, entries: entries as LintBaseline["entries"] };
}

function countsFor(findings: ImportedLintFinding[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const finding of findings) counts[finding.fingerprint] = (counts[finding.fingerprint] ?? 0) + 1;
    return counts;
}

export function newLintFindings(measurement: LintMeasurement, baseline: LintBaseline): ImportedLintFinding[] {
    const available = { ...baseline.entries[lintEntryKey(measurement.entry)] };
    return measurement.findings.filter((finding) => {
        const remaining = available[finding.fingerprint] ?? 0;
        if (remaining === 0) return true;
        available[finding.fingerprint] = remaining - 1;
        return false;
    });
}

/** Seed previously unadopted scopes explicitly; existing scopes can only retire allowances. */
export function tightenLintBaseline(root: string, measurements: LintMeasurement[]): LintBaseline {
    if (measurements.some((measurement) => measurement.status !== "measured")) throw new Error("Cannot baseline an incomplete lint run");
    const baseline = loadLintBaseline(root);
    for (const measurement of measurements) {
        const key = lintEntryKey(measurement.entry);
        const current = countsFor(measurement.findings);
        const previous = baseline.entries[key];
        if (previous === undefined) {
            baseline.entries[key] = current;
            continue;
        }
        baseline.entries[key] = Object.fromEntries(Object.entries(previous).map(([fingerprint, count]) => [fingerprint, Math.min(count, current[fingerprint] ?? 0)]));
    }
    writeLintJson(root, LINT_BASELINE_PATH, baseline);
    return baseline;
}

/** Ordinary checks retire existing allowances, without adopting any new debt implicitly. */
export function retireLintDebt(root: string, measurements: LintMeasurement[]): LintBaseline {
    const baseline = loadLintBaseline(root);
    const adopted = measurements.filter((measurement) => Object.hasOwn(baseline.entries, lintEntryKey(measurement.entry)));
    if (adopted.length === 0) return baseline;
    return tightenLintBaseline(root, adopted);
}
