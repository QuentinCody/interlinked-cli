import { dirname, join } from "node:path";
import { buildAllAdapters, detectAdapter, getAdapter } from "./harness/adapters/index.js";
import type { RunnerAdapter } from "./harness/adapters/types.js";
import { recordPayloadKeys } from "./harness/payload-key-census.js";
import type { RunnerId, UnifiedHookEvent } from "./harness/unified-event.js";
import { findRepoRoot } from "./hook-entry-project.js";
import { recordHookRuntime } from "./lib/hook-runtime-receipt.js";

interface AdapterResolutionInput {
	env: NodeJS.ProcessEnv;
	runner?: RunnerId | undefined;
}

export function resolveHookAdapter(input: AdapterResolutionInput): RunnerAdapter | null {
	const all = buildAllAdapters();
	if (input.runner) return getAdapter(input.runner, all);
	return detectAdapter(input.env, all);
}

export function buildUnifiedHookEvent(
	adapter: RunnerAdapter,
	nativeJson: unknown,
	nativeEventName: string,
): UnifiedHookEvent {
	// Adapters are tolerant of unknown fields and never throw; this is the one
	// seam that still holds the untruncated provider payload.
	const event = adapter.parseHookInput(nativeJson, nativeEventName);
	recordPayloadKeys({
		runner: adapter.id,
		nativeEvent: nativeEventName,
		raw: event.raw,
		cwd: event.context.cwd,
	});
	return event;
}

export function resolveHookDataDir(gateCwd: string, socketPath: string | null): string | null {
	if (socketPath) return dirname(socketPath);
	const root = findRepoRoot(gateCwd);
	return root ? join(root, ".interlinked") : null;
}

export function recordAdapterExecution(
	adapter: RunnerAdapter,
	event: UnifiedHookEvent,
	gateCwd: string,
): void {
	const root = findRepoRoot(gateCwd);
	if (!root) return;
	recordHookRuntime({
		dataDir: join(root, ".interlinked"),
		provider: adapter.id,
		nativeEvent: event.runner_native_event,
		definitionPath: join(root, adapter.capabilities.project_hook_path),
	});
}
