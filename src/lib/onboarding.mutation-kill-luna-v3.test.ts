import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCallTool, mockResolveConfig, mockUpdateLocalConfig } = vi.hoisted(() => ({
    mockCallTool: vi.fn(),
    mockResolveConfig: vi.fn(),
    mockUpdateLocalConfig: vi.fn(),
}));

vi.mock("./api-client.js", () => ({
    getClient: vi.fn(() => ({
        callTool: mockCallTool,
        isAuthenticated: vi.fn(() => true),
        isLocalDevServer: vi.fn(() => false),
    })),
}));

vi.mock("./config.js", () => ({
    resolveConfig: mockResolveConfig,
    updateLocalConfig: mockUpdateLocalConfig,
}));

const { ensureRemoteOnboarding } = await import("./onboarding.js");

describe("ensureRemoteOnboarding mutation contracts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveConfig.mockReturnValue({
            server_url: "https://test.example.com",
            workspace_id: "ws_test",
            agent_name: "ConfiguredAgent",
        });
    });

    // test-contract: a true server is_new flag remains observable as true.
    it("preserves the server is_new flag", async () => {
        mockCallTool.mockResolvedValue({
            agent: {
                name: "ServerAgent",
                is_new: true,
                reclaimed: false,
            },
        });

        const result = await ensureRemoteOnboarding();

        expect(result).toEqual({
            status: "linked",
            agentName: "ServerAgent",
            agentHandle: undefined,
            isNewAgent: true,
            reclaimedAgent: false,
            workspaceName: undefined,
        });
    });

    // test-contract: a nonblank server agent name replaces the configured name.
    it("uses a nonblank server agent name", async () => {
        mockCallTool.mockResolvedValue({
            agent: {
                name: "ServerAgent",
            },
        });

        const result = await ensureRemoteOnboarding();

        expect(result.agentName).toBe("ServerAgent");
        expect(mockCallTool).toHaveBeenCalledWith("get_started", {
            name: "ConfiguredAgent",
            program: "interlinked-cli",
        });
    });

    // test-contract: blank agent names and handles are treated as absent.
    it("falls back from blank values without persisting a blank handle", async () => {
        mockCallTool.mockResolvedValue({
            agent: {
                name: "   ",
                agent_handle: "   ",
            },
        });

        const result = await ensureRemoteOnboarding();

        expect(result).toEqual({
            status: "linked",
            agentName: "ConfiguredAgent",
            agentHandle: undefined,
            isNewAgent: false,
            reclaimedAgent: false,
            workspaceName: undefined,
        });
        expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
    });
});
