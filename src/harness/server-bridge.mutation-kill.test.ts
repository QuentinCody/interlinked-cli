import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { parseWire, wireArray, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// Mutation-kill companion for server-bridge.ts (PASS-1 fleet, ~62 survivors).
// Self-contained: duplicates the small mock/stub harness from
// server-bridge.test.ts rather than importing it, per the placement rule (a
// sibling *.mutation-kill.test.ts beside the target, static SUT import).
//
// Each `it()` targets ONE or more specific surviving mutantIds (named in a
// comment) via an OBSERVABLE-behavior assertion — never `toContain`, always
// exact values. Several tests reach a module-private function (
// isExplicitReservationRejection, listReservations' Array.isArray guard)
// through the ONLY caller that can drive it into the state that matters;
// where the real call chain provably cannot produce that state (a private
// method's return value never actually being null/undefined), a
// `vi.spyOn(instance, "callTool")` on the private method is used instead —
// this is a test-file-only technique, no source edits.

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

// --- node:fs mock (only createServerBridge reads files) ---
const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<(p: string) => boolean>(),
	readFileSync: vi.fn<(p: string, enc: string) => string>(),
}));
vi.mock("node:fs", () => fsMock);

// --- secrets scrubber mock (egress boundary; not the focus of this file) ---
const scrubMock = vi.hoisted(() => ({
	scrubEgressPayload: vi.fn((_p: Record<string, unknown>): { found: number; types: string[] } => ({
		found: 0,
		types: [],
	})),
}));
vi.mock("../lib/secrets.js", () => scrubMock);

import { nonNull } from "../lib/non-null.js";
import { createServerBridge, ServerBridge } from "./server-bridge.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// Shared fetch/fs stubbing helpers (mirrors server-bridge.test.ts)
// ===========================================

type FetchImpl = (url: string, init?: RequestInit) => Response | Promise<Response>;
let fetchSpy: MockInstance;

function stubFetch(impl: FetchImpl): void {
	fetchSpy = vi.fn(((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return Promise.resolve(impl(url, init));
	}));
	vi.stubGlobal("fetch", fetchSpy);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function withHealthOk(rest: FetchImpl): FetchImpl {
	return (url, init) => {
		if (url.endsWith("/health")) return new Response("ok", { status: 200 });
		return rest(url, init);
	};
}

function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

const baseConfig = {
	serverUrl: "http://localhost:9999",
	workspaceKey: "ws",
	projectKey: "proj",
} as const;

async function connectedBridge(
	extra: Partial<ConstructorParameters<typeof ServerBridge>[0]> = {},
): Promise<ServerBridge> {
	const b = new ServerBridge({ ...baseConfig, ...extra });
	await b.healthCheck();
	return b;
}

const session: SessionTrajectory = ({ ...completeSessionFixture(), ...{
	tool_call_count: 7,
	started_at: "2026-01-01T00:00:00Z",
} });

function makeEvent(
	over: Partial<Parameters<ServerBridge["reportGuardEvent"]>[0]> = {},
): Parameters<ServerBridge["reportGuardEvent"]>[0] {
	return {
		agent_name: "alice",
		event_type: "guard_block",
		decision: "block",
		reason: "blocked rm -rf",
		occurred_at: "2026-01-01T00:00:00Z",
		tool_name: "Bash",
		tool_input_summary: "rm -rf /",
		...over,
	};
}

beforeEach(() => {
	fsMock.existsSync.mockReset();
	fsMock.readFileSync.mockReset();
	scrubMock.scrubEgressPayload.mockClear();
	stubFetch(withHealthOk(() => json({ result: {} })));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

// ===========================================
// createServerBridge observation helpers
// ===========================================

/** Bridge whose config.json always supplies a valid server_url, with the
 *  caller-supplied fields merged into config.local.json. Isolates every
 *  parseLocalBridgeFields/parseLocalServerEntry assertion to the LOCAL side. */
function localFieldsBridge(localJson: Record<string, unknown>): ServerBridge {
	fsMock.existsSync.mockReturnValue(true);
	fsMock.readFileSync.mockImplementation((p: string) =>
		p.endsWith("config.local.json")
			? JSON.stringify(localJson)
			: JSON.stringify({ server_url: "https://shared.example" }),
	);
	return nonNull(createServerBridge("/repo"));
}

/** Bridge built from a config.json carrying the caller-supplied fields
 *  (plus a valid server_url); no config.local.json present. Isolates every
 *  parseSharedBridgeFields assertion to the SHARED side. */
function sharedFieldsBridge(sharedJson: Record<string, unknown>): ServerBridge {
	fsMock.existsSync.mockImplementation(
		(p: string) => p.endsWith("config.json") && !p.endsWith("config.local.json"),
	);
	fsMock.readFileSync.mockReturnValue(
		JSON.stringify({ server_url: "https://shared.example", ...sharedJson }),
	);
	return nonNull(createServerBridge("/repo"));
}

/** Drives one releaseFile() call and captures the /api/ui/call envelope —
 *  the body (workspace_id presence) and headers (Authorization presence). */
async function captureCallToolEnvelope(
	b: ServerBridge,
): Promise<{ body: Record<string, unknown> | undefined; headers: Record<string, string> | undefined }> {
	let body: Record<string, unknown> | undefined;
	let headers: Record<string, string> | undefined;
	stubFetch(
		withHealthOk((url, init) => {
			if (url.endsWith("/api/ui/call") && init?.body) {
				body = JSON.parse(String(init.body));
				headers = parseWire(init.headers, wireRecord(wireString), "test JSON value");
			}
			return json({ result: {} });
		}),
	);
	await b.healthCheck();
	await b.releaseFile("a.ts", "alice");
	return { body, headers };
}

/** Drives one fetchCoordinationState() call and captures the raw
 *  /api/auto-coordinate body — the ONE call site that sends
 *  config.workspaceKey/projectKey directly, with no `|| "main"` fallback to
 *  mask a bad value. */
async function captureAutoCoordinateBody(
	b: ServerBridge,
	timeoutMs?: number,
): Promise<Record<string, unknown> | undefined> {
	let body: Record<string, unknown> | undefined;
	stubFetch(
		withHealthOk((url, init) => {
			if (url.endsWith("/api/auto-coordinate") && init?.body) {
				body = JSON.parse(String(init.body));
			}
			return json({ result: {} });
		}),
	);
	await b.healthCheck();
	await b.fetchCoordinationState("alice", session, timeoutMs);
	return body;
}

// ===========================================
// (module) — class field initializer
// ===========================================

describe("ServerBridge — class field initializers ((module) scope)", () => {
	// Kills mutantId d2d1441c668955b2 (`private connected = false` -> `= true`).
	// test-contract: invariant — connected starts false until healthCheck() confirms it, never true by default
	it("connected starts false, before any health check can have resolved", () => {
		const b = new ServerBridge(baseConfig);
		expect(b.isConnected()).toBe(false);
		b.shutdown();
	});
});

// ===========================================
// createServerBridge — existsSync gates
// ===========================================

describe("createServerBridge — existsSync gates each file read independently", () => {
	// test-contract: invariant — a file must not be read when its own
	// existsSync check says it is absent. Kills mutantId 9e69fbe86bef6064
	// (`existsSync(sharedPath)` -> `true`).
	it("N: config.json is never read when existsSync(sharedPath) is false", () => {
		fsMock.existsSync.mockReturnValue(false);
		fsMock.readFileSync.mockImplementation((p: string) =>
			p.endsWith("config.json") && !p.endsWith("config.local.json")
				? JSON.stringify({ server_url: "https://leaked-shared.example" })
				: JSON.stringify({}),
		);
		expect(createServerBridge("/repo")).toBeNull();
	});

	// test-contract: invariant — same guarantee for the local file. Kills
	// mutantId 592ab5fa47308ace (`existsSync(localPath)` -> `true`).
	it("N: config.local.json is never read when existsSync(localPath) is false", () => {
		fsMock.existsSync.mockReturnValue(false);
		fsMock.readFileSync.mockImplementation((p: string) =>
			p.endsWith("config.local.json")
				? JSON.stringify({ servers: { production: { server_url: "https://leaked-local.example" } } })
				: JSON.stringify({}),
		);
		expect(createServerBridge("/repo")).toBeNull();
	});
});

// ===========================================
// createServerBridge — utf-8 encoding
// ===========================================

describe("createServerBridge — reads both config files as utf-8", () => {
	// test-contract: boundary — readFileSync must receive the literal "utf-8"
	// encoding so JSON.parse gets a string, not a Buffer/garbage. Kills
	// mutantIds 44273276b295027c (shared, ordinal 0) and 7c5147333ed15637
	// (local, ordinal 1).
	it("both readFileSync calls carry the exact 'utf-8' encoding argument", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockImplementation((p: string) =>
			p.endsWith("config.local.json")
				? JSON.stringify({})
				: JSON.stringify({ server_url: "https://shared.example" }),
		);
		createServerBridge("/repo")?.shutdown();
		expect(fsMock.readFileSync.mock.calls).toEqual([
			[expect.stringContaining("config.json"), "utf-8"],
			[expect.stringContaining("config.local.json"), "utf-8"],
		]);
	});
});

// ===========================================
// createServerBridge — workspace_key/project_key "main" fallback
// ===========================================

describe("createServerBridge — unset workspace_key/project_key resolve to the string 'main'", () => {
	// fetchCoordinationState is the one call site that sends
	// config.workspaceKey/projectKey raw (no second `|| "main"` to mask a
	// bad construction-time value). Kills mutantIds c6b3b2a99c66b8cd (->true),
	// 13cb22cc62cafd7f (->false), dc496db37f14f5f3 (||->&&),
	// 5d837be2dec67c39 ("main"->"" ord0), 138e22650464f2dc (->true),
	// 5a85fa82d8efd5e6 (->false), 0baec2dfaff7bdd3 (||->&&),
	// 11bc6167aa532de8 ("main"->"" ord1).
	// test-contract: invariant — unset workspaceKey/projectKey must resolve to the string "main", never a stray boolean
	it("resolve to 'main' on the raw fetchCoordinationState body, not a boolean", async () => {
		fsMock.existsSync.mockImplementation(
			(p: string) => p.endsWith("config.json") && !p.endsWith("config.local.json"),
		);
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ server_url: "https://shared.example" }));
		const b = nonNull(createServerBridge("/repo"));
		const body = await captureAutoCoordinateBody(b);
		expect(body).toMatchObject({ workspace_key: "main", project_key: "main" });
		b.shutdown();
	});
});

// ===========================================
// fetchWithTimeout — finally block
// ===========================================

describe("fetchWithTimeout — clears its abort timer on settle", () => {
	// test-contract: invariant — a resolved fetch must clear its own abort
	// timer; an emptied `finally` block leaves the timer pending and it fires
	// later, aborting a signal whose request already completed. Kills
	// mutantId e454eae624f0db8c (`{ clearTimeout(timer); }` -> `{}`).
	it("the captured signal never aborts after the fetch has already resolved", async () => {
		vi.useFakeTimers();
		try {
			let capturedSignal: AbortSignal | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn((input: string | URL | Request, init?: RequestInit) => {
					const url = typeof input === "string" ? input : input.toString();
					if (url.endsWith("/health")) capturedSignal = nonNull(init?.signal);
					return Promise.resolve(new Response("ok", { status: 200 }));
				}),
			);
			const b = new ServerBridge(baseConfig);
			await vi.advanceTimersByTimeAsync(0); // let the constructor's healthCheck() settle
			expect(capturedSignal?.aborted).toBe(false);
			// 3000ms is healthCheck's own budget; the finally block should have
			// cleared it already. Advance well past it.
			await vi.advanceTimersByTimeAsync(5000);
			expect(capturedSignal?.aborted).toBe(false);
			b.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================
// isExplicitDenialError — regex anchors
// ===========================================

describe("isExplicitDenialError (via reserveFile) — regex anchors", () => {
	// test-contract: invariant — only a message that is EXACTLY
	// "Server API error: <digits>" is an explicit denial; a prefixed message
	// must not match. Kills mutantId 6648672f758b35e0 (drops the `^` anchor).
	it("N: a message with text BEFORE 'Server API error:' is not a denial (^ anchor)", async () => {
		stubFetch(
			withHealthOk(() => {
				throw new Error("prefix Server API error: 409");
			}),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});

	// test-contract: invariant — a message with trailing text after the
	// digits must not match either. Kills mutantId b56b12adb479c881 (drops
	// the `$` anchor).
	it("N: a message with text AFTER the digit group is not a denial ($ anchor)", async () => {
		stubFetch(
			withHealthOk(() => {
				throw new Error("Server API error: 409 (Conflict)");
			}),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});
});

// ===========================================
// parseLocalBridgeFields — access_token
// ===========================================

describe("parseLocalBridgeFields — access_token type-check is not bypassed in either direction", () => {
	// test-contract: invariant — a non-string access_token must be treated as
	// absent, never smuggled through raw. Kills mutantId 7b82e8f647f7d781
	// (cond -> true, always uses the raw value).
	it("N: a non-string access_token does not become the Authorization header", async () => {
		const b = localFieldsBridge({ access_token: 12345 });
		const { headers } = await captureCallToolEnvelope(b);
		expect(headers && "Authorization" in headers).toBe(false);
		b.shutdown();
	});

	// Kills mutantIds e0cf789af6aa3b65 (cond -> false, always undefined),
	// d43b8d5ee354a1c4 (===  -> !==, inverted), and fbb4fcfa6c0317f9
	// ("string" -> "" ord0 — typeof never returns "", permanently false).
	// test-contract: invariant — a genuine string access_token must actually reach the Authorization header
	it("P: a genuine string access_token becomes the Authorization header", async () => {
		const b = localFieldsBridge({ access_token: "real-token" });
		const { headers } = await captureCallToolEnvelope(b);
		expect(headers?.Authorization).toBe("Bearer real-token");
		b.shutdown();
	});
});

// ===========================================
// parseLocalBridgeFields — top-level workspace_id
// ===========================================

describe("parseLocalBridgeFields — top-level workspace_id type-check", () => {
	// test-contract: invariant — a non-string workspace_id must be treated as
	// absent (omitted from the callTool envelope entirely), never coerced.
	// Kills mutantId 8f3eac6662cc51ae (cond -> true, always raw value).
	it("N: a non-string top-level workspace_id is not sent as workspace_id", async () => {
		const b = localFieldsBridge({ workspace_id: 99 });
		const { body } = await captureCallToolEnvelope(b);
		expect(body && "workspace_id" in body).toBe(false);
		b.shutdown();
	});
});

// ===========================================
// parseLocalBridgeFields — isJsonObject(servers) guard
// ===========================================

describe("parseLocalBridgeFields — isJsonObject(servers) guard", () => {
	// Kills mutantId 11bae4d201d80134 (cond -> true): `servers[activeKey]` on
	// undefined throws, the throw is swallowed by createServerBridge's outer
	// catch, and the whole `local` object (including the good top-level
	// fields) is discarded.
	// test-contract: invariant — an absent `servers` key must not discard the already-parsed top-level fields
	it("N: no `servers` key still applies the already-parsed top-level fields", async () => {
		const b = localFieldsBridge({ access_token: "should-survive", workspace_id: "ws-real" });
		const { body, headers } = await captureCallToolEnvelope(b);
		expect(headers?.Authorization).toBe("Bearer should-survive");
		expect(body?.workspace_id).toBe("ws-real");
		b.shutdown();
	});
});

// ===========================================
// Active-server workspace_id override chain
// (spans parseLocalBridgeFields + parseLocalServerEntry)
// ===========================================

describe("active-server entry's own workspace_id overrides the top-level one", () => {
	// Kills mutantId a016571a349a9387 (`activeServer.workspaceId` -> `false`,
	// in parseLocalBridgeFields) AND mutantIds 5698f464ea07a67c (cond ->
	// false) + 6e24060669ce5ec8 ("string" -> "" ord1) in
	// parseLocalServerEntry — all three break the same causal chain.
	// test-contract: invariant — when both server_url and workspace_id are present, the active-server's workspace_id must win
	it("P: active-server workspace_id wins when both server_url and workspace_id are present", async () => {
		const b = localFieldsBridge({
			workspace_id: "ws-top",
			active_server: "staging",
			servers: { staging: { server_url: "https://staging.example", workspace_id: "ws-staging" } },
		});
		const { body } = await captureCallToolEnvelope(b);
		expect(body?.workspace_id).toBe("ws-staging");
		b.shutdown();
	});
});

// ===========================================
// parseLocalServerEntry — explicit-null entry / non-string server_url
// ===========================================

describe("parseLocalServerEntry — null entry and non-string server_url", () => {
	// Kills mutantId d9f230afd453687d (`!isJsonObject(value)` -> `false`,
	// inside parseLocalServerEntry): with the guard neutered,
	// `(null).server_url` throws, which propagates out of
	// parseLocalBridgeFields entirely and is swallowed by createServerBridge's
	// outer catch — losing the already-good access_token along with it.
	// test-contract: invariant — an explicit-null active-server entry must not discard the top-level access_token
	it("N: an explicit-null active-server entry doesn't discard the top-level access_token", async () => {
		const b = localFieldsBridge({
			access_token: "should-survive",
			active_server: "staging",
			servers: { staging: null },
		});
		const { headers } = await captureCallToolEnvelope(b);
		expect(headers?.Authorization).toBe("Bearer should-survive");
		b.shutdown();
	});

	// test-contract: invariant — a non-string server_url in the active-server
	// entry must be treated as absent; with no other server_url source,
	// createServerBridge must stay null rather than adopt a coerced value.
	// Kills mutantId 95c88f19bf7794aa (cond -> true, always raw value).
	it("N: a non-string active-server server_url leaves createServerBridge null", () => {
		fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.local.json"));
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({ active_server: "staging", servers: { staging: { server_url: 123 } } }),
		);
		expect(createServerBridge("/repo")).toBeNull();
	});
});

// ===========================================
// parseSharedBridgeFields — default_workspace_key / default_project
// ===========================================

describe("parseSharedBridgeFields — default_workspace_key/default_project type-checks", () => {
	// test-contract: invariant — non-string values must be treated as absent
	// (falling back to "main" downstream), never coerced through raw. Kills
	// mutantIds 74ca7ec2f8d939bc (workspaceKey cond -> true) and
	// c5c4af80d56f6da5 (projectKey cond -> true).
	it("N: non-string default_workspace_key/default_project are treated as absent", async () => {
		const b = sharedFieldsBridge({ default_workspace_key: 42, default_project: true });
		const body = await captureAutoCoordinateBody(b);
		expect(body).toMatchObject({ workspace_key: "main", project_key: "main" });
		b.shutdown();
	});

	// Observed raw, with no `|| "main"` at this call site to mask a broken
	// guard. Kills mutantIds aaa8405691d962e3 (workspaceKey cond -> false),
	// 0ddba6a5849a167d (=== -> !==, inverted), f7747d900c581add ("string" ->
	// "" ord1), 51d58fb693f60fb2 (projectKey cond -> false),
	// 67f967be0df8e51f (=== -> !==, inverted), 469ae86f54bb02cb (ord2).
	// test-contract: invariant — genuine string default_workspace_key/default_project must actually be used, not discarded
	it("P: genuine string default_workspace_key/default_project flow through raw", async () => {
		const b = sharedFieldsBridge({ default_workspace_key: "wk-real", default_project: "pk-real" });
		const body = await captureAutoCoordinateBody(b);
		expect(body).toMatchObject({ workspace_key: "wk-real", project_key: "pk-real" });
		b.shutdown();
	});
});

// ===========================================
// ServerBridge.callTool
// ===========================================

describe("ServerBridge.callTool", () => {
	// test-contract: boundary — the /api/ui/call request must be a POST
	// carrying a JSON content type. Kills mutantIds 19666db072b4d381
	// ("POST" -> "") and aaa2dab3859dc028 ("application/json" -> "").
	it("sends a POST with Content-Type: application/json", async () => {
		let method: string | undefined;
		let contentType: string | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call")) {
					method = init?.method;
					contentType = (parseWire(init?.headers, wireOptional(wireRecord(wireString)), "test JSON value"))?.["Content-Type"];
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		await b.releaseFile("a.ts", "alice");
		expect(method).toBe("POST");
		expect(contentType).toBe("application/json");
		b.shutdown();
	});

	// Kills mutantId 3a2c9c04a2a6804b (`data.error` -> `false`): with the
	// guard neutered, callTool never throws and returns the raw poisoned
	// object, which listReservations then reads as if legitimate.
	// test-contract: security — a sibling `error` field must short-circuit callTool, even next to a reservations-shaped field
	it("N: a poisoned error+reservations payload is not read as a valid reservations list", async () => {
		stubFetch(
			withHealthOk(() =>
				json({
					error: { message: "rpc exploded" },
					reservations: [{ agent_name: "z", path_pattern: "z.ts" }],
				}),
			),
		);
		const b = await connectedBridge();
		await expect(b.listReservations()).resolves.toEqual([]);
		b.shutdown();
	});

	// Observed via reserveFile's 409-denial reclassification, which only
	// fires when the message text survives intact. Kills mutantIds
	// f31f0d73da9cd2ba (expr -> true), 50b50d18a774fe47 (expr -> false), and
	// 156048890f0e740d (|| -> &&, stringifying the whole error object).
	// test-contract: invariant — the thrown message must be the actual data.error.message, not a coerced boolean
	it("the thrown message is exactly data.error.message, not a stray boolean or [object Object]", async () => {
		stubFetch(withHealthOk(() => json({ error: { message: "Server API error: 409" } })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).rejects.toThrow("Server API error: 409");
		b.shutdown();
	});
});

// ===========================================
// ServerBridge.fetchCoordinationState
// ===========================================

describe("ServerBridge.fetchCoordinationState", () => {
	// test-contract: boundary — the /api/auto-coordinate request must be a
	// POST carrying a JSON content type. Kills mutantIds ab66cf56f1e685a9
	// ("POST" -> "") and 0004af4571a61e81 ("application/json" -> "").
	it("sends a POST with Content-Type: application/json", async () => {
		let method: string | undefined;
		let contentType: string | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/auto-coordinate")) {
					method = init?.method;
					contentType = (parseWire(init?.headers, wireOptional(wireRecord(wireString)), "test JSON value"))?.["Content-Type"];
				}
				return json({ heartbeat_recorded: false, unread: { total: 0, urgent: [] }, task_changes: [] });
			}),
		);
		const b = await connectedBridge();
		await b.fetchCoordinationState("alice", session);
		expect(method).toBe("POST");
		expect(contentType).toBe("application/json");
		b.shutdown();
	});

	// Kills mutantId 84a1ed275e1e148d (`!response.ok` -> `false`): with the
	// guard neutered, a valid-but-503 body gets parsed and returned as if it
	// were a real success payload.
	// test-contract: invariant — a non-ok response must yield null without ever parsing the body
	it("N: a non-ok response returns null even with a valid JSON body", async () => {
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/api/auto-coordinate")) {
					return json({ heartbeat_recorded: true, unread: { total: 0, urgent: [] }, task_changes: [] }, 503);
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		await expect(b.fetchCoordinationState("alice", session)).resolves.toBeNull();
		b.shutdown();
	});

	// `?? 2000` and `&& 2000` agree when timeoutMs is nullish but diverge for
	// any truthy value ("x && 2000" discards x and returns 2000). Observed
	// via the abort timing under fake timers. Kills mutantId 13cc3979016c7645.
	// test-contract: invariant — an explicit timeoutMs must be honored exactly, never coerced to the 2000ms default
	it("an explicit timeoutMs (1234) fires the abort at 1234ms, not the 2000ms default", async () => {
		vi.useFakeTimers();
		try {
			let aborted = false;
			vi.stubGlobal(
				"fetch",
				vi.fn((input: string | URL | Request, init?: RequestInit) => {
					const url = typeof input === "string" ? input : input.toString();
					if (url.endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }));
					if (url.endsWith("/api/auto-coordinate")) {
						return new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => {
								aborted = true;
								reject(new DOMException("aborted", "AbortError"));
							});
						});
					}
					return Promise.resolve(json({ result: {} }));
				}),
			);
			const b = new ServerBridge(baseConfig);
			await b.healthCheck();
			const promise = b.fetchCoordinationState("alice", session, 1234);
			await vi.advanceTimersByTimeAsync(1200); // < 1234
			expect(aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(100); // now at 1300, > 1234 but < 2000
			expect(aborted).toBe(true);
			await expect(promise).resolves.toBeNull();
			b.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================
// ServerBridge.flushGuardEvents
// ===========================================

describe("ServerBridge.flushGuardEvents", () => {
	// test-contract: boundary — the /batch request must be a POST. Kills
	// mutantId 5fc4e112fcfa1bf3 ("POST" -> "").
	it("sends a POST to /api/hooks/activity/batch", async () => {
		let method: string | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch")) method = init?.method;
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(method).toBe("POST");
		b.shutdown();
	});

	// test-contract: boundary — the re-queue-on-failure limit is INCLUSIVE of
	// 50 (`<= 50`), not exclusive. Kills mutantId 34d9b78a30168449
	// (`<= 50` -> `< 50`): at exactly 50 failed events, `<` drops them
	// instead of re-queueing.
	it("re-queues on flush failure at the boundary — exactly 50 survives", async () => {
		const batchSizes: number[] = [];
		let healthOk = false;
		let failNext = true;
		stubFetch((url, init) => {
			if (url.endsWith("/health")) return new Response("", { status: healthOk ? 200 : 500 });
			if (url.endsWith("/batch")) {
				batchSizes.push((parseWire(JSON.parse(String(init?.body)).events, wireArray(wireUnknown), "test JSON value")).length);
				if (failNext) {
					failNext = false;
					throw new TypeError("flush failed");
				}
				return json({ result: {} });
			}
			return json({ result: {} });
		});
		const b = new ServerBridge(baseConfig);
		await b.healthCheck(); // connected = false; events accumulate, no flush attempts
		for (let i = 0; i < 50; i++) b.reportGuardEvent(makeEvent());
		healthOk = true;
		await b.healthCheck(); // connected = true
		b.shutdown(); // final flush of all 50 -> throws -> 50<=50 -> re-queued
		await flush();
		expect(batchSizes).toEqual([50]);
		// Prove the 50 survived (weren't dropped): one more event tips the
		// queue past the immediate-flush threshold, and the NEXT flush
		// attempt (which now succeeds) must carry the original 50 plus this one.
		b.reportGuardEvent(makeEvent());
		await flush();
		expect(batchSizes).toEqual([50, 51]);
	});
});

// ===========================================
// ServerBridge.healthCheck
// ===========================================

describe("ServerBridge.healthCheck", () => {
	// test-contract: invariant — healthCheck's own request must abort at its
	// declared 3000ms budget, not fetchWithTimeout's 5000ms default. Kills
	// mutantId ca19784cbfe783f5 (`{ timeout: 3000 }` -> `{}`).
	it("aborts its own request at 3000ms, not the 5000ms fetchWithTimeout default", async () => {
		vi.useFakeTimers();
		try {
			let aborted = false;
			vi.stubGlobal(
				"fetch",
				vi.fn((_input: string | URL | Request, init?: RequestInit) => {
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							aborted = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					});
				}),
			);
			const b = new ServerBridge(baseConfig); // constructor fires healthCheck() itself
			await vi.advanceTimersByTimeAsync(2900);
			expect(aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(200); // now at 3100, > 3000 but < 5000
			expect(aborted).toBe(true);
			b.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================
// ServerBridge.listReservations
// ===========================================

describe("ServerBridge.listReservations", () => {
	// test-contract: boundary — the request must name the exact tool and pass
	// `brief: true`. Kills mutantIds ff1f6648392d90e8
	// ("list_file_reservations" -> "") and 9ec3d6647ef09661 (true -> false).
	it("calls list_file_reservations with brief: true", async () => {
		let body: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call") && init?.body) body = JSON.parse(String(init.body));
				return json({ result: { reservations: [] } });
			}),
		);
		const b = await connectedBridge();
		await b.listReservations();
		expect(body?.tool).toBe("list_file_reservations");
		expect(body?.args).toHaveProperty(["brief"], true);
		b.shutdown();
	});
});

// ===========================================
// ServerBridge.reserveFile
// ===========================================

describe("ServerBridge.reserveFile", () => {
	// test-contract: boundary — the request must name the exact tool and pass
	// paths:[filePath] (not an empty array). Kills mutantIds
	// 8b81dc84320868b0 ("file_reservation_paths" -> "") and aa2b28e79950997a
	// ([filePath] -> []).
	it("calls file_reservation_paths with paths:[filePath]", async () => {
		let body: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call") && init?.body) body = JSON.parse(String(init.body));
				return json({ result: { granted: ["x.ts"], conflicts: [] } });
			}),
		);
		const b = await connectedBridge();
		await b.reserveFile("some-specific-path.ts", "alice", 60);
		expect(body?.tool).toBe("file_reservation_paths");
		expect(body?.args).toHaveProperty(["paths"], ["some-specific-path.ts"]);
		b.shutdown();
	});
});
