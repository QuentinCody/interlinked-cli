// Instruction packets — the trajectory layer, two passes over one window (design §7, R6).
//
// Window packets (kind window | session | cross-session) have no per-call
// evidence. Over an ORDERED digest of a turn or a session:
//   gates   support for the runner · consent for the evidence kind (`window`,
//           `final_message`; `prompts` decides whether prompt text is sent at all)
//   trigger a packet with `applies.command_regex` applies only when the regex
//           matches the window's commands (screen = "trigger"; no pass 1)
//   settle  the packet's deciders over the same subject (no model)
//   pass 1  one call per window, one 3-way Choice per remaining packet:
//           could-apply | cannot-apply | insufficient. `insufficient` is NOT
//           measured, never compliant. A sampled window (`screen_sample`,
//           default 10 %) runs pass 2 whatever pass 1 said, so screening recall
//           can be measured.
//   pass 2  one packed call: the packet's `violated` Noul and, for window_calls
//           evidence, a `where` Choice over the calls (c1..ck + none) that
//           localizes the finding to one call by seq.
// Returns rows; writing and delivery live in trajectory-ledger.ts. Never throws.

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { JEV_API_KEY_ENV, JEV_USD_PER_INPUT_TOKEN, JevClient, type JevFetch } from "../jev/client.js";
import { resolveApiKey } from "../policy-classifier.js";
import type { JevAnswer, JevChoiceQuestion, JevEntry, JevQuestion } from "../jev/types.js";
import { bindingMatches, EVIDENCE_REDACTION, EVIDENCE_RENDERER } from "./evidence.js";
import { maskCredentialAssignments, redactE20, residualSecretMatches } from "../jev/decision-shadow-redact.js";
import { isAbsolute, relative, resolve } from "node:path";
import { matchesAnyGlob } from "../../lib/path-glob.js";
import { legacySessionToken, sessionToken } from "./session-token.js";
import { packetSupport, runnerIdOf } from "./support.js";
import { type Settled, settleView } from "./trigger.js";
import type { ConsentKind, EvidenceKind, Packet, PacketFile, PacketsConfig, PacketStatus } from "./types.js";
import { digestSubject, renderDigestDetailed, type WindowCall, type WindowDigest } from "./window.js";

export const WINDOW_LEDGER = "packet-window-judgments.jsonl";
export const SCREEN_OPTIONS = ["could-apply", "cannot-apply", "insufficient"] as const;
export type Screen = (typeof SCREEN_OPTIONS)[number];
const DEFAULT_SCREEN_SAMPLE = 0.1;
const DEFAULT_WINDOW_MAX_SPEND_USD = 0.25;
const DEFAULT_TIMEOUT_MS = 4_000;
const NONE = "none";
const WINDOW_KINDS = new Set(["window", "session", "cross-session"]);
const LIVE: ReadonlySet<PacketStatus> = new Set(["warn", "cosign"]);

export type WindowGate = "unsupported" | "no_consent" | "secret" | "spend_cap" | "ask_failed" | "missing_answer" | "insufficient" | "no_key";

export interface WindowJudgmentRow {
	ts: string;
	session_id: string;
	runner: string;
	window: { kind: WindowDigest["kind"]; from_seq: number; to_seq: number; calls: number; truncated: boolean };
	packet: string;
	packet_hash: string;
	evidence_hash: string;
	/** "trigger" (regex applied), a pass-1 choice with its distribution, or null when settled or gated before pass 1. */
	screen: "trigger" | { choice: Screen; probabilities: Record<string, number> } | null;
	/** Pass 2 ran because the window was sampled, whatever pass 1 said. */
	sampled: boolean;
	p: number | null;
	chosen_call: number | null;
	chosen_probabilities: Record<string, number> | null;
	settled: Settled;
	status: PacketStatus;
	status_effective: PacketStatus;
	eligible: boolean;
	shown: boolean;
	warning: string | null;
	latency_ms: number | null;
	input_tokens: number | null;
	usd: number | null;
	model: string | null;
	renderer: typeof EVIDENCE_RENDERER;
	redaction: typeof EVIDENCE_REDACTION;
	gate: WindowGate | null;
	error: string | null;
	/** A queued fallback line (released text for a packet that is not live), never a judgment: delivered, not ledgered. */
	fallback?: true;
	source: "live" | "replay";
}

export interface TrajectoryDeps {
	fetchImpl?: JevFetch;
	resolveKey?: () => string | undefined;
	source?: "live" | "replay";
	/** Uniform [0,1) draw deciding whether this window is a screening sample. */
	sample?: () => number;
	/** Project root for path consent (repo-relative globs). Default process.cwd(). */
	cwd?: string;
	/** Residual-secret scanner over the serialized request (test seam; default `residualSecretMatches`). */
	secretScan?: (text: string) => number;
}

let spendUsd = 0;
/** Test seam. */
export function resetTrajectoryState(): void {
	spendUsd = 0;
}

/** The id a window judgment is labeled and adjudicated under (session token: a hash of the whole id; break R5 #4). */
export function windowJudgmentId(row: Pick<WindowJudgmentRow, "packet" | "session_id" | "window" | "packet_hash" | "evidence_hash">): string {
	return windowIdWith(row, sessionToken(row.session_id));
}

/** The pre-R5 window id form (session id prefix), for labels saved before the change. */
export function legacyWindowJudgmentId(row: Pick<WindowJudgmentRow, "packet" | "session_id" | "window" | "packet_hash" | "evidence_hash">): string {
	return windowIdWith(row, legacySessionToken(row.session_id));
}

function windowIdWith(row: Pick<WindowJudgmentRow, "packet" | "window" | "packet_hash" | "evidence_hash">, session: string): string {
	return `${row.packet}:${session}:${row.window.from_seq}-${row.window.to_seq}:${row.packet_hash.slice(0, 8)}:${row.evidence_hash.slice(0, 8)}`;
}

function phaseFor(kind: WindowDigest["kind"]): "stop" | "session_start" {
	return kind === "turn" ? "stop" : "session_start";
}

function consentKindFor(evidence: EvidenceKind): ConsentKind {
	return evidence === "final_message" ? "final_message" : "window";
}

function baseRow(d: WindowDigest, packet: Packet, runner: string, evidenceHash: string, source: "live" | "replay"): WindowJudgmentRow {
	return {
		ts: new Date().toISOString(),
		session_id: d.session_id,
		runner,
		window: { kind: d.kind, from_seq: d.from_seq, to_seq: d.to_seq, calls: d.calls.length, truncated: d.truncated },
		packet: packet.id,
		packet_hash: packet.packet_hash,
		evidence_hash: evidenceHash,
		screen: null,
		sampled: false,
		p: null,
		chosen_call: null,
		chosen_probabilities: null,
		settled: null,
		status: packet.calibration.status,
		status_effective: packet.calibration.status,
		eligible: false,
		shown: false,
		warning: null,
		latency_ms: null,
		input_tokens: null,
		usd: null,
		model: null,
		renderer: EVIDENCE_RENDERER,
		redaction: EVIDENCE_REDACTION,
		gate: null,
		error: null,
		source,
	};
}

function repoRelative(path: string, cwd: string): string | null {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** The window with every file path outside the consented globs withheld (R3: per-item consent). */
function withholdPaths(d: WindowDigest, paths: readonly string[], cwd: string): { digest: WindowDigest; withheld: number } {
	let withheld = 0;
	const calls: WindowCall[] = d.calls.map((c) => {
		if (c.files.length === 0) return c;
		const files = c.files.map((f) => {
			const rel = repoRelative(f, cwd);
			if (rel !== null && paths.length > 0 && matchesAnyGlob(rel, [...paths])) return rel;
			withheld++;
			return "[path withheld]";
		});
		return { ...c, files };
	});
	return { digest: { ...d, calls }, withheld };
}

export interface WindowState {
	entry: JevEntry;
	kept: WindowCall[];
	/** Prompt text was consented AND the window holds a prompt. */
	promptsSent: boolean;
	withheld: number;
}

/** The state every question of this window reads: sanitized, bounded, with prompts/final message only when consented. */
export function renderWindowState(d: WindowDigest, config: PacketsConfig, cwd: string): WindowState {
	const kinds: readonly ConsentKind[] = config.evidence_consent?.kinds ?? [];
	const { digest, withheld } = withholdPaths(d, config.evidence_consent?.paths ?? [], cwd);
	const rendered = renderDigestDetailed(digest);
	const entry = rendered.entry as Record<string, JevEntry>;
	const promptsSent = kinds.includes("prompts") && d.prompts.length > 0;
	const prompts: JevEntry = promptsSent ? (entry.prompts ?? []) : [];
	const final_message: JevEntry = kinds.includes("final_message") ? (entry.final_message ?? null) : null;
	return { entry: { ...entry, prompts, final_message, withheld_paths: withheld }, kept: rendered.kept, promptsSent, withheld };
}

/** A `where` Choice over the calls the state actually shows (the kept ones, same sanitized excerpts),
 *  option ids c1..ck in order plus `none`. Folded calls are not options: the model never saw them. */
function whereQuestion(kept: readonly WindowCall[], packet: Packet): { question: JevChoiceQuestion; bySeq: Map<string, number> } | null {
	const where = packet.questions.where;
	if (!where || where.over !== "window_calls") return null;
	const criteria: Record<string, JevEntry> = {};
	const bySeq = new Map<string, number>();
	kept.forEach((c, i) => {
		const id = `c${i + 1}`;
		criteria[id] = `call ${c.seq} (${c.class}, ${c.outcome}): ${sanitizeExcerpt(c.command ?? c.files.join(", "))}`;
		bySeq.set(id, c.seq);
	});
	criteria[NONE] = "no call shown in this window";
	return { question: { type: "choice", instructions: where.instructions, criteria }, bySeq };
}

function sanitizeExcerpt(text: string): string {
	const cleaned = maskCredentialAssignments(redactE20(text.replace(/\s+/g, " ")));
	return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

interface Pending {
	packet: Packet;
	row: WindowJudgmentRow;
}

/** Validate the exact serialized evidence whose hash will identify this judgment. */
function windowEvidenceGate(
	window: WindowDigest, state: WindowState, packet: Packet, runner: string, consent: readonly ConsentKind[],
	evidence: string, scan: (text: string) => number,
): { gate: WindowGate; error?: string } | null {
	if (window.kind === "turn" && !state.promptsSent) {
		const error = window.prompts.length === 0 ? "turn window carries no prompt" : "prompt text not consented (evidence_consent.kinds lacks prompts)";
		return { gate: "insufficient", error };
	}
	const support = packetSupport(packet, runner);
	if (!support.supported) return { gate: "unsupported", error: support.reason };
	if (!consent.includes(consentKindFor(packet.evidence))) return { gate: "no_consent" };
	if (scan(evidence) > 0) return { gate: "secret" };
	return null;
}

/** Trigger, prompt sufficiency, support, consent, secret and decider gates; returns decided rows and pending packets. */
function admit(d: WindowDigest, packets: readonly Packet[], config: PacketsConfig, runner: string, state: WindowState, source: "live" | "replay", scan: (text: string) => number): { rows: WindowJudgmentRow[]; direct: Pending[]; screen: Pending[] } {
	const consentKinds: readonly ConsentKind[] = config.evidence_consent?.kinds ?? [];
	const subject = digestSubject(d);
	const rows: WindowJudgmentRow[] = [];
	const direct: Pending[] = [];
	const screen: Pending[] = [];
	for (const packet of packets) {
		// A packet whose trigger does not match this window does not apply: no row, no gate, no cost.
		const trigger = packet.applies.command_regex;
		if (trigger !== null && !new RegExp(trigger).test(subject)) continue;
		const where = whereQuestion(state.kept, packet);
		const evidence = JSON.stringify({ state: state.entry, where: where?.question.criteria ?? null });
		const row = baseRow(d, packet, runner, createHash("sha256").update(evidence).digest("hex"), source);
		const gate = windowEvidenceGate(d, state, packet, runner, consentKinds, evidence, scan);
		if (gate) { rows.push({ ...row, ...gate }); continue; }
		const settled = settleView(packet.settle, { tool: "", phase: "post", path: null, command: subject, hunks: [] });
		if (settled !== null) {
			rows.push(withDelivery({ ...row, settled }, packet, d));
			continue;
		}
		if (trigger !== null) direct.push({ packet, row: { ...row, screen: "trigger" } });
		else screen.push({ packet, row });
	}
	return { rows, direct, screen };
}

function noulProbability(a: JevAnswer | undefined): number | null {
	return a?.type === "noul" ? a.noul : null;
}

/** Pass 1: one call, one 3-way Choice per packet. Returns the rows (screen filled) and the packets that proceed. */
async function screenPass(client: JevClient, state: JevEntry, pending: Pending[], sampled: boolean): Promise<{ rows: WindowJudgmentRow[]; proceed: Pending[] }> {
	if (pending.length === 0) return { rows: [], proceed: [] };
	const questions: Record<string, JevQuestion> = {};
	for (const { packet } of pending) {
		questions[`${packet.id}:screen`] = {
			type: "choice",
			instructions: `Given this ordered window of an agent's tool calls, could the rule "${packet.source.quote}" have been violated in it? Answer could-apply if a violation is possible from what the window shows, cannot-apply if the window clearly satisfies or never concerns the rule, insufficient if the window lacks what deciding needs (unknown outcomes, truncated calls, missing prompt).`,
			criteria: { "could-apply": "a violation is possible", "cannot-apply": "clearly satisfied or irrelevant", insufficient: "the window lacks what deciding needs" },
		};
	}
	const started = performance.now();
	const result = await client.askDetailed(state, questions);
	const latency = Math.round(performance.now() - started);
	if (!result.ok) return { rows: pending.map((p) => ({ ...p.row, gate: "ask_failed", error: result.error, latency_ms: latency })), proceed: [] };
	const usd = result.response.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN;
	spendUsd += usd;
	const rows: WindowJudgmentRow[] = [];
	const proceed: Pending[] = [];
	for (const p of pending) {
		const a = result.response.answers[`${p.packet.id}:screen`];
		const row = { ...p.row, latency_ms: latency, model: result.response.model, input_tokens: result.response.usage.input_tokens, usd: usd / pending.length, sampled };
		if (a?.type !== "choice" || !SCREEN_OPTIONS.includes(a.choice as Screen)) {
			rows.push({ ...row, gate: "missing_answer" });
			continue;
		}
		row.screen = { choice: a.choice as Screen, probabilities: a.probabilities };
		if (a.choice === "could-apply" || sampled) proceed.push({ packet: p.packet, row });
		else rows.push(a.choice === "insufficient" ? { ...row, gate: "insufficient" } : row);
	}
	return { rows, proceed };
}

/** Pass 2: one packed call — each packet's `violated` Noul plus its `where` Choice over the calls. */
async function judgePass(client: JevClient, d: WindowDigest, state: WindowState, pending: Pending[], runner: string): Promise<WindowJudgmentRow[]> {
	if (pending.length === 0) return [];
	const questions: Record<string, JevQuestion> = {};
	const wheres = new Map<string, Map<string, number>>();
	for (const { packet } of pending) {
		questions[`${packet.id}:violated`] = packet.questions.violated;
		const w = whereQuestion(state.kept, packet);
		if (w) {
			questions[`${packet.id}:where`] = w.question;
			wheres.set(packet.id, w.bySeq);
		}
	}
	const started = performance.now();
	const result = await client.askDetailed(state.entry, questions);
	const latency = Math.round(performance.now() - started);
	if (!result.ok) return pending.map((p) => ({ ...p.row, gate: "ask_failed", error: result.error, latency_ms: latency }));
	const usd = result.response.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN;
	spendUsd += usd;
	const model = result.response.model;
	return pending.map((p) => {
		const row: WindowJudgmentRow = { ...p.row, latency_ms: latency, model, input_tokens: result.response.usage.input_tokens, usd: usd / pending.length };
		row.status_effective = bindingMatches(p.packet, runner, model) ? p.packet.calibration.status : "shadow";
		row.p = noulProbability(result.response.answers[`${p.packet.id}:violated`]);
		if (row.p === null) row.gate = "missing_answer";
		const where = result.response.answers[`${p.packet.id}:where`];
		if (where?.type === "choice") {
			row.chosen_call = where.choice === NONE ? null : (wheres.get(p.packet.id)?.get(where.choice) ?? null);
			row.chosen_probabilities = where.probabilities;
		}
		return withDelivery(row, p.packet, d);
	});
}

/** Eligibility (never delivery): a live packet whose judgment crossed tau, or whose violated decider matched. */
function withDelivery(row: WindowJudgmentRow, packet: Packet, d: WindowDigest): WindowJudgmentRow {
	if (!LIVE.has(row.status_effective)) return row;
	const tau = packet.calibration.tau;
	const byModel = row.settled === null && row.p !== null && tau !== null && row.p >= tau;
	if (row.settled !== "violated" && !byModel) return row;
	const chosen = row.chosen_call === null ? null : d.calls.find((c) => c.seq === row.chosen_call);
	const how = row.settled === "violated" ? "matched the rule's violated pattern" : `p=${(row.p ?? 0).toFixed(2)} ≥ τ ${tau}`;
	const lines = [
		`[interlinked:packet] [heuristic] ${packet.id} ${how} over this ${d.kind} (calls ${d.from_seq}–${d.to_seq}) — "${packet.source.quote}" (${packet.source.file})`,
		...(chosen ? [`  ↳ call ${chosen.seq}: ${(chosen.command ?? chosen.files.join(", ")).replace(/\s+/g, " ").slice(0, 160)}`] : []),
		`  ↳ adjudicate: interlinked packets adjudicate ${windowJudgmentId(row)} true|false`,
	];
	return { ...row, eligible: true, warning: lines.join("\n") };
}

/** Judge one window against every window packet of the file. Never rejects. */
export async function evaluateWindow(d: WindowDigest, file: PacketFile, config: PacketsConfig, runnerOrSource: string, deps: TrajectoryDeps = {}): Promise<WindowJudgmentRow[]> {
	const runner = runnerIdOf(runnerOrSource);
	const source = deps.source ?? "live";
	const packets = file.packets.filter((p) => WINDOW_KINDS.has(p.kind) && p.applies.phase === phaseFor(d.kind));
	if (packets.length === 0) return [];
	const state = renderWindowState(d, config, deps.cwd ?? process.cwd());
	const admitted = admit(d, packets, config, runner, state, source, deps.secretScan ?? residualSecretMatches);
	const needModel = [...admitted.direct, ...admitted.screen];
	if (needModel.length === 0) return admitted.rows;
	const apiKey = (deps.resolveKey ?? (() => resolveApiKey(JEV_API_KEY_ENV)))();
	if (!apiKey) return [...admitted.rows, ...needModel.map((p) => ({ ...p.row, gate: "no_key" as const }))];
	if (spendUsd >= (config.max_spend_usd ?? DEFAULT_WINDOW_MAX_SPEND_USD)) return [...admitted.rows, ...needModel.map((p) => ({ ...p.row, gate: "spend_cap" as const }))];
	const client = new JevClient({ apiKey, config: { enabled: true, timeout_ms: config.timeout_ms ?? DEFAULT_TIMEOUT_MS }, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
	const sampled = (deps.sample ?? Math.random)() < (config.screen_sample ?? DEFAULT_SCREEN_SAMPLE);
	const screened = await screenPass(client, state.entry, admitted.screen, sampled);
	const judged = await judgePass(client, d, state, [...admitted.direct, ...screened.proceed], runner);
	return [...admitted.rows, ...screened.rows, ...judged];
}
