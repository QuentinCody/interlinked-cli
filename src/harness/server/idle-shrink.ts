// ===========================================
// Harness daemon — shrinkable-cache valve
// ===========================================
// The idle-timer AND the emergency heap-pressure path (see daemon-timers.ts)
// both call one "drop everything reconstructible" callback. Extracted out of
// server.ts (already over its per-file line cap and may not grow) so a new
// retainer can be added here without touching that file.
//
// Root cause 2026-08-22: a daemon hard-aborted at ~2.35GB with three
// emergency-GCs immediately before it that "shrank caches + forced GC" and
// reclaimed nothing — because two of its three biggest retainers (manifest
// cache, tsc overlay LS) WERE cleared here, but the trigram index's dirty
// layer was not. A ~19k-file mutation-campaign scratch churn had grown that
// dirty layer's Sets, live-referenced from the daemon's own `trigramIndex`
// singleton, past what forced GC can ever reclaim. `updateFileInState`
// (trigram-index-mutation.ts) now bounds new growth at the source; clearing
// the dirty layer here is the second line of defense for whatever had
// already accumulated before that fix takes effect on a running daemon.
import { clearCheckEngineDiagnosticCache } from "../check-engine/index.js";
import { clearTscOverlayCache } from "../check-engine/tool-runners/tsc-overlay.js";
import { clearManifestCache } from "../mutation/manifest.js";
import type { TrigramIndex } from "../trigram-index.js";

/**
 * Build the shrink callback `installDaemonTimers` fires on idle and under
 * emergency heap pressure. `getTrigramIndex` is a thunk (not a direct
 * reference) because the daemon's `trigramIndex` binding can be reassigned
 * after this callback is constructed (e.g. re-loaded on SessionStart).
 */
export function makeShrinkIdleMemory(getTrigramIndex: () => TrigramIndex | null): () => void {
	return () => {
		clearManifestCache();
		clearCheckEngineDiagnosticCache();
		clearTscOverlayCache();
		getTrigramIndex()?.clearDirty();
		globalThis.gc?.();
	};
}
