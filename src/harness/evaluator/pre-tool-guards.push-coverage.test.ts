import { afterEach, expect, it, vi } from "vitest";
import { evaluatePackageInstallGuard } from "./pre-tool-guards.js";
import { recordLockfileBaseline } from "./lockfile-install-check.js";
import { evaluatePackageInstall } from "./package-install-guard.js";
import type { HarnessEvent } from "../types.js";

vi.mock("./lockfile-install-check.js", () => ({ recordLockfileBaseline: vi.fn() }));
vi.mock("../package-allowlist.js", () => ({ loadAllowlist: vi.fn(() => ({})) }));
vi.mock("./package-install-guard.js", () => ({ evaluatePackageInstall: vi.fn(() => ({
    decision: "block", reason: "Package is not approved",
})) }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("simulates install policy without seeding a real lockfile snapshot", () => {
    vi.stubEnv("INTERLINKED_DISABLE_PACKAGE_GUARD", "0");
    const event: HarnessEvent = {
        hook_event: "PreToolUse", session_id: "dry-install", agent_source: "codex", timestamp: "t",
        cwd: "/tmp/simulated-install", dry_run: true,
    };
    const input = { command: "npm install unapproved-package@1.0.0" };
    expect(evaluatePackageInstallGuard(event, "Bash", input)).toEqual({
        decision: "block", reason: "Package is not approved",
    });
    expect(recordLockfileBaseline).not.toHaveBeenCalled();
    expect(evaluatePackageInstall).toHaveBeenCalledOnce();
    expect(evaluatePackageInstallGuard({ ...event, dry_run: false }, "Bash", input)?.decision).toBe("block");
    expect(recordLockfileBaseline).toHaveBeenCalledWith("dry-install", event.cwd, expect.any(Array));
});
