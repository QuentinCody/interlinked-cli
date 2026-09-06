// Unit tests for the self-heal spawn arm that the integration test cannot reach:
// the daemon started, but the single-flight startup lease could not be handed to
// it (another process rewrote the lock while we were spawning). The child must be
// reaped and the attempt reported as a failed spawn, never as a recovery.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startupLockPath } from "./harness/startup-lock.js";
import { attemptDaemonSelfHealDetailed } from "./hook-entry-daemon-self-heal.js";

/** A pid no test may signal for real — process.kill is always stubbed here. */
const CHILD_PID = 4242;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "self-heal-lease-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("attemptDaemonSelfHealDetailed — lost startup lease", () => {
	it("reaps the spawned child and reports spawn-failed when the lease was stolen", () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

		const attempt = attemptDaemonSelfHealDetailed(
			root,
			{},
			{
				resolveServerPath: () => join(root, "server.js"),
				now: () => 1_000,
				dryRun: true,
				spawnDaemon: () => {
					// Another process wins the mutex between our acquire and our
					// transfer: the lock no longer names this pid, so the lease
					// cannot be handed to the child we just started.
					writeFileSync(
						startupLockPath(root),
						JSON.stringify({ pid: process.pid + 1, at: 1_000 }),
					);
					return CHILD_PID;
				},
			},
		);

		expect(attempt).toEqual({
			result: "skipped",
			disposition: "spawn-failed",
			launchAttempted: true,
		});
		expect(kill).toHaveBeenCalledWith(CHILD_PID, "SIGTERM");
	});
});
