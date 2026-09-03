// ===========================================
// ChangeSet result accumulator
// ===========================================
// One ChangeSet batch attributes findings back to the individual files the
// request touched, so every batch stage appends into the same per-path map.
// The append is shared here so the engine-batch stage and the named-check
// stage cannot drift on how a path's first row is created.

import type { QualityCheckResult } from "./result-types.js";

/** Append one result to `filePath`'s row list, creating the list if absent. */
export function pushResult(
	results: Map<string, QualityCheckResult[]>,
	filePath: string,
	result: QualityCheckResult,
): void {
	const rows = results.get(filePath) ?? [];
	rows.push(result);
	results.set(filePath, rows);
}
