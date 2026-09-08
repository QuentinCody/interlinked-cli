// ===========================================
// Gate reach — collection side (plan 16 §4)
// ===========================================
// The fs half of the meta-metric: enumerate the eligible domain, ask each
// gate's own artifact what it actually measured, append the figure to a ledger
// under `.interlinked/`, and hand the Stop path a warning when a gate is off or
// has lost reach. The arithmetic lives in `gate-reach.ts` (pure, unit-tested).
//
// Three constraints shape everything here:
//
//   1. OFF THE HOT PATH. This walks the tree and reads JSON artifacts, so it
//      runs at Stop only, self-throttled to once per session per interval. No
//      PreToolUse surface may call it.
//   2. ONE domain definition. `eligible` comes from
//      `large-file-policy.ts::isCappableFile` — the repo's single product-code
//      predicate — because gates disagreeing about scope is half the problem
//      this module reports on. The extension pre-filter below narrows to the
//      JS/TS family the wired gates measure; it never re-decides an exemption.
//   3. NEVER THROW. Modeled on `daemon-ledger.ts`: a diary failure must not
//      harm the daemon, so every fs path fails soft.
//
// Writes go through plain `fs` from inside the harness, exactly as
// `daemon-ledger.ts` / `coverage-ratchet.ts` do — never through the edit tools,
// which are barred from `.interlinked/`.

import { coverageExecutionReach } from "./coverage-execution.js";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { baselinePath, loadBaseline } from "./coverage-ratchet.js";
import {
	buildGateReachSnapshot,
	compareGateReach,
	formatGateReachReport,
	type GateReachInput,
	type GateReachSnapshot,
} from "./gate-reach.js";
import { isCappableFile } from "./large-file-policy.js";
import { findManifestFiles } from "./manifest-file-walk.js";

/** Repo-relative ledger path. Append-only JSONL, one snapshot per line. */
export const GATE_REACH_LEDGER_REL = join(".interlinked", "gate-reach.jsonl");

/**
 * Extension pre-filter for the walk. This is a LANGUAGE gate, not a second
 * scope definition — `isCappableFile` still decides every exemption. Same
 * regex the coverage-debt gate uses for the same reason: the wired gates
 * (coverage ratchet, per-edit coverage) measure the JS/TS family only, so
 * counting `.py`/`.go` files in the denominator would report a blind spot that
 * is really an out-of-scope language.
 */
const CODE_EXT_RE = /\.[cm]?[jt]sx?$/i;

/**
 * Bytes read per file to answer `isCappableFile`'s two CONTENT predicates
 * (`isGeneratedFile`, the `@codegen-data` marker). Both are bounded 20-line
 * header scans, so a header read is sufficient and turns a whole-tree content
 * read into a fixed small cost. If a file's first 20 lines exceed this budget
 * the marker is missed and the file counts as eligible — the conservative
 * direction: it inflates the denominator (louder), never the reach.
 */
const HEADER_BYTES = 8192;

/** Tail bound for ledger reads — ~64KB is many snapshots at ~1KB each. */
const READ_TAIL_BYTES = 64 * 1024;

/** Minimum gap between collections for one session. The walk is Stop-latency
 *  grade, but Stop fires per TURN; without this a long session would re-walk
 *  the tree dozens of times to re-report an unchanged figure. */
const DEFAULT_COLLECT_INTERVAL_MS = 15 * 60 * 1000;

function ledgerPath(cwd: string): string {
	return join(cwd, GATE_REACH_LEDGER_REL);
}

/** Read the first `HEADER_BYTES` of a file, or null when unreadable. */
function readHeader(abs: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(abs, "r");
		const buffer = Buffer.alloc(HEADER_BYTES);
		const bytes = readSync(fd, buffer, 0, HEADER_BYTES, 0);
		return buffer.subarray(0, bytes).toString("utf-8");
	} catch (err) {
		void err; // unreadable file: excluded from the domain, never fatal
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch (err) {
				void err;
			}
		}
	}
}

/**
 * Repo-relative POSIX paths of every file the product-code predicate governs.
 * THE denominator for every gate's reach. Sorted (the walker sorts each
 * directory), so two runs over an unchanged tree agree exactly.
 */
export function enumerateEligibleFiles(cwd: string): string[] {
	const candidates = findManifestFiles(cwd, (name) => CODE_EXT_RE.test(name));
	const eligible: string[] = [];
	for (const rel of candidates) {
		const content = readHeader(join(cwd, rel));
		if (content === null) continue;
		if (isCappableFile({ filePath: rel, content, root: cwd })) eligible.push(rel);
	}
	return eligible;
}

/** Append one snapshot. Never throws — see the module header. */
export function recordGateReach(cwd: string, snapshot: GateReachSnapshot): void {
	try {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		appendFileSync(ledgerPath(cwd), `${JSON.stringify(snapshot)}\n`);
	} catch (err) {
		// Deliberately quiet: this runs on the Stop path, where stderr is
		// agent-visible noise and there is no safer channel left.
		void err;
	}
}

/** Shape-check a parsed ledger row before trusting it. */
function parseSnapshotLine(line: string): GateReachSnapshot | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness checked above; each required field is type-tested
		// below before the row is handed to a caller.
		const candidate: Partial<GateReachSnapshot> = raw;
		if (candidate.version !== 1) return null;
		if (typeof candidate.at !== "string" || typeof candidate.session_id !== "string") return null;
		if (!Array.isArray(candidate.gates)) return null;
		// SAFETY: version/at/session_id/gates verified on the lines above.
		return candidate as GateReachSnapshot;
	} catch (err) {
		void err; // a torn final line from a killed daemon is expected
		return null;
	}
}

/** The newest valid snapshot from a bounded tail read, or null. Never throws. */
export function readLatestGateReachSnapshot(cwd: string): GateReachSnapshot | null {
	const path = ledgerPath(cwd);
	try {
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		const full = readFileSync(path, "utf-8");
		const tail = size > READ_TAIL_BYTES ? full.slice(full.length - READ_TAIL_BYTES) : full;
		const lines = tail.split("\n");
		// A mid-line cut at the tail boundary produces a torn first line; drop it.
		if (size > READ_TAIL_BYTES) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (line === undefined || line.trim() === "") continue;
			const snapshot = parseSnapshotLine(line);
			if (snapshot !== null) return snapshot;
		}
		return null;
	} catch (err) {
		void err;
		return null;
	}
}

/**
 * Whether this session should pay for a fresh walk. False only when the most
 * recent recorded snapshot belongs to THIS session and is younger than the
 * interval — a different session always re-collects, because "what did the
 * gates cover while I was working" is a per-session question.
 */
export function shouldCollectGateReach(args: {
	cwd: string;
	sessionId: string;
	now: number;
	intervalMs?: number;
}): boolean {
	const latest = readLatestGateReachSnapshot(args.cwd);
	if (latest === null || latest.session_id !== args.sessionId) return true;
	const previousAt = Date.parse(latest.at);
	if (!Number.isFinite(previousAt)) return true;
	return args.now - previousAt >= (args.intervalMs ?? DEFAULT_COLLECT_INTERVAL_MS);
}

/**
 * The coverage RATCHET's reach: how much of the eligible tree
 * `.interlinked/coverage-baseline.json` has a per-file water-line for. A file
 * recorded at 0% counts as MEASURED — the ratchet knows about it and will catch
 * a drop. Only a file the baseline never mentions is invisible to it.
 *
 * A missing baseline reports `source_unavailable`, never `measured=0`: the
 * ratchet may be perfectly healthy on a machine that simply has not run
 * coverage yet, and inventing a zero is the false-confidence failure inverted.
 */
function coverageRatchetInput(cwd: string, eligible: string[]): GateReachInput {
	const interlinkedDir = join(cwd, ".interlinked");
	if (!existsSync(baselinePath(interlinkedDir))) {
		return {
			gate: "coverage_ratchet",
			eligible: eligible.length,
			measured: 0,
			sourceUnavailable: true,
			reason: "no .interlinked/coverage-baseline.json",
		};
	}
	const recorded = new Set(Object.keys(loadBaseline(interlinkedDir).files).map((f) => f.replace(/\\/g, "/")));
	let measured = 0;
	for (const rel of eligible) {
		if (recorded.has(rel)) measured++;
	}
	return { gate: "coverage_ratchet", eligible: eligible.length, measured };
}

/**
 * Per-edit reach comes from the execution journal and current input hashes.
 * A disabled gate is explicit; an absent journal is unavailable. Old or failed
 * attempts never count as fresh measurements just because the gate is enabled.
 */
function perEditCoverageInput(eligible: string[], enabled: boolean, cwd: string): GateReachInput {
	const base = { gate: "per_edit_coverage", eligible: eligible.length, measured: 0 };
	if (!enabled) {
		return { ...base, disabled: true, reason: "config per_edit_coverage.enabled=false" };
	}
    const reach = coverageExecutionReach(cwd, eligible);
    if (!reach.present) return { ...base, sourceUnavailable: true, reason: "no_per_edit_measurement_ledger" };
    if (reach.issues.length) return { ...base, measured: reach.measured, sourceUnavailable: true, reason: reach.issues.join("; ") };
    return { ...base, measured: reach.measured, reason: `${reach.stale} stale or unavailable observations; ${reach.attempts} executions recorded` };
}

/** Walk the tree once and build every wired gate's figure. */
export function collectGateReachSnapshot(args: {
	cwd: string;
	sessionId: string;
	now: number;
	perEditCoverageEnabled: boolean;
	/** Optional gate-id allow-list, for surfaces that want a subset. */
	gates?: string[];
}): GateReachSnapshot {
	const eligible = enumerateEligibleFiles(args.cwd);
	// No product code in this tree — a docs-only checkout, a test fixture dir, a
	// cwd that is not a repo at all. There is no domain, so there is no reach
	// question to answer, and asking it anyway would nag every Stop in a
	// directory the gates were never meant to govern. (A real repo whose walk
	// broke also lands here; that trade is accepted — a false nag on every
	// non-repo Stop is the louder failure, and `enumerateEligibleFiles` is
	// directly tested.)
	const inputs: GateReachInput[] =
		eligible.length === 0
			? []
			: [
					coverageRatchetInput(args.cwd, eligible),
                    perEditCoverageInput(eligible, args.perEditCoverageEnabled, args.cwd),
				];
	const wanted = args.gates;
	return buildGateReachSnapshot({
		sessionId: args.sessionId,
		at: args.now,
		inputs: wanted === undefined ? inputs : inputs.filter((i) => wanted.includes(i.gate)),
	});
}

/**
 * Stop-path entry point: collect, record, compare against the previously
 * recorded snapshot, and return the agent-facing block (or null).
 *
 * The snapshot is recorded even when the block is null, so the ledger always
 * carries the figure and the next session has a water-line to compare against.
 * Never throws — every fs path inside fails soft.
 */
export function buildGateReachStopWarning(args: {
	cwd: string;
	sessionId: string;
	perEditCoverageEnabled: boolean;
	/** false = the session wrote nothing; the gates judged none of its work, so
	 *  the reach figure is nag, not signal — skip (undefined = legacy caller, run). */
	sessionWroteFiles?: boolean;
	now?: number;
	intervalMs?: number;
	gates?: string[];
}): string | null {
	if (args.sessionWroteFiles === false) return null;
	const now = args.now ?? Date.now();
	const throttle: { cwd: string; sessionId: string; now: number; intervalMs?: number } = {
		cwd: args.cwd,
		sessionId: args.sessionId,
		now,
		...(args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}),
	};
	if (!shouldCollectGateReach(throttle)) return null;
	// Read the water-line BEFORE appending, or the comparison is against self.
	const previous = readLatestGateReachSnapshot(args.cwd);
	const snapshot = collectGateReachSnapshot({
		cwd: args.cwd,
		sessionId: args.sessionId,
		now,
		perEditCoverageEnabled: args.perEditCoverageEnabled,
		...(args.gates !== undefined ? { gates: args.gates } : {}),
	});
	recordGateReach(args.cwd, snapshot);
	const regressions = compareGateReach(previous?.gates ?? [], snapshot.gates);
	return formatGateReachReport({ snapshot, regressions });
}
