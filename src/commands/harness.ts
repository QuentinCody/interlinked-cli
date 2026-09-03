// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { existsSync } from "node:fs";
import { distStaleness, stalenessWarning } from "../harness/build-staleness.js";
import { readRecentDaemonEvents } from "../harness/daemon-ledger.js";
import { recordInheritedDaemonSpawn } from "../harness/handover-churn.js";
import { detectEnforcementGaps, formatEnforcementGapWarning } from "../harness/enforcement-gap.js";
import { acquireStartupLock } from "../harness/startup-lock.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
// Lifecycle/status helpers extracted to a sibling to hold this file under the
// per-file line cap. Behavior is byte-identical; these are the same functions
// the start / restart / status commands have always called.
import {
	classifyHarnessLiveness,
	livenessStatusValue,
	probeHarnessLive,
	probeHarnessSocket,
	zombieWarningLine,
} from "./harness-liveness.js";
import { reapOrphanHarnessesVerified } from "./harness-daemon-control.js";
import { beginRestartAttempt, failRestartAttempt, reportRestartDecision, resolveRestartAction } from "./harness-restart-guard.js";
import {
	buildHarnessSpawnArgs,
	cleanStaleRestartFiles,
	reportPendingStart,
	daemonizeHarness,
	framedSocketLines,
	lockedJsonRestartStart,
	protocolStatusLines,
	startHarnessForeground,
	stopRunningHarnessForRestart,
} from "./harness-lifecycle-helpers.js";
import {
	ensureDistFresh,
	getHarnessServerPath,
	getSocketPath,
	isHarnessRunning,
} from "./harness-process.js";
import {
	parseHarnessProtocol,
	readActiveMode,
	readFramedSocketStatuses,
	readLastLatencyTimestamp,
	readProtocolStatus,
	readRssMb,
} from "./harness-status-helpers.js";
// `interlinked harness health` — check-health governance report (Tricorder-
// style demotion signal over the recurrence log). Implementation lives in a
// sibling to hold this file under the per-file line cap.
export { harnessHealthCommand } from "./harness-health.js";
// `interlinked harness stop` / `interlinked harness test` — daemon shutdown
// and synthetic-event probe. Implementation lives in a sibling to hold this
// file under the per-file line cap; behavior is byte-identical.
export { harnessStopCommand, harnessTestCommand } from "./harness-stop-command.js";
export type { ReapResult } from "./harness-process.js";
// Re-export the process/orphan-management surface so existing importers of
// `./harness.js` (init, enable, doctor, harness-reap, harness-clean, skill,
// index, tests) keep a byte-for-byte-identical public API after the split.
export { getSocketPath, isHarnessRunning } from "./harness-process.js";


// ===========================================
// harness start
// ===========================================

export async function harnessStartCommand(opts: {
	daemon?: boolean;
	verbose?: boolean;
	json?: boolean;
	protocol?: string;
	sessionId?: string;
	/** Internal restart handoff: the incumbent-safe build preflight already ran. */
	buildFreshness?: "preflight_complete";
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const protocol = parseHarnessProtocol(opts.protocol);
	const sessionId = opts.sessionId || "default";

	// STARTUP MUTEX (2026-08-15). Concurrent starts — an agent, a hook self-heal,
	// a build-refresh handover, all inside one second — used to race to bind, and
	// the losers reaped the winner on their way past. One winner binds; everyone
	// else waits on the socket and reports. Losers must NOT reap, bind, or record
	// a startup failure, so this gate is the FIRST thing the command does.
	const lock = acquireStartupLock(cwd);
	if (!lock.acquired) {
		await reportPendingStart(cwd, lock.holder?.pid ?? null, opts);
		return;
	}

	try {
		// A protocol round-trip outranks pid files. A healthy daemon can keep
		// serving after its pid file is lost; reaping before this check used to
		// classify that exact process as an orphan, kill it, and start a loop.
		if (await probeHarnessSocket(cwd)) {
			const liveStatus = isHarnessRunning(cwd);
			recordInheritedDaemonSpawn(cwd, "refused", "daemon socket already serving");
			output(
				mode,
				{ already_running: true, pid: liveStatus.pid, reaped: [] },
				{
					json: () => ({ status: "already_running", pid: liveStatus.pid, reaped: [] }),
					normal: () =>
						liveStatus.pid === undefined
							? "Harness already running (socket answered; pid file unavailable)"
							: `Harness already running (PID ${liveStatus.pid})`,
				},
			);
			return;
		}

		// Reap BEFORE the already-running check (2026-07-28: orphans accumulated
		// for hours because the reap only ran on the spawn path — one held 743MB
		// since 09:15 while the live daemon starved). Liveness-verified: a daemon
		// that ANSWERS its socket is never a reap victim.
		// A live PID without a protocol answer is a zombie, not readiness. Include
		// the pid-file daemon in the verified takeover sweep; answering sockets
		// were already protected above and are protected again inside the reaper.
		await reapOrphanHarnessesVerified(cwd, { killAll: true });

		// A direct start owns its build preflight. Restart performs the same work
		// before stopping the incumbent and marks the handoff so a second failed
		// build cannot discover itself only after the old daemon is gone.
		if (opts.buildFreshness !== "preflight_complete") ensureDistFresh({ quiet: mode === "json" });

		const serverPath = getHarnessServerPath();
		if (!serverPath || !existsSync(serverPath)) {
			recordInheritedDaemonSpawn(cwd, "no_artifact", "harness server artifact missing");
			outputError(
				mode,
				serverPath
					? `Harness server not found at ${serverPath}`
					: "Harness server not found. Ensure interlinked-cli is installed correctly or run from the source checkout.",
			);
			return;
		}

		const nodePath = process.execPath; // Use the same Node binary running the CLI
		const args = buildHarnessSpawnArgs(serverPath, cwd, protocol, sessionId, opts);

		if (opts.daemon !== false) {
			await daemonizeHarness({
				mode,
				cwd,
				nodePath,
				spawnArgs: args,
				protocol,
				sessionId,
				serverPath,
			});
		} else {
			startHarnessForeground(mode, nodePath, args, cwd);
		}
	} catch (err) {
		// Terminal for an inherited attempt: no successor is coming (idempotent).
		recordInheritedDaemonSpawn(cwd, "start_failed", "start threw");
		outputError(mode, err instanceof Error ? err.message : String(err));
	} finally {
		lock.release();
	}
}

// ===========================================
// harness restart
// ===========================================

export async function harnessRestartCommand(opts: {
	daemon?: boolean;
	verbose?: boolean;
	json?: boolean;
	protocol?: string;
	sessionId?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const protocol = parseHarnessProtocol(opts.protocol);
	const sessionId = opts.sessionId || "default";

	try {
		// Pre-flight (2026-08-22 postmortem): defer to an in-flight start, or
		// back off under the churn backstop, BEFORE ever calling
		// `stopRunningHarnessForRestart` — see harness-restart-guard.ts for the
		// race this closes. Only "proceed"/"deferred-timeout" fall through to the
		// stop+respawn sequence below; the other two verdicts are terminal.
		// Attempt-ID protocol: adopt the inherited id (automatic handover) or
		// mint one (manual restart), write the non-counting intent row — which
		// also upgrades the daemon's `signal` exit to `explicit-restart` in
		// `describeLastExit` — and keep the id in env for the daemon spawn.
		const attemptId = beginRestartAttempt(cwd);
		const decision = await resolveRestartAction(cwd);
		if (decision.action !== "proceed") {
			reportRestartDecision(mode, cwd, decision, { attemptId });
			if (decision.action !== "deferred-timeout") return;
		}
		// Rebuild BEFORE stopping the incumbent, in both human and JSON modes.
		// A compiler failure must leave the known-good daemon serving rather
		// than turn a stale checkout into an avoidable guard outage. A source
		// edit racing after this point belongs to the daemon's build watcher;
		// deliberately do not start a second fallible build after the stop.
		ensureDistFresh({ quiet: mode === "json" });
		// SIGTERM → escalate to SIGKILL if wedged. The helper owns its stderr
		// nudges and the survived-SIGKILL fatal error; on survival the terminal
		// row resolves the attempt before aborting.
		const { oldPid, survived } = await stopRunningHarnessForRestart(cwd, mode);
		if (survived) {
			failRestartAttempt(cwd, attemptId, "old daemon survived SIGKILL");
			return;
		}

		await cleanStaleRestartFiles(cwd);

		// Start fresh — but for JSON mode, emit a single combined payload. Both
		// branches respawn under the startup mutex: the human branch through
		// `harnessStartCommand`, the JSON branch through `lockedJsonRestartStart`
		// (which was the last unlocked start path — see its doc comment).
		if (mode === "json") {
			await lockedJsonRestartStart(cwd, opts, protocol, sessionId, oldPid, mode);
		} else {
			await harnessStartCommand({ ...opts, buildFreshness: "preflight_complete" });
		}
	} catch (err) {
		recordInheritedDaemonSpawn(cwd, "start_failed", "restart threw"); // terminal (idempotent)
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// harness status
// ===========================================

export async function harnessStatusCommand(opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const processStatus = isHarnessRunning(cwd);
		const socketExists = existsSync(getSocketPath(cwd));

		// A pid is not evidence. Ask the socket to ANSWER — that (plus any
		// framed daemon's health RPC below) is what decides the three states
		// this report can print. Before this, "running (PID …)" was printed on
		// pid-liveness alone, directly above "Socket: not found", with no line
		// admitting the two together mean the guard is off (audit F1/F12).
		const rawAnswered = await probeHarnessLive(cwd, processStatus.running);

		// Operational signals: orphan count, RSS of active daemon, configured
		// mode, last-event timestamp. Each is best-effort — a missing data
		// point shouldn't fail the whole status call.
		const orphanInfo = await reapOrphanHarnessesVerified(cwd, { dryRun: true });
		const rssMb =
			processStatus.running && processStatus.pid !== undefined
				? readRssMb(processStatus.pid)
				: null;
		const activeMode = readActiveMode(cwd);
		const lastEventAt = readLastLatencyTimestamp(cwd);
		const protocolStatus = readProtocolStatus(cwd);
		const framedSockets = await readFramedSocketStatuses(cwd);
		const staleness = distStaleness(cwd);
		// A framed daemon that returned its health RPC also answered — a
		// framed-only deployment has no raw socket to probe, and calling that
		// a zombie would be the same lie in the other direction.
		const socketAnswered = rawAnswered || framedSockets.some((f) => f.health !== null);
		const liveness = classifyHarnessLiveness({
			processRunning: processStatus.running,
			socketAnswered,
		});

		const result = {
			// `running` means exactly "the legacy harness.pid names a live
			// process" — NOT "the harness is serving" (that is `liveness`).
			// `pid_running` is the unambiguous alias; in a framed-only
			// deployment `running` can be false while liveness is "listening"
			// (review 2026-08-26: both readings were possible before).
			running: processStatus.running,
			pid_running: processStatus.running,
			liveness,
			socket_answered: socketAnswered,
			pid: processStatus.pid,
			socket: socketExists,
			socket_path: getSocketPath(cwd),
			raw_socket: {
				path: getSocketPath(cwd),
				exists: socketExists,
				health: socketExists ? "legacy-raw" : "missing",
			},
			framed_sockets: framedSockets,
			protocol_status: protocolStatus,
			protocol_version: protocolStatus?.protocol_version ?? null,
			last_raw_event_at: protocolStatus?.last_raw_event_at ?? null,
			last_framed_event_at: protocolStatus?.last_framed_event_at ?? null,
			framed_error_count: protocolStatus?.framed_error_count ?? null,
			framed_timeout_count: protocolStatus?.framed_timeout_count ?? null,
			orphan_count: orphanInfo.candidates.length,
			rss_mb: rssMb,
			mode: activeMode,
			last_event_at: lastEventAt,
			build_stale: staleness?.stale ?? false,
		};

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Harness Status"));
				lines.push(kvLine("Status", livenessStatusValue(liveness, processStatus.pid)));
				lines.push(
					kvLine(
						"Socket",
						socketExists ? c.green(getSocketPath(cwd)) : c.dim("not found"),
					),
				);
				// The pairing the audit called self-contradictory now always
				// carries its explanation: a live pid with nothing answering is
				// named, in one place, as the guard being OFF.
				if (liveness === "zombie") lines.push(c.red(`  ${zombieWarningLine(processStatus.pid)}`));
				if (protocolStatus) lines.push(...protocolStatusLines(protocolStatus));
				lines.push(...framedSocketLines(framedSockets));
				if (rssMb !== null) {
					lines.push(kvLine("RSS", `${rssMb} MB`));
				}
				const sw = stalenessWarning(staleness);
				if (sw) lines.push(kvLine("Build", c.yellow(sw)));
				if (activeMode !== null) {
					lines.push(kvLine("Mode", activeMode));
				}
				if (lastEventAt !== null) {
					lines.push(kvLine("Last event", lastEventAt));
				}
				const orphanLine =
					orphanInfo.candidates.length === 0
						? c.dim("0")
						: c.yellow(
								`${orphanInfo.candidates.length} (run 'interlinked harness reap' to inspect)`,
							);
				lines.push(kvLine("Orphans", orphanLine));
				// The guard fails OPEN, so an outage is silent: work proceeds
				// ungated and nothing says so. Measured 2026-08-05/06 in this
				// repo — a wedged daemon held the pid file for 9h07m while
				// serving nothing, and a 2h agent wave ran with the content gate
				// never firing. State the gap in the unit that matters: how long,
				// and whether it is still open.
				const gapWarning = formatEnforcementGapWarning(
					detectEnforcementGaps(readRecentDaemonEvents(cwd), Date.now()),
					Date.now(),
				);
				if (gapWarning) {
					lines.push("");
					lines.push(c.yellow(`  ${gapWarning}`));
				}
				if (!processStatus.running) {
					lines.push("");
					lines.push(c.dim("  Start with: interlinked harness start"));
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
