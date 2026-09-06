import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { createDaemonClient } from "./daemon-client.js";
import { encodeFrame } from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./session-daemon.js";
import type { DaemonPaths } from "./session-paths.js";
import type { TsgoRunner } from "./tsgo-runner.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;
let server: Server | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-dc-"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePaths(id: string): DaemonPaths {
	return {
		socket: join(tmp, `harness-${id}.sock`),
		pid: join(tmp, `harness-${id}.pid`),
		log: join(tmp, "logs", `daemon-${id}.log`),
	};
}

function makeTsgo(): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
	};
}

function makeEvaluatorContext(): EvaluateUnifiedContext {
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

describe("DaemonClient.call — happy path", () => {
	it("returns the result of daemon.health", async () => {
		const paths = makePaths("c1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "c1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createDaemonClient(paths.socket);
		const health = await client.call("daemon.health", {});
		expect(health.status).toBe("ready");
		expect(health.protocol_version).toBe("1");
	});

	it("forwards tsgo.invalidate and receives ack", async () => {
		const paths = makePaths("c2");
		const tsgo = makeTsgo();
		daemon = await startSessionDaemon({
			paths,
			session_id: "c2",
			state: { tsgo, getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createDaemonClient(paths.socket);
		const ack = await client.call("daemon.invalidate", { path: "/x.ts" });
		expect(ack.ack).toBe(true);
		expect(nonNull((tsgo.invalidate as ReturnType<typeof vi.fn>).mock.calls[0])[0]).toBe("/x.ts");
	});

	it("ignores responses whose id does not match the request", async () => {
		const socketPath = join(tmp, "mismatch.sock");
		server = createServer((socket) => {
			socket.on("data", () => {
				socket.write(
					encodeFrame({
						id: "wrong-id",
						result: {
							status: "degraded",
							uptime_ms: 0,
							warm_caches: [],
							tsgo_status: "unavailable",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
				socket.write(
					encodeFrame({
						id: "expected-id",
						result: {
							status: "ready",
							uptime_ms: 1,
							warm_caches: [],
							tsgo_status: "ready",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(socketPath, () => resolve());
		});

		const health = await createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			{ id: "expected-id", timeout_ms: 250 },
		);

		expect(health.status).toBe("ready");
	});
});

describe("DaemonClient.call — errors", () => {
	it("rejects with `timeout` when the socket does not exist", async () => {
		const missing = join(tmp, "nope.sock");
		expect(existsSync(missing)).toBe(false);
		const client = createDaemonClient(missing);
		await expect(client.call("daemon.health", {}, { timeout_ms: 250 })).rejects.toBeDefined();
	});

	it("skips an undecodable frame and resolves from the next well-formed one", async () => {
		const socketPath = join(tmp, "garbage.sock");
		server = createServer((socket) => {
			socket.on("data", () => {
				// Not JSON: decodeFrame throws, so parseResponseFrame must swallow
				// it and report `null` for this frame only.
				socket.write("{ not json\n");
				socket.write(
					encodeFrame({
						id: "garbage-id",
						result: {
							status: "ready",
							uptime_ms: 7,
							warm_caches: [],
							tsgo_status: "ready",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

		// Resolving with the SECOND frame's payload is the discriminating
		// observable: a decode failure that was not swallowed would escape the
		// `data` listener, leaving the call to reject on its deadline instead.
		const health = await createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			{ id: "garbage-id", timeout_ms: 1000 },
		);
		expect(health.status).toBe("ready");
		expect(health.uptime_ms).toBe(7);
	});

	it("rejects with `socket closed` when the daemon hangs up without answering", async () => {
		const socketPath = join(tmp, "hangup.sock");
		server = createServer((socket) => {
			socket.on("data", () => socket.end()); // read the request, answer nothing
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

		// The deadline is far longer than the hang-up, so the message
		// discriminates: without the close handler's rejection this call would
		// reject with `timeout` a second later instead.
		await expect(
			createDaemonClient(socketPath).call("daemon.health", {}, { timeout_ms: 1000 }),
		).rejects.toThrow("socket closed");
	});
});

describe("DaemonClient.call — cancellation (review pass 16)", () => {
	it("P: rejects with `aborted` when the signal fires after the socket connects", async () => {
		const socketPath = join(tmp, "silent.sock");
		const accepted: import("node:net").Socket[] = [];
		const controller = new AbortController();
		server = createServer((socket) => {
			accepted.push(socket); // accept, answer nothing
			controller.abort();
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		const pending = createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			{ timeout_ms: 250, signal: controller.signal },
		);
		await expect(pending).rejects.toThrow("aborted");
		for (const sock of accepted) sock.destroy();
	});

	it("P: a PRE-aborted signal rejects immediately and opens no socket", async () => {
		const socketPath = join(tmp, "never-dialed.sock");
		let connections = 0;
		server = createServer(() => {
			connections += 1;
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		const controller = new AbortController();
		controller.abort();
		await expect(
			createDaemonClient(socketPath).call(
				"daemon.health",
				{},
				{ timeout_ms: 250, signal: controller.signal },
			),
		).rejects.toThrow("aborted");
		// Cross one event-loop turn so any incorrectly queued connection event
		// becomes observable without coupling the assertion to wall-clock speed.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connections).toBe(0);
	});

	it("N: an unaborted signal changes nothing — the call completes normally", async () => {
		const socketPath = join(tmp, "normal.sock");
		server = createServer((socket) => {
			socket.on("data", () => {
				socket.write(
					encodeFrame({
						id: "sig-id",
						result: {
							status: "ready",
							uptime_ms: 1,
							warm_caches: [],
							tsgo_status: "ready",
							rpc_inflight: 0,
							protocol_version: "1",
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		const controller = new AbortController();
		const health = await createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			{ id: "sig-id", timeout_ms: 500, signal: controller.signal },
		);
		expect(health.status).toBe("ready");
	});
});
