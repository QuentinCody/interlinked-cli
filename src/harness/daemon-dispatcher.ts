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
	type RpcMethod,
	type RpcRequest,
	type RpcWireRequest,
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
import { isRpcHookEvent } from "./daemon-request-parser.js";
import { isHookCoverageRequest, type HookCoverageReport, type HookCoverageRequest } from "./hook-coverage-control.js";

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

const HOOK_DECISION_METHODS = new Set<string>([
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

const OBSERVATION_ONLY_HOOK_METHODS = new Set<string>([
	"hook.session_start",
	"hook.session_end",
	"hook.pre_compact",
	"hook.permission_request",
	"hook.post_compact",
	"hook.lifecycle",
]);

export interface DispatcherState {
	coverage?: (request: HookCoverageRequest) => HookCoverageReport;
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
export function dispatchRpc<M extends RpcMethod>(request: RpcRequest<M>, state: DispatcherState): Promise<RpcResponse<M> | RpcError>;
export function dispatchRpc(request: RpcWireRequest, state: DispatcherState): Promise<RpcResponse | RpcError>;
export async function dispatchRpc(
	request: RpcWireRequest,
	state: DispatcherState,
): Promise<RpcResponse | RpcError> {
	const receivedSchemaVersion = request.schema_version;
	if (receivedSchemaVersion !== PROTOCOL_VERSION) {
		return makeError(
			request.id,
			"schema_mismatch",
			`unsupported schema_version ${JSON.stringify(receivedSchemaVersion)}`,
			false,
		);
	}
	if (HOOK_DECISION_METHODS.has(request.method)) {
		return dispatchHookDecision(request, state);
	}
	switch (request.method) {
		case "daemon.coverage":
			return dispatchCoverage(request, state);
		case "daemon.health":
			return {
				id: request.id,
				result: buildHealthResponse(state),
			} satisfies RpcResponse<"daemon.health">;
		case "daemon.shutdown":
			return dispatchShutdown(request, state);
		case "daemon.invalidate":
			return dispatchInvalidate(request, state);
		case "tsgo.check_file":
			return dispatchTsgoCheck(request, state);
		case "tsgo.simulate_edit":
			return dispatchTsgoSimulate(request, state);
		default:
			return makeError(
				request.id,
				"unknown_method",
				`unknown method: ${String(request.method)}`,
				true,
			);
	}
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

function dispatchCoverage(request: { id: string; params?: unknown }, state: DispatcherState): RpcResponse<"daemon.coverage"> | RpcError {
	if (!isHookCoverageRequest(request.params)) return makeError(request.id, "bad_request", "Invalid hook coverage operation");
	try {
		return { id: request.id, result: state.coverage?.(request.params) ?? { readiness: "unmeasured", reason: "No daemon observer" } };
	} catch (error) { return makeError(request.id, "internal", String(error)); }
}

async function dispatchHookDecision(
	request: RpcWireRequest,
	state: DispatcherState,
): Promise<RpcResponse<HookDecisionMethod> | RpcError> {
	const event = request.params;
	const violations = validateUnifiedEvent(event);
	if (violations.length > 0) {
		return makeError(request.id, "bad_request", `invalid event: ${violations.join("; ")}`);
	}
	if (!isRpcHookEvent(event)) {
		return makeError(request.id, "bad_request", "invalid event: malformed action or metadata");
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

function isLifecycleHookMethod(method: string): boolean {
	return OBSERVATION_ONLY_HOOK_METHODS.has(method);
}

async function dispatchTsgoCheck(
	request: RpcWireRequest,
	state: DispatcherState,
): Promise<RpcResponse<"tsgo.check_file"> | RpcError> {
	const params = request.params;
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
	request: RpcWireRequest,
	state: DispatcherState,
): Promise<RpcResponse<"tsgo.simulate_edit"> | RpcError> {
	const params = request.params;
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

function dispatchShutdown(request: RpcWireRequest, state: DispatcherState): RpcResponse<"daemon.shutdown"> | RpcError {
	const params = request.params;
	if (!isJsonObject(params) || (params.reason !== undefined && typeof params.reason !== "string")) {
		return makeError(request.id, "bad_request", "daemon.shutdown requires an object with an optional reason string");
	}
	state.shutdown(params.reason);
	return { id: request.id, result: { ack: true } };
}

function dispatchInvalidate(request: RpcWireRequest, state: DispatcherState): RpcResponse<"daemon.invalidate"> | RpcError {
	const params = request.params;
	if (!isJsonObject(params) || typeof params.path !== "string" || params.path.length === 0) {
		return makeError(request.id, "bad_request", "daemon.invalidate requires a path");
	}
	state.tsgo.invalidate(params.path);
	return { id: request.id, result: { ack: true } };
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
