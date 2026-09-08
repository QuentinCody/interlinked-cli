import type { LintRuleDeclaration } from "./declarations.js";

/** A static inventory does not evaluate executable presets. */
export interface LintSource {
    tool: string;
    file: string;
    scope: string;
    kind: "config" | "manifest" | "ignore" | "script" | "dependency";
    declarations: string[];
    rules: LintRuleDeclaration[];
    digest: string;
    notes: string[];
}

export interface LintInventory {
    root: string;
    sources: LintSource[];
    warnings: string[];
    complete: boolean;
    invocations?: LintInvocationCandidate[];
}

export type LintCadence = "hook" | "audit";

export interface LintOrigin {
    file: string;
    line: number;
    kind: "package-script" | "ci" | "task" | "shell" | "registry" | "config";
    label: string;
}

export interface LintInvocationCandidate {
    origin: LintOrigin;
    command: string;
    scope: string;
    entry?: LintImportEntry;
    reason?: string;
}

export interface LintImportEntry {
    tool: string;
    scope: string;
    /** Explicit analyzer configuration, relative to the inventory root. */
    config?: string;
    sources: string[];
    /** Analyzer targets are relative to scope; flags are validated by its adapter. */
    targets?: string[];
    flags?: string[];
    cadence?: LintCadence;
    evidence?: LintOrigin[];
    report?: LintReportAdapter;
}

export interface LintReportAdapter {
    format: "sarif";
    command: string;
    args: string[];
    successCodes: number[];
}

export interface LintImportPolicy {
    version: 1;
    entries: LintImportEntry[];
    digests: Record<string, string>;
}

export interface ImportedLintFinding {
    tool: string;
    scope: string;
    config?: string;
    file: string;
    line: number;
    rule: string;
    message: string;
    fingerprint: string;
}

export interface LintMeasurement {
    entry: LintImportEntry;
    status: "measured" | "unavailable";
    findings: ImportedLintFinding[];
    reason?: string;
}

export interface LintBaseline {
    version: 1;
    entries: Record<string, Record<string, number>>;
}
