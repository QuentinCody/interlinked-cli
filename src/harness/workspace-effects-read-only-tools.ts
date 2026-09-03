// ===========================================
// Read-only tool classification for workspace effect capture
// ===========================================
//
// Tools whose calls never mutate the filesystem, exempted from the
// workspace snapshot/diff overhead. Companion to workspace-effects.ts.

const READ_ONLY_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"TodoRead",
	"NotebookRead",
	"ListFiles",
]);

/**
 * Unknown tools are observed by default. A new runner/tool must earn a
 * read-only exemption; otherwise renaming a write-capable tool would reopen
 * the exact bypass this layer exists to close.
 */
export function shouldObserveWorkspaceEffects(toolName: string | undefined): boolean {
	return !toolName || !READ_ONLY_TOOLS.has(toolName);
}
