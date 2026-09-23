import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["unit", "integration", "e2e", "base"])("a real Vitest %s run emits correctly attributed repository evidence", (lane) => {
    const project = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "viz-lane-"));
    try {
        symlinkSync(join(project, "node_modules"), join(root, "node_modules"));
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        writeFileSync(join(root, "one.test.ts"), 'import { it, expect } from "vitest"; it("reporter contract", () => expect(1 + 1).toBe(2));');
        const config = lane === "base" ? "vitest.config.ts" : `vitest.${lane}.config.ts`;
        writeFileSync(join(root, config), `export default ${JSON.stringify({ test: { include: ["one.test.ts"],
            reporters: [[join(project, "src/lib/viz/reporter-vitest.ts"), { root }]], retry: 0 } })};`);
        execFileSync(process.execPath, [join(project, "node_modules/vitest/vitest.mjs"), "run", "--config", config, "--maxWorkers=1"],
            { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        const rows = readFileSync(join(root, ".interlinked/test-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(rows.map((row) => row.kind)).toEqual(["run_start", "file_start", "test", "run_end"]);
        expect(rows.every((row) => row.lane === lane)).toBe(true);
        expect(rows.at(-1)).toMatchObject({ passed: 1, failed: 0, skipped: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
