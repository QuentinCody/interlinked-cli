import { isOverlayResponse } from "./tsc-overlay-wire.js";
// ===========================================
// TSC Overlay Sidecar — daemon-side client
// ===========================================
// Runs an overlay check by spawning the sidecar process (tsc-overlay-sidecar-
// main.ts) synchronously and reading its one-line JSON reply. This is a
// deliberate departure from the codebase's async-persistent SidecarManager
// pattern (content-scanner/sidecar-manager.ts) — see the module doc in
// tsc-overlay.ts for why, and DEVIATIONS.md-equivalent notes in the harness
// design doc. In short: the PreToolUse content-guard chain that calls this
// synchronously (diff-overlay.ts -> write-content-guards.ts) is fully
// synchronous end to end, and every other check-engine/tool-runners/*.ts
// module already spawns its external tool via spawnSync per call — this
// follows that exact, already-load-bearing convention rather than
// introducing a new async/Atomics bridge into one call site.
//
// Every failure mode (missing binary, crash, timeout, malformed reply,
// explicit {id,error}) yields a typed {status:"unavailable", reason} plus
// exactly one console.error line — the overlay guard's availability never
// depends on the sidecar being healthy, but consumers CAN now distinguish
// "checked clean" from "checker never ran" (the legacy wrapper collapses
// unavailable to `[]`). After SIDECAR_MAX_CONSECUTIVE_FAILURES in a row, the client stops
// even trying to spawn for SIDECAR_COOLDOWN_MS (one warning on ENTERING
// cooldown, silence while suppressed) — the per-call analog of "restart-on-
// crash with a cap ... then fall back" for a model with no persistent
// process to restart.

import { existsSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryAcquireProjectCompilerLease } from "../../project-compiler-gate.js";
import type { CheckResult } from "../types.js";
import {
	isSidecarErrorResponse,
	type SidecarOverlayRequest,
	type SidecarOverlayResponse,
	SIDECAR_PROTOCOL_VERSION,
} from "./tsc-overlay-protocol.js";
import type { RunTscOverlayInput } from "./tsc-overlay-service.js";

const nodeRequire = createRequire(import.meta.url);

/** Per-request timeout — spec §2 ("10s per-request timeout"). */
export const SIDECAR_REQUEST_TIMEOUT_MS = 10_000;

/** Consecutive-failure cap — spec §2 ("3 respawns/5min then fall back"),
 *  reinterpreted for the per-call spawn model: 3 failed calls in a row trip
 *  a cooldown instead of a 4th spawn attempt. */
export const SIDECAR_MAX_CONSECUTIVE_FAILURES = 3;

/** Cooldown window — spec §2's "5min" window. */
export const SIDECAR_COOLDOWN_MS = 5 * 60 * 1000;

/** Reply-stdout size cap — generous headroom over a realistic diagnostics
 *  payload; guards against a runaway/misbehaving sidecar filling the pipe. */
const SIDECAR_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

let consecutiveFailures = 0;
let cooldownUntilMs = 0;

/**
 * Typed outcome of one sidecar overlay run. "unavailable" means the checker
 * NEVER RAN (spawn failure, timeout/kill, malformed reply, explicit error,
 * cooldown) — it is not the same as "checked clean". Transactional consumers
 * (multi-edit, verify-changeset) must treat "unavailable" as a gate failure;
 * the legacy `runOverlayViaSidecar` wrapper collapses it to `[]` for the
 * ordinary advisory PreToolUse path, which surfaces the stderr warning only.
 */
export type SidecarOverlayOutcome =
	| { status: "ok"; findings: CheckResult[] }
	| { status: "unavailable"; reason: string };

/** Test-only reset — the module-level failure counters would otherwise leak
 *  across test cases sharing this module instance. */
export function _resetSidecarClientStateForTest(): void {
	consecutiveFailures = 0;
	cooldownUntilMs = 0;
}

function warnOnce(message: string): void {
	console.error(`[interlinked:tsc-overlay-sidecar] ${message}`);
}

/** Resolve where to find (and how to run) the sidecar entry point across
 *  three deployment layouts, mirroring the multi-candidate approach in
 *  rules/default-config-resolvers.ts:
 *    (1) prod / built dev tree: dist/harness/check-engine/tool-runners/tsc-overlay-sidecar-main.js
 *    (2) dev (tsx, no build): sibling .ts file, run via the tsx CLI
 *  Returns null when neither resolves — callers degrade to [] + warn. */
function resolveSidecarSpawnSpec(): { command: string; args: string[] } | null {
	const jsCandidates = [
		new URL("./tsc-overlay-sidecar-main.js", import.meta.url),
		new URL("../check-engine/tool-runners/tsc-overlay-sidecar-main.js", import.meta.url),
		new URL("./harness/check-engine/tool-runners/tsc-overlay-sidecar-main.js", import.meta.url),
	];
	for (const url of jsCandidates) {
		const p = fileURLToPath(url);
		if (existsSync(p)) return { command: process.execPath, args: [p] };
	}

	// Dev fallback: run the .ts source directly via the tsx devDependency.
	const tsPath = fileURLToPath(new URL("./tsc-overlay-sidecar-main.ts", import.meta.url));
	if (!existsSync(tsPath)) return null;
	try {
		const tsxPkg = nodeRequire.resolve("tsx/package.json");
		const tsxCli = join(dirname(tsxPkg), "dist/cli.mjs");
		if (!existsSync(tsxCli)) return null;
		return { command: process.execPath, args: [tsxCli, tsPath] };
	} catch {
		return null;
	}
}

function isCooldownActive(): boolean {
	return Date.now() < cooldownUntilMs;
}

function recordFailure(reason: string): SidecarOverlayOutcome {
	consecutiveFailures++;
	if (consecutiveFailures >= SIDECAR_MAX_CONSECUTIVE_FAILURES && !isCooldownActive()) {
		cooldownUntilMs = Date.now() + SIDECAR_COOLDOWN_MS;
		warnOnce(
			`${reason} — ${consecutiveFailures} consecutive failures, entering cooldown for ${Math.round(SIDECAR_COOLDOWN_MS / 1000)}s`,
		);
	} else {
		warnOnce(reason);
	}
	return { status: "unavailable", reason };
}

function recordSuccess(): void {
	consecutiveFailures = 0;
}

function parseReplyLine(stdout: string): SidecarOverlayResponse | null {
	const line = stdout.trim().split("\n").at(-1) ?? "";
	if (!line) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		return isOverlayResponse(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Run one overlay check by spawning the sidecar process. Synchronous —
 * matches the synchronous PreToolUse call chain (see module doc above).
 * Never throws; every failure mode returns a typed "unavailable" outcome so
 * consumers can distinguish "checked clean" from "checker never ran".
 */
export function runOverlayViaSidecarTyped(input: RunTscOverlayInput): SidecarOverlayOutcome {
	if (isCooldownActive()) {
		return {
			status: "unavailable",
			reason: "sidecar in cooldown after repeated consecutive failures",
		};
	}

	const spec = resolveSidecarSpawnSpec();
	if (!spec) return recordFailure("sidecar entry point not found (missing build?)");
	const releaseCompiler = tryAcquireProjectCompilerLease(input.projectRoot);
	if (!releaseCompiler) {
		const reason = "sidecar deferred: another TypeScript compiler is already running for this project";
		warnOnce(reason);
		return { status: "unavailable", reason };
	}

	const request: SidecarOverlayRequest = {
		id: 1,
		method: "overlayCheck",
		protocolVersion: SIDECAR_PROTOCOL_VERSION,
		params: input,
	};

	let result: SpawnSyncReturns<string>;
	try {
		result = spawnSync(spec.command, spec.args, {
			input: `${JSON.stringify(request)}\n`,
			encoding: "utf-8",
			timeout: SIDECAR_REQUEST_TIMEOUT_MS,
			maxBuffer: SIDECAR_MAX_BUFFER_BYTES,
		});
	} finally {
		releaseCompiler();
	}

	if (result.error) {
		return recordFailure(`sidecar spawn failed: ${result.error.message}`);
	}
	if (result.signal) {
		return recordFailure(`sidecar killed by signal ${result.signal} (timeout or external kill)`);
	}
	if (result.status !== 0) {
		return recordFailure(`sidecar exited with code ${result.status ?? "null"}`);
	}

	const reply = parseReplyLine(result.stdout);
	if (!reply) return recordFailure("sidecar returned a malformed reply");
	if (isSidecarErrorResponse(reply)) return recordFailure(`sidecar reported an error: ${reply.error}`);

	recordSuccess();
	// The sidecar answered; the compiler simply could not measure this file
	// (no single project claims it). Unavailable for the consumer, and never a
	// failure for the cooldown.
	if (reply.notMeasured !== undefined) return { status: "unavailable", reason: reply.notMeasured };
	return { status: "ok", findings: reply.result };
}

/**
 * Legacy shape — findings only. "unavailable" collapses to `[]`, which is
 * indistinguishable from "checked clean"; the stderr warning emitted inside
 * the typed run is the only visible signal. Kept for the ordinary advisory
 * PreToolUse path. Transactional callers (multi-edit, verify-changeset) must
 * use `runOverlayViaSidecarTyped` (via `runTscOverlayTyped`) instead.
 */
export function runOverlayViaSidecar(input: RunTscOverlayInput): CheckResult[] {
	const outcome = runOverlayViaSidecarTyped(input);
	return outcome.status === "ok" ? outcome.findings : [];
}

// Re-exported so callers that only need to detect "is this an ENOENT / dev-
// tree-without-build situation" without running a full request can probe
// cheaply (used by tsc-overlay.ts status/telemetry, if ever added).
export { resolveSidecarSpawnSpec as _resolveSidecarSpawnSpecForTest };
