import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TestExecution } from "./test-run-receipt.js";
import { RecoveryTestRuns } from "./recovery-test-runs.js";

const mocks = vi.hoisted(() => ({ schedule: vi.fn(), language: vi.fn(), runtime: vi.fn() }));
vi.mock("./test-scheduler.js", () => ({ scheduleTests: mocks.schedule }));
vi.mock("./quality-checks/language-test-suite.js", () => ({ runLanguageTestSuite: mocks.language }));
vi.mock("./test-runtime.js", async original => ({ ...await original<typeof import("./test-runtime.js")>(), captureTestRuntime: mocks.runtime }));
const roots: string[] = [];
const check = { enabled: true, severity: "error" as const, timeout_ms: 1000, file_types: [""] };
const passed = (): TestExecution => ({ status: "passed", runId: "fresh-run", durationMs: 10, reused: false, reason: "fresh", output: "tests passed",
    plan: { version: 1, snapshot: "source", changedPaths: [], mode: "full", tests: [], omitted: [], reasons: [], estimatedSerialMs: null, reusable: false } });
beforeEach(() => { vi.resetAllMocks(); mocks.schedule.mockResolvedValue(passed()); mocks.runtime.mockResolvedValue({ hash: "runtime" }); });
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture(count = 65) {
    const root = mkdtempSync(join(tmpdir(), "recovery-tests-")); roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    const paths = Array.from({ length: count }, (_, index) => join(root, `${index}.ts`));
    paths.forEach(path => writeFileSync(path, "export const value = 1;\n"));
    return { root, paths, runs: new RecoveryTestRuns(root, paths, Date.now() + 60_000) };
}
function options(root: string, paths: string[]) { return { root, paths, timeoutMs: 1000, maxWorkers: 2, waitForCapacity: true, stage: "edit" as const }; }

it("runs one complete project input union across several 32-file recovery batches", async () => {
    const { root, paths, runs } = fixture();
    const first = await runs.vitest(options(root, paths.slice(0, 32)), check);
    const last = await runs.vitest(options(root, paths.slice(64)), check);
    expect(first).toEqual(passed());
    expect(last).toEqual(first);
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith({ ...options(root, paths), paths });
});

it.each(["failed", "deferred", "stale", "empty"] as const)("retains a %s outcome without spending another suite on later batches", async status => {
    const { root, paths, runs } = fixture();
    mocks.schedule.mockResolvedValue({ ...passed(), status, reason: "original result", output: "original evidence" });
    await runs.vitest(options(root, paths.slice(0, 32)), check);
    const later = await runs.vitest(options(root, paths.slice(32)), check);
    expect(later).toMatchObject({ status, reason: "original result", output: "original evidence" });
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it("retains a runner rejection for the job instead of retrying it for every batch", async () => {
    const { root, paths, runs } = fixture();
    mocks.schedule.mockRejectedValue(new Error("host capacity unavailable"));
    await expect(runs.vitest(options(root, paths.slice(0, 32)), check)).rejects.toThrow("host capacity unavailable");
    await expect(runs.vitest(options(root, paths.slice(32)), check)).rejects.toThrow("host capacity unavailable");
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it.each(["requested", "other-source", "fixture", "environment"])("refuses prior passing evidence after a %s change", async kind => {
    const { root, paths, runs } = fixture();
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, "fixture.txt"), "before");
    writeFileSync(join(root, ".interlinked/test-dependencies.json"), JSON.stringify({ version: 1, tests: { "0.test.ts": ["fixture.txt"] } }));
    await runs.vitest(options(root, paths.slice(0, 32)), check);
    if (kind === "environment") vi.stubEnv("RECOVERY_TEST_INPUT", "changed");
    else writeFileSync(kind === "requested" ? paths[0]! : join(root, kind === "fixture" ? "fixture.txt" : "other.ts"), "changed");
    await expect(runs.vitest(options(root, paths.slice(32)), check)).rejects.toThrow("inputs changed");
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it("refuses a change during the shared execution and retains that outcome for the job", async () => {
    const { root, paths, runs } = fixture();
    mocks.schedule.mockImplementation(async () => { writeFileSync(paths[0]!, "changed"); return passed(); });
    await expect(runs.vitest(options(root, paths.slice(0, 32)), check)).rejects.toThrow("inputs changed");
    await expect(runs.vitest(options(root, paths.slice(32)), check)).rejects.toThrow("inputs changed");
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it("revalidates a runtime identity when the execution claims one", async () => {
    const { root, paths, runs } = fixture();
    mocks.schedule.mockResolvedValue({ ...passed(), runtimeVerified: true, plan: { ...passed().plan, runtimeHash: "runtime" } });
    await runs.vitest(options(root, paths.slice(0, 32)), check);
    mocks.runtime.mockResolvedValue({ hash: "different-runtime" });
    await expect(runs.vitest(options(root, paths.slice(32)), check)).rejects.toThrow("runtime changed");
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
});

it("does not accept paths that were never part of the planned cohort", async () => {
    const { root, runs } = fixture();
    await expect(runs.vitest(options(root, [join(root, "new.ts")]), check)).rejects.toThrow("planned");
    expect(mocks.schedule).not.toHaveBeenCalled();
});

it("keeps nested projects separate and does not retain results into a new job", async () => {
    const { root, paths } = fixture(2);
    const nested = join(root, "nested"); mkdirSync(nested); writeFileSync(join(nested, "package.json"), "{}");
    const child = join(nested, "child.ts"); writeFileSync(child, "export const child = 1;");
    const runs = new RecoveryTestRuns(root, [...paths, child], Date.now() + 60_000);
    await runs.vitest(options(root, paths), check);
    await runs.vitest(options(nested, [child]), check);
    await new RecoveryTestRuns(root, paths, Date.now() + 60_000).vitest(options(root, paths), check);
    expect(mocks.schedule.mock.calls.map(call => [call[0].root, call[0].paths])).toEqual([[root, paths], [nested, [child]], [root, paths]]);
});

it("shares a native project test execution across its receipt batches", async () => {
    const { root } = fixture(0);
    writeFileSync(join(root, "pyproject.toml"), "");
    const paths = [join(root, "one.py"), join(root, "two.py")];
    paths.forEach(path => writeFileSync(path, "value = 1\n"));
    const runs = new RecoveryTestRuns(root, paths, Date.now() + 60_000);
    const options = { root, language: "python" as const, timeoutMs: 1000, recovery: true };
    mocks.language.mockResolvedValue({ status: "passed", scope: "project", reusable: false, durationMs: 1, reason: "pytest passed", output: "1 passed" });
    await runs.language(options, paths.slice(0, 1), check);
    const later = await runs.language(options, paths.slice(1), check);
    expect(later).toMatchObject({ status: "passed", output: "1 passed" });
    expect(mocks.language).toHaveBeenCalledExactlyOnceWith(options);
});

function nativeFixture() {
    const { root } = fixture(0);
    writeFileSync(join(root, "pyproject.toml"), "");
    mkdirSync(join(root, "fixtures"));
    writeFileSync(join(root, "fixtures/value.txt"), "1");
    const paths = [join(root, "one.py"), join(root, "two.py")];
    paths.forEach(path => writeFileSync(path, "value = 1\n"));
    const suite = { root, language: "python" as const, timeoutMs: 1000, recovery: true };
    mocks.language.mockResolvedValue({ status: "passed", scope: "project", reusable: false, durationMs: 1, reason: "pytest passed", output: "1 passed" });
    return { root, paths, suite, runs: new RecoveryTestRuns(root, paths, Date.now() + 60_000) };
}

it.each([["an undeclared fixture", "fixtures/value.txt"], ["an asset", "data.bin"]])("refuses a native pass after %s changes between batches", async (_, file) => {
    // test-contract: bug — a native suite has no runtime validation, so every file it could read is part of the witness
    const { root, paths, suite, runs } = nativeFixture();
    writeFileSync(join(root, "data.bin"), "a");
    await runs.language(suite, paths.slice(0, 1), check);
    writeFileSync(join(root, file), "changed");
    await expect(runs.language(suite, paths.slice(1), check)).rejects.toThrow(`inputs changed since the shared execution began: ${join(root, file)}`);
    expect(mocks.language).toHaveBeenCalledTimes(1);
});

it("shares a native pass when the runner writes only its own cache output", async () => {
    // test-contract: bug — pytest's first run creates .pytest_cache/README.md and __pycache__ bytecode; neither is input drift
    const { root, paths, suite, runs } = nativeFixture();
    mocks.language.mockImplementation(async () => {
        mkdirSync(join(root, ".pytest_cache/v/cache"), { recursive: true });
        writeFileSync(join(root, ".pytest_cache/README.md"), "# pytest cache directory #\n");
        writeFileSync(join(root, ".pytest_cache/v/cache/nodeids"), "[]");
        mkdirSync(join(root, "__pycache__"));
        writeFileSync(join(root, "__pycache__/one.cpython-312.pyc"), "bytecode");
        return { status: "passed", scope: "project", reusable: false, durationMs: 1, reason: "pytest passed", output: "1 passed" };
    });
    await expect(runs.language(suite, paths.slice(0, 1), check)).resolves.toMatchObject({ status: "passed" });
    await expect(runs.language(suite, paths.slice(1), check)).resolves.toMatchObject({ status: "passed" });
    expect(mocks.language).toHaveBeenCalledTimes(1);
});
