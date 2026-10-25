import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runArgvInOverlay } from "../overlay-command-runner.js";
import { runVitest } from "./index.js";

vi.mock("../overlay-command-runner.js", () => ({ runArgvInOverlay: vi.fn() }));
const roots: string[] = [];
beforeEach(() => { vi.mocked(runArgvInOverlay).mockReset(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "fbf-runner-")));
    roots.push(path);
    writeFileSync(join(path, "a.test.ts"), "test");
    return path;
}
describe("bounded Vitest evidence", () => {
    it.each([{ files: [] }, { files: ["missing.test.ts"] }])("never expands an empty or missing selection into a suite: %j", async ({ files }) => {
        vi.mocked(runArgvInOverlay).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 });
        expect(await runVitest(root(), files, 1000)).toEqual([]);
        expect(runArgvInOverlay).not.toHaveBeenCalled();
    });
    it("discards a partial report when the runner timed out", async () => {
        const dir = root();
        vi.mocked(runArgvInOverlay).mockImplementation(async argv => {
            const report = argv.find(arg => arg.startsWith("--outputFile="))!.slice("--outputFile=".length);
            writeFileSync(report, JSON.stringify({ testResults: [{ name: join(dir, "a.test.ts"), assertionResults: [{ fullName: "passes", status: "passed" }] }] }));
            return { exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 1000 };
        });
        expect(await runVitest(dir, ["a.test.ts"], 1000)).toEqual([]);
    });
});
