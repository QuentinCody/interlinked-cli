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

import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerAdapter } from "./harness/adapters/types.js";
import { methodForPhase } from "./harness/daemon-protocol.js";
import type { HarnessDecision } from "./harness/types.js";
import { resetSupervisorBackoff } from "./harness/supervisor-backoff.js";
import type { RunnerId, UnifiedHookEvent } from "./harness/unified-event.js";
import {
	coldDestructiveCommandBlockReason,
	coldGraphShardBlockReason,
	coldLargeFileBlockReason,
	coldMergeConflictBlockReason,
	coldPackageInstallBlockReason,
} from "./hook-entry-cold-gates.js";
import {
	attemptDaemonSelfHealDetailed,
	type SelfHealAttempt,
} from "./hook-entry-daemon-gate.js";
import { daemonRecoveryRootFresh } from "./hook-entry-daemon-probe.js";
import { defaultTimeoutForPhase, isCodeEditEvent } from "./hook-entry-deadlines.js";
import { attemptSelfHealOnStop } from "./hook-entry-stop-self-heal.js";
import {
	buildUnifiedHookEvent,
	recordAdapterExecution,
	resolveHookAdapter,
	resolveHookDataDir,
} from "./hook-entry-event.js";
import { callHookDaemon, discoverSocket } from "./hook-entry-transport.js";
import { writeLastCheckArtifact, writeNoHarnessArtifact } from "./lib/last-check-writer.js";
import {
	acknowledgeSynchronousPostToolResult,
	drainLatePostToolWarnings,
} from "./lib/post-tool-warning-spool-client.js";

// Re-export for back-compat: tests import these from "./hook-entry.js".
export { isCodeEditEvent, discoverSocket };

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
	runner?: RunnerId | undefined;
	/** Explicit socket path (overrides discovery). */
	socketPath?: string | undefined;
	/** Hard timeout for the daemon call. Defaults to 2s. */
	timeout_ms?: number;
}

export interface HookEntryResult {
	stdout?: string | undefined;
	stderr?: string | undefined;
	exit_code: number;
	/** True if the hook fell back to cold evaluation. */
	fell_back: boolean;
}

/** Run a single hook invocation end-to-end, returning the encoded output.
 *  Does not read from process.stdin or write to process.stdout — that is the
 *  CLI wrapper's job. Keeps the core logic easily testable. */
export async function runHookEntry(opts: HookEntryOptions): Promise<HookEntryResult> {
	const adapter = resolveHookAdapter(opts);
	if (!adapter) {
		const detail = opts.runner
			? `unknown runner id: ${opts.runner}`
			: "no runner detected from env; pass --runner=<id> or set INTERLINKED_RUNNER";
		return { stderr: `[interlinked] ${detail}\n`, exit_code: 0, fell_back: true };
	}

	let event = buildUnifiedHookEvent(adapter, opts.nativeJson, opts.nativeEventName);
	const postDeliveryToken = event.phase === "post-tool" ? randomUUID() : null;
	if (postDeliveryToken) {
		event = { ...event, post_delivery_token: postDeliveryToken, post_delivery_pid: process.pid };
	}

	// The daemon-liveness gate keys on the TOOL CALL's project (the event's
	// cwd), not the hook process's cwd — the hook may be spawned from anywhere
	// (a parent shell, a test harness), but `event.context.cwd` is the project
	// whose harness should be guarding this action. It is always a real
	// string by construction — every adapter's `normalizeNativeHookEvent`
	// falls back to `process.cwd()` at the parse boundary — so it never
	// needs a fallback to `opts.cwd`/`process.cwd()` here.
	const gateCwd = event.context.cwd;
	recordAdapterExecution(adapter, event, gateCwd);
	maybeSelfHealOnStop(event, gateCwd, opts.env);
	// Discover the socket in the SAME project the daemon gate keys on (the event's
	// cwd), not the hook process's cwd: a client that launches the hook binary
	// from outside the repo would otherwise miss the healthy daemon under the
	// event project and fall through to the fail-closed cold path on every call
	// (finding 2026-06).
	const socketPath = opts.socketPath ?? discoverSocket(gateCwd, event.session_id);
	const dataDir = resolveHookDataDir(gateCwd, socketPath);
	const lateWarnings =
		event.phase === "pre-tool" && dataDir
			? drainLatePostToolWarnings(dataDir, event.session_id)
			: [];
	if (!socketPath) {
		// No daemon available at all — cold fallback (which itself fails closed
		// when a daemon was running here and crashed; see encodeColdFallback).
		const cold = await encodeColdFallback(
			adapter,
			event,
			"daemon socket not found",
			gateCwd,
			opts.env,
			lateWarnings,
		);
		return cold;
	}

	const method = methodForPhase(event.phase);
	const timeoutMs = opts.timeout_ms ?? defaultTimeoutForPhase(event);
	let decision: HarnessDecision;
	const fellBack = false;
	const callStartMs = Date.now();
	const result = await callHookDaemon({ socketPath, method, event, timeoutMs, env: opts.env });
	if (result.ok) {
		decision = result.decision;
		// A served RPC proves the daemon is healthy, so every earlier failed
		// self-heal is history: clear the supervisor's backoff ladder. Without
		// this reset the decay would persist across a full recovery and delay
		// the NEXT real outage's first heal by up to a minute.
		resetSupervisorBackoff(dirname(dirname(socketPath)));
	} else {
		writeNoHarnessArtifact(dirname(socketPath), event, Date.now() - callStartMs);
		return encodeColdFallback(
			adapter,
			event,
			result.reason,
			gateCwd,
			opts.env,
			lateWarnings,
		);
	}

	if (postDeliveryToken && dataDir) {
		decision = {
			...decision,
			warnings: acknowledgeSynchronousPostToolResult(
				dataDir,
				postDeliveryToken,
				decision.warnings ?? [],
			),
		};
	}
	if (lateWarnings.length > 0) {
		decision = {
			...decision,
			warnings: [...new Set([...(decision.warnings ?? []), ...lateWarnings])],
		};
	}

	// Feed the statusline's kinetic row (`.interlinked/last-check.txt`) —
	// the same artifact the generated .mjs hook writes. The socket lives at
	// <root>/.interlinked/harness.sock, so its dirname IS the data dir.
	writeLastCheckArtifact(dirname(socketPath), event, decision, Date.now() - callStartMs);

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
/**
 * Claude Code's Stop/SubagentStop re-entrancy contract: when the agent is
 * already continuing BECAUSE a stop hook fired, the runner sets
 * `stop_hook_active: true`, and the hook must yield. On a Stop event,
 * `hookSpecificOutput.additionalContext` is not a note — it is a continue
 * instruction — so a hook that keeps emitting it re-prompts the model forever.
 * Observed live (mcp-client-bio, 2026-07-28): "A hook blocked the turn from
 * ending 9 consecutive times — overriding and ending turn", every turn, until
 * the runner's cap force-ended it.
 *
 * This guard bounds the whole CLASS: whatever a future code path emits on
 * Stop, it gets exactly one pass — the first Stop of a turn arrives with the
 * flag unset, so every nudge still surfaces once — and the re-entry pass
 * yields unconditionally.
 */
export function isStopHookReentry(eventName: string, nativeJson: unknown): boolean {
	if (eventName !== "Stop" && eventName !== "SubagentStop") return false;
	if (!nativeJson || typeof nativeJson !== "object") return false;
	// Both casings: runners deliver snake_case OR camelCase for the same field
	// (this repo's payload-casing map lists this exact pair). Reading one casing
	// only would silently disable the guard under the other — and the loop this
	// guard exists to prevent would return for that runner alone.
	const raw = nativeJson as { stop_hook_active?: unknown; stopHookActive?: unknown };
	return raw.stop_hook_active === true || raw.stopHookActive === true;
}

/** Fires {@link attemptSelfHealOnStop} for a Stop/SubagentStop event and
 *  discards the result — extracted so `runHookEntry` gains a single
 *  unconditional call (no branch) rather than an inline `if`, keeping it
 *  under the cyclomatic cap. `isStopHookReentry` already filtered the
 *  re-entry pass upstream in `mainFromStdin`, so a genuine Stop reaches this
 *  at most once. Purely observational: never changes the hook decision. */
function maybeSelfHealOnStop(
	event: UnifiedHookEvent,
	cwd: string | undefined,
	env: NodeJS.ProcessEnv,
): void {
	// Gate on phase HERE, not just inside attemptSelfHealOnStop: every other
	// phase (pre-tool above all) is the hot path, and skipping the call
	// entirely avoids paying resolveGateRoot/readGuardDisable/ledger-tail work
	// on every tool call for a check that can only ever apply to Stop events.
	if (event.phase !== "stop" && event.phase !== "subagent-stop") return;
	try {
		attemptSelfHealOnStop(event, cwd, env);
	} catch {
		// Best-effort recovery attempt only — an unexpected throw here must
		// never take down the hook that is supposed to make things work.
	}
}

async function mainFromStdin(): Promise<void> {
	const nativeJson = await readStdinJson();
	const nativeEventName = argOrEnv("--event") ?? process.env.INTERLINKED_EVENT ?? "PreToolUse";
	if (isStopHookReentry(nativeEventName, nativeJson)) process.exit(0);
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

/** Build a cold fail-closed BLOCK result for a named gate, appending the
 *  "<gate> fail-closed gate engaged" notice to stderr. Shared by every cold gate
 *  so the encode + notice shape is defined once. */
function coldBlockResult(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	fallbackReason: string,
	gateLabel: string,
	blockReason: string,
	warnings: readonly string[] = [],
): HookEntryResult {
	const blockOutput = adapter.encodeDecision(
		{ decision: "block", reason: blockReason, warnings: [...warnings] },
		event,
	);
	const notice = `[interlinked] ${fallbackReason}; ${gateLabel} fail-closed gate engaged\n`;
	return {
		stdout: blockOutput.stdout,
		stderr: blockOutput.stderr ? `${blockOutput.stderr}\n${notice}` : notice,
		exit_code: blockOutput.exit_code,
		fell_back: true,
	};
}

/** True when the runner's native payload marked this a simulated event
 *  (`interlinked harness test --write/--edit`). The unified event carries no
 *  `dry_run` field of its own, so the raw payload is the only source. Every
 *  evaluator that PERSISTS must honor this — a read-only probe that mutates
 *  state is how three simulated writes opened real transient debt on 2026-08-04. */
function isDryRunEvent(event: UnifiedHookEvent): boolean {
	const raw = event.raw;
	if (typeof raw !== "object" || raw === null) return false;
	// SAFETY: object-ness checked above; the field is read as unknown and
	// compared to `true`, so a non-boolean value can never be trusted.
	return (raw as { dry_run?: unknown }).dry_run === true;
}

async function encodeColdFallback(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	reason: string,
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
	lateWarnings: readonly string[] = [],
): Promise<HookEntryResult> {
	// Cold fallback: allow the action and report the skipped evaluator only
	// on stderr. Do not put timeout/socket failures in decision warnings:
	// Claude routes PreToolUse warnings into model-visible additionalContext,
	// and transport failures are not useful task context for the agent.
	// The full evaluator is too heavy to run inline in the hook process in
	// every runner — the correct place to add cold checks is here as this
	// module grows, but never at the cost of the per-tool-class budget.
	//
	// Recovery is phase-independent: any ordinary hook invocation can revive a
	// missing daemon. The decision to launch is cross-process single-flight and
	// backoff-bounded. Crucially, daemon absence itself is NOT a blanket block:
	// the deterministic inline gates below still refuse dangerous operations,
	// while reads, diagnostics, and repair commands remain executable. This
	// prevents a stale pid/ledger or a missing server artifact from deadlocking
	// every agent in the repository.
	const recoveryRoot = await daemonRecoveryRootFresh(event, cwd, env);
	const recoveryAttempt = recoveryRoot
		? attemptDaemonSelfHealDetailed(
				recoveryRoot,
				env,
				isDryRunEvent(event) ? { dryRun: true } : {},
			)
		: null;

	// Exception: fail-closed graph-prediction gate. If the agent is about to
	// edit a file with a fresh `.graph.*` shard and we can't reach the
	// evaluator, block — the protocol requires it.
	// Cold fail-closed gate: merge-conflict markers are a guaranteed parse
	// error. Checked before the graph-shard gate — broken content is a more
	// immediate signal than the protocol-restart mechanics.
	const mergeBlockReason = coldMergeConflictBlockReason(event);
	if (mergeBlockReason) {
		return coldBlockResult(adapter, event, reason, "merge-conflict", mergeBlockReason, lateWarnings);
	}

	const shardBlockReason = coldGraphShardBlockReason(event);
	if (shardBlockReason) {
		return coldBlockResult(adapter, event, reason, "graph-shard", shardBlockReason, lateWarnings);
	}

	const destructiveReason = coldDestructiveCommandBlockReason(event);
	if (destructiveReason)
		return coldBlockResult(
			adapter,
			event,
			reason,
			"destructive-command",
			destructiveReason,
			lateWarnings,
		);

	const packageInstallReason = coldPackageInstallBlockReason(event);
	if (packageInstallReason)
		return coldBlockResult(
			adapter,
			event,
			reason,
			"supply-chain",
			packageInstallReason,
			lateWarnings,
		);

	// Quality gate, daemon-independent: enforce the per-file line cap inline so an
	// over-cap write does not slip through while the daemon is unreachable (the gap
	// that let a 797→802 edit cross the cap unblocked on a socket blip).
	const largeFileReason = coldLargeFileBlockReason(event);
	if (largeFileReason)
		return coldBlockResult(
			adapter,
			event,
			reason,
			"large-file cap",
			largeFileReason,
			lateWarnings,
		);
	const decision: HarnessDecision =
		lateWarnings.length > 0
			? { decision: "allow", warnings: [...lateWarnings] }
			: { decision: "allow" };
	const output = adapter.encodeDecision(decision, event);
	const fallbackNotice = `[interlinked] ${reason}; evaluator skipped${recoveryAttemptNotice(recoveryAttempt)}\n`;
	const functionTokenNotice = isCodeEditEvent(event)
		? "[interlinked:function-tokens:not-measured] function-token enforcement requires the running harness daemon and an exact language adapter; this cold-fallback edit was not measured\n"
		: "";
	return {
		stdout: output.stdout,
		stderr: output.stderr
			? `${output.stderr}\n${fallbackNotice}${functionTokenNotice}`
			: `${fallbackNotice}${functionTokenNotice}`,
		exit_code: output.exit_code,
		fell_back: true,
	};
}

/** One truthful clause for the recovery action this invocation observed. */
function recoveryAttemptNotice(attempt: SelfHealAttempt | null): string {
	if (!attempt) return "";
	switch (attempt.disposition) {
		case "launch-attempted":
			return "; daemon launch attempted but not yet verified";
		case "spawn-failed":
			return "; daemon launch was attempted but the spawn failed";
		case "startup-lock-held":
			return "; no launch by this hook (startup lock held)";
		case "retry-backoff":
			return "; no launch attempted (supervisor retry backoff active)";
		case "server-artifact-missing":
			return "; no launch attempted (daemon server artifact missing — rebuild or reinstall Interlinked)";
		case "self-heal-disabled":
			return "; no launch attempted (self-heal disabled)";
		case "guard-disabled":
			return "; no launch attempted (guard intentionally disabled)";
		case "no-project":
			return "; no launch attempted (no Interlinked project found)";
	}
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
	for (const [i, a] of args.entries()) {
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
		process.stderr.write(`[interlinked] hook runtime failed: ${message}\n`);
		process.exit(1);
	});
}
