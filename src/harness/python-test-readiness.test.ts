import { afterEach, expect, it, vi } from "vitest";
import { pythonTestReadiness } from "./python-test-readiness.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { loadAllowlist } from "./package-allowlist.js";
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
vi.mock("./package-allowlist.js", async original => ({ ...await original<typeof import("./package-allowlist.js")>(), loadAllowlist: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("names the selected interpreter and proposes only operator-approved pins without installing", async () => {
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, timedOut: false, killed: false, stdout: '{"pytest":false,"pytest_cov":true,"coverage":true,"pip":true}', stderr: "" });
    vi.mocked(loadAllowlist).mockReturnValue({ version: 1, packages: { npm: {}, pypi: { pytest: { approved_at: "today", approved_by: "operator", version_range: "8.4.2" } }, cargo: {}, rubygems: {}, go: {}, composer: {}, maven: {}, gradle: {}, nuget: {} }, lockfile_snapshots: {} });
    const result = await pythonTestReadiness("/project", { pythonExecutable: "/project/.venv/bin/python" });
    expect(result.install).toEqual({ command: "/project/.venv/bin/python", args: ["-m", "pip", "install", "pytest==8.4.2"] });
    expect(result.status).toBe("unavailable");
    expect(result.behavioralEvidence).toBe("not-run");
    expect(runProcessAsync).toHaveBeenCalledTimes(1);
});
it("does not fall back when the project interpreter is unavailable", async () => {
    vi.mocked(runProcessAsync).mockResolvedValue({ code: null, timedOut: false, killed: false, stdout: "", stderr: "ENOENT" });
    const result = await pythonTestReadiness("/project", { pythonExecutable: "/missing/python" });
    expect(result.status).toBe("unavailable");
    expect(result.install).toBeNull();
    expect(runProcessAsync).toHaveBeenCalledTimes(1);
});
it.each(["null", "[]", "{}", "not json"])("rejects malformed readiness evidence: %s", async stdout => {
    vi.mocked(runProcessAsync).mockResolvedValue({ code: 0, timedOut: false, killed: false, stdout, stderr: "" });
    const result = await pythonTestReadiness("/project", { pythonExecutable: "/selected/python" });
    expect(result.status).toBe("unavailable");
    expect(result.install).toBeNull();
    expect(loadAllowlist).not.toHaveBeenCalled();
});
