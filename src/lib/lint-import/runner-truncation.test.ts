import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runImportedLintAsync } from "../../harness/check-engine/tool-runners/lint-import.js";
import { tightenLintBaseline } from "./baseline.js";
import { discoverLint } from "./discovery.js";
import { LINT_BASELINE_PATH, LINT_POLICY_PATH, planLintImport, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";

const directories: string[] = [];

afterEach(() => {
    for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps adopted debt when a real analyzer's text report exceeds the capture limit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-truncation-")));
    directories.push(root);
    mkdirSync(join(root, ".venv", "bin"), { recursive: true });
    writeFileSync(join(root, ".flake8"), "[flake8]\nmax-line-length = 88\n");
    writeFileSync(join(root, "a.py"), "import os\n");
    writeFileSync(join(root, "b.py"), "import sys\n");
    const executable = join(root, ".venv", "bin", "flake8");
    const header = `#!${process.execPath}\nconst fs = require('node:fs');\n`;
    writeFileSync(executable, `${header}fs.writeSync(1, 'a.py\\t1\\tF401\\tunused os\\nb.py\\t1\\tF401\\tunused sys\\n');\nprocess.exitCode = 1;\n`);
    chmodSync(executable, 0o700);
    const { policy } = planLintImport(discoverLint(root));
    writeLintJson(root, LINT_POLICY_PATH, policy);
    const complete = await measureImportedLint(root, policy);
    expect(complete[0]?.status).toBe("measured");
    expect(complete[0]?.findings.map(({ file }) => file)).toEqual(["a.py", "b.py"]);
    tightenLintBaseline(root, complete);
    const baselinePath = join(root, LINT_BASELINE_PATH);
    const baselineBefore = readFileSync(baselinePath, "utf8");

    // Exercise the real subprocess capture. A long first message leaves a
    // parseable prefix, while the second file's diagnostic is beyond the cap.
    // Output stays in the runner's bounded buffer, never the test console.
    writeFileSync(executable, `${header}
fs.writeSync(1, 'a.py\\t1\\tF401\\t');
for (let index = 0; index < 192; index++) fs.writeSync(1, 'x'.repeat(65536));
fs.writeSync(1, '\\nb.py\\t1\\tF401\\tunused sys\\n');
process.exitCode = 1;
`);
    const incomplete = await measureImportedLint(root, policy);
    expect(incomplete[0]?.status).toBe("unavailable");
    expect(incomplete[0]?.reason).toBe("Analyzer stdout report was truncated; no verdict");
    expect(incomplete[0]?.findings).toEqual([]);
    expect(() => tightenLintBaseline(root, incomplete)).toThrow("Cannot baseline an incomplete lint run");
    await expect(runImportedLintAsync({
        scope: { projectRoot: root, mode: "project" },
        timeoutMs: 10_000,
    })).rejects.toThrow("Analyzer stdout report was truncated; no verdict");
    expect(readFileSync(baselinePath, "utf8")).toBe(baselineBefore);
}, 20_000);
