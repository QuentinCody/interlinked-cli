// ===========================================
// Adapter registry — dispatcher + factory for the supported runners
// ===========================================

import type { ClassifierOverrides } from "../tool-class-classifier.js";
import type { RunnerId } from "../unified-event.js";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotCliAdapter } from "./copilot-cli.js";
import { createCursorAdapter } from "./cursor.js";
import { createGeminiCliAdapter } from "./gemini-cli.js";
import { createOpenCodeAdapter } from "./opencode.js";
import { createOpencode2Adapter } from "./opencode2.js";
import { createPiAdapter } from "./pi.js";
import type { RunnerAdapter } from "./types.js";

export interface AdapterRegistryOptions {
	overrides?: ClassifierOverrides | undefined;
}

/** Build the full set of adapters, sharing classifier overrides. */
export function buildAllAdapters(opts: AdapterRegistryOptions = {}): RunnerAdapter[] {
	return [
		createClaudeCodeAdapter({ overrides: opts.overrides }),
		createCopilotCliAdapter({ overrides: opts.overrides }),
		createCursorAdapter({ overrides: opts.overrides }),
		createGeminiCliAdapter({ overrides: opts.overrides }),
		createCodexAdapter({ overrides: opts.overrides }),
		createOpencode2Adapter({ overrides: opts.overrides }),
		createOpenCodeAdapter({ overrides: opts.overrides }),
		createPiAdapter({ overrides: opts.overrides }),
	];
}

/** Detect which adapter the current process environment best matches. The
 *  first adapter whose `detectFromEnv` returns true wins. Stable ordering:
 *  claude-code → copilot-cli → cursor → gemini-cli → codex → opencode2 → opencode → pi. */
export function detectAdapter(
	env: NodeJS.ProcessEnv,
	adapters: RunnerAdapter[] = buildAllAdapters(),
): RunnerAdapter | null {
	for (const adapter of adapters) {
		if (adapter.detectFromEnv(env)) return adapter;
	}
	return null;
}

/** Look up an adapter by id. Returns null if not found. */
export function getAdapter(
	id: RunnerId,
	adapters: RunnerAdapter[] = buildAllAdapters(),
): RunnerAdapter | null {
	return adapters.find((a) => a.id === id) ?? null;
}

export { createClaudeCodeAdapter } from "./claude-code.js";
export { createCodexAdapter } from "./codex.js";
export { createCopilotCliAdapter } from "./copilot-cli.js";
export { createCursorAdapter } from "./cursor.js";
export { createGeminiCliAdapter } from "./gemini-cli.js";
export { createOpenCodeAdapter, renderOpenCodeBridgeSource } from "./opencode.js";
export { createOpencode2Adapter } from "./opencode2.js";
export { createPiAdapter, renderPiBridgeSource } from "./pi.js";
export {
	buildStandardAction,
	DEFAULT_NATIVE_FIELD_ALIASES,
	normalizeNativeHookEvent,
	normalizeToolName,
} from "./normalization.js";
export {
	CLAUDE_CODE_CAPABILITIES,
	CODEX_CAPABILITIES,
	COPILOT_CLI_CAPABILITIES,
	CURSOR_CAPABILITIES,
	eventCapability,
	GEMINI_CLI_CAPABILITIES,
	installedEventNames,
	OPENCODE_CAPABILITIES,
	PI_CAPABILITIES,
} from "./provider-capabilities.js";
export {
	encodeProviderBridgeDecision,
	PROVIDER_BRIDGE_MARKER,
	renderProviderBridgePrelude,
} from "./provider-bridge-source.js";
export type {
	AdapterOutput,
	InstallerManifestEntry,
	MergeStrategy,
	NativeDecisionControl,
	NativeHookEventCapability,
	RunnerAdapter,
	RunnerCapabilities,
	SettingsFragment,
} from "./types.js";
export type {
	NativeFieldAliases,
	NormalizeNativeHookOptions,
	StandardActionOptions,
} from "./normalization.js";
