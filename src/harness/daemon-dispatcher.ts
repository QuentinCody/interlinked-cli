// ===========================================
// Daemon dispatcher — routes RPC requests to handlers
// ===========================================
// Pure dispatcher: given an `RpcRequest` returns an `RpcResponse` or `RpcError`.
// Socket I/O lives in the caller (see hook-entry.ts for the client side and
// the forthcoming session-daemon.ts for the server side). Splitting the
// dispatcher from the transport makes it trivial to unit-test every method.

import {
	makeError,
	PROTOCOL_VERSION,
	type RpcError,
	type RpcParams,
	type RpcRequest,
	type RpcResponse,
	type RpcResult,
} from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import { evaluateUnified } from "./evaluator-unified.js";
import { isJsonObject } from "../lib/json-types.js";
import type { TsgoRunner } from "./tsgo-runner.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";
import { validateUnifiedEvent } from "./unified-event.js";

type HookDecisionMethod =
	| "hook.pre_tool_use"
	| "hook.post_tool_use"
	| "hook.user_prompt"
	| "hook.session_start"
	| "hook.session_end"
	| "hook.pre_compact"
	| "hook.permission_request"
	| "hook.post_compact"
	| "hook.lifecycle";

const HOOK_DECISION_METHODS = new Set<HookDecisionMethod>([
	"hook.pre_tool_use",
	"hook.post_tool_use",
	"hook.user_prompt",
	"hook.session_start",
	"hook.session_end",
	"hook.pre_compact",
	"hook.permission_request",
	"hook.post_compact",
	"hook.lifecycle",
]);

const OBSERVATION_ONLY_HOOK_METHODS = new Set<HookDecisionMethod>([
	"hook.session_start",
	"hook.session_end",
	"hook.pre_compact",
	"hook.permission_request",
	"hook.post_compact",
	"hook.lifecycle",
]);

export interface DispatcherState {
	/** Wall-clock ms at daemon start. */
	started_at: number;
	/** In-flight request count (updated by the caller). */
	rpc_inflight: number;
	/** tsgo child-process wrapper. */
	tsgo: TsgoRunner;
	/** Evaluator context factory — returns fresh context per RPC so sessions,
	 *  rules, and caches are always current. */
	getEvaluatorContext(): EvaluateUnifiedContext;
	/** Optional production runtime bridge. When present, hook RPCs go through
	 *  the same HarnessEvent evaluator used by the raw socket path so lifecycle
	 *  side effects, latency hooks, reservations, and scanner state stay shared. */
	evaluateHook?: ((event: UnifiedHookEvent) => Promise<HarnessDecision>) | undefined;
	/** Called from the `daemon.shutdown` RPC. */
	shutdown(reason?: string): void;
}

/** Dispatch a single RPC request. Never throws — errors come back as
 *  RpcError frames. */
export async function dispatchRpc(
	request: RpcRequest,
	state: DispatcherState,
): Promise<RpcResponse | RpcError> {
	// `request` is cast from an untrusted wire object upstream (decodeFrame /
	// session-daemon's `message as RpcRequest`), so schema_version isn't
	// actually guaranteed to be the literal "1" at runtime — widen before
	// comparing so this stays a real runtime check, not a tautology.
	const receivedSchemaVersion: unknown = request.schema_version;
	if (receivedSchemaVersion !== PROTOCOL_VERSION) {
		return makeError(
			request.id,
			"schema_mismatch",
			`unsupported schema_version ${JSON.stringify(receivedSchemaVersion)}`,
			false,
		);
	}
	if (isHookDecisionRequest(request)) {
		return dispatchHookDecision(request, state);
	}
	switch (request.method) {
		case "daemon.health":
			return {
				id: request.id,
				result: buildHealthResponse(state),
			} satisfies RpcResponse<"daemon.health">;
		case "daemon.shutdown":
			state.shutdown((request.params as RpcParams["daemon.shutdown"]).reason);
			return {
				id: request.id,
				result: { ack: true },
			} satisfies RpcResponse<"daemon.shutdown">;
		case "daemon.invalidate":
			state.tsgo.invalidate((request.params as RpcParams["daemon.invalidate"]).path);
			return {
				id: request.id,
				result: { ack: true },
			} satisfies RpcResponse<"daemon.invalidate">;
		case "tsgo.check_file":
			return dispatchTsgoCheck(request as RpcRequest<"tsgo.check_file">, state);
		case "tsgo.simulate_edit":
			return dispatchTsgoSimulate(request as RpcRequest<"tsgo.simulate_edit">, state);
		default:
			return makeError(
				request.id,
				"unknown_method",
				`unknown method: ${String(request.method)}`,
				true,
			);
	}
}

function isHookDecisionRequest(
	request: RpcRequest,
): request is RpcRequest<HookDecisionMethod> {
	return HOOK_DECISION_METHODS.has(request.method as HookDecisionMethod);
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function dispatchHookDecision<M extends HookDecisionMethod>(
	request: RpcRequest<M>,
	state: DispatcherState,
): Promise<RpcResponse<M> | RpcError> {
	const event = request.params;
	const violations = validateUnifiedEvent(event);
	if (violations.length > 0) {
		return makeError(request.id, "bad_request", `invalid event: ${violations.join("; ")}`);
	}
	if (state.evaluateHook) {
		const decision = await state.evaluateHook(event);
		return {
			id: request.id,
			result: decision,
		};
	}
	if (isLifecycleHookMethod(request.method)) {
		return {
			id: request.id,
			result: { decision: "allow" },
		};
	}
	const ctx = state.getEvaluatorContext();
	const decision = await evaluateUnified(event, ctx);
	return {
		id: request.id,
		result: decision,
	};
}

function isLifecycleHookMethod(method: HookDecisionMethod): boolean {
	return OBSERVATION_ONLY_HOOK_METHODS.has(method);
}

async function dispatchTsgoCheck(
	request: RpcRequest<"tsgo.check_file">,
	state: DispatcherState,
): Promise<RpcResponse<"tsgo.check_file"> | RpcError> {
	// `request.params` is typed as the required `{ path: string }` shape, but
	// that's inherited from the same untrusted `as RpcRequest` cast at the
	// socket boundary (session-daemon.ts) — a malformed client can send
	// anything here, so widen before validating.
	const params: unknown = request.params;
	if (!isJsonObject(params) || typeof params.path !== "string" || params.path.length === 0) {
		return makeError(request.id, "bad_request", "tsgo.check_file requires a path");
	}
	if (!state.tsgo.available()) {
		return makeError(request.id, "tsgo_unavailable", "tsgo is not installed", true);
	}
	const result = await state.tsgo.checkFile(params.path);
	return { id: request.id, result };
}

async function dispatchTsgoSimulate(
	request: RpcRequest<"tsgo.simulate_edit">,
	state: DispatcherState,
): Promise<RpcResponse<"tsgo.simulate_edit"> | RpcError> {
	// Same untrusted-boundary reasoning as dispatchTsgoCheck above.
	const params: unknown = request.params;
	if (
		!isJsonObject(params) ||
		typeof params.path !== "string" ||
		typeof params.old_string !== "string" ||
		typeof params.new_string !== "string"
	) {
		return makeError(
			request.id,
			"bad_request",
			"tsgo.simulate_edit requires path, old_string, new_string",
		);
	}
	if (!state.tsgo.available()) {
		return makeError(request.id, "tsgo_unavailable", "tsgo is not installed", true);
	}
	const result = await state.tsgo.simulateEdit(params.path, params.old_string, params.new_string);
	return { id: request.id, result };
}

function buildHealthResponse(state: DispatcherState): RpcResult["daemon.health"] {
	const warm_caches: string[] = [];
	if (state.tsgo.available()) warm_caches.push("tsgo");
	if (state.tsgo.stats().cache_size > 0) warm_caches.push("mtime");
	return {
		status: state.tsgo.available() ? "ready" : "degraded",
		uptime_ms: Date.now() - state.started_at,
		warm_caches,
		tsgo_status: state.tsgo.available() ? "ready" : "unavailable",
		rpc_inflight: state.rpc_inflight,
		protocol_version: PROTOCOL_VERSION,
	};
}
