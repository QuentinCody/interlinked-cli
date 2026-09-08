import { parseWire, wireArray, wireNullable, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked workspace — behavioral coverage
// ===========================================
// Drives workspaceListCommand / workspaceSwitchCommand through every
// branch: output modes, empty/populated list, active-marker ternaries,
// null-field em-dashes, switch happy path (servers map + flat fallback),
// invalid-id, not-found (with/without available ids), server-unreachable,
// and the error/catch paths (incl. non-Error throwables + process.exit).
//
// `../lib/config.js` and `../lib/api-client.js` are mocked so the persisted
// side-effect of a switch is asserted on the `updateLocalConfig` call args
// (no real fs). `node:fs` is mocked too so any incidental disk access is a
// no-op rather than touching the real tree. `../lib/formatter.js` is mocked
// to identity/predictable renderers so assertions are exact strings rather
// than ANSI-sensitive substrings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchWorkspaces = vi.fn();
const mockGetClient = vi.fn(() => ({ fetchWorkspaces: mockFetchWorkspaces }));
const mockResolveConfig = vi.fn();
const mockReadLocalConfig = vi.fn();
const mockUpdateLocalConfig = vi.fn();

vi.mock("../lib/api-client.js", () => ({
	getClient: () => mockGetClient(),
}));

vi.mock("../lib/config.js", () => ({
	resolveConfig: () => mockResolveConfig(),
	readLocalConfig: () => mockReadLocalConfig(),
	updateLocalConfig: (updates: unknown) => mockUpdateLocalConfig(updates),
}));

// node:fs is mocked per the harness contract — config/api-client are the real
// disk/network surfaces and are already stubbed above, so this just guarantees
// no test ever reaches the filesystem even by accident.
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
}));

// Identity/predictable formatter so output assertions are exact. `c.<color>`
// returns its input unchanged; badge/header/table return a stable shape we
// can match against literally.
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string): string => s;
	return {
		c: new Proxy(
			{},
			{
				get: (): ((s: string) => string) => identity,
			},
		),
		badge: (s: string): string => `[${s}]`,
		header: (title: string): string => `== ${title} ==`,
		table: (headers: string[], rows: string[][]): string =>
			`TABLE(${headers.join("|")})\n${rows.map((r: string[]) => r.join("|")).join("\n")}`,
	};
});

import { nonNull } from "../lib/non-null.js";
import { workspaceListCommand, workspaceSwitchCommand } from "./workspace.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	mockFetchWorkspaces.mockReset();
	mockGetClient.mockClear();
	mockGetClient.mockImplementation(() => ({ fetchWorkspaces: mockFetchWorkspaces }));
	mockResolveConfig.mockReset();
	mockReadLocalConfig.mockReset();
	mockUpdateLocalConfig.mockReset();
	process.exitCode = 0;

	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	// process.exit is stubbed to throw so the catch-path's exit(1) is
	// observable AND halts execution exactly like the real call would.
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit:${code}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

const lastLog = (): string => String(logSpy.mock.calls.at(-1)?.[0] ?? "");
const allLog = (): string =>
	logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const lastErr = (): string => String(errSpy.mock.calls.at(-1)?.[0] ?? "");

// ===========================================
// workspaceListCommand
// ===========================================

describe("workspaceListCommand", () => {
	it("renders a populated table in normal mode with the active marker, badge, and counts", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockResolvedValue([
			{
				id: "ws_active",
				name: "Alpha",
				role: "owner",
				project_count: 3,
				agent_count: 2,
			},
			{
				id: "ws_other",
				name: "Beta",
				role: "member",
				project_count: 0,
				agent_count: 5,
			},
		]);

		await workspaceListCommand({});

		const out = allLog();
		expect(out).toContain("== Registry Workspaces ==");
		// Active row: marker "*", name, badge, counts (0 must render as "0",
		// not the em-dash, since `!= null` allows zero), and the id.
		expect(out).toContain("*|Alpha|[owner]|3|2|ws_active");
		// Inactive row: marker is a single space.
		expect(out).toContain(" |Beta|[member]|0|5|ws_other");
		// Active footer + the two help lines.
		expect(out).toContain("Active: ws_active");
		expect(out).toContain("IDs here are registry workspace IDs (ws_...).");
		expect(out).toContain("Internal workspace_key/project_key are selected in MCP tool calls.");
		expect(process.exitCode).toBe(0);
	});

	it("renders em-dashes for missing name/role/counts and omits the active footer when no workspace_id", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: undefined });
		mockFetchWorkspaces.mockResolvedValue([
			{
				id: "ws_x",
				name: undefined,
				role: undefined,
				project_count: undefined,
				agent_count: undefined,
			},
		]);

		await workspaceListCommand({});

		const out = allLog();
		// name/role/projects/agents all fall to the dim "-" placeholder.
		expect(out).toContain(" |-|-|-|-|ws_x");
		// No active footer line (workspace_id is falsy).
		expect(out).not.toContain("Active:");
		// Help lines still print.
		expect(out).toContain("IDs here are registry workspace IDs (ws_...).");
	});

	it("renders an em-dash id when w.id is null (w.id != null branch)", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockResolvedValue([{ id: undefined, name: "NoId" }]);

		await workspaceListCommand({});

		const out = allLog();
		// id column is the "-" placeholder; row is inactive (active !== undefined).
		expect(out).toContain(" |NoId|-|-|-|-");
	});

	it("treats a non-matching workspace_id as not-active so the marker is a space (=== false branch)", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_other" });
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_x", name: "X" }]);

		await workspaceListCommand({});

		const out = allLog();
		// isActive = ("ws_other" === "ws_x") => false => marker is " ".
		expect(out).toContain(" |X|");
		expect(out).not.toContain("*|X|");
	});

	it("renders the empty-state line and returns early (no table, no footer)", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockResolvedValue([]);

		await workspaceListCommand({});

		const out = allLog();
		expect(out).toContain("== Registry Workspaces ==");
		expect(out).toContain("No workspaces found");
		expect(out).not.toContain("TABLE(");
		// Early return skips the Active footer even though workspace_id is set.
		expect(out).not.toContain("Active: ws_active");
	});

	it("emits JSON with active_workspace = workspace_id when set", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_json" });
		const workspaces = [{ id: "ws_json", name: "J", role: "owner", project_count: 1, agent_count: 1 }];
		mockFetchWorkspaces.mockResolvedValue(workspaces);

		await workspaceListCommand({ json: true });

		const payload = parseWire(JSON.parse(lastLog()), wireObject({ "workspaces": wireArray(wireUnknown), "active_workspace": wireNullable(wireString) }), "test JSON value");
		expect(payload.workspaces).toEqual(workspaces);
		expect(payload.active_workspace).toBe("ws_json");
	});

	it("emits JSON with active_workspace = null when workspace_id is falsy (|| null branch)", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "" });
		mockFetchWorkspaces.mockResolvedValue([]);

		await workspaceListCommand({ json: true });

		const payload = parseWire(JSON.parse(lastLog()), wireObject({ "active_workspace": wireNullable(wireString) }), "test JSON value");
		expect(payload.active_workspace).toBeNull();
	});

	// NOTE: workspaceListCommand's parameter type is `{ json?: boolean }`, so
	// the short/full branches of getOutputMode are unreachable from this
	// command via a type-safe call. The `output()` short/full renderers (which
	// fall back to `normal`) are covered by output.ts's own tests.

	it("reports an Error message via outputError and sets exitCode (server unreachable)", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8787"));

		await workspaceListCommand({});

		expect(lastErr()).toBe("Error: ECONNREFUSED 127.0.0.1:8787");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throwable in the catch branch", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockRejectedValue("plain string failure");

		await workspaceListCommand({});

		expect(lastErr()).toBe("Error: plain string failure");
		expect(process.exitCode).toBe(1);
	});

	it("reports an Error as structured JSON to stderr in json mode", async () => {
		mockResolveConfig.mockReturnValue({ workspace_id: "ws_active" });
		mockFetchWorkspaces.mockRejectedValue(new Error("boom"));

		await workspaceListCommand({ json: true });

		const payload = parseWire(JSON.parse(lastErr()), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe("boom");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// workspaceSwitchCommand
// ===========================================

describe("workspaceSwitchCommand", () => {
	it("persists the new workspace_id into the active server entry when a servers map exists", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_new" }, { id: "ws_local" }]);
		mockReadLocalConfig.mockReturnValue({
			active_server: "production",
			workspace_id: "ws_old_top",
			servers: {
				production: { server_url: "https://prod", workspace_id: "ws_old_prod" },
				local: { server_url: "http://localhost:8787", workspace_id: "ws_local" },
			},
		});

		await workspaceSwitchCommand("ws_new");

		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
		const arg = parseWire(nonNull(mockUpdateLocalConfig.mock.calls[0])[0], wireObject({ "workspace_id": wireString, "servers": wireRecord(wireObject({ "workspace_id": wireString, "server_url": wireString })) }), "test JSON value");
		expect(arg.workspace_id).toBe("ws_new");
		// Active entry updated; other entries preserved (spread).
		expect(arg.servers.production).toEqual({ server_url: "https://prod", workspace_id: "ws_new" });
		expect(arg.servers.local).toEqual({
			server_url: "http://localhost:8787",
			workspace_id: "ws_local",
		});
		expect(lastLog()).toContain("Switched");
		expect(lastLog()).toContain("ws_new");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("defaults the active server key to 'production' when active_server is unset (|| branch)", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_new" }]);
		mockReadLocalConfig.mockReturnValue({
			servers: {
				production: { server_url: "https://prod", workspace_id: "ws_old" },
			},
		});

		await workspaceSwitchCommand("ws_new");

		const arg = parseWire(nonNull(mockUpdateLocalConfig.mock.calls[0])[0], wireObject({ "servers": wireRecord(wireObject({ "workspace_id": wireString })) }), "test JSON value");
		expect(nonNull(arg.servers.production).workspace_id).toBe("ws_new");
	});

	it("falls back to a flat workspace_id update when there is no servers map", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_newtop" }]);
		mockReadLocalConfig.mockReturnValue({ workspace_id: "ws_old" });

		await workspaceSwitchCommand("ws_newtop");

		expect(mockUpdateLocalConfig).toHaveBeenCalledTimes(1);
		expect(nonNull(mockUpdateLocalConfig.mock.calls[0])[0]).toEqual({ workspace_id: "ws_newtop" });
		expect(lastLog()).toContain("Switched");
	});

	it("falls back to a flat update when readLocalConfig returns null (|| {} branch)", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_newtop" }]);
		mockReadLocalConfig.mockReturnValue(null);

		await workspaceSwitchCommand("ws_newtop");

		expect(nonNull(mockUpdateLocalConfig.mock.calls[0])[0]).toEqual({ workspace_id: "ws_newtop" });
	});

	it("falls back to a flat update when the active server key has no entry in the servers map", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_newtop" }]);
		// active_server points at a key absent from servers -> servers?.[key] is undefined.
		mockReadLocalConfig.mockReturnValue({
			active_server: "staging",
			servers: { production: { server_url: "https://prod", workspace_id: "ws_old" } },
		});

		await workspaceSwitchCommand("ws_newtop");

		expect(nonNull(mockUpdateLocalConfig.mock.calls[0])[0]).toEqual({ workspace_id: "ws_newtop" });
	});

	it("rejects an id that does not match the ws_<alnum> pattern and exits 1 (no fetch, no write)", async () => {
		await expect(workspaceSwitchCommand("not-a-ws-id")).rejects.toThrow("process.exit:1");

		expect(mockFetchWorkspaces).not.toHaveBeenCalled();
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		expect(lastErr()).toContain("Error:");
		expect(lastErr()).toContain("Invalid workspace ID 'not-a-ws-id'");
		expect(lastErr()).toContain("Expected format: ws_<alphanumeric>");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("errors with the available-ids suffix when the workspace is not found and ids exist", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_a" }, { id: "ws_b" }, { id: undefined }]);
		mockReadLocalConfig.mockReturnValue({});

		await expect(workspaceSwitchCommand("ws_missing")).rejects.toThrow("process.exit:1");

		const msg = lastErr();
		expect(msg).toContain("Workspace 'ws_missing' was not found in your workspace list.");
		// undefined id is filtered out; only real ids are listed.
		expect(msg).toContain("Available IDs: ws_a, ws_b");
		expect(msg).not.toContain("undefined");
		expect(mockUpdateLocalConfig).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("errors with the no-accessible-workspaces suffix when the list is empty", async () => {
		mockFetchWorkspaces.mockResolvedValue([]);
		mockReadLocalConfig.mockReturnValue({});

		await expect(workspaceSwitchCommand("ws_missing")).rejects.toThrow("process.exit:1");

		const msg = lastErr();
		expect(msg).toContain("Workspace 'ws_missing' was not found in your workspace list.");
		expect(msg).toContain("No accessible workspaces were returned by the server.");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("errors with the no-accessible suffix when every returned id is falsy (filter empties the list)", async () => {
		// Workspaces exist but all ids are undefined -> available.length === 0
		// even though workspaces.length > 0. Exercises the filter + length===0 path.
		mockFetchWorkspaces.mockResolvedValue([{ id: undefined }, { id: undefined }]);
		mockReadLocalConfig.mockReturnValue({});

		await expect(workspaceSwitchCommand("ws_missing")).rejects.toThrow("process.exit:1");

		expect(lastErr()).toContain("No accessible workspaces were returned by the server.");
	});

	it("surfaces a fetch failure (server unreachable) via the catch path and exits 1", async () => {
		mockFetchWorkspaces.mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(workspaceSwitchCommand("ws_ok")).rejects.toThrow("process.exit:1");

		expect(lastErr()).toContain("Error:");
		expect(lastErr()).toContain("ECONNREFUSED");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("stringifies a non-Error throwable in the switch catch branch", async () => {
		mockFetchWorkspaces.mockResolvedValue([{ id: "ws_ok" }]);
		mockReadLocalConfig.mockReturnValue({ workspace_id: "ws_old" });
		mockUpdateLocalConfig.mockImplementation(() => {
			throw "disk full";
		});

		await expect(workspaceSwitchCommand("ws_ok")).rejects.toThrow("process.exit:1");

		expect(lastErr()).toContain("Error:");
		expect(lastErr()).toContain("disk full");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
