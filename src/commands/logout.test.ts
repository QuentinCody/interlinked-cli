import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// Behavioral tests for `interlinked logout`
// ===========================================
// Mocks the two module boundaries logout.ts imports — ../lib/config.js
// (isConfigured / readLocalConfig / updateLocalConfig) and
// ../lib/formatter.js (the `c` color object, stubbed to identity so output
// strings are deterministic regardless of TTY/CI/NO_COLOR). Spies on
// console.log to assert real emitted strings, and on updateLocalConfig to
// assert token-clearing side-effects. Exercises every branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-boundary mocks -----------------------------------------------

vi.mock("../lib/config.js", () => ({
	isConfigured: vi.fn(),
	readLocalConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

// Stub the formatter so c.bold / c.dim / c.green are identity functions.
// This removes ANSI from the assertions without depending on env color
// gating, and keeps the real call sites (c.dim("…"), c.green("Cleared")).
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

import { isConfigured, readLocalConfig, updateLocalConfig } from "../lib/config.js";
import { nonNull } from "../lib/non-null.js";
import { logoutCommand } from "./logout.js";

const mockIsConfigured = vi.mocked(isConfigured);
const mockReadLocalConfig = vi.mocked(readLocalConfig);
const mockUpdateLocalConfig = vi.mocked(updateLocalConfig);

// Capture all console.log output for a single command invocation.
let logSpy: ReturnType<typeof vi.spyOn>;

function logged(): string[] {
	return (logSpy.mock.calls).map((args: unknown[]) => String(args[0]));
}
function loggedText(): string {
	return logged().join("\n");
}
/** Parse the single JSON line emitted in --json mode. */
function jsonOut(): Record<string, unknown> {
	const calls = logged();
	expect(calls).toHaveLength(1);
	return parseWire(JSON.parse(nonNull(calls[0])), wireRecord(wireUnknown), "test JSON value");
}

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
});

// -------------------------------------------------------------------------
// Branch: not configured
// -------------------------------------------------------------------------

describe("logout — not configured", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(false);
	});

	it("human mode: prints 'Not configured' and clears nothing", async () => {
		await logoutCommand({});
		expect(loggedText()).toContain("Not configured. Nothing to log out from.");
		expect(mockReadLocalConfig).not.toHaveBeenCalled();
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("json mode: emits {status:'not_configured'}", async () => {
		await logoutCommand({ json: true });
		expect(jsonOut()).toEqual({ status: "not_configured" });
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});
});

// -------------------------------------------------------------------------
// Branch: configured but no local config object
// -------------------------------------------------------------------------

describe("logout — configured but readLocalConfig returns null", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
		mockReadLocalConfig.mockReturnValue(null);
	});

	it("human mode: prints 'No local config found'", async () => {
		await logoutCommand({});
		expect(loggedText()).toContain("No local config found. Nothing to log out from.");
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("json mode: emits {status:'no_credentials'}", async () => {
		await logoutCommand({ json: true });
		expect(jsonOut()).toEqual({ status: "no_credentials" });
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});
});

// -------------------------------------------------------------------------
// Branch: local config exists but has no auth credentials
// -------------------------------------------------------------------------

describe("logout — no credentials present", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
		// agent_handle present but no token/refresh/oauth → still "no credentials"
		mockReadLocalConfig.mockReturnValue({ agent_handle: "agent-7" });
	});

	it("human mode: prints 'Already logged out'", async () => {
		await logoutCommand({});
		expect(loggedText()).toContain("No credentials found in config. Already logged out.");
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});

	it("json mode: emits {status:'no_credentials'}", async () => {
		await logoutCommand({ json: true });
		expect(jsonOut()).toEqual({ status: "no_credentials" });
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
	});
});

// -------------------------------------------------------------------------
// Branch: logged out — credentials cleared (human output)
// -------------------------------------------------------------------------

describe("logout — clears credentials (human output)", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
	});

	it("clears the three auth fields and reports each present one", async () => {
		mockReadLocalConfig.mockReturnValue({
			access_token: "tok",
			refresh_token: "ref",
			oauth_client_id: "cid",
			agent_handle: "agent-7",
		});

		await logoutCommand({});

		// Side-effect: auth fields cleared, agent_handle NOT cleared (no --all).
		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
		const [updates, cwdArg] = nonNull(mockUpdateLocalConfig.mock.calls[0]);
		expect(updates).toEqual({
			access_token: undefined,
			refresh_token: undefined,
			token_expires_at: undefined,
			oauth_client_id: undefined,
		});
		expect("agent_handle" in updates).toBe(false);
		expect(cwdArg).toBe(process.cwd());

		const text = loggedText();
		expect(text).toContain("Interlinked CLI — Logout");
		expect(text).toContain("Cleared access token");
		expect(text).toContain("Cleared refresh token");
		expect(text).toContain("Cleared OAuth client ID");
		expect(text).not.toContain("Cleared agent handle");
		expect(text).toContain("Logged out.");
		expect(text).toContain("To re-authenticate: interlinked login");
	});

	it("only reports the credentials that were present (token only)", async () => {
		mockReadLocalConfig.mockReturnValue({ access_token: "tok" });

		await logoutCommand({});

		const text = loggedText();
		expect(text).toContain("Cleared access token");
		expect(text).not.toContain("Cleared refresh token");
		expect(text).not.toContain("Cleared OAuth client ID");
		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
	});

	it("reports refresh + oauth without an access token", async () => {
		mockReadLocalConfig.mockReturnValue({
			refresh_token: "ref",
			oauth_client_id: "cid",
		});

		await logoutCommand({});

		const text = loggedText();
		expect(text).not.toContain("Cleared access token");
		expect(text).toContain("Cleared refresh token");
		expect(text).toContain("Cleared OAuth client ID");
	});
});

// -------------------------------------------------------------------------
// Branch: --all also clears agent handle
// -------------------------------------------------------------------------

describe("logout --all — clears agent handle", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
	});

	it("human mode: clears agent_handle and prints re-registration note", async () => {
		mockReadLocalConfig.mockReturnValue({
			access_token: "tok",
			agent_handle: "agent-7",
		});

		await logoutCommand({ all: true });

		const [updates] = nonNull(mockUpdateLocalConfig.mock.calls[0]);
		expect(updates).toEqual({
			access_token: undefined,
			refresh_token: undefined,
			token_expires_at: undefined,
			oauth_client_id: undefined,
			agent_handle: undefined,
		});

		const text = loggedText();
		expect(text).toContain("Cleared agent handle");
		expect(text).toContain("Re-registration required on next login.");
	});

	it("--all with no agent_handle: clears it in updates but prints no handle line", async () => {
		// hadHandle === false → the `options.all && hadHandle` console block is skipped,
		// but updates.agent_handle is still set to undefined.
		mockReadLocalConfig.mockReturnValue({ access_token: "tok" });

		await logoutCommand({ all: true });

		const [updates] = nonNull(mockUpdateLocalConfig.mock.calls[0]);
		expect("agent_handle" in updates).toBe(true);
		expect(updates.agent_handle).toBeUndefined();

		const text = loggedText();
		expect(text).not.toContain("Cleared agent handle");
		expect(text).toContain("Logged out.");
	});
});

// -------------------------------------------------------------------------
// Branch: logged out — JSON output (cleared map reflects had* + all)
// -------------------------------------------------------------------------

describe("logout — JSON output", () => {
	beforeEach(() => {
		mockIsConfigured.mockReturnValue(true);
	});

	it("reports the cleared map for all present credentials with --all", async () => {
		mockReadLocalConfig.mockReturnValue({
			access_token: "tok",
			refresh_token: "ref",
			oauth_client_id: "cid",
			agent_handle: "agent-7",
		});

		await logoutCommand({ json: true, all: true });

		expect(jsonOut()).toEqual({
			status: "logged_out",
			cleared: {
				access_token: true,
				refresh_token: true,
				oauth_client_id: true,
				agent_handle: true,
			},
		});
		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
	});

	it("agent_handle cleared key is omitted without --all even when handle present", async () => {
		// Source emits `options.all && hadHandle`. Without --all, options.all is
		// undefined, so `undefined && true` === undefined → JSON.stringify drops
		// the key entirely (it is not serialized as `false`).
		mockReadLocalConfig.mockReturnValue({
			access_token: "tok",
			agent_handle: "agent-7",
		});

		await logoutCommand({ json: true });

		const out = jsonOut();
		expect(out.status).toBe("logged_out");
		const cleared = parseWire(out.cleared, wireRecord(wireUnknown), "test JSON value");
		expect("agent_handle" in cleared).toBe(false);
		expect(cleared.access_token).toBe(true);
	});

	it("cleared flags reflect absent credentials (oauth only, no --all)", async () => {
		// agent_handle is absent here AND --all is unset, so `undefined && false`
		// === undefined → the key is omitted from the serialized map.
		mockReadLocalConfig.mockReturnValue({ oauth_client_id: "cid" });

		await logoutCommand({ json: true });

		expect(jsonOut()).toEqual({
			status: "logged_out",
			cleared: {
				access_token: false,
				refresh_token: false,
				oauth_client_id: true,
			},
		});
	});

	it("agent_handle cleared is false when --all set but no handle present", async () => {
		// options.all && hadHandle  →  true && false  →  false (the && short-circuit)
		mockReadLocalConfig.mockReturnValue({ refresh_token: "ref" });

		await logoutCommand({ json: true, all: true });

		const out = jsonOut();
		expect(out).toHaveProperty(["cleared","agent_handle"], false);
		expect(out).toHaveProperty(["cleared","refresh_token"], true);
	});
});
