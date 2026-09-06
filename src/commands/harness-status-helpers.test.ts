// Direct pins for queryHarnessSocket — the RAW-PROTOCOL-ONLY by-explicit-path
// round-trip (review 2026-08-26, corrected: framed daemons speak the RPC
// frame envelope and are probed with createDaemonClient, NEVER this helper).
// A REAL unix socket, no mocks.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryHarnessSocket } from "./harness-status-helpers.js";

const EVENT = { hook_event: "StatusQuery", session_id: "t", agent_source: "claude", timestamp: "t" };

describe("queryHarnessSocket — positive (must fire)", () => {
	let tmp: string;
	let server: Server;
	let socketPath: string;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "il-qhs-"));
		socketPath = join(tmp, "answering.sock");
		server = createServer((sock) => {
			sock.on("data", () => {
				sock.write(`${JSON.stringify({ decision: "allow" })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tmp, { recursive: true, force: true });
	});

	it("P1: completes a real request/response round-trip against the given path", async () => {
		const answer = await queryHarnessSocket(socketPath, EVENT, 2000);
		expect(answer).toEqual({ decision: "allow" });
	});

	it("P2: resolves null without ever connecting when the signal starts already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		// The server at `socketPath` is live and answers every connection with
		// {decision:"allow"} (see P1); if the pre-aborted guard were skipped the
		// promise would settle with that object instead of null.
		const answer = await queryHarnessSocket(socketPath, EVENT, 2000, controller.signal);
		expect(answer).toBeNull();
	});
});

describe("queryHarnessSocket — negative (must not fire)", () => {
	it("N1: resolves null without connecting when the socket file is absent", async () => {
		const answer = await queryHarnessSocket("/nonexistent/nowhere.sock", EVENT, 2000);
		expect(answer).toBeNull();
	});

	it("N3: aborting the signal settles null promptly, well before the timeout (review pass 16)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "il-qhs-abort-"));
		const socketPath = join(tmp, "silent.sock");
		const accepted: import("node:net").Socket[] = [];
		const server = createServer((sock) => {
			accepted.push(sock);
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const controller = new AbortController();
			const t0 = Date.now();
			const pending = queryHarnessSocket(socketPath, EVENT, 5000, controller.signal);
			setTimeout(() => controller.abort(), 50);
			await expect(pending).resolves.toBeNull();
			expect(Date.now() - t0).toBeLessThan(1000);
		} finally {
			for (const sock of accepted) sock.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("N2: resolves null (never hangs) when the server accepts but stays silent", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "il-qhs-silent-"));
		const socketPath = join(tmp, "silent.sock");
		// Track accepted sockets: `server.close()` waits for existing
		// connections, and the silent server's side of the probed connection can
		// linger past the client's destroy — the TEARDOWN hung, not the probe.
		const accepted = new Set<import("node:net").Socket>();
		const server = createServer((sock) => {
			accepted.add(sock);
			sock.on("close", () => accepted.delete(sock));
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const answer = await queryHarnessSocket(socketPath, EVENT, 200);
			expect(answer).toBeNull();
		} finally {
			for (const sock of accepted) sock.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
