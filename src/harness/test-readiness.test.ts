import { expect, it, vi } from "vitest";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { testReadiness, testReadinessGuidance } from "./test-readiness.js";
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));

it("checks the project JavaScript runner without running or installing it", async () => {
    const result = await testReadiness(process.cwd(), "typescript");
    expect(result.status).toBe("ready");
    expect(result.interpreter).toContain("vitest");
    expect(result.behavioralEvidence).toBe("not-run");
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(testReadinessGuidance(result, "typescript")).toContain("no behavioral checks have run");
    expect(testReadinessGuidance(result, "typescript")).toContain("public contract");
});

it.each(["go", "rust"])("does not call a missing %s project ready just because the tool exists", async language => {
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, timedOut: false, killed: false, stdout: "tool version", stderr: "" });
    const result = await testReadiness(process.cwd(), language);
    expect(result.status).toBe("unavailable");
    expect(result.missing).toContain(language === "rust" ? "Cargo.toml" : "go.mod");
    expect(result.install).toBeNull();
});
