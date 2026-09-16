import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoverageRunOpts } from "./coverage-runner.js";
import { clearPythonCoverageReport } from "./pytest-case-evidence.js";

export interface PythonCoverageWorkspace {
    options: CoverageRunOpts;
    env?: Record<string, string>;
    dispose: () => void;
}

/** Own both JSON and coverage.py's database, while preserving cwd and pytest configuration. */
export function pythonCoverageWorkspace(options: CoverageRunOpts): PythonCoverageWorkspace {
    if (options.testCommand) {
        // Custom argv owns its report location; assertion evidence stays unmeasured.
        if (!clearPythonCoverageReport(options.coverageDir)) throw new Error("Previous Python coverage report could not be cleared");
        return { options, dispose: () => {} };
    }
    mkdirSync(options.coverageDir, { recursive: true });
    const owned = mkdtempSync(join(resolve(options.coverageDir), "python-"));
    return {
        options: { ...options, coverageDir: owned },
        env: { COVERAGE_FILE: join(owned, ".coverage") },
        dispose: () => {
            try { rmSync(owned, { recursive: true, force: true }); }
            catch { process.stderr.write(`[interlinked:coverage] Could not remove owned Python report directory: ${owned}\n`); }
        },
    };
}
