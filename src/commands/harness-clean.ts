// ===========================================
// `interlinked harness clean` — stale state-file removal
// ===========================================
// Removes a leftover `harness.sock` + `harness.pid` pair after a crash, but
// only when no live daemon currently owns them. Refuses (exits non-zero) if
// the daemon is alive — the user is expected to `harness stop` first.
//
// Spec: docs/plans/free-cli-adoption/_phase-e-operational-commands.md §3.

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { classifyDaemonSocket } from "../harness/session-paths.js";
import { getConfigDir } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { isHarnessRunning } from "./harness.js";

export interface HarnessCleanOptions {
	/** Machine-readable output. */
	json?: boolean;
}

interface CleanOutputJson {
	ok: boolean;
	removed: string[];
	reason?: string;
}

/**
 * Remove stale `.interlinked/harness.sock` + `harness.pid` left behind by a
 * previous daemon crash. Refuses if the daemon is currently running — the
 * user must `harness stop` first to guarantee no in-flight reads/writes.
 */
export async function harnessCleanCommand(options: HarnessCleanOptions = {}): Promise<void> {
	const mode = getOutputMode(options);
	const cwd = process.cwd();
	const dir = getConfigDir(cwd);
	const sockPath = join(dir, "harness.sock");
	const pidPath = join(dir, "harness.pid");
	// Snapshot existence BEFORE the liveness probe — `isHarnessRunning`
	// auto-cleans stale pid files as a side effect, which would otherwise
	// rob us of the ability to report it as "removed" to the user.
	const pidExisted = existsSync(pidPath);
	const sockExisted = existsSync(sockPath);
	// A missing or stale PID never establishes ownership of a socket path.
	// Preserve both records while a listener accepts connections, even if its
	// protocol is unresponsive. Probe before the PID helper can remove records.
	if ((await classifyDaemonSocket(sockPath)) !== "absent") {
		outputError(mode, "Harness socket is occupied. Stop its owner before cleaning harness state.");
		return;
	}

	const status = isHarnessRunning(cwd);
	if (status.running && status.pid !== undefined) {
		outputError(
			mode,
			`Harness is currently running (PID ${status.pid}). Stop it first: interlinked harness stop`,
		);
		return;
	}
	if ((await classifyDaemonSocket(sockPath)) !== "absent") {
		outputError(mode, "Harness socket became occupied. Stop its owner before cleaning harness state.");
		return;
	}

	const removed: string[] = [];
	if (pidExisted) {
		// May already be gone (auto-cleaned by isHarnessRunning). Either way,
		// the user invoked `clean` because they wanted it gone — count it.
		try {
			if (existsSync(pidPath)) unlinkSync(pidPath);
			removed.push(pidPath);
		} catch (err) {
			void err; // Best-effort: we can't help if perms are wrong; carry on.
		}
	}
	if (sockExisted) {
		try {
			if (existsSync(sockPath)) unlinkSync(sockPath);
			removed.push(sockPath);
		} catch (err) {
			void err;
		}
	}

	const payload: CleanOutputJson = { ok: true, removed };
	output(mode, payload, {
		json: () => payload,
		normal: () => formatHumanOutput(payload),
	});
}

function formatHumanOutput(payload: CleanOutputJson): string {
	if (payload.removed.length === 0) {
		return c.dim("No stale harness state files found.");
	}
	const lines: string[] = [];
	lines.push(c.green(`Removed ${payload.removed.length} stale file${payload.removed.length === 1 ? "" : "s"}:`));
	for (const path of payload.removed) {
		lines.push(`  ${c.dim(path)}`);
	}
	return lines.join("\n");
}
