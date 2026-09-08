import { wireLiteral } from "../lib/value-validation.js";
import { parseWire, wireArray, wireBoolean, wireNullable, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DaemonHealth,
	encodeFrame,
	type RpcError,
	type RpcEnvelope,
	decodeFrame,
} from "../harness/daemon-protocol.js";
import { nonNull } from "../lib/non-null.js";
import { daemonsCommand } from "./daemons.js";

const isCapturedDaemonHealth = wireObject({ "daemons": wireArray(wireObject({ "alive": wireBoolean, "health": wireNullable(wireObject({ "status": wireLiteral("ready", "warming", "degraded"), "uptime_ms": wireNumber, "warm_caches": wireArray(wireString), "tsgo_status": wireLiteral("ready", "starting", "unavailable"), "rpc_inflight": wireNumber, "protocol_version": wireLiteral("1") })), "health_error": wireNullable(wireString) })) });

let tmp = "";
// SPY, not process.chdir(): chdir THROWS in a worker thread ("process.chdir()
// is not supported in workers"), and Stryker's vitest runner pins its own
// pool, so a real chdir here fails the mutation dry run for any file whose
// graph-selected test scope includes this one. daemonsCommand reads
// `process.cwd()` explicitly, so the spy exercises the same path.
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
let server: Server | null = null;
// Track accepted connections so teardown can destroy them: `server.close()`
// resolves only after every open socket ends, and a client that timed out
// leaves its server-side peer open — without this the suite hangs in afterEach.
let connections: Socket[] = [];

/** Destroy any open server-side sockets, then close + null the server. */
async function closeServer(): Promise<void> {
	for (const c of connections) c.destroy();
	connections = [];
	if (server) {
		const s = server;
		server = null;
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
}

/** Listen on a Unix socket, registering each accepted connection for teardown. */
async function bindServer(
	socketPath: string,
	onConnection: (socket: Socket) => void,
): Promise<void> {
	await closeServer();
	const s = createServer((socket) => {
		connections.push(socket);
		onConnection(socket);
	});
	s.unref();
	server = s;
	await new Promise<void>((resolve, reject) => {
		s.once("error", reject);
		s.listen(socketPath, () => resolve());
	});
}

beforeEach(() => {
	connections = [];
	// Root under /tmp (not os.tmpdir()): on macOS os.tmpdir() lives under a deep
	// /private/var/folders/... path that pushes the bound Unix-socket path past
	// the ~104-char sun_path limit. /tmp keeps `.interlinked/harness-<id>.sock`
	// comfortably short.
	// `daemonsCommand` resolves `.interlinked/` from `process.cwd()`. Bind the
	// test's sockets against the canonical, symlink-resolved path (realpathSync,
	// matching what a real chdir would have given via process.cwd()'s own
	// /tmp -> /private/tmp resolution) so they live exactly where the command
	// dials.
	tmp = realpathSync(mkdtempSync("/tmp/ildm-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
});
afterEach(async () => {
	await closeServer();
	cwdSpy?.mockRestore();
	rmSync(tmp, { recursive: true, force: true });
});

function captureStdout(): { text: () => string; restore: () => void } {
	let captured = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((
		buf: string | Uint8Array,
	) => {
		captured += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	});
	return {
		text: () => captured,
		restore: () => spy.mockRestore(),
	};
}

/**
 * Stand up a real Unix-socket daemon at the path `daemonsCommand` will probe
 * for `sessionId` (under cwd's `.interlinked/`), responding to every request
 * with `responder(request)` framed exactly like the real daemon. Also writes a
 * live PID file (current process) so liveness detection treats it as alive.
 */
async function startFakeDaemon(
	sessionId: string,
	responder: (req: RpcEnvelope) => DaemonHealth | RpcError,
): Promise<void> {
	const base = join(tmp, ".interlinked");
	const socketPath = join(base, `harness-${sessionId}.sock`);
	writeFileSync(join(base, `harness-${sessionId}.pid`), String(process.pid));
	// bindServer closes any prior server first, so re-binding within one test
	// (e.g. probe twice) does not hit EADDRINUSE.
	await bindServer(socketPath, (socket) => {
		let pending = "";
		socket.on("data", (b: Buffer) => {
			pending += b.toString("utf-8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.length === 0) continue;
				const req = decodeFrame(line);
				const out = responder(req);
				const frame =
					"error" in out
						? encodeFrame({ id: req.id, error: out.error })
						: encodeFrame({ id: req.id, result: out });
				socket.write(frame);
			}
		});
	});
}

function readyHealth(): DaemonHealth {
	return {
		status: "ready",
		uptime_ms: 1234,
		warm_caches: ["index"],
		tsgo_status: "ready",
		rpc_inflight: 0,
		protocol_version: "1",
	};
}

describe("daemons command", () => {
	it("reports no daemons when .interlinked is empty", async () => {
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		expect(cap.text()).toContain("no daemons found");
	});

	it("lists a discovered daemon (dead process)", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-deadsess.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		const out = cap.text();
		expect(out).toContain("deadsess");
		expect(out).toContain("dead");
	});

	it("JSON output enumerates daemons", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-json1.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({ json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "daemons": wireArray(wireObject({ "session_id": wireString })) }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.daemons.length).toBe(1);
		expect(nonNull(payload.daemons[0]).session_id).toBe("json1");
	});

	it("JSON output marks a dead daemon with a health_error and no health", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-deadj.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({ json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "daemons": wireArray(wireObject({ "session_id": wireString, "alive": wireBoolean, "health": wireNullable(wireObject({ "status": wireLiteral("ready", "warming", "degraded"), "uptime_ms": wireNumber, "warm_caches": wireArray(wireString), "tsgo_status": wireLiteral("ready", "starting", "unavailable"), "rpc_inflight": wireNumber, "protocol_version": wireLiteral("1") })), "health_error": wireNullable(wireString) })) }), "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).alive).toBe(false);
		expect(nonNull(row).health).toBeNull();
		expect(nonNull(row).health_error).toBe("process not alive");
	});

	it("cleanup removes orphan PID files", async () => {
		const pidPath = join(tmp, ".interlinked", "harness-orphan.pid");
		writeFileSync(pidPath, "999999999");
		const cap = captureStdout();
		await daemonsCommand({ cleanup: true });
		cap.restore();
		expect(cap.text()).toContain("orphan");
		expect(existsSync(pidPath)).toBe(false);
	});

	it("cleanup lists every removed session id in human output", async () => {
		const p1 = join(tmp, ".interlinked", "harness-orphA.pid");
		const p2 = join(tmp, ".interlinked", "harness-orphB.pid");
		writeFileSync(p1, "999999999");
		writeFileSync(p2, "999999998");
		const cap = captureStdout();
		await daemonsCommand({ cleanup: true });
		cap.restore();
		const out = cap.text();
		expect(out).toContain("cleaned 2 orphan daemon(s)");
		expect(out).toContain("orphA");
		expect(out).toContain("orphB");
		expect(existsSync(p1)).toBe(false);
		expect(existsSync(p2)).toBe(false);
	});

	it("cleanup --json reports the cleaned session ids and leaves live daemons alone", async () => {
		const orphan = join(tmp, ".interlinked", "harness-gone.pid");
		const livePid = join(tmp, ".interlinked", "harness-here.pid");
		writeFileSync(orphan, "999999999");
		writeFileSync(livePid, String(process.pid));
		const cap = captureStdout();
		await daemonsCommand({ cleanup: true, json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "cleaned": wireArray(wireString) }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.cleaned).toEqual(["gone"]);
		// The orphan was removed; the live daemon's PID file survives.
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(livePid)).toBe(true);
	});

	it("cleanup --json with nothing to clean returns an empty cleaned list", async () => {
		const cap = captureStdout();
		await daemonsCommand({ cleanup: true, json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "ok": wireBoolean, "cleaned": wireArray(wireString) }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.cleaned).toEqual([]);
	});

	it("probes a live daemon and reports its reported health (human output)", async () => {
		await startFakeDaemon("livesess", () => readyHealth());
		const cap = captureStdout();
		await daemonsCommand({ healthTimeoutMs: 1000 });
		cap.restore();
		const out = cap.text();
		// Live + health present → status column shows the daemon-reported status,
		// TSGO column shows the reported tsgo_status (the non-default arms).
		expect(out).toContain("livesess");
		expect(out).toContain("ready");
		// PID column shows the live (current) pid, not a dash.
		expect(out).toContain(String(process.pid));
		expect(out).not.toContain("unreachable");
		expect(out).not.toContain("dead");
	});

	it("probes a live daemon and surfaces full health in JSON", async () => {
		await startFakeDaemon("livej", () => readyHealth());
		const cap = captureStdout();
		await daemonsCommand({ json: true, healthTimeoutMs: 1000 });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "daemons": wireArray(wireObject({ "session_id": wireString, "pid": wireNullable(wireNumber), "alive": wireBoolean, "health": wireNullable(wireObject({ "status": wireLiteral("ready", "warming", "degraded"), "uptime_ms": wireNumber, "warm_caches": wireArray(wireString), "tsgo_status": wireLiteral("ready", "starting", "unavailable"), "rpc_inflight": wireNumber, "protocol_version": wireLiteral("1") })), "health_error": wireNullable(wireString) })) }), "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).session_id).toBe("livej");
		expect(nonNull(row).alive).toBe(true);
		expect(nonNull(row).pid).toBe(process.pid);
		expect(nonNull(row).health_error).toBeNull();
		expect(nonNull(row).health).not.toBeNull();
		expect(nonNull(row).health?.status).toBe("ready");
		expect(nonNull(row).health?.tsgo_status).toBe("ready");
		expect(nonNull(row).health?.protocol_version).toBe("1");
	});

	it("renders a degraded daemon with a starting tsgo status (non-ready arms)", async () => {
		await startFakeDaemon("degr", () => ({
			status: "degraded",
			uptime_ms: 5,
			warm_caches: [],
			tsgo_status: "starting",
			rpc_inflight: 2,
			protocol_version: "1",
		}));
		const cap = captureStdout();
		await daemonsCommand({ healthTimeoutMs: 1000 });
		cap.restore();
		const out = cap.text();
		expect(out).toContain("degr");
		expect(out).toContain("degraded");
		expect(out).toContain("starting");
	});

	it("marks a live-but-erroring daemon as unreachable and carries the error message", async () => {
		await startFakeDaemon("errsess", (req) => ({
			id: req.id,
			error: { code: "internal", message: "boom-from-daemon", recoverable: true },
		}));
		const cap = captureStdout();
		await daemonsCommand({ json: true, healthTimeoutMs: 1000 });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), isCapturedDaemonHealth, "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).alive).toBe(true);
		expect(nonNull(row).health).toBeNull();
		expect(nonNull(row).health_error).toBe("boom-from-daemon");

		// And the human renderer shows "unreachable" for a live row without health.
		// Use a fresh session id so the rebind lands on a clean socket path.
		await startFakeDaemon("errhuman", (req) => ({
			id: req.id,
			error: { code: "internal", message: "boom-from-daemon", recoverable: true },
		}));
		const cap2 = captureStdout();
		await daemonsCommand({ healthTimeoutMs: 1000 });
		cap2.restore();
		const out = cap2.text();
		expect(out).toContain("errhuman");
		expect(out).toContain("unreachable");
		// No row in this render carries health, so the TSGO column never shows a
		// real tsgo status — it falls back to "-" for every row.
		expect(out).not.toMatch(/\bready\b/);
		expect(out).not.toMatch(/\bstarting\b/);
	});

	it("falls back to 'unknown' when the daemon returns an error with an empty message", async () => {
		await startFakeDaemon("emptyerr", (req) => ({
			id: req.id,
			error: { code: "internal", message: "", recoverable: true },
		}));
		const cap = captureStdout();
		await daemonsCommand({ json: true, healthTimeoutMs: 1000 });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "daemons": wireArray(wireObject({ "health": wireNullable(wireObject({ "status": wireLiteral("ready", "warming", "degraded"), "uptime_ms": wireNumber, "warm_caches": wireArray(wireString), "tsgo_status": wireLiteral("ready", "starting", "unavailable"), "rpc_inflight": wireNumber, "protocol_version": wireLiteral("1") })), "health_error": wireNullable(wireString) })) }), "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).health).toBeNull();
		// Empty error message → `err || "unknown"` fallback.
		expect(nonNull(row).health_error).toBe("unknown");
	});

	it("reports a live daemon as unreachable when the health RPC times out", async () => {
		// Bind a socket that accepts the connection but never replies, forcing
		// the client `.call` to reject with a timeout → live row, no health.
		const base = join(tmp, ".interlinked");
		const socketPath = join(base, "harness-silent.sock");
		writeFileSync(join(base, "harness-silent.pid"), String(process.pid));
		await bindServer(socketPath, () => {
			/* accept and hang — never write a response frame */
		});

		const cap = captureStdout();
		await daemonsCommand({ json: true, healthTimeoutMs: 60 });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), isCapturedDaemonHealth, "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).alive).toBe(true);
		expect(nonNull(row).health).toBeNull();
		expect(nonNull(row).health_error).toBe("timeout");
	});

	it("uses the default 500ms health timeout when none is supplied", async () => {
		// A dead daemon never reaches the timeout path, so this exercises the
		// `healthTimeoutMs ?? 500` default branch without waiting on a socket.
		writeFileSync(join(tmp, ".interlinked", "harness-defto.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		expect(cap.text()).toContain("defto");
	});

	it("renders a dash in the PID column when the PID file is unparseable", async () => {
		// A non-numeric PID file makes readPidFile return null → the row has a
		// null pid, exercising the `r.pid?.toString() ?? "-"` fallback arm.
		writeFileSync(join(tmp, ".interlinked", "harness-nopid.pid"), "not-a-number\n");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		const out = cap.text();
		expect(out).toContain("nopid");
		// A null pid is dead, so the row shows "dead" status…
		expect(out).toContain("dead");
		// …and the PID column shows the dash fallback. The session id is short
		// (5 chars) so it is padded to 22; the PID column then begins with "-".
		expect(out).toMatch(/nopid\s+-\s+dead/);
	});

	it("reports a null pid as null in JSON for an unparseable PID file", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-nopidj.pid"), "");
		const cap = captureStdout();
		await daemonsCommand({ json: true });
		cap.restore();
		const payload = parseWire(JSON.parse(cap.text()), wireObject({ "daemons": wireArray(wireObject({ "session_id": wireString, "pid": wireNullable(wireNumber), "alive": wireBoolean })) }), "test JSON value");
		const row = payload.daemons[0];
		expect(nonNull(row).session_id).toBe("nopidj");
		expect(nonNull(row).pid).toBeNull();
		expect(nonNull(row).alive).toBe(false);
	});

	it("pads a session id at or beyond the column width with a single trailing space", async () => {
		// SESSION column is 22 wide; a >=22-char id hits the `s.length >= n`
		// branch in pad(), which appends exactly one space rather than padding.
		const longId = "session-name-of-thirty-three-chars";
		expect(longId.length).toBeGreaterThanOrEqual(22);
		writeFileSync(join(tmp, ".interlinked", `harness-${longId}.pid`), "999999999");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		const out = cap.text();
		expect(out).toContain(longId);
		// The over-width id is followed by exactly one space, then the PID column.
		expect(out).toContain(`${longId} `);
		expect(out).not.toContain(`${longId}  `);
	});

	it("renders the table header before any rows", async () => {
		writeFileSync(join(tmp, ".interlinked", "harness-hdr.pid"), "999999999");
		const cap = captureStdout();
		await daemonsCommand({});
		cap.restore();
		const out = cap.text();
		expect(out).toContain("SESSION");
		expect(out).toContain("PID");
		expect(out).toContain("STATUS");
		expect(out).toContain("TSGO");
		expect(out).toContain("SOCKET");
		// Header precedes the data row.
		expect(out.indexOf("SESSION")).toBeLessThan(out.indexOf("hdr"));
	});
});
