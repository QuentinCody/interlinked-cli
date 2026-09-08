import { describeReason as describeMalformedReason } from "../../lib/settings-validator.js";
import { DEFAULT_AUTO_COORDINATION_CONFIG } from "../auto-coordinate.js";
import { startBuildRefreshWatcher } from "../build-refresh.js";
import { compileAllowlist } from "../content-scanner/allowlist.js";
import { makeHeapPressureLedger, recordDaemonEvent } from "../daemon-ledger.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import { sweepStaleLiveSnapshots } from "../live-snapshot.js";
import { startMutationCloudV3Background } from "../mutation/mutation-cloud-v3-background.js";
import { resolveApiKey } from "../policy-classifier.js";
import { loadRules, watchRulesFiles } from "../rules-loader.js";
import type { SocketLifecycle } from "../server-socket-lifecycle.js";
import { watchSettingsFiles } from "../settings-watcher.js";
import { readSponsorSettingsFromConfig, startSponsorRuntime } from "../sponsor/runtime.js";
import { acquireStartupLock } from "../startup-lock.js";
import { createTsgoRunner } from "../tsgo-runner.js";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import { antiStompDepsFor, settleIncumbentAtBind } from "./incumbent-check.js";
import { makeShrinkIdleMemory } from "./idle-shrink.js";
import { heapSpaceSummary, installDaemonTimers } from "./daemon-timers.js";
import {
	buildStartupMessage,
	computeClassifierStatusLine,
	formatScannerStatusLine,
} from "./protocol-status.js";
import type { EarlyShutdownController, ServerCliConfig } from "./server-cli-bootstrap.js";
import type { DaemonState } from "./server-daemon-state.js";
import type { ServerRuntime } from "./runtime-context.js";
import { ensureDirectory } from "./socket-lifecycle.js";
import {
	runStartupSelfCheck,
	startFramedDaemonOrExit,
	type StartupGuard,
} from "./startup-guard.js";

const SPONSOR_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
const LOST_AGENT_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const MS_PER_MINUTE = 60_000;

interface ActivateDaemonOptions {
	cli: ServerCliConfig;
	state: DaemonState;
	runtime: ServerRuntime;
	socketLifecycle: SocketLifecycle;
	startupGuard: StartupGuard;
	earlyShutdown: EarlyShutdownController;
	moduleUrl: string;
	getRules: () => GuardRulesConfig;
	setRules: (rules: GuardRulesConfig) => void;
	setCompiledAllowlist: (allowlist: ReturnType<typeof compileAllowlist>) => void;
	getLastHookEventAtMs: () => number;
	getTrigramIndex: () => import("../trigram-index.js").TrigramIndex | null;
	getGraphForFile: (filePath: string) => import("../project-graph.js").ProjectGraph;
	resetIdleTimer: () => void;
	refreshStatuslineSnapshot: () => void;
	shutdownWith: (reason: string) => void;
	evaluateEventLine: (line: string, protocol: "raw" | "framed") => Promise<HarnessDecision>;
	evaluateUnifiedViaRuntime: Parameters<typeof startFramedDaemonOrExit>[0]["state"]["evaluateHook"];
	writeProtocolStatus: () => void;
	log: (message: string) => void;
	logAlways: (message: string) => void;
}

function reportStaleSnapshots(cwd: string, log: (message: string) => void): void {
	const sweep = sweepStaleLiveSnapshots(cwd);
	if (sweep.removed.length > 0) {
		log(`Reaped ${sweep.removed.length} stale live snapshot(s) (of ${sweep.scanned} scanned)`);
	}
}

function installLostAgentScan(state: DaemonState, log: (message: string) => void): void {
	setInterval(() => {
		const lost = state.cohort.detectLostAgents();
		for (const agent of lost) {
			log(`Agent lost (no events for 5min): ${agent.name}`);
			state.reservations.releaseAllForAgent(agent.name, state.cohort);
		}
	}, LOST_AGENT_SCAN_INTERVAL_MS);
}

function installRulesWatchers(options: ActivateDaemonOptions): void {
	const { cli, state, runtime, socketLifecycle, log, logAlways } = options;
	const unwatchRules = watchRulesFiles(cli.cwd, (newRules) => {
		options.setRules(newRules);
		runtime.rules = newRules;
		state.writeClassifierStatus(computeClassifierStatusLine(newRules));
		if (!newRules.content_scanner?.enabled) {
			state.writeScannerStatus("disabled");
		} else if (state.contentScanner?.getStatus) {
			state.writeScannerStatus(formatScannerStatusLine(state.contentScanner.getStatus()));
		} else if (state.contentScanner) {
			state.writeScannerStatus(`ready:${state.contentScanner.runtime}`);
		} else {
			state.writeScannerStatus("down:needs_restart");
		}
		const allowlist = compileAllowlist(newRules.content_scanner?.allowlist);
		options.setCompiledAllowlist(allowlist);
		runtime.compiledAllowlist = allowlist;
		Object.assign(
			state.autoCoordConfig,
			DEFAULT_AUTO_COORDINATION_CONFIG,
			newRules.auto_coordination || {},
		);
		log(`Rules reloaded: ${newRules.rules.length} rules active`);
		options.refreshStatuslineSnapshot();
	});
	const unwatchSettings = watchSettingsFiles({
		cwd: cli.cwd,
		onStrip: (stripResult) => {
			resetProjectSetupWarningsCache();
			const previews = stripResult.entries.slice(0, 5).map((entry) => {
				const file = entry.file.replace(/^.+?(\.claude\/.+)$/, "$1");
				return `  - ${file} permissions.${entry.bucket}[${entry.index}] = ${JSON.stringify(entry.rule)} (${describeMalformedReason(entry.reason)})`;
			});
			const more =
				stripResult.entries.length > previews.length
					? `\n  ...and ${stripResult.entries.length - previews.length} more`
					: "";
			logAlways(
				`[interlinked] Live-stripped ${stripResult.totalStripped} malformed permission rule(s) from .claude/settings*.json:\n${previews.join("\n")}${more}`,
			);
		},
	});
	const mutationBackground = startMutationCloudV3Background({
		root: cli.cwd,
		log: logAlways,
		onFinding: state.deliverMutationFindingToSessions,
	});
	socketLifecycle.setUnwatchers(() => {
		mutationBackground.stop();
		unwatchRules();
	}, unwatchSettings);
}

function installAuxiliaryRuntimes(options: ActivateDaemonOptions): void {
	const { cli, state, log, logAlways } = options;
	installDaemonTimers({
		refreshStatuslineSnapshot: options.refreshStatuslineSnapshot,
		acquireRecycleLease: () => acquireStartupLock(cli.cwd).acquired,
		shutdown: () => options.shutdownWith("rss-ceiling"),
		onSpike: (rssMb, deltaMb) =>
			recordDaemonEvent(cli.cwd, {
				at: Date.now(),
				pid: process.pid,
				event: "spike",
				rss_mb: rssMb,
				detail: `+${deltaMb}MB in one tick [${heapSpaceSummary()}]`,
			}),
		onHeapPressure: makeHeapPressureLedger(cli.cwd, logAlways),
		snapshotDir: cli.interlinkedDir,
		lastEventAtMs: options.getLastHookEventAtMs,
		shrinkIdleMemory: makeShrinkIdleMemory(options.getTrigramIndex),
		log: logAlways,
	});
	const sponsorRuntime = startSponsorRuntime({
		interlinkedDir: cli.interlinkedDir,
		readSettings: () => readSponsorSettingsFromConfig(cli.interlinkedDir),
		hasRecentActivity: () =>
			Date.now() - options.getLastHookEventAtMs() < SPONSOR_ACTIVITY_WINDOW_MS,
		log,
	});
	void sponsorRuntime.tick();
	options.resetIdleTimer();
	installLostAgentScan(state, log);
}

function installProcessHandlers(options: ActivateDaemonOptions): void {
	const { cli, runtime, logAlways } = options;
	options.earlyShutdown.upgrade(
		() => options.shutdownWith("signal"),
		() => {
			logAlways("Shutdown was requested during startup — running graceful path now");
			options.socketLifecycle.shutdown();
		},
	);
	process.on("SIGHUP", () => {
		const rules = loadRules(cli.cwd);
		options.setRules(rules);
		runtime.rules = rules;
		logAlways(`Rules reloaded via SIGHUP: ${rules.rules.length} rules active`);
	});
}

async function bindFramedSocket(
	options: ActivateDaemonOptions,
	antiStomp: ReturnType<typeof antiStompDepsFor>,
	tsgoRunner: ReturnType<typeof createTsgoRunner>,
): Promise<void> {
	const { cli, state, socketLifecycle, startupGuard } = options;
	if (!cli.runFramedSocket) return;
	socketLifecycle.setFramedDaemon(
		await startFramedDaemonOrExit(
			{
				paths: cli.framedPaths,
				session_id: cli.framedSessionId,
				idle_shutdown_ms: cli.idleTimeoutMs,
				state: {
					tsgo: tsgoRunner,
					getEvaluatorContext: () => ({
				hasBackgroundWork: () => options.runtime.hookCoverage?.verification?.isRunning() ?? false,
						rules: options.getRules(),
						session: state.sessions.get(cli.framedSessionId),
						reservations: state.reservations,
						cohort: state.cohort,
						graph: options.getGraphForFile(cli.cwd),
						sessions: state.sessions,
						routeMap: state.routeMap,
						errorHistory: state.errorHistory,
					}),
					evaluateHook: options.evaluateUnifiedViaRuntime,
				},
			},
			{ cwd: cli.cwd, antiStomp, startup: startupGuard },
		),
	);
}

async function finishStartup(options: ActivateDaemonOptions): Promise<void> {
	const { cli, state, log, logAlways } = options;
	options.writeProtocolStatus();
	await runStartupSelfCheck({
		cwd: cli.cwd,
		evaluate: options.evaluateEventLine,
		log: logAlways,
		recordEvent: (event) => recordDaemonEvent(cli.cwd, event),
	});
	logAlways(
		buildStartupMessage({
			protocol: cli.protocolMode,
			rawSocketPath: cli.runRawSocket ? cli.socketPath : null,
			framedSocketPath: cli.runFramedSocket ? cli.framedPaths.socket : null,
			pid: process.pid,
			ruleCount: options.getRules().rules.length,
			idleTimeoutMs: cli.idleTimeoutMs,
			msPerMinute: MS_PER_MINUTE,
		}),
	);
	startBuildRefreshWatcher({
		moduleUrl: options.moduleUrl,
		cwd: cli.cwd,
		lastActivityMs: () => options.runtime.hookCoverage?.verification?.isRunning() ? Date.now() : options.getLastHookEventAtMs(),
		log: logAlways,
	});
	const rules = options.getRules();
	state.writeClassifierStatus(computeClassifierStatusLine(rules));
	if (rules.policy_classifier?.enabled) {
		const { provider, model } = rules.policy_classifier;
		const hasKey =
			provider === "claude_code" || !!resolveApiKey(rules.policy_classifier.api_key_env);
		log(`Policy classifier: ${provider}/${model} (${hasKey ? "ready" : "no API key"})`);
	}
}

/** Bind sockets, watchers, timers, and process handlers in startup order. */
export async function activateDaemon(options: ActivateDaemonOptions): Promise<void> {
	const { cli, socketLifecycle, startupGuard, log, logAlways } = options;
	const antiStomp = antiStompDepsFor(cli.cwd, logAlways);
	await settleIncumbentAtBind({
		socketPath: cli.socketPath,
		pidPath: cli.pidPath,
		cwd: cli.cwd,
		logAlways,
	});
	if (cli.runRawSocket) {
		socketLifecycle.cleanupSocket();
		ensureDirectory(cli.socketPath);
	}
	socketLifecycle.writePidFile();
	options.writeProtocolStatus();
	reportStaleSnapshots(cli.cwd, log);
	installRulesWatchers(options);
	installAuxiliaryRuntimes(options);
	installProcessHandlers(options);
	const tsgoRunner = createTsgoRunner();
	await bindFramedSocket(options, antiStomp, tsgoRunner);
	if (cli.runRawSocket) socketLifecycle.startRawServer(startupGuard);
	await finishStartup(options);
}
