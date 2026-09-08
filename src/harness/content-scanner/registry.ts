// ===========================================
// Content Scanner — Registry (factory)
// ===========================================
//
// Given a ContentScannerConfig, returns the right backend instance — or
// `undefined` when the feature is disabled. Consumed by server.ts at harness
// startup. Also applies the `disabled_labels` wrapper so the rest of the
// pipeline never has to know about category-level kill switches.

import { OpfHttpScanner } from "./opf-http.js";
import { OpfLocalScanner } from "./opf-local.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "./types.js";

/**
 * Build a content scanner for the given config, or `undefined` if disabled
 * or misconfigured. Never throws — startup errors surface as `ready() ===
 * false` on the returned scanner instead, consistent with fail-open posture.
 */
type ScannerFactoryConfig = Omit<ContentScannerConfig, "runtime"> & { runtime: unknown };

function hasSupportedRuntime(config: ScannerFactoryConfig): config is ContentScannerConfig {
	return config.runtime === "local" || config.runtime === "huggingface" || config.runtime === "custom_http";
}

export function createScanner(config: ScannerFactoryConfig): ContentScanner | undefined {
	if (!config.enabled || !hasSupportedRuntime(config)) return undefined;
	const backend = buildBackend(config);
	if (!backend) return undefined;
	return wrapWithDisabledLabels(backend, config.disabled_labels);
}

function buildBackend(config: ContentScannerConfig): ContentScanner | undefined {
	switch (config.runtime) {
		case "local":
			return new OpfLocalScanner(config);
		case "huggingface":
		case "custom_http":
			return new OpfHttpScanner(config);
		default:
			return undefined;
	}
}

/**
 * Decorate a backend so any finding whose label is in `disabledLabels` is
 * dropped before it reaches the caller. The wrapper preserves identity for
 * lifecycle observability (status callbacks, getStatus) and is a no-op when
 * `disabledLabels` is unset/empty so behavior is bit-identical to the bare
 * backend in the common case.
 *
 * Exported for unit tests. Production code constructs scanners through
 * createScanner() which applies the wrapper automatically.
 */
export function wrapWithDisabledLabels(
	backend: ContentScanner,
	disabledLabels: readonly string[] | undefined,
): ContentScanner {
	if (!disabledLabels || disabledLabels.length === 0) return backend;
	const blocked = new Set(disabledLabels);
	const filter = (findings: ScanFinding[]): ScanFinding[] =>
		findings.filter((f) => !blocked.has(f.label));
	return {
		name: backend.name,
		runtime: backend.runtime,
		ready: () => backend.ready(),
		scan: async (req) => filter(await backend.scan(req)),
		shutdown: () => backend.shutdown(),
		// Preserve optional lifecycle hooks if the backend supplies them so the
		// statusline / harness status command keep working through the wrapper.
		onStatusChange: backend.onStatusChange?.bind(backend),
		getStatus: backend.getStatus?.bind(backend),
	};
}
