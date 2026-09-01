// ===========================================
// Daemon RPC client — connect, send one request, read one response
// ===========================================
// Minimal client for the hook binary. Opens a Unix socket, writes a single
// encoded frame, reads response frames until one matches the request id, and
// closes. Designed to be fast (no persistent connection) and robust (hard
// deadline; explicit failure for the caller to decide cold-fallback).

import { createConnection, type Socket } from "node:net";
import {
	decodeFrame,
	encodeFrame,
	type RpcError,
	type RpcMethod,
	type RpcParams,
	type RpcRequest,
	type RpcResponse,
	type RpcResult,
	splitFrames,
} from "./daemon-protocol.js";

interface RpcCallOptions {
	/** Hard deadline in milliseconds. If no response arrives the promise
	 *  rejects with `new Error("timeout")`. */
	timeout_ms?: number;
	/** Explicit id. Defaults to a random value. */
	id?: string;
	/** Optional cancellation: on abort the socket is destroyed, the timer is
	 *  cleared, and the call rejects with `new Error("aborted")`. Lets a
	 *  multi-socket liveness race cancel its losing probes instead of leaving
	 *  their sockets holding the event loop (review 2026-08-26). */
	signal?: AbortSignal;
}

export interface DaemonClient {
	call<M extends RpcMethod>(
		method: M,
		params: RpcParams[M],
		opts?: RpcCallOptions,
	): Promise<RpcResult[M]>;
}

/** Create a client bound to a specific socket path. Each call opens a new
 *  connection — the daemon is expected to handle concurrent short-lived
 *  clients. The Node.js kernel Unix-socket backlog handles bursts. */
export function createDaemonClient(socketPath: string): DaemonClient {
	return {
		async call<M extends RpcMethod>(
			method: M,
			params: RpcParams[M],
			opts: RpcCallOptions = {},
		): Promise<RpcResult[M]> {
			const id = opts.id ?? makeId();
			const timeoutMs = opts.timeout_ms ?? 2000;
			const request: RpcRequest<M> = {
				schema_version: "1",
				id,
				method,
				params,
			};
			return callOverSocket(socketPath, request, timeoutMs, opts.signal);
		},
	};
}

function callOverSocket<M extends RpcMethod>(
	socketPath: string,
	request: RpcRequest<M>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RpcResult[M]> {
	return new Promise((resolve, reject) => {
		let socket: Socket | null = null;
		let settled = false;
		// ONE settlement helper: every path (success, error, close, timeout,
		// abort) funnels through here, and cleanup — timer AND abort listener —
		// happens exactly once. A long-lived signal reused across many calls must
		// not accumulate completed listeners (review pass 16).
		const onAbort = (): void => finish(() => reject(new Error("aborted")));
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (socket) socket.destroy();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
		if (signal) {
			if (signal.aborted) {
				// Pre-aborted: settle immediately, never open a socket.
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		socket = createConnection(socketPath, () => {
			(socket as Socket).write(encodeFrame(request));
		});
		let pending = "";
		socket.on("data", (b: Buffer) => {
			const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
			pending = remainder;
			for (const frame of frames) {
				const message = parseResponseFrame(frame);
				if (message == null) continue;
				if (message.id !== request.id) continue;
				clearTimeout(timer);
				if ("error" in message) {
					finish(() =>
						reject(
							Object.assign(new Error(message.error.message), {
								code: message.error.code,
								recoverable: message.error.recoverable,
							}),
						),
					);
					return;
				}
				finish(() => resolve(message.result as RpcResult[M]));
				return;
			}
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			finish(() => reject(err));
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (!settled) finish(() => reject(new Error("socket closed")));
		});
	});
}

function parseResponseFrame<M extends RpcMethod>(frame: string): RpcResponse<M> | RpcError | null {
	let parsed: unknown;
	try {
		parsed = decodeFrame(frame);
	} catch {
		return null;
	}
	return parsed as RpcResponse<M> | RpcError;
}

function makeId(): string {
	return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
