// ===========================================
// Block-fingerprint session integration (P1 trajectory, DW-continuity)
// ===========================================
// Wires the pure fingerprint store (`block-fingerprint.ts`) into session state:
// record a refused action when a PreToolUse block fires; on a later candidate
// event, run the four workaround detectors against the still-armed
// fingerprints; count what fires and surface it ONCE at Stop. Shadow by design
// — detection never blocks (the continuity doctrine: an agent must run
// continuously, and a mid-flow block on suspicion is what derails it). The
// armed set is IN-MEMORY on the session (not serialized) — a stale block should
// not survive a daemon restart; SessionStart preload is a separate mechanism.

import { relative, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { isFileWrite } from "../evaluator/tool-classifiers.js";
import { resolveProposedContent } from "../overlay-content.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	type BlockFingerprint,
	configLooseningAfterBlock,
	escapeEnvAfterBlock,
	fingerprintBlock,
	pruneExpired,
	sameContentResurfacing,
	sameTargetDifferentChannel,
} from "./block-fingerprint.js";
import { loadArmedFingerprints, persistArmedFingerprints } from "./fingerprint-archive.js";

/** One observed workaround: which detector fired and the rule it circumvents. */
export interface WorkaroundSignal {
	detector: string;
	ruleId: string;
}

/** A candidate tool action tested against the armed set. Any channel may be
 *  absent; `| undefined` is explicit for `exactOptionalPropertyTypes`. */
export interface WorkaroundCandidate {
	content?: string | null | undefined;
	command?: string | null | undefined;
	target?: string | null | undefined;
	/** Which channel this action arrives on — see BlockFingerprint.channel. */
	channel?: "write" | "command" | undefined;
}

/** Record a refused action into the session's armed fingerprint set (pruning
 *  expired ones first). Called when a PreToolUse block is finalized. */
export function recordBlockFingerprint(
	session: SessionTrajectory,
	input: { ruleId: string; content: string; target?: string | null; atMs: number; channel?: "write" | "command" | undefined },
): void {
	const armed = pruneExpired(session.block_fingerprints ?? [], input.atMs);
	armed.push(fingerprintBlock(input));
	session.block_fingerprints = armed;
}

/**
 * Both channels known AND equal.
 *
 * An UNKNOWN channel must never suppress the signal — a fingerprint persisted by
 * an older daemon has none, and defaulting that to "same" would silently switch
 * the detector off for every pre-upgrade session. Unknown fails toward reporting.
 */
function sameKnownChannel(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a === b;
}

/** Content/target resurfacing counts as evasion only on the command channel —
 *  a bash redirect is the one path that dodges the write gates. */
function detectCommandChannelResurfacing(
	armed: readonly BlockFingerprint[],
	candidate: WorkaroundCandidate,
): WorkaroundSignal | null {
	if (candidate.channel !== "command") return null;
	const byContent = candidate.content ? sameContentResurfacing(armed, candidate.content) : null;
	if (byContent && !sameKnownChannel(byContent.channel, candidate.channel)) {
		return { detector: "same-content-resurfacing", ruleId: byContent.ruleId };
	}
	const byTarget = sameTargetDifferentChannel(armed, candidate.target);
	if (byTarget) return { detector: "same-target-different-channel", ruleId: byTarget.ruleId };
	return null;
}

/** An ALLOWED write on an armed target means the objection was remediated —
 *  disarm it so a later incidental bash touch cannot fire a stale signal. */
function disarmRemediatedTarget(
	session: SessionTrajectory,
	armed: BlockFingerprint[],
	candidate: WorkaroundCandidate,
): void {
	if (candidate.channel !== "write" || !candidate.target) {
		session.block_fingerprints = armed;
		return;
	}
	const norm = candidate.target.replace(/\\/g, "/");
	session.block_fingerprints = armed.filter((f) => f.target !== norm);
}

/**
 * Run the four workaround detectors on a candidate event against the armed set.
 * Returns the first signal (highest-priority detector), or null. `content` is
 * the candidate's proposed file content / patch body; `command` its bash
 * command; `target` its write path — any may be absent.
 */
export function detectWorkaround(
	session: SessionTrajectory,
	candidate: WorkaroundCandidate,
	nowMs: number,
): WorkaroundSignal | null {
	const armed = pruneExpired(session.block_fingerprints ?? [], nowMs);
	if (armed.length === 0) return null;

	// Only movement to an UNDER-GATED channel can evade a gate (2026-08-23,
	// generalized from the command→write carve-out after six FP signals in one
	// session). A Write-channel candidate reaching this point was fully judged
	// and ALLOWED — that is remediation by definition, whatever the gate was:
	// test-first after a TDD block, extract-then-shrink after the line cap,
	// resequenced edits after the tsc overlay all legitimately revisit the same
	// target/content through gated tools. So the content/target detectors fire
	// only for command-channel candidates (the bash side, where a redirect can
	// dodge the write gates); an allowed write DISARMS its target instead.
	// Env-escape and config-loosening below stay channel-independent — those
	// shapes are evasion on any channel.
	const commandSignal = detectCommandChannelResurfacing(armed, candidate);
	if (commandSignal) return commandSignal;
	disarmRemediatedTarget(session, armed, candidate);

	const byConfig = configLooseningAfterBlock(armed, candidate.target);
	if (byConfig) return { detector: "config-loosening-in-window", ruleId: byConfig.ruleId };

	const byEnv = candidate.command ? escapeEnvAfterBlock(armed, candidate.command) : null;
	if (byEnv) return { detector: "escape-env-after-block", ruleId: byEnv.ruleId };

	return null;
}

/** Record a detected workaround signal onto the session (deduped by
 *  detector+rule so a repeated attempt counts once). */
export function noteWorkaroundSignal(session: SessionTrajectory, signal: WorkaroundSignal): void {
	const seen = session.workaround_signals ?? [];
	if (seen.some((s) => s.detector === signal.detector && s.ruleId === signal.ruleId)) return;
	seen.push(signal);
	session.workaround_signals = seen;
}

/** The once-per-session Stop reflection line, or null when no workaround was
 *  observed. Names the detectors + circumvented rules; framed as observation,
 *  never accusation. */
export function formatWorkaroundStopLine(session: SessionTrajectory): string | null {
	const signals = session.workaround_signals ?? [];
	if (signals.length === 0) return null;
	const detail = signals
		.slice(0, 4)
		.map((s) => `${s.detector} (vs ${s.ruleId})`)
		.join("; ");
	return (
		`[interlinked:trajectory] ${signals.length} workaround signal(s) this session — after a block, the ` +
		`refused action resurfaced through another channel: ${detail}. If a gate mis-modeled a legitimate ` +
		"change, that is a gate defect to report — routing around it silently defeats the guarantee it protects."
	);
}

function strField(input: JsonObject, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

/**
 * Extract the workaround-detection candidate from a tool event. For a
 * Write/Edit: the proposed content (reconstructed via the overlay, so a blocked
 * edit yields its would-be content) and the repo-relative target path. For any
 * other tool (Bash the common one): the command serves as BOTH the content
 * channel — a heredoc/redirect can reproduce refused file content inline — and
 * the escape-env channel.
 */
function candidateFromEvent(event: HarnessEvent, cwd: string): WorkaroundCandidate {
	const input = event.tool_input ?? {};
	const command = typeof input.command === "string" ? input.command : undefined;
	if (isFileWrite(event.tool_name)) {
		const named = strField(input, "file_path") || strField(input, "path");
		if (!named) return { target: null };
		const abs = resolve(cwd, named);
		return {
			content: resolveProposedContent(abs, input),
			target: relative(cwd, abs).replace(/\\/g, "/"),
			channel: "write",
		};
	}
	return { content: command, command, target: null, channel: "command" };
}

/** Hot-path fast exit: a non-block event with nothing armed has nothing to
 *  record and nothing to detect against — skip the candidate extraction (which
 *  reads the file for a Write/Edit). */
function nothingToObserve(session: SessionTrajectory, decision: HarnessDecision): boolean {
	return decision.decision !== "block" && (session.block_fingerprints?.length ?? 0) === 0;
}

/** Load the persisted armed set the first time this daemon sees the session
 *  (continuity across a mid-session build-refresh restart). `block_fingerprints
 *  === undefined` is the fresh-session signal; hydration always leaves it
 *  defined (possibly `[]`), so this runs at most once per session per daemon and
 *  never self-duplicates. */
function hydrateOnce(
	session: SessionTrajectory,
	cwd: string,
	sessionId: string,
	nowMs: number,
): void {
	if (session.block_fingerprints !== undefined) return;
	const loaded = loadArmedFingerprints(cwd, sessionId, nowMs);
	session.block_fingerprints = loaded?.fingerprints ?? [];
	if (loaded && loaded.signals.length > 0) {
		session.workaround_signals = [...(session.workaround_signals ?? []), ...loaded.signals];
	}
}

/** Write-through the current armed set + signals for restart continuity. */
function persistNow(session: SessionTrajectory, cwd: string, sessionId: string): void {
	persistArmedFingerprints(
		cwd,
		sessionId,
		session.block_fingerprints ?? [],
		session.workaround_signals ?? [],
	);
}

/**
 * The single choke-point glue (wired at the pre-tool decision boundary): arm a
 * fingerprint when THIS event was blocked; otherwise — the event is getting
 * through — check whether it reproduces a still-armed refusal and note the
 * signal. The two paths are mutually exclusive per event, so a still-blocked
 * retry (which the harness already caught) never counts as a workaround, and a
 * block never self-matches. Returns the noted signal, or null. Shadow-only.
 */
export function observeBlockWorkaround(
	session: SessionTrajectory,
	event: HarnessEvent,
	decision: HarnessDecision,
	cwd: string,
	nowMs: number,
): WorkaroundSignal | null {
	hydrateOnce(session, cwd, event.session_id, nowMs);
	if (nothingToObserve(session, decision)) return null;
	const candidate = candidateFromEvent(event, cwd);
	if (decision.decision === "block") {
		recordBlockFingerprint(session, {
			ruleId: decision.rule_id ?? "block",
			content: candidate.content ?? candidate.command ?? "",
			target: candidate.target ?? null,
			atMs: nowMs,
			channel: candidate.channel,
		});
		persistNow(session, cwd, event.session_id);
		return null;
	}
	const signal = detectWorkaround(session, candidate, nowMs);
	if (signal) {
		noteWorkaroundSignal(session, signal);
		persistNow(session, cwd, event.session_id);
	}
	return signal;
}

export type { BlockFingerprint };
