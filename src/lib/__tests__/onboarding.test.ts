import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCallTool,
	mockIsAuthenticated,
	mockIsLocalDevServer,
	mockResolveConfig,
	mockUpdateLocalConfig,
} = vi.hoisted(() => ({
	mockCallTool: vi.fn(),
	mockIsAuthenticated: vi.fn().mockReturnValue(true),
	mockIsLocalDevServer: vi.fn().mockReturnValue(false),
	mockResolveConfig: vi.fn().mockReturnValue({
		server_url: "https://test.example.com",
		workspace_id: "ws_test",
		agent_name: "TestAgent",
	}),
	mockUpdateLocalConfig: vi.fn(),
}));

vi.mock("../api-client.js", () => ({
	getClient: vi.fn(() => ({
		callTool: mockCallTool,
		isAuthenticated: mockIsAuthenticated,
		isLocalDevServer: mockIsLocalDevServer,
	})),
}));

vi.mock("../config.js", () => ({
	resolveConfig: mockResolveConfig,
	updateLocalConfig: mockUpdateLocalConfig,
}));

const { ensureRemoteOnboarding } = await import("../onboarding.js");

describe("ensureRemoteOnboarding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsAuthenticated.mockReturnValue(true);
		mockIsLocalDevServer.mockReturnValue(false);
		mockResolveConfig.mockReturnValue({
			server_url: "https://test.example.com",
			workspace_id: "ws_test",
			agent_name: "TestAgent",
		});
	});

	it("skips when agent_name is missing", async () => {
		mockResolveConfig.mockReturnValue({
			server_url: "https://test.example.com",
			workspace_id: "ws_test",
		});

		const result = await ensureRemoteOnboarding();

		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("agent_name_missing");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("skips when remote server requires auth and no token is available", async () => {
		mockIsAuthenticated.mockReturnValue(false);
		mockIsLocalDevServer.mockReturnValue(false);

		const result = await ensureRemoteOnboarding();

		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("not_authenticated");
		expect(mockCallTool).not.toHaveBeenCalled();
	});

	it("links remote identity and persists agent_handle", async () => {
		mockCallTool.mockResolvedValue({
			workspace: { name: "main" },
			agent: {
				name: "TestAgent",
				agent_handle: "ah_test.abc",
				is_new: false,
				reclaimed: true,
			},
		});

		const result = await ensureRemoteOnboarding();

		expect(mockCallTool).toHaveBeenCalledWith("get_started", {
			name: "TestAgent",
			program: "interlinked-cli",
		});
		expect(result.status).toBe("linked");
		expect(result.agentHandle).toBe("ah_test.abc");
		expect(result.reclaimedAgent).toBe(true);
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ agent_handle: "ah_test.abc" });
	});

	it("returns failed result on bootstrap errors", async () => {
		mockCallTool.mockRejectedValue(new Error("unreachable"));

		const result = await ensureRemoteOnboarding();

		expect(result.status).toBe("failed");
		expect(result.reason).toBe("bootstrap_failed");
		expect(result.error).toContain("unreachable");
	});

	it.each([null, undefined])("retains the configured name when bootstrap returns no identity: %s", async response => {
		mockCallTool.mockResolvedValue(response);
		expect(await ensureRemoteOnboarding()).toMatchObject({ status: "linked", agentName: "TestAgent", agentHandle: undefined });
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it.each([[], { agent: { agent_handle: 17 } }, { workspace: { name: false } }])("rejects malformed remote identity without persisting it: %j", async response => {
		mockCallTool.mockResolvedValue(response);
		expect(await ensureRemoteOnboarding()).toMatchObject({ status: "failed", reason: "bootstrap_failed", error: "Invalid agent bootstrap response" });
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("reports non-Error transport failures without throwing", async () => {
		mockCallTool.mockRejectedValue("remote disconnected");
		expect(await ensureRemoteOnboarding()).toMatchObject({ status: "failed", error: "remote disconnected" });
	});
});
