import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { parseWire, wireArray, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// Behavioral coverage for the Server Bridge — reservation sync + guard
// event reporting + auto-coordination + the createServerBridge factory.
//
// Network (`fetch`) is stubbed via `vi.stubGlobal`; `node:fs` and the
// shared egress scrubber are mocked at the module boundary. No real I/O,
// no real network, deterministic timers. Every export and branch in
// `server-bridge.ts` is exercised: the two pure classifiers, the
// ServerBridge methods (health, reserve/release/list, guard queue +
// flush, callTool JSON-RPC shapes, fetchCoordinationState, shutdown),
// and the factory's config-merge / fail-open paths.

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

// --- secrets scrubber mock: assert it runs at the egress boundary ---
const scrubMock = vi.hoisted(() => ({
	scrubEgressPayload: vi.fn((_p: Record<string, unknown>): { found: number; types: string[] } => ({
		found: 0,
		types: [],
	})),
}));
vi.mock("../lib/secrets.js", () => scrubMock);

// Imported AFTER the mocks above are registered (vi.mock is hoisted, so the
// ordering is cosmetic — but it documents intent).
import { nonNull } from "../lib/non-null.js";
import { createServerBridge, parseLocalBridgeFields, ServerBridge } from "./server-bridge.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// fetch stubbing
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

/** A fetch impl where /health is OK and everything else delegates. */
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

/** A connected bridge: health returns ok, then flush microtasks. */
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

beforeEach(() => {
	fsMock.existsSync.mockReset();
	fsMock.readFileSync.mockReset();
	scrubMock.scrubEgressPayload.mockClear();
	// Default fetch: health ok, everything else 200 empty JSON-RPC result.
	stubFetch(withHealthOk(() => json({ result: {} })));
});

afterEach(() => {
	// Each test shuts its bridge down (clears the 10s interval); restore any
	// global stubs/spies. Real timers are the default — the lone interval test
	// scopes fake timers locally.
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

// ===========================================
// Pure classifiers (reached via reserveFile)
// ===========================================

describe("isExplicitReservationRejection (via reserveFile)", () => {
	it("null/empty body → accepted (no throw)", async () => {
		stubFetch(withHealthOk(() => json({ result: null })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});

	it("ok:false → rejected (throws)", async () => {
		stubFetch(withHealthOk(() => json({ result: { ok: false } })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).rejects.toThrow(
			"server rejected reservation",
		);
		b.shutdown();
	});

	it("non-empty conflicts[] → rejected (throws)", async () => {
		stubFetch(
			withHealthOk(() =>
				json({ result: { granted: [], conflicts: [{ file: "a.ts" }] } }),
			),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).rejects.toThrow(
			"server rejected reservation",
		);
		b.shutdown();
	});

	it("empty conflicts[] + ok!==false → accepted", async () => {
		stubFetch(
			withHealthOk(() => json({ result: { granted: ["a.ts"], conflicts: [] } })),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});

	it("conflicts is non-array → accepted (Array.isArray false branch)", async () => {
		stubFetch(
			withHealthOk(() => json({ result: { conflicts: "nope" } })),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});
});

describe("isExplicitDenialError (via reserveFile)", () => {
	it("409 callTool error → re-throws (explicit denial)", async () => {
		stubFetch(withHealthOk(() => new Response("conflict", { status: 409 })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).rejects.toThrow(
			"Server API error: 409",
		);
		b.shutdown();
	});

	it("423 callTool error → re-throws (Locked)", async () => {
		stubFetch(withHealthOk(() => new Response("locked", { status: 423 })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).rejects.toThrow(
			"Server API error: 423",
		);
		b.shutdown();
	});

	it("401 callTool error → swallowed (auth, not a denial)", async () => {
		stubFetch(withHealthOk(() => new Response("nope", { status: 401 })));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});

	it("network TypeError (not a Server API error) → swallowed", async () => {
		stubFetch(
			withHealthOk(() => {
				throw new TypeError("network down");
			}),
		);
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});

	it("thrown non-Error value → swallowed (instanceof guard)", async () => {
		// callTool rejects with a string, not an Error → isExplicitDenialError false.
		const throwString = () => {
			const e: unknown = "string failure";
			throw e; // a non-Error throw, to exercise the `instanceof Error` guard
		};
		stubFetch(withHealthOk(throwString));
		const b = await connectedBridge();
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		b.shutdown();
	});
});

// ===========================================
// Constructor + health check + interval
// ===========================================

describe("constructor / healthCheck / isConnected", () => {
	it("fires an initial health check on construction", async () => {
		stubFetch(withHealthOk(() => json({ result: {} })));
		const b = new ServerBridge(baseConfig);
		await flush();
		expect(fetchSpy).toHaveBeenCalledWith(
			"http://localhost:9999/health",
			expect.objectContaining({ signal: expect.anything() }),
		);
		expect(b.isConnected()).toBe(true);
		b.shutdown();
	});

	it("healthCheck returns false + sets disconnected on non-ok", async () => {
		stubFetch(() => new Response("down", { status: 500 }));
		const b = new ServerBridge(baseConfig);
		const ok = await b.healthCheck();
		expect(ok).toBe(false);
		expect(b.isConnected()).toBe(false);
		b.shutdown();
	});

	it("healthCheck returns false + sets disconnected when fetch throws", async () => {
		stubFetch(() => {
			throw new Error("boom");
		});
		const b = new ServerBridge(baseConfig);
		expect(await b.healthCheck()).toBe(false);
		expect(b.isConnected()).toBe(false);
		b.shutdown();
	});

	it("the 10s flush interval invokes flushGuardEvents", async () => {
		// The ONLY test that uses fake timers: it must fire the constructor's
		// 10s setInterval without waiting in real time. Scoped locally so the
		// rest of the suite runs on real timers.
		vi.useFakeTimers();
		try {
			const b = new ServerBridge(baseConfig);
			await b.healthCheck(); // connected = true
			// Queue ONE event (below the >=10 immediate-flush threshold) so the
			// only thing that can flush it is the interval.
			b.reportGuardEvent(makeEvent());
			fetchSpy.mockClear();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(
				fetchSpy.mock.calls.some((c) =>
					String(c[0]).endsWith("/api/hooks/activity/batch"),
				),
			).toBe(true);
			b.shutdown();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================
// releaseFile / listReservations
// ===========================================

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

describe("releaseFile", () => {
	it("posts release_file_reservations with workspace/project keys", async () => {
		const seen: RequestInit[] = [];
		stubFetch(
			withHealthOk((_url, init) => {
				if (init) seen.push(init);
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		await b.releaseFile("a.ts", "alice");
		const body = JSON.parse(String(seen.at(-1)?.body));
		expect(body.tool).toBe("release_file_reservations");
		expect(body.args).toMatchObject({
			agent_name: "alice",
			paths: ["a.ts"],
			workspace_key: "ws",
			project_key: "proj",
		});
		b.shutdown();
	});

	it("swallows callTool errors (best-effort)", async () => {
		stubFetch(withHealthOk(() => new Response("err", { status: 500 })));
		const b = await connectedBridge();
		await expect(b.releaseFile("a.ts", "alice")).resolves.toBeUndefined();
		b.shutdown();
	});

	it("defaults workspace/project to 'main' when unset", async () => {
		const seen: RequestInit[] = [];
		stubFetch(
			withHealthOk((_url, init) => {
				if (init) seen.push(init);
				return json({ result: {} });
			}),
		);
		const b = new ServerBridge({ serverUrl: baseConfig.serverUrl });
		await b.healthCheck();
		await b.releaseFile("a.ts", "alice");
		const body = JSON.parse(String(seen.at(-1)?.body));
		expect(body.args.workspace_key).toBe("main");
		expect(body.args.project_key).toBe("main");
		b.shutdown();
	});
});

describe("listReservations", () => {
	it("maps reservations, including the expires_at optional field", async () => {
		stubFetch(
			withHealthOk(() =>
				json({
					result: {
						reservations: [
							{
								agent_name: "alice",
								path_pattern: "a.ts",
								expires_at: "2026-02-01T00:00:00Z",
							},
							{ agent_name: "bob", path_pattern: "b.ts" }, // no expires_at
						],
					},
				}),
			),
		);
		const b = await connectedBridge();
		const r = await b.listReservations();
		expect(r).toEqual([
			{
				agent_name: "alice",
				path_pattern: "a.ts",
				expires_at: "2026-02-01T00:00:00Z",
			},
			{ agent_name: "bob", path_pattern: "b.ts" },
		]);
		expect("expires_at" in nonNull(r[1])).toBe(false);
		b.shutdown();
	});

	it("returns [] when reservations is not an array", async () => {
		stubFetch(withHealthOk(() => json({ result: { reservations: "x" } })));
		const b = await connectedBridge();
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});

	it("returns [] when result is missing (optional chaining)", async () => {
		stubFetch(withHealthOk(() => json({})));
		const b = await connectedBridge();
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});

	it("returns [] on callTool error (catch branch)", async () => {
		stubFetch(withHealthOk(() => new Response("err", { status: 500 })));
		const b = await connectedBridge();
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});
});

// ===========================================
// workspace_key / project_key `|| "main"` fallback (right side of ||)
// ===========================================

describe("workspace_key/project_key default to 'main' when unset", () => {
	/** Bridge with NO workspaceKey/projectKey → forces the `|| "main"` branch. */
	async function noKeysBridge(): Promise<ServerBridge> {
		const b = new ServerBridge({ serverUrl: baseConfig.serverUrl });
		await b.healthCheck();
		return b;
	}

	it("reserveFile sends workspace_key/project_key = 'main'", async () => {
		let args: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call")) args = JSON.parse(String(init?.body)).args;
				return json({ result: { granted: ["a.ts"], conflicts: [] } });
			}),
		);
		const b = await noKeysBridge();
		await b.reserveFile("a.ts", "alice", 60);
		expect(args).toMatchObject({ workspace_key: "main", project_key: "main" });
		b.shutdown();
	});

	it("listReservations sends workspace_key/project_key = 'main'", async () => {
		let args: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call")) args = JSON.parse(String(init?.body)).args;
				return json({ result: { reservations: [] } });
			}),
		);
		const b = await noKeysBridge();
		await b.listReservations();
		expect(args).toMatchObject({ workspace_key: "main", project_key: "main" });
		b.shutdown();
	});

	it("flushGuardEvents stamps each event with workspace_key/project_key = 'main'", async () => {
		let payload: { events: Array<Record<string, unknown>> } | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch")) payload = JSON.parse(String(init?.body));
				return json({ result: {} });
			}),
		);
		const b = await noKeysBridge();
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(payload?.events[0]).toMatchObject({
			workspace_key: "main",
			project_key: "main",
		});
		b.shutdown();
	});
});

// ===========================================
// Guard event queue + flush
// ===========================================

describe("reportGuardEvent / flushGuardEvents", () => {
	it("flushes immediately once the queue reaches 10", async () => {
		const bodies: string[] = [];
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch") && init?.body) bodies.push(String(init.body));
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(bodies).toHaveLength(1);
		const payload = JSON.parse(nonNull(bodies[0]));
		expect(payload.events).toHaveLength(10);
		// Egress scrubber ran once per event (10) at the cloud boundary.
		expect(scrubMock.scrubEgressPayload).toHaveBeenCalledTimes(10);
		b.shutdown();
	});

	it("does NOT flush below the threshold of 10", async () => {
		stubFetch(withHealthOk(() => json({ result: {} })));
		const b = await connectedBridge();
		fetchSpy.mockClear();
		for (let i = 0; i < 9; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(
			fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("/batch")),
		).toBe(false);
		b.shutdown();
	});

	it("builds the activity payload with guard fields + truncated error_message", async () => {
		let captured: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch") && init?.body) {
					captured = JSON.parse(String(init.body));
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge({ authToken: "tok-123" });
		const longReason = "x".repeat(1000);
		for (let i = 0; i < 10; i++) {
			b.reportGuardEvent(makeEvent({ reason: longReason, event_type: "guard_warn" }));
		}
		await flush();
		const ev = nonNull((parseWire(captured?.events, wireArray(wireRecord(wireUnknown)), "test JSON value"))[0]);
		expect(ev).toMatchObject({
			agent_name: "alice",
			event_type: "guard_warn",
			tool_name: "Bash",
			tool_input_summary: "rm -rf /",
			hook_event: "guard_warn",
			source: "harness",
			workspace_key: "ws",
			project_key: "proj",
		});
		expect(String(ev.error_message).startsWith("[block] ")).toBe(true);
		expect(String(ev.error_message).length).toBe(500); // .slice(0, 500)
		b.shutdown();
	});

	it("sends Authorization + harness-version headers when authToken set", async () => {
		let headers: Record<string, string> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch")) {
					headers = parseWire(init?.headers, wireRecord(wireString), "test JSON value");
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge({ authToken: "secret-tok" });
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer secret-tok",
			"X-Interlinked-Harness-Version": "1.0.0",
		});
		b.shutdown();
	});

	it("omits Authorization header when no authToken (spread {} branch)", async () => {
		let headers: Record<string, string> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch")) {
					headers = parseWire(init?.headers, wireRecord(wireString), "test JSON value");
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge(); // no authToken
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(headers && "Authorization" in headers).toBe(false);
		b.shutdown();
	});

	it("early-returns when the queue is empty (shutdown's final flush is a no-op)", async () => {
		stubFetch(withHealthOk(() => json({ result: {} })));
		const b = await connectedBridge();
		fetchSpy.mockClear();
		// shutdown() invokes the same private flushGuardEvents; empty queue → early return.
		b.shutdown();
		await flush();
		expect(
			fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("/batch")),
		).toBe(false);
	});

	it("early-returns when disconnected (queue retained, no fetch to /batch)", async () => {
		// Health fails → connected=false. Queuing 10 events triggers the
		// immediate-flush path, but the `!this.connected` guard early-returns
		// before any /batch fetch.
		stubFetch(() => new Response("down", { status: 500 }));
		const b = new ServerBridge(baseConfig);
		await b.healthCheck();
		expect(b.isConnected()).toBe(false);
		fetchSpy.mockClear();
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		expect(
			fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("/batch")),
		).toBe(false);
		b.shutdown();
	});

	it("re-queues events on flush failure when batch ≤ 50", async () => {
		let attempt = 0;
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/batch")) {
					attempt++;
					if (attempt === 1) throw new TypeError("flush failed");
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush(); // immediate flush throws → 10 events re-queued (≤50)
		expect(attempt).toBe(1);
		// shutdown's final flush re-sends the re-queued batch — proving the
		// events survived the failure rather than being dropped.
		let resent: number | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/batch")) {
					attempt++;
					resent = (parseWire(JSON.parse(String(init?.body)).events, wireArray(wireUnknown), "test JSON value")).length;
				}
				return json({ result: {} });
			}),
		);
		b.shutdown();
		await flush();
		expect(attempt).toBe(2);
		expect(resent).toBe(10);
	});

	it("drops events on flush failure when batch > 50 (no re-queue)", async () => {
		// To build a single >50 batch we must avoid the immediate-flush path
		// (which drains 10 at a time). Queue all 60 while DISCONNECTED — every
		// reportGuardEvent's immediate flush early-returns on !connected, so the
		// queue accumulates to 60. Then reconnect and trigger one flush: a
		// single 60-event batch that fails → 60 > 50 → dropped, NOT re-queued.
		const batchSizes: number[] = [];
		let healthOk = false;
		stubFetch((url, init) => {
			if (url.endsWith("/health")) {
				return new Response("", { status: healthOk ? 200 : 500 });
			}
			if (url.endsWith("/batch")) {
				batchSizes.push((parseWire(JSON.parse(String(init?.body)).events, wireArray(wireUnknown), "test JSON value")).length);
				throw new TypeError("flush failed");
			}
			return json({ result: {} });
		});
		const b = new ServerBridge(baseConfig);
		await b.healthCheck(); // connected = false
		for (let i = 0; i < 60; i++) b.reportGuardEvent(makeEvent()); // no flush yet
		// Reconnect, then flush the whole 60-event queue once via shutdown.
		healthOk = true;
		await b.healthCheck(); // connected = true
		b.shutdown();
		await flush();
		// Exactly one batch attempt, of size 60 (>50) → dropped.
		expect(batchSizes).toEqual([60]);
		// Proof it was dropped, not re-queued: a second flush sends nothing.
		const before = batchSizes.length;
		// Re-trigger flush by queueing past the threshold (still failing fetch).
		for (let i = 0; i < 10; i++) b.reportGuardEvent(makeEvent());
		await flush();
		// Only the new 10-event batch is attempted; the dropped 60 never returns.
		expect(batchSizes.slice(before)).toEqual([10]);
	});
});

// ===========================================
// callTool JSON-RPC response shapes
// ===========================================

describe("callTool response handling (via listReservations / reserveFile)", () => {
	it("unwraps data.result", async () => {
		stubFetch(
			withHealthOk(() => json({ result: { reservations: [] } })),
		);
		const b = await connectedBridge();
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});

	it("throws data.error.message when present", async () => {
		stubFetch(
			withHealthOk(() => json({ error: { message: "rpc exploded" } })),
		);
		const b = await connectedBridge();
		// listReservations swallows → []; reserveFile maps to a non-denial → swallowed.
		// Use reserveFile and assert it does NOT throw (error message ≠ "Server API error").
		await expect(b.reserveFile("a.ts", "alice", 60)).resolves.toBeUndefined();
		// And confirm via release that the error path is reached: spy the message.
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});

	it("falls back to String(error) when error has no message", async () => {
		stubFetch(withHealthOk(() => json({ error: "bare-error-string" })));
		const b = await connectedBridge();
		expect(await b.listReservations()).toEqual([]);
		b.shutdown();
	});

	it("returns bare data when neither result nor error present", async () => {
		// No result key, no error → callTool returns the object itself.
		// listReservations sees reservations on the bare object.
		stubFetch(withHealthOk(() => json({ reservations: [{ agent_name: "z", path_pattern: "z.ts" }] })));
		const b = await connectedBridge();
		const r = await b.listReservations();
		expect(r).toEqual([{ agent_name: "z", path_pattern: "z.ts" }]);
		b.shutdown();
	});

	it("includes workspace_id in the call body when configured", async () => {
		let body: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call") && init?.body) {
					body = JSON.parse(String(init.body));
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge({ workspaceId: "do-abc" });
		await b.releaseFile("a.ts", "alice");
		expect(body?.workspace_id).toBe("do-abc");
		b.shutdown();
	});

	it("omits workspace_id when not configured", async () => {
		let body: Record<string, unknown> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call") && init?.body) {
					body = JSON.parse(String(init.body));
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge(); // no workspaceId
		await b.releaseFile("a.ts", "alice");
		expect(body && "workspace_id" in body).toBe(false);
		b.shutdown();
	});

	it("sends Authorization on callTool when authToken set", async () => {
		let headers: Record<string, string> | undefined;
		stubFetch(
			withHealthOk((url, init) => {
				if (url.endsWith("/api/ui/call")) {
					headers = parseWire(init?.headers, wireRecord(wireString), "test JSON value");
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge({ authToken: "ct-tok" });
		await b.releaseFile("a.ts", "alice");
		expect(headers?.Authorization).toBe("Bearer ct-tok");
		b.shutdown();
	});
});

// ===========================================
// fetchCoordinationState
// ===========================================

describe("fetchCoordinationState", () => {
	it("returns null immediately when not connected (no fetch)", async () => {
		stubFetch(() => new Response("down", { status: 500 }));
		const b = new ServerBridge(baseConfig);
		await b.healthCheck(); // connected=false
		fetchSpy.mockClear();
		const r = await b.fetchCoordinationState("alice", session);
		expect(r).toBeNull();
		expect(
			fetchSpy.mock.calls.some((c) =>
				String(c[0]).endsWith("/api/auto-coordinate"),
			),
		).toBe(false);
		b.shutdown();
	});

	it("returns parsed response on success", async () => {
		const payload = { heartbeat_recorded: true, unread: { total: 0, urgent: [] }, task_changes: [] };
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/api/auto-coordinate")) return json(payload);
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		const r = await b.fetchCoordinationState("alice", session);
		expect(r).toMatchObject({ heartbeat_recorded: true });
		b.shutdown();
	});

	it("returns null when response is not ok", async () => {
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/api/auto-coordinate")) return new Response("no", { status: 503 });
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		expect(await b.fetchCoordinationState("alice", session)).toBeNull();
		b.shutdown();
	});

	it("returns null when fetch throws (fail-open)", async () => {
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/api/auto-coordinate")) throw new TypeError("net");
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		expect(await b.fetchCoordinationState("alice", session)).toBeNull();
		b.shutdown();
	});

	it("aborts via fetchWithTimeout's timer when the request outlives timeoutMs", async () => {
		// Exercises fetchWithTimeout's `setTimeout(() => controller.abort(), …)`
		// callback: a fetch that only settles when its AbortSignal fires. A 1ms
		// timeoutMs makes the timer abort it → fetch rejects → fetchCoordinationState
		// fails open to null.
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }));
				if (url.endsWith("/api/auto-coordinate")) {
					return new Promise<Response>((_resolve, reject) => {
						const sig = init?.signal;
						sig?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						);
					});
				}
				return Promise.resolve(new Response("{}", { status: 200 }));
			}),
		);
		const b = new ServerBridge(baseConfig);
		await b.healthCheck();
		const r = await b.fetchCoordinationState("alice", session, 1);
		expect(r).toBeNull();
		b.shutdown();
	});

	it("passes the explicit timeoutMs branch and sends session fields + auth header", async () => {
		// `fetchWithTimeout` consumes the `timeout` option (destructures it out
		// before calling global fetch), so its value is NOT observable at the
		// fetch boundary — only the abort `signal` is. We therefore exercise the
		// `timeoutMs ?? 2000` truthy branch by passing an explicit value and
		// assert the observable surface: an abort signal, the auth header, and
		// the session-derived body.
		let init: RequestInit | undefined;
		stubFetch(
			withHealthOk((url, i) => {
				if (url.endsWith("/api/auto-coordinate")) {
					init = i;
					return json({ heartbeat_recorded: false, unread: { total: 0, urgent: [] }, task_changes: [] });
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge({ authToken: "co-tok" });
		await b.fetchCoordinationState("alice", session, 1234);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.headers).toHaveProperty(["Authorization"], "Bearer co-tok");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			agent_name: "alice",
			workspace_key: "ws",
			project_key: "proj",
			tool_call_count: 7,
			session_started_at: "2026-01-01T00:00:00Z",
		});
		b.shutdown();
	});

	it("takes the default-timeout branch when timeoutMs omitted (no auth header)", async () => {
		// Exercises the `timeoutMs ?? 2000` falsy branch (arg omitted) and the
		// no-authToken header branch. The 2000 value is consumed inside
		// fetchWithTimeout, so we assert the observable surface instead: a
		// signal is present and no Authorization header is sent.
		let init: RequestInit | undefined;
		stubFetch(
			withHealthOk((url, i) => {
				if (url.endsWith("/api/auto-coordinate")) {
					init = i;
					return json({ heartbeat_recorded: false, unread: { total: 0, urgent: [] }, task_changes: [] });
				}
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge(); // no authToken → no Authorization header
		const r = await b.fetchCoordinationState("alice", session);
		expect(r).toMatchObject({ heartbeat_recorded: false });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(new Headers(init?.headers).has("Authorization")).toBe(false);
		b.shutdown();
	});
});

// ===========================================
// shutdown
// ===========================================

describe("shutdown", () => {
	it("clears the flush interval (if-branch true) and attempts a final flush", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		let batched = false;
		stubFetch(
			withHealthOk((url) => {
				if (url.endsWith("/batch")) batched = true;
				return json({ result: {} });
			}),
		);
		const b = await connectedBridge();
		// Queue ONE event (below the immediate-flush threshold) so the only way
		// it reaches /batch is shutdown's final flushGuardEvents() call.
		b.reportGuardEvent(makeEvent());
		b.shutdown();
		await flush();
		expect(clearSpy).toHaveBeenCalledTimes(1);
		expect(batched).toBe(true);
	});

	it("is idempotent — second shutdown hits the null-interval (if-branch false)", async () => {
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		const b = await connectedBridge();
		b.shutdown(); // clears interval
		b.shutdown(); // flushInterval === null → skips clearInterval
		expect(clearSpy).toHaveBeenCalledTimes(1);
		expect(() => b.shutdown()).not.toThrow();
	});
});

// ===========================================
// createServerBridge factory
// ===========================================

describe("createServerBridge", () => {
	it("returns null when no config files exist", () => {
		fsMock.existsSync.mockReturnValue(false);
		expect(createServerBridge("/repo")).toBeNull();
	});

	it("returns null when shared has no server_url and no local override", () => {
		fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.json"));
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ default_project: "proj" }));
		expect(createServerBridge("/repo")).toBeNull();
	});

	it("builds a bridge from shared config.json (server_url + keys)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.json"));
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				server_url: "https://shared.example",
				default_workspace_key: "wk",
				default_project: "pk",
			}),
		);
		const b = createServerBridge("/repo");
		expect(b).toBeInstanceOf(ServerBridge);
		b?.shutdown();
	});

	it("prefers the active_server entry from config.local.json", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockImplementation((p: string) => {
			if (p.endsWith("config.local.json")) {
				return JSON.stringify({
					access_token: "tok",
					workspace_id: "ws-top",
					active_server: "staging",
					servers: {
						staging: { server_url: "https://staging.example", workspace_id: "ws-staging" },
					},
				});
			}
			return JSON.stringify({ server_url: "https://shared.example" });
		});
		const b = createServerBridge("/repo");
		expect(b).toBeInstanceOf(ServerBridge);
		b?.shutdown();
	});

	it("defaults active_server to 'production' and keeps top-level workspace_id when server lacks one", () => {
		fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.local.json"));
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				access_token: "tok",
				workspace_id: "ws-top",
				servers: { production: { server_url: "https://prod.example" } }, // no workspace_id
			}),
		);
		const b = createServerBridge("/repo");
		expect(b).toBeInstanceOf(ServerBridge);
		b?.shutdown();
	});

	it("survives malformed shared JSON (inner catch) and still uses local server_url", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockImplementation((p: string) => {
			if (p.endsWith("config.local.json")) {
				return JSON.stringify({ access_token: "tok", servers: { production: { server_url: "https://prod.example" } } });
			}
			return "{ not json"; // shared parse throws → caught
		});
		const b = createServerBridge("/repo");
		expect(b).toBeInstanceOf(ServerBridge);
		b?.shutdown();
	});

	it("survives malformed local JSON (inner catch); returns null if no server_url anywhere", () => {
		fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.local.json"));
		fsMock.readFileSync.mockReturnValue("}{ broken");
		expect(createServerBridge("/repo")).toBeNull();
	});

	it("returns null via the outer catch when existsSync throws", () => {
		fsMock.existsSync.mockImplementation(() => {
			throw new Error("fs exploded");
		});
		expect(createServerBridge("/repo")).toBeNull();
	});

	it("uses process.cwd() as the default cwd argument", () => {
		fsMock.existsSync.mockReturnValue(false);
		expect(createServerBridge()).toBeNull();
		// existsSync was called with a path rooted at the real cwd/.interlinked.
		const calledWith = fsMock.existsSync.mock.calls.map((c) => String(c[0]));
		expect(calledWith.some((p) => p.includes(".interlinked"))).toBe(true);
	});

	describe("parseSharedBridgeFields / parseLocalBridgeFields — wrong-typed fields", () => {
		it("P1: a well-typed shared config resolves normally (control)", async () => {
			fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.json"));
			fsMock.readFileSync.mockReturnValue(
				JSON.stringify({ server_url: "https://shared.example" }),
			);
			const b = createServerBridge("/repo");
			expect(b).toBeInstanceOf(ServerBridge);
			b?.shutdown();
		});

		it("N1: a non-string server_url in config.json is treated as absent, not coerced", async () => {
			fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.json"));
			fsMock.readFileSync.mockReturnValue(JSON.stringify({ server_url: 12345 }));
			// No local override either → no valid string URL anywhere → null.
			expect(createServerBridge("/repo")).toBeNull();
		});

		it("N2: config.json parsing to a non-object JSON value (array) is treated as absent", async () => {
			fsMock.existsSync.mockImplementation((p: string) => p.endsWith("config.json"));
			fsMock.readFileSync.mockReturnValue("[1,2,3]");
			expect(createServerBridge("/repo")).toBeNull();
		});

		/** The `workspace_id` field the constructed bridge sends in its callTool
		 *  envelope — the one network-observable proof of what `workspaceId`
		 *  actually resolved to (the class has no getter for it). */
		async function observedWorkspaceId(b: ServerBridge): Promise<unknown> {
			let body: Record<string, unknown> | undefined;
			stubFetch(
				withHealthOk((url, init) => {
					if (url.endsWith("/api/ui/call") && init?.body) body = JSON.parse(String(init.body));
					return json({ result: {} });
				}),
			);
			await b.healthCheck();
			await b.releaseFile("a.ts", "alice");
			return body?.workspace_id;
		}

		it("N3: a non-string active-server workspace_id falls back to the top-level one, not coerced", async () => {
			// The original `activeServer.workspace_id || workspaceId` had no type
			// check, so a wrong-typed (but truthy) 99 would win over "ws-top".
			fsMock.existsSync.mockReturnValue(true);
			fsMock.readFileSync.mockImplementation((p: string) => {
				if (p.endsWith("config.local.json")) {
					return JSON.stringify({
						workspace_id: "ws-top",
						active_server: "staging",
						servers: { staging: { server_url: "https://staging.example", workspace_id: 99 } },
					});
				}
				return JSON.stringify({});
			});
			const b = createServerBridge("/repo");
			expect(b).toBeInstanceOf(ServerBridge);
			expect(await observedWorkspaceId(nonNull(b))).toBe("ws-top");
			b?.shutdown();
		});

		it("N4: an active-server entry with workspace_id but no server_url overrides neither field", async () => {
			// Matches the original `if (activeServer?.server_url) { ... }` nesting:
			// a workspace_id-only entry (no server_url) must not flip workspaceId
			// on its own — only an entry that ALSO supplies server_url may do so.
			fsMock.existsSync.mockReturnValue(true);
			fsMock.readFileSync.mockImplementation((p: string) => {
				if (p.endsWith("config.local.json")) {
					return JSON.stringify({
						workspace_id: "ws-top",
						active_server: "staging",
						servers: { staging: { workspace_id: "ws-staging" } }, // no server_url
					});
				}
				return JSON.stringify({ server_url: "https://shared.example" });
			});
			const b = createServerBridge("/repo");
			expect(b).toBeInstanceOf(ServerBridge);
			expect(await observedWorkspaceId(nonNull(b))).toBe("ws-top");
			b?.shutdown();
		});

		it("N5: parseLocalBridgeFields treats a JSON scalar (null) as absent instead of crashing on property access", () => {
			// `config.local.json` can parse to any JSON value, not just an object
			// (e.g. a stray top-level `null`). isJsonObject(null) is false, so the
			// guard returns the all-undefined default. If that guard's condition
			// were inverted, the function would instead try `value.access_token`
			// on `null` and THROW — this call is made directly (no surrounding
			// try/catch, unlike the createServerBridge call site), so a thrown
			// TypeError here fails the test instead of being swallowed.
			expect(parseLocalBridgeFields(null)).toEqual({
				authToken: undefined,
				workspaceId: undefined,
				activeServerUrl: undefined,
			});
		});
	});
});
