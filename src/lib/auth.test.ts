// Behavioral coverage for auth.ts — token resolution, OAuth PKCE login,
// Claude Code credential fallback, and token persistence. Every external
// edge is mocked so assertions are on real, deterministic outputs/throws:
//   - ./config.js   → control resolveConfig, spy updateLocalConfig
//   - node:fs       → fake the ~/.claude/.credentials.json store
//   - node:crypto   → deterministic PKCE verifier/challenge/state
//   - node:http     → fake callback server (no real port bind)
//   - node:child_process → spy spawn (openBrowser), no real browser launch
//   - global.fetch  → fake /register, /token, refresh responses
// No real HTTP/OAuth/disk/time.

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- module mocks ---------------------------------------------------------

vi.mock("./config.js", () => ({
	resolveConfig: vi.fn(),
	updateLocalConfig: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

// Deterministic PKCE: randomBytes returns a fixed buffer; createHash returns
// a stub digest. We assert the *derived* values flow into the authorize URL
// and token exchange, not the entropy itself.
vi.mock("node:crypto", () => {
	const digestImpl = vi.fn(() => "STUBCHALLENGE");
	const updateImpl = vi.fn(() => ({ digest: digestImpl }));
	return {
		randomBytes: vi.fn((n: number) => Buffer.alloc(n, 7)),
		createHash: vi.fn(() => ({ update: updateImpl })),
	};
});

// node:http — createServer returns a controllable fake. Tests drive the
// request handler and the listen callback by hand.
const httpState: {
	requestHandler:
		| ((req: { url?: string }, res: FakeRes) => void)
		| null;
	server: FakeServer | null;
	// Synchronous hook invoked at the top of FakeServer.listen — edge tests use
	// it to mutate address / emit error before the success callback runs.
	beforeListen?: ((server: FakeServer) => void) | undefined;
} = { requestHandler: null, server: null, beforeListen: undefined };

vi.mock("node:http", () => ({
	createServer: vi.fn((handler: (req: { url?: string }, res: FakeRes) => void) => {
		httpState.requestHandler = handler;
		const server = new FakeServer();
		httpState.server = server;
		return server;
	}),
}));

// node:child_process — openBrowser does `await import("node:child_process")`.
const spawnMock = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => ({ unref: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// ---- imports (after mocks) ------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
	performLogin,
	resolveAuthToken,
	resolveAuthTokenWithRefresh,
	saveLoginTokens,
} from "./auth.js";
import type { ResolvedConfig } from "./config.js";
import { resolveConfig, updateLocalConfig } from "./config.js";
import { nonNull } from "./non-null.js";

const resolveConfigMock = vi.mocked(resolveConfig);
const updateLocalConfigMock = vi.mocked(updateLocalConfig);
const existsSyncMock = vi.mocked(existsSync);
const readFileSyncMock = vi.mocked(readFileSync);

// ---- fakes for node:http --------------------------------------------------

interface FakeRes {
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	statusCode?: number | undefined;
	headers?: Record<string, string> | undefined;
	body?: string | undefined;
}

function makeRes(): FakeRes {
	const res: FakeRes = {
		writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
			res.statusCode = status;
			res.headers = headers;
		}),
		end: vi.fn((body?: string) => {
			res.body = body;
		}),
	};
	return res;
}

class FakeServer extends EventEmitter {
	listenArgs: unknown[] | null = null;
	closed = false;
	errored = false;
	private addr: { port: number } | string | null = { port: 54321 };

	listen(port: number, host: string, cb: () => void): this {
		this.listenArgs = [port, host, cb];
		// Synchronous per-test hook: edge tests mutate address / emit 'error'
		// BEFORE the success callback observes server state, so the reject path
		// is taken deterministically (no race with the subsequent fetch).
		httpState.beforeListen?.(this);
		// Defer so the in-flight Promise executor finishes wiring first. Skip the
		// success callback if an 'error' has already rejected the outer promise.
		if (!this.errored) queueMicrotask(cb);
		return this;
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		if (event === "error") this.errored = true;
		return super.emit(event, ...args);
	}

	address(): { port: number } | string | null {
		return this.addr;
	}

	setAddress(addr: { port: number } | string | null): void {
		this.addr = addr;
	}

	close(): void {
		this.closed = true;
	}
}

// ---- helpers --------------------------------------------------------------

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		server_url: "https://server.example",
		sync_mode: "realtime",
		...overrides,
	};
}

function futureIso(msAhead = 60_000): string {
	return new Date(Date.now() + msAhead).toISOString();
}
function pastIso(msAgo = 60_000): string {
	return new Date(Date.now() - msAgo).toISOString();
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	const response = new Response(JSON.stringify(body), { status });
	Object.defineProperty(response, "ok", { value: ok });
	return response;
}
function errorResponse(status: number, text: string): Response {
	return new Response(text, { status });
}

function recordedFetch(call: Parameters<typeof fetch> | undefined): [RequestInfo | URL, RequestInit] {
	const [url, init] = nonNull(call);
	return [url, nonNull(init)];
}

function encodedBody(body: BodyInit | null | undefined): string {
	if (!(body instanceof URLSearchParams)) throw new Error("Expected form-encoded request body");
	return body.toString();
}

function jsonBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") throw new Error("Expected JSON request body");
	return JSON.parse(body);
}

beforeEach(() => {
	vi.clearAllMocks();
	httpState.requestHandler = null;
	httpState.server = null;
	httpState.beforeListen = undefined;
	// Default: no credentials file on disk.
	existsSyncMock.mockReturnValue(false);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ===========================================================================
// resolveAuthToken — CLI token + expiry + Claude Code fallback
// ===========================================================================

describe("resolveAuthToken", () => {
	it("returns the CLI token when present with a future expiry", () => {
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "cli-tok", token_expires_at: futureIso() }),
		);
		expect(resolveAuthToken("/cwd")).toBe("cli-tok");
		expect(resolveConfigMock).toHaveBeenCalledWith("/cwd");
	});

	it("returns the CLI token when present with NO expiry recorded", () => {
		resolveConfigMock.mockReturnValue(cfg({ access_token: "no-exp-tok" }));
		expect(resolveAuthToken()).toBe("no-exp-tok");
	});

	it("falls through to fallback when the CLI token is expired", () => {
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "stale", token_expires_at: pastIso() }),
		);
		// No credentials file → null.
		expect(resolveAuthToken()).toBeNull();
	});

	it("treats a CLI token expiring at this instant as expired", () => {
		vi.useFakeTimers();
		const now = new Date("2026-08-13T12:00:00.000Z");
		vi.setSystemTime(now);
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "at-the-boundary", token_expires_at: now.toISOString() }),
		);

		expect(resolveAuthToken()).toBeNull();
	});

	it("returns null when there is no CLI token and no credentials file", () => {
		resolveConfigMock.mockReturnValue(cfg());
		expect(resolveAuthToken()).toBeNull();
	});

	it("falls back to a Claude Code credential matched by mcp_prefix", () => {
		resolveConfigMock.mockReturnValue(cfg({ mcp_prefix: "il_" }));
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					il_server: { accessToken: "prefix-tok", serverName: "whatever" },
				},
			}),
		);
		expect(resolveAuthToken()).toBe("prefix-tok");
	});
});

// ===========================================================================
// readClaudeCodeToken (via resolveAuthToken) — every fallback branch
// ===========================================================================

describe("Claude Code credential fallback (readClaudeCodeToken)", () => {
	beforeEach(() => {
		// CLI token absent so every call reaches the fallback.
		resolveConfigMock.mockReturnValue(cfg({ mcp_prefix: "il_" }));
		existsSyncMock.mockReturnValue(true);
	});

	it("returns null when the credentials JSON is malformed", () => {
		readFileSyncMock.mockReturnValue("{not json");
		expect(resolveAuthToken()).toBeNull();
	});

	it("returns null when mcpOAuth is missing or not an object", () => {
		readFileSyncMock.mockReturnValue(JSON.stringify({ mcpOAuth: "nope" }));
		expect(resolveAuthToken()).toBeNull();
	});

	it("skips a prefix match that is expired and falls to serverName strategy", () => {
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					il_a: {
						accessToken: "expired-prefix",
						serverName: "x",
						expires_at: pastIso(),
					},
					other: {
						accessToken: "by-name",
						serverName: "Interlinked Prod",
					},
				},
			}),
		);
		expect(resolveAuthToken()).toBe("by-name");
	});

	it("matches by serverName (case-insensitive) when no prefix is given", () => {
		resolveConfigMock.mockReturnValue(cfg()); // no mcp_prefix
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					whatever: { accessToken: "name-tok", serverName: "MY interlinked" },
				},
			}),
		);
		expect(resolveAuthToken()).toBe("name-tok");
	});

	it("returns null when serverName match exists but is expired", () => {
		resolveConfigMock.mockReturnValue(cfg());
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					whatever: {
						accessToken: "expired-name",
						serverName: "interlinked",
						expiresAt: pastIso(),
					},
				},
			}),
		);
		expect(resolveAuthToken()).toBeNull();
	});

	it("returns null when no entry matches by prefix or serverName", () => {
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					unrelated: { accessToken: "x", serverName: "github" },
				},
			}),
		);
		expect(resolveAuthToken()).toBeNull();
	});

	it("ignores entries that are not valid cred objects (isCredEntry guard)", () => {
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					il_number: 42,
					il_bad1: null,
					il_bad2: { serverName: "interlinked" }, // no accessToken
					il_bad3: { accessToken: 123 }, // wrong type
					il_good: { accessToken: "good", serverName: "interlinked" },
				},
			}),
		);
		expect(resolveAuthToken()).toBe("good");
	});

	it("does not let a missing prefix select an unrelated entry before a named match", () => {
		resolveConfigMock.mockReturnValue(cfg());
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					unrelated: { accessToken: "wrong", serverName: "GitHub" },
					linked: { accessToken: "right", serverName: "Interlinked Cloud" },
				},
			}),
		);

		expect(resolveAuthToken()).toBe("right");
	});
});

// ===========================================================================
// Expiry parsing (resolveCredExpiry / parseExpiryValue) via fallback
// ===========================================================================

describe("credential expiry parsing", () => {
	function tokenFromEntry(entry: Record<string, unknown>): string | null {
		resolveConfigMock.mockReturnValue(cfg());
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: {
					e: { accessToken: "tok", serverName: "interlinked", ...entry },
				},
			}),
		);
		return resolveAuthToken();
	}

	it("treats an entry with no expiry fields as not-expired", () => {
		expect(tokenFromEntry({})).toBe("tok");
	});

	it("parses epoch-seconds (number) — future = valid", () => {
		expect(tokenFromEntry({ exp: Math.floor(Date.now() / 1000) + 600 })).toBe(
			"tok",
		);
	});

	it("parses epoch-seconds (number) — past = expired", () => {
		expect(tokenFromEntry({ exp: Math.floor(Date.now() / 1000) - 600 })).toBeNull();
	});

	it("parses epoch-milliseconds (number > 1e12) — future = valid", () => {
		expect(tokenFromEntry({ expiry: Date.now() + 600_000 })).toBe("tok");
	});

	it("expires an epoch-milliseconds value from the recent past", () => {
		expect(tokenFromEntry({ expiry: Date.now() - 600_000 })).toBeNull();
	});

	it("parses a numeric string as epoch seconds", () => {
		const secs = String(Math.floor(Date.now() / 1000) + 600);
		expect(tokenFromEntry({ tokenExpiresAt: secs })).toBe("tok");
	});

	it("expires a numeric string containing a past epoch", () => {
		const secs = String(Math.floor(Date.now() / 1000) - 600);
		expect(tokenFromEntry({ tokenExpiresAt: secs })).toBeNull();
	});

	it("parses an ISO date string — future = valid", () => {
		expect(tokenFromEntry({ expires_at: futureIso() })).toBe("tok");
	});

	it("expires an ISO date string from the past", () => {
		expect(tokenFromEntry({ expires_at: pastIso() })).toBeNull();
	});

	it("ignores an empty / whitespace string expiry (treats as no expiry)", () => {
		expect(tokenFromEntry({ token_expires_at: "   " })).toBe("tok");
	});

	it("ignores a non-parseable date string (treats as no expiry)", () => {
		expect(tokenFromEntry({ expires_at: "not-a-date" })).toBe("tok");
	});

	it("ignores a non-finite number expiry (NaN) and treats as no expiry", () => {
		// NaN is not finite → parseExpiryValue returns null → not expired.
		expect(tokenFromEntry({ exp: Number.NaN })).toBe("tok");
	});

	it("prefers the first present candidate field (token_expires_at wins)", () => {
		// token_expires_at past → expired even though a later field is future.
		expect(
			tokenFromEntry({ token_expires_at: pastIso(), exp: Date.now() / 1000 + 600 }),
		).toBeNull();
	});

	it("ignores a non-string/non-number expiry value (boolean → no expiry)", () => {
		// A boolean reaches parseExpiryValue's final `return null` (neither the
		// number nor the string branch), so the entry is treated as not expired.
		expect(tokenFromEntry({ exp: true })).toBe("tok");
	});

	it("ignores a finite number that overflows into an Invalid Date", () => {
		// 1e300 is finite, so it passes the guard, but new Date(1e300) is an
		// Invalid Date → the NaN side of the ternary returns null → not expired.
		expect(tokenFromEntry({ expiry: 1e300 })).toBe("tok");
	});

	it("treats credential expiry exactly at now as expired", () => {
		vi.useFakeTimers();
		const now = new Date("2026-08-13T12:00:00.000Z");
		vi.setSystemTime(now);
		expect(tokenFromEntry({ exp: now.toISOString() })).toBeNull();
	});

	it("distinguishes the epoch-seconds/milliseconds cutoff at exactly 1e12", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_000_000_000_000));
		// Exactly 1e12 is interpreted as epoch seconds by the strict `>` check,
		// producing an invalid date and therefore no expiry. A `>=` mutant
		// interprets it as milliseconds and expires it at the current instant.
		expect(tokenFromEntry({ exp: 1_000_000_000_000 })).toBe("tok");
	});
});

// ===========================================================================
// Credential path resolution — HOME / USERPROFILE / "~" fallback chain
// ===========================================================================

describe("credential path home-dir resolution", () => {
	const savedHome = process.env.HOME;
	const savedUserProfile = process.env.USERPROFILE;

	afterEach(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedUserProfile;
	});

	it("uses USERPROFILE when HOME is unset", () => {
		resolveConfigMock.mockReturnValue(cfg());
		delete process.env.HOME;
		process.env.USERPROFILE = "/winhome";
		// We can't assert the path directly, but existsSync receives it; capture.
		existsSyncMock.mockImplementation((p: unknown) => {
			expect(String(p)).toContain("/winhome");
			return false;
		});
		expect(resolveAuthToken()).toBeNull();
		expect(existsSyncMock).toHaveBeenCalled();
	});

	it("falls back to '~' when both HOME and USERPROFILE are unset", () => {
		resolveConfigMock.mockReturnValue(cfg());
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		existsSyncMock.mockImplementation((p: unknown) => {
			expect(String(p)).toContain("~");
			return false;
		});
		expect(resolveAuthToken()).toBeNull();
	});

	it("reads the expected Claude credentials path and UTF-8 encoding", () => {
		resolveConfigMock.mockReturnValue(cfg());
		process.env.HOME = "/home/tester";
		process.env.USERPROFILE = "/ignored-profile";
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({ mcpOAuth: { e: { accessToken: "tok", serverName: "interlinked" } } }),
		);

		expect(resolveAuthToken()).toBe("tok");
		expect(existsSyncMock).toHaveBeenCalledWith(
			"/home/tester/.claude/.credentials.json",
		);
		expect(readFileSyncMock).toHaveBeenCalledWith(
			"/home/tester/.claude/.credentials.json",
			"utf-8",
		);
	});
});

// ===========================================================================
// resolveAuthTokenWithRefresh
// ===========================================================================

describe("resolveAuthTokenWithRefresh", () => {
	it.each([{ access_token: 7 }, { access_token: "" }, { access_token: "valid", refresh_token: 7 }, { access_token: "valid", expires_in: "3600" }])("does not persist malformed refresh responses (%j)", async (body) => {
		resolveConfigMock.mockReturnValue(cfg({ access_token: "old", token_expires_at: pastIso(), refresh_token: "rt" }));
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(body)));
		await expect(resolveAuthTokenWithRefresh()).resolves.toBeNull();
		expect(updateLocalConfigMock).not.toHaveBeenCalled();
	});
	it("returns the CLI token immediately when not expired", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "fresh", token_expires_at: futureIso() }),
		);
		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("fresh");
	});

	it("treats a token with no expiry as valid (isExpired false on undefined)", async () => {
		resolveConfigMock.mockReturnValue(cfg({ access_token: "noexp" }));
		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("noexp");
	});

	it("treats a token with an unparseable expiry as valid (NaN branch)", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "weird", token_expires_at: "garbage" }),
		);
		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("weird");
	});

	it("treats a token exactly five seconds from now as expired for skew safety", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-08-13T12:00:00.000Z");
		vi.setSystemTime(now);
		resolveConfigMock.mockReturnValue(
			cfg({
				access_token: "near-expiry",
				token_expires_at: new Date(now.getTime() + 5_000).toISOString(),
			}),
		);

		await expect(resolveAuthTokenWithRefresh()).resolves.toBeNull();
	});

	it("refreshes an expired token, persists it, and returns the new token", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({
				access_token: "old",
				token_expires_at: pastIso(),
				refresh_token: "rt",
				oauth_client_id: "cid",
			}),
		);
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				access_token: "new-tok",
				refresh_token: "new-rt",
				expires_in: 3600,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(resolveAuthTokenWithRefresh("https://override")).resolves.toBe(
			"new-tok",
		);

		// POST to the OVERRIDE server's /token with client_id set.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = recordedFetch(fetchMock.mock.calls[0]);
		expect(url).toBe("https://override/token");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"Content-Type": "application/x-www-form-urlencoded",
		});
		const body = encodedBody(init.body);
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("refresh_token=rt");
		expect(body).toContain("client_id=cid");

		// saveLoginTokens persisted the refreshed token.
		expect(updateLocalConfigMock).toHaveBeenCalledTimes(1);
		const updates = nonNull(updateLocalConfigMock.mock.calls[0])[0];
		expect(updates.access_token).toBe("new-tok");
		expect(updates.refresh_token).toBe("new-rt");
	});

	it("uses config.server_url when no override is passed and omits client_id when absent", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({
				server_url: "https://from-config",
				access_token: "old",
				token_expires_at: pastIso(),
				refresh_token: "rt",
			}),
		);
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({ access_token: "n2" }), // no refresh_token / expires_in
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("n2");
		const [url, init] = recordedFetch(fetchMock.mock.calls[0]);
		expect(url).toBe("https://from-config/token");
		const body = encodedBody(init.body);
		expect(body).not.toContain("client_id");

		// expires_in absent → token_expires_at cleared to undefined.
		const updates = nonNull(updateLocalConfigMock.mock.calls[0])[0];
		expect(updates.token_expires_at).toBeUndefined();
		// refresh_token falls back to the original when server omits it.
		expect(updates.refresh_token).toBe("rt");
	});

	it("falls back to Claude Code creds when refresh fails (non-ok response)", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({
				access_token: "old",
				token_expires_at: pastIso(),
				refresh_token: "rt",
				mcp_prefix: "il_",
			}),
		);
		vi.stubGlobal("fetch", vi.fn(async () => errorResponse(400, "bad refresh")));
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(
			JSON.stringify({
				mcpOAuth: { il_x: { accessToken: "fallback-tok", serverName: "x" } },
			}),
		);

		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("fallback-tok");
		expect(updateLocalConfigMock).not.toHaveBeenCalled();
	});

	it("falls back to Claude Code creds when fetch itself throws", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({
				access_token: "old",
				token_expires_at: pastIso(),
				refresh_token: "rt",
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		// No creds file → null.
		await expect(resolveAuthTokenWithRefresh()).resolves.toBeNull();
	});

	it("skips refresh entirely when there is no refresh_token and goes to fallback", async () => {
		resolveConfigMock.mockReturnValue(
			cfg({ access_token: "old", token_expires_at: pastIso() }),
		);
		const fetchMock = vi.fn<typeof fetch>(async () => {
			throw new Error("fetch must not be called when refresh_token is absent");
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(resolveAuthTokenWithRefresh()).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("goes straight to fallback when there is no CLI access_token at all", async () => {
		resolveConfigMock.mockReturnValue(cfg({ refresh_token: "rt" }));
		// access_token absent → the `if (config.access_token)` block is skipped,
		// but refresh_token present → it WILL attempt refresh.
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "r" })));
		await expect(resolveAuthTokenWithRefresh()).resolves.toBe("r");
	});
});

// ===========================================================================
// saveLoginTokens
// ===========================================================================

describe("saveLoginTokens", () => {
	it("writes access_token plus all optional fields and a computed expiry", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		saveLoginTokens(
			{
				access_token: "a",
				refresh_token: "r",
				expires_in: 3600,
				client_id: "c",
			},
			"/proj",
		);
		expect(updateLocalConfigMock).toHaveBeenCalledTimes(1);
		const [updates, cwd] = nonNull(updateLocalConfigMock.mock.calls[0]);
		expect(cwd).toBe("/proj");
		expect(updates).toMatchObject({
			access_token: "a",
			refresh_token: "r",
			oauth_client_id: "c",
			token_expires_at: "2026-01-01T01:00:00.000Z",
		});
	});

	it("omits optional fields and clears expiry when only access_token is given", () => {
		saveLoginTokens({ access_token: "only" });
		const updates = nonNull(updateLocalConfigMock.mock.calls[0])[0];
		expect(updates).toHaveProperty("access_token", "only");
		expect(updates).toHaveProperty("token_expires_at", undefined);
		expect(updates).not.toHaveProperty("oauth_client_id");
		expect(updates).not.toHaveProperty("refresh_token");
	});
});

// ===========================================================================
// performLogin — OAuth PKCE end-to-end (all mocked)
// ===========================================================================

describe("performLogin", () => {
	// Drive the fake callback server: wait for the handler to be wired, then
	// simulate the browser hitting the given callback URL.
	async function hitCallback(path: string): Promise<FakeRes> {
		// Wait until createServer ran and listen()'s deferred cb resolved the
		// outer startCallbackServer promise (handler is set synchronously).
		while (!httpState.requestHandler) {
			await new Promise((r) => setTimeout(r, 0));
		}
		const res = makeRes();
		// Flush the queued listen() microtask callback first.
		await new Promise((r) => setTimeout(r, 0));
		httpState.requestHandler!({ url: path }, res);
		return res;
	}

	function stubRegisterAndToken(opts?: {
		tokenResponse?: Response;
		registerResponse?: Response;
	}) {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.endsWith("/register")) {
				return (
					opts?.registerResponse ?? jsonResponse({ client_id: "dyn-client" })
				);
			}
			if (url.endsWith("/token")) {
				return (
					opts?.tokenResponse ??
					jsonResponse({
						access_token: "AT",
						refresh_token: "RT",
						expires_in: 7200,
					})
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("completes the full flow: register → authorize → callback → token", async () => {
		const fetchMock = stubRegisterAndToken();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const promise = performLogin("https://oauth.example");
		// state from randomBytes(16) of 0x07 → hex of 16 * 0x07.
		const expectedState = Buffer.alloc(16, 7).toString("hex");
		const res = await hitCallback(`/callback?code=THECODE&state=${expectedState}`);

		const result = await promise;
		expect(result).toEqual({
			access_token: "AT",
			refresh_token: "RT",
			expires_in: 7200,
			client_id: "dyn-client",
		});

		// success page rendered + server closed.
		expect(res.statusCode).toBe(200);
		expect(res.headers).toEqual({ "Content-Type": "text/html" });
		expect(res.body).toContain("Authentication successful");
		expect(httpState.server?.closed).toBe(true);

		// Browser launched via spawn (darwin/win32/linux all route to spawn).
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(createHash).toHaveBeenCalledWith("sha256");
		expect(randomBytes).toHaveBeenNthCalledWith(1, 32);
		expect(randomBytes).toHaveBeenNthCalledWith(2, 16);
		const browserCall = nonNull(spawnMock.mock.calls[0]);
		const browserUrl = String(nonNull(browserCall[1])[0]);
		const authorize = new URL(browserUrl);
		expect(authorize.searchParams.get("response_type")).toBe("code");
		expect(authorize.searchParams.get("client_id")).toBe("dyn-client");
		expect(authorize.searchParams.get("redirect_uri")).toMatch(
			/^http:\/\/localhost:\d+\/callback$/,
		);
		expect(authorize.searchParams.get("code_challenge")).toBe("STUBCHALLENGE");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("state")).toBe(expectedState);
		expect(authorize.searchParams.get("resource")).toBe("https://oauth.example");
		expect(logSpy).toHaveBeenCalledWith("\nOpening browser for authentication...");
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("If the browser doesn't open, visit:\n  "),
		);
		expect(logSpy).toHaveBeenCalledWith(
			"Waiting for callback on http://localhost:54321...",
		);
		expect(logSpy).toHaveBeenCalledWith(
			"This localhost port is temporary and expected for OAuth redirect handling.",
		);
		expect(logSpy).toHaveBeenCalledWith(
			"Keep this terminal open while you finish login in the browser (timeout: 5 minutes).",
		);
		expect(logSpy).toHaveBeenCalledWith("Press Ctrl+C to cancel.\n");
		expect(httpState.server?.listenArgs?.slice(0, 2)).toEqual([0, "127.0.0.1"]);

		// register POST shape.
		const registerCall = fetchMock.mock.calls.find((c) =>
			String(c[0]).endsWith("/register"),
		);
		expect(registerCall).toBeDefined();
		const regBody = jsonBody(recordedFetch(registerCall)[1].body);
		expect(regBody).toMatchObject({
			client_name: "Interlinked CLI",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
		});
		expect(registerCall![1]).toMatchObject({
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(regBody).toHaveProperty("redirect_uris", [expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/)]);

		// token exchange POST shape — PKCE verifier + dynamic client_id.
		const tokenCall = fetchMock.mock.calls.find((c) =>
			String(c[0]).endsWith("/token"),
		);
		const tokBody = encodedBody(recordedFetch(tokenCall)[1].body);
		expect(tokBody).toContain("grant_type=authorization_code");
		expect(tokBody).toContain("code=THECODE");
		expect(tokBody).toContain("client_id=dyn-client");
		expect(tokBody).toContain(
			`code_verifier=${encodeURIComponent(Buffer.alloc(32, 7).toString("base64url"))}`,
		);
		expect(tokenCall![1]).toMatchObject({
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});

		logSpy.mockRestore();
	});

	it("does not throw when the browser fails to open (openBrowser rejection swallowed)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		spawnMock.mockImplementationOnce(() => {
			throw new Error("spawn failed");
		});

		const promise = performLogin("https://oauth.example");
		const expectedState = Buffer.alloc(16, 7).toString("hex");
		await hitCallback(`/callback?code=C&state=${expectedState}`);
		await expect(promise).resolves.toMatchObject({ access_token: "AT" });
	});

	it("throws on state mismatch (CSRF guard)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		await hitCallback(`/callback?code=C&state=WRONG`);
		await expect(promise).rejects.toThrow("State mismatch");
	});

	it("throws when the token exchange returns a non-ok response", async () => {
		stubRegisterAndToken({ tokenResponse: errorResponse(500, "boom") });
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		const expectedState = Buffer.alloc(16, 7).toString("hex");
		await hitCallback(`/callback?code=C&state=${expectedState}`);
		await expect(promise).rejects.toThrow(/Token exchange failed \(500\): boom/);
	});

	it("throws when dynamic client registration fails (before any callback)", async () => {
		stubRegisterAndToken({ registerResponse: errorResponse(403, "denied") });
		vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(performLogin("https://oauth.example")).rejects.toThrow(
			/Client registration failed \(403\): denied/,
		);
	});

	it.each([null, [], {}, { client_id: 42 }, { client_id: "" }])("rejects malformed client registration before authorization: %j", async (reply) => {
		stubRegisterAndToken({ registerResponse: jsonResponse(reply) });
		await expect(performLogin("https://oauth.example")).rejects.toThrow("Client registration returned an invalid client_id");
	});

	it("rejects the callback with an OAuth error param (error page + reject)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		const res = await hitCallback(
			"/callback?error=access_denied&error_description=nope",
		);
		await expect(promise).rejects.toThrow(/OAuth error: access_denied — nope/);
		expect(res.statusCode).toBe(200);
		expect(res.headers).toEqual({ "Content-Type": "text/html" });
		expect(res.body).toContain("Authentication failed");
	});

	it("rejects an OAuth error with no error_description (defaults to empty)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		// error present, error_description absent → `|| ""` empty branch.
		await hitCallback("/callback?error=server_error");
		await expect(promise).rejects.toThrow(/OAuth error: server_error — $/);
	});

	it("handles a request whose url is undefined (defaults to '/', returns 404)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		// Drive the handler directly with the url property absent → at runtime
		// req.url is undefined, exercising the `req.url || "/"` fallback (without
		// tripping exactOptionalPropertyTypes by writing an explicit undefined).
		while (!httpState.requestHandler) {
			await new Promise((r) => setTimeout(r, 0));
		}
		await new Promise((r) => setTimeout(r, 0));
		const res = makeRes();
		httpState.requestHandler({}, res);
		expect(res.statusCode).toBe(404);
		// Complete the flow so the promise settles (no dangling handle).
		const expectedState = Buffer.alloc(16, 7).toString("hex");
		await hitCallback(`/callback?code=DONE&state=${expectedState}`);
		await expect(promise).resolves.toMatchObject({ access_token: "AT" });
	});

	it("rejects the callback when no authorization code is present (400 page)", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		const res = await hitCallback("/callback?state=anything");
		await expect(promise).rejects.toThrow("No authorization code received");
		expect(res.statusCode).toBe(400);
		expect(res.headers).toEqual({ "Content-Type": "text/html" });
		expect(res.body).toContain("Missing authorization code");
	});

	it("returns 404 for a non-callback path and does not resolve the flow", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		// Hit an unrelated path → 404, flow still pending.
		const res404 = await hitCallback("/favicon.ico");
		expect(res404.statusCode).toBe(404);
		expect(res404.headers).toBeUndefined();
		expect(res404.body).toBe("Not found");
		// Now complete normally so the promise settles (no dangling handle).
		const expectedState = Buffer.alloc(16, 7).toString("hex");
		await hitCallback(`/callback?code=OK&state=${expectedState}`);
		await expect(promise).resolves.toMatchObject({ access_token: "AT" });
	});

	it("defaults returnedState to empty string when state param is absent, causing mismatch", async () => {
		stubRegisterAndToken();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		// code present, state absent → returnedState "" !== real state → throw.
		await hitCallback("/callback?code=ONLYCODE");
		await expect(promise).rejects.toThrow("State mismatch");
	});
});

// ===========================================================================
// startCallbackServer — listen-error and address edge cases
// ===========================================================================

describe("startCallbackServer edges (via performLogin)", () => {
	it("rejects when server.address() is null", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Null the address synchronously before listen's success callback runs.
		httpState.beforeListen = (s) => s.setAddress(null);
		// fetch is never reached on this path, but stub so a stray call is inert.
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
		await expect(performLogin("https://oauth.example")).rejects.toThrow(
			"Failed to start callback server",
		);
	});

	it("rejects when server.address() returns a string", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		httpState.beforeListen = (s) => s.setAddress("/unix/socket");
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
		await expect(performLogin("https://oauth.example")).rejects.toThrow(
			"Failed to start callback server",
		);
	});

	it("rejects when the server emits an 'error' event", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Emit 'error' synchronously inside listen; the success callback is then
		// skipped (errored flag) so the only settle is the reject.
		httpState.beforeListen = (s) => s.emit("error", new Error("EADDRINUSE"));
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
		await expect(performLogin("https://oauth.example")).rejects.toThrow(
			"EADDRINUSE",
		);
	});

	it("rejects via the 5-minute login timeout", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ client_id: "c" })));
		const login = performLogin("https://oauth.example");
		let settled = false;
		void login.catch(() => {
			settled = true;
		});
		// Attach the rejection handler up front so the 5-minute timer's reject is
		// never momentarily unhandled (it fires inside advanceTimersByTimeAsync).
		const assertion = expect(login).rejects.toThrow("Login timed out after 5 minutes");
		// Let the register fetch + wiring settle under fake timers.
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settled).toBe(false);
		// Trip the 5-minute timer.
		await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1);
		await assertion;
		expect(httpState.server?.closed).toBe(true);
	});
});

// ===========================================================================
// openBrowser — platform branches (via performLogin spawn args)
// ===========================================================================

describe("openBrowser platform branches", () => {
	const realPlatform = process.platform;
	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform });
	});

	async function runLoginAndComplete(): Promise<void> {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.endsWith("/register")) return jsonResponse({ client_id: "c" });
			return jsonResponse({ access_token: "AT" });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const promise = performLogin("https://oauth.example");
		while (!httpState.requestHandler) {
			await new Promise((r) => setTimeout(r, 0));
		}
		await new Promise((r) => setTimeout(r, 0));
		const state = Buffer.alloc(16, 7).toString("hex");
		httpState.requestHandler!(
			{ url: `/callback?code=C&state=${state}` },
			makeRes(),
		);
		await promise;
	}

	it("uses `open` on darwin", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		await runLoginAndComplete();
		expect(spawnMock).toHaveBeenCalledWith(
			"open",
			[expect.any(String)],
			expect.objectContaining({ detached: true }),
		);
	});

	it("uses `cmd /c start` on win32", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		await runLoginAndComplete();
		expect(spawnMock).toHaveBeenCalledWith(
			"cmd",
			["/c", "start", "", expect.any(String)],
			expect.objectContaining({ windowsVerbatimArguments: true }),
		);
	});

	it("uses `xdg-open` on linux/other", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		await runLoginAndComplete();
		expect(spawnMock).toHaveBeenCalledWith(
			"xdg-open",
			[expect.any(String)],
			expect.objectContaining({ detached: true }),
		);
	});
});
