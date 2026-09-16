import { getOutputMode, output, outputError } from "../lib/output.js";
import { reviewChange } from "../harness/change-review.js";

export function testsReviewCommand(paths: string[], options: { cwd?: string; base?: string; json?: boolean }): void {
    const mode = getOutputMode(options);
    try {
        const result = reviewChange(options.cwd ?? process.cwd(), { paths, ...(options.base ? { base: options.base } : {}) });
        output(mode, result, { normal: () => `${result.status}: ${result.files.length} source/test files; ${result.gaps.length} gaps; behavioral evidence: not run\n` +
            [...result.findings.map(row => `${row.path}:${row.line}: ${row.text}`), ...result.gaps.map(row => `${row.path}: NOT REVIEWED: ${row.reason}`), ...result.review].join("\n") });
        if (result.status === "partial") process.exitCode = 1;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Change review unavailable"); }
}
