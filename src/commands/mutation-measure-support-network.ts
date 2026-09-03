// ===========================================
// interlinked mutation measure — network measurement seam
// ===========================================
// Extracted from mutation-measure-support.ts (large-file-policy.ts's per-file
// line cap) — the runner-endpoint resolution and the real network-backed
// `MeasureFn`, with no behavior change. `mutation-measure-support.ts` imports
// these; nothing outside that file needs them.

import type { MeasureOutcome } from "../harness/mutation/measure.js";
import type { MeasurementSurface } from "../harness/mutation/types.js";

/** Injected in tests; the default is the real network-backed `measureFile`. */
export type MeasureFn = (args: {
	file: string;
	content: string;
	overlays: Array<{ path: string; content: string }>;
	endpoints: string[];
	token?: string | undefined;
	deadlineMs?: number | undefined;
	testScope?: string[] | undefined;
}) => Promise<MeasureOutcome>;

/** Returns a fatal message, or null to proceed. Injected in tests. */
export type PreflightFn = (args: { tests: string[]; cwd: string; quiet: boolean }) => Promise<string | null>;

export interface MeasureOneArgs {
	/** Any spelling of the path; normalized to the manifest's canonical key. */
	file: string;
	cwd: string;
	configDir: string;
	record?: boolean | undefined;
	skipPreflight?: boolean | undefined;
	budgetMs?: number | undefined;
	runnerUrl?: string | undefined;
	/** Ordered fallback list — index 0 is tried first. Preferred over
	 *  `runnerUrl` when both are given. A caller that can reach several runners
	 *  passes all of them so a disconnected host costs one retry round, not the
	 *  whole per-file budget. */
	runnerUrls?: string[] | undefined;
	/** Suppress the progress notes this step writes to stderr. */
	quiet?: boolean | undefined;
	/** Progress sink, called as each note is produced (before the run starts). */
	onNote?: ((note: string) => void) | undefined;
	/** Recorded with the measurement so a later reader knows which surface (and
	 *  therefore which budget and scope) produced it. */
	surface?: MeasurementSurface | undefined;
	measure?: MeasureFn | undefined;
	preflight?: PreflightFn | undefined;
}

/** Resolve the runner endpoints for this run: an explicit override wins, else
 *  the repo's configured `per_edit_mutation` endpoints. */
export async function resolveEndpoints(
	args: MeasureOneArgs,
	readDisk: (p: string) => string | null,
): Promise<{ endpoints: string[]; token?: string | undefined }> {
	if (args.runnerUrls && args.runnerUrls.length > 0) return { endpoints: [...args.runnerUrls] };
	if (args.runnerUrl) return { endpoints: [args.runnerUrl] };
	const { configuredRunnerEndpoints } = await import("../harness/mutation/measure.js");
	return configuredRunnerEndpoints(args.cwd, readDisk);
}

export function networkMeasure(
	measureFile: typeof import("../harness/mutation/measure.js").measureFile,
): MeasureFn {
	return (args) =>
		measureFile({
			file: args.file,
			content: args.content,
			overlays: args.overlays,
			endpoints: args.endpoints,
			fetchImpl: (url, init) => fetch(url, { ...init, signal: init.signal }),
			...(args.token !== undefined ? { token: args.token } : {}),
			...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
			...(args.testScope !== undefined ? { testScope: args.testScope } : {}),
		});
}
