// ===========================================
// interlinked doctor — System-requirements helpers
// ===========================================
// Surfaces CPU / memory / disk / tool / orphan-daemon signals from inside
// the existing `doctor` command. Phase E.1 of the Free CLI Phase-2 roadmap.
//
// Each helper returns a `CheckResult` shaped like the rest of the doctor
// command's results, so the caller can `push(...checks)` and render uniformly.
// Pure computation where possible — the outer command does the os/process
// reads and passes raw values in. Lets the entire surface be unit-testable
// without monkey-patching `os` or `child_process`.

import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cpus, freemem } from "node:os";

export type CheckStatus = "pass" | "fail" | "warn";

interface SystemCheckResult {
	name: string;
	status: CheckStatus;
	message: string;
}

const BYTES_PER_GB = 1024 ** 3;

/** Convert raw bytes to gigabytes as a double. */
export function bytesToGb(bytes: number): number {
	return bytes / BYTES_PER_GB;
}

/** Render a byte count as a one-decimal `<n>.<m> GB` string. */
export function formatGb(bytes: number): string {
	return `${bytesToGb(bytes).toFixed(1)} GB`;
}

/**
 * Check CPU core count. The post-event check pipeline runs ~6 concurrent
 * subprocesses at peak (Phase A); below 4 cores parallelism is throttled,
 * below 2 it stops being parallel at all.
 *
 * Pass ≥ 4 cores. Warn 2–3. Fail < 2 (single-core machine; some checks
 * will starve).
 */
export function checkCpuCores(coreCount: number): SystemCheckResult {
	if (coreCount >= 4) {
		return {
			name: "CPU cores",
			status: "pass",
			message: `${coreCount} cores — full parallel pipeline available`,
		};
	}
	if (coreCount >= 2) {
		return {
			name: "CPU cores",
			status: "warn",
			message: `${coreCount} cores — parallel pipeline will be throttled (recommended ≥ 4)`,
		};
	}
	return {
		name: "CPU cores",
		status: "fail",
		message: `${coreCount} cores — parallel pipeline disabled; expect serial check execution`,
	};
}

/**
 * Check available physical memory. The daemon's working set is ~200–500 MB;
 * the parallel check pipeline peaks at ~2 GB; we want at least 4 GB free for
 * comfortable operation alongside an editor and other apps.
 */
export function checkFreeMemoryGb(freeMemoryBytes: number): SystemCheckResult {
	const gb = bytesToGb(freeMemoryBytes);
	if (gb >= 4) {
		return {
			name: "Free memory",
			status: "pass",
			message: `${gb.toFixed(1)} GB free — comfortable headroom`,
		};
	}
	if (gb >= 2) {
		return {
			name: "Free memory",
			status: "warn",
			message: `${gb.toFixed(1)} GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)`,
		};
	}
	return {
		name: "Free memory",
		status: "fail",
		message: `${gb.toFixed(1)} GB free — parallel pipeline may swap or OOM (need ≥ 2 GB)`,
	};
}

/**
 * Check for orphan harness daemons. The daemon is always-on by default —
 * each CWD that's hosted a session keeps its harness alive until the user
 * runs `interlinked harness stop` or `interlinked harness clean`. A growing
 * count across many directories suggests the user should run `harness clean`
 * to reclaim daemons attached to repos they're no longer working in.
 */
export function checkOrphanHarnessCount(orphanCount: number | null): SystemCheckResult {
	if (orphanCount === null) {
		return {
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"could not determine orphan count — the daemon probe failed; re-run, or check 'interlinked harness status'",
		};
	}
	if (orphanCount === 0) {
		return {
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		};
	}
	const fixHint = ` Run 'interlinked harness reap --force' to clean up`;
	if (orphanCount < 10) {
		return {
			name: "Orphan harness daemons",
			status: "warn",
			message: `${orphanCount} orphan daemon${orphanCount === 1 ? "" : "s"} found — using extra memory.${fixHint}`,
		};
	}
	return {
		name: "Orphan harness daemons",
		status: "fail",
		message: `${orphanCount} orphan daemons found — significant memory pressure.${fixHint}`,
	};
}

/** What the CLI-resolvability probe observed about the `interlinked` verb. */
interface CliResolution {
	/** Path `whichinterlinked` returned, or null when it resolves nowhere. */
	resolvedPath: string | null;
	/** Whether the resolved entry's target actually exists (symlinks rot). */
	linkTargetExists: boolean;
}

const CLI_REPAIR_HINT =
	"Repair: (cd <interlinked-cli> && npm run build) then re-link, e.g. " +
	"ln -sf <interlinked-cli>/dist/index.js ~/.local/bin/interlinked";

/**
 * The `interlinked` verb must resolve on PATH and point at a real build.
 *
 * Red-team F5 (2026-08-09): the CLI vanished from PATH mid-session while
 * `~/.local/bin/interlinked` still existed. Nothing noticed — every operator
 * flow that shells out to `interlinked` (fleet unit verification included)
 * silently lost its verb, and a dangling symlink looks fine to `ls`.
 */
export function checkCliResolvable(res: CliResolution): SystemCheckResult {
	const name = "interlinked CLI on PATH";
	if (!res.resolvedPath) {
		return {
			name,
			status: "fail",
			message: `'interlinked' does not resolve on PATH — shell-outs to the CLI will fail. ${CLI_REPAIR_HINT}`,
		};
	}
	if (!res.linkTargetExists) {
		return {
			name,
			status: "fail",
			message: `'interlinked' resolves to ${res.resolvedPath} but its target is missing (dangling link). ${CLI_REPAIR_HINT}`,
		};
	}
	return { name, status: "pass", message: `resolves to ${res.resolvedPath}` };
}

/** Observe the live PATH state of the `interlinked` verb (shell + fs, no logic). */
export function observeCliResolution(): CliResolution {
	let resolvedPath: string | null = null;
	try {
		resolvedPath = execSync("command -v interlinked", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		resolvedPath = null; // non-zero exit = not on PATH
	}
	if (!resolvedPath) return { resolvedPath: null, linkTargetExists: false };
	// realpathSync throws on a dangling link (ENOENT) — that IS the failure this
	// probe reports, so it must never escape as an exception and take the whole
	// doctor run down with it.
	try {
		return { resolvedPath, linkTargetExists: existsSync(realpathSync.native(resolvedPath)) };
	} catch {
		return { resolvedPath, linkTargetExists: false };
	}
}

/**
 * Inspect the CPU + memory state, plus list orphan harness daemons
 * (interlinked-cli/dist/harness/server processes whose ppid ≤ 1).
 *
 * Combines all three into a single `runSystemChecks()` call the doctor
 * command consumes. Pure-shell side effects only happen inside; the
 * underlying primitives are unit-tested via the other exports above.
 */
/**
 * Orphan count from the canonical, protection-aware sweep — the one
 * `harness status` and `harness reap` use. It resolves which daemons are
 * actually ANSWERING over their sockets and excludes them, so the active
 * daemon (re-parented to pid 1, like every daemon) is never counted.
 *
 * Public API — `doctor.ts` awaits this and passes the result to
 * `runSystemChecks`. Best-effort: any failure yields 0 rather than a scary
 * fabricated number, matching the fallback scan's contract.
 */
export async function countVerifiedOrphans(cwd: string): Promise<number | null> {
	try {
		const { reapOrphanHarnessesVerified } = await import("./harness-daemon-control.js");
		const result = await reapOrphanHarnessesVerified(cwd, { dryRun: true });
		return result.candidates.length;
	} catch (e) {
		void e;
		// UNAVAILABLE, never 0. Returning 0 on a failed probe renders a green
		// "0 orphans — auto-reaper working as expected" row for a question that
		// was never answered, which is the same false-clean class the harness
		// exists to prevent: a check that cannot run must say so, not pass.
		return null;
	}
}

export function runSystemChecks(orphanCount: number | null): SystemCheckResult[] {
	const results: SystemCheckResult[] = [];
	results.push(checkCpuCores(cpus().length));
	results.push(checkFreeMemoryGb(freemem()));
	// REQUIRED, not optional: the count comes from the one protection-aware
	// sweep `harness status` and `harness reap` use, and `null` means the probe
	// could not answer — rendered as "could not determine", never as zero.
	// There is deliberately no local fallback scanner to fall back TO.
	results.push(checkOrphanHarnessCount(orphanCount));
	results.push(checkCliResolvable(observeCliResolution()));
	return results;
}

// The private `ps` scanner that used to live here is DELETED (2026-08-27).
// It was a second definition of "orphan" that disagreed with the canonical
// one: it counted every harness process whose parent had exited, which is
// every daemon by definition, so a healthy machine was told it had an orphan
// and offered a reap that would have killed the daemon doing the work. The one
// answer now comes from `countVerifiedOrphans` → `reapOrphanHarnessesVerified`,
// which resolves who is actually ANSWERING and protects them.
