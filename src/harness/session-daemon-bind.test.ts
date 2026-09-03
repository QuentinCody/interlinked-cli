// Companion tests for the session-daemon socket-bind cluster extracted from
// session-daemon.ts. They cover the three behaviours the retry loop owes its
// caller: a plain bind, a stale-socket recovery, and a live incumbent that must
// never be stomped.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BIND_ATTEMPTS,
	BIND_BACKOFF_MS,
	bindSessionSocket,
	sessionSocketState,
} from "./session-daemon-bind.js";

vi.mock("./session-paths.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./session-paths.js")>();
	return { ...actual, classifyDaemonSocket: vi.fn(actual.classifyDaemonSocket) };
});

const { classifyDaemonSocket } = await import("./session-paths.js");

let temp = "";
const opened: Socket[] = [];

afterEach(() => {
	for (const socket of opened.splice(0)) socket.destroy();
	if (temp !== "") rmSync(temp, { recursive: true, force: true });
	temp = "";
	vi.mocked(classifyDaemonSocket).mockReset();
});

function tempSocketPath(): string {
	temp = mkdtempSync(join(tmpdir(), "session-daemon-bind-"));
	return join(temp, "s.sock");
}

describe("bind constants", () => {
	it("allows three attempts with two backoff steps between them", () => {
		expect(BIND_ATTEMPTS).toBe(3);
		expect(BIND_BACKOFF_MS).toEqual([50, 150]);
		expect(BIND_BACKOFF_MS.length).toBe(BIND_ATTEMPTS - 1);
	});
});

describe("bindSessionSocket", () => {
	it("binds a fresh path and routes connections to onConnection", async () => {
		const socketPath = tempSocketPath();
		const seen: Socket[] = [];
		const server = await bindSessionSocket({
			socketPath,
			onConnection: (socket) => seen.push(socket),
		});
		expect(server.listening).toBe(true);
		const client = createConnection(socketPath);
		opened.push(client);
		// Poll for the accepted connection with a generous ceiling: the timeout
		// bounds only the failure path, so a loaded box does not flake here.
		const deadline = Date.now() + 5_000;
		while (seen.length === 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 10);
			});
		}
		expect(seen.length).toBe(1);
		// `server.close()` waits for live connections, so drop both ends first.
		client.destroy();
		for (const accepted of seen) accepted.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("removes a stale socket file that answers nothing and retries", async () => {
		const socketPath = tempSocketPath();
		writeFileSync(socketPath, "");
		const sleep = vi.fn(async () => undefined);
		const server = await bindSessionSocket({
			socketPath,
			onConnection: () => undefined,
			sleep,
			isServing: async () => false,
		});
		expect(server.listening).toBe(true);
		expect(sleep).toHaveBeenCalledWith(BIND_BACKOFF_MS[0]);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("never unlinks a socket a live incumbent is serving", async () => {
		const socketPath = tempSocketPath();
		const incumbent = await bindSessionSocket({
			socketPath,
			onConnection: () => undefined,
		});
		await expect(
			bindSessionSocket({
				socketPath,
				onConnection: () => undefined,
				sleep: async () => undefined,
				isServing: async () => true,
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
		expect(existsSync(socketPath)).toBe(true);
		await new Promise<void>((resolve) => incumbent.close(() => resolve()));
	});

	it("spends its last attempt without probing or sleeping again", async () => {
		const socketPath = tempSocketPath();
		const incumbent = await bindSessionSocket({
			socketPath,
			onConnection: () => undefined,
		});
		const sleep = vi.fn(async () => undefined);
		const isServing = vi.fn(async () => false);
		await expect(
			bindSessionSocket({
				socketPath,
				onConnection: () => undefined,
				attempts: 1,
				sleep,
				isServing,
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
		expect(sleep).not.toHaveBeenCalled();
		expect(isServing).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => incumbent.close(() => resolve()));
	});
});

describe("sessionSocketState", () => {
	it("re-probes exactly once when the first probe reports occupied_unready", async () => {
		vi.mocked(classifyDaemonSocket)
			.mockResolvedValueOnce("occupied_unready")
			.mockResolvedValueOnce("ready");
		await expect(sessionSocketState("/nowhere/x.sock")).resolves.toBe("ready");
		expect(classifyDaemonSocket).toHaveBeenCalledTimes(2);
	});

	it("returns a settled first probe without re-probing", async () => {
		vi.mocked(classifyDaemonSocket).mockResolvedValueOnce("absent");
		await expect(sessionSocketState("/nowhere/x.sock")).resolves.toBe("absent");
		expect(classifyDaemonSocket).toHaveBeenCalledTimes(1);
	});
});
