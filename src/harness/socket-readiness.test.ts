import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, PROTOCOL_VERSION } from "./daemon-protocol.js";
import { classifyHarnessSocket, isHarnessSocketReady } from "./socket-readiness.js";

let root: string;
let server: Server | null;
let clients: Set<Socket>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-ready-"));
	server = null;
	clients = new Set();
});

afterEach(async () => {
	for (const socket of clients) socket.destroy();
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
});

async function listen(handler: (socket: Socket) => void): Promise<string> {
	const socketPath = join(root, "harness.sock");
	server = createServer((socket) => {
		clients.add(socket);
		socket.once("close", () => clients.delete(socket));
		handler(socket);
	});
	await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
	return socketPath;
}

describe("isHarnessSocketReady", () => {
	it("accepts a raw socket only after a valid StatusQuery decision", async () => {
		const path = await listen((socket) => {
			socket.once("data", () => socket.end('{"decision":"allow"}\n'));
		});
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe(true);
	});

	it("rejects a listener that accepts but never answers", async () => {
		const path = await listen(() => {
			/* deliberately silent */
		});
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "raw", opts: { timeout_ms: 30 } }),
		).resolves.toBe(false);
	});

	it("rejects an unrelated JSON-speaking listener", async () => {
		const path = await listen((socket) => socket.once("data", () => socket.end('{"ok":true}\n')));
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe(false);
	});

	it("accepts framed readiness only after a valid daemon.health response", async () => {
		const path = await listen((socket) => {
			socket.once("data", (chunk: Buffer) => {
				const request = parseWire(JSON.parse(chunk.toString("utf8").trim()), wireObject({ "id": wireString }), "test JSON value");
				socket.end(
					encodeFrame({
						schema_version: "1",
						id: request.id,
						result: {
							status: "ready",
							uptime_ms: 1,
							warm_caches: [],
							tsgo_status: "ready",
							rpc_inflight: 0,
							protocol_version: PROTOCOL_VERSION,
						},
					}),
				);
			});
		});
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "framed", opts: { timeout_ms: 200 } }),
		).resolves.toBe(true);
	});

	it("rejects a listener whose first line is not JSON at all", async () => {
		const path = await listen((socket) => socket.once("data", () => socket.end("not-json\n")));
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe(false);
	});

	it("rejects a pathname whose connection fails before any answer arrives", async () => {
		// The timeout is far longer than an ENOENT round-trip, so only the
		// socket error path can settle this probe.
		await expect(
			isHarnessSocketReady({
				socketPath: join(root, "missing.sock"),
				protocol: "raw",
				opts: { timeout_ms: 3_000 },
			}),
		).resolves.toBe(false);
	});

	it("rejects a pathname the platform refuses to open a connection for", async () => {
		await expect(
			isHarnessSocketReady({ socketPath: "", protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe(false);
	});

	it("rejects a framed listener whose health body only resembles the contract", async () => {
		const path = await listen((socket) => {
			socket.once("data", (chunk: Buffer) => {
				const request = parseWire(JSON.parse(chunk.toString("utf8").trim()), wireObject({ "id": wireString }), "test JSON value");
				// Deliberately bypass the typed encoder: this is an untrusted peer
				// returning a schema-shaped but incomplete health response.
				socket.end(
					`${JSON.stringify({ id: request.id, result: { status: "ready", protocol_version: PROTOCOL_VERSION } })}\n`,
				);
			});
		});
		await expect(
			isHarnessSocketReady({ socketPath: path, protocol: "framed", opts: { timeout_ms: 200 } }),
		).resolves.toBe(false);
	});
});

describe("classifyHarnessSocket", () => {
	it("reports an absent pathname as unlink-safe", async () => {
		await expect(
			classifyHarnessSocket({
				socketPath: join(root, "missing.sock"),
				protocol: "raw",
				opts: { timeout_ms: 30 },
			}),
		).resolves.toBe("absent");
	});

	it("reports a valid protocol peer as ready", async () => {
		const path = await listen((socket) => {
			socket.once("data", () => socket.end('{"decision":"allow"}\n'));
		});
		await expect(
			classifyHarnessSocket({ socketPath: path, protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe("ready");
	});

	it("protects an accepting but silent listener as occupied-unready", async () => {
		const path = await listen(() => {
			/* deliberately silent */
		});
		await expect(
			classifyHarnessSocket({ socketPath: path, protocol: "raw", opts: { timeout_ms: 30 } }),
		).resolves.toBe("occupied_unready");
	});

	it("protects an unrelated JSON listener as occupied-unready", async () => {
		const path = await listen((socket) => socket.once("data", () => socket.end('{"ok":true}\n')));
		await expect(
			classifyHarnessSocket({ socketPath: path, protocol: "raw", opts: { timeout_ms: 200 } }),
		).resolves.toBe("occupied_unready");
	});

	it("protects a pathname the platform refuses to open a connection for", async () => {
		await expect(
			classifyHarnessSocket({ socketPath: "", protocol: "raw", opts: { timeout_ms: 30 } }),
		).resolves.toBe("occupied_unready");
	});

	it("protects a connection that has not been accepted by the deadline", async () => {
		const path = await listen(() => {
			/* accepts eventually; the presence probe must not wait for it */
		});
		// Fake timers fire the presence deadline before the event loop can
		// deliver the connect callback, which is the ordering the guard exists
		// for: an unanswered connect must never be reported as unlink-safe.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const state = classifyHarnessSocket({ socketPath: path, protocol: "raw", opts: { timeout_ms: 40 } });
		vi.advanceTimersByTime(40);
		vi.useRealTimers();
		await expect(state).resolves.toBe("occupied_unready");
	});
});
