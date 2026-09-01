// ===========================================
// PostToolUse test-process backpressure
// ===========================================
// Test runners are intentionally heavyweight (Vitest can consume hundreds of
// MB while transforming this repository).  A daemon serves several agent
// sessions at once, so a per-request concurrency limit is not a limit at all:
// each socket request can start its own runner.  This project-scoped,
// cross-process gate admits one affected/ripple test process and declines
// overlapping advisory work, even when several agent CLIs are running. The
// caller surfaces that deferral instead of building an unbounded queue.

import { runProcessAsync } from "../check-engine/spawn-async.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";

interface TestProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	/** Optional cancellation from the owning hook request. */
	signal?: AbortSignal;
	/** Internal composition seam: the caller already owns this project's heavy
	 * process lease across a larger compiler+test transaction. Ordinary callers
	 * must omit it so this function acquires nonqueueing admission itself. */
	admissionAlreadyHeld?: boolean;
}

type TestProcessOutcome =
	| {
			kind: "completed";
			code: number;
			stdout: string;
			stderr: string;
	  }
	| {
			kind: "deferred";
			reason: "busy" | "timeout" | "interrupted" | "unavailable";
	  };

/**
 * Run one test process without blocking the daemon's event loop.  Concurrent
 * callers get `busy` immediately; PostToolUse checks are advisory after the
 * edit landed, so bounded honest deferral is safer than a queue that makes
 * health probes time out and eventually exhausts system memory.
 */
export async function runBoundedTestProcess(
	spec: TestProcessSpec,
): Promise<TestProcessOutcome> {
	const release = spec.admissionAlreadyHeld
		? undefined
		: tryAcquireProjectHeavyProcessLease(spec.cwd);
	if (!spec.admissionAlreadyHeld && !release) return { kind: "deferred", reason: "busy" };
	try {
		let result: Awaited<ReturnType<typeof runProcessAsync>>;
		try {
			result = await runProcessAsync(spec.command, spec.args, {
				cwd: spec.cwd,
				timeout: spec.timeoutMs,
				...(spec.signal ? { signal: spec.signal } : {}),
			});
		} catch {
			// Invalid launch arguments can make node:child_process throw before it
			// can emit the ordinary ENOENT-style `error` event. Preserve this API's
			// total no-verdict contract and release the shared slot in `finally`.
			return { kind: "deferred", reason: "unavailable" };
		}
		if (result.timedOut) return { kind: "deferred", reason: "timeout" };
		if (result.killed) return { kind: "deferred", reason: "interrupted" };
		if (result.code === null) return { kind: "deferred", reason: "unavailable" };
		// POSIX wrappers such as npm can translate a child signal into the
		// conventional 128 + signum exit code (143 for SIGTERM, 137 for
		// SIGKILL/OOM). That run did not complete its assertions and therefore
		// cannot be classified as an ordinary red suite.
		if (result.code >= 128) return { kind: "deferred", reason: "interrupted" };
		return {
			kind: "completed",
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} finally {
		release?.();
	}
}
