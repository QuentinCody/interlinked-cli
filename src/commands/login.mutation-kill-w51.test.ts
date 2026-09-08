import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks -----------------------------------------------------------

const mockInitConfig = vi.fn();
const mockIsConfigured = vi.fn();
const mockReadLocalConfig = vi.fn();
const mockResolveConfig = vi.fn();
const mockUpdateLocalConfig = vi.fn();

vi.mock("../lib/config.js", () => ({
	initConfig: (...a: unknown[]) => mockInitConfig(...a),
	isConfigured: (...a: unknown[]) => mockIsConfigured(...a),
	readLocalConfig: (...a: unknown[]) => mockReadLocalConfig(...a),
	resolveConfig: (...a: unknown[]) => mockResolveConfig(...a),
	updateLocalConfig: (...a: unknown[]) => mockUpdateLocalConfig(...a),
}));

const mockPerformLogin = vi.fn();
const mockSaveLoginTokens = vi.fn();
vi.mock("../lib/auth.js", () => ({
	performLogin: (...a: unknown[]) => mockPerformLogin(...a),
	saveLoginTokens: (...a: unknown[]) => mockSaveLoginTokens(...a),
}));

const mockEnsureRemoteOnboarding = vi.fn();
vi.mock("../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: (...a: unknown[]) => mockEnsureRemoteOnboarding(...a),
}));

const mockCallTool = vi.fn();
const mockFetchWorkspaces = vi.fn();
let lastClientConfig: unknown = null;
vi.mock("../lib/api-client.js", () => ({
	InterlinkedClient: class {
		constructor(cfg: unknown) {
			lastClientConfig = cfg;
		}
		callTool(...a: unknown[]) {
			return mockCallTool(...a);
		}
		fetchWorkspaces(...a: unknown[]) {
			return mockFetchWorkspaces(...a);
		}
	},
}));

import { c } from "../lib/formatter.js";
import { loginCommand } from "./login.js";

// ---- harness -----------------------------------------------------------

let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = [];
	errors = [];
	lastClientConfig = null;
	mockInitConfig.mockReset();
	mockIsConfigured.mockReset().mockReturnValue(true);
	mockReadLocalConfig.mockReset().mockReturnValue({});
	mockResolveConfig.mockReset().mockReturnValue({ server_url: "http://localhost:8787" });
	mockUpdateLocalConfig.mockReset();
	mockPerformLogin.mockReset();
	mockSaveLoginTokens.mockReset();
	mockEnsureRemoteOnboarding.mockReset().mockResolvedValue({ status: "skipped", reason: "other" });
	mockCallTool.mockReset().mockResolvedValue(undefined);
	mockFetchWorkspaces.mockReset().mockResolvedValue([]);

	logSpy = vi.spyOn(console, "log").mockImplementation((s: unknown) => {
		logs.push(String(s));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((s: unknown) => {
		errors.push(String(s));
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected process.exit"); });
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	exitSpy.mockRestore();
});

const oauthTokens = { access_token: "tok-abc", expires_in: 7200, refresh_token: "refresh-1" };

// ---- header separator (always printed) ---------------------------------

describe("loginCommand header separator", () => {
	it("prints the dim 40-dash separator as the second log line", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		await loginCommand({});
		expect(logs[1]).toBe(c.dim("─".repeat(40)));
	});
});

// ---- config-created "Server:" line --------------------------------------

describe("loginCommand — config created banner", () => {
	it("prints the exact Server: line with the default URL when unconfigured", async () => {
		mockIsConfigured.mockReturnValue(false);
		mockPerformLogin.mockResolvedValue(oauthTokens);
		await loginCommand({});
		const expected = `  ${c.dim("Server:")} http://localhost:8787\n`;
		expect(logs).toContain(expected);
	});
});

// ---- OAuth-start "Server:" + "Starting OAuth PKCE flow..." -------------

describe("loginCommand — OAuth start banner", () => {
	it("prints the exact Server: line and PKCE-start line before the flow", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		await loginCommand({});
		expect(logs).toContain(`${c.dim("Server:")} http://localhost:8787`);
		expect(logs).toContain(c.dim("Starting OAuth PKCE flow...\n"));
	});
});

// ---- InterlinkedClient object literal for workspace discovery ----------

describe("loginCommand — workspace-discovery client config", () => {
	it("constructs InterlinkedClient with serverUrl + token, not an empty object", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockFetchWorkspaces.mockResolvedValue([]);
		await loginCommand({});
		expect(lastClientConfig).toEqual({
			serverUrl: "http://localhost:8787",
			token: "tok-abc",
		});
	});
});

// ---- preferred?.id gating the workspace auto-select ---------------------

describe("loginCommand — preferred workspace id gating", () => {
	it("does not attempt a workspace update when the preferred workspace has a falsy id", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockFetchWorkspaces.mockResolvedValue([{ id: "", role: "owner" }]);
		mockReadLocalConfig.mockReturnValue({ servers: { production: {} } });
		await loginCommand({});
		// original: preferred?.id is "" (falsy) -> skip the whole workspace-select block
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("does perform the workspace update when the preferred workspace has a real id", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws-real", role: "owner" }]);
		mockReadLocalConfig.mockReturnValue({ servers: { production: {} } });
		await loginCommand({});
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
			expect.objectContaining({ workspace_id: "ws-real" }),
			expect.anything(),
		);
	});
});

// ---- "production" default activeServerKey -------------------------------

describe("loginCommand — default active-server key", () => {
	it("uses 'production' as the default active server key to merge servers map", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws1", role: "owner" }]);
		mockReadLocalConfig.mockReturnValue({ servers: { production: { extra: true } } });
		await loginCommand({});
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				servers: expect.objectContaining({
					production: expect.objectContaining({ extra: true, workspace_id: "ws1" }),
				}),
			}),
			expect.anything(),
		);
	});
});

// ---- "Token saved to:" line ---------------------------------------------

describe("loginCommand — token-saved banner", () => {
	it("prints the exact token-saved-to line", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		await loginCommand({});
		expect(logs).toContain(
			`  ${c.dim("Token saved to:")} .interlinked/config.local.json`,
		);
	});
});

// ---- "Expires in:" (hours branch) ----------------------------------------

describe("loginCommand — expiry banner (hours)", () => {
	it("prints hours when expires_in is large", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "tok", expires_in: 7200 });
		await loginCommand({});
		expect(logs).toContain(`  ${c.dim("Expires in:")}    ~2 hour(s)`);
	});
});

// ---- "Expires in:" (minutes branch) --------------------------------------

describe("loginCommand — expiry banner (minutes)", () => {
	it("prints minutes when expires_in rounds to zero hours", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "tok", expires_in: 120 });
		await loginCommand({});
		expect(logs).toContain(`  ${c.dim("Expires in:")}    ~2 minute(s)`);
	});
});

// ---- "Yes" refresh-token banner ------------------------------------------

describe("loginCommand — refresh-token banner", () => {
	it("prints Yes when a refresh token is present", async () => {
		mockPerformLogin.mockResolvedValue({
			access_token: "tok",
			expires_in: 3600,
			refresh_token: "r1",
		});
		await loginCommand({});
		expect(logs).toContain(
			`  ${c.dim("Refresh token:")} ${c.green("Yes")} (auto-renewal available)`,
		);
	});
});

// ---- "Workspace:" line ----------------------------------------------------

describe("loginCommand — workspace-selected banner", () => {
	it("prints the exact Workspace: line when resolveConfig reports one afterward", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockResolveConfig
			.mockReturnValueOnce({ server_url: "http://localhost:8787" })
			.mockReturnValueOnce({ server_url: "http://localhost:8787", workspace_id: "ws-9" });
		await loginCommand({});
		expect(logs).toContain(`  ${c.dim("Workspace:")}    ws-9 (auto-selected)`);
	});
});

// ---- reportLoginFailure reporters (private, reached via performLogin reject) --

describe("loginCommand — login-failure reporters", () => {
	it("reports timed-out failures with the retry hint", async () => {
		mockPerformLogin.mockRejectedValue(new Error("Login timed out waiting"));
		await expect(loginCommand({})).rejects.toThrow("Unexpected process.exit");
		expect(errors).toContain(c.dim("Try again with: interlinked login"));
	});

	it("reports client-registration failures with server-check guidance", async () => {
		mockPerformLogin.mockRejectedValue(new Error("Client registration failed: 500"));
		await expect(loginCommand({})).rejects.toThrow("Unexpected process.exit");
		expect(errors).toContain(`\n${c.red("Server error:")} Could not register OAuth client.`);
		expect(errors).toContain(
			c.dim("Check that the Server URL is correct and the server is running."),
		);
	});

	it("reports token-exchange failures with the exact message and hint", async () => {
		mockPerformLogin.mockRejectedValue(new Error("Token exchange failed: invalid_grant"));
		await expect(loginCommand({})).rejects.toThrow("Unexpected process.exit");
		expect(errors).toContain(
			`\n${c.red("Token exchange failed:")} Token exchange failed: invalid_grant`,
		);
		expect(errors).toContain(
			c.dim("The authorization succeeded but token exchange failed."),
		);
	});
});

// ---- renderRemoteOnboarding (private, reached via ensureRemoteOnboarding) ----

describe("loginCommand — remote-onboarding rendering", () => {
	it("renders the linked banner with no stray handle text when agentHandle is absent", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			isNewAgent: true,
			reclaimedAgent: false,
			workspaceName: "main",
			agentName: "bot1",
			agentHandle: undefined,
		});
		await loginCommand({});
		const expected = `  ${c.dim("Remote agent:")} ${c.green("bot1 linked")} ${c.dim(
			"[main/new]",
		)}${c.dim("")}`;
		expect(logs).toContain(expected);
		expect(logs.join("\n")).not.toContain("Stryker was here!");
	});

	it("renders the agent_name_missing skipped banner", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "agent_name_missing",
		});
		await loginCommand({});
		const expected = `  ${c.dim("Remote agent:")} ${c.yellow("skipped")} ${c.dim(
			"(set agent name: interlinked enable --agent <name>)",
		)}`;
		expect(logs).toContain(expected);
	});

	it("falls through to the not-linked banner when status isn't literally 'skipped'", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "error",
			reason: "agent_name_missing",
			error: "boom",
		});
		await loginCommand({});
		const expected = `  ${c.dim("Remote agent:")} ${c.yellow("not linked")} ${c.dim("boom")}`;
		expect(logs).toContain(expected);
		// must NOT have taken the agent_name_missing skipped branch
		expect(
			logs.some((l) => l.includes("set agent name: interlinked enable --agent")),
		).toBe(false);
	});

	it("prints nothing extra for a skipped status with an unrecognized reason", async () => {
		mockPerformLogin.mockResolvedValue(oauthTokens);
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "some_other_reason",
		});
		await loginCommand({});
		expect(logs.some((l) => l.includes("Remote agent:"))).toBe(false);
	});
});
