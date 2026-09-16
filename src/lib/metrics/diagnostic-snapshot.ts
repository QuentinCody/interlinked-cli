import { natural, record, stringList, textField } from "./evidence-json.js";
import { hashBytes } from "./inventory.js";
import type { JsonObject } from "../json-types.js";

export interface DiagnosticSnapshot {
    identity: string; profile: string; sourceHash: string; roleVersion: string; discovery: string;
    complete: boolean; exclusions: string[]; gaps: string[];
    files: { path: string; hash: string; language: string; sloc: number; flaggedLines: number }[];
    verbosity: { numerator: number; denominator: number; fraction: number | null };
    erosion: { numerator: number; denominator: number; fraction: number | null };
}

function finite(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Expected finite nonnegative diagnostic value");
    return value;
}
function digest(value: unknown): string {
    const text = textField(value, "digest");
    if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("Invalid diagnostic digest");
    return text;
}
function rows(value: unknown): JsonObject[] {
    if (!Array.isArray(value)) throw new Error("Expected diagnostic rows");
    return value.map(item => record(item, "row"));
}
function equalNumber(actual: number, expected: number): void {
    if (Math.abs(actual - expected) > 1e-9 * Math.max(1, expected)) throw new Error("Inconsistent diagnostic totals");
}
function ratio(value: unknown): DiagnosticSnapshot["verbosity"] {
    const row = record(value, "ratio"), numerator = finite(row.numerator), denominator = finite(row.denominator);
    if (numerator > denominator) throw new Error("Diagnostic numerator exceeds denominator");
    if (denominator === 0) {
        if (row.fraction !== null || row.state !== "not-applicable") throw new Error("Empty diagnostic denominator must be not-applicable");
        return { numerator, denominator, fraction: null };
    }
    if (row.state !== "measured") throw new Error("Unexpected diagnostic measurement state");
    const fraction = finite(row.fraction);
    equalNumber(fraction, numerator / denominator);
    return { numerator, denominator, fraction };
}
function file(value: JsonObject): DiagnosticSnapshot["files"][number] {
    const counts = record(value.counts, "line counts");
    const sloc = natural(value.sloc, "SLOC"), flaggedLines = natural(counts.union, "flagged lines");
    if (flaggedLines > sloc) throw new Error("Flagged lines exceed SLOC");
    return { path: textField(value.path, "file path"), hash: digest(value.sourceSha256),
        language: textField(value.language, "file language"), sloc, flaggedLines };
}
function scopeEntries(value: unknown): string[] {
    return rows(value).map(row => JSON.stringify([textField(row.path, "scope path"), textField(row.role, "role"), textField(row.reason, "reason")])).sort();
}

function validatePopulations(row: JsonObject, files: DiagnosticSnapshot["files"], verbosity: DiagnosticSnapshot["verbosity"], erosion: DiagnosticSnapshot["erosion"]): void {
    if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Duplicate diagnostic file");
    equalNumber(verbosity.numerator, files.reduce((total, file) => total + file.flaggedLines, 0));
    equalNumber(verbosity.denominator, files.reduce((total, file) => total + file.sloc, 0));
    const paths = new Set(files.map(file => file.path));
    let mass = 0, highMass = 0;
    for (const fn of rows(row.functions)) {
        if (!paths.has(textField(fn.file, "function file"))) throw new Error("Function references unmeasured file");
        const cc = natural(fn.cyclomatic, "cyclomatic"), sloc = natural(fn.sloc, "function SLOC");
        if (!cc || !sloc) throw new Error("Invalid function measurement");
        const expected = cc * Math.sqrt(sloc);
        equalNumber(finite(fn.mass), expected);
        equalNumber(finite(fn.highComplexityMass), cc > 10 ? expected : 0);
        mass += expected;
        highMass += cc > 10 ? expected : 0;
    }
    equalNumber(erosion.denominator, mass);
    equalNumber(erosion.numerator, highMass);
}

/** Validate comparison fields; a digest is identity, not authentication. */
export function parseDiagnosticSnapshot(value: unknown): DiagnosticSnapshot {
    const row = record(value, "diagnostic snapshot"), profile = record(row.profile, "profile"), scope = record(row.scope, "scope");
    if (row.schemaVersion !== 1 || profile.erosionThreshold !== 10) throw new Error("Unsupported diagnostic schema or erosion definition");
    const roleVersion = textField(scope.roleVersion, "role version"), parsers = stringList(row.parsers, "parsers");
    const identity = digest(row.measurementIdentity);
    if (identity !== hashBytes(JSON.stringify([profile, roleVersion, parsers]))) throw new Error("Diagnostic measurement identity does not match its contract");
    const files = rows(row.files).map(file).sort((a, b) => a.path.localeCompare(b.path));
    const verbosity = ratio(row.verbosity), erosion = ratio(row.erosion);
    validatePopulations(row, files, verbosity, erosion);
    const gaps = scopeEntries(scope.notMeasured), exclusions = scopeEntries(scope.exclusions);
    if (natural(scope.measuredFiles, "measured files") !== files.length || natural(scope.eligibleFiles, "eligible files") !== files.length + gaps.length) throw new Error("Inconsistent diagnostic population");
    const issues = stringList(scope.discoveryIssues, "discovery issues");
    const complete = gaps.length === 0 && issues.length === 0;
    if (scope.status !== (complete ? "complete" : "partial")) throw new Error("Inconsistent diagnostic completeness");
    if (complete && row.sourceHash !== hashBytes(JSON.stringify(files.map(file => [file.path, "product", file.hash])))) throw new Error("Diagnostic source identity does not match file population");
    return { identity, profile: textField(profile.id, "profile id"), sourceHash: digest(row.sourceHash), roleVersion,
        discovery: textField(scope.discovery, "discovery"), complete, gaps: [...gaps, ...issues], exclusions, files, verbosity, erosion };
}
