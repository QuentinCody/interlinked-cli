import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireString } from "../../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockResetState,
	mockInitConfig,
	mockReadLocalConfig,
	mockReadSharedConfig,
	mockResolveConfig,
	mockUpdateLocalConfig,
	mockWriteSharedConfig,
	mockEnsureRemoteOnboarding,
} = vi.hoisted(() => {
	const state: {
		server_url: string; workspace_id: string;
		default_workspace_key: string | undefined; default_project: string | undefined;
		agent_name: string; active_server: string;
		servers: { production: { server_url: string; workspace_id: string } };
	} = {
		server_url: "https://initial.example.com",
		workspace_id: "ws_initial",
		default_workspace_key: undefined,
		default_project: undefined,
		agent_name: "InitialAgent",
		active_server: "production",
		servers: {
			production: {
				server_url: "https://initial.example.com",
				workspace_id: "ws_initial",
			},
		},
	};

	const resetState = () => {
		state.server_url = "https://initial.example.com";
		state.workspace_id = "ws_initial";
		state.default_workspace_key = undefined;
		state.default_project = undefined;
		state.agent_name = "InitialAgent";
		state.active_server = "production";
		state.servers.production.server_url = "https://initial.example.com";
		state.servers.production.workspace_id = "ws_initial";
	};

	return {
		mockResetState: vi.fn(resetState),
		mockInitConfig: vi.fn((opts: { serverUrl?: string }) => {
			if (opts.serverUrl) {
				state.server_url = opts.serverUrl;
				state.servers.production.server_url = opts.serverUrl;
			}
		}),
		mockReadLocalConfig: vi.fn(() => ({
			active_server: state.active_server,
			servers: {
				production: {
					...state.servers.production,
				},
			},
		})),
		mockReadSharedConfig: vi.fn(() => ({
			version: 1 as const,
			server_url: state.server_url,
			...(state.default_workspace_key
				? { default_workspace_key: state.default_workspace_key }
				: {}),
			...(state.default_project ? { default_project: state.default_project } : {}),
		})),
		mockResolveConfig: vi.fn(() => ({
			server_url: state.server_url,
			workspace_id: state.workspace_id,
			default_workspace_key: state.default_workspace_key,
			default_project: state.default_project,
			agent_name: state.agent_name,
		})),
		mockUpdateLocalConfig: vi.fn((updates: Record<string, unknown>) => {
			if (typeof updates.workspace_id === "string") {
				state.workspace_id = updates.workspace_id;
			}
			if (typeof updates.agent_name === "string") {
				state.agent_name = updates.agent_name;
			}
			const servers = parseWire(updates.servers, wireOptional(wireObject({ "production": wireAbsentOptional(wireOptional(wireObject({ "workspace_id": wireAbsentOptional(wireOptional(wireString)), "server_url": wireAbsentOptional(wireOptional(wireString)) }))) })), "test JSON value");
			if (servers?.production?.workspace_id) {
				state.servers.production.workspace_id = servers.production.workspace_id;
			}
			if (servers?.production?.server_url) {
				state.servers.production.server_url = servers.production.server_url;
			}
		}),
		mockWriteSharedConfig: vi.fn(
			(next: {
				version: 1;
				server_url: string;
				default_workspace_key?: string;
				default_project?: string;
			}) => {
				state.server_url = next.server_url;
				state.default_workspace_key = next.default_workspace_key;
				state.default_project = next.default_project;
			},
		),
		mockEnsureRemoteOnboarding: vi.fn(),
	};
});

vi.mock("../../lib/config.js", () => ({
	initConfig: mockInitConfig,
	readLocalConfig: mockReadLocalConfig,
	readSharedConfig: mockReadSharedConfig,
	resolveConfig: mockResolveConfig,
	updateLocalConfig: mockUpdateLocalConfig,
	writeSharedConfig: mockWriteSharedConfig,
}));

vi.mock("../../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: mockEnsureRemoteOnboarding,
}));

describe("attach command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResetState();
		process.exitCode = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("when updating local settings and linking remote identity", () => {
		interface ParsedAttachPayload {
			server_url: string;
			workspace_id?: string;
			default_workspace_key?: string;
			default_project?: string;
			agent_name?: string;
			remote: { status: string; agent_handle?: string };
		}

		async function runAttachAndCapturePayload(): Promise<ParsedAttachPayload> {
			mockEnsureRemoteOnboarding.mockResolvedValue({
				status: "linked",
				agentName: "Worker-Alpha",
				agentHandle: "ah_test.123",
				isNewAgent: false,
				reclaimedAgent: true,
				workspaceName: "main",
			});

			const { attachCommand } = await import("../attach.js");
			await attachCommand({
				server: "https://remote.example.com",
				workspace: "ws_abc123",
				workspaceKey: "mcp-client-bio",
				project: "main",
				agent: "Worker-Alpha",
				json: true,
			});

			const payloadRaw = parseWire(vi.mocked(console.log).mock.calls.at(-1)?.[0], wireString, "test JSON value");
			return parseWire(JSON.parse(payloadRaw), wireObject({ "server_url": wireString, "workspace_id": wireAbsentOptional(wireString), "default_workspace_key": wireAbsentOptional(wireString), "default_project": wireAbsentOptional(wireString), "agent_name": wireAbsentOptional(wireString), "remote": wireObject({ "status": wireString, "agent_handle": wireAbsentOptional(wireString) }) }), "test JSON value");
		}

		it("initializes config with the given server URL", async () => {
			await runAttachAndCapturePayload();
			expect(mockInitConfig).toHaveBeenCalledWith({
				serverUrl: "https://remote.example.com",
			});
		});

		it("writes shared config with workspace_key and project defaults", async () => {
			await runAttachAndCapturePayload();
			expect(mockWriteSharedConfig).toHaveBeenCalledWith({
				version: 1,
				server_url: "https://remote.example.com",
				default_workspace_key: "mcp-client-bio",
				default_project: "main",
			});
		});

		it("persists agent_name to local config", async () => {
			await runAttachAndCapturePayload();
			expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
				expect.objectContaining({ agent_name: "Worker-Alpha" }),
			);
		});

		it("invokes remote onboarding with the server URL", async () => {
			await runAttachAndCapturePayload();
			expect(mockEnsureRemoteOnboarding).toHaveBeenCalledWith({
				serverUrl: "https://remote.example.com",
			});
		});

		it("emits JSON payload with resolved workspace fields", async () => {
			const payload = await runAttachAndCapturePayload();
			expect(payload).toMatchObject({
				server_url: "https://remote.example.com",
				workspace_id: "ws_abc123",
				default_workspace_key: "mcp-client-bio",
				default_project: "main",
				agent_name: "Worker-Alpha",
			});
		});

		it("emits remote link result in the JSON payload", async () => {
			const payload = await runAttachAndCapturePayload();
			expect(payload.remote).toMatchObject({
				status: "linked",
				agent_handle: "ah_test.123",
			});
		});
	});

	it("shows guidance when not authenticated", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "not_authenticated",
		});

		const { attachCommand } = await import("../attach.js");
		await attachCommand({ agent: "Worker-Beta" });

		const output = parseWire(vi.mocked(console.log).mock.calls.at(-1)?.[0], wireString, "test JSON value");
		expect(output).toContain("Run: interlinked login");
	});

	it("rejects invalid workspace IDs", async () => {
		const { attachCommand } = await import("../attach.js");
		await attachCommand({ workspace: "main", json: true });

		expect(mockEnsureRemoteOnboarding).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});
});
