import { lintJson, lintObject } from "./policy.js";
import { EXTRA_LINT_PARSERS, TEXT_LINT_PARSERS } from "./parsers-extra.js";

export interface LintDiagnostic {
    file: string;
    line: number;
    rule: string;
    message: string;
}

function string(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new Error("Incomplete lint diagnostic");
    return value;
}

function line(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("Missing lint source location");
    return value;
}

function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error("Invalid lint report array");
    return value;
}

function eslintReport(value: unknown): LintDiagnostic[] {
    return array(value).flatMap((raw) => {
        const file = lintObject(raw);
        return array(file.messages).map((rawMessage) => {
            const message = lintObject(rawMessage);
            return { file: string(file.filePath), line: line(message.line), rule: string(message.ruleId), message: string(message.message) };
        });
    });
}

function oxlintReport(value: unknown): LintDiagnostic[] {
    const report = lintObject(value);
    if (typeof report.number_of_files !== "number" || !Number.isSafeInteger(report.number_of_files) || report.number_of_files < 1) {
        throw new Error("Oxlint report has no measured files");
    }
    return array(report.diagnostics).map((raw) => {
        const diagnostic = lintObject(raw);
        const span = lintObject(lintObject(array(diagnostic.labels)[0]).span);
        // Parser/configuration errors do not carry a lint rule code; never adopt them as debt.
        return { file: string(diagnostic.filename), line: line(span.line), rule: string(diagnostic.code), message: string(diagnostic.message) };
    });
}

function ruffReport(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const message = lintObject(raw);
        return { file: string(message.filename), line: line(lintObject(message.location).row), rule: string(message.code), message: string(message.message) };
    });
}

function golangciReport(value: unknown): LintDiagnostic[] {
    const report = lintObject(value);
    if (report.Issues === null) return [];
    return array(report.Issues).map((raw) => {
        const message = lintObject(raw);
        const position = lintObject(message.Pos);
        return { file: string(position.Filename), line: line(position.Line), rule: string(message.FromLinter), message: string(message.Text) };
    });
}

function swiftReport(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const message = lintObject(raw);
        return { file: string(message.file), line: line(message.line), rule: string(message.rule_id), message: string(message.reason) };
    });
}

function biomeReport(value: unknown): LintDiagnostic[] {
    const report = lintObject(value);
    const summary = lintObject(report.summary);
    if (summary.diagnosticsNotPrinted !== 0 || summary.skipped !== 0) throw new Error("Biome report is incomplete");
    return array(report.diagnostics).map((raw) => {
        const diagnostic = lintObject(raw);
        const location = lintObject(diagnostic.location);
        const rule = string(diagnostic.category);
        if (!rule.startsWith("lint/")) throw new Error("Biome parse/configuration failure prevents lint measurement");
        return { file: string(location.path), line: line(lintObject(location.start).line), rule, message: string(diagnostic.message) };
    });
}

function rubocopReport(value: unknown): LintDiagnostic[] {
    return array(lintObject(value).files).flatMap((raw) => {
        const file = lintObject(raw);
        return array(file.offenses).map((rawOffense) => {
            const offense = lintObject(rawOffense);
            return { file: string(file.path), line: line(lintObject(offense.location).start_line), rule: string(offense.cop_name), message: string(offense.message) };
        });
    });
}

function stylelintReport(value: unknown): LintDiagnostic[] {
    return array(value).flatMap((raw) => {
        const file = lintObject(raw);
        if (array(file.parseErrors ?? []).length > 0) throw new Error("Stylelint parse errors prevent a complete measurement");
        return array(file.warnings).map((rawWarning) => {
            const warning = lintObject(rawWarning);
            return { file: string(file.source), line: line(warning.line), rule: string(warning.rule), message: string(warning.text) };
        });
    });
}

function cargoMessage(value: Record<string, unknown>): LintDiagnostic[] {
    const message = lintObject(value.message);
    if (message.level !== "warning" && message.level !== "error") return [];
    const rule = string(lintObject(message.code).code);
    if (!rule.startsWith("clippy::")) throw new Error("Compiler diagnostics prevent a complete Clippy measurement");
    const spans = array(message.spans).map(lintObject).filter((span) => span.is_primary === true);
    if (spans.length === 0) throw new Error("Clippy diagnostic has no primary location");
    return spans.map((span) => ({ file: string(span.file_name), line: line(span.line_start), rule, message: string(message.message) }));
}

function clippyReport(output: string): LintDiagnostic[] {
    const findings: LintDiagnostic[] = [];
    let finished = false;
    for (const text of output.split(/\r?\n/).filter((row) => row.trim())) {
        const row = lintObject(lintJson(text));
        if (row.reason === "build-finished") finished = row.success === true;
        if (row.reason === "compiler-message") findings.push(...cargoMessage(row));
    }
    if (!finished) throw new Error("Clippy build did not complete successfully");
    return findings;
}

const PARSERS: Record<string, (value: unknown) => LintDiagnostic[]> = {
    ...EXTRA_LINT_PARSERS,
    biome: biomeReport,
    eslint: eslintReport,
    oxlint: oxlintReport,
    ruff: ruffReport,
    "golangci-lint": golangciReport,
    swiftlint: swiftReport,
    rubocop: rubocopReport,
    standardrb: rubocopReport,
    stylelint: stylelintReport,
};

export function parseImportedLint({ tool, output }: { tool: string; output: string }): LintDiagnostic[] {
    if (tool === "clippy") return clippyReport(output);
    const textParser = TEXT_LINT_PARSERS[tool];
    if (textParser) return textParser(output);
    const parser = PARSERS[tool];
    if (!parser) throw new Error(`No lint report parser for ${tool}`);
    return parser(lintJson(output));
}
