// Pure metric extraction + arm comparison for the harness-compat evals
// (evals/run-evals.mjs). No I/O, no imports: the eval driver loads this
// module (dist build when present, tsx fallback otherwise) and feeds it raw
// activity.jsonl lines harvested from an eval fixture's .interlinked/.
//
// Event schema: schema_version 5 activity events. The fields consumed here
// (verified against real logs): type (tool_use_start | tool_use | guard_block
// | guard_warn | guard_allow), tool, guard_rule_id, guard_reason,
// guard_warnings (string[] | null), tool_input.command.

export interface EvalMetrics {
	/** Block count per rule id ("unattributed:<reason prefix>" when the event carries no rule id). */
	blocks: Record<string, number>;
	blocks_total: number;
	/** Total warning strings surfaced to the agent (guard_warn/guard_allow/guard_block payloads). */
	warnings: number;
	/** Completed edit-tool calls (Edit/Write/MultiEdit/NotebookEdit PostToolUse events). */
	edits: number;
	/** Completed Bash calls whose command looks like a test/typecheck/lint/build run. */
	verifier_runs: number;
	/** Blocks later followed by a completed call of the same tool (the block→retry→success path). */
	block_retry_success: number;
	/** Runs of >=3 consecutive same-rule blocks (each run counts once) — the stuck-loop signal. */
	block_loops: number;
	/** Attempted tool calls (tool_use_start events), including blocked attempts. */
	turns: number;
}

interface ArmComparisonRow {
	metric: string;
	on: number;
	off: number;
	delta: number;
	flag: string | null;
}

export interface ArmCellSummary {
	arm: "on" | "off";
	rep: number;
	success: boolean;
	metrics: EvalMetrics;
}

interface TaskVerdict {
	verdict: "PASS"| "WARN" | "FAIL" | "SKIP";
	reasons: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const VERIFIER_COMMAND_PATTERNS: readonly RegExp[] = [
	/\bvitest\b/,
	/\bjest\b/,
	/\bpytest\b/,
	/\btsc\b/,
	/\btsgo\b/,
	/\bnpm\s+(run\s+)?(test|typecheck|build|lint)\b/,
	/\bnode\s+--test\b/,
	/\bcargo\s+(test|check)\b/,
	/\bgo\s+(test|vet)\b/,
	/\bmypy\b/,
	/\bruff\b/,
	/\bbiome\s+(check|lint|ci)\b/,
	/\beslint\b/,
	/\boxlint\b/,
];

export function isVerifierCommand(command: string): boolean {
	return VERIFIER_COMMAND_PATTERNS.some((rx) => rx.test(command));
}

type RawEvent = Record<string, unknown>;

function parseEventLine(line: string): RawEvent | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return null; // malformed line — skip, never throw on a partial log
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	// SAFETY: verified above to be a non-null, non-array object parsed from JSON.
	return value as RawEvent;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function ruleKeyOf(evt: RawEvent): string {
	const id = str(evt.guard_rule_id);
	if (id !== null && id !== "") return id;
	const reason = str(evt.guard_reason);
	if (reason === null || reason === "") return "unattributed:<no-reason>";
	return `unattributed:${reason.replace(/\s+/g, " ").slice(0, 40)}`;
}

function warningCountOf(evt: RawEvent): number {
	if (Array.isArray(evt.guard_warnings)) return evt.guard_warnings.length;
	return evt.type === "guard_warn" ? 1 : 0;
}

function commandOf(evt: RawEvent): string | null {
	const input = evt.tool_input;
	if (typeof input !== "object" || input === null) return null;
	// SAFETY: verified above to be a non-null object; command is re-narrowed by str().
	return str((input as RawEvent).command);
}

interface BlockRetryState {
	tool: string;
	satisfied: boolean;
}

function recordBlock(evt: RawEvent, metrics: EvalMetrics, blockKeys: string[], retries: BlockRetryState[]): void {
	const key = ruleKeyOf(evt);
	metrics.blocks[key] = (metrics.blocks[key] ?? 0) + 1;
	blockKeys.push(key);
	const tool = str(evt.tool);
	if (tool !== null) retries.push({ tool, satisfied: false });
}

function recordCompletedTool(evt: RawEvent, metrics: EvalMetrics, retries: BlockRetryState[]): void {
	const tool = str(evt.tool);
	if (tool === null) return;
	if (EDIT_TOOLS.has(tool)) metrics.edits += 1;
	if (tool === "Bash") {
		const command = commandOf(evt);
		if (command !== null && isVerifierCommand(command)) metrics.verifier_runs += 1;
	}
	for (const pending of retries) {
		if (!pending.satisfied && pending.tool === tool) pending.satisfied = true;
	}
}

function computeBlockLoops(blockKeys: string[]): number {
	let loops = 0;
	let run = 0;
	let prev: string | null = null;
	for (const key of blockKeys) {
		run = key === prev ? run + 1 : 1;
		prev = key;
		if (run === 3) loops += 1;
	}
	return loops;
}

function emptyMetrics(): EvalMetrics {
	return {
		blocks: {},
		blocks_total: 0,
		warnings: 0,
		edits: 0,
		verifier_runs: 0,
		block_retry_success: 0,
		block_loops: 0,
		turns: 0,
	};
}

export function extractEvalMetrics(activityLines: string[]): EvalMetrics {
	const metrics = emptyMetrics();
	const blockKeys: string[] = [];
	const retries: BlockRetryState[] = [];
	for (const line of activityLines) {
		const evt = parseEventLine(line);
		if (evt === null) continue;
		const type = str(evt.type);
		if (type === "tool_use_start") metrics.turns += 1;
		if (type === "guard_warn" || type === "guard_allow" || type === "guard_block") {
			metrics.warnings += warningCountOf(evt);
		}
		if (type === "guard_block") recordBlock(evt, metrics, blockKeys, retries);
		if (type === "tool_use") recordCompletedTool(evt, metrics, retries);
	}
	metrics.blocks_total = blockKeys.length;
	metrics.block_retry_success = retries.filter((r) => r.satisfied).length;
	metrics.block_loops = computeBlockLoops(blockKeys);
	return metrics;
}

export function aggregateMetrics(list: EvalMetrics[]): EvalMetrics {
	const sum = emptyMetrics();
	for (const m of list) {
		for (const [key, count] of Object.entries(m.blocks)) {
			sum.blocks[key] = (sum.blocks[key] ?? 0) + count;
		}
		sum.blocks_total += m.blocks_total;
		sum.warnings += m.warnings;
		sum.edits += m.edits;
		sum.verifier_runs += m.verifier_runs;
		sum.block_retry_success += m.block_retry_success;
		sum.block_loops += m.block_loops;
		sum.turns += m.turns;
	}
	return sum;
}

/** Warnings per attempted tool call — the "how naggy was the harness" ratio. */
export function noiseRatio(metrics: EvalMetrics): number {
	return metrics.warnings / Math.max(1, metrics.turns);
}

const NOISE_RATIO_WARN_THRESHOLD = 0.5;

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function row(metric: string, on: number, off: number, flag: string | null): ArmComparisonRow {
	return { metric, on, off, delta: round3(on - off), flag };
}

function successFlag(onSuccess: boolean, offSuccess: boolean): string | null {
	if (offSuccess && !onSuccess) return "harness_regression";
	if (!offSuccess && !onSuccess) return "both_arms_failed";
	return null;
}

export function compareArms(
	onMetrics: EvalMetrics,
	offMetrics: EvalMetrics,
	onSuccess: boolean,
	offSuccess: boolean,
): ArmComparisonRow[] {
	const onNoise = round3(noiseRatio(onMetrics));
	const offNoise = round3(noiseRatio(offMetrics));
	return [
		row("success", onSuccess ? 1 : 0, offSuccess ? 1 : 0, successFlag(onSuccess, offSuccess)),
		row("blocks_total", onMetrics.blocks_total, offMetrics.blocks_total, null),
		row("block_loops", onMetrics.block_loops, offMetrics.block_loops, onMetrics.block_loops > 0 ? "block_loop" : null),
		row("warnings", onMetrics.warnings, offMetrics.warnings, null),
		row("noise_ratio", onNoise, offNoise, onNoise > NOISE_RATIO_WARN_THRESHOLD ? "noisy" : null),
		row("edits", onMetrics.edits, offMetrics.edits, null),
		row("verifier_runs", onMetrics.verifier_runs, offMetrics.verifier_runs, null),
		row("turns", onMetrics.turns, offMetrics.turns, null),
	];
}

function hasConsecutiveFailures(sortedCells: ArmCellSummary[], atLeast: number): boolean {
	let run = 0;
	for (const cell of sortedCells) {
		run = cell.success ? 0 : run + 1;
		if (run >= atLeast) return true;
	}
	return false;
}

function regressionReasons(onCells: ArmCellSummary[], offSucceeded: boolean): { fail: boolean; reasons: string[] } {
	if (!offSucceeded) return { fail: false, reasons: [] };
	if (hasConsecutiveFailures(onCells, 2)) {
		return { fail: true, reasons: ["succeeds harness-off but failed harness-on twice in a row"] };
	}
	if (onCells.some((c) => !c.success)) {
		return {
			fail: false,
			reasons: ["harness-regression candidate: failed harness-on while harness-off succeeds (re-run with --repeat 2)"],
		};
	}
	return { fail: false, reasons: [] };
}

/**
 * Verdict for one (task, runner) group across repeats.
 * FAIL: harness-off succeeds but harness-on failed >=2 consecutive reps.
 * WARN: single on-arm failure vs off success, any on-arm block loop, or noise ratio above threshold.
 */
export function taskVerdict(cells: ArmCellSummary[]): TaskVerdict {
	const onCells = cells.filter((c) => c.arm === "on").sort((a, b) => a.rep - b.rep);
	const offCells = cells.filter((c) => c.arm === "off");
	if (onCells.length === 0 || offCells.length === 0) {
		return {
			verdict: "SKIP",
			reasons: [`need both arms to compare (have on=${onCells.length}, off=${offCells.length})`],
		};
	}
	const offSucceeded = offCells.some((c) => c.success);
	const regression = regressionReasons(onCells, offSucceeded);
	const reasons = [...regression.reasons];
	if (onCells.some((c) => c.metrics.block_loops > 0)) {
		reasons.push("block loop on harness-on arm (same rule blocked >=3x consecutively)");
	}
	if (onCells.some((c) => noiseRatio(c.metrics) > NOISE_RATIO_WARN_THRESHOLD)) {
		reasons.push(`harness-on noise ratio above ${NOISE_RATIO_WARN_THRESHOLD} (warnings per tool call)`);
	}
	if (regression.fail) return { verdict: "FAIL", reasons };
	return reasons.length > 0 ? { verdict: "WARN", reasons } : { verdict: "PASS", reasons: [] };
}
