// `interlinked trajectory` — inspect session trajectory state and replay
// recorded event streams through the sequence-detector framework.
//
// Three subcommands:
//   - `show [--session <id>]` — dump a trajectory snapshot from
//     `.interlinked/sessions/<id>.trajectory.json`. The most recent
//     snapshot is used when `--session` is omitted.
//   - `list` — enumerate snapshots on disk.
//   - `replay <events.jsonl>` — feed a recorded event stream through
//     `SessionTracker.recordEvent` and run every default-enabled sequence
//     detector at the appropriate phase. Used to debug FPs against real
//     session captures without rerunning the harness in production.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "../harness/sequence-checks/index.js";
import { SessionTracker } from "../harness/session-state.js";
import type { AgentSource, HarnessEvent, SessionTrajectory } from "../harness/types.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

interface CommonOpts {
	cwd?: string;
	json?: boolean;
}

interface ShowOpts extends CommonOpts {
	session?: string;
}

interface ReplayOpts extends CommonOpts {
	file: string;
	/** When set, only run the detector with the given id. */
	check?: string;
	/** When set, only emit findings for the given phase. */
	phase?: "pre_block" | "pre_warn" | "stop";
}

interface ListedSnapshot {
	session_id: string;
	path: string;
	modified_at: string;
	bytes: number;
}

interface SnapshotShape {
	session_id?: string;
	agent_name?: string;
	[k: string]: unknown;
}

function snapshotsDir(cwd: string): string {
	return join(cwd, ".interlinked", "sessions");
}

function listSnapshots(cwd: string): ListedSnapshot[] {
	const dir = snapshotsDir(cwd);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: ListedSnapshot[] = [];
	for (const name of entries) {
		if (!name.endsWith(".trajectory.json")) continue;
		const sessionId = name.slice(0, -".trajectory.json".length);
		const path = join(dir, name);
		let mtime: Date;
		let bytes: number;
		try {
			const st = statSync(path);
			mtime = st.mtime;
			bytes = st.size;
		} catch {
			continue;
		}
		out.push({
			session_id: sessionId,
			path,
			modified_at: mtime.toISOString(),
			bytes,
		});
	}
	out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
	return out;
}

export async function trajectoryListCommand(opts: CommonOpts = {}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const snapshots = listSnapshots(cwd);
	if (opts.json) {
		console.log(JSON.stringify({ snapshots }, null, 2));
		return;
	}
	if (snapshots.length === 0) {
		console.log("no trajectories on disk");
		return;
	}
	console.log(`${snapshots.length} trajectories on disk:`);
	for (const s of snapshots) {
		console.log(`  ${s.session_id}  (${s.bytes} bytes, modified ${s.modified_at})`);
	}
}

/** Pick the snapshot named by `--session`, or the most recent one when the
 *  flag is absent. Throws the same message the command reported inline. */
function resolveSnapshot(
	snapshots: ListedSnapshot[],
	sessionId: string | undefined,
): ListedSnapshot {
	let target: ListedSnapshot | undefined;
	if (sessionId) {
		target = snapshots.find((s) => s.session_id === sessionId);
	} else {
		target = snapshots[0];
	}
	if (!target) {
		const msg = sessionId
			? `no trajectory snapshot found for session ${sessionId}`
			: "no trajectory snapshots on disk";
		throw new Error(msg);
	}
	return target;
}

/** Print every snapshot field except the two already shown in the header,
 *  skipping empty values and values with no one-line summary. */
function printSnapshotFields(parsed: SnapshotShape): void {
	for (const [k, v] of Object.entries(parsed)) {
		if (k === "session_id" || k === "agent_name") continue;
		if (v === null || v === undefined) continue;
		const summary = summarizeValue(v);
		if (summary === null) continue;
		console.log(`${k}: ${summary}`);
	}
}

export async function trajectoryShowCommand(opts: ShowOpts = {}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const target = resolveSnapshot(listSnapshots(cwd), opts.session);
	const raw = readFileSync(target.path, "utf-8");
	if (opts.json) {
		console.log(raw);
		return;
	}
	let parsed: SnapshotShape;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`trajectory snapshot ${target.path} is malformed`, {
			cause: err,
		});
	}
	console.log(`session_id: ${parsed.session_id ?? target.session_id}`);
	console.log(`agent_name: ${parsed.agent_name ?? "—"}`);
	printSnapshotFields(parsed);
}

function summarizeValue(v: unknown): string | null {
	if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}…` : v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
	if (typeof v === "object") {
		const keys = Object.keys(v as JsonObject);
		return `{${keys.length} field${keys.length === 1 ? "" : "s"}}`;
	}
	return null;
}

/** Boundary parser for one line of a replayed events.jsonl. Only the four
 *  identity fields the tracker/dispatcher key on are validated; the rest of
 *  `HarnessEvent` is a wide, evolving wire shape shared across five agent
 *  runners (see `harness/types/events.ts`) that downstream code already
 *  reads defensively, and `trajectory replay`'s whole purpose is accepting
 *  real captured logs — including ones carrying fields this build doesn't
 *  know about — so it is carried through unchanged rather than re-validated
 *  field-by-field. `agent_source` is checked as a string, not narrowed to
 *  the `AgentSource` literal union: real wire events already carry values
 *  outside it (`interlinked skill` posts `agent_source: "cli"`), so a strict
 *  union check would reject legitimate captured rows. */
function parseHarnessEvent(value: unknown, lineNumber: number): HarnessEvent {
	if (!isJsonObject(value)) {
		throw new Error(`line ${lineNumber}: not a JSON object`);
	}
	const { hook_event, session_id, agent_source, timestamp } = value;
	if (typeof hook_event !== "string") {
		throw new Error(`line ${lineNumber}: missing/invalid hook_event`);
	}
	if (typeof session_id !== "string") {
		throw new Error(`line ${lineNumber}: missing/invalid session_id`);
	}
	if (typeof agent_source !== "string") {
		throw new Error(`line ${lineNumber}: missing/invalid agent_source`);
	}
	if (typeof timestamp !== "string") {
		throw new Error(`line ${lineNumber}: missing/invalid timestamp`);
	}
	return {
		...value,
		hook_event,
		session_id,
		agent_source: agent_source as AgentSource,
		timestamp,
	};
}

type ReplayPhase = "pre_block" | "pre_warn" | "stop";

interface ReplayFinding {
	event_index: number;
	phase: string;
	detector_id: string;
	message: string;
}

/** Parse every non-blank line of an events.jsonl into a HarnessEvent,
 *  reporting the 1-based line number of the first bad row. */
function parseEventLines(raw: string): HarnessEvent[] {
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	return lines.map((line, i) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`line ${i + 1}: invalid JSON`);
		}
		return parseHarnessEvent(parsed, i + 1);
	});
}

/** Feed every event through a fresh SessionTracker and collect the findings
 *  each requested phase reports for it. */
function collectReplayFindings(
	events: HarnessEvent[],
	phases: ReplayPhase[],
	isCheckMatch: (id: string) => boolean,
): ReplayFinding[] {
	const tracker = new SessionTracker();
	const findings: ReplayFinding[] = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i] as HarnessEvent;
		const trajectory: SessionTrajectory = tracker.recordEvent(event);
		for (const phase of phases) {
			const out = runSequenceDetectorsForPhase({
				phase,
				trajectory,
				candidate: event,
				isEnabled: (d) => d.default_enabled && isCheckMatch(d.id),
			});
			for (const f of out) {
				findings.push({
					event_index: i,
					phase,
					detector_id: f.detector_id,
					message: f.match.message,
				});
			}
		}
	}
	return findings;
}

/**
 * Replay an events.jsonl through the dispatcher. For each event, the
 * trajectory is updated via `SessionTracker.recordEvent`; the dispatcher
 * is then invoked with that event as the candidate. Findings from every
 * phase are accumulated and printed.
 *
 * When `--phase` is provided, only that phase is exercised (default: all
 * three). When `--check <id>` is provided, only matching detectors fire.
 */
export async function trajectoryReplayCommand(opts: ReplayOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const filePath = isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file);
	const events = parseEventLines(readFileSync(filePath, "utf-8"));

	const phases: ReplayPhase[] = opts.phase
		? [opts.phase]
		: ["pre_block", "pre_warn", "stop"];
	const isCheckMatch = opts.check
		? (id: string) => id === opts.check
		: () => true;
	const findings = collectReplayFindings(events, phases, isCheckMatch);

	if (opts.json) {
		console.log(
			JSON.stringify(
				{ events_replayed: events.length, findings },
				null,
				2,
			),
		);
		return;
	}
	console.log(`replayed ${events.length} event(s)`);
	if (findings.length === 0) {
		console.log("no findings");
		return;
	}
	for (const f of findings) {
		console.log(
			formatSequenceFinding({
				detector_id: f.detector_id,
				family: "quality",
				phase: f.phase as "pre_block" | "pre_warn" | "stop",
				match: { message: f.message },
			}),
		);
	}
}
