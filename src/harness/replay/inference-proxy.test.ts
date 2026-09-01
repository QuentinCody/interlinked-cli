// G1 pass-through proxy — integration against a mock upstream: SSE responses
// stream to the client unmodified while the tee reassembles + captures an
// envelope; JSON responses capture directly; non-/v1/messages traffic passes
// through uncaptured; upstream failure returns 502 without crashing capture
// (docs/design/reproducibility/g1-inference-capture.md).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceProxy, type InferenceProxy, shouldCapture } from "./inference-proxy.js";
import { loadEnvelopes, pendingEnvelopePath } from "./inference-store.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PROXY_ENTRY = join("src", "harness", "replay", "inference-proxy.ts");

// `main()`'s CLI-entry guard creates its server through plain `createServer`
// with no way to retrieve the instance afterward. To run `main()` IN-PROCESS
// (so its startup path is coverage-instrumented, unlike a spawned subprocess)
// this wrapper records every server `node:http` creates so the main()-entry
// test below can close the one it started.
const capturedServers = vi.hoisted(() => {
	const servers: Server[] = [];
	return servers;
});
vi.mock("node:http", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:http")>();
	return {
		...actual,
		createServer: (...args: Parameters<typeof actual.createServer>) => {
			const server = actual.createServer(...args);
			capturedServers.push(server);
			return server;
		},
	};
});

// Control flags flipped per-test to force the reassembler / store to fail in
// ways that are otherwise unreachable through real SSE input (the
// reassembler is documented to "never throw on malformed input") or a real
// filesystem error (appendEnvelope always throws `Error` instances for real
// fs failures — a non-Error rejection needs an injected fault).
const sseFault = vi.hoisted(() => ({ throwNonError: false }));
vi.mock("./sse-reassembly.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sse-reassembly.js")>();
	return {
		...actual,
		createSseReassembler: (...args: Parameters<typeof actual.createSseReassembler>) => {
			const real = actual.createSseReassembler(...args);
			return {
				push: (chunk: string) => {
					if (sseFault.throwNonError) throw "sse-push-boom";
					real.push(chunk);
				},
				finish: () => real.finish(),
			};
		},
	};
});

const storeFault = vi.hoisted(() => ({ throwNonError: false }));
vi.mock("./inference-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./inference-store.js")>();
	return {
		...actual,
		appendEnvelope: (...args: Parameters<typeof actual.appendEnvelope>) => {
			if (storeFault.throwNonError) throw "append-boom";
			return actual.appendEnvelope(...args);
		},
	};
});

const cleanups: Array<() => void> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) fn();
});

function tempReplayDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-proxy-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const SSE_BODY: string = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","model":"m","usage":{"input_tokens":10}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_prx","name":"Read","input":{}}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":1}"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

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

async function startMockUpstream(): Promise<string> {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			// Two flushes so the proxy sees a chunk boundary mid-stream.
			res.write(SSE_BODY.slice(0, 120));
			setTimeout(() => {
				res.end(SSE_BODY.slice(120));
			}, 10);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, path: req.url }));
	});
	return listen(server);
}

async function startProxy(upstreamUrl: string, replayDir: string): Promise<InferenceProxy> {
	const proxy = await createInferenceProxy({
		port: 0,
		upstreamUrl,
		replayDir,
		log: () => undefined,
	});
	cleanups.push(() => proxy.close());
	return proxy;
}

describe("shouldCapture — the capture contract", () => {
	it("captures POST /v1/messages (with or without query)", () => {
		expect(shouldCapture("POST", "/v1/messages")).toBe(true);
		expect(shouldCapture("POST", "/v1/messages?beta=true")).toBe(true);
	});

	it("does not capture sub-paths, other endpoints, or non-POST", () => {
		expect(shouldCapture("POST", "/v1/messages/count_tokens")).toBe(false);
		expect(shouldCapture("POST", "/v1/messages/batches")).toBe(false);
		expect(shouldCapture("GET", "/v1/messages")).toBe(false);
		expect(shouldCapture("POST", "/v1/models")).toBe(false);
	});
});

describe("createInferenceProxy", () => {
	it("streams SSE through unmodified and captures a reassembled envelope", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);

		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": "sk-secret-never-persist",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }], max_tokens: 8 }),
		});
		const text = await resp.text();
		expect(resp.status).toBe(200);
		expect(text).toBe(SSE_BODY);

		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes).toHaveLength(1);
		const env = envelopes[0];
		expect(env?.tool_use_ids).toEqual(["toolu_prx"]);
		expect(env?.response.stop_reason).toBe("tool_use");
		expect(env?.request.model).toBe("m");
		expect(env?.request.params).toEqual({ max_tokens: 8 });
		expect(JSON.stringify(env?.request_headers)).not.toContain("sk-secret");
		expect(env?.request_headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("captures non-streaming JSON message responses too", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "msg_json",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "hi" }],
					}),
				);
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect((await resp.json()).id).toBe("msg_json");
		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.response.id).toBe("msg_json");
		expect(envelopes[0]?.tool_use_ids).toEqual([]);
	});

	it("passes non-/v1/messages traffic through without capturing", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/models`, { method: "GET" });
		expect((await resp.json()).ok).toBe(true);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("does not capture count_tokens (a /v1/messages sub-path)", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/messages/count_tokens`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("returns 502 when the upstream is unreachable", async () => {
		const replayDir = tempReplayDir();
		const proxy = await startProxy("http://127.0.0.1:9", replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(502);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("shouldCapture — url ?? default", () => {
	it("treats a missing url as non-matching rather than throwing", () => {
		expect(shouldCapture("POST", undefined)).toBe(false);
	});
});

describe("forwardHeaders — duplicate (array-valued) request headers", () => {
	it("joins duplicate header values with a comma before forwarding upstream", async () => {
		const replayDir = tempReplayDir();
		let received: Record<string, unknown> = {};
		const upstream = await listen(
			createServer((req, res) => {
				received = req.headers;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const port = Number(new URL(proxy.url).port);

		await new Promise<void>((resolveDone, rejectDone) => {
			const sock = netConnect(port, "127.0.0.1", () => {
				sock.write(
					[
						"GET /v1/models HTTP/1.1",
						`Host: 127.0.0.1:${port}`,
						"Set-Cookie: a=1",
						"Set-Cookie: b=2",
						"Connection: close",
						"",
						"",
					].join("\r\n"),
				);
			});
			sock.on("data", () => undefined);
			sock.on("close", () => resolveDone());
			sock.on("error", rejectDone);
		});

		// Node always reports "set-cookie" as an array on the receiving side
		// (even for a single physical header line) — the array element itself
		// is the joined string forwardHeaders produced.
		expect(received["set-cookie"]).toEqual(["a=1,b=2"]);
	});
});

describe("parseJsonObject — non-object-shaped bodies do not capture", () => {
	it("does not capture when the request body parses to a JSON array", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify([1, 2, 3]),
		});
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe(SSE_BODY);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("does not capture when the request body parses to a JSON number", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "42",
		});
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});

	it("does not capture (and still forwards) when the request body is malformed JSON", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not valid json",
		});
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe(SSE_BODY);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("relaySseWithCapture — no upstream body", () => {
	it("ends the response and skips capture when upstream returns a bodyless SSE response", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(204, { "content-type": "text/event-stream" });
				res.end();
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(resp.status).toBe(204);
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("relayBufferedWithCapture — response body does not parse as JSON", () => {
	it("still relays the raw text but skips capture", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("not actually json");
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(await resp.text()).toBe("not actually json");
		expect(loadEnvelopes(pendingEnvelopePath(replayDir))).toEqual([]);
	});
});

describe("content-type fallback — upstream response with no content-type header", () => {
	it("treats a missing content-type as non-SSE and captures via the buffered path", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				// Deliberately no content-type header at all.
				res.writeHead(200);
				res.end(JSON.stringify({ id: "msg_no_ct", stop_reason: "end_turn" }));
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect((await resp.json()).id).toBe("msg_no_ct");
		const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.response.id).toBe("msg_no_ct");
	});
});

describe("handleRequest — an in-flight request error propagates through the outer catch", () => {
	it("logs a handler error and closes the response when the client aborts mid-body", async () => {
		const replayDir = tempReplayDir();
		const logs: string[] = [];
		const proxy = await createInferenceProxy({
			port: 0,
			upstreamUrl: "http://127.0.0.1:9",
			replayDir,
			log: (msg) => logs.push(msg),
		});
		cleanups.push(() => proxy.close());
		const port = Number(new URL(proxy.url).port);

		await new Promise<void>((resolveDone) => {
			const sock = netConnect(port, "127.0.0.1", () => {
				// Announce a 100-byte body, then send far less and cut the
				// connection: readBody()'s `req.on("error", ...)` fires before
				// "end", rejecting handleRequest's promise from inside its own
				// (unawaited-by-the-caller) async body — the outer
				// `.catch(...)` in createInferenceProxy must handle it.
				sock.write(
					`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\n`,
				);
				sock.write("short body");
				setTimeout(() => sock.destroy(), 50);
			});
			sock.on("close", () => resolveDone());
			sock.on("error", () => resolveDone());
		});

		// The server-side "error"/"aborted" event and the outer .catch's log
		// call race the socket teardown above; poll for the deterministic
		// outcome instead of a fixed sleep.
		await vi.waitFor(() => {
			expect(logs.some((m) => m.startsWith("handler error:"))).toBe(true);
		});
	});
});

describe("relayPassthrough — no upstream body", () => {
	it("ends the client response cleanly when upstream returns a bodyless reply", async () => {
		const replayDir = tempReplayDir();
		const upstream = await listen(
			createServer((_req, res) => {
				res.writeHead(204, { "content-type": "application/json" });
				res.end();
			}),
		);
		const proxy = await startProxy(upstream, replayDir);
		const resp = await fetch(`${proxy.url}/v1/models`, { method: "GET" });
		expect(resp.status).toBe(204);
	});
});

describe("persistEnvelope — append failure is fail-open", () => {
	it("logs and does not throw when appendEnvelope's directory cannot be created", async () => {
		const replayDir = tempReplayDir();
		// Pre-create a plain FILE where appendEnvelope needs to mkdir a directory
		// ("<replayDir>/inference"), forcing a real fs error on append.
		writeFileSync(join(replayDir, "inference"), "not a directory");
		const upstream = await startMockUpstream();
		const logs: string[] = [];
		const proxy = await createInferenceProxy({
			port: 0,
			upstreamUrl: upstream,
			replayDir,
			log: (msg) => logs.push(msg),
		});
		cleanups.push(() => proxy.close());

		const resp = await fetch(`${proxy.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(await resp.text()).toBe(SSE_BODY);
		expect(logs.some((m) => m.includes("envelope append failed"))).toBe(true);
	});

	it("stringifies a thrown non-Error value in the envelope-append-failed log", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const logs: string[] = [];
		const proxy = await createInferenceProxy({
			port: 0,
			upstreamUrl: upstream,
			replayDir,
			log: (msg) => logs.push(msg),
		});
		cleanups.push(() => proxy.close());
		storeFault.throwNonError = true;
		try {
			const resp = await fetch(`${proxy.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m", messages: [] }),
			});
			expect(await resp.text()).toBe(SSE_BODY);
		} finally {
			storeFault.throwNonError = false;
		}
		expect(logs).toContain("envelope append failed (capture skipped): append-boom");
	});
});

describe("fetchUpstream — request with no body", () => {
	it("omits the body init field entirely for a bodyless GET request", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const proxy = await startProxy(upstream, replayDir);
		const port = Number(new URL(proxy.url).port);

		const response = await new Promise<string>((resolveDone, rejectDone) => {
			let raw = "";
			const sock = netConnect(port, "127.0.0.1", () => {
				sock.write(
					[`GET /v1/models HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close", "", ""].join(
						"\r\n",
					),
				);
			});
			sock.on("data", (chunk: Buffer) => {
				raw += chunk.toString("utf-8");
			});
			sock.on("close", () => resolveDone(raw));
			sock.on("error", rejectDone);
		});

		expect(response).toContain("200");
		expect(response).toContain('"ok":true');
	});
});

describe("relaySseWithCapture — non-Error thrown after headers are already sent", () => {
	it("skips re-writing the response head and stringifies the non-Error handler failure", async () => {
		const replayDir = tempReplayDir();
		const upstream = await startMockUpstream();
		const logs: string[] = [];
		const proxy = await createInferenceProxy({
			port: 0,
			upstreamUrl: upstream,
			replayDir,
			log: (msg) => logs.push(msg),
		});
		cleanups.push(() => proxy.close());

		sseFault.throwNonError = true;
		try {
			await new Promise<void>((resolveDone) => {
				fetch(`${proxy.url}/v1/messages`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "m", messages: [] }),
				}).catch(() => undefined);
				// The client fetch may itself error once the server aborts the
				// response mid-stream (headers already sent, body cut short); the
				// assertion below is on the server-side log, not the client result.
				setTimeout(resolveDone, 200);
			});
			await vi.waitFor(() => {
				expect(logs.some((m) => m.startsWith("handler error:"))).toBe(true);
			});
			expect(logs).toContain("handler error: sse-push-boom");
		} finally {
			sseFault.throwNonError = false;
		}
	});
});

describe("fetchUpstream — non-Error rejection", () => {
	it("stringifies a thrown non-Error value in the upstream-unreachable log", async () => {
		const replayDir = tempReplayDir();
		const logs: string[] = [];
		const proxy = await createInferenceProxy({
			port: 0,
			upstreamUrl: "http://127.0.0.1:9",
			replayDir,
			log: (msg) => logs.push(msg),
		});
		cleanups.push(() => proxy.close());

		// Only the proxy's OWN outbound fetch (to the upstream) should throw; the
		// test's client-side fetch to `proxy.url` must still go through for real,
		// and both travel over the same global `fetch` symbol.
		const originalFetch = globalThis.fetch;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const target = typeof input === "string" ? input : input.toString();
			if (target.startsWith(proxy.url)) return originalFetch(input, init);
			throw "boom-non-error";
		});
		try {
			const resp = await fetch(`${proxy.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m", messages: [] }),
			});
			expect(resp.status).toBe(502);
		} finally {
			fetchSpy.mockRestore();
		}
		expect(logs).toContain("upstream unreachable: boom-non-error");
	});
});

describe("createInferenceProxy default log/now + CLI entry (main)", () => {
	it("falls back to console.error and Date.now when log/now are omitted", async () => {
		const replayDir = tempReplayDir();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const proxy = await createInferenceProxy({ port: 0, upstreamUrl: "http://127.0.0.1:9", replayDir });
			cleanups.push(() => proxy.close());
			await fetch(`${proxy.url}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(consoleSpy.mock.calls.some((c) => String(c[0]).includes("[inference-proxy]"))).toBe(true);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	it("main(): starts listening and logs the proxy URL when run as a CLI entry", async () => {
		// Runs the module's CLI-entry guard IN-PROCESS (rather than via a
		// spawned subprocess) so main()'s startup path is coverage-instrumented:
		// stamp process.argv[1] to match this module's own resolved path, set
		// the env vars main() reads, then re-import with a cache-busting query
		// so the top-level `if (... import.meta.url === ...)` guard re-runs and
		// fires `main()` for real.
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
		const serversBefore = capturedServers.length;
		try {
			await import(`${pathToFileURL(modulePath).href}?run-as-main=${Date.now()}`);
			await vi.waitFor(() => {
				expect(
					consoleSpy.mock.calls.some((c) => String(c[0]).includes("listening on")),
				).toBe(true);
			});
			expect(
				consoleSpy.mock.calls.some((c) =>
					String(c[0]).includes("[inference-proxy] listening on http://127.0.0.1:"),
				),
			).toBe(true);
		} finally {
			for (const server of capturedServers.slice(serversBefore)) server.close();
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

	it("main(): falls back to the default upstream URL and replay dir when unset", async () => {
		// Same in-process technique as above, but leaving
		// ANTHROPIC_REAL_BASE_URL / INTERLINKED_REPLAY_DIR unset exercises the
		// `??` default arms (no upstream call and no filesystem write happen
		// during startup, so it's safe to actually hit the real defaults).
		const modulePath = fileURLToPath(new URL("./inference-proxy.ts", import.meta.url));
		const prevArgv1 = process.argv[1];
		const prevPort = process.env.PORT;
		const prevUpstream = process.env.ANTHROPIC_REAL_BASE_URL;
		const prevReplayDir = process.env.INTERLINKED_REPLAY_DIR;
		process.argv[1] = modulePath;
		process.env.PORT = "0";
		delete process.env.ANTHROPIC_REAL_BASE_URL;
		delete process.env.INTERLINKED_REPLAY_DIR;

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const serversBefore = capturedServers.length;
		try {
			await import(`${pathToFileURL(modulePath).href}?run-as-main=${Date.now()}`);
			await vi.waitFor(() => {
				expect(
					consoleSpy.mock.calls.some((c) => String(c[0]).includes("listening on")),
				).toBe(true);
			});
			expect(
				consoleSpy.mock.calls.some((c) => String(c[0]).includes("https://api.anthropic.com")),
			).toBe(true);
		} finally {
			for (const server of capturedServers.slice(serversBefore)) server.close();
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

	it("main(): defaults PORT to 8787 when the env var is unset", async () => {
		const replayDir = tempReplayDir();
		const modulePath = fileURLToPath(new URL("./inference-proxy.ts", import.meta.url));
		const prevArgv1 = process.argv[1];
		const prevPort = process.env.PORT;
		const prevUpstream = process.env.ANTHROPIC_REAL_BASE_URL;
		const prevReplayDir = process.env.INTERLINKED_REPLAY_DIR;
		process.argv[1] = modulePath;
		delete process.env.PORT;
		process.env.ANTHROPIC_REAL_BASE_URL = "http://127.0.0.1:9";
		process.env.INTERLINKED_REPLAY_DIR = replayDir;

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const serversBefore = capturedServers.length;
		try {
			await import(`${pathToFileURL(modulePath).href}?run-as-main=${Date.now()}`);
			await vi.waitFor(() => {
				expect(
					consoleSpy.mock.calls.some((c) => String(c[0]).includes("listening on")),
				).toBe(true);
			});
			expect(
				consoleSpy.mock.calls.some((c) =>
					String(c[0]).includes("[inference-proxy] listening on http://127.0.0.1:8787"),
				),
			).toBe(true);
		} finally {
			for (const server of capturedServers.slice(serversBefore)) server.close();
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

	it("main(): a fatal startup error is logged and exits non-zero", async () => {
		const replayDir = tempReplayDir();
		const child: ChildProcess = spawn(
			TSX_BIN,
			[PROXY_ENTRY],
			{
				cwd: REPO_ROOT,
				env: {
					...process.env,
					PORT: "not-a-number",
					ANTHROPIC_REAL_BASE_URL: "http://127.0.0.1:9",
					INTERLINKED_REPLAY_DIR: replayDir,
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		cleanups.push(() => {
			if (!child.killed) child.kill("SIGKILL");
		});

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
			const timer = setTimeout(() => rejectExit(new Error(`timed out; stderr so far: ${stderr}`)), 15_000);
			child.on("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
			child.on("error", (e) => {
				clearTimeout(timer);
				rejectExit(e);
			});
		});

		expect(exitCode).toBe(1);
		expect(stderr).toContain("[inference-proxy] fatal:");
	}, 20_000);
});
