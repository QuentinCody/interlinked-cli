// ===========================================
// `interlinked harness taint status | clear`
// ===========================================
//
// `status` answers the question a block message could not: WHICH source set
// this session's sensitivity level, and is that attribution proven or inferred
// from a snapshot written before the `escalated` flag existed.
//
// `clear` is the recovery path the monotone ratchet lacks. It is OPERATOR-ONLY:
// it requires a real terminal on stdin AND stdout, and the operator to type the
// session id prefix. An agent's Bash tool call has no TTY, so the gated agent
// cannot clear the label it is gated by, and there is deliberately no
// `--yes` / `--force` to restore that capability.
//
// THIS GATE IS A CONVENIENCE, NOT A SECURITY BOUNDARY. Interlinked's local
// checks are "a fast deterministic guardrail, not a security trust boundary
// (it's local and bypassable)" — skills/interlinked-harness/SKILL.md. Anything
// that can write `.interlinked/sessions/<id>.live.json` can set any level it
// likes; the TTY gate stops an accident and an unthinking agent, not an
// adversary. The audit row in `.interlinked/taint-clears.jsonl` is what makes
// a clear reviewable after the fact.

import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import type { OptionValues } from "commander";
import {
	appendTaintClearAudit,
	type AuditAppendResult,
	type TaintClearAuditRow,
} from "../harness/taint-clear-log.js";
import { networkBlockedAt, type TaintSessionView } from "../harness/taint-control.js";
import type { SensitivityLevel } from "../harness/types.js";
import { getOutputMode, type OutputMode, output, outputError } from "../lib/output.js";
import {
	resolveTaintClear,
	resolveTaintStatus,
	type TaintClientDeps,
	type TaintResolution,
	taintClientDeps,
} from "./harness-taint-client.js";

export const NON_INTERACTIVE_REFUSAL =
	"`harness taint clear` is operator-only: it needs a real terminal on stdin and stdout. An agent tool call has no TTY, and there is no --yes/--force. Run it yourself from a shell.";

/** How many characters of the session id the operator must type. Long enough
 *  that a reflexive "y" cannot pass, short enough to type from the block
 *  message. */
const CONFIRM_PREFIX_LEN = 8;

export function confirmationToken(sessionId: string): string {
	return sessionId.length <= CONFIRM_PREFIX_LEN ? sessionId : sessionId.slice(0, CONFIRM_PREFIX_LEN);
}

export interface TaintCommandDeps extends TaintClientDeps {
	/** True only when BOTH stdin and stdout are terminals. */
	isInteractive: () => boolean;
	/** Read one line of operator input; the prompt goes to stderr so `--json`
	 *  output on stdout stays parseable. */
	promptLine: (question: string) => Promise<string>;
	operatorUser: () => string;
	pid: () => number;
	now: () => string;
	/** Operator-facing notices (preamble, prompt echo, warnings) → stderr. */
	write: (line: string) => void;
}

function readOneLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

/** Both streams must be terminals: an agent's Bash tool call has neither, and
 *  a piped stdin with a terminal stdout is still not an operator at a prompt. */
function stdioIsInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function writeNotice(line: string): void {
	process.stderr.write(`${line}\n`);
}

function taintCommandDeps(cwd: string = process.cwd()): TaintCommandDeps {
	const terminal = {
		isInteractive: stdioIsInteractive,
		promptLine: readOneLine,
		write: writeNotice,
	};
	const identity = {
		operatorUser: () => userInfo().username,
		pid: () => process.pid,
		now: () => new Date().toISOString(),
	};
	return { ...taintClientDeps(cwd), ...terminal, ...identity };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStepLimit(limit: number | null): string {
	return limit === null ? "unlimited" : String(limit);
}

function renderSetter(view: TaintSessionView): string {
	const setter = view.set_by;
	if (!setter) return "  set by: unknown (no recorded source carries the current level)";
	const how = setter.inferred
		? "inferred — earliest source at this level; this snapshot predates the escalated flag"
		: "proven — the source carries the escalated flag";
	const detail = setter.detail ? `\n  detail:  ${setter.detail}` : "";
	return `  set by: ${setter.file} at step ${setter.at_step} (${how})${detail}`;
}

/** Per-actor levels (B3). A carrier with no lineage data says so, because
 *  "no rows" and "every actor at the session level" mean different things. */
function renderActors(view: TaintSessionView): string[] {
	if (!view.actors) {
		return ["  actors: not recorded (pre-lineage snapshot — every actor reads the session level)"];
	}
	const blocked = (level: SensitivityLevel) =>
		networkBlockedAt(level, view.network_block_at) ? "network BLOCKED" : "network allowed";
	const rows = view.actors.map(
		(a) => `    - ${a.actor}${a.parent ? ` (child of ${a.parent})` : " (root)"}: ${a.level}, ${blocked(a.level)}`,
	);
	const files = view.tainted_files ?? 0;
	return [`  actors: ${view.actors.length}; ${files} file(s) written while tainted:`, ...rows];
}

function renderView(view: TaintSessionView): string {
	const network = view.network_blocked ? "BLOCKED" : "allowed";
	const header = `session ${view.session_id} (${view.agent_name ?? "unnamed"}) — read from ${view.origin}`;
	const level = `  level:  ${view.sensitivity_level}  (network: ${network} at ${view.network_block_at}+; this is the MAX over actors)`;
	const steps = `  steps:  limit ${renderStepLimit(view.step_limit)}`;
	const sourceHeader = `  sources: ${view.source_count} recorded; last ${view.recent_sources.length}:`;
	const sources = view.recent_sources.map((source) => `    - [${source.level}] ${source.file}`);
	return [
		header,
		level,
		steps,
		renderSetter(view),
		...renderActors(view),
		sourceHeader,
		...sources,
	].join("\n");
}

function renderSessionList(views: TaintSessionView[]): string {
	if (views.length === 0) return "No tainted sessions: nothing above Public in memory or on disk.";
	return views
		.map(
			(view) =>
				`${view.session_id}  ${view.sensitivity_level}  ${view.origin}  set by ${view.set_by?.file ?? "unknown"}${view.set_by?.inferred ? " (inferred)" : ""}`,
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function renderStatus(resolved: TaintResolution): string {
	const { report } = resolved;
	if (report.session) return `${renderView(report.session)}\n  (via ${resolved.via})`;
	return `${renderSessionList(report.sessions ?? [])}\n(via ${resolved.via})`;
}

export async function harnessTaintStatusCommand(
	opts: OptionValues,
	deps: TaintCommandDeps = taintCommandDeps(),
): Promise<void> {
	const mode = getOutputMode(opts);
	const sessionId = typeof opts.session === "string" ? opts.session.trim() : undefined;
	const resolved = await resolveTaintStatus(deps, sessionId || undefined);
	if (!resolved.report.ok) {
		outputError(mode, resolved.report.reason ?? "Taint status unavailable", resolved);
		return;
	}
	const payload = { via: resolved.via, ...resolved.report };
	output(mode, payload, {
		json: () => payload,
		short: () => renderStatusShort(resolved),
		normal: () => renderStatus(resolved),
	});
}

function renderStatusShort(resolved: TaintResolution): string {
	const one = resolved.report.session;
	if (one) return `${one.session_id} ${one.sensitivity_level} (via ${resolved.via})`;
	return `${resolved.report.sessions?.length ?? 0} tainted session(s) (via ${resolved.via})`;
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

interface ClearPreamble {
	view: TaintSessionView;
	reason: string;
	token: string;
	/** Named actor, when the operator is clearing one actor rather than all. */
	actor?: string | undefined;
}

function clearPreamble({ view, reason, token, actor }: ClearPreamble): string {
	const scope =
		actor === undefined
			? "This sets EVERY actor of the session to Public, resets the step limit, drops the tainted-file records"
			: `This sets ONLY actor ${actor} to Public and drops the files it tainted; the session level and every other actor stay as they are. It`;
	return [
		"",
		"OPERATOR ACTION — lowering a sensitivity level is not a ratchet.",
		renderView(view),
		`  reason: ${reason}`,
		"",
		`${scope}, keeps the source history and appends an audit row to .interlinked/taint-clears.jsonl.`,
		`To confirm, type the first ${token.length} characters of the session id: ${token}`,
		"",
	].join("\n");
}

/** The two reads a clear needs before it may prompt: the session must exist
 *  and must actually be above Public. */
async function loadClearTarget(
	deps: TaintCommandDeps,
	mode: OutputMode,
	sessionId: string,
): Promise<TaintSessionView | null> {
	const status = await resolveTaintStatus(deps, sessionId);
	const view = status.report.session;
	if (!status.report.ok || !view) {
		outputError(mode, status.report.reason ?? `Unknown session ${sessionId}`, status);
		return null;
	}
	if (view.sensitivity_level === "Public") {
		outputError(mode, `Session ${sessionId} is already Public — nothing to clear`, status);
		return null;
	}
	return view;
}

function auditRow(deps: TaintCommandDeps, resolved: TaintResolution): TaintClearAuditRow | null {
	const cleared = resolved.report.cleared;
	if (!cleared) return null;
	return {
		ts: deps.now(),
		session: cleared.session_id,
		previous_level: cleared.previous_level,
		set_by: cleared.set_by,
		reason: cleared.reason,
		operator_user: deps.operatorUser(),
		pid: deps.pid(),
	};
}

function reportAuditFailure(deps: TaintCommandDeps, result: AuditAppendResult): void {
	if (result.ok) return;
	deps.write(`WARNING: the clear applied but the audit row could not be written: ${result.error}`);
}

function renderCleared(deps: TaintCommandDeps, resolved: TaintResolution): string {
	const cleared = resolved.report.cleared;
	const where = cleared?.applied_to.join(" + ") ?? "nothing";
	const staleNote =
		resolved.via === "snapshot"
			? "\nNo daemon answered the control query, so only the live snapshot changed. If a daemon IS running (an older build), restart it — its in-memory level is unchanged until then."
			: "";
	return `Cleared ${cleared?.session_id ?? "session"}: ${cleared?.previous_level ?? "?"} → Public (applied to ${where}). Audit row appended for ${deps.operatorUser()}.${staleNote}`;
}

export async function harnessTaintClearCommand(
	opts: OptionValues,
	deps: TaintCommandDeps = taintCommandDeps(),
): Promise<void> {
	const mode = getOutputMode(opts);
	const sessionId = typeof opts.session === "string" ? opts.session.trim() : "";
	const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
	const actor = typeof opts.actor === "string" && opts.actor.trim() !== "" ? opts.actor.trim() : undefined;
	if (!sessionId || !reason) {
		outputError(mode, 'both --session <id> and --reason "<text>" are required');
		return;
	}
	if (!deps.isInteractive()) {
		outputError(mode, NON_INTERACTIVE_REFUSAL);
		return;
	}
	const view = await loadClearTarget(deps, mode, sessionId);
	if (!view) return;

	const token = confirmationToken(view.session_id);
	deps.write(clearPreamble({ view, reason, token, actor }));
	const typed = (await deps.promptLine(`Type ${token} to confirm: `)).trim();
	if (typed !== token) {
		outputError(mode, "confirmation did not match; nothing changed");
		return;
	}

	const resolved = await resolveTaintClear(deps, { sessionId: view.session_id, reason, actor });
	if (!resolved.report.ok || !resolved.report.cleared) {
		outputError(mode, resolved.report.reason ?? "Taint clear failed; nothing changed", resolved);
		return;
	}
	const row = auditRow(deps, resolved);
	if (row) reportAuditFailure(deps, appendTaintClearAudit(deps.cwd, row));
	const payload = { via: resolved.via, ...resolved.report, audit: row };
	output(mode, payload, {
		json: () => payload,
		short: () => `cleared ${view.session_id}: ${view.sensitivity_level} → Public`,
		normal: () => renderCleared(deps, resolved),
	});
}
