// Instruction packets — the per-call evaluator, stage 1: SHADOW ONLY (design §6).
//
// One PostToolUse event → the packets whose deterministic trigger matches →
// consent and secret gates → ONE packed Jev call → one row per packet in
// `.interlinked/packet-judgments.jsonl`. Nothing is shown to the agent and no
// decision changes: this module returns rows for tests and the ledger, never a
// warning. Gates, in order, all before any network (every refusal is a row
// naming the gate, the once-per-process ones so the ledger is not flooded):
//   dry_run · PostToolUse only · packets.enabled && jev.enabled · packet file
//   present · parses · source hashes match · key · tool_use_id claimed once ·
//   trigger · runner delivers this phase×tool (R7) · consent by kind and path
//   (R3) · no residual secret in the rendered evidence · spend cap.
// A judgment carries the binding stamps (renderer, redaction, RESOLVED model,
// runner, packet_hash) so calibration can be bound to the evaluator that
// earned it (R5); a packet whose binding does not match this evaluator is
// judged at `status_effective: "shadow"` whatever its file status says.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { findRepoRoot } from "../../lib/interlinked-root.js";
import { resolveApiKey } from "../policy-classifier.js";
import { JEV_API_KEY_ENV, JEV_USD_PER_INPUT_TOKEN, JevClient, type JevFetch } from "../jev/client.js";
import type { JevEntry, JevQuestion } from "../jev/types.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { cosignPairingAt, decidePacketAsk, pickAsk } from "./cosign-pairing.js";
import { consentDecision, EVIDENCE_REDACTION, EVIDENCE_RENDERER, type EvidenceConsent, renderEvidence, renderState } from "./evidence.js";
import { nonLiveReason, outageFallbackLines, SLOW_JEV_REASON } from "./outage-fallback.js";
import { judgmentId } from "./session-token.js";
import { resolveSourcePath } from "./source-path.js";
import { parsePacketFile } from "./schema.js";
import { packetSupport, runnerIdOf, runnerSupportsAsk } from "./support.js";
import { matchesTrigger, type Settled, settleView, type TriggerView, viewsFromToolInput } from "./trigger.js";
import { PACKET_FILE_BASENAME, type Packet, type PacketFile, type PacketsConfig, type PacketStatus } from "./types.js";

export const PACKET_LEDGER = "packet-judgments.jsonl";
export const DEFAULT_MAX_SPEND_USD = 0.25;
export const DEFAULT_TIMEOUT_MS = 1_500;
/** Rendering bounds; the label sheet re-renders with the same ones so labels see what Jev saw. */
export const EVIDENCE_BOUNDS = { commandChars: 3_000, hunkChars: 2_500, maxHunks: 6 } as const;
const SEEN_IDS_CAP = 4_096;

export type JudgmentGate = "no_key" | "packets_invalid" | "hash_mismatch" | "unsupported" | "no_consent" | "privacy" | "secret" | "spend_cap" | "ask_failed" | "missing_answer";

export interface PacketJudgmentRow {
	ts: string;
	session_id: string;
	tool_use_id: string | null;
	seq: number | null;
	runner: string;
	tool: string;
	/** Packet id, or "*" for a row about the whole packet set. */
	packet: string;
	packet_hash: string | null;
	/** sha256 of the rendered evidence this judgment was asked about (one row per file of a multi-file patch); null for a gate row. */
	evidence_hash: string | null;
	status: PacketStatus | null;
	/** The status this evaluator honors: `status` when the binding matches, else shadow. */
	status_effective: PacketStatus | null;
	p: number | null;
	/** Decided by the packet's regex decider without a model call; null when the model judged (or a gate refused). */
	settled: Settled;
	/** `live` from the hook, `replay` from `packets replay` over the collection log. */
	source: "live" | "replay";
	/** Eligible for delivery: a live packet whose judgment crossed tau or whose violated pattern matched. */
	eligible: boolean;
	/** True only when the delivery phase accepted the warning in time (never on replay). */
	shown: boolean;
	/** The warning line (set when eligible; delivered only when `shown`). */
	warning: string | null;
	latency_ms: number | null;
	input_tokens: number | null;
	usd: number | null;
	model: string | null;
	renderer: typeof EVIDENCE_RENDERER;
	redaction: typeof EVIDENCE_REDACTION;
	gate: JudgmentGate | null;
	error: string | null;
	/** PreToolUse cosign rows only: the paired rule this packet may tighten, or null when unpaired (§5; the ask
	 *  is withheld). Absent on every other row. */
	cosign_rule?: string | null;
}

export interface PacketEvaluatorDeps {
	fetchImpl?: JevFetch;
	resolveKey?: () => string | undefined;
	/** Where the event came from; rows record it. Default `live`. */
	source?: "live" | "replay";
	/** Replay only: judge just these packet ids (the ones the ledger has not judged under their current hash). */
	onlyPackets?: ReadonlySet<string>;
	/** Delivery path only: return rows without appending them; the caller appends after deciding delivery. */
	deferAppend?: boolean;
	/** Cosign path: judge at PreToolUse whatever phase the packet declares (the evidence is the same tool_input). */
	phaseAgnostic?: boolean;
	/** Cosign path: judge only packets at this status. */
	onlyStatus?: PacketStatus;
}

interface EvaluatorState {
	usd: number;
	seen: Set<string>;
	once: Set<string>;
	ledgerErrors: number;
	/** The last Jev call failed (outage); cleared by the next answer. §9 "Jev unreachable at the last probe". */
	lastAskFailed: boolean;
}
let state: EvaluatorState = { usd: 0, seen: new Set(), once: new Set(), ledgerErrors: 0, lastAskFailed: false };

/** Test seam: spend, de-dup and once-per-process gates are per daemon process. */
export function resetPacketEvaluatorState(): void {
	state = { usd: 0, seen: new Set(), once: new Set(), ledgerErrors: 0, lastAskFailed: false };
}

/** Why packets are not live in THIS daemon right now, whatever the packet file says: the spend cap is reached,
 *  or Jev failed at its last call. The SessionStart fallback reads it too (audit B, finding 5), so a known
 *  outage hands the words back at the start instead of one call late. */
export function runtimeNonLiveReason(rules: GuardRulesConfig): string | null {
	const config = enabledConfig(rules);
	if (!config) return null; // disabled packets are a static gap (`liveGap`), not a runtime one
	if (state.usd >= (config.max_spend_usd ?? DEFAULT_MAX_SPEND_USD)) return "spend cap reached this daemon run";
	if (state.lastAskFailed) return "Jev unreachable at the last call";
	return null;
}

function once(key: string): boolean {
	if (state.once.has(key)) return false;
	state.once.add(key);
	return true;
}

/** One evaluation per (tool call, purpose): the PreToolUse cosign pass and the PostToolUse pass are different purposes. */
function claim(event: HarnessEvent, purpose: "post" | "cosign-pre"): boolean {
	const id = event.tool_use_id;
	if (!id) return true;
	const key = `${id}:${purpose}`;
	if (state.seen.has(key)) return false;
	if (state.seen.size >= SEEN_IDS_CAP) state.seen.clear();
	state.seen.add(key);
	return true;
}

function baseRow(event: HarnessEvent, packet: Packet | null, source: "live" | "replay" = "live"): PacketJudgmentRow {
	return {
		ts: new Date().toISOString(),
		session_id: event.session_id,
		tool_use_id: event.tool_use_id ?? null,
		seq: event.seq ?? null,
		runner: runnerIdOf(event.agent_source),
		tool: event.tool_name ?? "",
		packet: packet?.id ?? "*",
		packet_hash: packet?.packet_hash ?? null,
		evidence_hash: null,
		status: packet?.calibration.status ?? null,
		status_effective: packet?.calibration.status ?? null,
		p: null,
		settled: null,
		source,
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
	};
}

function gateRow(event: HarnessEvent, packet: Packet | null, gate: JudgmentGate, error: string | null = null, source: "live" | "replay" = "live"): PacketJudgmentRow {
	return { ...baseRow(event, packet, source), gate, error };
}

function appendRows(cwd: string, rows: PacketJudgmentRow[]): void {
	if (rows.length === 0) return;
	try {
		appendFileSync(join(cwd, ".interlinked", PACKET_LEDGER), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
	} catch {
		state.ledgerErrors++; // a ledger gap beats a daemon crash
	}
}

export type Loaded = { ok: true; file: PacketFile } | { ok: false; gate: "packets_invalid" | "hash_mismatch"; error: string };

/** Parse the packet file and verify every source digest against the files on disk. */
export function loadPacketFile(cwd: string, path: string): Loaded {
	const parsed = parsePacketFile(readFileSync(path, "utf8"));
	if (!parsed.ok) return { ok: false, gate: "packets_invalid", error: parsed.error };
	for (const [file, digest] of Object.entries(parsed.value.sources)) {
		let content: string | null = null;
		try {
			content = readFileSync(resolveSourcePath(cwd, file), "utf8");
		} catch {
			content = null;
		}
		const now = content === null ? null : createHash("sha256").update(content).digest("hex");
		if (now !== digest) return { ok: false, gate: "hash_mismatch", error: `${file} changed since compile; run \`interlinked packets compile\`` };
	}
	return { ok: true, file: parsed.value };
}

function enabledConfig(rules: GuardRulesConfig): PacketsConfig | null {
	const packets = rules.packets;
	return packets?.enabled === true && rules.jev?.enabled === true ? packets : null;
}

function consentOf(config: PacketsConfig): EvidenceConsent | undefined {
	const c = config.evidence_consent;
	return c ? { kinds: c.kinds ?? [], paths: c.paths ?? [] } : undefined;
}

function bindingMatches(packet: Packet, runner: string, model: string): boolean {
	const b = packet.calibration.bound_to;
	return b !== null && b.packet_hash === packet.packet_hash && b.renderer === EVIDENCE_RENDERER && b.redaction === EVIDENCE_REDACTION && b.model === model && b.runner === runner;
}

export { judgmentId, legacyJudgmentId } from "./session-token.js";

export function evidenceHash(evidence: JevEntry): string {
	return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

const EXCERPT_CHARS = 160;
const LIVE: ReadonlySet<PacketStatus> = new Set(["warn", "cosign"]);

/** Stage 2 delivery rule: a live packet (warn/cosign for THIS evaluator) whose judgment crossed tau, or settled violated. */
function isShown(row: PacketJudgmentRow, packet: Packet): boolean {
	if (row.status_effective === null || !LIVE.has(row.status_effective)) return false;
	if (row.settled === "violated") return true;
	const tau = packet.calibration.tau;
	return row.settled === null && row.p !== null && tau !== null && row.p >= tau;
}

function excerpt(view: TriggerView): string {
	const text = (view.command ?? view.path ?? "").replace(/\s+/g, " ");
	return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

/** Fill `eligible` and `warning` for a finished row; `shown` is set only by the delivery path. */
function withDelivery(row: PacketJudgmentRow, packet: Packet, view: TriggerView): PacketJudgmentRow {
	if (!isShown(row, packet)) return row;
	const how = row.settled === "violated" ? "matched the rule's violated pattern" : `p=${(row.p ?? 0).toFixed(2)} ≥ τ ${packet.calibration.tau}`;
	const where = packet.source.span ? `${packet.source.file}:${packet.source.span[0]}` : packet.source.file;
	row.eligible = true;
	row.warning = [
		`[interlinked:packet] [heuristic] ${packet.id} ${how} — "${packet.source.quote}" (${where})`,
		`  ↳ evidence: ${excerpt(view)}`,
		`  ↳ adjudicate: interlinked packets adjudicate ${judgmentId(row)} true|false`,
	].join("\n");
	return row;
}

/** The evidence identity of a settled view (no rendering happened): the same subject the decider read. */
function settleSubjectEntry(view: TriggerView): JevEntry {
	return { path: view.path, subject: view.command ?? view.hunks.map((h) => h.new).join("\n") };
}

interface Candidate {
	packet: Packet;
	view: TriggerView;
}

/** EVERY view each packet's trigger matches: a two-file patch yields two candidates for one packet. */
function candidatesOf(file: PacketFile, views: TriggerView[], only?: ReadonlySet<string>, phaseAgnostic = false, onlyStatus?: PacketStatus): Candidate[] {
	const out: Candidate[] = [];
	for (const packet of file.packets) {
		if (only && !only.has(packet.id)) continue;
		if (onlyStatus && packet.calibration.status !== onlyStatus) continue;
		for (const view of views) {
			const applies = phaseAgnostic ? { ...packet.applies, phase: view.phase } : packet.applies;
			if (matchesTrigger(applies, view)) out.push({ packet, view });
		}
	}
	return out;
}

interface Admitted {
	rows: PacketJudgmentRow[];
	asks: { packet: Packet; evidence: JevEntry; view: TriggerView }[];
}

/** Delivery, decider, consent and secret gates per candidate; refusals and settled events become rows. */
function admit(event: HarnessEvent, candidates: Candidate[], consent: EvidenceConsent | undefined, cwd: string, source: "live" | "replay"): Admitted {
	const rows: PacketJudgmentRow[] = [];
	const asks: Admitted["asks"] = [];
	for (const { packet, view } of candidates) {
		const support = packetSupport(packet, runnerIdOf(event.agent_source));
		if (!support.supported) {
			rows.push(gateRow(event, packet, "unsupported", support.reason, source));
			continue;
		}
		// The deterministic decider runs BEFORE consent: a settled event sends nothing anywhere.
		const settled = settleView(packet.settle, view);
		if (settled !== null) {
			rows.push(withDelivery({ ...baseRow(event, packet, source), settled, evidence_hash: evidenceHash(settleSubjectEntry(view)) }, packet, view));
			continue;
		}
		const decision = consentDecision(consent, packet.evidence, view, cwd);
		if (!decision.ok) {
			rows.push(gateRow(event, packet, decision.gate, null, source));
			continue;
		}
		const rendered = renderEvidence(packet.evidence, view, EVIDENCE_BOUNDS);
		if (!rendered.ok) {
			rows.push(gateRow(event, packet, rendered.gate, null, source));
			continue;
		}
		asks.push({ packet, evidence: rendered.evidence, view });
	}
	return { rows, asks };
}

async function askGroup(event: HarnessEvent, asks: Admitted["asks"], config: PacketsConfig, apiKey: string, deps: PacketEvaluatorDeps, source: "live" | "replay"): Promise<PacketJudgmentRow[]> {
	const first = asks[0];
	if (!first) return [];
	if (state.usd >= (config.max_spend_usd ?? DEFAULT_MAX_SPEND_USD)) {
		return once(`${event.cwd}:spend_cap`) ? [gateRow(event, null, "spend_cap", null, source)] : [];
	}
	const client = new JevClient({ apiKey, config: { enabled: true, timeout_ms: config.timeout_ms ?? DEFAULT_TIMEOUT_MS }, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
	const questions: Record<string, JevQuestion> = {};
	for (const a of asks) questions[a.packet.id] = a.packet.questions.violated;
	const stateEntry = renderState(event.tool_name ?? "", first.evidence, asks.map((a) => a.packet));
	const started = performance.now();
	const result = await client.askDetailed(stateEntry, questions);
	const latency = Math.round(performance.now() - started);
	state.lastAskFailed = !result.ok;
	if (!result.ok) return asks.map((a) => ({ ...gateRow(event, a.packet, "ask_failed", result.error, source), latency_ms: latency }));
	const { model, usage } = result.response;
	const usd = usage.input_tokens * JEV_USD_PER_INPUT_TOKEN;
	state.usd += usd;
	return asks.map((a) => {
		const answer = result.response.answers[a.packet.id];
		const row = baseRow(event, a.packet, source);
		row.evidence_hash = evidenceHash(a.evidence);
		row.latency_ms = latency;
		row.model = model;
		row.input_tokens = usage.input_tokens;
		row.usd = usd / asks.length;
		row.status_effective = bindingMatches(a.packet, runnerIdOf(event.agent_source), model) ? a.packet.calibration.status : "shadow";
		if (answer?.type === "noul") row.p = answer.noul;
		else row.gate = "missing_answer";
		return withDelivery(row, a.packet, a.view);
	});
}

/** One packed call per DISTINCT rendered evidence: a question is only ever asked against its own evidence
 *  (a multi-file patch yields one call per file, each packet grouped with the file it matched). */
async function ask(event: HarnessEvent, asks: Admitted["asks"], config: PacketsConfig, apiKey: string, deps: PacketEvaluatorDeps): Promise<PacketJudgmentRow[]> {
	const source = deps.source ?? "live";
	const groups = new Map<string, Admitted["asks"]>();
	for (const a of asks) {
		const key = JSON.stringify(a.evidence);
		groups.set(key, [...(groups.get(key) ?? []), a]);
	}
	const out: PacketJudgmentRow[] = [];
	for (const group of groups.values()) out.push(...(await askGroup(event, group, config, apiKey, deps, source)));
	return out;
}

/** The project the event belongs to: the root holding `.interlinked/` above its cwd, where the packet file and the
 *  ledger live and against which consent globs are repo-relative (a call from a subdirectory is still judged; the
 *  fallback oracle resolves the same root, so neither side can think the other covers the words; review-100 P1). */
function packetRoot(event: HarnessEvent): string {
	const cwd = event.cwd || process.cwd();
	return findRepoRoot(cwd) ?? cwd;
}

/** Judge one PostToolUse event; resolves to the rows written. Never rejects. */
export async function runPacketEvaluation(event: HarnessEvent, rules: GuardRulesConfig, deps: PacketEvaluatorDeps = {}): Promise<PacketJudgmentRow[]> {
	try {
		if (event.dry_run === true || (event.hook_event !== "PostToolUse" && !(deps.phaseAgnostic && event.hook_event === "PreToolUse"))) return [];
		const config = enabledConfig(rules);
		if (!config) return [];
		const cwd = packetRoot(event);
		const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
		if (!existsSync(path)) return [];
		const loaded = loadPacketFile(cwd, path);
		if (!loaded.ok) {
			const rows = once(`${cwd}:${loaded.gate}:${statSync(path).mtimeMs}`) ? [gateRow(event, null, loaded.gate, loaded.error)] : [];
			appendRows(cwd, rows);
			return rows;
		}
		const apiKey = (deps.resolveKey ?? (() => resolveApiKey(JEV_API_KEY_ENV)))();
		if (!apiKey) {
			const rows = once(`${cwd}:no_key`) ? [gateRow(event, null, "no_key")] : [];
			appendRows(cwd, rows);
			return rows;
		}
		if (!claim(event, deps.onlyStatus === "cosign" ? "cosign-pre" : "post")) return [];
		const views = viewsFromToolInput(event.tool_name ?? "", event.hook_event === "PreToolUse" ? "pre" : "post", event.tool_input ?? {});
		const admitted = admit(event, candidatesOf(loaded.file, views, deps.onlyPackets, deps.phaseAgnostic, deps.onlyStatus), consentOf(config), cwd, deps.source ?? "live");
		const rows = [...admitted.rows, ...(await ask(event, admitted.asks, config, apiKey, deps))];
		if (!deps.deferAppend) appendRows(cwd, rows);
		return rows;
	} catch {
		return [];
	}
}

/** True when the packet file holds a packet at warn/cosign (a judgment may need delivering, so the pipeline awaits). */
export function hasLivePackets(cwd: string): boolean {
	const path = join(cwd, ".interlinked", PACKET_FILE_BASENAME);
	if (!existsSync(path)) return false;
	const parsed = parsePacketFile(readFileSync(path, "utf8"));
	return parsed.ok && parsed.value.packets.some((p) => LIVE.has(p.calibration.status));
}

/** Hook-path entry: fire and forget after the PostToolUse response (no warning, no await). */
export function schedulePacketEvaluation(event: HarnessEvent, rules: GuardRulesConfig): void {
	if (event.dry_run === true || !enabledConfig(rules)) return;
	setImmediate(() => {
		void runPacketEvaluation(event, rules);
	});
}

export const DEFAULT_DELIVERY_TIMEOUT_MS = 2_500;

/** Pipeline entry (stage 2): await the evaluation when a live packet exists so its warning can ride the
 *  response; otherwise shadow. `shown` is written TRUE only when the rows come back inside the budget —
 *  a late evaluation still lands in the ledger, eligible but not shown, because the agent never saw it. */
export async function collectPacketWarnings(event: HarnessEvent, rules: GuardRulesConfig, deps: PacketEvaluatorDeps = {}, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS): Promise<string[]> {
	if (event.dry_run === true || event.hook_event !== "PostToolUse" || !enabledConfig(rules)) return [];
	const cwd = packetRoot(event);
	if (!hasLivePackets(cwd)) {
		schedulePacketEvaluation(event, rules);
		return [];
	}
	const evaluation = runPacketEvaluation(event, rules, { ...deps, deferAppend: true });
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
	const rows = await Promise.race([evaluation, timeout]);
	if (rows === null) {
		// Too late to deliver: record the judgments as eligible but not shown when they arrive — and the released
		// words go back now, since nothing enforced them on this call (audit B, finding 3).
		void evaluation.then((late) => appendRows(cwd, late));
		return outageFallbackLines(cwd, event.session_id, SLOW_JEV_REASON);
	}
	for (const r of rows) if (r.eligible && r.warning !== null) r.shown = true;
	appendRows(cwd, rows);
	const lines = rows.filter((r) => r.shown && r.warning !== null).map((r) => r.warning as string);
	// §9: a packet that goes non-live mid-session re-injects its released text once per context; ids the hook
	// already recorded as received are skipped (fallback-ledger.ts), so a persistent outage does not repeat it.
	const reason = nonLiveReason(rows, runtimeNonLiveReason(rules));
	if (reason !== null) lines.push(...outageFallbackLines(cwd, event.session_id, reason));
	return lines;
}

/** PreToolUse entry (stage 4): when a cosign packet exists, judge the call before it runs and tighten an
 *  allow to ask on an eligible judgment. Bounded by `timeoutMs`; a late or failed evaluation changes nothing
 *  (its rows still land, eligible but not shown). Returns the possibly-tightened decision. */
export async function collectPacketAsk(event: HarnessEvent, rules: GuardRulesConfig, local: HarnessDecision, deps: PacketEvaluatorDeps = {}, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS): Promise<HarnessDecision> {
	if (event.dry_run === true || event.hook_event !== "PreToolUse" || local.decision !== "allow" || !enabledConfig(rules)) return local;
	// A runner whose PreToolUse can only DENY would turn this ask into a hard block; a packet never blocks (§3).
	if (!runnerSupportsAsk(event.agent_source)) return local;
	const cwd = packetRoot(event);
	// An unpaired cosign packet never asks; with no paired one the evaluator is not called at this phase.
	const pairs = cosignPairingAt(cwd, rules);
	if (![...pairs.values()].some((r) => r !== null)) return local;
	const evaluation = runPacketEvaluation(event, rules, { ...deps, deferAppend: true, phaseAgnostic: true, onlyStatus: "cosign" });
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
	const rows = await Promise.race([evaluation, timeout]);
	const tag = (rs: PacketJudgmentRow[]) => {
		for (const r of rs) if (pairs.has(r.packet)) r.cosign_rule = pairs.get(r.packet) ?? null;
		return rs;
	};
	if (rows === null) {
		void evaluation.then((late) => appendRows(cwd, tag(late)));
		return local;
	}
	tag(rows);
	const decision = decidePacketAsk(local, rows, pairs);
	const hit = decision.decision === "ask" ? pickAsk(rows, pairs) : null;
	if (hit) hit.shown = true; // only the finding the ask carries was delivered; the rest stay eligible, not shown
	appendRows(cwd, rows);
	return decision;
}
