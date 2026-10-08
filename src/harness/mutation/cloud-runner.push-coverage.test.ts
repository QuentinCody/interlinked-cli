import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
    createCloudMutationRunner,
    describeErrorResponse,
    MutationRunPendingError,
    readEngineExitCode,
} from "./cloud-runner.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("preserves a pending job handle even when no underlying error was supplied", () => {
    const error = new MutationRunPendingError("job-retained", "https://runner.invalid");
    expect(error.name).toBe("MutationRunPendingError");
    expect(error.message).toBe("mutation run still pending (job job-retained)");
    expect(error.jobId).toBe("job-retained");
    expect(error.runnerUrl).toBe("https://runner.invalid");
    expect(Object.hasOwn(error, "cause")).toBe(false);
});

it.each(["null", "42", '["engine failed"]', '{"error":null}'])(
    "retains the raw error body when JSON %s contains no usable message",
    async (body) => {
        await expect(describeErrorResponse({
            ok: false, status: 500, json: async () => JSON.parse(body), text: async () => body,
        })).resolves.toBe(`mutation runner HTTP 500: ${body}`);
    },
);

it.each([null, "0", true, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "keeps an unknown or malformed claimed engine exit code %s distinct from success and absence",
    (exitCode) => {
        expect(readEngineExitCode({ engine: { exitCode } })).toBeNull();
        expect(readEngineExitCode({})).toBeUndefined();
    },
);

it.each([undefined, 0, 2, null])("reports parse loss and preserves engine status %s without inventing test-run evidence", async (exitCode) => {
    const cwd = mkdtempSync(join(tmpdir(), "cloud-runner-push-"));
    roots.push(cwd);
    const source = "export const ready = true;";
    const runner = createCloudMutationRunner({ url: "https://runner.invalid", timeoutMs: 1000, cwd }, async () => ({
        ok: true, status: 200, json: async () => ({
            files: { "src/ready.ts": { source, mutants: [{ status: "Survived" }] } },
            ...(exitCode === undefined ? {} : { engine: { exitCode } }),
        }),
    }));
    const result = await runner.run("src/ready.ts", source);
    expect(result.mutants).toEqual([]);
    expect(result.droppedMutants).toBe(1);
    expect(result.executedTestCount).toBeNull();
    expect(Object.hasOwn(result, "testRun")).toBe(false);
    expect(Object.hasOwn(result, "engineExitCode")).toBe(exitCode !== undefined);
    expect(result.engineExitCode).toBe(exitCode);
});
