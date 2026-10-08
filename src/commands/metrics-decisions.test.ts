import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decisionsAction } from "./metrics-decisions.js";

it("initializes an opt-in configuration and refuses to overwrite it", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
        expect(await decisionsAction("init", undefined, { cwd: root })).toBe(0);
        expect(
            JSON.parse(readFileSync(join(root, ".interlinked", "decision-metrics.json"), "utf8")),
        ).toMatchObject({ enabled: false, hook: { enabled: false } });
        expect(await decisionsAction("catalog", undefined, { cwd: root })).toBe(0);
        const broken = join(root, "broken.json");
        writeFileSync(broken, '[{"id":"missing-fields"}]');
        expect(await decisionsAction("measure", broken, { cwd: root, plan: true })).toBe(2);
    } finally {
        log.mockRestore();
        error.mockRestore();
        rmSync(root, { recursive: true, force: true });
    }
});
