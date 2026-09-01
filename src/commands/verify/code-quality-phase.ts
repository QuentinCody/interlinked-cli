import {
	createScanProgress,
	formatSeconds,
	formatSlowestFiles,
} from "./scan-progress.js";
import { streamAllCqSections } from "./streaming-output.js";
import {
	clearCodeQualityResults,
	filterCodeQualityResultsInPlace,
	runCodeQualityChecksProgressive,
} from "./tool-results.js";
import { streamUndocumentedEnvVars } from "./verify-summary.js";

interface CodeQualityPhaseArgs {
	files: string[];
	cwd: string;
	skipChecks: Set<string>;
	details: boolean;
	allFlaggedFiles: Set<string>;
	/** Wall clock the caller started the phase at; `emitVerifyRun` reuses it. */
	startedAt: number;
}

/** Run, stream, and promptly release the long per-file check battery. */
export async function runCodeQualityPhase(args: CodeQualityPhaseArgs): Promise<void> {
	const progress = createScanProgress(args.files.length);
	const cq = filterCodeQualityResultsInPlace(
		await runCodeQualityChecksProgressive(args.files, args.cwd, progress),
		args.skipChecks,
	);
	const elapsedMs = Date.now() - args.startedAt;

	try {
		streamAllCqSections(cq, args.details, args.allFlaggedFiles);
		streamUndocumentedEnvVars(cq.undocumentedEnvVars, args.allFlaggedFiles);
	} finally {
		// External tools run after this phase. Do not retain every inline finding
		// while those subprocesses allocate their own output and parser state.
		clearCodeQualityResults(cq);
	}

	process.stderr.write(
		`\x1b[2m  code quality checks completed in ${formatSeconds(elapsedMs)}s\x1b[0m\n`,
	);
	const slowest = formatSlowestFiles(progress.slowest(), elapsedMs);
	if (slowest !== null) process.stderr.write(slowest);
}
