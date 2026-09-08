import type { LintDiagnostic } from "./parsers.js";
import { lintJson, lintObject } from "./policy.js";
import { reportArray as array, reportLine as line, reportString as string } from "./report-values.js";

function pylint(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const row = lintObject(raw);
        const rule = string(row["message-id"]);
        if (row.type === "fatal" || rule === "E0001") throw new Error("Pylint could not analyze the source");
        return { file: string(row.path), line: line(row.line), rule, message: string(row.message) };
    });
}

function shellcheck(value: unknown): LintDiagnostic[] {
    return array(lintObject(value).comments).map((raw) => {
        const row = lintObject(raw);
        const code = line(row.code);
        if (code < 2000) throw new Error("ShellCheck parsing/source failure prevents a complete measurement");
        return { file: string(row.file), line: line(row.line), rule: `SC${code}`, message: string(row.message) };
    });
}

function hadolint(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const row = lintObject(raw);
        const rule = string(row.code);
        if (rule === "DL1000") throw new Error("Hadolint could not parse the Dockerfile");
        return { file: string(row.file), line: line(row.line), rule, message: string(row.message) };
    });
}

function actionlint(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const row = lintObject(raw);
        const rule = string(row.kind);
        if (rule === "syntax-check") throw new Error("Actionlint could not parse the workflow");
        return { file: string(row.filepath), line: line(row.line), rule, message: string(row.message) };
    });
}

function phpcs(value: unknown): LintDiagnostic[] {
    const files = lintObject(lintObject(value).files);
    return Object.entries(files).flatMap(([file, raw]) => array(lintObject(raw).messages).map((message) => {
        const row = lintObject(message);
        return { file, line: line(row.line), rule: string(row.source), message: string(row.message) };
    }));
}

function phpstan(value: unknown): LintDiagnostic[] {
    const report = lintObject(value);
    if (array(report.errors).length > 0 || lintObject(report.totals).errors !== 0) throw new Error("PHPStan reports analysis errors");
    return Object.entries(lintObject(report.files)).flatMap(([file, raw]) => array(lintObject(raw).messages).map((message) => {
        const row = lintObject(message);
        return { file, line: line(row.line), rule: string(row.identifier ?? "analysis"), message: string(row.message) };
    }));
}

function psalm(value: unknown): LintDiagnostic[] {
    return array(value).map((raw) => {
        const row = lintObject(raw);
        const rule = string(row.type);
        if (rule === "ParseError") throw new Error("Psalm could not parse the source");
        return { file: string(row.file_name), line: line(row.line_from), rule, message: string(row.message) };
    });
}

function sqlfluff(value: unknown): LintDiagnostic[] {
    return array(value).flatMap((raw) => {
        const file = lintObject(raw);
        return array(file.violations).map((item) => {
            const row = lintObject(item);
            const rule = string(row.code);
            if (["PRS", "TMP", "LXR"].includes(rule)) throw new Error("SQLFluff parsing/templating failure prevents measurement");
            return { file: string(file.filepath), line: line(row.start_line_no ?? row.line_no), rule, message: string(row.description) };
        });
    });
}

function semgrep(value: unknown): LintDiagnostic[] {
    const report = lintObject(value);
    if (array(report.errors).length > 0) throw new Error("Semgrep reports analysis errors; no verdict");
    return array(report.results).map((raw) => {
        const row = lintObject(raw);
        return { file: string(row.path), line: line(lintObject(row.start).line), rule: string(row.check_id), message: string(lintObject(row.extra).message) };
    });
}

export const EXTRA_LINT_PARSERS: Readonly<Record<string, (value: unknown) => LintDiagnostic[]>> = { pylint, shellcheck, hadolint, actionlint, phpcs, phpstan, psalm, sqlfluff, semgrep };

function mypy(output: string): LintDiagnostic[] {
    return output.split(/\r?\n/).filter((text) => text.trim()).flatMap((text) => {
        const row = lintObject(lintJson(text));
        if (row.severity === "note") return [];
        const rule = string(row.code);
        if (rule === "syntax") throw new Error("Mypy could not parse the source");
        return [{ file: string(row.file), line: line(row.line), rule, message: string(row.message) }];
    });
}

function flake8(output: string): LintDiagnostic[] {
    return output.split(/\r?\n/).filter((text) => text.trim()).map((text) => {
        const [file, row, rule, ...message] = text.split("\t");
        if (rule === "E902" || rule === "E999") throw new Error("Flake8 reports an unreadable or unparsable file");
        return { file: string(file), line: line(Number(row)), rule: string(rule), message: string(message.join("\t")) };
    });
}

function prettier(output: string): LintDiagnostic[] {
    return output.split(/\r?\n/).filter((text) => text.trim()).map((file) => ({ file, line: 1, rule: "format", message: "File does not match the configured formatting rules" }));
}

export const TEXT_LINT_PARSERS: Readonly<Record<string, (output: string) => LintDiagnostic[]>> = { mypy, flake8, prettier };
