// ===========================================
// Quality Check Result — shared finding shape
// ===========================================
// The single warning/error record every quality-check phase pushes. Hoisted
// out of quality-checks.ts so the extracted per-phase modules (tool-check-loop,
// inline-block, ratchet-comparison) and the orchestrator all reference one
// type definition instead of redeclaring it. Mirrors the shape consumed by
// formatQualityWarnings.

export interface QualityCheckResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file?: string;
	detail?: string;
}

/** Per-tool execution metrics surfaced from the engine into latency telemetry.
 *  Mirror of `ToolMetrics` in `check-engine/types.ts` but flattened into the
 *  shape `latency-log.ts` consumes (snake_case keys) and stripped to the three
 *  fields the latency CLI actually aggregates. */
export interface ToolBreakdownEntry {
	tool: string;
	ms: number;
	finding_count: number;
}
