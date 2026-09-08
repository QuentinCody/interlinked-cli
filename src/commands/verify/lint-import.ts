import { existsSync } from "node:fs";
import { join } from "node:path";
import { runImportedLintAsync } from "../../harness/check-engine/tool-runners/lint-import.js";
import { LINT_POLICY_PATH } from "../../lib/lint-import/policy.js";

interface ImportedLintStream {
    cwd: string;
    opts: { only?: string | undefined; allChecks?: boolean };
    skipChecks: Set<string>;
    allFlaggedFiles: Set<string>;
}

/** Human verify shares the imported-lint runner with JSON verify and PostToolUse. */
export async function streamImportedLint(args: ImportedLintStream): Promise<void> {
    if (args.opts.only && args.opts.only !== "lint-import" && args.opts.only !== "lint_import") return;
    if (args.skipChecks.has("lint-import") || args.skipChecks.has("lint_import")) return;
    if (!existsSync(join(args.cwd, LINT_POLICY_PATH))) return;
    try {
        const findings = await runImportedLintAsync({ scope: { projectRoot: args.cwd, mode: "project", lintCadence: args.opts.allChecks ? "all" : "hook" }, timeoutMs: 30_000 });
        process.stderr.write(`\n  Imported lint: ${findings.length} findings above baseline\n`);
        for (const finding of findings) {
            args.allFlaggedFiles.add(finding.file);
            process.stderr.write(`    ${finding.file}:${finding.line} ${finding.message}\n`);
        }
    } catch (error) {
        process.stderr.write(`\n  Imported lint NOT CHECKED: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
