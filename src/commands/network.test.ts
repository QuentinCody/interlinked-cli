import { afterEach, expect, it, vi } from "vitest";
import { networkCheckCommand, networkCodexProfileCommand } from "./network.js";
import { checkNetworkAccess } from "../lib/network-access.js";
import { installCodexNetworkProfile } from "../lib/codex-network-profile.js";

vi.mock("../lib/network-access.js", async (original) => ({ ...await original<typeof import("../lib/network-access.js")>(), checkNetworkAccess: vi.fn() }));
vi.mock("../lib/codex-network-profile.js", async (original) => ({ ...await original<typeof import("../lib/codex-network-profile.js")>(), installCodexNetworkProfile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = undefined; });

it("reports failed probes with a nonzero exit and runtime-scoped JSON", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(checkNetworkAccess).mockResolvedValue({ schema_version: 1, observed_at: "now", scope: "current-process", cwd: "/fixture", runtime: { codex_sandbox: "seatbelt", network_disabled: true, thread_id: "blocked" }, reachable: false, probes: [{ endpoint: "https://example.com", reachable: false, failure: "dns" }], guidance: "runtime evidence" });
    await networkCheckCommand(["https://example.com"], { json: true });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ reachable: false, runtime: { thread_id: "blocked" } });
});

it("previews without writing a profile", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    networkCodexProfileCommand("research", { allow: ["https://example.com"], json: true });
    expect(installCodexNetworkProfile).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ name: "research", hosts: ["example.com"] });
});

it("reports invalid profile input without writes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    networkCodexProfileCommand("../escape", { allow: ["https://example.com"], json: true });
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("Profile names");
    expect(installCodexNetworkProfile).not.toHaveBeenCalled();
});
