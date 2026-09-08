// ===========================================
// Behavioral tests for `interlinked login`
// ===========================================
// login.ts is a commander OAuth handler. We mock every module boundary it
// imports — ../lib/auth.js (performLogin / saveLoginTokens), ../lib/config.js
// (initConfig / isConfigured / readLocalConfig / resolveConfig /
// updateLocalConfig), ../lib/api-client.js (the InterlinkedClient class:
// callTool / fetchWorkspaces), ../lib/onboarding.js (ensureRemoteOnboarding),
// and ../lib/formatter.js (the `c` color object, stubbed to identity so output
// strings are deterministic regardless of TTY/CI/NO_COLOR). console.log /
// console.error are spied to assert real emitted strings, process.exit is
// stubbed to throw a sentinel so control flow halts exactly where the real
// process would terminate. No real OAuth, no network, no fs writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-boundary mocks -----------------------------------------------

vi.mock("../lib/auth.js", () => ({
	performLogin: vi.fn(),
	saveLoginTokens: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	initConfig: vi.fn(),
	isConfigured: vi.fn(),
	readLocalConfig: vi.fn(),
	resolveConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

vi.mock("../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: vi.fn(),
}));

// InterlinkedClient is used as `new InterlinkedClient({...})`. Capture the
// constructor options and route the two instance methods login.ts calls
// (callTool, fetchWorkspaces) to module-level spies.
const ctorCalls: Array<{ serverUrl?: string; token?: string }> = [];
const mockCallTool = vi.fn();
const mockFetchWorkspaces = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	InterlinkedClient: class {
		constructor(opts: { serverUrl?: string; token?: string }) {
			ctorCalls.push(opts);
		}
		callTool(...args: unknown[]): Promise<unknown> {
			return mockCallTool(...args);
		}
		fetchWorkspaces(...args: unknown[]): Promise<unknown> {
			return mockFetchWorkspaces(...args);
		}
	},
}));

// Stub the formatter so c.bold / c.dim / c.green / c.cyan / c.yellow are
// identity functions — strips ANSI from assertions without env-color coupling.
vi.mock("../lib/formatter.js", () => ({
	c: new Proxy(
		{},
		{
			get:
				() =>
				(s = ""): string =>
					s,
		},
	),
}));

import { performLogin, saveLoginTokens } from "../lib/auth.js";
import type { ResolvedConfig } from "../lib/config.js";
import {
	initConfig,
	isConfigured,
	readLocalConfig,
	resolveConfig,
	updateLocalConfig,
} from "../lib/config.js";
import type { RemoteOnboardingResult } from "../lib/onboarding.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { loginCommand } from "./login.js";

const mockPerformLogin = vi.mocked(performLogin);
const mockSaveLoginTokens = vi.mocked(saveLoginTokens);
const mockInitConfig = vi.mocked(initConfig);
const mockIsConfigured = vi.mocked(isConfigured);
const mockReadLocalConfig = vi.mocked(readLocalConfig);
const mockResolveConfig = vi.mocked(resolveConfig);
const mockUpdateLocalConfig = vi.mocked(updateLocalConfig);
const mockEnsureRemoteOnboarding = vi.mocked(ensureRemoteOnboarding);

// --- Console + process.exit capture --------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

class ProcessExit extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

function logged(): string {
	return (logSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("\n");
}
function errored(): string {
	return (errSpy.mock.calls).map((a: unknown[]) => String(a[0])).join("\n");
}

/** A ResolvedConfig stub with sensible defaults, overridable per-test. */
function resolved(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { server_url: "https://srv.example", sync_mode: "realtime", ...over };
}

const SKIPPED: RemoteOnboardingResult = { status: "skipped", reason: "not_authenticated" };

beforeEach(() => {
	vi.clearAllMocks();
	ctorCalls.length = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ProcessExit(code === undefined ? undefined : Number(code));
	});
	// Defaults: configured, resolves to a remote server, onboarding skipped.
	mockIsConfigured.mockReturnValue(true);
	mockResolveConfig.mockReturnValue(resolved());
	mockReadLocalConfig.mockReturnValue({});
	mockEnsureRemoteOnboarding.mockResolvedValue(SKIPPED);
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	exitSpy.mockRestore();
});

// =========================================================================
// Config bootstrap branches (header + create/update)
// =========================================================================

describe("login — config bootstrap", () => {
	it("creates config when not configured, defaulting to localhost", async () => {
		mockIsConfigured.mockReturnValue(false);
		mockResolveConfig.mockReturnValue(resolved({ server_url: "http://localhost:8787" }));
		mockPerformLogin.mockResolvedValue({ access_token: "tok" });

		await loginCommand({});

		// initConfig called with the localhost default.
		expect(mockInitConfig).toHaveBeenCalledWith(
			{ serverUrl: "http://localhost:8787" },
			process.cwd(),
		);
		const out = logged();
		expect(out).toContain("Interlinked CLI — Login");
		expect(out).toContain("Created");
		expect(out).toContain("http://localhost:8787");
	});

	it("creates config with the --server URL when not configured", async () => {
		mockIsConfigured.mockReturnValue(false);
		mockResolveConfig.mockReturnValue(resolved({ server_url: "http://localhost:8787" }));
		mockPerformLogin.mockResolvedValue({ access_token: "tok" });

		await loginCommand({ server: "https://team.example" });

		// Once for the not-configured create, again for the differs-from-config update.
		expect(mockInitConfig).toHaveBeenCalledWith(
			{ serverUrl: "https://team.example" },
			process.cwd(),
		);
		expect(logged()).toContain("Updated");
	});

	it("updates the server URL when --server differs from existing config", async () => {
		mockResolveConfig.mockReturnValue(resolved({ server_url: "https://old.example" }));
		mockPerformLogin.mockResolvedValue({ access_token: "tok" });

		await loginCommand({ server: "https://new.example" });

		expect(mockInitConfig).toHaveBeenCalledWith(
			{ serverUrl: "https://new.example" },
			process.cwd(),
		);
		expect(logged()).toContain("Updated");
		// PKCE flow runs against the --server URL.
		expect(mockPerformLogin).toHaveBeenCalledWith("https://new.example");
	});

	it("does not re-init when --server matches existing config", async () => {
		mockResolveConfig.mockReturnValue(resolved({ server_url: "https://same.example" }));
		mockPerformLogin.mockResolvedValue({ access_token: "tok" });

		await loginCommand({ server: "https://same.example" });

		expect(mockInitConfig).not.toHaveBeenCalled();
		expect(logged()).not.toContain("Updated");
	});
});

// =========================================================================
// Path 1 — manual token injection
// =========================================================================

describe("login — manual token (--token)", () => {
	it("rejects an empty/whitespace token and exits 1 without saving", async () => {
		await expect(loginCommand({ token: "   " })).rejects.toBeInstanceOf(ProcessExit);
		expect(errored()).toContain("Invalid token.");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		// Never reached the health-check client.
		expect(ctorCalls).toHaveLength(0);
	});

	it("validates the token via health_check, saves it, and runs onboarding", async () => {
		mockCallTool.mockResolvedValue({ ok: true });
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "agent-a",
			isNewAgent: true,
			workspaceName: "main",
		});

		await loginCommand({ token: "  my-token  " });

		// Health-check client built with the trimmed token + resolved server.
		expect(ctorCalls[0]).toEqual({ serverUrl: "https://srv.example", token: "my-token" });
		expect(mockCallTool).toHaveBeenCalledWith("health_check");

		// Token persisted with refresh/expiry/oauth cleared (manual injection).
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
			{
				access_token: "my-token",
				refresh_token: undefined,
				token_expires_at: undefined,
				oauth_client_id: undefined,
			},
			process.cwd(),
		);
		expect(mockEnsureRemoteOnboarding).toHaveBeenCalledWith({
			serverUrl: "https://srv.example",
			token: "my-token",
		});

		const out = logged();
		expect(out).toContain("Saved");
		expect(out).toContain("Token source: --token flag (manual injection)");
		expect(out).toContain("agent-a linked");
		expect(out).toContain("Authenticated.");
		// PKCE flow never invoked on the manual path.
		expect(mockPerformLogin).not.toHaveBeenCalled();
	});

	it("exits 1 (and does not save) when health_check rejects with an Error", async () => {
		mockCallTool.mockRejectedValue(new Error("401 Unauthorized"));

		await expect(loginCommand({ token: "bad-token" })).rejects.toBeInstanceOf(ProcessExit);

		expect(errored()).toContain("Token validation failed:");
		expect(errored()).toContain("401 Unauthorized");
		expect(errored()).toContain("The token was not saved.");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("stringifies a non-Error health_check rejection", async () => {
		mockCallTool.mockRejectedValue("plain string failure");

		await expect(loginCommand({ token: "bad-token" })).rejects.toBeInstanceOf(ProcessExit);

		expect(errored()).toContain("plain string failure");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

// =========================================================================
// Path 2 — OAuth PKCE flow: success variants
// =========================================================================

describe("login — OAuth PKCE success", () => {
	it("saves tokens and prints expiry in hours when expires_in >= 1h", async () => {
		mockPerformLogin.mockResolvedValue({
			access_token: "acc",
			refresh_token: "ref",
			expires_in: 7200, // 2h
		});
		mockFetchWorkspaces.mockResolvedValue([]);
		mockResolveConfig.mockReturnValue(resolved()); // no workspace_id after login

		await loginCommand({});

		expect(mockPerformLogin).toHaveBeenCalledWith("https://srv.example");
		expect(mockSaveLoginTokens).toHaveBeenCalledWith(
			{ access_token: "acc", refresh_token: "ref", expires_in: 7200 },
			process.cwd(),
		);
		const out = logged();
		expect(out).toContain("Authentication successful!");
		expect(out).toContain("~2 hour(s)");
		expect(out).toContain("Refresh token:");
		expect(out).toContain("Ready.");
	});

	it("prints expiry in minutes when expires_in rounds to < 1h", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc", expires_in: 600 }); // 10m
		mockFetchWorkspaces.mockResolvedValue([]);

		await loginCommand({});

		const out = logged();
		expect(out).toContain("~10 minute(s)");
		expect(out).not.toContain("hour(s)");
		// No refresh token → no refresh line.
		expect(out).not.toContain("Refresh token:");
	});

	it("auto-selects the owner workspace and writes it into the active server entry", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockResolvedValue([
			{ id: "ws-member", name: "m", role: "member" },
			{ id: "ws-owner", name: "o", role: "owner" },
		]);
		mockReadLocalConfig.mockReturnValue({
			active_server: "prod",
			servers: { prod: { server_url: "https://srv.example" } },
		});
		// resolveConfig is called twice: once up front, once after login (shows workspace).
		mockResolveConfig
			.mockReturnValueOnce(resolved())
			.mockReturnValueOnce(resolved({ workspace_id: "ws-owner" }));

		await loginCommand({});

		// Workspace discovery client built with the access token.
		expect(ctorCalls[0]).toEqual({ serverUrl: "https://srv.example", token: "acc" });
		// Owner preferred over the member entry, merged into servers[active].
		expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
			{
				workspace_id: "ws-owner",
				servers: { prod: { server_url: "https://srv.example", workspace_id: "ws-owner" } },
			},
			process.cwd(),
		);
		expect(logged()).toContain("ws-owner (auto-selected)");
	});

	it("falls back to the first workspace and the flat path when no servers map exists", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws-first", name: "f" }]);
		// readLocalConfig returns {} → no servers[activeServerKey] → flat update branch.
		mockReadLocalConfig.mockReturnValue({});
		mockResolveConfig.mockReturnValue(resolved());

		await loginCommand({});

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith(
			{ workspace_id: "ws-first" },
			process.cwd(),
		);
	});

	it("handles readLocalConfig returning null during workspace auto-select", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws-x", name: "x" }]);
		mockReadLocalConfig.mockReturnValue(null); // `|| {}` fallback path
		mockResolveConfig.mockReturnValue(resolved());

		await loginCommand({});

		expect(mockUpdateLocalConfig).toHaveBeenCalledWith({ workspace_id: "ws-x" }, process.cwd());
	});

	it("does not update workspace when none are returned", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockResolvedValue([]); // preferred is undefined → no id
		mockResolveConfig.mockReturnValue(resolved());

		await loginCommand({});

		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		expect(logged()).not.toContain("auto-selected");
	});

	it("swallows workspace-discovery errors (login already succeeded)", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockRejectedValue(new Error("workspace fetch down"));
		mockResolveConfig.mockReturnValue(resolved());

		await loginCommand({});

		// The catch block is intentional: still reaches the success epilogue.
		expect(logged()).toContain("Authentication successful!");
		expect(logged()).toContain("Ready.");
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("prints neither expiry line when expires_in is absent", async () => {
		mockPerformLogin.mockResolvedValue({ access_token: "acc" });
		mockFetchWorkspaces.mockResolvedValue([]);

		await loginCommand({});

		const out = logged();
		expect(out).not.toContain("Expires in:");
	});
});

// =========================================================================
// Path 2 — OAuth PKCE flow: failure → reportLoginFailure dispatch
// =========================================================================

describe("login — OAuth PKCE failure dispatch", () => {
	async function failWith(message: string): Promise<void> {
		mockPerformLogin.mockRejectedValue(new Error(message));
		await expect(loginCommand({})).rejects.toBeInstanceOf(ProcessExit);
	}

	it("timeout → 'Login timed out.' and exits 1", async () => {
		await failWith("the flow timed out waiting for callback");
		expect(errored()).toContain("Login timed out.");
		expect(errored()).toContain("Alternative: use --token");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("CSRF mismatch → security/MITM warning", async () => {
		await failWith("CSRF state mismatch detected");
		expect(errored()).toContain("Security error:");
		expect(errored()).toContain("CSRF state mismatch detected");
		expect(errored()).toContain("man-in-the-middle");
	});

	it("client registration failure → server-error guidance with the URL", async () => {
		await failWith("Client registration failed: 500");
		expect(errored()).toContain("Could not register OAuth client.");
		expect(errored()).toContain("Server: https://srv.example");
	});

	it("token exchange failure → exchange-specific guidance", async () => {
		await failWith("Token exchange failed: invalid_grant");
		expect(errored()).toContain("Token exchange failed:");
		expect(errored()).toContain("invalid_grant");
		expect(errored()).toContain("server-side issue");
	});

	it("unrecognized error → generic 'Login failed:' fallback", async () => {
		await failWith("disk on fire");
		expect(errored()).toContain("Login failed:");
		expect(errored()).toContain("disk on fire");
	});

	it("stringifies a non-Error rejection in the generic fallback", async () => {
		mockPerformLogin.mockRejectedValue({ weird: true });
		await expect(loginCommand({})).rejects.toBeInstanceOf(ProcessExit);
		expect(errored()).toContain("Login failed:");
		expect(errored()).toContain("[object Object]");
	});
});

// =========================================================================
// renderRemoteOnboarding — every status/sub-branch (driven through login)
// =========================================================================

describe("login — renderRemoteOnboarding rendering", () => {
	beforeEach(() => {
		// Manual-token path is the simplest carrier for onboarding rendering.
		mockCallTool.mockResolvedValue({ ok: true });
	});

	it("linked + new agent with handle prints [workspace/new] and the handle", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "agent-a",
			agentHandle: "agent-a-7",
			isNewAgent: true,
			workspaceName: "team",
		});
		await loginCommand({ token: "t" });
		const out = logged();
		expect(out).toContain("agent-a linked");
		expect(out).toContain("[team/new]");
		expect(out).toContain("(agent-a-7)");
	});

	it("linked + reclaimed agent prints [main/reclaimed] and defaults workspace to 'main'", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "agent-b",
			isNewAgent: false,
			reclaimedAgent: true,
		});
		await loginCommand({ token: "t" });
		expect(logged()).toContain("[main/reclaimed]");
	});

	it("linked + existing agent (not new, not reclaimed) prints [main/existing]", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "agent-c",
			isNewAgent: false,
			reclaimedAgent: false,
		});
		await loginCommand({ token: "t" });
		const out = logged();
		expect(out).toContain("[main/existing]");
		// No handle → no parenthesized label, defaults the name when missing handled elsewhere.
		expect(out).not.toContain("()");
	});

	it("linked with no agentName falls back to the literal 'agent'", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "linked", isNewAgent: true });
		await loginCommand({ token: "t" });
		expect(logged()).toContain("agent linked");
	});

	it("skipped + agent_name_missing prints the set-name hint", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "agent_name_missing",
		});
		await loginCommand({ token: "t" });
		expect(logged()).toContain("interlinked enable --agent");
	});

	it("skipped for any other reason renders nothing for the remote line", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "skipped",
			reason: "server_unavailable",
		});
		await loginCommand({ token: "t" });
		const out = logged();
		expect(out).not.toContain("Remote agent:");
		// Still completed the happy path.
		expect(out).toContain("Authenticated.");
	});

	it("failed status prints the carried error", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({
			status: "failed",
			error: "bootstrap exploded",
		});
		await loginCommand({ token: "t" });
		expect(logged()).toContain("bootstrap exploded");
	});

	it("failed status with no error falls back to 'bootstrap failed'", async () => {
		mockEnsureRemoteOnboarding.mockResolvedValue({ status: "failed" });
		await loginCommand({ token: "t" });
		expect(logged()).toContain("bootstrap failed");
	});
});
