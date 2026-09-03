// interlinked-tdd: exempt
// ===========================================
// interlinked harness — spawn-argv builder (extracted from harness-lifecycle-helpers.ts)
// ===========================================
//
// Moved verbatim to keep the parent file under the per-file line cap;
// behavior is byte-identical.

import { configuredHeapMb } from "../harness/memory-ceiling.js";
import type { HarnessProtocolMode } from "./harness-status-helpers.js";

/**
 * Build the `node` argv for every harness server launch. Caps the V8 heap at
 * the shared daemon default; override via `INTERLINKED_HARNESS_HEAP_MB`.
 */
export function buildHarnessSpawnArgs(
	serverPath: string,
	cwd: string,
	protocol: HarnessProtocolMode,
	sessionId: string,
	opts: { verbose?: boolean },
): string[] {
	const heapMb = configuredHeapMb();
	// --expose-gc powers the idle shrink (daemon-timers): a forced collection
	// after the manifest cache drops, so idle RSS actually falls.
	const args = [`--max-old-space-size=${heapMb}`, "--expose-gc", serverPath, "--cwd", cwd];
	args.push("--protocol", protocol);
	if (protocol !== "raw") args.push("--session-id", sessionId);
	if (opts.verbose) args.push("--verbose");
	return args;
}
