#!/usr/bin/env node
// ===========================================
// Hook entry — thin client the installer wires into every runner
// ===========================================
// 1. Parse stdin JSON (the runner's native payload).
// 2. Detect adapter (INTERLINKED_RUNNER env → --runner arg → env heuristic).
// 3. Build a UnifiedHookEvent via the adapter.
// 4. Discover the daemon socket.
// 5. Send RPC to daemon; wait within a hard deadline.
// 6. On socket error or timeout: run the cold fallback (inline checks).
// 7. Encode the decision via the adapter; write stdout/stderr; exit with code.
//
// This module is importable (for tests) and also runnable as a CLI script.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllAdapters, detectAdapter, getAdapter } from "./harness/adapters/index.js";
import type { RunnerAdapter } from "./harness/adapters/types.js";
import { createDaemonClient } from "./harness/daemon-client.js";
import { methodForPhase, type RpcMethod } from "./harness/daemon-protocol.js";
import {
	callLegacyHarness,
	DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS,
	isLegacyHarnessSocket,
} from "./harness/legacy-client.js";
import type { HarnessDecision } from "./harness/types.js";
import type { RunnerId, UnifiedHookEvent } from "./harness/unified-event.js";

const DEFAULT_HOOK_TIMEOUT_MS = 2000;

// User-prompt phase calls the metacoder synchronously, which runs Opus 4.7
// max-effort (~30s) inside the harness. The hook timeout must exceed the
// metacoder's internal timeout with a buffer so the harness can return a
// clean "metacoder timed out, allow" decision before the hook gives up on
// the socket. Strictly greater than `METACODER_TIMEOUT_DEFAULT_MS` (30_000)
// in `src/harness/metacoder/types.ts`. Plan §2.4, §6, §10 risk #10.
const DEFAULT_USER_PROMPT_TIMEOUT_MS = 35_000;

// Hook-socket transport variants. The legacy server uses newline-delimited
// JSON over a raw stream; the new server uses length-prefixed framing.
const HOOK_PROTOCOL_RAW = "raw";
const HOOK_PROTOCOL_FRAMED = "framed";
type HookProtocol = typeof HOOK_PROTOCOL_RAW | typeof HOOK_PROTOCOL_FRAMED;

// Unified phase tags (a subset of UnifiedPhase). Centralized as constants
// because hook-entry compares against them in multiple places — magic
// strings drift across files when one place is refactored and the others
// aren't.
const PHASE_PRE_TOOL = "pre-tool";
const PHASE_USER_PROMPT = "user-prompt";

// Recursion guard for the metacoder subprocess path. Plan §2.5. The harness
// spawns `claude -p` with this env set to "1"; the spawned subprocess's
// first prompt fires UserPromptSubmit back to the harness, which would
// recurse without this flag. Hook-entry forwards the env onto the event so
// `server.ts` can short-circuit.
const METACODER_SUBPROCESS_ENV = "INTERLINKED_METACODER_SUBPROCESS";
const METACODER_SUBPROCESS_FLAG = "1";

// Discriminator values for UnifiedAction. Same rationale as above.
const ACTION_TOOL_CALL = "tool_call";
const ACTION_FILE_OPERATION = "file_operation";

export interface HookEntryOptions {
	/** The native hook event name the runner emitted. */
	nativeEventName: string;
	/** JSON payload from the runner's stdin. */
	nativeJson: unknown;
	/** Process environment — useful for tests to inject env. */
	env: NodeJS.ProcessEnv;
	/** Repo root to discover the daemon socket under. Defaults to cwd. */
	cwd?: string;
	/** Explicit runner id (overrides env detection). */
	runner?: RunnerId;
	/** Explicit socket path (overrides discovery). */
	socketPath?: string;
	/** Hard timeout for the daemon call. Defaults to 2s. */
	timeout_ms?: number;
}

export interface HookEntryResult {
	stdout?: string;
	stderr?: string;
	exit_code: number;
	/** True if the hook fell back to cold evaluation. */
	fell_back: boolean;
}

/** Run a single hook invocation end-to-end, returning the encoded output.
 *  Does not read from process.stdin or write to process.stdout — that is the
 *  CLI wrapper's job. Keeps the core logic easily testable. */
export async function runHookEntry(opts: HookEntryOptions): Promise<HookEntryResult> {
	const adapter = resolveAdapter(opts);
	if (!adapter) {
		const detail = opts.runner
			? `unknown runner id: ${opts.runner}`
			: "no runner detected from env; pass --runner=<id> or set INTERLINKED_RUNNER";
		return { stderr: `[interlinked] ${detail}\n`, exit_code: 0, fell_back: true };
	}

	let event: UnifiedHookEvent;
	event = tryBuildEvent(adapter, opts.nativeJson, opts.nativeEventName);

	// Forward the metacoder-subprocess recursion sentinel from env onto the
	// event envelope. Plan §2.5 — without this, the framed adapter path
	// would not surface the sentinel to `server.ts` and the metacoder would
	// recurse on its own subprocess.
	if (opts.env[METACODER_SUBPROCESS_ENV] === METACODER_SUBPROCESS_FLAG) {
		event.metacoder_subprocess = true;
	}

	const socketPath =
		opts.socketPath ?? discoverSocket(opts.cwd ?? process.cwd(), event.session_id);
	if (!socketPath) {
		// No daemon available at all — cold fallback to allow with note.
		return encodeColdFallback(adapter, event, "daemon socket not found");
	}

	const method = methodForPhase(event.phase);
	const timeoutMs = opts.timeout_ms ?? defaultTimeoutForPhase(event);
	let decision: HarnessDecision;
	const fellBack = false;
	const protocol = resolveHookProtocol(socketPath, opts.env);
	const result =
		protocol === HOOK_PROTOCOL_RAW
			? await safeCallLegacy(socketPath, event, timeoutMs)
			: await safeCallDaemon({ socketPath, method, event, timeoutMs });
	if (result.ok) {
		decision = result.decision;
	} else {
		const cold = encodeColdFallback(adapter, event, result.reason);
		return cold;
	}

	const output = adapter.encodeDecision(decision, event);
	return {
		stdout: output.stdout,
		stderr: output.stderr,
		exit_code: output.exit_code,
		fell_back: fellBack,
	};
}

/** Entry point for CLI invocation — reads stdin, detects runner + event,
 *  writes stdout/stderr, exits with the adapter-decided code. Invoked by
 *  the IIFE at the bottom of the file when run as a script; not part of
 *  the importable surface (consumers should use `runHookEntry`). */
async function mainFromStdin(): Promise<void> {
	const nativeJson = await readStdinJson();
	const nativeEventName = argOrEnv("--event") ?? process.env.INTERLINKED_EVENT ?? "PreToolUse";
	const runner = argOrEnv("--runner") ?? process.env.INTERLINKED_RUNNER;
	const socketPath = argOrEnv("--socket") ?? process.env.INTERLINKED_SOCKET;
	const result = await runHookEntry({
		nativeEventName,
		nativeJson,
		env: process.env,
		runner: runner as RunnerId | undefined,
		socketPath,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exit(result.exit_code);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveAdapter(opts: HookEntryOptions): RunnerAdapter | null {
	const all = buildAllAdapters();
	if (opts.runner) return getAdapter(opts.runner, all);
	return detectAdapter(opts.env, all);
}

function tryBuildEvent(
	adapter: RunnerAdapter,
	nativeJson: unknown,
	nativeEventName: string,
): UnifiedHookEvent {
	// Adapters are tolerant of unknown fields and never throw; the wrapper
	// exists only as a single seam where a future caller can add fallback
	// behavior if adapter contracts change.
	const event: UnifiedHookEvent = adapter.parseHookInput(nativeJson, nativeEventName);
	return event;
}

interface SafeCallDaemonArgs {
	socketPath: string;
	method: RpcMethod;
	event: UnifiedHookEvent;
	timeoutMs: number;
}

async function safeCallDaemon(
	args: SafeCallDaemonArgs,
): Promise<{ ok: true; decision: HarnessDecision } | { ok: false; reason: string }> {
	const client = createDaemonClient(args.socketPath);
	let decision: HarnessDecision | null = null;
	let reason = "";
	const done = await client
		.call(args.method as "hook.pre_tool_use", args.event, { timeout_ms: args.timeoutMs })
		.then((d) => {
			decision = d as HarnessDecision;
			return true;
		})
		.catch((err: Error) => {
			reason = err.message;
			return false;
		});
	if (done && decision) return { ok: true, decision };
	return { ok: false, reason };
}

async function safeCallLegacy(
	socketPath: string,
	event: UnifiedHookEvent,
	timeoutMs: number,
): Promise<{ ok: true; decision: HarnessDecision } | { ok: false; reason: string }> {
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

function defaultTimeoutForPhase(event: UnifiedHookEvent): number {
	if (event.phase === PHASE_PRE_TOOL) return DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS;
	if (event.phase === PHASE_USER_PROMPT) return DEFAULT_USER_PROMPT_TIMEOUT_MS;
	return DEFAULT_HOOK_TIMEOUT_MS;
}

/** Discover the daemon socket. Priority:
 *    1. `--socket` flag / INTERLINKED_SOCKET env var (handled by caller)
 *    2. Per-session `.interlinked/harness-<sanitized>.sock`
 *    3. Default framed `.interlinked/harness-default.sock`
 *    4. Legacy `.interlinked/harness.sock`
 *    5. Any other `harness-*.sock` in the dir (first hit, alphabetical) */
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

	const entries = safeReaddir(dir);
	const socketFiles = entries.filter((n) => n.endsWith(".sock")).sort();
	if (socketFiles.length > 0) return join(dir, socketFiles[0]);
	return null;
}

function findRepoRoot(cwd: string): string | null {
	let dir = cwd;
	let depth = 0;
	while (depth < 20) {
		if (existsSync(join(dir, ".interlinked"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
		depth++;
	}
	return null;
}

function safeReaddir(dir: string): string[] {
	let out: string[] = [];
	try {
		out = readdirSync(dir);
	} catch {
		out = [];
	}
	return out;
}

// Graph-prediction protocol mirror for the cold path. When the harness daemon
// is unreachable or times out, the runner-adapter path (this file) used to
// fall through to `allow`. The protocol explicitly requires that edits to
// files with a fresh `.graph.*` shard go through predict/reveal/reconcile;
// allowing them silently when the daemon is busy or down breaks the
// protocol's "must" guarantee. This function mirrors the inline check in
// `src/lib/hook-template-chunks/guards-inline.ts::inlineGraphShardCheck` —
// any change here should be reflected there (and vice versa).
const GRAPH_SHARD_STALENESS_GRACE_MS = 60_000;
// Tool names AFTER `normalizeToolName` in the Claude Code adapter (PascalCase
// → snake_case, e.g. `Edit` → `edit`, `MultiEdit` → `multi_edit`). Other
// adapters use the snake_case form directly. Both are covered here so a future
// adapter that forwards the raw PascalCase string still hits the same set.
const GRAPH_SHARD_WRITE_TOOLS = new Set([
	// Normalized (snake_case) forms — the canonical UnifiedHookEvent shape.
	"write",
	"edit",
	"multi_edit",
	"notebook_edit",
	"write_file",
	"edit_file",
	"file_write",
	"file_edit",
	"create",
	"str_replace",
	"apply_patch",
	// Raw PascalCase fallbacks for adapters that bypass normalization.
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"WriteFile",
	"EditFile",
	"FileWrite",
	"FileEdit",
]);

// Path keys that appear on tool_input across runners. Centralized so the
// cold-fallback path doesn't have to keep a separate copy of the list. The
// adapters normalize input keys but historic callers have used all of these.
const FILE_PATH_INPUT_KEYS = ["file_path", "filePath", "path", "target_file"] as const;

// `apply_patch` body markers used in OpenAI Codex CLI and similar tools.
const APPLY_PATCH_TOOL = "apply_patch";
const APPLY_PATCH_FILE_HEADER_RE = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm;
const APPLY_PATCH_MOVE_HEADER_RE = /^\*\*\* Move to:\s+(.+)$/gm;

// What `colColdToolName` returns when the unified event is a generic
// file_operation (no specific tool name). "edit" matches the normalized
// form in GRAPH_SHARD_WRITE_TOOLS.
const FILE_OPERATION_DEFAULT_TOOL = "edit";

// Sentinel value for `INTERLINKED_DISABLE_GRAPH_SHARD_INLINE` that opts out of
// the cold-fallback gate. Stored as a constant so the comparison is
// self-documenting and matches the inline-fallback variant exactly.
const DISABLE_GRAPH_SHARD_FLAG = "1";

interface ApplyPatchInput {
	command?: string;
	patch?: string;
	content?: string;
	_raw_patch?: string;
}

interface FileTargetInput {
	file_path?: string;
	filePath?: string;
	path?: string;
	target_file?: string;
}

type ColdToolInput = FileTargetInput & ApplyPatchInput;

function extractColdTargetPaths(event: UnifiedHookEvent): string[] {
	const paths: string[] = [];
	const action = event.action;
	if (action.kind === ACTION_TOOL_CALL) {
		const ti = (action.tool_input ?? {}) as ColdToolInput;
		for (const key of FILE_PATH_INPUT_KEYS) {
			const v = ti[key];
			if (typeof v === "string" && v.trim() !== "") paths.push(v.trim());
		}
		if (action.tool_name === APPLY_PATCH_TOOL) {
			const patch = String(ti.command ?? ti.patch ?? ti.content ?? ti._raw_patch ?? "");
			let m: RegExpExecArray | null;
			while ((m = APPLY_PATCH_FILE_HEADER_RE.exec(patch)) !== null) {
				const p = (m[1] ?? "").trim();
				if (p && !paths.includes(p)) paths.push(p);
			}
			while ((m = APPLY_PATCH_MOVE_HEADER_RE.exec(patch)) !== null) {
				const p = (m[1] ?? "").trim();
				if (p && !paths.includes(p)) paths.push(p);
			}
			APPLY_PATCH_FILE_HEADER_RE.lastIndex = 0;
			APPLY_PATCH_MOVE_HEADER_RE.lastIndex = 0;
		}
	} else if (action.kind === ACTION_FILE_OPERATION) {
		if (typeof action.path === "string" && action.path.trim() !== "") {
			paths.push(action.path.trim());
		}
	}
	return paths;
}

function colColdToolName(event: UnifiedHookEvent): string | null {
	const action = event.action;
	if (action.kind === ACTION_TOOL_CALL) return action.tool_name;
	if (action.kind === ACTION_FILE_OPERATION) return FILE_OPERATION_DEFAULT_TOOL;
	return null;
}

function coldGraphShardBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	if (process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE === "1") return null;
	const toolName = colColdToolName(event);
	if (!toolName || !GRAPH_SHARD_WRITE_TOOLS.has(toolName)) return null;
	const paths = extractColdTargetPaths(event);
	if (paths.length === 0) return null;
	const cwd = event.context?.cwd ?? process.cwd();
	for (const t of paths) {
		const abs = isAbsolute(t) ? t : resolvePath(cwd, t);
		try {
			if (!existsSync(abs)) continue;
			const m = abs.match(/\.[^./]+$/);
			const ext = m ? m[0] : "";
			const shardPath = ext ? abs.slice(0, -ext.length) + ".graph" + ext : abs + ".graph";
			if (!existsSync(shardPath)) continue;
			const sourceMtime = statSync(abs).mtimeMs;
			const shardMtime = statSync(shardPath).mtimeMs;
			if (shardMtime < sourceMtime - GRAPH_SHARD_STALENESS_GRACE_MS) continue;
			return (
				"[interlinked:graph-pred][harness-offline] Cannot evaluate the graph-prediction protocol because the harness daemon is unreachable (or did not respond in time), but " +
				abs +
				" has a fresh Supermodel shard colocated. Edits to E-fresh files MUST go through the predict/reveal/reconcile loop. " +
				"Start the harness with: interlinked harness start  (or restart it). Once it's up, retry your edit. " +
				"Override (advanced, defeats the protocol): set INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1."
			);
		} catch {
			continue;
		}
	}
	return null;
}

function encodeColdFallback(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	reason: string,
): HookEntryResult {
	// Cold fallback: allow the action and report the skipped evaluator only
	// on stderr. Do not put timeout/socket failures in decision warnings:
	// Claude routes PreToolUse warnings into model-visible additionalContext,
	// and transport failures are not useful task context for the agent.
	// The full evaluator is too heavy to run inline in the hook process in
	// every runner — the correct place to add cold checks is here as this
	// module grows, but never at the cost of the per-tool-class budget.
	//
	// Exception: fail-closed graph-prediction gate. If the agent is about to
	// edit a file with a fresh `.graph.*` shard and we can't reach the
	// evaluator, block — the protocol requires it.
	const shardBlockReason = coldGraphShardBlockReason(event);
	if (shardBlockReason) {
		const blockDecision: HarnessDecision = {
			decision: "block",
			reason: shardBlockReason,
		};
		const blockOutput = adapter.encodeDecision(blockDecision, event);
		const notice = `[interlinked] ${reason}; graph-shard fail-closed gate engaged\n`;
		return {
			stdout: blockOutput.stdout,
			stderr: blockOutput.stderr ? `${blockOutput.stderr}\n${notice}` : notice,
			exit_code: blockOutput.exit_code,
			fell_back: true,
		};
	}
	const decision: HarnessDecision = {
		decision: "allow",
	};
	const output = adapter.encodeDecision(decision, event);
	const fallbackNotice = `[interlinked] ${reason}; evaluator skipped\n`;
	return {
		stdout: output.stdout,
		stderr: output.stderr ? `${output.stderr}\n${fallbackNotice}` : fallbackNotice,
		exit_code: output.exit_code,
		fell_back: true,
	};
}

async function readStdinJson(): Promise<unknown> {
	const data = await new Promise<string>((resolve) => {
		let collected = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			collected += chunk;
		});
		process.stdin.on("end", () => resolve(collected));
		process.stdin.on("error", () => resolve(collected));
	});
	if (!data) return {};
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(data);
	} catch {
		parsed = {};
	}
	return parsed;
}

function argOrEnv(flag: string): string | undefined {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === flag && i + 1 < args.length) return args[i + 1];
		if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
	}
	return undefined;
}

function isDirectRun(): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	void mainFromStdin().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[interlinked] hook failed open: ${message}\n`);
		process.exit(0);
	});
}
