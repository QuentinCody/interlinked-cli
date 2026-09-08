// Fleet W27 mutation-kill pass for inference-proxy.ts — targets the 45
// mutants the manifest recorded as `survived` after the earlier fleet
// (fleet-r3, W8) and companion-test rounds. Each `it()` is preceded by a
// `// test-contract:` comment naming the exact mutantId(s) it is designed to
// kill and the observable difference relied on. Receipts:
// scratch/fleet-r3/receipts/src_harness_replay_inference-proxy.ts.jsonl

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceProxy, type InferenceProxy, shouldCapture } from "./inference-proxy.js";
import { loadEnvelopes, pendingEnvelopePath } from "./inference-store.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-proxy-w27-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function listen(server: Server): Promise<string> {
	return new Promise((resolveUrl) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			cleanups.push(() => server.close());
			resolveUrl(`http://127.0.0.1:${port}`);
		});
	});
}

async function startProxy(
	upstreamUrl: string,
	replayDir: string,
	log?: (msg: string) => void,
): Promise<InferenceProxy> {
	const proxy = await createInferenceProxy({
		port: 0,
		upstreamUrl,
		replayDir,
		log: log ?? (() => undefined),
	});
	cleanups.push(() => proxy.close());
	return proxy;
}

/** Raw HTTP/1.1 GET with caller-supplied extra header lines, capturing what
 *  the (real) upstream server actually received. */
function startHeaderRecordingUpstream(): { url: Promise<string>; received: () => Record<string, unknown> } {
	let received: Record<string, unknown> = {};
	const server = createServer((req, res) => {
		received = req.headers;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	return { url: listen(server), received: () => received };
}

function rawRequest(port: number, extraHeaderLines: string[]): Promise<void> {
	return new Promise((resolveDone, rejectDone) => {
		const sock = netConnect(port, "127.0.0.1", () => {
			sock.write(
				[
					"GET /v1/models HTTP/1.1",
					`Host: 127.0.0.1:${port}`,
					"Connection: close",
					...extraHeaderLines,
					"",
					"",
				].join("\r\n"),
			);
		});
		sock.on("data", () => undefined);
		sock.on("close", () => resolveDone());
		sock.on("error", rejectDone);
		setTimeout(() => rejectDone(new Error("rawRequest timed out")), 5000);
	});
}

// Swaps globalThis.fetch so calls TO the proxy itself pass through to the
// real network, while every other call (the proxy's own outbound call to
// "upstream") is answered by `fakeUpstream`. Lets a test fully control the
// shape of the upstream Response without real HTTP framing risk.
function mockUpstreamFetch(
	proxyUrl: string,
	fakeUpstream: () => Response,
): { restore: () => void; capturedInit: () => RequestInit | undefined } {
	const originalFetch = globalThis.fetch;
	let capturedInit: RequestInit | undefined;
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const target = typeof input === "string" ? input : input.toString();
		if (target.startsWith(proxyUrl)) return originalFetch(input, init);
		capturedInit = init;
		return Promise.resolve(fakeUpstream());
	});
	return { restore: () => fetchSpy.mockRestore(), capturedInit: () => capturedInit };
}

describe("forwardHeaders — array-valued header is a joined STRING, never an array", () => {
	// test-contract: public-api — kills dda79f9837965ca1 (`typeof value ===
	// "string"` -> `true`). Spies on the proxy's OWN internal upstream fetch
	// call and asserts the exact shape of the `init.headers` object
	// forwardHeaders built: for an array-valued inbound header (the only way
	// Node ever hands forwardHeaders a non-string value), the forwarded value
	// must be the comma-joined STRING, not the raw array. Under the mutant,
	// the array-valued branch never runs and the raw array is assigned
	// instead — failing a strict equality against the expected joined string.
	it("passes forwardHeaders' output for a duplicate (array-valued) header as an exact joined string", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const port = Number(new URL(proxy.url).port);

		const mock = mockUpstreamFetch(
			proxy.url,
			() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
		);
		await rawRequest(port, ["Set-Cookie: a=1", "Set-Cookie: b=2"]);
		mock.restore();

		expect(mock.capturedInit()?.headers).toMatchObject({ "set-cookie": "a=1,b=2" });
	});
});

describe("shouldCapture — the leading anchor rejects a path that merely CONTAINS /v1/messages", () => {
	// test-contract: public-api — kills aeca3ad9f4fc8d1e (regex `^` anchor
	// stripped). With the anchor removed, "/v1/messages" anywhere in the
	// string would match; the pristine regex requires it at the very start.
	it("does not capture when /v1/messages appears mid-path rather than at the start", () => {
		expect(shouldCapture("POST", "/proxy/v1/messages")).toBe(false);
	});
});

describe("parseJsonObject — a numeric JSON body is rejected (not cast through as an object)", () => {
	// test-contract: boundary — kills 3a1238de206e4dc2, 79c954597784f697, and
	// 9b9bf4d4de272187 — three independent mutations of the guard
	// `parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)`
	// that all collapse to the same observable effect for a bare-number body:
	// `typeof 42 === "object"` is false in every pristine evaluation, so the
	// guard correctly rejects it and capture is skipped (empty envelope
	// list). Each mutant forces the first two clauses truthy, leaving only
	// `!Array.isArray(42)` (true) — letting 42 through as a fabricated
	// JsonObject; buildEnvelope does NOT throw on it (Object.entries(42) is
	// simply empty), so it silently produces a real envelope, flipping the
	// pristine "envelopes stays empty" result to non-empty.
	it("does not capture a request body that parses to a bare JSON number", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "msg_num", stop_reason: "end_turn" }));
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "42",
		});
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("relaySseWithCapture — no handler-error log for a bodyless SSE response", () => {
	// test-contract: boundary — kills 46a4362d85d99249 (`upstream.body` ->
	// `true`). With a real null `upstream.body` (204, no content), the
	// mutant's forced-true condition attempts `for await (const chunk of
	// null)`, which throws synchronously — surfacing as a "handler error:"
	// log via the outer .catch in createInferenceProxy. Pristine code skips
	// the loop via the real falsy check and logs nothing.
	it("ends cleanly and logs nothing when upstream returns a bodyless SSE response", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(204, { "content-type": "text/event-stream" });
				res.end();
			}),
		);
		const logs: string[] = [];
		const proxy = await startProxy(upstream, replayDir, (msg) => logs.push(msg));
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(204);
		expect(logs.some((m) => m.startsWith("handler error:"))).toBe(false);
	});
});

describe("relaySseWithCapture — no envelope-append-failed log when the stream never produced a message", () => {
	// test-contract: boundary — kills cc4f8396c09d3e6e (`message` -> `true`).
	// A real SSE (200, text/event-stream) response with zero bytes
	// reassembles to `null` (no message_start event ever arrived). Pristine
	// code's `if (message)` correctly skips persistEnvelope. The mutant forces
	// the call regardless, so buildEnvelope(ctx, null) throws inside
	// extractToolUseIds (`null.content`) — caught, and logged as
	// "envelope append failed ...".
	it("skips persistEnvelope and logs nothing for a zero-byte SSE-labeled response", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end();
			}),
		);
		const logs: string[] = [];
		const proxy = await startProxy(upstream, replayDir, (msg) => logs.push(msg));
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(200);
		expect(logs.some((m) => m.includes("envelope append failed"))).toBe(false);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("relayBufferedWithCapture — no envelope-append-failed log for a non-JSON body", () => {
	// test-contract: boundary — kills 6c4e81fcd2d9d35b (`parsed` -> `true`).
	// Pristine code's `if (parsed) persistEnvelope(...)` correctly skips a
	// null parse result. The mutant always calls persistEnvelope(ctx, null),
	// whose buildEnvelope throws inside extractToolUseIds — caught and
	// logged.
	it("relays raw text and logs nothing when the response body does not parse as JSON", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("not actually json");
			}),
		);
		const logs: string[] = [];
		const proxy = await startProxy(upstream, replayDir, (msg) => logs.push(msg));
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(await resp.text()).toBe("not actually json");
		expect(logs.some((m) => m.includes("envelope append failed"))).toBe(false);
	});
});

describe("relayPassthrough — no handler-error log for a bodyless non-captured response", () => {
	// test-contract: boundary — kills 54b3498343fa3a28 (`upstream.body` ->
	// `true`). Same reasoning as the SSE case above, on the non-/v1/messages
	// path.
	it("ends cleanly and logs nothing when upstream returns a bodyless reply on a passthrough route", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(204, { "content-type": "application/json" });
				res.end();
			}),
		);
		const logs: string[] = [];
		const proxy = await startProxy(upstream, replayDir, (msg) => logs.push(msg));
		const resp = await fetch(`${proxy.url}/v1/models`, { method: "GET" });
		expect(resp.status).toBe(204);
		expect(logs.some((m) => m.startsWith("handler error:"))).toBe(false);
	});
});

describe("fetchUpstream — a non-empty request body is actually forwarded upstream", () => {
	// test-contract: public-api — kills 57b011c141a007f9 (`body.length > 0`
	// -> `false`). Pristine code sets `init.body` whenever the body has
	// bytes; the mutant forces the guard false unconditionally, so
	// `init.body` is never set — upstream would receive an empty body no
	// matter what the client sent.
	it("forwards the client's POST body bytes to upstream unchanged", async () => {
		const replayDir = tempReplayDir();
		let receivedBody = "";
		const upstream = await listen(
			createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					receivedBody = Buffer.concat(chunks).toString("utf-8");
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				});
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/models`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "PROBE-BODY-MARKER-12345",
		});
		expect(receivedBody).toBe("PROBE-BODY-MARKER-12345");
	});
});

describe("fetchUpstream — the connect-timeout timer is always cleared", () => {
	// test-contract: invariant — kills 7ab86c92cf185b49 (the `finally {
	// clearTimeout(...) }` block emptied). A call-count spy on the injectable
	// global clearTimeout, paired with the request's own successful (real)
	// completion, is the direct observable for "the finally block still ran".
	it("calls clearTimeout exactly once per completed request", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		// The global clearTimeout is shared with unrelated Node/undici internals, so a raw
		// total-call-count assertion is not a valid observable — isolate the connect-timer's
		// own id (the setTimeout scheduled with the 30s connect-timeout delay) and confirm
		// THAT specific timer is cleared exactly once.
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		try {
			const resp = await fetch(`${proxy.url}/v1/models`);
			expect(resp.status).toBe(200);
			const connectTimerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000);
			expect(connectTimerCallIndex).toBeGreaterThanOrEqual(0);
			const connectTimerId = setTimeoutSpy.mock.results[connectTimerCallIndex]?.value;
			const clearsForConnectTimer = clearTimeoutSpy.mock.calls.filter(([id]) => id === connectTimerId);
			expect(clearsForConnectTimer.length).toBe(1);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		}
	});
});

describe("handleRequest — the 502 upstream-unreachable response has the exact documented shape", () => {
	// test-contract: public-api — kills 07043e1f4cf880ac, df2ff3ccbf27cd41,
	// cac77f98c8255b4c, 6efcd4e0da28fc6c, c5af6e5a490e54be, and
	// fbcdbb8c9bff13f6 — all six mutate either the `!upstream` guard itself
	// or the exact status/headers/body it writes. Any of them causes control
	// to fall through into relayResponseHeaders(upstream, res) with upstream
	// still null, which throws — caught by the OUTER handler catch, which
	// (headers never sent) writes a bare 502 with NO content-type and an
	// EMPTY body. Asserting the exact content-type and exact JSON body (not
	// just the status code) is what distinguishes pristine from all six.
	it("returns 502 with the exact content-type and JSON error body", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(502);
		expect(resp.headers.get("content-type")).toBe("application/json");
		expect(await resp.text()).toBe(JSON.stringify({ error: "inference-proxy: upstream unreachable" }));
	});
});

describe("handleRequest — a non-capture-eligible request never attempts (or fails) capture", () => {
	// test-contract: boundary — kills 1b576d89d7296b97 (`!requestBody` ->
	// `false`) and 15f8483a695b57c3 (the early-return block emptied) — both
	// let control fall through into the capture-context build with
	// requestBody still null. persistEnvelope would then be invoked with a
	// null requestBody once the response body parses as JSON (as this GET
	// does), and splitRequestBody(null) throws (Object.entries(null)) —
	// caught and logged, which pristine code never produces for a
	// non-/v1/messages route.
	it("logs nothing at all for a plain GET to a non-messages route", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}),
		);
		const logs: string[] = [];
		const proxy = await startProxy(upstream, replayDir, (msg) => logs.push(msg));
		const resp = await fetch(`${proxy.url}/v1/models`, { method: "GET" });
		const body: unknown = await resp.json();
		expect(body).toEqual({ ok: true });
		expect(logs).toEqual([]);
	});
});

describe("createInferenceProxy — binds strictly to loopback", () => {
	// test-contract: security — kills 4d01c0d1876cf136 (`"127.0.0.1"` ->
	// `""`). An empty host string changes the actual OS-reported bind address
	// away from "127.0.0.1" (binding to all interfaces instead) — a direct
	// regression of the loopback-only design this proxy depends on to keep
	// live API credentials off the network (see the file's own header
	// comment and the `ubs_hardcoded_localhost` suppression above the bind).
	it("reports 127.0.0.1 as the actual bound address", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const addr = proxy.server.address();
		expect(typeof addr === "object" && addr ? addr.address : null).toBe("127.0.0.1");
	});
});

describe("createInferenceProxy — the request-index counter increments, never decrements", () => {
	// test-contract: invariant — kills da020a6d4ce942b6 (`++counter` ->
	// `--counter`).
	it("assigns strictly increasing request_index values across consecutive captures", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "msg", stop_reason: "end_turn" }));
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes.map((e) => e.request_index)).toEqual([1, 2]);
	});
});

describe("createInferenceProxy — the request handler's fallback 502 fires even when the failure precedes any writeHead", () => {
	// test-contract: public-api — kills 2dfe9c287ee6da05 (`!res.headersSent`
	// -> `false`). Forces the proxy's OWN internal upstream fetch to return
	// an object whose `.headers.forEach` throws, so the failure happens
	// inside relayResponseHeaders BEFORE any writeHead call. Pristine
	// outer-catch: headers genuinely unsent, so it writes 502. Mutant: the
	// check is forced false, writeHead is skipped, and res.end() alone
	// leaves Node's default (200) status.
	it("still answers 502 when the upstream response's headers cannot be read", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const mock = mockUpstreamFetch(proxy.url, () => {
			const response = new Response(null, { status: 200 });
			vi.spyOn(response.headers, "forEach").mockImplementation(() => { throw new Error("boom-headers"); });
			return response;
		});
		try {
			const resp = await fetch(`${proxy.url}/v1/models`);
			expect(resp.status).toBe(502);
		} finally {
			mock.restore();
		}
	});
});

describe("createInferenceProxy — close() actually stops the server listening", () => {
	// test-contract: public-api — kills 74cd2c5501c191b6 (`() =>
	// server.close()` -> `() => undefined`). Node's `Server.listening` flips
	// to false as soon as close() is called (even before the "close" event
	// fires).
	it("flips server.listening to false", async () => {
		const replayDir = tempReplayDir();
		const proxy = await createInferenceProxy({ port: 0, upstreamUrl: "http://127.0.0.1:9", replayDir });
		expect(proxy.server.listening).toBe(true);
		proxy.close();
		expect(proxy.server.listening).toBe(false);
	});
});

describe("relayResponseHeaders — content-length/transfer-encoding are recomputed, not relayed", () => {
	// test-contract: public-api — kills 5294f8a621a22277 ("content-length"
	// blanked in NON_RELAYED) and e82d2087701ac117 ("transfer-encoding"
	// blanked in NON_RELAYED). Fully mocks the proxy's internal upstream
	// fetch (never touches real HTTP framing, which would be unsafe to fake
	// with mismatched declared lengths) so the fake Response can declare raw
	// upstream headers under our control, and asserts none of the
	// NON_RELAYED names reach the client while an unrelated custom header
	// does.
	it("strips content-length/transfer-encoding/connection/content-encoding but relays a custom header", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const mock = mockUpstreamFetch(
			proxy.url,
			() =>
				new Response(null, {
					status: 200,
					headers: {
						"content-type": "application/json",
						"content-length": "999",
						// A sentinel Node's own outgoing chunked-framing logic would never produce —
						// distinguishes "our code relayed this literal upstream value" from "Node set
						// its own transfer-encoding: chunked because no content-length was given",
						// which is legitimate and NOT the bug this case targets.
						"transfer-encoding": "bogus-te-999",
						// Same rationale as transfer-encoding above: Node's own HTTP/1.1
						// keep-alive handling legitimately sets its own "connection" value
						// independent of what upstream sent, so a sentinel distinguishes
						// "our code relayed the literal upstream value" from Node's own choice.
						connection: "bogus-conn-999",
						"content-encoding": "gzip",
						"x-upstream-marker": "keep-me",
					},
				}),
		);
		const resp = await fetch(`${proxy.url}/v1/models`);
		mock.restore();
		expect(resp.headers.get("content-length")).not.toBe("999");
		expect(resp.headers.get("transfer-encoding")).not.toBe("bogus-te-999");
		expect(resp.headers.get("connection")).not.toBe("bogus-conn-999");
		expect(resp.headers.get("content-encoding")).toBeNull();
		expect(resp.headers.get("x-upstream-marker")).toBe("keep-me");
	});
});

describe("forwardHeaders — the inbound Host header is never forwarded upstream", () => {
	// test-contract: security — kills 1cada42cad588e30 ("host" blanked in
	// NON_FORWARDED). A client-declared Host header value must never reach
	// the real upstream unchanged; forwardHeaders strips it so the outbound
	// fetch computes its own Host from the actual target URL.
	it("does not leak the client's declared Host header value to upstream", async () => {
		const { url, received } = startHeaderRecordingUpstream();
		const upstreamUrl = await url;
		const replayDir = tempReplayDir();
		const proxy = await startProxy(upstreamUrl, replayDir);
		const port = Number(new URL(proxy.url).port);

		await rawRequest(port, ["X-Marker: irrelevant"]);
		// The client connected declaring `Host: 127.0.0.1:<proxy port>` (see
		// rawRequest); if that leaked through unstripped, upstream would see
		// the PROXY's port in the Host header rather than its own.
		expect(String(received().host ?? "")).not.toContain(String(port));
	});
});

describe("forwardHeaders — the inbound Upgrade header is never forwarded upstream", () => {
	// test-contract: security — kills f1b38d891b122bf1 ("upgrade" blanked in
	// NON_FORWARDED).
	it("does not forward a client-declared Upgrade header", async () => {
		const { url, received } = startHeaderRecordingUpstream();
		const upstreamUrl = await url;
		const replayDir = tempReplayDir();
		const proxy = await startProxy(upstreamUrl, replayDir);
		const port = Number(new URL(proxy.url).port);

		await rawRequest(port, ["Upgrade: PROBE-UPGRADE-MARKER"]);
		expect(received().upgrade).toBeUndefined();
	});
});

describe("main() — literal/log-text mutants", () => {
	// test-contract: public-api — kills 57de7cf238ef771b (`??` -> `&&` on
	// INTERLINKED_REPLAY_DIR), e0fbfb56dc9e3d29 (the "envelopes →" template
	// literal blanked), and 0fd16fa35588f26e (the "point your runner at it"
	// template literal blanked). With `&&`, a truthy env var value would
	// select the SECOND operand (the cwd-based default) instead of itself,
	// so the logged replay dir would not be our custom tmp dir; asserting
	// the FULL expected log line (not just log-truthiness) also fails if
	// either template was emptied.
	it("honors INTERLINKED_REPLAY_DIR over the cwd-based default and logs the full expected lines", async () => {
		const replayDir = tempReplayDir();
		const modulePath = fileURLToPath(new URL("./inference-proxy.ts", import.meta.url));
		const prevArgv1 = process.argv[1];
		const prevPort = process.env.PORT;
		const prevUpstream = process.env.ANTHROPIC_REAL_BASE_URL;
		const prevReplayDir = process.env.INTERLINKED_REPLAY_DIR;
		process.argv[1] = modulePath;
		process.env.PORT = "0";
		process.env.ANTHROPIC_REAL_BASE_URL = "http://127.0.0.1:9";
		process.env.INTERLINKED_REPLAY_DIR = replayDir;

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await import(`${pathToFileURL(modulePath).href}?run-as-main-w27=${Date.now()}`);
			await vi.waitFor(() => {
				expect(consoleSpy.mock.calls.some((c) => String(c[0]).includes("listening on"))).toBe(true);
			});
			expect(
				consoleSpy.mock.calls.some((c) =>
					String(c[0]).includes(`[inference-proxy] envelopes → ${replayDir}/inference/pending.jsonl`),
				),
			).toBe(true);
			expect(
				consoleSpy.mock.calls.some((c) =>
					String(c[0]).includes("[inference-proxy] point your runner at it:  export ANTHROPIC_BASE_URL="),
				),
			).toBe(true);
		} finally {
			if (prevArgv1 !== undefined) process.argv[1] = prevArgv1;
			if (prevPort === undefined) delete process.env.PORT;
			else process.env.PORT = prevPort;
			if (prevUpstream === undefined) delete process.env.ANTHROPIC_REAL_BASE_URL;
			else process.env.ANTHROPIC_REAL_BASE_URL = prevUpstream;
			if (prevReplayDir === undefined) delete process.env.INTERLINKED_REPLAY_DIR;
			else process.env.INTERLINKED_REPLAY_DIR = prevReplayDir;
			consoleSpy.mockRestore();
		}
	});

	// test-contract: public-api — kills 4f680342e85d2f66 (".interlinked"
	// blanked) and 32116d766b09be4e ("replay" blanked). Only exercised when
	// INTERLINKED_REPLAY_DIR is unset, so the default-join arm runs; the
	// expected substring requires BOTH literal segments intact.
	it("builds the default replay dir from BOTH '.interlinked' and 'replay' path segments", async () => {
		const modulePath = fileURLToPath(new URL("./inference-proxy.ts", import.meta.url));
		const prevArgv1 = process.argv[1];
		const prevPort = process.env.PORT;
		const prevUpstream = process.env.ANTHROPIC_REAL_BASE_URL;
		const prevReplayDir = process.env.INTERLINKED_REPLAY_DIR;
		process.argv[1] = modulePath;
		process.env.PORT = "0";
		delete process.env.ANTHROPIC_REAL_BASE_URL;
		delete process.env.INTERLINKED_REPLAY_DIR;

		const expectedDefault = join(process.cwd(), ".interlinked", "replay");
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await import(`${pathToFileURL(modulePath).href}?run-as-main-w27b=${Date.now()}`);
			await vi.waitFor(() => {
				expect(consoleSpy.mock.calls.some((c) => String(c[0]).includes("listening on"))).toBe(true);
			});
			expect(
				consoleSpy.mock.calls.some((c) =>
					String(c[0]).includes(`[inference-proxy] envelopes → ${expectedDefault}/inference/pending.jsonl`),
				),
			).toBe(true);
		} finally {
			if (prevArgv1 !== undefined) process.argv[1] = prevArgv1;
			if (prevPort === undefined) delete process.env.PORT;
			else process.env.PORT = prevPort;
			if (prevUpstream === undefined) delete process.env.ANTHROPIC_REAL_BASE_URL;
			else process.env.ANTHROPIC_REAL_BASE_URL = prevUpstream;
			if (prevReplayDir === undefined) delete process.env.INTERLINKED_REPLAY_DIR;
			else process.env.INTERLINKED_REPLAY_DIR = prevReplayDir;
			consoleSpy.mockRestore();
		}
	});
});
