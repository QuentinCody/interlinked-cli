// Behavioral coverage for the `interlinked harness status` IO/formatting
// helpers. Every export and every branch is exercised here.
//
// Mocking strategy:
//  - node:child_process (execSync) is mocked so `readRssMb` is deterministic
//    and never shells out to the real `ps`.
//  - ../harness/daemon-client.js is mocked so `readFramedSocketStatuses`
//    drives both the health-success and health-error branches without a live
//    daemon. `discoverDaemons` itself stays REAL — it is driven by real
//    pid/socket files written into a temp `.interlinked/` directory.
//  - Pure file readers use real temp dirs. `getConfigDir` honors the
//    `INTERLINKED_HOME` env var, so each test points it at a fresh dir and
//    writes real fixture files (config.json, harness-protocol.json,
//    logs/latency.jsonl).
//  - queryHarness is exercised against a REAL `node:net` unix socket server
//    (and against an absent socket path) — no network mocking.

import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../harness/daemon-client.js";
import { getFramedSocketPath, getSocketPath } from "./harness-process.js";
import {
	expectedSocketPaths,
	getProtocolStatusPath,
	type HarnessProtocolStatus,
	parseHarnessProtocol,
	queryHarness,
	readActiveMode,
	readFramedSocketStatuses,
	readLastLatencyTimestamp,
	readProtocolStatus,
	readRssMb,
} from "./harness-status-helpers.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));
vi.mock("../harness/daemon-client.js", () => ({
	createDaemonClient: vi.fn(),
}));

const execSyncMock = vi.mocked(execSync);
const createDaemonClientMock = vi.mocked(createDaemonClient);

let tmp = "";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-statushelpers-"));
	// Point every getConfigDir() consumer at this temp dir.
	process.env.INTERLINKED_HOME = tmp;
	vi.clearAllMocks();
});

afterEach(() => {
	process.env.INTERLINKED_HOME = undefined;
	delete process.env.INTERLINKED_HOME;
	rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getProtocolStatusPath
// ---------------------------------------------------------------------------

describe("getProtocolStatusPath", () => {
	it("joins the config dir with harness-protocol.json", () => {
		expect(getProtocolStatusPath(tmp)).toBe(join(tmp, "harness-protocol.json"));
	});

	it("defaults cwd to process.cwd() when omitted (env home wins)", () => {
		// INTERLINKED_HOME short-circuits getConfigDir, so the path is the
		// env home regardless of the (defaulted) cwd argument.
		expect(getProtocolStatusPath()).toBe(join(tmp, "harness-protocol.json"));
	});
});

// ---------------------------------------------------------------------------
// parseHarnessProtocol — every literal branch + the default fallback
// ---------------------------------------------------------------------------

describe("parseHarnessProtocol", () => {
	it("returns 'raw' verbatim", () => {
		expect(parseHarnessProtocol("raw")).toBe("raw");
	});
	it("returns 'framed' verbatim", () => {
		expect(parseHarnessProtocol("framed")).toBe("framed");
	});
	it("returns 'dual' verbatim", () => {
		expect(parseHarnessProtocol("dual")).toBe("dual");
	});
	it("falls back to 'dual' for an unrecognized string", () => {
		expect(parseHarnessProtocol("nonsense")).toBe("dual");
	});
	it("falls back to 'dual' for undefined", () => {
		expect(parseHarnessProtocol(undefined)).toBe("dual");
	});
});

// ---------------------------------------------------------------------------
// expectedSocketPaths — the three protocol branches
// ---------------------------------------------------------------------------

describe("expectedSocketPaths", () => {
	it("returns only the raw socket for protocol 'raw'", () => {
		const paths = expectedSocketPaths(tmp, "raw", "sess-1");
		expect(paths).toEqual([getSocketPath(tmp)]);
	});

	it("returns only the framed socket for protocol 'framed'", () => {
		const paths = expectedSocketPaths(tmp, "framed", "sess-2");
		expect(paths).toEqual([getFramedSocketPath(tmp, "sess-2")]);
	});

	it("returns both sockets for protocol 'dual'", () => {
		const paths = expectedSocketPaths(tmp, "dual", "sess-3");
		expect(paths).toEqual([getSocketPath(tmp), getFramedSocketPath(tmp, "sess-3")]);
		expect(paths).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// readRssMb — execSync mocked
// ---------------------------------------------------------------------------

describe("readRssMb", () => {
	it("converts kilobytes to rounded megabytes", () => {
		// 2048 KB / 1024 = 2 MB exactly.
		execSyncMock.mockReturnValue("  2048\n");
		expect(readRssMb(4321)).toBe(2);
		// Confirms the pid was interpolated into the ps invocation.
		expect(execSyncMock.mock.calls[0]?.[0]).toContain("-p 4321");
	});

	it("rounds to the nearest megabyte (1536 KB -> 2 MB)", () => {
		execSyncMock.mockReturnValue("1536");
		expect(readRssMb(1)).toBe(2);
	});

	it("rounds down when below the half-MB boundary (1500 KB -> 1 MB)", () => {
		execSyncMock.mockReturnValue("1500");
		expect(readRssMb(1)).toBe(1);
	});

	it("returns null when ps output is not a number", () => {
		execSyncMock.mockReturnValue("not-a-number");
		expect(readRssMb(1)).toBeNull();
	});

	it("returns null when ps output is empty", () => {
		execSyncMock.mockReturnValue("");
		expect(readRssMb(1)).toBeNull();
	});

	it("returns null when execSync throws", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("ps failed");
		});
		expect(readRssMb(99999)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readActiveMode
// ---------------------------------------------------------------------------

describe("readActiveMode", () => {
	it("returns the string mode from config.json", () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify({ mode: "team" }));
		expect(readActiveMode(tmp)).toBe("team");
	});

	it("returns null when config.json is missing", () => {
		expect(readActiveMode(tmp)).toBeNull();
	});

	it("returns null when mode is not a string", () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify({ mode: 42 }));
		expect(readActiveMode(tmp)).toBeNull();
	});

	it("returns null when mode key is absent", () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify({ other: "x" }));
		expect(readActiveMode(tmp)).toBeNull();
	});

	it("returns null when config.json is malformed JSON (catch branch)", () => {
		writeFileSync(join(tmp, "config.json"), "{ not json ");
		expect(readActiveMode(tmp)).toBeNull();
	});

	// parseActiveMode boundary parser (internal): the value must be a JSON
	// object before its `mode` field is read at all.
	it("P1: accepts an object whose mode field is a string", () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify({ mode: "solo" }));
		expect(readActiveMode(tmp)).toBe("solo");
	});

	it("N1: rejects a non-object top-level value (JSON array)", () => {
		writeFileSync(join(tmp, "config.json"), JSON.stringify(["not", "an", "object"]));
		expect(readActiveMode(tmp)).toBeNull();
	});

	it("N2: rejects a bare JSON null top-level value", () => {
		writeFileSync(join(tmp, "config.json"), "null");
		expect(readActiveMode(tmp)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readProtocolStatus — full-field, default-field, reject, missing, catch
// ---------------------------------------------------------------------------

describe("readProtocolStatus", () => {
	const writeStatus = (obj: unknown): void => {
		writeFileSync(getProtocolStatusPath(tmp), JSON.stringify(obj));
	};

	it("returns null when the file is missing", () => {
		expect(readProtocolStatus(tmp)).toBeNull();
	});

	it("returns null when protocol is not a recognized literal", () => {
		writeStatus({ protocol: "bogus" });
		expect(readProtocolStatus(tmp)).toBeNull();
	});

	it("returns null on malformed JSON (catch branch)", () => {
		writeFileSync(getProtocolStatusPath(tmp), "}{ broken");
		expect(readProtocolStatus(tmp)).toBeNull();
	});

	it("maps every field when all are present and correctly typed", () => {
		const full: HarnessProtocolStatus = {
			protocol: "dual",
			protocol_version: "1.2.3",
			started_at: "2026-06-06T00:00:00Z",
			raw_socket_path: "/tmp/raw.sock",
			framed_socket_path: "/tmp/framed.sock",
			framed_session_id: "abc",
			last_raw_event_at: "2026-06-06T01:00:00Z",
			last_framed_event_at: "2026-06-06T02:00:00Z",
			raw_event_count: 10,
			framed_event_count: 20,
			framed_error_count: 3,
			framed_timeout_count: 4,
		};
		writeStatus(full);
		expect(readProtocolStatus(tmp)).toEqual(full);
	});

	it("applies every default when optional fields are missing/mistyped", () => {
		// Only the required (valid) protocol is present; every other field is
		// either absent or the wrong type, exercising the right-hand side of
		// each ternary.
		writeStatus({
			protocol: "raw",
			protocol_version: 99, // wrong type -> "unknown"
			started_at: null, // wrong type -> ""
			raw_socket_path: 5, // wrong type -> null
			framed_socket_path: false, // wrong type -> null
			framed_session_id: {}, // wrong type -> null
			last_raw_event_at: 1, // wrong type -> null
			last_framed_event_at: [], // wrong type -> null
			raw_event_count: "x", // wrong type -> 0
			framed_event_count: null, // wrong type -> 0
			framed_error_count: "y", // wrong type -> 0
			framed_timeout_count: undefined, // wrong type -> 0
		});
		expect(readProtocolStatus(tmp)).toEqual({
			protocol: "raw",
			protocol_version: "unknown",
			started_at: "",
			raw_socket_path: null,
			framed_socket_path: null,
			framed_session_id: null,
			last_raw_event_at: null,
			last_framed_event_at: null,
			raw_event_count: 0,
			framed_event_count: 0,
			framed_error_count: 0,
			framed_timeout_count: 0,
		});
	});

	it("accepts 'framed' as a valid protocol literal", () => {
		writeStatus({ protocol: "framed" });
		expect(readProtocolStatus(tmp)?.protocol).toBe("framed");
	});

	// parseHarnessProtocolStatus boundary parser (internal): the value must be
	// a JSON object before `protocol` (or any other field) is read at all —
	// the malformed-JSON case above never reaches this guard since JSON.parse
	// itself throws first.
	it("N4: rejects a non-object top-level value (JSON array)", () => {
		writeFileSync(getProtocolStatusPath(tmp), JSON.stringify([1, 2, 3]));
		expect(readProtocolStatus(tmp)).toBeNull();
	});

	it("N5: rejects a bare JSON null top-level value", () => {
		writeFileSync(getProtocolStatusPath(tmp), "null");
		expect(readProtocolStatus(tmp)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// readLastLatencyTimestamp — missing, tail-scan, skip-corrupt, all-corrupt
// ---------------------------------------------------------------------------

describe("readLastLatencyTimestamp", () => {
	const latencyPath = (): string => join(tmp, "logs", "latency.jsonl");
	const writeLatency = (content: string): void => {
		mkdirSync(join(tmp, "logs"), { recursive: true });
		writeFileSync(latencyPath(), content);
	};

	it("returns null when the latency log is missing", () => {
		expect(readLastLatencyTimestamp(tmp)).toBeNull();
	});

	it("returns the ts of the last valid record", () => {
		writeLatency(
			`${JSON.stringify({ ts: "2026-06-06T00:00:00Z" })}\n${JSON.stringify({ ts: "2026-06-06T05:00:00Z" })}\n`,
		);
		expect(readLastLatencyTimestamp(tmp)).toBe("2026-06-06T05:00:00Z");
	});

	it("scans back-to-front, skipping trailing corrupt lines (catch branch)", () => {
		writeLatency(
			`${JSON.stringify({ ts: "2026-06-06T09:00:00Z" })}\n{ broken json\nalso-bad\n`,
		);
		expect(readLastLatencyTimestamp(tmp)).toBe("2026-06-06T09:00:00Z");
	});

	it("skips records whose ts is not a string, returning an earlier valid ts", () => {
		writeLatency(
			`${JSON.stringify({ ts: "2026-06-06T03:00:00Z" })}\n${JSON.stringify({ ts: 12345 })}\n`,
		);
		expect(readLastLatencyTimestamp(tmp)).toBe("2026-06-06T03:00:00Z");
	});

	it("returns null when no line contains a string ts", () => {
		writeLatency(`${JSON.stringify({ ts: 1 })}\n${JSON.stringify({ nope: true })}\n`);
		expect(readLastLatencyTimestamp(tmp)).toBeNull();
	});

	it("returns null when the file is empty (only blank lines filtered out)", () => {
		writeLatency("\n   \n\n");
		expect(readLastLatencyTimestamp(tmp)).toBeNull();
	});

	it("only reads the trailing window, ignoring an old record before the tail", () => {
		// A valid record far past the 8 KiB tail must NOT be returned; padding
		// after it (with no valid ts) pushes it out of the read window.
		const oldRecord = `${JSON.stringify({ ts: "1999-01-01T00:00:00Z" })}\n`;
		const filler = `${JSON.stringify({ junk: "x".repeat(200) })}\n`.repeat(60);
		writeLatency(oldRecord + filler);
		expect(readLastLatencyTimestamp(tmp)).toBeNull();
	});

	it("returns null on a read failure (catch branch — path is a directory)", () => {
		// Create logs/latency.jsonl as a DIRECTORY so existsSync passes but
		// readFileSync throws EISDIR, hitting the outer catch.
		mkdirSync(join(tmp, "logs", "latency.jsonl"), { recursive: true });
		expect(readLastLatencyTimestamp(tmp)).toBeNull();
	});

	// parseLatencyRecordTs boundary parser (internal): a syntactically valid
	// JSON line whose top-level value isn't an object must be skipped like any
	// other line with no usable ts, not treated as a parse failure.
	it("P1: accepts a record whose ts is a string, ignoring unrelated extra fields", () => {
		writeLatency(
			`${JSON.stringify({ ts: "2026-06-06T06:00:00Z", extra: { nested: true } })}\n`,
		);
		expect(readLastLatencyTimestamp(tmp)).toBe("2026-06-06T06:00:00Z");
	});

	it("N3: skips a syntactically valid but non-object line (JSON array), finding an earlier valid ts", () => {
		writeLatency(
			`${JSON.stringify({ ts: "2026-06-06T04:00:00Z" })}\n${JSON.stringify([1, 2, 3])}\n`,
		);
		expect(readLastLatencyTimestamp(tmp)).toBe("2026-06-06T04:00:00Z");
	});
});

// ---------------------------------------------------------------------------
// readFramedSocketStatuses — filter, dead, alive+health, alive+error
// ---------------------------------------------------------------------------

describe("readFramedSocketStatuses", () => {
	// discoverDaemons walks <cwd>/.interlinked directly (NOT INTERLINKED_HOME),
	// so we write real pid/socket fixtures into the temp dir's .interlinked.
	const interlinkedDir = (): string => join(tmp, ".interlinked");

	const writeDaemonFixture = (
		filenameStem: string,
		pid: number | null,
	): void => {
		mkdirSync(interlinkedDir(), { recursive: true });
		if (pid !== null) {
			writeFileSync(join(interlinkedDir(), `${filenameStem}.pid`), String(pid));
		}
		// Touch the socket file so the path exists (content irrelevant).
		writeFileSync(join(interlinkedDir(), `${filenameStem}.sock`), "");
	};

	it("filters out the default 'harness.sock' daemon entirely", async () => {
		// Only a default daemon present -> nothing framed -> empty result.
		writeDaemonFixture("harness", process.pid);
		const result = await readFramedSocketStatuses(tmp);
		expect(result).toEqual([]);
		// daemon-client must never be consulted when there's nothing framed.
		expect(createDaemonClientMock).not.toHaveBeenCalled();
	});

	it("returns an empty array when there are no daemons at all", async () => {
		// .interlinked dir does not exist -> discoverDaemons returns [].
		expect(await readFramedSocketStatuses(tmp)).toEqual([]);
	});

	it("reports 'process not alive' for a dead framed daemon without querying health", async () => {
		// PID 1 is init; signal-0 against it from a normal user throws EPERM,
		// which isProcessAlive treats as alive. To force a guaranteed-dead
		// process we pick a very high pid that does not exist (ESRCH -> dead).
		writeDaemonFixture("harness-deadsess", 2_147_483_646);
		const result = await readFramedSocketStatuses(tmp);
		expect(result).toHaveLength(1);
		const entry = result[0];
		expect(entry?.session_id).toBe("deadsess");
		expect(entry?.alive).toBe(false);
		expect(entry?.health).toBeNull();
		expect(entry?.health_error).toBe("process not alive");
		expect(entry?.socket_path).toBe(join(interlinkedDir(), "harness-deadsess.sock"));
		expect(createDaemonClientMock).not.toHaveBeenCalled();
	});

	it("returns health for an alive framed daemon (success branch)", async () => {
		const health = {
			status: "ready",
			protocol_version: "1",
			pid: process.pid,
		} as unknown as Awaited<ReturnType<ReturnType<typeof createDaemonClient>["call"]>>;
		const callMock = vi.fn().mockResolvedValue(health);
		createDaemonClientMock.mockReturnValue({ call: callMock });

		// process.pid is the live test runner -> isProcessAlive returns true.
		writeDaemonFixture("harness-livesess", process.pid);
		const result = await readFramedSocketStatuses(tmp);

		expect(result).toHaveLength(1);
		const entry = result[0];
		expect(entry?.session_id).toBe("livesess");
		expect(entry?.alive).toBe(true);
		expect(entry?.health).toBe(health);
		expect(entry?.health_error).toBeNull();
		// daemon-client bound to the framed socket; health called with timeout.
		expect(createDaemonClientMock).toHaveBeenCalledWith(
			join(interlinkedDir(), "harness-livesess.sock"),
		);
		expect(callMock).toHaveBeenCalledWith("daemon.health", {}, { timeout_ms: 500 });
	});

	it("captures an Error message when the health call rejects (alive + error branch)", async () => {
		const callMock = vi.fn().mockRejectedValue(new Error("connection refused"));
		createDaemonClientMock.mockReturnValue({ call: callMock });

		writeDaemonFixture("harness-errsess", process.pid);
		const result = await readFramedSocketStatuses(tmp);

		const entry = result[0];
		expect(entry?.alive).toBe(true);
		expect(entry?.health).toBeNull();
		expect(entry?.health_error).toBe("connection refused");
	});

	it("stringifies a non-Error rejection value (String(err) branch)", async () => {
		const callMock = vi.fn().mockRejectedValue("plain string failure");
		createDaemonClientMock.mockReturnValue({ call: callMock });

		writeDaemonFixture("harness-strerr", process.pid);
		const result = await readFramedSocketStatuses(tmp);

		expect(result[0]?.health_error).toBe("plain string failure");
		expect(result[0]?.health).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// queryHarness — real unix-socket server + absent/error/close paths
// ---------------------------------------------------------------------------

describe("queryHarness", () => {
	let server: Server | null = null;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = null;
		}
	});

	const socketPath = (): string => getSocketPath(tmp);

	const startServer = (
		onConn: (conn: import("node:net").Socket) => void,
	): Promise<void> => {
		mkdirSync(tmp, { recursive: true });
		server = createServer(onConn);
		return new Promise<void>((resolve) => server?.listen(socketPath(), resolve));
	};

	it("resolves null immediately when the socket file does not exist", async () => {
		// No server started -> getSocketPath does not exist.
		expect(await queryHarness(tmp, { hook_event: "x" })).toBeNull();
	});

	it("sends the event and resolves the parsed newline-delimited response", async () => {
		let received = "";
		await startServer((conn) => {
			conn.on("data", (chunk) => {
				received += chunk.toString();
				// Reply with a newline-terminated JSON frame.
				conn.write(`${JSON.stringify({ decision: "allow", echoed: true })}\n`);
			});
		});

		const result = await queryHarness(tmp, { hook_event: "PreToolUse", n: 7 });
		expect(result).toEqual({ decision: "allow", echoed: true });
		// The exact event payload was written to the socket with a trailing \n.
		expect(received).toBe(`${JSON.stringify({ hook_event: "PreToolUse", n: 7 })}\n`);
	});

	it("resolves null when the newline-framed response is invalid JSON", async () => {
		await startServer((conn) => {
			conn.on("data", () => {
				conn.write("this is not json\n");
			});
		});
		expect(await queryHarness(tmp, { hook_event: "x" })).toBeNull();
	});

	it("parses a response delivered only on socket close (no newline) — close branch", async () => {
		await startServer((conn) => {
			conn.on("data", () => {
				// Write a complete JSON object but NO newline, then close so the
				// 'data' newline path can't fire and the 'close' handler parses.
				conn.write(JSON.stringify({ decision: "block", via: "close" }));
				conn.end();
			});
		});
		expect(await queryHarness(tmp, { hook_event: "x" })).toEqual({
			decision: "block",
			via: "close",
		});
	});

	it("resolves null when the close-delivered payload is invalid JSON (close catch)", async () => {
		await startServer((conn) => {
			conn.on("data", () => {
				conn.write("partial-not-json");
				conn.end();
			});
		});
		expect(await queryHarness(tmp, { hook_event: "x" })).toBeNull();
	});

	it("resolves null when the connection closes with no data at all (close else branch)", async () => {
		await startServer((conn) => {
			conn.on("data", () => {
				// Close without writing anything -> data stays empty -> null.
				conn.end();
			});
		});
		expect(await queryHarness(tmp, { hook_event: "x" })).toBeNull();
	});

	it("resolves null when the socket path exists but is not a listening socket (error branch)", async () => {
		// Create a plain file at the socket path: existsSync passes, but
		// connect() fails with ECONNREFUSED/ENOTSOCK -> the 'error' handler runs.
		mkdirSync(tmp, { recursive: true });
		writeFileSync(socketPath(), "");
		expect(await queryHarness(tmp, { hook_event: "x" })).toBeNull();
	});

	it("resolves null after the 2s deadline when the server connects but never replies (timeout branch)", async () => {
		// Accept the connection but never write and never close. Neither the
		// 'data' nor 'close' paths can fire, so the 2000ms setTimeout is the
		// only thing that can settle the promise: it destroys the socket and
		// resolves null. This is the in-band timeout guard.
		const openConns: import("node:net").Socket[] = [];
		await startServer((conn) => {
			openConns.push(conn);
			// Deliberately do nothing: hold the connection open and silent.
		});
		const result = await queryHarness(tmp, { hook_event: "x" });
		expect(result).toBeNull();
		// Tidy the held connection so server.close() can complete in afterEach.
		for (const conn of openConns) conn.destroy();
	}, 10_000);
});
