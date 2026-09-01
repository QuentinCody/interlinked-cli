import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDaemonClient } from "./harness/daemon-client.js";
import type { RpcMethod } from "./harness/daemon-protocol.js";
import { callLegacyHarness, isLegacyHarnessSocket } from "./harness/legacy-client.js";
import type { HarnessDecision } from "./harness/types.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import { findRepoRoot } from "./hook-entry-project.js";
import { nonNull } from "./lib/non-null.js";

const HOOK_PROTOCOL_RAW = "raw";
const HOOK_PROTOCOL_FRAMED = "framed";
type HookProtocol = typeof HOOK_PROTOCOL_RAW | typeof HOOK_PROTOCOL_FRAMED;

export type HookDaemonCallResult =
	| { ok: true; decision: HarnessDecision }
	| { ok: false; reason: string };

interface HookDaemonCallArgs {
	socketPath: string;
	method: RpcMethod;
	event: UnifiedHookEvent;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

/** Call the framed or legacy daemon protocol selected for this socket. Socket
 * failures are values so the entry module can apply its bounded cold gates. */
export async function callHookDaemon(args: HookDaemonCallArgs): Promise<HookDaemonCallResult> {
	const protocol = resolveHookProtocol(args.socketPath, args.env);
	if (protocol === HOOK_PROTOCOL_RAW) {
		return safeCallLegacy(args.socketPath, args.event, args.timeoutMs);
	}
	return safeCallDaemon(args);
}

async function safeCallDaemon(args: HookDaemonCallArgs): Promise<HookDaemonCallResult> {
	const client = createDaemonClient(args.socketPath);
	try {
		const value = await client.call(args.method, args.event, {
			timeout_ms: args.timeoutMs,
		});
		// SAFETY: callHookDaemon receives only methodForPhase outputs, whose
		// RpcResult entries are all HarnessDecision; RpcMethod is wider only
		// because daemon-protocol.ts also serves health and compiler methods.
		return { ok: true, decision: value as HarnessDecision };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

async function safeCallLegacy(
	socketPath: string,
	event: UnifiedHookEvent,
	timeoutMs: number,
): Promise<HookDaemonCallResult> {
	try {
		return {
			ok: true,
			decision: await callLegacyHarness(socketPath, event, { timeout_ms: timeoutMs }),
		};
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

function resolveHookProtocol(socketPath: string, env: NodeJS.ProcessEnv): HookProtocol {
	const requested = env.INTERLINKED_HOOK_PROTOCOL;
	if (requested === HOOK_PROTOCOL_RAW) return HOOK_PROTOCOL_RAW;
	if (requested === HOOK_PROTOCOL_FRAMED) return HOOK_PROTOCOL_FRAMED;
	return isLegacyHarnessSocket(socketPath) ? HOOK_PROTOCOL_RAW : HOOK_PROTOCOL_FRAMED;
}

/** Discover the daemon socket. Priority: per-session, default framed, legacy,
 * then the first other named socket in alphabetical order. */
export function discoverSocket(cwd: string, sessionId: string): string | null {
	const root = findRepoRoot(cwd);
	if (!root) return null;
	const dir = join(root, ".interlinked");
	if (!existsSync(dir)) return null;

	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	const perSession = join(dir, `harness-${safe}.sock`);
	if (existsSync(perSession)) return perSession;

	const defaultFramed = join(dir, "harness-default.sock");
	if (existsSync(defaultFramed)) return defaultFramed;

	const legacy = join(dir, "harness.sock");
	if (existsSync(legacy)) return legacy;

	const socketFiles = safeReaddir(dir)
		.filter((name) => name.endsWith(".sock"))
		.sort();
	return socketFiles.length > 0 ? join(dir, nonNull(socketFiles[0])) : null;
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
