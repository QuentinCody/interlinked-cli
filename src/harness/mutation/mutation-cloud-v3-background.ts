// =========================================================
// Mutation cloud v3 — daemon-owned durable background poller
// =========================================================
// The hook path must never wait for a cloud mutation job. This scheduler runs
// beside the daemon, opens the journal only when the separate default-off
// background opt-in is true, and processes one due row per tick through MutationCloudV3Runtime —
// the exact processor/evaluator used by the immediate CLI path.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	MUTATION_CLOUD_V3_LOCAL_CONFIG,
	loadMutationCloudV3Config,
} from "./mutation-cloud-v3-config.js";
import {
	MutationCloudV3Runtime,
	type MutationCloudV3ProcessResult,
	type MutationCloudV3RuntimeConfig,
} from "./mutation-cloud-v3-runtime.js";
import type { MutationFindingDeliveryOutcome } from "./mutation-cloud-v3-finding-delivery.js";

/** Public operational cadence so status/doctor surfaces can report the same
 * schedule without copying a magic number. */
const MUTATION_CLOUD_BACKGROUND_INTERVAL_MS = 15_000;

interface BackgroundRuntime {
	processNext(): Promise<MutationCloudV3ProcessResult>;
	deliverOneFinding(): Promise<MutationFindingDeliveryOutcome>;
	close(): void;
}

interface MutationCloudBackgroundOptions {
	root: string;
	log: (message: string) => void;
	intervalMs?: number;
	onResult?: (result: MutationCloudV3ProcessResult) => void;
	onFinding?: (finding: Extract<MutationFindingDeliveryOutcome, { kind: "delivered" }>) => void;
}

interface MutationCloudBackgroundDependencies {
	configExists?: (path: string) => boolean;
	loadConfig?: (root: string) => MutationCloudV3RuntimeConfig & { backgroundEnabled?: boolean };
	openRuntime?: (root: string, config: MutationCloudV3RuntimeConfig) => BackgroundRuntime;
	setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
	clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

interface MutationCloudBackgroundHandle {
	tick(): Promise<"disabled" | "busy" | "idle" | "processed" | "failed">;
	stop(): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function outcomeMessage(result: MutationCloudV3ProcessResult): string | null {
	const outcome = result.processor;
	if (outcome.kind === "idle" || outcome.kind === "pending") return null;
	if (outcome.kind === "acknowledged") {
		return `Mutation cloud background job ${outcome.jobId} was journaled and acknowledged.`;
	}
	if (outcome.kind === "dead_letter") {
		return `Mutation cloud background job ${outcome.jobId} was dead-lettered during ${outcome.stage}: ${outcome.reason}`;
	}
	if (outcome.kind === "lost_lease") {
		return `Mutation cloud background job ${outcome.jobId} lost its local lease during ${outcome.stage}; it was not treated as clean.`;
	}
	return `Mutation cloud background job ${outcome.jobId} remains durable for retry after ${outcome.stage}: ${outcome.reason}`;
}

function findingDiagnostic(outcome: MutationFindingDeliveryOutcome): string | null {
	if (outcome.kind === "idle" || outcome.kind === "delivered") return null;
	if (outcome.kind === "lost_lease") {
		return `Mutation cloud finding ${outcome.outboxId} lost its local delivery lease during ${outcome.stage}; it remains in the durable feed.`;
	}
	return `Mutation cloud finding ${outcome.outboxId} remains durable for retry after ${outcome.stage}.`;
}

interface BackgroundCycle {
	result: MutationCloudV3ProcessResult;
	finding: MutationFindingDeliveryOutcome;
}

async function runBackgroundCycle(
	runtime: BackgroundRuntime,
	options: MutationCloudBackgroundOptions,
): Promise<BackgroundCycle> {
	const processed = await runtime.processNext().then(
		(result) => ({ ok: true as const, result }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	// Delivery is deliberately independent of result polling. A transient
	// remote error must not strand a finding whose SQLite commit already won.
	const finding = await runtime.deliverOneFinding();
	if (finding.kind === "delivered") options.onFinding?.(finding);
	if (!processed.ok) throw processed.error;
	options.onResult?.(processed.result);
	return { result: processed.result, finding };
}

function cycleMessage(cycle: BackgroundCycle): string | null {
	return outcomeMessage(cycle.result) ?? findingDiagnostic(cycle.finding);
}

function cycleDidWork(cycle: BackgroundCycle): boolean {
	return cycle.result.processor.kind !== "idle" || cycle.finding.kind !== "idle";
}

/** Start one repo-scoped scheduler. Missing config is a silent disabled state;
 * malformed opted-in config is logged once per distinct failure. */
export function startMutationCloudV3Background(
	options: MutationCloudBackgroundOptions,
	overrides: MutationCloudBackgroundDependencies = {},
): MutationCloudBackgroundHandle {
	const intervalMs = options.intervalMs ?? MUTATION_CLOUD_BACKGROUND_INTERVAL_MS;
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
		throw new Error("mutation cloud background interval must be a safe integer of at least 1000ms");
	}
	const configExists = overrides.configExists ?? existsSync;
	const loadConfig = overrides.loadConfig ?? loadMutationCloudV3Config;
	const openRuntime = overrides.openRuntime ?? ((root, config) => new MutationCloudV3Runtime(root, config));
	const installInterval = overrides.setInterval ?? setInterval;
	const removeInterval = overrides.clearInterval ?? clearInterval;
	const configPath = join(options.root, MUTATION_CLOUD_V3_LOCAL_CONFIG);
	let running = false;
	let stopped = false;
	let lastDiagnostic = "";

	const logOnce = (message: string): void => {
		if (message === lastDiagnostic) return;
		lastDiagnostic = message;
		options.log(message);
	};

	/** One tick's work once the caller has confirmed it's safe to run: load
	 * config, bail out (silently) if the background feature isn't opted in,
	 * otherwise open a runtime and process one cycle. `setRuntime` hands the
	 * opened runtime back to the caller immediately so it can still be closed
	 * if this throws. */
	const attemptOperation = async (
		setRuntime: (runtime: BackgroundRuntime) => void,
	): Promise<"disabled" | "processed" | "idle"> => {
		const config = loadConfig(options.root);
		// Manual mutation-cloud commands remain available with enabled:true, but
		// the daemon must not amplify full manifest snapshots unless the operator
		// separately accepts that current experimental resource profile.
		if (config.backgroundEnabled !== true) {
			lastDiagnostic = "";
			return "disabled";
		}
		const runtime = openRuntime(options.root, config);
		setRuntime(runtime);
		const cycle = await runBackgroundCycle(runtime, options);
		const message = cycleMessage(cycle);
		if (message !== null) logOnce(message);
		else lastDiagnostic = "";
		return cycleDidWork(cycle) ? "processed" : "idle";
	};

	const tick = async (): Promise<"disabled" | "busy" | "idle" | "processed" | "failed"> => {
		if (stopped || !configExists(configPath)) return "disabled";
		if (running) return "busy";
		running = true;
		const runtimeBox: { current: BackgroundRuntime | null } = { current: null };
		try {
			return await attemptOperation((opened) => {
				runtimeBox.current = opened;
			});
		} catch (error) {
			logOnce(`Mutation cloud background processing is paused: ${errorMessage(error)}`);
			return "failed";
		} finally {
			try {
				runtimeBox.current?.close();
			} catch (error) {
				logOnce(`Mutation cloud background runtime close failed: ${errorMessage(error)}`);
			}
			running = false;
		}
	};

	const timer = installInterval(() => {
		void tick();
	}, intervalMs);
	timer.unref();

	return {
		tick,
		stop: () => {
			if (stopped) return;
			stopped = true;
			removeInterval(timer);
		},
	};
}
