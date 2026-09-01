// ===========================================
// Supermodel `.graph.*` shard write guard — apply_patch coverage
// ===========================================
// `builtin-supermodel-graph-write-blocked` (in
// `rules/builtin-rules-supermodel.ts`) catches Write/Edit/MultiEdit/
// NotebookEdit calls where the destination is exposed as
// `tool_input.file_path`. Codex `apply_patch` payloads embed paths inside
// the patch body — a regex-pattern rule on `field: file_path` cannot
// see them. This module is the second layer.
//
// Walks the union of `extractAllEditedFilePaths(event)`, which already
// returns destinations from `apply_patch` `*** Update/Add/Delete File:`
// headers and the `Move to:` form. See
// `docs/design/graph-prediction-protocol.md §9.2`.

import { isFileWrite } from "./evaluator/tool-classifiers.js";
import { extractAllEditedFilePaths } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

const SHARD_REGEX = /\.graph(\.[a-zA-Z0-9]+)?$/i;

/** Result of an apply_patch-aware shard-write check.
 *  Returned (instead of throwing) so callers can compose the result with
 *  other guard outcomes — pre-tool.ts is one big sequential decision. */
interface ShardWriteBlocked {
	block: true;
	reason: string;
	rule_id: "builtin-supermodel-graph-write-blocked-applypatch";
	severity: "high";
	category: "filesystem";
}

/** Returns a block result when any destination of a file-write tool call
 *  resolves to a Supermodel shard path. Returns null on:
 *   - non-file-write tool names
 *   - no destinations resolved (malformed apply_patch, missing file_path)
 *   - destinations that don't match the shard suffix regex */
export function checkSupermodelShardWrite(event: HarnessEvent): ShardWriteBlocked | null {
	if (!isFileWrite(event.tool_name)) return null;
	const paths = extractAllEditedFilePaths(event);
	// NotebookEdit's `notebook_path` is not in `extractAllEditedFilePaths`'s
	// canonical set today; pick it up here so this guard remains the
	// guaranteed safety net for the rule's `field: file_path` mismatch.
	const notebookPath =
		typeof event.tool_input?.notebook_path === "string" ? event.tool_input.notebook_path : null;
	const candidates = notebookPath ? [...paths, notebookPath] : paths;
	if (candidates.length === 0) return null;
	for (const path of candidates) {
		if (SHARD_REGEX.test(path)) {
			return {
				block: true,
				reason:
					`BLOCKED: Write to ${path} blocked. Supermodel \`.graph.*\` shards are read-only ` +
					"artifacts owned by Supermodel's daemon. Writing to them corrupts the codebase " +
					"graph and silently breaks impact analysis. The graph_prediction contract lives " +
					"in your response text, not on disk.",
				rule_id: "builtin-supermodel-graph-write-blocked-applypatch",
				severity: "high",
				category: "filesystem",
			};
		}
	}
	return null;
}
