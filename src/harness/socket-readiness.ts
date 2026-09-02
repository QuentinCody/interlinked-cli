// ===========================================
// Harness socket protocol readiness
// ===========================================
// A successful Unix connect proves only that something owns the pathname. A
// start may report success only after the expected Interlinked protocol answers.

import { createConnection } from "node:net";
import { createDaemonClient } from "./daemon-client.js";
import { type DaemonHealth, PROTOCOL_VERSION } from "./daemon-protocol.js";

type HarnessSocketProtocol = "raw" | "framed";
export type HarnessSocketState = "ready" | "absent" | "occupied_unready";

interface HarnessSocketReadinessOptions {
	timeout_ms?: number;
}

type SocketPresence = "accepted" | "absent" | "ambiguous";

function probeSocketPresence(socketPath: string, timeoutMs: number): Promise<SocketPresence> {
	return new Promise((resolve) => {
		let settled = false;
		let socket: ReturnType<typeof createConnection> | null = null;
		const finish = (result: SocketPresence): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish("ambiguous"), timeoutMs);
		try {
			socket = createConnection(socketPath, () => finish("accepted"));
		} catch {
			finish("ambiguous");
			return;
		}
		socket.on("error", (err: NodeJS.ErrnoException) => {
			const absent = err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "ENOTSOCK";
			finish(absent ? "absent" : "ambiguous");
		});
	});
}

export function isRawStatusDecision(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const decision = Reflect.get(value, "decision");
	return decision === "allow" || decision === "block" || decision === "ask";
}

type DaemonHealthStatus = DaemonHealth["status"];
type DaemonHealthTsgoStatus = DaemonHealth["tsgo_status"];

function readHealthStatus(value: object): DaemonHealthStatus | null {
	const status = Reflect.get(value, "status");
	if (status !== "ready" && status !== "warming" && status !== "degraded") return null;
	return status;
}

function readHealthTsgoStatus(value: object): DaemonHealthTsgoStatus | null {
	const tsgoStatus = Reflect.get(value, "tsgo_status");
	if (tsgoStatus !== "ready" && tsgoStatus !== "starting" && tsgoStatus !== "unavailable") {
		return null;
	}
	return tsgoStatus;
}

function readNonNegativeInt(value: object, key: string): number | null {
	const n = Reflect.get(value, key);
	if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
	return n;
}

function readWarmCaches(value: object): string[] | null {
	const warmCaches = Reflect.get(value, "warm_caches");
	if (!Array.isArray(warmCaches) || !warmCaches.every((entry) => typeof entry === "string")) {
		return null;
	}
	return warmCaches;
}

/** Parse the complete daemon.health contract. Readiness, diagnostics, and
 * startup arbitration must not each accept a different subset of the wire. */
export function parseDaemonHealth(value: unknown): DaemonHealth | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const status = readHealthStatus(value);
	if (status === null) return null;
	const tsgoStatus = readHealthTsgoStatus(value);
	if (tsgoStatus === null) return null;
	const uptimeMs = readNonNegativeInt(value, "uptime_ms");
	if (uptimeMs === null) return null;
	const rpcInflight = readNonNegativeInt(value, "rpc_inflight");
	if (rpcInflight === null) return null;
	const warmCaches = readWarmCaches(value);
	if (warmCaches === null) return null;
	if (Reflect.get(value, "protocol_version") !== PROTOCOL_VERSION) return null;
	return {
		status,
		uptime_ms: uptimeMs,
		warm_caches: warmCaches,
		tsgo_status: tsgoStatus,
		rpc_inflight: rpcInflight,
		protocol_version: PROTOCOL_VERSION,
	};
}

function probeRawReadiness(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let data = "";
		let socket: ReturnType<typeof createConnection> | null = null;
		const finish = (ready: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			resolve(ready);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		try {
			socket = createConnection(socketPath, () => {
				socket?.write(
					`${JSON.stringify({
						hook_event: "StatusQuery",
						session_id: "startup-readiness",
						agent_source: "interlinked-cli",
						timestamp: new Date().toISOString(),
					})}\n`,
				);
			});
		} catch {
			finish(false);
			return;
		}
		socket.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(isRawStatusDecision(JSON.parse(data.slice(0, newline))));
			} catch {
				finish(false);
			}
		});
		socket.on("error", () => finish(false));
		socket.on("close", () => finish(false));
	});
}

async function probeFramedReadiness(socketPath: string, timeoutMs: number): Promise<boolean> {
	try {
		const health = await createDaemonClient(socketPath).call("daemon.health", {}, {
			timeout_ms: timeoutMs,
		});
		return parseDaemonHealth(health) !== null;
	} catch {
		return false;
	}
}

/** True only after a valid protocol response, never merely on connect(). */
export function isHarnessSocketReady(args: {
	socketPath: string;
	protocol: HarnessSocketProtocol;
	opts?: HarnessSocketReadinessOptions;
}): Promise<boolean> {
	const { socketPath, protocol, opts = {} } = args;
	const timeoutMs = opts.timeout_ms ?? 1_500;
	return protocol === "raw"
		? probeRawReadiness(socketPath, timeoutMs)
		: probeFramedReadiness(socketPath, timeoutMs);
}

/** Distinguish a stale pathname from a live listener that accepted a
 * connection but failed the Interlinked protocol. Only `absent` authorizes
 * unlinking without first stopping a verified owner. */
export async function classifyHarnessSocket(args: {
	socketPath: string;
	protocol: HarnessSocketProtocol;
	opts?: HarnessSocketReadinessOptions;
}): Promise<HarnessSocketState> {
	const timeoutMs = args.opts?.timeout_ms ?? 1_500;
	const presence = await probeSocketPresence(args.socketPath, timeoutMs);
	if (presence === "absent") return "absent";
	if (presence === "ambiguous") return "occupied_unready";
	return (await isHarnessSocketReady(args)) ? "ready" : "occupied_unready";
}
