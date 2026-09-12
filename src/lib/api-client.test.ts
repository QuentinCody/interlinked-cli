// Behavioral tests for src/lib/api-client.ts — the POST /api/ui/call HTTP
// wrapper. fetch, auth-token resolution, and config are all mocked so the
// suite is deterministic with no real network or timing. Every branch of
// every export is exercised against real outputs / throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "./json-types.js";
import { nonNull } from "./non-null.js";

const { mockResolveAuthToken, mockResolveAuthTokenWithRefresh, mockResolveConfig } = vi.hoisted(
	() => ({
		mockResolveAuthToken: vi.fn<() => string | null>(),
		mockResolveAuthTokenWithRefresh: vi.fn<() => Promise<string | null>>(),
		mockResolveConfig: vi.fn(),
	}),
);

vi.mock("./auth.js", () => ({
	resolveAuthToken: mockResolveAuthToken,
	resolveAuthTokenWithRefresh: mockResolveAuthTokenWithRefresh,
}));

vi.mock("./config.js", () => ({
	resolveConfig: mockResolveConfig,
}));

const { InterlinkedClient, getClient } = await import("./api-client.js");

/** Build a minimal ResolvedConfig-shaped object for resolveConfig mocks. */
function cfg(over: Record<string, unknown> = {}) {
	return {
		server_url: "https://server.example",
		sync_mode: "realtime",
		...over,
	};
}

/** A fetch Response stand-in. Only the fields api-client touches are modeled. */
function makeRes(opts: {
	status?: number;
	ok?: boolean;
	json?: unknown;
	jsonThrows?: unknown;
	text?: string;
}): Response {
	const status = opts.status ?? 200;
	const ok = opts.ok ?? (status >= 200 && status < 300);
	const response = new Response(opts.text ?? "", { status });
	Object.defineProperty(response, "ok", { value: ok });
	vi.spyOn(response, "json").mockImplementation(async () => {
		if (opts.jsonThrows !== undefined) throw opts.jsonThrows;
		return opts.json;
	});
	return response;
}

let fetchMock = vi.fn<typeof fetch>();

function recordedFetch(index = 0): [RequestInfo | URL, RequestInit] {
	const [url, init] = nonNull(fetchMock.mock.calls[index]);
	return [url, nonNull(init)];
}

function jsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
	if (typeof body !== "string") throw new Error("Expected a JSON request body");
	const value: unknown = JSON.parse(body);
	if (!isJsonObject(value)) throw new Error("Expected a JSON request object");
	return value;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Defaults: remote server, no ambient on-disk token, refresh returns null.
	mockResolveConfig.mockReturnValue(cfg());
	mockResolveAuthToken.mockReturnValue(null);
	mockResolveAuthTokenWithRefresh.mockResolvedValue(null);
	fetchMock = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("constructor", () => {
	it("prefers explicit options over config for serverUrl / workspaceId / token", () => {
		mockResolveConfig.mockReturnValue(cfg({ server_url: "https://from-config", workspace_id: "cfg-ws" }));
		const c = new InterlinkedClient({
			serverUrl: "https://from-opts",
			workspaceId: "opt-ws",
			token: "opt-token",
		});
		expect(c.isLocalDevServer()).toBe(false); // uses https://from-opts
		expect(c.isAuthenticated()).toBe(true); // opt-token
	});

	it("falls back to config server_url / workspace_id when options omitted", () => {
		mockResolveConfig.mockReturnValue(cfg({ server_url: "http://localhost:9999", workspace_id: "cfg-ws" }));
		const c = new InterlinkedClient();
		expect(c.isLocalDevServer()).toBe(true); // localhost from config
	});

	it("resolves token via resolveAuthToken() when no explicit token", () => {
		mockResolveAuthToken.mockReturnValue("ambient-token");
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		expect(c.isAuthenticated()).toBe(true);
		expect(mockResolveAuthToken).toHaveBeenCalled();
	});

	it("token is null when neither option nor resolveAuthToken supplies one", () => {
		mockResolveAuthToken.mockReturnValue(null);
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		expect(c.isAuthenticated()).toBe(false);
	});
});

describe("getConfig / isAuthenticated / isLocalDevServer", () => {
	it("getConfig returns whatever resolveConfig returns", () => {
		const conf = cfg({ default_project: "proj" });
		mockResolveConfig.mockReturnValue(conf);
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		expect(c.getConfig()).toBe(conf);
	});

	it("isLocalDevServer matches localhost and 127.0.0.1, rejects others", () => {
		expect(new InterlinkedClient({ serverUrl: "http://localhost:1" }).isLocalDevServer()).toBe(true);
		expect(new InterlinkedClient({ serverUrl: "http://127.0.0.1:1" }).isLocalDevServer()).toBe(true);
		expect(new InterlinkedClient({ serverUrl: "https://prod.example" }).isLocalDevServer()).toBe(false);
	});
});

describe("ensureToken (via callTool side effects)", () => {
	it("with explicit token, does NOT call refresh and keeps the explicit token", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "explicit" });
		fetchMock.mockResolvedValue(makeRes({ json: { ok: 1 } }));
		await c.callTool("t");
		expect(mockResolveAuthTokenWithRefresh).not.toHaveBeenCalled();
		const [, init] = recordedFetch();
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer explicit");
	});

	it("without explicit token, refreshes and uses the refreshed token", async () => {
		mockResolveAuthToken.mockReturnValue(null);
		mockResolveAuthTokenWithRefresh.mockResolvedValue("refreshed");
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		expect(mockResolveAuthTokenWithRefresh).toHaveBeenCalledWith("https://x");
		const [, init] = recordedFetch();
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer refreshed");
	});
});

describe("callTool", () => {
	it("throws the not-authenticated error when no token and not local dev", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://prod.example" });
		await expect(c.callTool("t")).rejects.toThrow(/Not authenticated\. Run 'interlinked login'/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses default workspace/project keys from config and merges args", async () => {
		mockResolveConfig.mockReturnValue(
			cfg({ default_workspace_key: "ws-key", default_project: "proj-key" }),
		);
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: { r: 1 } }));
		await c.callTool("mytool", { extra: "v", workspace_key: "override" });
		const [url, init] = recordedFetch();
		expect(url).toBe("https://x/api/ui/call");
		expect(init.method).toBe("POST");
		const body = jsonBody(init.body);
		expect(body.tool).toBe("mytool");
		expect(body.args).toMatchObject({
			workspace_key: "override", // caller arg wins over default
			project_key: "proj-key",
			extra: "v",
		});
	});

	it("falls back to 'main' workspace/project keys when config omits them", async () => {
		mockResolveConfig.mockReturnValue(cfg());
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		const body = jsonBody(recordedFetch()[1].body);
		expect(body.args).toHaveProperty("workspace_key", "main");
		expect(body.args).toHaveProperty("project_key", "main");
	});

	it("includes workspace in body when workspaceId is set", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk", workspaceId: "ws-99" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		const body = jsonBody(recordedFetch()[1].body);
		expect(body.workspace).toBe("ws-99");
	});

	it("omits workspace from body when workspaceId is not set", async () => {
		mockResolveConfig.mockReturnValue(cfg({ workspace_id: undefined }));
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		const body = jsonBody(recordedFetch()[1].body);
		expect(body).not.toHaveProperty("workspace");
	});

	it("sends Bearer header for a real token on a remote server", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "real" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		const headers = new Headers(recordedFetch()[1].headers);
		expect(headers.get("Authorization")).toBe("Bearer real");
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	it("omits Bearer header on a local dev server even with a token", async () => {
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787", token: "real" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.callTool("t");
		const headers = new Headers(recordedFetch()[1].headers);
		expect(headers.has("Authorization")).toBe(false);
	});

	it("proceeds without auth header on a local dev server with no token", async () => {
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787" });
		fetchMock.mockResolvedValue(makeRes({ json: { ok: true } }));
		const r = await c.callTool("t");
		expect(r).toEqual({ ok: true });
		const headers = new Headers(recordedFetch()[1].headers);
		expect(headers.has("Authorization")).toBe(false);
	});

	it("throws the auth-failed error on HTTP 401", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ status: 401, ok: false }));
		await expect(c.callTool("t")).rejects.toThrow(/Authentication failed.*token may have expired/);
	});

	it("returns the parsed JSON body on success", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: { value: 42 } }));
		const r = await c.callTool("t");
		expect(r).toEqual({ value: 42 });
	});

	it("error body: uses error.message when present", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(
			makeRes({ status: 500, ok: false, json: { error: { message: "boom-inner" } } }),
		);
		await expect(c.callTool("t")).rejects.toThrow("API error (500): boom-inner");
	});

	it("error body: falls back to top-level message when error.message absent", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(
			makeRes({ status: 400, ok: false, json: { message: "top-msg" } }),
		);
		await expect(c.callTool("t")).rejects.toThrow("API error (400): top-msg");
	});

	it("error body: falls back to JSON.stringify when object has no message fields", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(
			makeRes({ status: 503, ok: false, json: { detail: "nope" } }),
		);
		await expect(c.callTool("t")).rejects.toThrow('API error (503): {"detail":"nope"}');
	});

	it("error body: stringifies a non-object JSON value", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ status: 502, ok: false, json: "plain string error" }));
		await expect(c.callTool("t")).rejects.toThrow("API error (502): plain string error");
	});

	it("error body: handles null JSON value via String()", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ status: 500, ok: false, json: null }));
		await expect(c.callTool("t")).rejects.toThrow("API error (500): null");
	});
});

describe("fetchWorkspaces", () => {
	it.each([null, [], { workspaces: "invalid" }, { workspaces: [{ id: 4, name: "project" }] }, { workspaces: [null] }])("rejects malformed workspace records (%j)", async (json) => {
		const client = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json }));
		await expect(client.fetchWorkspaces()).rejects.toThrow(/Workspace response/);
	});

	it("preserves optional workspace role and display name", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		const workspace = { id: "1", name: "a", role: "owner", display_name: "Project A" };
		fetchMock.mockResolvedValue(makeRes({ json: { workspaces: [workspace] } }));
		expect(await c.fetchWorkspaces()).toEqual([workspace]);
	});

	it("applies the caller's parser to a successful tool response", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: { count: 7 } }));
		expect(await c.callTool("count", {}, (value) => JSON.stringify(value))).toBe('{"count":7}');
	});

	it("propagates a response parser's validation failure", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: null }));
		await expect(c.callTool("count", {}, () => { throw new Error("invalid count response"); })).rejects.toThrow("invalid count response");
	});
	it("throws when no token and not local dev", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://prod.example" });
		await expect(c.fetchWorkspaces()).rejects.toThrow(/Not authenticated\. Run 'interlinked login'/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("GETs the registry endpoint with a Bearer header for a remote token", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: { workspaces: [{ id: "1", name: "a" }] } }));
		const ws = await c.fetchWorkspaces();
		const [url, init] = recordedFetch();
		expect(url).toBe("https://x/api/workspaces");
		expect(init.method).toBe("GET");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tk");
		expect(ws).toEqual([{ id: "1", name: "a" }]);
	});

	it("omits the auth header on a local dev server", async () => {
		const c = new InterlinkedClient({ serverUrl: "http://127.0.0.1:8787" });
		fetchMock.mockResolvedValue(makeRes({ json: { workspaces: [] } }));
		await c.fetchWorkspaces();
		const headers = new Headers(recordedFetch()[1].headers);
		expect(headers.has("Authorization")).toBe(false);
	});

	it("throws the auth-failed error on 401", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ status: 401, ok: false }));
		await expect(c.fetchWorkspaces()).rejects.toThrow(/Authentication failed/);
	});

	it("throws an API error with the response text on non-ok, non-401", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ status: 500, ok: false, text: "server exploded" }));
		await expect(c.fetchWorkspaces()).rejects.toThrow("API error (500): server exploded");
	});

	it("returns [] when the response has no workspaces field", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		expect(await c.fetchWorkspaces()).toEqual([]);
	});
});

describe("callTools", () => {
	it("runs each call in sequence and collects results, defaulting args to {}", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ json: { a: 1 } }))
			.mockResolvedValueOnce(makeRes({ json: { b: 2 } }));
		const results = await c.callTools([
			{ name: "first", args: { x: 1 } },
			{ name: "second" }, // no args → defaults to {}
		]);
		expect(results).toEqual([{ a: 1 }, { b: 2 }]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const body2 = jsonBody(recordedFetch(1)[1].body);
		expect(body2.tool).toBe("second");
	});

	it("returns an empty array for no calls", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		expect(await c.callTools([])).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("postHookEvent", () => {
	it("returns early (no fetch) when no token and not local dev", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://prod.example" });
		await expect(
			c.postHookEvent({ agent_name: "a", event_type: "e" }),
		).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("POSTs to the activity endpoint by default with merged payload + Bearer", async () => {
		mockResolveConfig.mockReturnValue(
			cfg({ default_workspace_key: "wk", default_project: "pk" }),
		);
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.postHookEvent({ agent_name: "ag", event_type: "tool", tool_name: "Bash" });
		const [url, init] = recordedFetch();
		expect(url).toBe("https://x/api/hooks/activity");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tk");
		const payload = jsonBody(init.body);
		expect(payload).toMatchObject({
			workspace_key: "wk",
			project_key: "pk",
			agent_name: "ag",
			event_type: "tool",
			tool_name: "Bash",
		});
	});

	it("POSTs to the lifecycle endpoint when type is 'lifecycle'", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.postHookEvent({ agent_name: "ag", event_type: "session_start" }, "lifecycle");
		expect(recordedFetch()[0]).toBe("https://x/api/hooks/lifecycle");
	});

	it("uses 'main' fallbacks and omits the auth header on a local dev server", async () => {
		mockResolveConfig.mockReturnValue(cfg());
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787" });
		fetchMock.mockResolvedValue(makeRes({ json: {} }));
		await c.postHookEvent({ agent_name: "ag", event_type: "tool" });
		const [, init] = recordedFetch();
		expect(init.headers).not.toHaveProperty("Authorization");
		const payload = jsonBody(init.body);
		expect(payload.workspace_key).toBe("main");
		expect(payload.project_key).toBe("main");
	});

	it("swallows fetch rejections (fire-and-forget)", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(
			c.postHookEvent({ agent_name: "ag", event_type: "tool" }),
		).resolves.toBeUndefined();
	});
});

describe("healthCheck", () => {
	it("reports unreachable when the /health ping fails (fetch rejects → null)", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockRejectedValueOnce(new Error("conn refused"));
		const r = await c.healthCheck();
		expect(r).toEqual({ serverReachable: false, authenticated: false, error: "server unreachable" });
	});

	it("reports unreachable when the /health ping returns non-ok", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock.mockResolvedValueOnce(makeRes({ status: 503, ok: false }));
		const r = await c.healthCheck();
		expect(r.serverReachable).toBe(false);
		expect(r.error).toBe("server unreachable");
	});

	it("local dev with no token: pings, calls health_check, extracts version", async () => {
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ ok: true, json: {} })) // /health ping
			.mockResolvedValueOnce(makeRes({ json: { version: "1.2.3" } })); // health_check tool
		const r = await c.healthCheck();
		expect(r).toEqual({ serverReachable: true, authenticated: true, serverVersion: "1.2.3" });
	});

	it("local dev with no token: version undefined when result is not an object", async () => {
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ ok: true, json: {} })) // ping
			.mockResolvedValueOnce(makeRes({ json: "not-an-object" })); // health_check tool
		const r = await c.healthCheck();
		expect(r.serverVersion).toBeUndefined();
		expect(r.authenticated).toBe(true);
	});

	it("remote with no token: reachable but unauthenticated", async () => {
		mockResolveConfig.mockReturnValue(cfg({ workspace_id: undefined }));
		mockResolveAuthTokenWithRefresh.mockResolvedValue(null);
		const c = new InterlinkedClient({ serverUrl: "https://prod.example" });
		fetchMock.mockResolvedValueOnce(makeRes({ ok: true, json: {} })); // ping only
		const r = await c.healthCheck();
		expect(r).toEqual({ serverReachable: true, authenticated: false, error: "No auth token" });
		expect(fetchMock).toHaveBeenCalledTimes(1); // no health_check tool call
	});

	it("remote with token: pings, calls health_check, extracts version", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ ok: true, json: {} })) // ping
			.mockResolvedValueOnce(makeRes({ json: { version: "9.9.9" } })); // health_check tool
		const r = await c.healthCheck();
		expect(r).toEqual({ serverReachable: true, authenticated: true, serverVersion: "9.9.9" });
	});

	it("remote with token: version undefined when health_check returns null", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ ok: true, json: {} })) // ping
			.mockResolvedValueOnce(makeRes({ json: null })); // health_check tool → null
		const r = await c.healthCheck();
		expect(r.serverVersion).toBeUndefined();
		expect(r.authenticated).toBe(true);
	});

	it("maps an 'Authentication failed' error to token-invalid (reachable)", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://x", token: "tk" });
		fetchMock
			.mockResolvedValueOnce(makeRes({ ok: true, json: {} })) // ping ok
			.mockResolvedValueOnce(makeRes({ status: 401, ok: false })); // health_check → 401 throws
		const r = await c.healthCheck();
		expect(r).toEqual({
			serverReachable: true,
			authenticated: false,
			error: "Token invalid or expired",
		});
	});

	it("maps any other thrown error to unreachable with its message", async () => {
		// Force the catch via a non-auth error path: ensureToken throws.
		mockResolveAuthTokenWithRefresh.mockRejectedValueOnce(new Error("refresh blew up"));
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		const r = await c.healthCheck();
		expect(r).toEqual({
			serverReachable: false,
			authenticated: false,
			error: "refresh blew up",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stringifies a non-Error thrown value in the catch", async () => {
		mockResolveAuthTokenWithRefresh.mockRejectedValueOnce("string failure");
		const c = new InterlinkedClient({ serverUrl: "https://x" });
		const r = await c.healthCheck();
		expect(r.serverReachable).toBe(false);
		expect(r.error).toBe("string failure");
	});
});

describe("getClient", () => {
	it("returns a fresh instance when options are provided", () => {
		const a = getClient({ serverUrl: "https://a", token: "t1" });
		const b = getClient({ serverUrl: "https://b", token: "t2" });
		expect(a).not.toBe(b);
		expect(a).toBeInstanceOf(InterlinkedClient);
	});

	it("returns a cached shared singleton when no options are provided", () => {
		const a = getClient();
		const b = getClient();
		expect(a).toBe(b);
		expect(a).toBeInstanceOf(InterlinkedClient);
	});
});
