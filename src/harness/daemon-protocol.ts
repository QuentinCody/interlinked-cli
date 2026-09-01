// ===========================================
// Daemon RPC protocol — newline-delimited JSON over Unix socket
// ===========================================
// Versioned JSON-RPC-ish format. Every request carries `schema_version: "1"`.
// Multiple inflight requests are keyed by `id` (the daemon echoes it back).
// See docs/design/free-cli-architecture.md §"Daemon architecture".

import type { JsonObject } from "../lib/json-types.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

/** Wire-version. Bumped when the envelope breaks compatibility. */
export const PROTOCOL_VERSION = "1" as const;

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

export interface RpcRequest<TMethod extends RpcMethod = RpcMethod> {
	schema_version: typeof PROTOCOL_VERSION;
	id: string;
	method: TMethod;
	params: RpcParams[TMethod];
}

export interface RpcResponse<TMethod extends RpcMethod = RpcMethod> {
	id: string;
	result: RpcResult[TMethod];
}

export interface RpcError {
	id: string;
	error: { code: RpcErrorCode; message: string; recoverable: boolean };
}

type RpcErrorCode =
	| "timeout"
	| "bad_request"
	| "unknown_method"
	| "schema_mismatch"
	| "tsgo_unavailable"
	| "internal";

export type RpcMessage = RpcRequest | RpcResponse | RpcError;

// -----------------------------------------------------------------------------
// Method table
// -----------------------------------------------------------------------------

export type RpcMethod =
	| "hook.pre_tool_use"
	| "hook.post_tool_use"
	| "hook.session_start"
	| "hook.session_end"
	| "hook.user_prompt"
	| "hook.pre_compact"
	| "hook.permission_request"
	| "hook.post_compact"
	| "hook.lifecycle"
	| "daemon.health"
	| "daemon.shutdown"
	| "daemon.invalidate"
	| "tsgo.check_file"
	| "tsgo.simulate_edit";

// -----------------------------------------------------------------------------
// Parameter + result types (indexed by method name)
// -----------------------------------------------------------------------------

export interface TsgoDiagnostic {
	line: number;
	column: number;
	code: number;
	severity: "error" | "warning" | "info";
	message: string;
	file: string;
}

export interface DaemonHealth {
	status: "ready" | "warming" | "degraded";
	uptime_ms: number;
	warm_caches: string[];
	tsgo_status: "ready" | "starting" | "unavailable";
	rpc_inflight: number;
	protocol_version: typeof PROTOCOL_VERSION;
}

interface HookSessionAck {
	ack: true;
}

export interface RpcParams {
	"hook.pre_tool_use": UnifiedHookEvent;
	"hook.post_tool_use": UnifiedHookEvent;
	"hook.session_start": UnifiedHookEvent;
	"hook.session_end": UnifiedHookEvent;
	"hook.user_prompt": UnifiedHookEvent;
	"hook.pre_compact": UnifiedHookEvent;
	"hook.permission_request": UnifiedHookEvent;
	"hook.post_compact": UnifiedHookEvent;
	"hook.lifecycle": UnifiedHookEvent;
	"daemon.health": Record<string, never>;
	"daemon.shutdown": { reason?: string };
	"daemon.invalidate": { path: string };
	"tsgo.check_file": { path: string };
	"tsgo.simulate_edit": { path: string; old_string: string; new_string: string };
}

export interface RpcResult {
	"hook.pre_tool_use": HarnessDecision;
	"hook.post_tool_use": HarnessDecision;
	"hook.session_start": HarnessDecision;
	"hook.session_end": HarnessDecision;
	"hook.user_prompt": HarnessDecision;
	"hook.pre_compact": HarnessDecision;
	"hook.permission_request": HarnessDecision;
	"hook.post_compact": HarnessDecision;
	"hook.lifecycle": HarnessDecision;
	"daemon.health": DaemonHealth;
	"daemon.shutdown": HookSessionAck;
	"daemon.invalidate": HookSessionAck;
	"tsgo.check_file": { diagnostics: TsgoDiagnostic[]; cached: boolean; elapsed_ms: number };
	"tsgo.simulate_edit": {
		new_diagnostics: TsgoDiagnostic[];
		elapsed_ms: number;
	};
}

// -----------------------------------------------------------------------------
// Encoder / decoder
// -----------------------------------------------------------------------------

/** Encode an RpcRequest/Response/Error as a single newline-delimited JSON frame. */
export function encodeFrame(message: RpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** Split a chunk of incoming bytes into complete JSON frames + a leftover
 *  remainder (everything after the last newline). Callers persist the
 *  remainder between reads. */
export function splitFrames(chunk: string, pending = ""): { frames: string[]; remainder: string } {
	// PERFORMANCE CONSTRAINT (2026-08-27 daemon-melt root cause): scan ONLY
	// the incoming chunk for newlines. The prior `(pending + chunk).split("\n")`
	// flattened (memmove) the whole accumulated buffer on every chunk, so one
	// large partial frame cost O(n²) copying and stalled the event loop. When
	// the chunk carries no newline, the returned remainder is a lazy V8 cons
	// string (no flatten); the accumulated text is only materialized when its
	// terminating newline finally arrives.
	let idx = chunk.indexOf("\n");
	if (idx === -1) {
		return { frames: [], remainder: pending.length > 0 ? pending + chunk : chunk };
	}
	const frames: string[] = [];
	const first = pending + chunk.slice(0, idx);
	if (first.length > 0) frames.push(first);
	let start = idx + 1;
	idx = chunk.indexOf("\n", start);
	while (idx !== -1) {
		const part = chunk.slice(start, idx);
		if (part.length > 0) frames.push(part);
		start = idx + 1;
		idx = chunk.indexOf("\n", start);
	}
	return { frames, remainder: chunk.slice(start) };
}

/** Decode a single JSON frame into an RpcMessage. Throws when the shape is
 *  fundamentally broken; callers should translate the throw into an RpcError
 *  with `code: bad_request`. */
export function decodeFrame(frame: string): RpcMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame);
	} catch (err) {
		throw new Error(`invalid JSON frame: ${(err as Error).message}`, {
			cause: err,
		});
	}
	if (parsed == null || typeof parsed !== "object") {
		throw new Error("frame must be an object");
	}
	const obj = parsed as JsonObject;
	if (typeof obj.id !== "string" || obj.id.length === 0) {
		throw new Error("frame missing id");
	}
	// Protocol edge: we validate the envelope `id` here and defer variant
	// discrimination (request / response / error) to `isRequest` / `isError`
	// downstream, so the wire object is widened from `unknown` to the
	// `RpcMessage` union rather than structurally smuggled into it.
	const wireMessage: unknown = obj;
	return wireMessage as RpcMessage;
}

/** Type-narrowing predicate: true when the message has a `method` field. */
export function isRequest(msg: RpcMessage): msg is RpcRequest {
	return typeof (msg as RpcRequest).method === "string";
}

/**
 * Type-narrowing predicate: true when the message carries a WELL-FORMED error.
 *
 * Every required field of `RpcError` is checked, including `id` and the nested
 * `error` members. Before 2026-08-09 this tested only that `error` was a
 * non-null object, so `{ error: {} }` off the wire narrowed to `RpcError` and
 * callers then read `.id` / `.error.code` as `string` when both were
 * `undefined` — `parseWireMessage` widens an untrusted object into `RpcMessage`
 * by assertion, which makes this predicate the only real gate. Found by the
 * `type_predicate_drift` check.
 *
 * Tightening is safe for our own traffic: `makeError` is the sole producer and
 * always populates all four fields.
 */
export function isError(msg: RpcMessage): msg is RpcError {
	if (typeof (msg as RpcError).id !== "string") return false;
	const err: unknown = (msg as RpcError).error;
	if (typeof err !== "object" || err === null) return false;
	const { code, message, recoverable } = err as Partial<RpcError["error"]>;
	return (
		typeof code === "string" && typeof message === "string" && typeof recoverable === "boolean"
	);
}

/** Construct a well-formed RpcError. */
export function makeError(
	id: string,
	code: RpcErrorCode,
	message: string,
	recoverable = true,
): RpcError {
	return { id, error: { code, message, recoverable } };
}

/** Map a hook UnifiedPhase to the corresponding RpcMethod. */
export function methodForPhase(phase: UnifiedHookEvent["phase"]): RpcMethod {
	switch (phase) {
		case "pre-tool":
			return "hook.pre_tool_use";
		case "post-tool":
			return "hook.post_tool_use";
		case "session-start":
			return "hook.session_start";
		case "session-end":
			return "hook.session_end";
		case "user-prompt":
			return "hook.user_prompt";
		case "pre-compact":
			return "hook.pre_compact";
		case "permission-request":
			return "hook.permission_request";
		case "post-compact":
			return "hook.post_compact";
		default:
			// Unknown and lifecycle-style phases must never be mistaken for a
			// pre-tool gate. The generic method records them without applying a
			// tool policy to a payload that has no tool semantics.
			return "hook.lifecycle";
	}
}
