// ===========================================
// Trajectory State Machine — Per-Session Anti-Pattern Detection (Phase D.2)
// ===========================================
//
// Some agent misbehavior is invisible to per-tool-call rules but obvious
// from the *trajectory* — the sequence of recent tool calls. This module
// runs on every PreToolUse and classifies the recent buffer for that
// session into zero or more anti-pattern findings.
//
// Detected patterns:
//   - tool_loop:           same tool + same input >5 times in 60s with no
//                          observable state change (Edit/Write/MultiEdit).
//   - destructive_sequence: rm → mkdir/touch → rm of the same path within 30s.
//   - unbackedoff_retry:   3+ consecutive PostToolUseFailure on identical Bash
//                          commands with no `sleep`/`wait` between attempts.
//   - silent_stall:        > 10 minute gap since the previous event in the
//                          same session (agent appears stuck).
//
// Constraints:
//   - Sub-millisecond per-event cost. Ring buffer + linear scan over ≤50
//     events; no per-event regex compilation, no fs I/O.
//   - No external dependencies.
//
// Findings surface as PreToolUse warnings (severity "warning"); the harness
// never blocks on a trajectory finding — humans break loops, not the CLI.

import type { JsonObject } from "../lib/json-types.js";

// ===========================================
// Public types
// ===========================================

export interface TrajectoryEvent {
	/** Epoch milliseconds for the event. */
	ts_ms: number;
	/** Hook event class. PostToolUseFailure is treated as a separate phase
	 *  for the unbackedoff_retry detector. */
	hook_event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
	/** Agent tool name (e.g. "Bash", "Edit", "Read"). */
	tool_name: string;
	/** Full tool input as observed; the detector reads `command`/`file_path`
	 *  out of it. May be omitted when not relevant. */
	tool_input?: JsonObject | undefined;
	/** Decision returned for the previous evaluation, if known. Reserved for
	 *  future use; current detectors do not consult it. */
	decision?: "allow" | "block" | "ask" | undefined;
	/** Whether the tool call succeeded (PostToolUse only). */
	succeeded?: boolean | undefined;
}

export interface TrajectoryFinding {
	/** Anti-pattern that fired. */
	pattern: "tool_loop" | "destructive_sequence" | "unbackedoff_retry" | "silent_stall";
	/** Severity tier; trajectory findings never block, so this is always
	 *  "warning" in v1. "info" reserved for downstream debug surfaces. */
	severity: "warning" | "info";
	/** Human-readable single-line message intended for hook stderr. */
	message: string;
	/** Timestamp at which the pattern was detected (always the latest event's
	 *  ts_ms — detectors are causally bound to the observe() call). */
	detected_at_ms: number;
	/** How far back the detection looked (ms). 0 for stateless / no-window
	 *  patterns; non-zero for the time-windowed ones. */
	window_ms: number;
	/** Up to 3 truncated, quoted snippets that were the basis for the finding.
	 *  Each entry is bounded to ~80 chars to keep stderr readable. */
	evidence: string[];
}

export interface TrajectoryOptions {
	/** Cap on the per-session ring buffer. Default 50. Lower bounds: 16. */
	bufferSize?: number;
	/** Cooldown between repeated firings of the same pattern. Defaults to
	 *  the detector window for the pattern; set to 0 to fire on every observe. */
	cooldownMs?: number;
}

export interface TrajectoryDetector {
	/** Append an event to the session ring buffer and run all enabled
	 *  detectors. Returns any findings produced by the *new* event. */
	observe(event: TrajectoryEvent): TrajectoryFinding[];
	/** Drop all internal state so the next observe() starts fresh. */
	reset(): void;
}

// ===========================================
// Detection thresholds
// ===========================================
//
// Spec from `docs/plans/free-cli-adoption/05-trajectory-state-machine.md`
// + the Phase-D.2 brief in `majestic-wiggling-pearl.md`. The brief tightens
// some thresholds vs. the original plan (>5 in 60s for tool_loop; > 10m for
// silent_stall), so the brief wins for v1.

const TOOL_LOOP_THRESHOLD = 5; // strict greater-than: fires when count > 5 (i.e. ≥ 6)
const TOOL_LOOP_WINDOW_MS = 60_000;
const DESTRUCTIVE_SEQUENCE_WINDOW_MS = 30_000;
const UNBACKED_RETRY_THRESHOLD = 3;
const UNBACKED_RETRY_SLEEP_RX = /\b(?:sleep|wait)\b/;
const SILENT_STALL_MS = 10 * 60_000;
const DEFAULT_BUFFER_SIZE = 50;
const MIN_BUFFER_SIZE = 16;
const EVIDENCE_MAX_CHARS = 80;
const EVIDENCE_MAX_ITEMS = 3;

// Tool names whose successful invocation counts as an "observable state
// change" — they break tool_loop runs even when the surrounding reads keep
// repeating. Kept as a narrow set so we err toward firing on legit loops.
const STATE_CHANGE_TOOLS = new Set([
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
	"apply_patch",
]);

// Destructive command match: rm/rmdir with any path argument. We don't
// require flags so that `rm /tmp/x` is caught alongside `rm -rf build`.
const DESTRUCTIVE_RX = /^\s*(?:sudo\s+)?(?:rm|rmdir|unlink)\s+/;
const RECREATE_RX = /^\s*(?:sudo\s+)?(?:mkdir|touch|cp|mv|tee|cat\s*>)\s+/;

// ===========================================
// Factory
// ===========================================

export function createTrajectoryDetector(opts?: TrajectoryOptions): TrajectoryDetector {
	const bufferSize = Math.max(MIN_BUFFER_SIZE, opts?.bufferSize ?? DEFAULT_BUFFER_SIZE);
	const buffer: TrajectoryEvent[] = [];
	// Last fire-time per pattern, to throttle repeat findings inside the same
	// detection window. Without this, a 6-call loop would fire on calls 6, 7,
	// 8, ... — noisy. Cooldown defaults to the pattern's own window.
	const lastFireMs = new Map<TrajectoryFinding["pattern"], number>();
	const cooldownOverride = opts?.cooldownMs;

	function push(event: TrajectoryEvent): void {
		buffer.push(event);
		if (buffer.length > bufferSize) {
			buffer.splice(0, buffer.length - bufferSize);
		}
	}

	function fired(pattern: TrajectoryFinding["pattern"], nowMs: number, defaultWindow: number): boolean {
		const last = lastFireMs.get(pattern);
		if (last === undefined) return false;
		const cooldown = cooldownOverride ?? defaultWindow;
		if (cooldown <= 0) return false;
		return nowMs - last < cooldown;
	}

	function markFired(pattern: TrajectoryFinding["pattern"], nowMs: number): void {
		lastFireMs.set(pattern, nowMs);
	}

	return {
		observe(event: TrajectoryEvent): TrajectoryFinding[] {
			push(event);
			const findings: TrajectoryFinding[] = [];

			const stallFinding = detectSilentStall(buffer);
			if (stallFinding && !fired("silent_stall", event.ts_ms, SILENT_STALL_MS)) {
				findings.push(stallFinding);
				markFired("silent_stall", event.ts_ms);
			}

			const loopFinding = detectToolLoop(buffer);
			if (loopFinding && !fired("tool_loop", event.ts_ms, TOOL_LOOP_WINDOW_MS)) {
				findings.push(loopFinding);
				markFired("tool_loop", event.ts_ms);
			}

			const destructiveFinding = detectDestructiveSequence(buffer);
			if (
				destructiveFinding &&
				!fired("destructive_sequence", event.ts_ms, DESTRUCTIVE_SEQUENCE_WINDOW_MS)
			) {
				findings.push(destructiveFinding);
				markFired("destructive_sequence", event.ts_ms);
			}

			const retryFinding = detectUnbackedoffRetry(buffer);
			if (retryFinding && !fired("unbackedoff_retry", event.ts_ms, TOOL_LOOP_WINDOW_MS)) {
				findings.push(retryFinding);
				markFired("unbackedoff_retry", event.ts_ms);
			}

			return findings;
		},
		reset(): void {
			buffer.length = 0;
			lastFireMs.clear();
		},
	};
}

// ===========================================
// Detectors
// ===========================================

/** Index of the most recent observable state change (Edit/Write/MultiEdit
 *  PostToolUse) at or after `cutoff`; -1 when the window holds none. */
function findLastStateChangeIndex(buffer: TrajectoryEvent[], cutoff: number): number {
	for (let i = buffer.length - 1; i >= 0; i--) {
		const e = buffer[i];
		if (!e) continue;
		if (e.ts_ms < cutoff) break;
		if (STATE_CHANGE_TOOLS.has(e.tool_name) && e.hook_event === "PostToolUse") return i;
	}
	return -1;
}

/** Tally PreToolUse events from `startIdx` onward, keyed by tool name plus
 *  normalized input, skipping anything older than `cutoff`. */
function countCallsByInput(
	buffer: TrajectoryEvent[],
	startIdx: number,
	cutoff: number,
): Map<string, { count: number; events: TrajectoryEvent[] }> {
	const counts = new Map<string, { count: number; events: TrajectoryEvent[] }>();
	for (let i = startIdx; i < buffer.length; i++) {
		const e = buffer[i];
		if (!e) continue;
		if (e.ts_ms < cutoff) continue;
		if (e.hook_event !== "PreToolUse") continue;
		const key = `${e.tool_name}::${normalizeInput(e.tool_input)}`;
		const entry = counts.get(key);
		if (entry) {
			entry.count += 1;
			entry.events.push(e);
		} else {
			counts.set(key, { count: 1, events: [e] });
		}
	}
	return counts;
}

/** Tool-loop: same tool_name + similar tool_input called > 5 times in 60s
 *  with no observable state change in the intervening events. */
function detectToolLoop(buffer: TrajectoryEvent[]): TrajectoryFinding | null {
	const last = buffer[buffer.length - 1];
	if (!last) return null;
	const cutoff = last.ts_ms - TOOL_LOOP_WINDOW_MS;

	// Count occurrences keyed by (tool_name, normalized_input) within the
	// recent window AFTER the most recent state-change event. Tool calls
	// before a state change are conceptually a fresh batch.
	const stateChangeIdx = findLastStateChangeIndex(buffer, cutoff);
	const counts = countCallsByInput(buffer, stateChangeIdx + 1, cutoff);

	for (const [key, entry] of counts) {
		if (entry.count > TOOL_LOOP_THRESHOLD) {
			const tool = key.split("::", 1)[0] ?? "tool";
			const evidence = entry.events
				.slice(-EVIDENCE_MAX_ITEMS)
				.map((e) => quoteEvidence(summarizeInput(e)));
			return {
				pattern: "tool_loop",
				severity: "warning",
				message: `[interlinked:trajectory] looping on ${tool}; consider checking state externally (${entry.count} identical calls in ${Math.round(TOOL_LOOP_WINDOW_MS / 1000)}s)`,
				detected_at_ms: last.ts_ms,
				window_ms: TOOL_LOOP_WINDOW_MS,
				evidence,
			};
		}
	}
	return null;
}

/** Destructive cycle: rm A → recreate A → rm A again, all within 30s.
 *  Indicates the agent is in a delete/recreate spin. */
function detectDestructiveSequence(buffer: TrajectoryEvent[]): TrajectoryFinding | null {
	const last = buffer[buffer.length - 1];
	if (!last) return null;
	if (last.hook_event !== "PreToolUse" || last.tool_name !== "Bash") return null;
	const lastCmd = readCommand(last.tool_input);
	if (!lastCmd) return null;
	if (!DESTRUCTIVE_RX.test(lastCmd)) return null;
	const lastTarget = extractFirstPath(lastCmd, DESTRUCTIVE_RX);
	if (!lastTarget) return null;

	const cutoff = last.ts_ms - DESTRUCTIVE_SEQUENCE_WINDOW_MS;
	const cycle = findDestructiveCyclePrefix(buffer, cutoff, lastTarget);
	if (!cycle) return null;
	const { recreateAt, earlierRmAt } = cycle;

	const evidence = [earlierRmAt, recreateAt, buffer.length - 1]
		.map((idx) => buffer[idx])
		.filter((e): e is TrajectoryEvent => Boolean(e))
		.map((e) => quoteEvidence(summarizeInput(e)));

	return {
		pattern: "destructive_sequence",
		severity: "warning",
		message: `[interlinked:trajectory] destructive cycle on ${lastTarget}; pause and verify`,
		detected_at_ms: last.ts_ms,
		window_ms: DESTRUCTIVE_SEQUENCE_WINDOW_MS,
		evidence,
	};
}

/** Walk backward from the second-to-last buffer event looking for a recreate
 *  of `lastTarget` and, further back, an earlier rm of the same target — the
 *  two positions `detectDestructiveSequence` needs to confirm a cycle. Order:
 *  the latest event is rm (caller already verified). Need to find, excluding
 *  the latest event:
 *    * a recreate event that touches lastTarget, AND
 *    * an earlier rm event that targets lastTarget,
 *  with the recreate temporally between the two rms. Stops scanning once
 *  `cutoff` is passed. Returns null if the window closes before both are
 *  found. */
/** True when `cmd` matches `rx` and the first path it names overlaps
 *  `lastTarget`. */
function commandTouchesTarget(cmd: string, rx: RegExp, lastTarget: string): boolean {
	if (!rx.test(cmd)) return false;
	const target = extractFirstPath(cmd, rx);
	return Boolean(target && pathsOverlap(target, lastTarget));
}

function findDestructiveCyclePrefix(
	buffer: TrajectoryEvent[],
	cutoff: number,
	lastTarget: string,
): { recreateAt: number; earlierRmAt: number } | null {
	let recreateAt = -1;
	let earlierRmAt = -1;
	for (let i = buffer.length - 2; i >= 0; i--) {
		const e = buffer[i];
		if (!e) continue;
		if (e.ts_ms < cutoff) break;
		if (e.tool_name !== "Bash") continue;
		const cmd = readCommand(e.tool_input);
		if (!cmd) continue;

		if (recreateAt === -1) {
			if (commandTouchesTarget(cmd, RECREATE_RX, lastTarget)) recreateAt = i;
			continue;
		}
		if (commandTouchesTarget(cmd, DESTRUCTIVE_RX, lastTarget)) {
			earlierRmAt = i;
			break;
		}
	}

	if (recreateAt === -1 || earlierRmAt === -1) return null;
	return { recreateAt, earlierRmAt };
}

/** Unbacked-off retry: 3+ consecutive trailing PostToolUseFailure events
 *  for the same Bash command with no `sleep`/`wait` between attempts. */
function detectUnbackedoffRetry(buffer: TrajectoryEvent[]): TrajectoryFinding | null {
	if (buffer.length < UNBACKED_RETRY_THRESHOLD) return null;
	const last = buffer[buffer.length - 1];
	if (!last || last.hook_event !== "PostToolUseFailure") return null;
	if (last.tool_name !== "Bash") return null;
	const lastCmd = readCommand(last.tool_input);
	if (!lastCmd) return null;

	// Walk backwards from the trailing event. Count consecutive
	// PostToolUseFailures with the same command. Any non-failure or
	// different command, OR any sleep/wait between them, breaks the run.
	let consecutive = 0;
	const evidenceEvents: TrajectoryEvent[] = [];
	for (let i = buffer.length - 1; i >= 0; i--) {
		const e = buffer[i];
		if (!e) break;
		if (e.tool_name !== "Bash") break;
		const cmd = readCommand(e.tool_input);
		if (!cmd) break;
		if (e.hook_event === "PostToolUseFailure") {
			if (cmd !== lastCmd) break;
			consecutive += 1;
			evidenceEvents.push(e);
			continue;
		}
		// Non-failure event in the trailing run. If it's a sleep/wait, the
		// retries WERE backed off and we abort cleanly. If it's anything
		// else (success, unrelated tool call), the run is also broken.
		if (UNBACKED_RETRY_SLEEP_RX.test(cmd)) {
			return null;
		}
		break;
	}

	if (consecutive < UNBACKED_RETRY_THRESHOLD) return null;

	const evidence = evidenceEvents.slice(0, EVIDENCE_MAX_ITEMS).map((e) => quoteEvidence(summarizeInput(e)));
	return {
		pattern: "unbackedoff_retry",
		severity: "warning",
		message: `[interlinked:trajectory] ${consecutive} retries without backoff on ${truncate(lastCmd, EVIDENCE_MAX_CHARS)}`,
		detected_at_ms: last.ts_ms,
		window_ms: 0,
		evidence,
	};
}

/** Silent stall: gap > 10 minutes between the latest event and the previous
 *  event in the buffer. Indicates the agent went quiet within a session. */
function detectSilentStall(buffer: TrajectoryEvent[]): TrajectoryFinding | null {
	if (buffer.length < 2) return null;
	const last = buffer[buffer.length - 1];
	const prev = buffer[buffer.length - 2];
	if (!last || !prev) return null;
	const gap = last.ts_ms - prev.ts_ms;
	if (gap <= SILENT_STALL_MS) return null;
	const minutes = Math.round(gap / 60_000);
	return {
		pattern: "silent_stall",
		severity: "warning",
		message: `[interlinked:trajectory] session has been idle for ${minutes}m; agent may be stuck`,
		detected_at_ms: last.ts_ms,
		window_ms: gap,
		evidence: [quoteEvidence(summarizeInput(prev))],
	};
}

// ===========================================
// Helpers
// ===========================================

/** Stringify the relevant fields of tool_input for similarity comparison.
 *  Pulls only the well-known agent-tool field names so we don't leak
 *  arbitrary state into the dedup key. */
function normalizeInput(input: JsonObject | undefined): string {
	if (!input) return "";
	const fields: string[] = [];
	for (const key of ["command", "file_path", "path", "url", "pattern", "old_string"]) {
		const v = input[key];
		if (typeof v === "string") {
			fields.push(`${key}=${v.trim()}`);
		}
	}
	return fields.join("|");
}

/** Extract a `command` string from tool_input, defensively. */
function readCommand(input: JsonObject | undefined): string {
	if (!input) return "";
	const cmd = input.command;
	return typeof cmd === "string" ? cmd : "";
}

/** First path-like argument after a verb. We're not parsing shell — just
 *  pulling the first whitespace-delimited token after the matched verb that
 *  isn't a flag. Good enough for `rm -rf build` / `mkdir -p build` patterns. */
function extractFirstPath(cmd: string, leadRx: RegExp): string {
	const matched = cmd.match(leadRx);
	if (!matched) return "";
	const rest = cmd.slice(matched[0].length).trim();
	if (!rest) return "";
	const tokens = rest.split(/\s+/);
	for (const tok of tokens) {
		if (!tok) continue;
		if (tok.startsWith("-")) continue;
		// Strip surrounding quotes.
		const stripped = tok.replace(/^['"]|['"]$/g, "");
		return stripped;
	}
	return "";
}

/** Loose path equivalence: same after trimming trailing slashes. Avoids
 *  false negatives between "build" and "build/". */
function pathsOverlap(a: string, b: string): boolean {
	const na = a.replace(/\/+$/, "");
	const nb = b.replace(/\/+$/, "");
	return na === nb;
}

function summarizeInput(e: TrajectoryEvent): string {
	const cmd = readCommand(e.tool_input);
	if (cmd) return `${e.tool_name}: ${cmd}`;
	const file = e.tool_input?.file_path;
	if (typeof file === "string") return `${e.tool_name}: ${file}`;
	return e.tool_name;
}

function quoteEvidence(s: string): string {
	return `"${truncate(s, EVIDENCE_MAX_CHARS)}"`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 1))}…`;
}
