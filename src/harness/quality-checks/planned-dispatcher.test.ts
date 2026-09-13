import { expect, it, vi } from "vitest";
import { TEST_DISPATCHERS } from "./test-dispatchers.js";
import { scheduleTests } from "../test-scheduler.js";
import { getProfileForFile } from "../language-profiles.js";

vi.mock("../test-scheduler.js", () => ({ scheduleTests: vi.fn() }));

it("submits an edited test to one shared plan instead of launching companion tests separately", async () => {
    const profile = getProfileForFile("src/a.test.ts");
    const dispatcher = TEST_DISPATCHERS.typescript;
    if (!profile || !dispatcher) throw new Error("TypeScript dispatcher unavailable");
    vi.mocked(scheduleTests).mockRejectedValue(new Error("Host capacity busy; request retained"));
    const result = await dispatcher({ profile, filePath: "src/a.test.ts", absPath: "/repo/src/a.test.ts",
        checkCwd: "/repo", timeoutMs: 5000, severity: "error", checkName: "affected_tests", maxDependentTests: 12 });
    expect(scheduleTests).toHaveBeenCalledExactlyOnceWith({ root: "/repo", paths: ["/repo/src/a.test.ts"], timeoutMs: 5000, maxTests: 12, waitForCapacity: false });
    expect(result).toEqual([{ name: "affected_tests_deferred", severity: "warning", file: "src/a.test.ts",
        message: "Affected test request retained", detail: "Host capacity busy; request retained" }]);
});

it("reports an unsupported configured runner without claiming a completed check", async () => {
    vi.clearAllMocks();
    const profile = getProfileForFile("src/a.ts"), dispatcher = TEST_DISPATCHERS.typescript;
    if (!profile || !dispatcher) throw new Error("TypeScript dispatcher unavailable");
    const result = await dispatcher({ profile: { ...profile, test_runner: {
        command: "npx jest", timeout_ms: 5000, severity: "error", description: "Jest project" } },
        filePath: "src/a.ts", absPath: "/repo/src/a.ts", checkCwd: "/repo", timeoutMs: 5000,
        severity: "error", checkName: "affected_tests" });
    expect(result).toEqual([expect.objectContaining({ name: "affected_tests_deferred",
        detail: "The configured runner is not Vitest; no run was scheduled." })]);
    expect(scheduleTests).not.toHaveBeenCalled();
});
