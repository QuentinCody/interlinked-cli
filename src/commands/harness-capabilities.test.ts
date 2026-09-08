import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryHookCoverage } from "./harness-capabilities.js";

const mocks = vi.hoisted(() => ({ exists: vi.fn(), raw: vi.fn(), framed: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: mocks.exists }));
vi.mock("./harness-status-helpers.js", () => ({ queryHarness: mocks.raw }));
vi.mock("../harness/daemon-client.js", () => ({ createDaemonClient: () => ({ call: mocks.framed }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.exists.mockReturnValue(true); mocks.raw.mockResolvedValue(null); mocks.framed.mockResolvedValue({ readiness: "ready" }); });

describe("coverage control delivery", () => {
    it("does not treat malformed framed evidence as measured", async () => {
        mocks.exists.mockReturnValue(false);
        mocks.framed.mockResolvedValue({ readiness: "ready", checks: [{}] });
        expect(await queryHookCoverage("/repo", { operation: "status" })).toMatchObject({ readiness: "unmeasured", reason: expect.stringContaining("Invalid coverage daemon response") });
    });
    it("does not retry a mutation on another transport after an ambiguous response", async () => {
        const result = await queryHookCoverage("/repo", { operation: "accept_policy", digest: "reviewed" });
        expect(mocks.raw).toHaveBeenCalledExactlyOnceWith("/repo", { hook_event: "HookCoverage", request: { operation: "accept_policy", digest: "reviewed" } }, 10_000);
        expect(mocks.framed).not.toHaveBeenCalled();
        expect(result).toMatchObject({ readiness: "unmeasured", reason: expect.stringContaining("may already have completed") });
    });
    it("uses the framed endpoint directly when there is no raw endpoint", async () => {
        mocks.exists.mockReturnValue(false);
        await queryHookCoverage("/repo", { operation: "accept_policy", digest: "reviewed" });
        expect(mocks.raw).not.toHaveBeenCalled();
        expect(mocks.framed).toHaveBeenCalledExactlyOnceWith("daemon.coverage", { operation: "accept_policy", digest: "reviewed" }, { timeout_ms: 10_000 });
    });
    it("can retry a read-only status query", async () => {
        expect(await queryHookCoverage("/repo", { operation: "status" })).toEqual({ readiness: "ready" });
        expect(mocks.framed).toHaveBeenCalledOnce();
    });
});
