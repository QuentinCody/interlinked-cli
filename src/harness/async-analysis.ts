// ===========================================
// Async Background Analysis with Coalescing
// ===========================================
// Runs expensive PostToolUse checks (structural, impact) asynchronously.
// Overlapping requests are coalesced — only the latest pending context runs.
// Findings are written to pending-async-findings.json for retrieval through
// this manager's file-scoped consume() path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResultEntry } from "./types.js";

interface PendingFindings {
	file: string;
	findings: CheckResultEntry[];
	produced_at: string;
}

export interface AsyncAnalysisManager {
	/** Whether an analysis is currently running */
	readonly inProgress: boolean;
	/** Submit a file for async analysis. If one is in flight, the new request is stashed. */
	submit(file: string, analysisFn: () => Promise<CheckResultEntry[]>): void;
	/** Read and clear pending findings for a given file */
	consume(file: string): CheckResultEntry[];
	/** Wait for any in-flight analysis to complete (for graceful shutdown) */
	drain(timeoutMs?: number): Promise<void>;
}

/** Create an async analysis manager rooted at the given .interlinked directory */
export function createAsyncAnalysisManager(interlinkedDir: string): AsyncAnalysisManager {
	let running = false;
	let pendingRequest: { file: string; analysisFn: () => Promise<CheckResultEntry[]> } | null =
		null;
	let currentPromise: Promise<void> | null = null;
	const pendingsPath = join(interlinkedDir, "pending-async-findings.json");

	function readPendingMap(): Record<string, PendingFindings> {
		try {
			if (existsSync(pendingsPath)) {
				return JSON.parse(readFileSync(pendingsPath, "utf-8"));
			}
		} catch (e) {
			void e;
		}
		return {};
	}

	function writePendingMap(map: Record<string, PendingFindings>): void {
		try {
			if (!existsSync(interlinkedDir)) mkdirSync(interlinkedDir, { recursive: true });
			writeFileSync(pendingsPath, JSON.stringify(map, null, 2));
		} catch (e) {
			void e;
		}
	}

	async function runAnalysis(
		file: string,
		analysisFn: () => Promise<CheckResultEntry[]>,
	): Promise<void> {
		running = true;
		try {
			const findings = await analysisFn();
			if (findings.length > 0) {
				const map = readPendingMap();
				map[file] = {
					file,
					findings,
					produced_at: new Date().toISOString(),
				};
				writePendingMap(map);
			}
		} catch (e) {
			void e;
		} finally {
			running = false;
			// If a new request was stashed during this run, execute it (coalescing)
			if (pendingRequest) {
				const next = pendingRequest;
				pendingRequest = null;
				currentPromise = runAnalysis(next.file, next.analysisFn);
			} else {
				currentPromise = null;
			}
		}
	}

	return {
		get inProgress() {
			return running;
		},

		submit(file, analysisFn) {
			if (running) {
				// Coalesce: stash the latest request, discard any previously stashed one
				pendingRequest = { file, analysisFn };
			} else {
				currentPromise = runAnalysis(file, analysisFn);
			}
		},

		consume(file) {
			const map = readPendingMap();
			const entry = map[file];
			if (!entry) return [];
			delete map[file];
			writePendingMap(map);
			return entry.findings;
		},

		async drain(timeoutMs = 10_000) {
			if (!currentPromise) return;
			await Promise.race([
				currentPromise,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					timer.unref();
				}),
			]);
		},
	};
}
