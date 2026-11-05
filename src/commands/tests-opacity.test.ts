import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testsOpacityCommand } from "./tests-opacity.js";
import { discoverVitestUniverse } from "../harness/coverage-shards/discovery.js";

vi.mock("../harness/coverage-shards/discovery.js", () => ({ discoverVitestUniverse: vi.fn(), captureVitestEnvironment: () => ({ environment: {}, environmentHash: "fixture" }) }));
beforeEach(() => { vi.mocked(discoverVitestUniverse).mockReset().mockResolvedValue({ tests: ["src/pure.test.ts", "src/io.test.ts"], supportFiles: [] }); });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); process.exitCode = undefined; });

function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "tests-opacity-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    writeFileSync(join(root, "src/pure.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "src/io.ts"), 'import { readFileSync } from "node:fs";\nexport const read = (p: string) => readFileSync(p, "utf8");\n');
    writeFileSync(join(root, "src/pure.test.ts"), 'import { value } from "./pure";\n');
    writeFileSync(join(root, "src/io.test.ts"), 'import { read } from "./io";\n');
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    return root;
}

describe("tests opacity — positive (must fire)", () => {
    // test-contract: public-api — the command ranks the repository's opacity causes; --json carries the report
    it("P1: reports the ranked causes for a repository", async () => {
        const root = repository();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await testsOpacityCommand({ cwd: root, json: true });
        const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(printed.tests).toBe(2);
        expect(printed.causes.map((cause: { path: string }) => cause.path)).toEqual(["src/io.ts"]);
        expect(process.exitCode).toBeUndefined();
    });

    // test-contract: public-api — the runner's include/exclude and setupFiles scope determines the report, not test-like filenames alone.
    it("uses native discovery for the test universe and shared setup", async () => {
        const root = repository();
        writeFileSync(join(root, "src/setup.ts"), 'import { read } from "./io"; read("settings.json");');
        vi.mocked(discoverVitestUniverse).mockResolvedValue({ tests: ["src/pure.test.ts"], supportFiles: ["src/setup.ts"] });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await testsOpacityCommand({ cwd: root, json: true });
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ tests: 1, opaque_tests: 1,
            causes: [{ path: "src/io.ts", tests: 1, chain: ["src/pure.test.ts", "<runner support>", "src/setup.ts", "src/io.ts"] }] });
        expect(discoverVitestUniverse).toHaveBeenCalledWith(expect.any(String), expect.any(Number), {});
    });
});

describe("tests opacity — negative (must not fire)", () => {
    // test-contract: invariant — a bad --limit is a usage error (exit 2), never a silent default
    it("N1: rejects a non-positive limit", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await testsOpacityCommand({ cwd: repository(), limit: "0" });
        expect(process.exitCode).toBe(2);
        expect(String(error.mock.calls[0]?.[0])).toContain("--limit");
    });

    // test-contract: invariant — unavailable native discovery is unavailable evidence, not a clean guessed universe.
    it("reports discovery failure without printing a clean opacity report", async () => {
        vi.mocked(discoverVitestUniverse).mockRejectedValue(new Error("Vitest configuration unavailable"));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await testsOpacityCommand({ cwd: repository() });
        expect(process.exitCode).toBe(2);
        expect(String(error.mock.calls[0]?.[0])).toContain("Vitest configuration unavailable");
        expect(log).not.toHaveBeenCalled();
    });
});
