// ===========================================
// Hook timeout policy — SECONDS, per event (single source)
// ===========================================
// Claude Code's `hooks[].timeout` is in seconds (client default 60). Both
// writers of Claude hook entries — the adapter settings-fragment renderer
// (`harness/adapters/claude-code.ts`) and the legacy shared installer
// (`lib/hook-installers-shared.ts`) — consume THIS map so the policy can
// never fork between them.
//
// PreToolUse must outlast the per-edit coverage overlay: with per-edit test
// runs pinned ON (2026-07-17 directive — tests run per edit; slower is fine
// when it buys quality), the daemon may legitimately compute for the whole
// `per_edit_coverage.budget_ms`, and the dist client waits up to its 180s
// transport failsafe — a 60s hook kill would discard the verdict after the
// cost was already paid. PostToolUse gets room for the full tsc+biome
// quality pass. Events not listed keep the client default.

export const HOOK_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
	// Observation-only Codex lifecycle telemetry must never make Ctrl-C wait.
	Interrupt: 3,
	PreToolUse: 240,
	PostToolUse: 120,
	PostToolBatch: 120,
};

/** The policy timeout for an event, or undefined to keep the client default. */
export function hookTimeoutSecondsFor(eventName: string): number | undefined {
	return HOOK_TIMEOUT_SECONDS[eventName];
}
